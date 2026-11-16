import * as fs from "node:fs";
import * as path from "node:path";
import { isWorkspaceRootSyntax } from "./paths.js";

/** The plugin's own tiny settings store: <dataDirectory>/settings.json.
 *  The host does not load/save plugin settings, so this plugin owns it. */

export interface StoredSettings { root: string | null }

export function readSettings(dataDirectory: string): StoredSettings {
	const file = path.join(dataDirectory, "settings.json");
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		const root = typeof raw?.root === "string" ? raw.root : null;
		if (root && !isWorkspaceRootSyntax(root).ok) return { root: null };
		return { root };
	} catch {
		return { root: null };
	}
}

export function writeSettings(dataDirectory: string, settings: StoredSettings): void {
	fs.mkdirSync(dataDirectory, { recursive: true });
	const file = path.join(dataDirectory, "settings.json");
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(settings, null, 2));
	fs.renameSync(temp, file);
}
