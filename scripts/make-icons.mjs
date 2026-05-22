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
//   npm install --no-save --no-package-lock sharp
//   node scripts/make-icons.mjs
//
// `--no-save` keeps package.json untouched and
// `--no-package-lock` prevents npm from rewriting package-lock.json
// for the one-off install (otherwise the lockfile would churn every
// time someone regenerates icons). The generated PNGs are committed
// to the repo; downstream developers do NOT need sharp to build the
// extension.

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error(
    "sharp not installed. Run `npm install --no-save --no-package-lock sharp` first, then re-run this script.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ICON_DIR = resolve(root, "public/icons");

const BG = "rgb(37, 99, 235)";
const FG = "#ffffff";

// Stylised "S" defined as an explicit SVG path so the GEOMETRY is
// reproducible across operating systems and CI environments — the
// previous text-based version used `font-family="Helvetica, Arial"`
// which silently substituted whichever similar font was installed,
// producing visibly different glyphs on different machines.
//
// PNG bytes are NOT guaranteed to be identical across runs: different
// `sharp` / libvips versions can vary chunk metadata (gAMA, pHYs,
// tEXt) and the zlib-compressed IDAT stream even from the same
// rendered pixels. The PNGs are committed once and treated as build
// artifacts; regenerate only when the geometry or color change.
//
// The path is hand-drawn in a 100×100 viewBox; the parent <svg>
// scales it uniformly to whatever pixel size is requested.
const S_PATH =
  "M76 22 C76 14 68 8 56 8 C42 8 30 14 30 26 C30 38 42 44 56 50 " +
  "C68 56 76 60 76 70 C76 82 64 92 50 92 C36 92 24 86 24 76";
const S_STROKE_WIDTH = 14;

for (const size of [16, 32, 48, 128]) {
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="${BG}"/>
  <path d="${S_PATH}"
        fill="none"
        stroke="${FG}"
        stroke-width="${S_STROKE_WIDTH}"
        stroke-linecap="round"/>
</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const outPath = resolve(ICON_DIR, `icon-${size}.png`);
  await writeFile(outPath, buf);
  console.log(`wrote ${outPath} (${size}x${size}, ${buf.length} bytes)`);
}
