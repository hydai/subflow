// Regenerate the placeholder Subflow toolbar icons.
//
// SPEC §7.5 lists icons at 16/32/48/128 px. The current artwork is a
// blue square with a white capital "S" — a stand-in until a designed
// icon set is commissioned (#19's "M1-M6 完成後再回頭做正式設計"
// note). Run this script after editing the constants below to
// regenerate the four PNGs under `public/icons/`.
//
// `sharp` is not pinned as a devDependency because the binary is
// heavy (~50 MB across native modules) and only this one-shot
// generator needs it. Install on demand:
//
//   npm install --no-save sharp
//   node scripts/make-icons.mjs
//
// The generated PNGs are committed to the repo; downstream
// developers do NOT need sharp to build the extension.

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error(
    "sharp not installed. Run `npm install --no-save sharp` first, then re-run this script.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ICON_DIR = resolve(root, "public/icons");

const BG = "rgb(37, 99, 235)";
const FG = "#ffffff";

for (const size of [16, 32, 48, 128]) {
  const fontSize = Math.round(size * 0.7);
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <text x="50%" y="55%"
        text-anchor="middle"
        dominant-baseline="middle"
        font-family="Helvetica, Arial, sans-serif"
        font-weight="bold"
        font-size="${fontSize}"
        fill="${FG}">S</text>
</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const outPath = resolve(ICON_DIR, `icon-${size}.png`);
  await writeFile(outPath, buf);
  console.log(`wrote ${outPath} (${size}x${size}, ${buf.length} bytes)`);
}
