// Typed wrapper around `chrome.storage.local` for SPEC §7.4's shape
// (`preferences` + `workflows`), with §6.6 failure surfaces routed
// through a `Result<T, E>` discriminated union — no throws cross the
// public surface.
//
// First reads (no record present) return defaults rather than an
// error: `preferences = { languagePriority: [] }`, `workflows = []`.
// Subsequent writes always re-stamp `schemaVersion: 1` so future
// migrations can branch on the stored version.
//
// chrome.storage.local exposes BOTH a callback-style API
// (synchronous return, error reported via chrome.runtime.lastError)
// and a Promise-returning API. Manifest V3 service workers support
// promises, but Chrome documents the callback variant as canonical
// and only the callback path reliably surfaces lastError when the
// underlying call fails synchronously. To keep failure detection
// solid across both surfaces, we always invoke with a callback and
// check lastError there — that's what `promisifyGet` / `promisifySet`
// below do.

import type { Preferences, Workflow } from "./types";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface StorageReadError {
  type: "STORAGE_API_ERROR";
  message: string;
}

export type StorageWriteError =
  | { type: "QUOTA_EXCEEDED"; message: string }
  | { type: "STORAGE_API_ERROR"; message: string };

export const SCHEMA_VERSION = 1;
const STORAGE_KEYS = ["schemaVersion", "preferences", "workflows"] as const;

interface RawStorage {
  schemaVersion?: number;
  preferences?: Preferences;
  workflows?: Workflow[];
}

export async function getPreferences(): Promise<Result<Preferences, StorageReadError>> {
  const raw = await rawGet();
  if (!raw.ok) return raw;
  // Fresh object — never hand the caller a reference they could
  // mutate into a shared module-level default.
  return {
    ok: true,
    value: raw.value.preferences ?? { languagePriority: [] },
  };
}

export async function setPreferences(
  preferences: Preferences,
): Promise<Result<void, StorageWriteError>> {
  return rawSet({ preferences });
}

export async function getWorkflows(): Promise<Result<Workflow[], StorageReadError>> {
  const raw = await rawGet();
  if (!raw.ok) return raw;
  return { ok: true, value: raw.value.workflows ?? [] };
}

export async function setWorkflows(
  workflows: Workflow[],
): Promise<Result<void, StorageWriteError>> {
  return rawSet({ workflows });
}

async function rawGet(): Promise<Result<RawStorage, StorageReadError>> {
  try {
    const items = await promisifyGet([...STORAGE_KEYS]);
    return { ok: true, value: items as RawStorage };
  } catch (err) {
    return {
      ok: false,
      error: { type: "STORAGE_API_ERROR", message: messageOf(err) },
    };
  }
}

async function rawSet(items: Partial<RawStorage>): Promise<Result<void, StorageWriteError>> {
  try {
    // Always re-stamp schemaVersion so any future migration step has
    // a fresh value to branch on. `chrome.storage.local.set` is a
    // partial update — keys not mentioned here are left alone.
    await promisifySet({ schemaVersion: SCHEMA_VERSION, ...items });
    return { ok: true, value: undefined };
  } catch (err) {
    const message = messageOf(err);
    if (message.toUpperCase().includes("QUOTA")) {
      return { ok: false, error: { type: "QUOTA_EXCEEDED", message } };
    }
    return { ok: false, error: { type: "STORAGE_API_ERROR", message } };
  }
}

function promisifyGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        const last = chrome.runtime.lastError;
        if (last) {
          reject(new Error(last.message ?? "chrome.storage.local.get failed"));
          return;
        }
        resolve(items ?? {});
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function promisifySet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items, () => {
        const last = chrome.runtime.lastError;
        if (last) {
          reject(new Error(last.message ?? "chrome.storage.local.set failed"));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
