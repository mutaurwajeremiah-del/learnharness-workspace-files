"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/backend.ts
var backend_exports = {};
__export(backend_exports, {
  activate: () => activate
});
module.exports = __toCommonJS(backend_exports);

// src/approvals.ts
var import_node_crypto = require("node:crypto");
var TIMEOUT_MS = 10 * 6e4;
function createApprovalBroker(onChange) {
  const pending = /* @__PURE__ */ new Map();
  const broker = (request, signal) => new Promise((resolve2) => {
    if (signal?.aborted) {
      resolve2({ status: "aborted" });
      return;
    }
    const id = (0, import_node_crypto.randomUUID)();
    const now = Date.now();
    const full = { ...request, id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TIMEOUT_MS).toISOString() };
    let settled = false;
    const timer = setTimeout(() => settle({ status: "timeout" }), TIMEOUT_MS);
    const onAbort = () => settle({ status: "aborted" });
    function settle(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      onChange();
      resolve2(outcome);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, { request: full, settle });
    onChange();
  });
  return {
    broker,
    list() {
      return [...pending.values()].map((p) => p.request).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    decide(id, approved) {
      const found = pending.get(id);
      if (!found) return false;
      found.settle(approved ? { status: "approved" } : { status: "denied" });
      return true;
    }
  };
}

// src/fileops.ts
var import_node_crypto2 = require("node:crypto");
var fs2 = __toESM(require("node:fs"));
var fsp = __toESM(require("node:fs/promises"));
var path2 = __toESM(require("node:path"));

// src/paths.ts
var fs = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var WorkspaceError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
};
var CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
var MAX_SEGMENT_LENGTH = 255;
var MAX_RELATIVE_LENGTH = 240;
var WINDOWS_MAX_PATH = 259;
var RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
var ILLEGAL_SEGMENT_CHARS = /[<>:"|?*]/;
var CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
var SENSITIVE_NAME = /^(\.env(\..*)?|\.git|id_rsa|id_ed25519|\.ssh|.*credentials\.json|.*\.pem|.*\.pfx)$/i;
function isSensitivePath(absolute) {
  return absolute.split(path.sep).some((segment) => SENSITIVE_NAME.test(segment));
}
function pathKey(p) {
  const normalized = path.resolve(p);
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}
function isInside(parent, child, allowEqual = true) {
  const rel = path.relative(pathKey(parent), pathKey(child));
  if (rel === "") return allowEqual;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function relativeKeepingCase(parent, child) {
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
function toPosix(p) {
  return p.split(path.sep).join("/");
}
function isWorkspaceRootSyntax(value) {
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
function assessWorkspaceRoot(rootRaw, protectedFolders) {
  const syntax = isWorkspaceRootSyntax(rootRaw);
  if (!syntax.ok) return { ok: false, message: syntax.error };
  const configured = path.resolve(rootRaw);
  let real;
  try {
    real = fs.realpathSync.native(configured);
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, message: `The workspace folder does not exist: ${configured}.` };
    return { ok: false, message: `The workspace folder cannot be opened: ${configured}.` };
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, message: `The workspace path is not a folder: ${configured}.` };
    fs.accessSync(real, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, message: `The workspace folder is not readable and writable: ${configured}.` };
  }
  let home = null;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    home = null;
  }
  if (home && isInside(real, home)) return { ok: false, message: "The workspace cannot be your home folder or a folder that contains it." };
  for (const folder of protectedFolders) {
    let protectedReal = folder;
    try {
      protectedReal = fs.realpathSync.native(folder);
    } catch {
    }
    if (isInside(protectedReal, real) || isInside(real, protectedReal)) return { ok: false, message: "The workspace cannot overlap this plugin's own code or data folder." };
  }
  if (isSensitivePath(real)) return { ok: false, message: "The workspace is a protected location and cannot be used." };
  return { ok: true, real };
}
function validateSegment(segment, label) {
  if (segment === "..") throw new WorkspaceError("invalid-path", `${label}: '..' is not allowed.`);
  if (CONTROL_CHARS.test(segment)) throw new WorkspaceError("invalid-path", `${label}: control characters are not allowed.`);
  if (ILLEGAL_SEGMENT_CHARS.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" contains a character that is not allowed in file names.`);
  if (/[ .]$/.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" must not end with a space or a period.`);
  if (RESERVED_NAME.test(segment)) throw new WorkspaceError("invalid-path", `${label}: "${segment}" is a reserved Windows device name.`);
  if (segment.length > MAX_SEGMENT_LENGTH) throw new WorkspaceError("invalid-path", `${label}: a path segment is too long.`);
}
function outside(label, raw) {
  return new WorkspaceError("outside-workspace", `${label}: "${raw}" is outside the workspace.`);
}
function describeFsError(error, action, relative2) {
  if (error instanceof WorkspaceError) return error;
  const code = error?.code;
  const where = relative2 ? `"${relative2}"` : "the workspace";
  switch (code) {
    case "ENOENT":
      return new WorkspaceError("not-found", `Cannot ${action} ${where}: it does not exist.`);
    case "EEXIST":
      return new WorkspaceError("exists", `Cannot ${action} ${where}: something with that name already exists.`);
    case "ENOTDIR":
      return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: a parent in the path is a file, not a folder.`);
    case "EISDIR":
      return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: it is a folder, not a file.`);
    case "ENOTEMPTY":
      return new WorkspaceError("conflict", `Cannot ${action} ${where}: the folder is not empty.`);
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return new WorkspaceError("permission", `Cannot ${action} ${where}: permission denied. The operation was NOT performed.`);
    case "EBUSY":
    case "ETXTBSY":
      return new WorkspaceError("locked", `Cannot ${action} ${where}: the file is locked by another program. The operation was NOT performed.`);
    case "ENOSPC":
      return new WorkspaceError("io", `Cannot ${action} ${where}: the disk is full.`);
    case "ENAMETOOLONG":
      return new WorkspaceError("invalid-path", `Cannot ${action} ${where}: the path is too long.`);
    default:
      return new WorkspaceError("io", `Cannot ${action} ${where}: ${error?.message ?? "unknown error"}.`);
  }
}
function resolveWorkspaceTarget(rawInput, rootFn, options = {}) {
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
  let segments;
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
  let stat2 = null;
  let existingDepth = 0;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT") {
        exists = false;
        break;
      }
      if (code === "ENOTDIR") throw new WorkspaceError("wrong-type", `${label}: a parent in "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
      throw describeFsError(error, "access", segments.slice(0, i + 1).join("/"));
    }
    if (st.isSymbolicLink()) throw new WorkspaceError("link", `${label}: "${segments.slice(0, i + 1).join("/")}" is a symbolic link or junction. Links are never followed.`);
    if (i < segments.length - 1 && !st.isDirectory()) throw new WorkspaceError("wrong-type", `${label}: "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
    current = next;
    stat2 = st;
    existingDepth = i + 1;
  }
  let absolute;
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
  const relative2 = relativeKeepingCase(root, absolute) ?? segments.join("/");
  return { root, absolute, relative: toPosix(relative2), exists, stat: exists ? stat2 : null, isRoot: false };
}

// src/fileops.ts
var MAX_WRITE_BYTES = 1024 * 1024;
var MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
var MAX_FILE_BYTES = 5 * 1024 * 1024;
var READ_MAX_LINES = 2e3;
var MAX_OUTPUT_BYTES = 50 * 1024;
var LIST_DEFAULT_LIMIT = 500;
var TEMP_PREFIX = ".wf-tmp-";
var PREVIEW_LINES = 12;
var PREVIEW_CHARS = 800;
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function decodeUtf8(buffer, relative2) {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) throw new WorkspaceError("binary", `"${relative2}" looks like a binary file.`);
  const bom = buffer.length >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? buffer.subarray(3) : buffer), bom };
  } catch {
    throw new WorkspaceError("binary", `"${relative2}" is not valid UTF-8 text.`);
  }
}
function encodeUtf8(text, bom) {
  const body = Buffer.from(text, "utf-8");
  return bom ? Buffer.concat([Buffer.from([239, 187, 191]), body]) : body;
}
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return "none";
  if (crlf > 0 && lf === 0) return "crlf";
  if (lf > 0 && crlf === 0) return "lf";
  return "mixed";
}
function toEol(value, eol) {
  if (eol === "crlf") return value.replace(/\r?\n/g, "\r\n");
  if (eol === "lf") return value.replace(/\r\n/g, "\n");
  return value;
}
function countLines(text) {
  return text.length === 0 ? 0 : text.split(/\r\n|\n/).length - (/\n$/.test(text) ? 1 : 0);
}
function preview(text) {
  const lines = text.split(/\r\n|\n/).slice(0, PREVIEW_LINES).join("\n");
  return lines.length > PREVIEW_CHARS ? `${lines.slice(0, PREVIEW_CHARS)}\u2026` : lines;
}
function assertNoNul(content, label) {
  if (content.includes("\0")) throw new WorkspaceError("binary", `${label} contains a NUL character.`);
}
function assertWritable(bytes, label) {
  if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError("too-large", `${label} is ${formatSize(bytes)}; a single call may write at most ${formatSize(MAX_WRITE_BYTES)}.`);
}
async function createNewFile(target, data) {
  let handle;
  let created = false;
  try {
    handle = await fsp.open(target.absolute, "wx", 420);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = void 0;
  } catch (error) {
    await handle?.close().catch(() => void 0);
    if (created) await fsp.unlink(target.absolute).catch(() => void 0);
    throw describeFsError(error, "create", target.relative);
  }
}
async function replaceFileAtomically(target, data) {
  const temp = path2.join(path2.dirname(target.absolute), `${TEMP_PREFIX}${(0, import_node_crypto2.randomUUID)()}`);
  let handle;
  try {
    handle = await fsp.open(temp, "wx", 420);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = void 0;
    await fsp.rename(temp, target.absolute);
  } catch (error) {
    await handle?.close().catch(() => void 0);
    await fsp.unlink(temp).catch(() => void 0);
    throw describeFsError(error, "write", target.relative);
  }
}
async function assertUnchanged(target, before) {
  let now;
  try {
    now = await fsp.lstat(target.absolute);
  } catch {
    throw new WorkspaceError("conflict", `"${target.relative}" disappeared while waiting for approval.`);
  }
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new WorkspaceError("conflict", `"${target.relative}" changed on disk while waiting for approval. Nothing was changed.`);
}
async function ensureParentFolders(target) {
  const parent = path2.dirname(target.absolute);
  if (fs2.existsSync(parent)) return;
  try {
    await fsp.mkdir(parent, { recursive: true });
  } catch (error) {
    throw describeFsError(error, "create folder for", target.relative);
  }
}
async function readFileOp(root, args) {
  const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  if (!target.stat.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
  if (target.stat.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to read.`);
  const buffer = await fsp.readFile(target.absolute).catch((e) => {
    throw describeFsError(e, "read", target.relative);
  });
  const { text } = decodeUtf8(buffer, target.relative);
  const allLines = text.split("\n");
  const total = allLines.length;
  const start = args.offset ? Math.max(0, args.offset - 1) : 0;
  if (start >= total) throw new WorkspaceError("invalid-path", `Offset ${args.offset} is beyond the end of the file.`);
  let selected = allLines.slice(start, args.limit !== void 0 ? start + args.limit : total);
  if (selected.length > READ_MAX_LINES) selected = selected.slice(0, READ_MAX_LINES);
  while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) selected.pop();
  const end = start + selected.length;
  const body = selected.join("\n");
  return total - end > 0 ? `${body}

[${total - end} more lines. Use offset=${end + 1} to continue.]` : body;
}
async function listDirectoryOp(root, args) {
  const target = resolveWorkspaceTarget(args.path ?? "", root, { allowRoot: true, mustExist: true });
  if (!target.stat.isDirectory()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a file.`);
  const entries = await fsp.readdir(target.absolute, { withFileTypes: true }).catch((e) => {
    throw describeFsError(e, "list", target.relative);
  });
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const limit = Math.max(1, args.limit ?? LIST_DEFAULT_LIMIT);
  const lines = [];
  for (const entry of entries) {
    if (entry.name.startsWith(TEMP_PREFIX)) continue;
    if (lines.length >= limit) break;
    if (entry.isSymbolicLink()) {
      lines.push(`${entry.name}  [link \u2014 not followed]`);
      continue;
    }
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
      continue;
    }
    try {
      lines.push(`${entry.name}  (${formatSize((await fsp.stat(path2.join(target.absolute, entry.name))).size)})`);
    } catch {
      lines.push(entry.name);
    }
  }
  const header = `Workspace: ${target.root}
Folder: ${target.relative || "(workspace root)"}`;
  return lines.length === 0 ? `${header}

Folder is empty.` : `${header}

${lines.join("\n")}`;
}
async function writeFileOp(root, args, approve, signal) {
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
  if (!target.stat.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
  if (args.overwrite !== true) throw new WorkspaceError("exists", `"${target.relative}" already exists. Use edit_file, append_file, or write_file with overwrite=true.`);
  if (target.stat.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to overwrite safely.`);
  const before = target.stat;
  const existing = await fsp.readFile(target.absolute).catch((e) => {
    throw describeFsError(e, "read", target.relative);
  });
  const decoded = decodeUtf8(existing, target.relative);
  const newBuffer = encodeUtf8(args.content, decoded.bom);
  if (existing.equals(newBuffer)) return `No change: ${target.relative} already contains exactly this content.`;
  await approve({
    operation: "overwrite_file",
    relativePath: target.relative,
    absolutePath: target.absolute,
    sizeBytes: existing.length,
    modifiedAt: before.mtime.toISOString(),
    currentPreview: preview(decoded.text),
    newSizeBytes: newBuffer.length,
    newPreview: preview(args.content)
  }, signal);
  const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  await assertUnchanged(again, before);
  await replaceFileAtomically(again, newBuffer);
  return `Overwrote ${again.relative} with the learner's approval (${formatSize(existing.length)} \u2192 ${formatSize(newBuffer.length)}).`;
}
function occurrences(haystack, needle) {
  const found = [];
  let from = 0;
  for (; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}
async function editFileOp(root, args) {
  if (args.old_string.length === 0) throw new WorkspaceError("invalid-path", "old_string must not be empty.");
  assertNoNul(args.new_string, "new_string");
  const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  const before = target.stat;
  if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
  if (before.size > MAX_EDIT_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to edit.`);
  const buffer = await fsp.readFile(target.absolute).catch((e) => {
    throw describeFsError(e, "read", target.relative);
  });
  const { text, bom } = decodeUtf8(buffer, target.relative);
  const eol = detectEol(text);
  const needle = toEol(args.old_string, eol);
  const replacement = toEol(args.new_string, eol);
  if (needle === replacement) throw new WorkspaceError("invalid-path", "old_string and new_string are identical.");
  const hits = occurrences(text, needle);
  if (hits.length === 0) throw new WorkspaceError("not-found", `old_string was not found in "${target.relative}".`);
  if (hits.length > 1 && args.replace_all !== true) throw new WorkspaceError("conflict", `old_string matches ${hits.length} places; include more context or set replace_all=true.`);
  const updated = args.replace_all === true ? text.split(needle).join(replacement) : text.slice(0, hits[0]) + replacement + text.slice(hits[0] + needle.length);
  const out = encodeUtf8(updated, bom);
  assertWritable(out.length, "the edited file");
  const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  await assertUnchanged(again, before);
  await replaceFileAtomically(again, out);
  return `Edited ${again.relative}; file is now ${formatSize(out.length)}, ${countLines(updated)} lines.`;
}
async function appendFileOp(root, args) {
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
  const before = target.stat;
  if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder.`);
  const existing = await fsp.readFile(target.absolute).catch((e) => {
    throw describeFsError(e, "read", target.relative);
  });
  const { text } = decodeUtf8(existing, target.relative);
  const eol = detectEol(text);
  let addition = toEol(args.content, eol);
  if (text.length > 0 && !/\n$/.test(text) && !/^\r?\n/.test(addition)) addition = (eol === "crlf" ? "\r\n" : "\n") + addition;
  const added = Buffer.from(addition, "utf-8");
  const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  await assertUnchanged(again, before);
  const handle = await fsp.open(again.absolute, "a").catch((e) => {
    throw describeFsError(e, "append to", again.relative);
  });
  await handle.appendFile(added);
  await handle.sync();
  await handle.close();
  return `Appended ${formatSize(added.length)} to ${again.relative}.`;
}
async function createDirectoryOp(root, args) {
  const target = resolveWorkspaceTarget(args.path, root);
  if (target.exists) {
    if (target.stat.isDirectory()) return `Folder already exists: ${target.relative}`;
    throw new WorkspaceError("wrong-type", `"${target.relative}" exists and is a file.`);
  }
  await fsp.mkdir(target.absolute, { recursive: true }).catch((e) => {
    throw describeFsError(e, "create folder", target.relative);
  });
  return `Created folder ${target.relative}`;
}
async function renamePathOp(root, args) {
  const src = resolveWorkspaceTarget(args.from, root, { mustExist: true, label: "from" });
  const dst = resolveWorkspaceTarget(args.to, root, { label: "to" });
  if (dst.exists) throw new WorkspaceError("exists", `Destination "${dst.relative}" already exists. Rename never overwrites.`);
  if (!fs2.existsSync(path2.dirname(dst.absolute))) throw new WorkspaceError("not-found", `The destination folder for "${dst.relative}" does not exist.`);
  await fsp.rename(src.absolute, dst.absolute).catch((e) => {
    throw describeFsError(e, "rename", src.relative);
  });
  return `Renamed ${src.stat.isDirectory() ? "folder" : "file"}: ${src.relative} \u2192 ${dst.relative}`;
}
async function deleteFileOp(root, args, approve, signal) {
  const target = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  const before = target.stat;
  if (before.isDirectory()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder. This plugin never deletes folders.`);
  let text;
  if (before.size <= MAX_FILE_BYTES) {
    try {
      text = decodeUtf8(await fsp.readFile(target.absolute), target.relative).text;
    } catch {
      text = void 0;
    }
  }
  await approve({
    operation: "delete_file",
    relativePath: target.relative,
    absolutePath: target.absolute,
    sizeBytes: before.size,
    modifiedAt: before.mtime.toISOString(),
    currentPreview: text === void 0 ? void 0 : preview(text)
  }, signal);
  const again = resolveWorkspaceTarget(args.path, root, { mustExist: true });
  await assertUnchanged(again, before);
  await fsp.unlink(again.absolute).catch((e) => {
    throw describeFsError(e, "delete", again.relative);
  });
  return `Deleted ${again.relative} with the learner's approval (${formatSize(before.size)}).`;
}

// src/settings.ts
var fs3 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
function readSettings(dataDirectory) {
  const file = path3.join(dataDirectory, "settings.json");
  try {
    const raw = JSON.parse(fs3.readFileSync(file, "utf-8"));
    const root = typeof raw?.root === "string" ? raw.root : null;
    if (root && !isWorkspaceRootSyntax(root).ok) return { root: null };
    return { root };
  } catch {
    return { root: null };
  }
}
function writeSettings(dataDirectory, settings) {
  fs3.mkdirSync(dataDirectory, { recursive: true });
  const file = path3.join(dataDirectory, "settings.json");
  const temp = `${file}.tmp`;
  fs3.writeFileSync(temp, JSON.stringify(settings, null, 2));
  fs3.renameSync(temp, file);
}

// src/backend.ts
function activate(ctx) {
  const protectedFolders = [ctx.directory, ctx.dataDirectory];
  function workspaceRoot() {
    const stored = readSettings(ctx.dataDirectory);
    if (!stored.root) {
      throw new WorkspaceError("unavailable", "No workspace folder is configured. Set one in the Workspace Files plugin settings.");
    }
    const assessment = assessWorkspaceRoot(stored.root, protectedFolders);
    if (!assessment.ok) throw new WorkspaceError("unavailable", `Workspace unavailable: ${assessment.message}`);
    return { configured: stored.root, real: assessment.real };
  }
  const { broker, list, decide } = createApprovalBroker(() => ctx.events.emit("workspace-files.approvals-changed"));
  async function approve(request, signal) {
    const outcome = await broker(request, signal);
    if (outcome.status === "approved") return;
    const what = request.operation === "delete_file" ? "deletion" : "overwrite";
    if (outcome.status === "denied") throw new WorkspaceError("not-approved", `The learner declined the ${what} of "${request.relativePath}". Nothing was changed.`);
    if (outcome.status === "timeout") throw new WorkspaceError("not-approved", `No answer for the ${what} of "${request.relativePath}" in time. Nothing was changed.`);
    throw new WorkspaceError("not-approved", `The ${what} of "${request.relativePath}" was cancelled. Nothing was changed.`);
  }
  ctx.handle("approvals.list", () => list());
  ctx.handle("approvals.decide", (input) => {
    const { id, approved } = input;
    return { ok: decide(id, approved) };
  });
  ctx.handle("settings.get", () => readSettings(ctx.dataDirectory));
  ctx.handle("settings.set", (input) => {
    const root = typeof input?.root === "string" ? input.root.trim() : "";
    if (root) {
      const assessment = assessWorkspaceRoot(root, protectedFolders);
      if (!assessment.ok) throw new Error(assessment.message ?? "Invalid workspace folder.");
    }
    writeSettings(ctx.dataDirectory, { root: root || null });
    return readSettings(ctx.dataDirectory);
  });
  ctx.handle("settings.assess", (input) => {
    const candidate = typeof input?.root === "string" ? input.root.trim() : readSettings(ctx.dataDirectory).root;
    if (!candidate) return { ok: false, message: "No workspace folder is configured yet." };
    return assessWorkspaceRoot(candidate, protectedFolders);
  });
  const compatCtx = ctx;
  if (typeof compatCtx.registerSettings === "function") {
    const settingsHandle = compatCtx.registerSettings({
      rows: [
        {
          key: "root",
          label: "Workspace folder",
          description: "The one folder the Teacher, Practitioner and Prober may create, edit, rename and (with your approval) delete files in.",
          type: "text",
          value: readSettings(ctx.dataDirectory).root ?? "",
          validate: (value) => {
            if (!value) return void 0;
            const assessment = assessWorkspaceRoot(value, protectedFolders);
            return assessment.ok ? void 0 : assessment.message;
          },
          onChange: (value) => {
            writeSettings(ctx.dataDirectory, { root: value || null });
          }
        }
      ]
    });
    ctx.cleanup(() => {
      if (typeof settingsHandle === "function") settingsHandle();
      else settingsHandle?.dispose?.();
    });
  }
  ctx.registerTools({
    agents: ["teacher", "prober", "practice"],
    create() {
      return [
        {
          name: "read_file",
          label: "read_file",
          description: "Read a text file from the workspace. Output is truncated; use offset/limit to page. Read a file before editing it.",
          parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await readFileOp(workspaceRoot, input) }], details: void 0 })
        },
        {
          name: "list_directory",
          label: "list_directory",
          description: "List a folder in the workspace (default: the root). Directories end with '/'.",
          parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await listDirectoryOp(workspaceRoot, input ?? {}) }], details: void 0 })
        },
        {
          name: "write_file",
          label: "write_file",
          description: "Create a NEW text file (missing parent folders are created). Fails if it exists. overwrite=true replaces an existing file and needs the learner's approval.",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["path", "content"] },
          executionMode: "sequential",
          execute: async (_id, input, signal) => ({ content: [{ type: "text", text: await writeFileOp(workspaceRoot, input, approve, signal) }], details: void 0 })
        },
        {
          name: "edit_file",
          label: "edit_file",
          description: "Replace exact text in an existing file. old_string must match exactly once (or set replace_all=true).",
          parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await editFileOp(workspaceRoot, input) }], details: void 0 })
        },
        {
          name: "append_file",
          label: "append_file",
          description: "Add text to the end of an existing file. Fails if missing unless create_if_missing=true.",
          parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, create_if_missing: { type: "boolean" } }, required: ["path", "content"] },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await appendFileOp(workspaceRoot, input) }], details: void 0 })
        },
        {
          name: "create_directory",
          label: "create_directory",
          description: "Create a folder (and missing parents) in the workspace.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await createDirectoryOp(workspaceRoot, input) }], details: void 0 })
        },
        {
          name: "rename_path",
          label: "rename_path",
          description: "Rename or move a file or folder within the workspace. Never overwrites.",
          parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
          executionMode: "sequential",
          execute: async (_id, input) => ({ content: [{ type: "text", text: await renamePathOp(workspaceRoot, input) }], details: void 0 })
        },
        {
          name: "delete_file",
          label: "delete_file",
          description: "Delete ONE file. The learner must approve it in the Workspace Files plugin panel; folders are never deleted.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          executionMode: "sequential",
          execute: async (_id, input, signal) => ({ content: [{ type: "text", text: await deleteFileOp(workspaceRoot, input, approve, signal) }], details: void 0 })
        }
      ];
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate
});
