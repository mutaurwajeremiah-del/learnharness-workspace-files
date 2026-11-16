/**
 * WORKSPACE SETTINGS (custom build, 2026-11): the one folder the learner-facing
 * agents may CREATE, EDIT, RENAME and (with approval) DELETE files in.
 *
 * This is deliberately separate from `fileAccess` (read-only, whole-home
 * learner sources). Pure core: syntax only — no fs, no os. Whether the folder
 * exists, is writable, or overlaps app-private data is decided at the IO layer
 * (agent/tools/workspace/paths.ts) at the moment of each operation.
 */
/** Used only while `agent.workspace` is absent from settings.json. The
 *  learner can change it in Settings → Agent → Workspace. */
export declare const DEFAULT_WORKSPACE_ROOT = "C:\\Users\\hp\\OneDrive\\Documents\\code understood masterclass";
export interface WorkspaceSettings {
    /** Absolute path of the workspace folder (local drive path or POSIX absolute). */
    root: string;
}
export type WorkspaceSettingsResult = {
    ok: true;
    settings: WorkspaceSettings;
} | {
    ok: false;
    error: string;
};
/** Windows drive letter + separator, or a POSIX absolute path. UNC shares and
 *  device namespaces (\\?\, \\.\) are refused: a network share or raw device
 *  path cannot be canonicalised or compared reliably. */
export declare function isWorkspaceRootSyntax(value: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
/** The strict parser shared by the settings write route and the store reader:
 *  a malformed workspace must never silently decay into the default folder. */
export declare function parseWorkspaceSettings(raw: unknown): WorkspaceSettingsResult;
