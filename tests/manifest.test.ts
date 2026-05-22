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
    const action = manifest.action as Record<string, unknown>;
    expect(action).toBeDefined();
    expect(action.default_title).toBe("Subflow");
    expect(action).not.toHaveProperty("default_popup");
  });

  it("registers an options_page entry", () => {
    expect(manifest.options_page).toBe("options.html");
  });

  it("registers a background service worker", () => {
    const background = manifest.background as Record<string, unknown>;
    expect(background.service_worker).toBe("background.js");
  });

  it("declares a content script for the YouTube watch domain", () => {
    const contentScripts = manifest.content_scripts as Array<Record<string, unknown>>;
    expect(contentScripts).toHaveLength(1);
    const first = contentScripts[0]!;
    expect(first.matches).toEqual(["https://www.youtube.com/*"]);
    expect(first.js).toEqual(["content.js"]);
    expect(first.run_at).toBe("document_idle");
  });

  it("ships icons for all four standard sizes", () => {
    const icons = manifest.icons as Record<string, string>;
    for (const size of ["16", "32", "48", "128"]) {
      expect(icons[size]).toBe(`icons/icon-${size}.png`);
    }
  });
});
