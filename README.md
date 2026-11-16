# Workspace Files — a LearnHarness community plugin

A plugin port of the native "workspace file tools" feature: gives the Teacher,
Practitioner and Prober eight tools — `read_file`, `list_directory`,
`write_file`, `edit_file`, `append_file`, `create_directory`, `rename_path`,
`delete_file` — confined to one folder you choose, with `delete_file` and an
overwriting `write_file` gated behind your approval.

Built against LearnHarness's real, documented plugin API v1 (`registerTools`,
`registerSettings`, `registerView`, `ctx.handle`/`ctx.call`, `ctx.onNotification`),
as described in `docs/plugin-authoring.md` and `docs/plugin-api/`.

## What is verified

Verified by building and running the real compiled bundles (`dist/backend.cjs` + `dist/main.js`):

- **Real Plugin SDK v1 Typecheck (`npm run typecheck`)**:
  - `.sdk/` contains the **real `learnharness-plugin-api` v1 declarations** emitted directly from upstream LearnHarness v0.6.1 (`node ../learnharness/scripts/build-plugin-types.mjs .sdk`).
  - `npm run typecheck` (`tsc --noEmit`) passes with zero errors against the real v0.6.1 `PluginBackendContext` and `PluginFrontendContext` contracts.
- **Bundle Build (`npm run build`)**:
  - `esbuild` produces `dist/backend.cjs`, `dist/main.js`, and `dist/manifest.json` cleanly.
- **End-to-End Smoke, Security & Real v0.6.1 Host + DOM Suite (`node smoke.cjs` — 23/23 assertions pass)**:
  1. **All 8 tools & security guards (`16 assertions`)**: Exercises `dist/backend.cjs` against a real temporary folder on Windows: create, read, edit, append, mkdir, rename, path-traversal refusal (`../`), **Windows junction escape refusal** (`fs.symlinkSync(..., "junction")`), protected plugin code/data directory refusal, and the full delete-approval flow (both approved and declined).
  2. **Real LearnHarness v0.6.1 `PluginHost` + `dist/main.js` DOM Integration (`7 assertions`)**:
     - Loads the built `dist/` package inside LearnHarness's real `createPluginHost` (`src/server/plugin-host.ts` with `appVersion: "0.6.1"`), verifying `manifest.json` (`minAppVersion: "0.6.1"`) and activating `dist/backend.cjs`.
     - Verifies that `host.agentContributions(...)` admits all 8 tools and validates their JSON schemas (`validatePluginSchema`) for `teacher`, `prober`, and `practice`.
     - Mounts the real `dist/main.js` in a DOM (`linkedom`) wired to `host.call("workspace-files", ...)` and `ctx.onNotification`, sets the workspace folder through the registered frontend settings row (`settings.set` / `settings.assess`), triggers a live `delete_file` tool call, verifies the pending approval card renders in the DOM, and clicks the DOM **Delete file** button to resolve the pending tool call end-to-end.

## Install in LearnHarness (v0.6.1+)

### Option 1: From the GitHub Release
Download `manifest.json`, `backend.cjs`, and `main.js` from the [v0.1.0 release](https://github.com/mutaurwajeremiah-del/learnharness-workspace-files/releases/tag/v0.1.0) into `<plugins-directory>/workspace-files/dist/`.

### Option 2: Build from Source
```sh
# Inside LearnHarness's plugins directory (Settings → Community plugins shows the path):
git clone https://github.com/mutaurwajeremiah-del/learnharness-workspace-files.git "<plugins-directory>/workspace-files"
cd "<plugins-directory>/workspace-files"
npm install --foreground-scripts
npm run build
```

Then in LearnHarness: **Settings → Community plugins → Refresh** → enable **Workspace Files**, open its settings page and set your **Workspace folder**, and open the **Workspace Files** view from the sidebar whenever a delete or overwrite is waiting for your approval.

## Re-running the verification suite

```sh
npm run typecheck && npm run build && node smoke.cjs
```

## Notes & future enhancements

- The approval UI is a sidebar view (`registerView`) that updates live on `workspace-files.approvals-changed` notifications (with a 2s fallback poll while open). Upgrading it to pop up an automatic modal via `ctx.ui.openSurface` / `ctx.ui.openDialog` is a natural next enhancement.
- `isSensitivePath`'s denylist in `src/paths.ts` is a self-contained defense-in-depth check; always choose a dedicated learning workspace folder that does not contain credentials or private keys.

## License

Reuses logic from LearnHarness (https://github.com/amosblomqvist/learnharness),
licensed AGPL-3.0. This plugin is a derivative work; keep the license and
attribution if you distribute it.
