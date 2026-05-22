import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-entry build for the Chrome extension.
//
// Entry filenames are fixed (no [hash]) because `manifest.json` and the
// options HTML reference them by static path. Non-entry chunk and asset
// filenames include `[hash]` to avoid silent collisions when modules
// happen to share basenames.
//
// MV3 caveat: `content.js` is declared in `manifest.json`'s
// `content_scripts` without `"type": "module"`, so Chrome loads it as a
// classic script. Classic scripts cannot contain ESM module syntax —
// neither `import` nor `export` — so the emitted `content.js` must be
// self-contained and free of any module declarations. With today's
// empty stubs nothing is shared, so Rollup emits no chunks at all; the
// bare `export {}` markers in the stub source files are stripped from
// the bundle because they have no semantic effect. The first downstream
// issue that introduces shared code into `content.ts` or adds real
// `export` declarations to it (likely #5 or #11) must either keep
// content.ts free of cross-file imports/exports or split the build
// into per-entry Vite invocations with `inlineDynamicImports: true`
// for the classic entries.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        "content-main": resolve(__dirname, "src/content/main-world.ts"),
        sidebar: resolve(__dirname, "src/sidebar/index.ts"),
        options: resolve(__dirname, "options.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith(".html")) {
            return "[name][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
