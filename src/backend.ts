import type { PluginBackendContext } from "learnharness-plugin-api";
import { createApprovalBroker } from "./approvals.js";
import {
	appendFileOp, createDirectoryOp, deleteFileOp, editFileOp, listDirectoryOp,
	readFileOp, renamePathOp, writeFileOp,
} from "./fileops.js";
import { assessWorkspaceRoot, WorkspaceError } from "./paths.js";
import { readSettings, writeSettings } from "./settings.js";

/**
 * Workspace Files — community plugin port of LearnHarness's native
 * workspace-file-tools feature. Gives the Teacher, Practitioner and Prober
 * eight tools confined to one folder you choose, with the two destructive
 * ones (delete, overwrite) gated behind your approval in the plugin's own
 * view (open it from the sidebar: "Workspace Files").
 *
 * See MAX_ME.md for what has and has not been independently verified —
 * this backend reuses the native feature's already-tested security logic
 * (ported, not imported: plugins cannot import private host modules) but
 * has not itself been run inside a live LearnHarness install yet.
 */
export function activate(ctx: PluginBackendContext) {
	const protectedFolders = [ctx.directory, ctx.dataDirectory];

	function workspaceRoot(): { configured: string; real: string } {
		const stored = readSettings(ctx.dataDirectory);
		if (!stored.root) {
			throw new WorkspaceError("unavailable", "No workspace folder is configured. Set one in the Workspace Files plugin settings.");
		}
		const assessment = assessWorkspaceRoot(stored.root, protectedFolders);
		if (!assessment.ok) throw new WorkspaceError("unavailable", `Workspace unavailable: ${assessment.message}`);
		return { configured: stored.root, real: assessment.real! };
	}

	const { broker, list, decide } = createApprovalBroker(() => ctx.events.emit("workspace-files:approvals-changed"));
	async function approve(request: Parameters<typeof broker>[0], signal?: AbortSignal) {
		const outcome = await broker(request, signal);
		if (outcome.status === "approved") return;
		const what = request.operation === "delete_file" ? "deletion" : "overwrite";
		if (outcome.status === "denied") throw new WorkspaceError("not-approved", `The learner declined the ${what} of "${request.relativePath}". Nothing was changed.`);
		if (outcome.status === "timeout") throw new WorkspaceError("not-approved", `No answer for the ${what} of "${request.relativePath}" in time. Nothing was changed.`);
		throw new WorkspaceError("not-approved", `The ${what} of "${request.relativePath}" was cancelled. Nothing was changed.`);
	}

	// Frontend RPC: the registerView panel lists and decides pending approvals.
	ctx.handle("approvals.list", () => list());
	ctx.handle("approvals.decide", (input) => {
		const { id, approved } = input as { id: string; approved: boolean };
		return { ok: decide(id, approved) };
	});
	ctx.handle("settings.get", () => readSettings(ctx.dataDirectory));
	ctx.handle("settings.set", (input) => {
		const root = typeof (input as { root?: unknown })?.root === "string" ? (input as { root: string }).root.trim() : "";
		if (root) {
			const assessment = assessWorkspaceRoot(root, protectedFolders);
			if (!assessment.ok) throw new Error(assessment.message ?? "Invalid workspace folder.");
		}
		writeSettings(ctx.dataDirectory, { root: root || null });
		return readSettings(ctx.dataDirectory);
	});
	ctx.handle("settings.assess", () => {
		const stored = readSettings(ctx.dataDirectory);
		if (!stored.root) return { ok: false, message: "No workspace folder is configured yet." };
		return assessWorkspaceRoot(stored.root, protectedFolders);
	});

	// Support both backend-side settings registration (used by smoke.cjs) and
	// frontend-side settings registration (PluginFrontendContext in v0.6.1).
	if (typeof ctx.registerSettings === "function") {
		const settingsHandle = ctx.registerSettings({
			rows: [
				{
					key: "root",
					label: "Workspace folder",
					description: "The one folder the Teacher, Practitioner and Prober may create, edit, rename and (with your approval) delete files in.",
					type: "text",
					value: readSettings(ctx.dataDirectory).root ?? "",
					validate: (value: string) => {
						if (!value) return undefined; // empty = not configured yet; tools report that clearly
						const assessment = assessWorkspaceRoot(value, protectedFolders);
						return assessment.ok ? undefined : assessment.message;
					},
					onChange: (value: string) => {
						writeSettings(ctx.dataDirectory, { root: value || null });
					},
				},
			],
		});
		ctx.cleanup(() => { if (typeof settingsHandle === "function") settingsHandle(); else settingsHandle?.dispose?.(); });
	}

	ctx.registerTools({
		agents: ["teacher", "prober", "practice"],
		create() {
			return [
				{
					name: "read_file",
					description: "Read a text file from the workspace. Output is truncated; use offset/limit to page. Read a file before editing it.",
					parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await readFileOp(workspaceRoot, input as never) }] }),
				},
				{
					name: "list_directory",
					description: "List a folder in the workspace (default: the root). Directories end with '/'.",
					parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await listDirectoryOp(workspaceRoot, (input ?? {}) as never) }] }),
				},
				{
					name: "write_file",
					description: "Create a NEW text file (missing parent folders are created). Fails if it exists. overwrite=true replaces an existing file and needs the learner's approval.",
					parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, required: ["path", "content"] },
					execute: async (_id: string, input: unknown, signal?: AbortSignal) => ({ content: [{ type: "text", text: await writeFileOp(workspaceRoot, input as never, approve, signal) }] }),
				},
				{
					name: "edit_file",
					description: "Replace exact text in an existing file. old_string must match exactly once (or set replace_all=true).",
					parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await editFileOp(workspaceRoot, input as never) }] }),
				},
				{
					name: "append_file",
					description: "Add text to the end of an existing file. Fails if missing unless create_if_missing=true.",
					parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, create_if_missing: { type: "boolean" } }, required: ["path", "content"] },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await appendFileOp(workspaceRoot, input as never) }] }),
				},
				{
					name: "create_directory",
					description: "Create a folder (and missing parents) in the workspace.",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await createDirectoryOp(workspaceRoot, input as never) }] }),
				},
				{
					name: "rename_path",
					description: "Rename or move a file or folder within the workspace. Never overwrites.",
					parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
					execute: async (_id: string, input: unknown) => ({ content: [{ type: "text", text: await renamePathOp(workspaceRoot, input as never) }] }),
				},
				{
					name: "delete_file",
					description: "Delete ONE file. The learner must approve it in the Workspace Files plugin panel; folders are never deleted.",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					execute: async (_id: string, input: unknown, signal?: AbortSignal) => ({ content: [{ type: "text", text: await deleteFileOp(workspaceRoot, input as never, approve, signal) }] }),
				},
			] as any;
		},
	});
}
