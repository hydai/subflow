// Build the Web-Store-ready zip from `dist/`.
// Reads version from package.json, asserts the bundled manifest version
// matches, and writes `subflow-v<version>.zip` using the `archiver` Node
// package (no dependency on the system `zip` binary). Issue #20 will
// harden this further (typecheck/test gating, file allowlists, etc.).

import { createWriteStream, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// archiver@8 is ESM-native and exposes per-format classes
// (`ZipArchive`, `TarArchive`, `JsonArchive`). It no longer exports a
// callable default factory the way archiver@<=7 did, so the old
// `import archiver from "archiver"; archiver("zip", ...)` pattern
// throws at runtime.
import { ZipArchive } from "archiver";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const distManifestPath = resolve(distDir, "manifest.json");

if (!existsSync(distDir)) {
  console.error(`dist/ not found at ${distDir}; run \`npm run build\` first.`);
  process.exit(1);
}

if (!existsSync(distManifestPath)) {
  console.error(`dist/manifest.json not found; run \`npm run build\` first.`);
  process.exit(1);
}

const distManifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
if (distManifest.version !== pkg.version) {
  console.error(
    `Version mismatch: package.json is ${pkg.version} but dist/manifest.json is ${distManifest.version}. Update public/manifest.json so they agree before packaging.`,
  );
  process.exit(1);
}

const zipPath = resolve(root, `subflow-v${pkg.version}.zip`);
const output = createWriteStream(zipPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

await new Promise((resolvePromise, rejectPromise) => {
  output.on("close", resolvePromise);
  output.on("error", rejectPromise);
  archive.on("error", rejectPromise);
  archive.pipe(output);
  archive.directory(distDir, false);
  archive.finalize();
});

const { size } = statSync(zipPath);
console.log(`Created ${zipPath} (${size} bytes)`);
