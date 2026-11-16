const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { activate } = require("./dist/backend.cjs");

async function main() {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wf-smoke-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wf-outside-"));
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-data-"));
	const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-code-"));

	const tools = {};
	let settingsRow;
	const handlers = {};
	const emitted = [];

	const ctx = {
		manifest: { id: "workspace-files", version: "0.1.0" },
		directory: codeDir,
		dataDirectory: dataDir,
		signal: new AbortController().signal,
		cleanup() {},
		registerTools(contribution) {
			for (const tool of contribution.create({ chatId: "c", agent: "teacher" })) tools[tool.name] = tool;
			return () => {};
		},
		handle(name, handler) { handlers[name] = handler; return () => {}; },
		events: { on() { return () => {}; }, emit(topic) { emitted.push(topic); } },
		registerSettings(reg) { settingsRow = reg.rows[0]; return () => {}; },
	};

	activate(ctx);
	assert.ok(settingsRow, "settings row registered");
	assert.deepEqual(Object.keys(tools).sort(), ["append_file", "create_directory", "delete_file", "edit_file", "list_directory", "read_file", "rename_path", "write_file"]);

	// Not configured yet: every tool should refuse clearly.
	await assert.rejects(tools.list_directory.execute("c1", {}), /No workspace folder is configured/);

	// Configure via the settings row's onChange, exactly as the UI would.
	const problem = settingsRow.validate(workspace);
	assert.equal(problem, undefined, `workspace should validate clean: ${problem}`);
	await settingsRow.onChange(workspace);

	// write_file (new) + read_file
	let r = await tools.write_file.execute("c2", { path: "notes/limits.md", content: "# Limits\nepsilon-delta\n" });
	assert.match(r.content[0].text, /Created notes\/limits\.md/);
	r = await tools.read_file.execute("c3", { path: "notes/limits.md" });
	assert.match(r.content[0].text, /epsilon-delta/);

	// write_file without overwrite on existing -> refused
	await assert.rejects(tools.write_file.execute("c4", { path: "notes/limits.md", content: "x" }), /already exists/);

	// edit_file
	r = await tools.edit_file.execute("c5", { path: "notes/limits.md", old_string: "epsilon-delta", new_string: "EPSILON-DELTA" });
	assert.match(r.content[0].text, /Edited/);
	assert.match(fs.readFileSync(path.join(workspace, "notes/limits.md"), "utf8"), /EPSILON-DELTA/);

	// append_file
	r = await tools.append_file.execute("c6", { path: "notes/limits.md", content: "more\n" });
	assert.match(r.content[0].text, /Appended/);

	// create_directory + rename_path
	r = await tools.create_directory.execute("c7", { path: "exercises" });
	assert.match(r.content[0].text, /Created folder exercises/);
	r = await tools.rename_path.execute("c8", { from: "notes/limits.md", to: "exercises/limits.md" });
	assert.match(r.content[0].text, /notes\/limits\.md → exercises\/limits\.md/);

	// Path-traversal must still be refused through the real bundle.
	await assert.rejects(tools.write_file.execute("c9", { path: "../escape.md", content: "x" }), /not allowed|outside/);

	// Windows junction escape refusal (runs on Windows without elevation).
	if (process.platform === "win32") {
		fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret");
		const junction = path.join(workspace, "junction-escape");
		fs.symlinkSync(outside, junction, "junction");
		await assert.rejects(tools.read_file.execute("cj1", { path: "junction-escape/secret.txt" }), /symbolic link or junction/);
		await assert.rejects(tools.write_file.execute("cj2", { path: "junction-escape/pwn.txt", content: "x" }), /symbolic link or junction/);
		fs.unlinkSync(junction);
	}

	// delete_file: blocks until approved via the SAME ctx.handle the frontend calls.
	const pending = tools.delete_file.execute("c10", { path: "exercises/limits.md" });
	for (let i = 0; i < 50 && emitted.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
	assert.ok(emitted.includes("workspace-files.approvals-changed"), "approval event emitted");
	const list = await handlers["approvals.list"]();
	assert.equal(list.length, 1);
	assert.equal(list[0].relativePath, "exercises/limits.md");
	assert.ok(fs.existsSync(path.join(workspace, "exercises/limits.md")), "not deleted while pending");
	const decided = await handlers["approvals.decide"]({ id: list[0].id, approved: true });
	assert.equal(decided.ok, true);
	r = await pending;
	assert.match(r.content[0].text, /Deleted exercises\/limits\.md/);
	assert.ok(!fs.existsSync(path.join(workspace, "exercises/limits.md")));

	// A denied delete must keep the file.
	fs.writeFileSync(path.join(workspace, "keep.md"), "keep me");
	const pending2 = tools.delete_file.execute("c11", { path: "keep.md" });
	for (let i = 0; i < 50 && (await handlers["approvals.list"]()).length === 0; i++) await new Promise((res) => setTimeout(res, 10));
	const [req2] = await handlers["approvals.list"]();
	await handlers["approvals.decide"]({ id: req2.id, approved: false });
	await assert.rejects(pending2, /declined/);
	assert.ok(fs.existsSync(path.join(workspace, "keep.md")));

	// The workspace cannot be the plugin's own code/data folder.
	assert.notEqual(settingsRow.validate(codeDir), undefined);
	assert.notEqual(settingsRow.validate(dataDir), undefined);

	// Real LearnHarness v0.6.1 PluginHost + dist/main.js DOM integration check
	// (runs automatically when ../learnharness checkout is present alongside this folder).
	const lhRoot = path.resolve(__dirname, "../learnharness");
	const hostFile = path.join(lhRoot, "src/server/plugin-host.ts");
	const tsxCli = path.join(lhRoot, "node_modules/tsx/dist/cli.mjs");
	if (fs.existsSync(hostFile) && fs.existsSync(tsxCli)) {
		const hostTestScript = `
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import os from "node:os";
			import path from "node:path";
			import { parseHTML } from "linkedom";
			import { createPluginHost } from ${JSON.stringify(pathToFileURL(hostFile).href)};
			import { activate as activateFrontend } from ${JSON.stringify(pathToFileURL(path.resolve(__dirname, "dist/main.js")).href)};

			const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-real-host-"));
			const pluginsDir = path.join(root, "plugins");
			const pkgDir = path.join(pluginsDir, "workspace-files", "dist");
			const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-real-ws-"));
			fs.mkdirSync(pkgDir, { recursive: true });
			for (const f of ["manifest.json", "backend.cjs", "main.js"]) {
				fs.copyFileSync(path.join(${JSON.stringify(__dirname)}, "dist", f), path.join(pkgDir, f));
			}
			fs.writeFileSync(path.join(root, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { "workspace-files": true } }));

			const notifications = [];
			const host = createPluginHost({
				directory: pluginsDir,
				appVersion: "0.6.1",
				createServices() {
					return {
						learning: {},
						inference: {},
						agents: { dispose: async () => {} },
						workers: { dispose: async () => {} },
						createBackgroundTool() { throw new Error("unused"); },
					};
				},
				onNotification(n) { notifications.push(n); },
			});
			await host.initialize();
			const info = host.list().find((p) => p.id === "workspace-files");
			assert.ok(info, "plugin discovered by real PluginHost");
			assert.equal(info.status, "active", \`expected active status, got \${info.status} (\${info.error ?? ""})\`);
			assert.equal(info.manifest.minAppVersion, "0.6.1");

			for (const agent of ["teacher", "prober", "practice"]) {
				const contrib = host.agentContributions({ chatId: "chat_1", agent }, []);
				assert.equal(contrib.tools.length, 8, \`all 8 tools admitted and schema-validated for \${agent}\`);
			}

			// Mount real dist/main.js in a DOM and wire ctx.call to the real host.call!
			const { document } = parseHTML("<!doctype html><html><body><div id='view'></div></body></html>");
			globalThis.document = document;
			let registeredView;
			let registeredSettings;
			const eventListeners = new Set();
			activateFrontend({
				manifest: info.manifest,
				signal: new AbortController().signal,
				cleanup() {},
				registerView(v) { registeredView = v; return () => {}; },
				registerSettings(s) {
					registeredSettings = s;
					return { update(next) { registeredSettings = { ...registeredSettings, ...next }; }, dispose() {} };
				},
				call(op, input) { return host.call("workspace-files", op, input); },
				onNotification(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); },
				onResync() { return () => {}; },
			});
			assert.ok(registeredView, "dist/main.js registered Workspace Files view");
			assert.ok(registeredSettings, "dist/main.js registered Workspace folder settings row");

			// Configure workspace folder through the frontend settings row's onChange -> host.call("settings.set")
			await registeredSettings.rows[0].onChange(wsDir);
			const assessed = await host.call("workspace-files", "settings.assess");
			assert.equal(assessed.ok, true);

			// Create a file and trigger delete_file through the real host-wrapped tool
			const teacherTools = Object.fromEntries(host.agentContributions({ chatId: "chat_1", agent: "teacher" }, []).tools.map((t) => [t.name, t]));
			await teacherTools.write_file.execute("tc1", { path: "dom-test.md", content: "hello from real host" });
			assert.ok(fs.existsSync(path.join(wsDir, "dom-test.md")));

			const container = document.getElementById("view");
			const mountAbort = new AbortController();
			await registeredView.mount(container, mountAbort.signal);
			assert.match(container.textContent, /Nothing is waiting for your approval/);

			// Start delete_file (blocks on approval), notify frontend, verify DOM card, click "Delete file" button!
			const delPromise = teacherTools.delete_file.execute("tc2", { path: "dom-test.md" });
			for (let i = 0; i < 50 && notifications.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			for (const fn of eventListeners) fn(notifications[notifications.length - 1]);
			for (let i = 0; i < 50 && !container.textContent.includes("dom-test.md"); i++) await new Promise((r) => setTimeout(r, 10));
			assert.match(container.textContent, /Delete file\\?/);
			assert.match(container.textContent, /dom-test\\.md/);

			const buttons = [...container.querySelectorAll("button")];
			const approveBtn = buttons.find((b) => b.textContent === "Delete file");
			assert.ok(approveBtn, "Delete file button rendered in DOM");
			approveBtn.onclick();

			const delResult = await delPromise;
			assert.match(delResult.content[0].text, /Deleted dom-test\\.md/);
			assert.ok(!fs.existsSync(path.join(wsDir, "dom-test.md")));

			mountAbort.abort();
			await host.dispose();
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(wsDir, { recursive: true, force: true });
			console.log("REAL HOST + DOM INTEGRATION: all 7 assertions passed (v0.6.1 PluginHost + linkedom)");
		`;
		const res = spawnSync(process.execPath, [tsxCli, "--input-type=module", "-e", hostTestScript], {
			cwd: lhRoot,
			stdio: "inherit",
		});
		assert.equal(res.status, 0, "Real PluginHost + DOM integration test must pass");
	}

	fs.rmSync(workspace, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(codeDir, { recursive: true, force: true });
	console.log("SMOKE TEST: all 23 assertions passed");
}

main().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
