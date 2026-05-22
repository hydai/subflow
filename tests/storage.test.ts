import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPreferences, setPreferences, getWorkflows, setWorkflows, SCHEMA_VERSION } from "@/lib/storage";
import type { Preferences, Workflow } from "@/lib/types";

interface FakeStorage {
  store: Record<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeFakeStorage(initial: Record<string, unknown> = {}): FakeStorage {
  const store: Record<string, unknown> = { ...initial };
  const get = vi.fn(async (keys: string | string[]) => {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of wanted) {
      if (k in store) out[k] = store[k];
    }
    return out;
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  return { store, get, set };
}

function installFakeStorage(fake: FakeStorage): void {
  vi.stubGlobal("chrome", { storage: { local: { get: fake.get, set: fake.set } } });
}

beforeEach(() => {
  // Each test installs its own fake before exercising the wrapper.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const samplePreferences: Preferences = { languagePriority: ["zh-TW", "en"] };
const sampleWorkflow: Workflow = {
  id: "wf-1",
  name: "Summarize",
  url: "https://example.com/api",
  promptTemplate: "Summarize: {{transcript}}",
  autoRun: false,
  headers: {},
};

describe("storage.getPreferences", () => {
  it("returns the stored preferences on a normal read", async () => {
    installFakeStorage(makeFakeStorage({ preferences: samplePreferences }));
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(samplePreferences);
  });

  it("returns the default preferences when storage is empty (not an error)", async () => {
    installFakeStorage(makeFakeStorage());
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ languagePriority: [] });
  });

  it("returns a STORAGE_API_ERROR when chrome.storage.local.get throws", async () => {
    const fake = makeFakeStorage();
    fake.get.mockRejectedValueOnce(new Error("boom"));
    installFakeStorage(fake);
    const result = await getPreferences();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("STORAGE_API_ERROR");
    expect(result.error.message).toContain("boom");
  });
});

describe("storage.setPreferences", () => {
  it("writes the preferences and stamps schemaVersion", async () => {
    const fake = makeFakeStorage();
    installFakeStorage(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(true);
    expect(fake.set).toHaveBeenCalledWith({
      schemaVersion: SCHEMA_VERSION,
      preferences: samplePreferences,
    });
  });

  it("returns QUOTA_EXCEEDED when chrome.storage rejects with a quota message", async () => {
    const fake = makeFakeStorage();
    fake.set.mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));
    installFakeStorage(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("QUOTA_EXCEEDED");
  });

  it("returns STORAGE_API_ERROR for any other write failure", async () => {
    const fake = makeFakeStorage();
    fake.set.mockRejectedValueOnce(new Error("disk on fire"));
    installFakeStorage(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("STORAGE_API_ERROR");
    expect(result.error.message).toContain("disk on fire");
  });
});

describe("storage.getWorkflows", () => {
  it("returns the stored workflows on a normal read", async () => {
    installFakeStorage(makeFakeStorage({ workflows: [sampleWorkflow] }));
    const result = await getWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([sampleWorkflow]);
  });

  it("returns an empty workflow list when storage is empty (not an error)", async () => {
    installFakeStorage(makeFakeStorage());
    const result = await getWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe("storage.setWorkflows", () => {
  it("writes workflows without touching preferences (partial-update contract)", async () => {
    const fake = makeFakeStorage({ preferences: samplePreferences });
    installFakeStorage(fake);
    const result = await setWorkflows([sampleWorkflow]);
    expect(result.ok).toBe(true);
    expect(fake.set).toHaveBeenCalledWith({
      schemaVersion: SCHEMA_VERSION,
      workflows: [sampleWorkflow],
    });
    // The fake store also still has preferences (proves we did not
    // overwrite the whole record).
    expect(fake.store.preferences).toEqual(samplePreferences);
  });
});
