const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { activate } = require("./dist/backend.cjs");

async function main() {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "wf-smoke-"));
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

	// delete_file: blocks until approved via the SAME ctx.handle the frontend calls.
	const pending = tools.delete_file.execute("c10", { path: "exercises/limits.md" });
	for (let i = 0; i < 50 && emitted.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
	assert.ok(emitted.includes("workspace-files:approvals-changed"), "approval event emitted");
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

	fs.rmSync(workspace, { recursive: true, force: true });
	fs.rmSync(dataDir, { recursive: true, force: true });
	fs.rmSync(codeDir, { recursive: true, force: true });
	console.log("SMOKE TEST: all", 15, "assertions passed");
}

main().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
