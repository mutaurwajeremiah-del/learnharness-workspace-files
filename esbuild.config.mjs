// Bundles both entry points. Node built-ins stay external for the backend
// (the host does not bundle them); the frontend is a plain browser ES module
// with no external runtime deps of its own.
import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
	entryPoints: ["src/backend.ts"],
	outfile: "dist/backend.cjs",
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node18",
	external: ["node:*"],
	sourcemap: false,
});

await build({
	entryPoints: ["src/main.ts"],
	outfile: "dist/main.js",
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	sourcemap: false,
});

copyFileSync("manifest.json", "dist/manifest.json");
console.log("[build] dist/backend.cjs + dist/main.js + dist/manifest.json ready");
