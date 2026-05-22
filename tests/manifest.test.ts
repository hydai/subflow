import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const manifestPath = resolve(repoRoot, "public/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

const PROHIBITED_PERMISSIONS = ["tabs", "cookies", "<all_urls>", "history", "downloads"];

describe("public/manifest.json (SPEC §7.5)", () => {
  it("declares Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requests host_permissions limited to youtube.com over https", () => {
    expect(manifest.host_permissions).toEqual(["https://www.youtube.com/*"]);
  });

  it("requests only the storage and scripting API permissions", () => {
    expect(manifest.permissions).toEqual(["storage", "scripting"]);
  });

  it("does not request any of the explicitly-prohibited permissions", () => {
    const permissions = manifest.permissions as string[];
    const hostPermissions = manifest.host_permissions as string[];
    for (const banned of PROHIBITED_PERMISSIONS) {
      expect(permissions).not.toContain(banned);
      expect(hostPermissions).not.toContain(banned);
    }
  });

  it("defines an action with default_title but no default_popup", () => {
    expect(manifest).toHaveProperty("action.default_title", "Subflow");
    expect(manifest.action).not.toHaveProperty("default_popup");
  });

  it("registers an options_page entry", () => {
    expect(manifest.options_page).toBe("options.html");
  });

  it("registers a background service worker", () => {
    expect(manifest).toHaveProperty("background.service_worker", "background.js");
  });

  it("declares a content script for the entire YouTube domain at document_idle", () => {
    const contentScripts = manifest.content_scripts as Array<Record<string, unknown>>;
    expect(contentScripts).toHaveLength(1);
    const first = contentScripts[0]!;
    expect(first.matches).toEqual(["https://www.youtube.com/*"]);
    expect(first.js).toEqual(["content.js"]);
    expect(first.run_at).toBe("document_idle");
  });

  it("ships icons for all four standard sizes", () => {
    for (const size of ["16", "32", "48", "128"]) {
      expect(manifest).toHaveProperty(["icons", size], `icons/icon-${size}.png`);
    }
  });
});
