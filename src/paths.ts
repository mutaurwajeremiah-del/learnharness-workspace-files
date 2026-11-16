import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * THE WORKSPACE PATH GUARD, ported from the native LearnHarness feature's
 * src/agent/tools/workspace/paths.ts. Plugins cannot import private host
 * modules, so this file has no dependency on LearnHarness's own code — it
 * is a self-contained reimplementation of the same security contract,
 * verified by the native feature's test suite (tests/workspace-fileops.test.ts):
 *
 *  1. Syntax: no NUL/control chars, no UNC/device paths, no '..', no illegal
 *     Windows characters, no reserved device names, no trailing dot/space.
 *  2. Lexical containment against the configured root AND its canonical form.
 *  3. Every existing path component is lstat'ed; a symlink or Windows
 *     junction anywhere on the path is refused outright, even one that
 *     points back inside the workspace.
 *  4. Canonical (realpath) containment: catches case games and 8.3 names.
 *  5. A denylist of common secret file names, and the plugin's own code/data
 *     directories, are always unreachable — defense in depth, not a
 *     replacement for choosing a sensible workspace folder.
 *
 * Known limit: cannot defeat a hostile local process racing a directory-to-
 * link swap between the check and the following syscall.
 */

export type WorkspaceErrorCode =
	| "unavailable" | "invalid-path" | "outside-workspace" | "link" | "protected"
	| "not-found" | "exists" | "wrong-type" | "too-large" | "permission" | "locked" | "io" | "binary" | "conflict" | "not-approved";

export class WorkspaceError extends Error {
	readonly code: WorkspaceErrorCode;
	constructor(code: WorkspaceErrorCode, message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const MAX_SEGMENT_LENGTH = 255;
const MAX_RELATIVE_LENGTH = 240;
const WINDOWS_MAX_PATH = 259;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Best-effort secret-file denylist. Not a copy of any private host list —
 *  choose a workspace folder that does not contain real secrets regardless. */
const SENSITIVE_NAME = /^(\.env(\..*)?|\.git|id_rsa|id_ed25519|\.ssh|.*credentials\.json|.*\.pem|.*\.pfx)$/i;

export function isSensitivePath(absolute: string): boolean {
	return absolute.split(path.sep).some((segment) => SENSITIVE_NAME.test(segment));
}

function pathKey(p: string): string {
	const normalized = path.resolve(p);
	return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

export function isInside(parent: string, child: string, allowEqual = true): boolean {
	const rel = path.relative(pathKey(parent), pathKey(child));
	if (rel === "") return allowEqual;
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function relativeKeepingCase(parent: string, child: string): string | null {
	if (!isInside(parent, child)) return null;
	const parentKey = pathKey(parent);
	const childAbs = path.resolve(child);
	const childKey = pathKey(childAbs);
	if (childKey === parentKey) return "";
	if (childKey.length === childAbs.length && parentKey.length <= childAbs.length) {
		return childAbs.slice(parentKey.length).replace(/^[\\/]+/, "");
	}
	return path.relative(parentKey, childKey);
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

export function isWorkspaceRootSyntax(value: string): { ok: true } | { ok: false; error: string } {
	if (value.length === 0) return { ok: false, error: "The workspace folder must not be empty." };
	if (value.length > 240) return { ok: false, error: "The workspace folder path is too long." };
	if (CONTROL_CHARS.test(value)) return { ok: false, error: "The workspace folder must not contain control characters." };
	if (value.startsWith("\\\\") || value.startsWith("//")) return { ok: false, error: "The workspace folder must be a local folder, not a network share or device path." };
	const drive = /^[A-Za-z]:[\\/]/.test(value);
	const posix = value.startsWith("/");
	if (!drive && !posix) return { ok: false, error: "The workspace folder must be an absolute path." };
	if (/^[A-Za-z]:[\\/]?$/.test(value) || value === "/") return { ok: false, error: "The workspace folder cannot be a drive root." };
	if (value.slice(drive ? 2 : 0).includes(":")) return { ok: false, error: "The workspace folder must not contain ':' after the drive letter." };
	if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return { ok: false, error: "The workspace folder must not contain '..' segments." };
	return { ok: true };
}

export interface RootAssessment {
	ok: boolean;
	real?: string;
	message?: string;
}

/** `protectedFolders` are paths this workspace may never overlap — pass the
 *  plugin's own ctx.directory and ctx.dataDirectory. */
export function assessWorkspaceRoot(rootRaw: string, protectedFolders: string[]): RootAssessment {
	const syntax = isWorkspaceRootSyntax(rootRaw);
	if (!syntax.ok) return { ok: false, message: syntax.error };
	const configured = path.resolve(rootRaw);
	let real: string;
	try {
		real = fs.realpathSync.native(configured);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, message: `The workspace folder does not exist: ${configured}.` };
		return { ok: false, message: `The workspace folder cannot be opened: ${configured}.` };
	}
	try {
		if (!fs.statSync(real).isDirectory()) return { ok: false, message: `The workspace path is not a folder: ${configured}.` };
		fs.accessSync(real, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	} catch {
		return { ok: false, message: `The workspace folder is not readable and writable: ${configured}.` };
	}
	let home: string | null = null;
	try { home = fs.realpathSync.native(os.homedir()); } catch { home = null; }
	if (home && isInside(real, home)) return { ok: false, message: "The workspace cannot be your home folder or a folder that contains it." };
	for (const folder of protectedFolders) {
		let protectedReal = folder;
		try { protectedReal = fs.realpathSync.native(folder); } catch { /* not created yet */ }
		if (isInside(protectedReal, real) || isInside(real, protectedReal)) return { ok: false, message: "The workspace cannot overlap this plugin's own code or data folder." };
	}
	if (isSensitivePath(real)) return { ok: false, message: "The workspace is a protected location and cannot be used." };
	return { ok: true, real };
}

export interface WorkspaceTarget {
	root: string;
	absolute: string;
	relative: string;
	exists: boolean;
	stat: fs.Stats | null;
	isRoot: boolean;
}

export interface ResolveOptions {
	allowRoot?: boolean;
	mustExist?: boolean;
	label?: string;
}

function validateSegment(segment: string, label: string): void {
	if (segment === "..") throw new WorkspaceError("invalid-path", `${label}: '..' is not allowed.`);
	if (CONTROL_CHARS.test(segment)) throw new WorkspaceError("invalid-path", `${label}: control characters are not allowed.`);
	if (ILLEGAL_SEGMENT_CHARS.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" contains a character that is not allowed in file names.`);
	if (/[ .]$/.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" must not end with a space or a period.`);
	if (RESERVED_NAME.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" is a reserved Windows device name.`);
	if (segment.length > MAX_SEGMENT_LENGTH) throw new WorkspaceError("invalid-path", `${label}: a path segment is too long.`);
}

function outside(label: string, raw: string): WorkspaceError {
	return new WorkspaceError("outside-workspace", `${label}: "${raw}" is outside the workspace.`);
}

export function describeFsError(error: unknown, action: string, relative: string): WorkspaceError {
	if (error instanceof WorkspaceError) return error;
	const code = (error as NodeJS.ErrnoException)?.code;
	const where = relative ? `"${relative}"` : "the workspace";
	switch (code) {
		case "ENOENT": return new WorkspaceError("not-found", `Cannot ${action} ${where}: it does not exist.`);
		case "EEXIST": return new WorkspaceError("exists", `Cannot ${action} ${where}: something with that name already exists.`);
		case "ENOTDIR": return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: a parent in the path is a file, not a folder.`);
		case "EISDIR": return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: it is a folder, not a file.`);
		case "ENOTEMPTY": return new WorkspaceError("conflict", `Cannot ${action} ${where}: the folder is not empty.`);
		case "EACCES": case "EPERM": case "EROFS": return new WorkspaceError("permission", `Cannot ${action} ${where}: permission denied. The operation was NOT performed.`);
		case "EBUSY": case "ETXTBSY": return new WorkspaceError("locked", `Cannot ${action} ${where}: the file is locked by another program. The operation was NOT performed.`);
		case "ENOSPC": return new WorkspaceError("io", `Cannot ${action} ${where}: the disk is full.`);
		case "ENAMETOOLONG": return new WorkspaceError("invalid-path", `Cannot ${action} ${where}: the path is too long.`);
		default: return new WorkspaceError("io", `Cannot ${action} ${where}: ${(error as Error)?.message ?? "unknown error"}.`);
	}
}

export function resolveWorkspaceTarget(
	rawInput: unknown,
	rootFn: () => { configured: string; real: string },
	options: ResolveOptions = {},
): WorkspaceTarget {
	const label = options.label ?? "path";
	if (typeof rawInput !== "string") throw new WorkspaceError("invalid-path", `${label} must be a string.`);
	const raw = rawInput;
	const { configured: configuredRaw, real: root } = rootFn();
	const configured = path.resolve(configuredRaw);

	if (raw.length > 1024) throw new WorkspaceError("invalid-path", `${label} is too long.`);
	if (CONTROL_CHARS.test(raw)) throw new WorkspaceError("invalid-path", `${label}: control characters are not allowed.`);
	if (raw.startsWith("\\\\") || raw.startsWith("//")) throw new WorkspaceError("invalid-path", `${label}: network and device paths are not allowed.`);

	const drivePrefix = /^[A-Za-z]:[\\/]/.test(raw);
	const rooted = path.isAbsolute(raw) || drivePrefix || raw.startsWith("/") || raw.startsWith("\\");
	let segments: string[];

	if (rooted) {
		if (!path.isAbsolute(raw)) throw outside(label, raw);
		if (!drivePrefix && raw.slice(1).includes(":")) throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed in paths.`);
		if (drivePrefix && raw.slice(2).includes(":")) throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed after the drive letter.`);
		if (raw.split(/[\\/]+/).includes("..")) throw new WorkspaceError("invalid-path", `${label}: '..' is not allowed.`);
		const candidate = path.resolve(raw);
		const rel = relativeKeepingCase(configured, candidate) ?? relativeKeepingCase(root, candidate);
		if (rel === null) throw outside(label, raw);
		segments = rel.split(/[\\/]+/).filter((s) => s.length > 0);
	} else {
		if (raw.includes(":")) throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed in paths.`);
		segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
	}

	for (const segment of segments) validateSegment(segment, label);
	if (segments.join("/").length > MAX_RELATIVE_LENGTH) throw new WorkspaceError("invalid-path", `${label}: the path is too long.`);

	if (segments.length === 0) {
		if (!options.allowRoot) throw new WorkspaceError("invalid-path", `${label}: cannot target the workspace root itself.`);
		return { root, absolute: root, relative: "", exists: true, stat: fs.lstatSync(root), isRoot: true };
	}

	let current = root;
	let exists = true;
	let stat: fs.Stats | null = null;
	let existingDepth = 0;
	for (let i = 0; i < segments.length; i++) {
		const next = path.join(current, segments[i]!);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") { exists = false; break; }
			if (code === "ENOTDIR") throw new WorkspaceError("wrong-type", `${label}: a parent in "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
			throw describeFsError(error, "access", segments.slice(0, i + 1).join("/"));
		}
		if (st.isSymbolicLink()) throw new WorkspaceError("link", `${label}: "${segments.slice(0, i + 1).join("/")}" is a symbolic link or junction. Links are never followed.`);
		if (i < segments.length - 1 && !st.isDirectory()) throw new WorkspaceError("wrong-type", `${label}: "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
		current = next;
		stat = st;
		existingDepth = i + 1;
	}

	let absolute: string;
	try {
		const base = fs.realpathSync.native(current);
		absolute = exists ? base : path.join(base, ...segments.slice(existingDepth));
	} catch (error) {
		throw describeFsError(error, "resolve", segments.join("/"));
	}
	if (!isInside(root, absolute)) throw outside(label, raw);
	if (absolute.length > WINDOWS_MAX_PATH && process.platform === "win32") throw new WorkspaceError("invalid-path", `${label}: the full path is too long.`);
	if (isSensitivePath(absolute)) throw new WorkspaceError("protected", `${label}: "${segments.join("/")}" is a protected location.`);
	if (!exists && options.mustExist) throw new WorkspaceError("not-found", `${label}: "${segments.join("/")}" does not exist.`);
	const relative = relativeKeepingCase(root, absolute) ?? segments.join("/");
	return { root, absolute, relative: toPosix(relative), exists, stat: exists ? stat : null, isRoot: false };
}
