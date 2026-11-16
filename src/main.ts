import type { PluginFrontendContext } from "learnharness-plugin-api";

/**
 * The learner-facing side: a sidebar view listing pending delete/overwrite
 * approvals, with Approve/Keep buttons. Polls every 2s while open — simpler
 * and more certain to work correctly than guessing at the exact modal-surface
 * API for a first scaffold; see README.md for upgrading this to a proper
 * ctx.ui.openSurface modal that pops up on its own instead of needing the
 * view to be open.
 */

interface PendingApproval {
	id: string;
	operation: "delete_file" | "overwrite_file";
	relativePath: string;
	absolutePath: string;
	sizeBytes: number;
	modifiedAt: string;
	currentPreview?: string;
	newSizeBytes?: number;
	newPreview?: string;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function activate(ctx: PluginFrontendContext) {
	if (typeof ctx.registerSettings === "function") {
		let handle: ReturnType<NonNullable<PluginFrontendContext["registerSettings"]>> | undefined;
		const rows = (root: string) => [
			{
				key: "root",
				label: "Workspace folder",
				description: "The one folder the Teacher, Practitioner and Prober may create, edit, rename and (with your approval) delete files in.",
				type: "text" as const,
				value: root,
				onChange: async (value: string) => {
					const saved = await ctx.call<{ root: string | null }>("settings.set", { root: value });
					if (handle && typeof handle !== "function" && "update" in handle) {
						(handle as { update(p: unknown): void }).update({ rows: rows(saved.root ?? "") });
					}
				},
			},
		];
		handle = ctx.registerSettings({ rows: rows("") });
		void ctx.call<{ root: string | null }>("settings.get").then((s) => {
			if (handle && typeof handle !== "function" && "update" in handle) {
				(handle as { update(p: unknown): void }).update({ rows: rows(s.root ?? "") });
			}
		}).catch(() => undefined);
		ctx.cleanup?.(() => {
			if (typeof handle === "function") handle();
			else handle?.dispose?.();
		});
	}

	ctx.registerView({
		id: "approvals",
		name: "Workspace Files",
		async mount(container, signal) {
			container.style.padding = "12px";
			container.style.fontFamily = "inherit";
			const title = document.createElement("h2");
			title.textContent = "Pending file approvals";
			title.style.fontSize = "14px";
			container.appendChild(title);
			const list = document.createElement("div");
			container.appendChild(list);

			async function refresh() {
				if (signal.aborted) return;
				const approvals = await ctx.call<PendingApproval[]>("approvals.list").catch(() => [] as PendingApproval[]);
				list.replaceChildren();
				if (approvals.length === 0) {
					const empty = document.createElement("p");
					empty.textContent = "Nothing is waiting for your approval right now.";
					empty.style.opacity = "0.7";
					list.appendChild(empty);
					return;
				}
				for (const a of approvals) {
					list.appendChild(renderCard(a));
				}
			}

			function renderCard(a: PendingApproval): HTMLElement {
				const card = document.createElement("div");
				card.style.cssText = "border:1px solid currentColor;border-radius:8px;padding:10px;margin:8px 0;opacity:0.95";
				const heading = document.createElement("strong");
				heading.textContent = a.operation === "delete_file" ? "Delete file?" : "Replace file contents?";
				card.appendChild(heading);
				const path = document.createElement("div");
				path.textContent = a.relativePath;
				path.style.cssText = "font-family:monospace;margin:4px 0";
				card.appendChild(path);
				const meta = document.createElement("div");
				meta.style.cssText = "font-size:12px;opacity:0.7;margin-bottom:6px";
				meta.textContent = `${a.absolutePath} — ${formatBytes(a.sizeBytes)}${a.newSizeBytes !== undefined ? ` → ${formatBytes(a.newSizeBytes)}` : ""}`;
				card.appendChild(meta);
				if (a.currentPreview !== undefined) {
					const pre = document.createElement("pre");
					pre.style.cssText = "max-height:120px;overflow:auto;font-size:11px;white-space:pre-wrap;border:1px solid currentColor;opacity:0.8;padding:6px;border-radius:4px";
					pre.textContent = a.currentPreview || "(empty file)";
					card.appendChild(pre);
				}
				const row = document.createElement("div");
				row.style.cssText = "display:flex;gap:8px;margin-top:8px";
				const keep = document.createElement("button");
				keep.textContent = a.operation === "delete_file" ? "Keep file" : "Keep original";
				keep.onclick = () => decide(a.id, false);
				const go = document.createElement("button");
				go.textContent = a.operation === "delete_file" ? "Delete file" : "Replace file";
				go.onclick = () => decide(a.id, true);
				row.appendChild(keep);
				row.appendChild(go);
				card.appendChild(row);
				return card;
			}

			async function decide(id: string, approved: boolean) {
				await ctx.call("approvals.decide", { id, approved }).catch(() => undefined);
				void refresh();
			}

			await refresh();
			const interval = setInterval(() => void refresh(), 2000);
			signal.addEventListener("abort", () => clearInterval(interval), { once: true });
		},
	});
}
