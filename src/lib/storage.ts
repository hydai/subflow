// Typed wrapper around `chrome.storage.local` for SPEC §7.4's shape
// (`preferences` + `workflows`), with §6.6 failure surfaces routed
// through a `Result<T, E>` discriminated union — no throws cross the
// public surface.
//
// First reads (no record present) return defaults rather than an
// error: `preferences = { languagePriority: [] }`, `workflows = []`.
// Subsequent writes always re-stamp `schemaVersion: 1` so future
// migrations can branch on the stored version.

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

const DEFAULT_PREFERENCES: Preferences = { languagePriority: [] };
const DEFAULT_WORKFLOWS: Workflow[] = [];

export async function getPreferences(): Promise<Result<Preferences, StorageReadError>> {
  const raw = await rawGet();
  if (!raw.ok) return raw;
  return { ok: true, value: raw.value.preferences ?? DEFAULT_PREFERENCES };
}

export async function setPreferences(
  preferences: Preferences,
): Promise<Result<void, StorageWriteError>> {
  return rawSet({ preferences });
}

export async function getWorkflows(): Promise<Result<Workflow[], StorageReadError>> {
  const raw = await rawGet();
  if (!raw.ok) return raw;
  return { ok: true, value: raw.value.workflows ?? DEFAULT_WORKFLOWS };
}

export async function setWorkflows(
  workflows: Workflow[],
): Promise<Result<void, StorageWriteError>> {
  return rawSet({ workflows });
}

async function rawGet(): Promise<Result<RawStorage, StorageReadError>> {
  try {
    const items = await chrome.storage.local.get([...STORAGE_KEYS]);
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
    await chrome.storage.local.set({ schemaVersion: SCHEMA_VERSION, ...items });
    return { ok: true, value: undefined };
  } catch (err) {
    const message = messageOf(err);
    if (message.toUpperCase().includes("QUOTA")) {
      return { ok: false, error: { type: "QUOTA_EXCEEDED", message } };
    }
    return { ok: false, error: { type: "STORAGE_API_ERROR", message } };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
