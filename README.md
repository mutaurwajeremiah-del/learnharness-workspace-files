# Workspace Files — a LearnHarness community plugin

A plugin port of the native "workspace file tools" feature: gives the Teacher,
Practitioner and Prober eight tools — `read_file`, `list_directory`,
`write_file`, `edit_file`, `append_file`, `create_directory`, `rename_path`,
`delete_file` — confined to one folder you choose, with `delete_file` and an
overwriting `write_file` gated behind your approval.

Built against LearnHarness's real, documented plugin API (`registerTools`,
`registerSettings`, `registerView`, `ctx.handle`/`ctx.call`), as described in
the app's own `docs/plugin-authoring.md` and `docs/plugin-api/`.

## What is verified, and what is not

**Verified**, by actually running the built code:

- `npx tsc` typechecks `src/` cleanly against a stub of the plugin API
  (`.sdk/index.d.ts`, written from the real API reference — not the real SDK
  package, see below).
- `npm run build` (esbuild) produces `dist/backend.cjs` and `dist/main.js`
  without errors.
- `node smoke.cjs` loads the real built `dist/backend.cjs`, registers the
  settings row and all 8 tools against a fake `ctx`, and exercises them
  against a real temporary folder: create, read, edit, append, mkdir,
  rename, a path-traversal attempt correctly refused, and the full
  delete-approval flow (blocks → emits an event → lists the pending request
  → the frontend's exact `approvals.decide` call resolves it → the file is
  actually deleted; a denied decision correctly keeps the file). 15/15
  assertions pass.
- The security logic (`src/paths.ts`) is a direct port of the native
  feature's `src/agent/tools/workspace/paths.ts`, which has its own
  dedicated automated test suite (`tests/workspace-fileops.test.ts`,
  57+ cases including Windows junctions) — ported here because plugins
  cannot import private host modules, not because it was rewritten from
  scratch.

**Not verified** — this has never been loaded inside a real, running
LearnHarness:

- The `.sdk/` in this folder is a **stub I wrote from the API reference
  docs**, not the real `learnharness-plugin-api` package. Before building
  for real use, replace it: run `npm run sdk` inside a LearnHarness checkout,
  or download the plugin authoring skill and copy its `types/` over `.sdk/`.
  Re-run `npx tsc` after swapping it in case the real types differ from my
  reading of the docs in any small way.
- `src/main.ts` (the approval panel) has never rendered in a real browser
  context or talked to a real backend over `ctx.call`. The polling-panel
  approach is deliberately simple to maximize the odds it works first try,
  but "it builds and its logic is straightforward" is not the same as
  "confirmed working in the app."
- No test has run with the manifest's declared `minAppVersion` against a
  real app instance.

## Install for development

```sh
# from this folder's PARENT, inside LearnHarness's plugins directory
# (Settings → Community plugins shows the exact path):
cp -r learnharness-workspace-files "<plugins-directory>/workspace-files"
cd "<plugins-directory>/workspace-files"
npm install
# swap in the real SDK before building for real use:
#   npm run sdk   (if run from inside a LearnHarness checkout), or
#   copy the downloaded authoring skill's types/ over .sdk/
npm run build
```

Then in LearnHarness: Settings → Community plugins → refresh → enable
**Workspace Files**, restart the app, open its settings page and set the
workspace folder, then open the **Workspace Files** view from the sidebar
whenever a delete or overwrite is waiting on you.

## Re-running the smoke test after changes

```sh
npm run build && node smoke.cjs
```

## Known gaps versus the native feature

- No Windows-junction test runs here (the native suite has one; this plugin
  reimplements the same symlink-refusal logic but that specific test was not
  ported).
- The approval panel is a polling sidebar view, not a dialog that pops up on
  its own. Upgrading it to use `ctx.ui.openSurface` for an actual modal is a
  reasonable next step once this is confirmed working at all — see
  `docs/dialog-overlay-contract.md` and the `ctx.ui` method list in
  `docs/plugin-authoring.md` for the real host-side rules to follow.
- `isSensitivePath`'s denylist here is a reasonable-but-independent
  reimplementation, not a copy of any private host list.

## License

Reuses logic from LearnHarness (https://github.com/amosblomqvist/learnharness),
licensed AGPL-3.0. This plugin is a derivative work; keep the license and
attribution if you distribute it.
