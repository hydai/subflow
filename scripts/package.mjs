// Build the Web-Store-ready zip from `dist/`.
// Reads version from package.json and writes `subflow-v<version>.zip`.
// Issue #20 will harden this (typecheck/test gating, file allowlists, etc.).

import { createWriteStream, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const zipPath = resolve(root, `subflow-v${pkg.version}.zip`);

if (!existsSync(distDir)) {
  console.error(`dist/ not found at ${distDir}; run \`npm run build\` first.`);
  process.exit(1);
}

try {
  execFileSync("zip", ["-r", zipPath, "."], { cwd: distDir, stdio: "inherit" });
  console.log(`Created ${zipPath}`);
} catch (err) {
  console.error("Packaging failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
