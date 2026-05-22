import { describe, it, expect, vi, afterEach } from "vitest";
import { getPreferences, setPreferences, getWorkflows, setWorkflows, SCHEMA_VERSION } from "@/lib/storage";
import type { Preferences, Workflow } from "@/lib/types";

type GetCallback = (items: Record<string, unknown>) => void;
type SetCallback = () => void;

interface FakeChrome {
  store: Record<string, unknown>;
  lastError: { message: string } | undefined;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
}

function makeFakeChrome(initial: Record<string, unknown> = {}): FakeChrome {
  const store: Record<string, unknown> = { ...initial };
  const fake: FakeChrome = {
    store,
    lastError: undefined,
    get: vi.fn((keys: string[], cb: GetCallback) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in store) out[k] = store[k];
      }
      // Defer the callback so async code paths can observe ordering.
      Promise.resolve().then(() => cb(out));
    }),
    set: vi.fn((items: Record<string, unknown>, cb: SetCallback) => {
      Object.assign(store, items);
      Promise.resolve().then(cb);
    }),
  };
  return fake;
}

function install(fake: FakeChrome): void {
  vi.stubGlobal("chrome", {
    storage: { local: { get: fake.get, set: fake.set } },
    runtime: {
      // The wrapper reads `chrome.runtime.lastError` each time the
      // callback fires. We expose a getter so tests can flip it on a
      // per-call basis.
      get lastError() {
        return fake.lastError;
      },
    },
  });
}

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
    install(makeFakeChrome({ preferences: samplePreferences }));
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(samplePreferences);
  });

  it("returns the default preferences when storage is empty (not an error)", async () => {
    install(makeFakeChrome());
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ languagePriority: [] });
  });

  it("returns a fresh default object that callers can mutate safely", async () => {
    install(makeFakeChrome());
    const a = await getPreferences();
    const b = await getPreferences();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
    (a.value as Preferences).languagePriority.push("zh-TW");
    expect(b.value.languagePriority).toEqual([]);
  });

  it("returns STORAGE_API_ERROR when chrome.runtime.lastError is set on read", async () => {
    const fake = makeFakeChrome();
    fake.lastError = { message: "I/O exploded" };
    install(fake);
    const result = await getPreferences();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("STORAGE_API_ERROR");
    expect(result.error.message).toContain("I/O exploded");
  });

  it("returns STORAGE_API_ERROR when chrome.storage.local.get throws synchronously", async () => {
    const fake = makeFakeChrome();
    fake.get.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    install(fake);
    const result = await getPreferences();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("STORAGE_API_ERROR");
    expect(result.error.message).toContain("boom");
  });
});

describe("storage.setPreferences", () => {
  it("writes the preferences and stamps schemaVersion", async () => {
    const fake = makeFakeChrome();
    install(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(true);
    expect(fake.set).toHaveBeenCalledWith(
      { schemaVersion: SCHEMA_VERSION, preferences: samplePreferences },
      expect.any(Function),
    );
  });

  it("returns QUOTA_EXCEEDED when chrome.runtime.lastError mentions QUOTA on write", async () => {
    const fake = makeFakeChrome();
    fake.lastError = { message: "QUOTA_BYTES quota exceeded" };
    install(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("QUOTA_EXCEEDED");
  });

  it("returns STORAGE_API_ERROR for any other write failure", async () => {
    const fake = makeFakeChrome();
    fake.lastError = { message: "disk on fire" };
    install(fake);
    const result = await setPreferences(samplePreferences);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe("STORAGE_API_ERROR");
    expect(result.error.message).toContain("disk on fire");
  });
});

describe("storage.getWorkflows", () => {
  it("returns the stored workflows on a normal read", async () => {
    install(makeFakeChrome({ workflows: [sampleWorkflow] }));
    const result = await getWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([sampleWorkflow]);
  });

  it("returns an empty workflow list when storage is empty (not an error)", async () => {
    install(makeFakeChrome());
    const result = await getWorkflows();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("returns a fresh default array that callers can mutate safely", async () => {
    install(makeFakeChrome());
    const a = await getWorkflows();
    const b = await getWorkflows();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value).not.toBe(b.value);
    a.value.push(sampleWorkflow);
    expect(b.value).toEqual([]);
  });
});

describe("storage.setWorkflows", () => {
  it("writes workflows without touching preferences (partial-update contract)", async () => {
    const fake = makeFakeChrome({ preferences: samplePreferences });
    install(fake);
    const result = await setWorkflows([sampleWorkflow]);
    expect(result.ok).toBe(true);
    expect(fake.set).toHaveBeenCalledWith(
      { schemaVersion: SCHEMA_VERSION, workflows: [sampleWorkflow] },
      expect.any(Function),
    );
    expect(fake.store.preferences).toEqual(samplePreferences);
  });
});
