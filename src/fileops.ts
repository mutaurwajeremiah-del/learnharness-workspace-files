import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describeFsError, resolveWorkspaceTarget, WorkspaceError, type WorkspaceTarget } from "./paths.js";

/** Ported from the native feature's fileops.ts. Same limits, same atomic-write
 *  and re-validate-before-mutate discipline, same approval gate for delete
 *  and overwrite — see src/approvals.ts for the broker this calls into. */

export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const READ_MAX_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const LIST_DEFAULT_LIMIT = 500;
const TEMP_PREFIX = ".wf-tmp-";
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 800;

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RootFn = () => { configured: string; real: string };
export interface ApprovalRequest {
	operation: "delete_file" | "overwrite_file";
	relativePath: string;
	absolutePath: string;
	sizeBytes: number;
	modifiedAt: string;
	currentPreview?: string;
	newSizeBytes?: number;
	newPreview?: string;
}
export type ApprovalOutcome = { status: "approved" } | { status: "denied" } | { status: "timeout" } | { status: "aborted" };
export type ApprovalBroker = (req: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalOutcome>;

interface DecodedText { text: string; bom: boolean }
function decodeUtf8(buffer: Buffer, relative: string): DecodedText {
	if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) throw new WorkspaceError("binary", `"${relative}" looks like a binary file.`);
	const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
	try {
		return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? buffer.subarray(3) : buffer), bom };
	} catch {
		throw new WorkspaceError("binary", `"${relative}" is not valid UTF-8 text.`);
	}
}
function encodeUtf8(text: string, bom: boolean): Buffer {
	const body = Buffer.from(text, "utf-8");
	return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
type Eol = "crlf" | "lf" | "mixed" | "none";
function detectEol(text: string): Eol {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
	if (crlf === 0 && lf === 0) return "none";
	if (crlf > 0 && lf === 0) return "crlf";
	if (lf > 0 && crlf === 0) return "lf";
	return "mixed";
}
function toEol(value: string, eol: Eol): string {
	if (eol === "crlf") return value.replace(/\r?\n/g, "\r\n");
	if (eol === "lf") return value.replace(/\r\n/g, "\n");
	return value;
}
function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split(/\r\n|\n/).length - (/\n$/.test(text) ? 1 : 0);
}
function preview(text: string): string {
	const lines = text.split(/\r\n|\n/).slice(0, PREVIEW_LINES).join("\n");
	return lines.length > PREVIEW_CHARS ? `${lines.slice(0, PREVIEW_CHARS)}…` : lines;
}
function assertNoNul(content: string, label: string): void {
	if (content.includes("\u0000")) throw new WorkspaceError("binary", `${label} contains a NUL character.`);
}
function assertWritable(bytes: number, label: string): void {
	if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError("too-large", `${label} is ${formatSize(bytes)}; a single call may write at most ${formatSize(MAX_WRITE_BYTES)}.`);
}

async function createNewFile(target: WorkspaceTarget, data: Buffer): Promise<void> {
	let handle: fsp.FileHandle | undefined;
	let created = false;
	try {
		handle = await fsp.open(target.absolute, "wx", 0o644);
		created = true;
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (created) await fsp.unlink(target.absolute).catch(() => undefined);
		throw describeFsError(error, "create", target.relative);
	}
}
async function replaceFileAtomically(target: WorkspaceTarget, data: Buffer): Promise<void> {
	const temp = path.join(path.dirname(target.absolute), `${TEMP_PREFIX}${randomUUID()}`);
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(temp, "wx", 0o644);
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fsp.rename(temp, target.absolute);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fsp.unlink(temp).catch(() => undefined);
		throw describeFsError(error, "write", target.relative);
	}
}
async function assertUnchanged(target: WorkspaceTarget, before: fs.Stats): Promise<void> {
	let now: fs.Stats;
	try { now = await fsp.lstat(target.absolute); } catch { throw new WorkspaceError("conflict", `"${target.relative}" disappeared while waiting for approval.`); }
	if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new WorkspaceError("conflict", `"${target.relative}" changed on disk while waiting for approval. Nothing was changed.`);
}
async function ensureParentFolders(target: WorkspaceTarget): Promise<void> {
	const parent = path.dirname(target.absolute);
	if (fs.existsSync(parent)) return;
	try { await fsp.mkdir(parent, { recursive: true }); } catch (error) { throw describeFsError(error, "create folder for", target.relative); }
}

export async function readFileOp(root: RootFn, args: { path: string; offset?: number; limit?: number }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	if (!target.stat!.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
	if (target.stat!.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to read.`);
	const buffer = await fsp.readFile(target.absolute).catch((e) => { throw describeFsError(e, "read", target.relative); });
	const { text } = decodeUtf8(buffer, target.relative);
	const allLines = text.split("\n");
	const total = allLines.length;
	const start = args.offset ? Math.max(0, args.offset - 1) : 0;
	if (start >= total) throw new WorkspaceError("invalid-path", `Offset ${args.offset} is beyond the end of the file.`);
	let selected = allLines.slice(start, args.limit !== undefined ? start + args.limit : total);
	if (selected.length > READ_MAX_LINES) selected = selected.slice(0, READ_MAX_LINES);
	while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) selected.pop();
	const end = start + selected.length;
	const body = selected.join("\n");
	return total - end > 0 ? `${body}\n\n[${total - end} more lines. Use offset=${end + 1} to continue.]` : body;
}

export async function listDirectoryOp(root: RootFn, args: { path?: string; limit?: number }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path ?? "", root, { allowRoot: true, mustExist: true });
	if (!target.stat!.isDirectory()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a file.`);
	const entries = await fsp.readdir(target.absolute, { withFileTypes: true }).catch((e) => { throw describeFsError(e, "list", target.relative); });
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	const limit = Math.max(1, args.limit ?? LIST_DEFAULT_LIMIT);
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(TEMP_PREFIX)) continue;
		if (lines.length >= limit) break;
		if (entry.isSymbolicLink()) { lines.push(`${entry.name}  [link — not followed]`); continue; }
		if (entry.isDirectory()) { lines.push(`${entry.name}/`); continue; }
		try { lines.push(`${entry.name}  (${formatSize((await fsp.stat(path.join(target.absolute, entry.name))).size)})`); } catch { lines.push(entry.name); }
	}
	const header = `Workspace: ${target.root}\nFolder: ${target.relative || "(workspace root)"}`;
	return lines.length === 0 ? `${header}\n\nFolder is empty.` : `${header}\n\n${lines.join("\n")}`;
}

export async function writeFileOp(root: RootFn, args: { path: string; content: string; overwrite?: boolean }, approve: (req: ApprovalRequest, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<string> {
	assertNoNul(args.content, "content");
	const bytes = Buffer.byteLength(args.content, "utf-8");
	assertWritable(bytes, "content");
	const target = resolveWorkspaceTarget(args.path, root);

	if (!target.exists) {
		await ensureParentFolders(target);
		const fresh = resolveWorkspaceTarget(args.path, root);
		await createNewFile(fresh, Buffer.from(args.content, "utf-8"));
		return `Created ${fresh.relative} (${formatSize(bytes)}, ${countLines(args.content)} lines).`;
	}
	if (!target.stat!.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
	if (args.overwrite !== true) throw new WorkspaceError("exists", `"${target.relative}" already exists. Use edit_file, append_file, or write_file with overwrite=true.`);
	if (target.stat!.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to overwrite safely.`);

	const before = target.stat!;
	const existing = await fsp.readFile(target.absolute).catch((e) => { throw describeFsError(e, "read", target.relative); });
	const decoded = decodeUtf8(existing, target.relative);
	const newBuffer = encodeUtf8(args.content, decoded.bom);
	if (existing.equals(newBuffer)) return `No change: ${target.relative} already contains exactly this content.`;

	await approve({
		operation: "overwrite_file", relativePath: target.relative, absolutePath: target.absolute,
		sizeBytes: existing.length, modifiedAt: before.mtime.toISOString(),
		currentPreview: preview(decoded.text), newSizeBytes: newBuffer.length, newPreview: preview(args.content),
	}, signal);
	const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	await assertUnchanged(again, before);
	await replaceFileAtomically(again, newBuffer);
	return `Overwrote ${again.relative} with the learner's approval (${formatSize(existing.length)} → ${formatSize(newBuffer.length)}).`;
}

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = []; let from = 0;
	for (;;) { const at = haystack.indexOf(needle, from); if (at === -1) return found; found.push(at); from = at + needle.length; }
}

export async function editFileOp(root: RootFn, args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> {
	if (args.old_string.length === 0) throw new WorkspaceError("invalid-path", "old_string must not be empty.");
	assertNoNul(args.new_string, "new_string");
	const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	const before = target.stat!;
	if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
	if (before.size > MAX_EDIT_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to edit.`);
	const buffer = await fsp.readFile(target.absolute).catch((e) => { throw describeFsError(e, "read", target.relative); });
	const { text, bom } = decodeUtf8(buffer, target.relative);
	const eol = detectEol(text);
	const needle = toEol(args.old_string, eol);
	const replacement = toEol(args.new_string, eol);
	if (needle === replacement) throw new WorkspaceError("invalid-path", "old_string and new_string are identical.");
	const hits = occurrences(text, needle);
	if (hits.length === 0) throw new WorkspaceError("not-found", `old_string was not found in "${target.relative}".`);
	if (hits.length > 1 && args.replace_all !== true) throw new WorkspaceError("conflict", `old_string matches ${hits.length} places; include more context or set replace_all=true.`);
	const updated = args.replace_all === true ? text.split(needle).join(replacement) : text.slice(0, hits[0]!) + replacement + text.slice(hits[0]! + needle.length);
	const out = encodeUtf8(updated, bom);
	assertWritable(out.length, "the edited file");
	const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	await assertUnchanged(again, before);
	await replaceFileAtomically(again, out);
	return `Edited ${again.relative}; file is now ${formatSize(out.length)}, ${countLines(updated)} lines.`;
}

export async function appendFileOp(root: RootFn, args: { path: string; content: string; create_if_missing?: boolean }): Promise<string> {
	assertNoNul(args.content, "content");
	assertWritable(Buffer.byteLength(args.content, "utf-8"), "content");
	if (args.content.length === 0) throw new WorkspaceError("invalid-path", "content is empty.");
	const target = resolveWorkspaceTarget(args.path, root);
	if (!target.exists) {
		if (args.create_if_missing !== true) throw new WorkspaceError("not-found", `"${target.relative}" does not exist. Set create_if_missing=true to start a new file.`);
		await ensureParentFolders(target);
		const fresh = resolveWorkspaceTarget(args.path, root);
		const data = Buffer.from(args.content, "utf-8");
		await createNewFile(fresh, data);
		return `Created ${fresh.relative} with the appended content (${formatSize(data.length)}).`;
	}
	const before = target.stat!;
	if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
	const existing = await fsp.readFile(target.absolute).catch((e) => { throw describeFsError(e, "read", target.relative); });
	const { text } = decodeUtf8(existing, target.relative);
	const eol = detectEol(text);
	let addition = toEol(args.content, eol);
	if (text.length > 0 && !/\n$/.test(text) && !/^\r?\n/.test(addition)) addition = (eol === "crlf" ? "\r\n" : "\n") + addition;
	const added = Buffer.from(addition, "utf-8");
	const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	await assertUnchanged(again, before);
	const handle = await fsp.open(again.absolute, "a").catch((e) => { throw describeFsError(e, "append to", again.relative); });
	await handle.appendFile(added); await handle.sync(); await handle.close();
	return `Appended ${formatSize(added.length)} to ${again.relative}.`;
}

export async function createDirectoryOp(root: RootFn, args: { path: string }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path, root);
	if (target.exists) {
		if (target.stat!.isDirectory()) return `Folder already exists: ${target.relative}`;
		throw new WorkspaceError("wrong-type", `"${target.relative}" exists and is a file.`);
	}
	await fsp.mkdir(target.absolute, { recursive: true }).catch((e) => { throw describeFsError(e, "create folder", target.relative); });
	return `Created folder ${target.relative}`;
}

export async function renamePathOp(root: RootFn, args: { from: string; to: string }): Promise<string> {
	const src = resolveWorkspaceTarget(args.from, root, { mustExist: true, label: "from" });
	const dst = resolveWorkspaceTarget(args.to, root, { label: "to" });
	if (dst.exists) throw new WorkspaceError("exists", `Destination "${dst.relative}" already exists. Rename never overwrites.`);
	if (!fs.existsSync(path.dirname(dst.absolute))) throw new WorkspaceError("not-found", `The destination folder for "${dst.relative}" does not exist.`);
	await fsp.rename(src.absolute, dst.absolute).catch((e) => { throw describeFsError(e, "rename", src.relative); });
	return `Renamed ${src.stat!.isDirectory() ? "folder" : "file"}: ${src.relative} → ${dst.relative}`;
}

export async function deleteFileOp(root: RootFn, args: { path: string }, approve: (req: ApprovalRequest, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<string> {
	const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	const before = target.stat!;
	if (before.isDirectory()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder. This plugin never deletes folders.`);
	let text: string | undefined;
	if (before.size <= MAX_FILE_BYTES) { try { text = decodeUtf8(await fsp.readFile(target.absolute), target.relative).text; } catch { text = undefined; } }
	await approve({
		operation: "delete_file", relativePath: target.relative, absolutePath: target.absolute,
		sizeBytes: before.size, modifiedAt: before.mtime.toISOString(), currentPreview: text === undefined ? undefined : preview(text),
	}, signal);
	const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
	await assertUnchanged(again, before);
	await fsp.unlink(again.absolute).catch((e) => { throw describeFsError(e, "delete", again.relative); });
	return `Deleted ${again.relative} with the learner's approval (${formatSize(before.size)}).`;
}
