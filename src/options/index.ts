// Subflow options page (SPEC §6.8 / §7.4 / §7.6).
//
// Pure DOM rendering — no framework — keyed off two pieces of state:
// the `Workflow[]` array and the `string[]` language priority. Every
// workflow mutation routes through `setWorkflows`, language saves
// route through `setPreferences`, and the page re-renders from the
// post-mutation state, so the UI is always a reflection of
// `chrome.storage.local` (modulo the in-flight edit form's local
// state).
//
// Inline errors live next to the field they describe (SPEC §7.6); no
// alert / chrome.notifications / console.error is used as a user-
// visible failure surface.

import {
  getWorkflows,
  setWorkflows,
  getPreferences,
  setPreferences,
} from "@/lib/storage";
import { validateWorkflow } from "@/lib/validate-workflow";
import type { WorkflowValidationError } from "@/lib/validate-workflow";
import type { Workflow } from "@/lib/types";

const root = document.getElementById("app")!;

// Header rows are kept as an ORDERED LIST of {id, key, value} during
// editing, separate from the Workflow.headers Record. Editing keys
// in a Record live-updates the data structure as the user types,
// which races with the value field's input handler (the value writes
// to "Aut" when the name field has typed "Aut" before "Authorization"
// resolves). Keeping a row-id-based array decouples in-flight key
// typing from header lookup, and we collapse to a Record only at
// save time.
interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

type EditState =
  | { mode: "list" }
  | {
      mode: "edit";
      draft: Workflow;
      headerRows: HeaderRow[];
      isNew: boolean;
    };

interface AppState {
  workflows: Workflow[];
  languagePriority: string[];
  edit: EditState;
  validationErrors: WorkflowValidationError[];
  // Top-of-page banner. Carries both save failures and load-time
  // warnings, distinguished by `source` so the banner can be
  // cleared by the right code path without substring-matching the
  // message text:
  //   - "preferences"  → resolved by a successful setPreferences
  //   - "workflows"    → resolved by a successful setWorkflows
  //   - "load"         → resolved by EITHER a successful save (the
  //                      user has demonstrated the storage path
  //                      works again; whatever was wrong at load
  //                      time is no longer worth nagging about)
  banner: { source: "preferences" | "workflows" | "load"; message: string } | null;
  // Inline error for the language-priority section. Lives next to
  // the section per SPEC §7.6.
  languageError: string | null;
}

const state: AppState = {
  workflows: [],
  languagePriority: [],
  edit: { mode: "list" },
  validationErrors: [],
  banner: null,
  languageError: null,
};

// Clear the banner when its `source` is in the set of sources that
// the just-finished save resolves. "load" is resolved by anything
// (the storage path is provably working again); "preferences" only
// by a preferences save; "workflows" only by a workflows save.
function clearBannerIfResolvedBy(
  resolved: ReadonlyArray<"preferences" | "workflows" | "load">,
): void {
  if (state.banner === null) return;
  if (resolved.includes(state.banner.source)) state.banner = null;
}

void bootstrap();

async function bootstrap(): Promise<void> {
  const [wfs, prefs] = await Promise.all([getWorkflows(), getPreferences()]);
  // Defensive shape-checks before trusting what came out of
  // chrome.storage.local: extension storage can be edited by the
  // user, by other extensions sharing storage (Subflow doesn't, but
  // future code might), or by a stale older-schema version. Coerce
  // any unexpected shape back to a safe default and surface a
  // top-of-page warning so the user knows the load wasn't clean.
  let loadWarning: string | null = null;
  if (wfs.ok) {
    // Defensively unwrap. getWorkflows()'s type says Workflow[] but
    // chrome.storage.local can hand back anything a user / older
    // schema put there (object, string, missing field, …). Bail to
    // [] if it's not even an array, so the for…of can't throw a
    // non-iterable error or iterate string characters.
    const candidates = Array.isArray(wfs.value) ? (wfs.value as unknown[]) : [];
    if (!Array.isArray(wfs.value)) {
      // Wording: this is an IN-MEMORY fallback, not a durable reset.
      // chrome.storage.local still holds whatever malformed value
      // was there; it'll be overwritten only when the user
      // successfully saves something new. Avoid copy that implies
      // we've already destroyed their data.
      loadWarning =
        "Stored workflows were not an array; showing an empty list until you save changes.";
    }
    const repaired: Workflow[] = [];
    let droppedCount = 0;
    for (const candidate of candidates) {
      const repairedCandidate = repairWorkflow(candidate);
      if (repairedCandidate === null) {
        droppedCount += 1;
      } else {
        repaired.push(repairedCandidate);
      }
    }
    state.workflows = repaired;
    if (droppedCount > 0) {
      loadWarning = `Some stored workflows (${droppedCount}) were malformed and have been hidden until you re-save settings.`;
    }
  } else {
    state.workflows = [];
  }
  if (prefs.ok) {
    // prefs.value's compile-time type is Preferences, but stored
    // data could be a string / null / etc. Guard each access.
    const prefsValue = prefs.value as unknown;
    if (prefsValue !== null && typeof prefsValue === "object") {
      const langs = (prefsValue as { languagePriority?: unknown }).languagePriority;
      if (Array.isArray(langs) && langs.every((s) => typeof s === "string")) {
        state.languagePriority = langs as string[];
      } else {
        state.languagePriority = [];
        loadWarning =
          loadWarning ??
          "Stored language priority was malformed; showing an empty list until you save changes.";
      }
    } else {
      state.languagePriority = [];
      loadWarning =
        loadWarning ??
        "Stored preferences were malformed; showing defaults until you save changes.";
    }
  } else {
    state.languagePriority = [];
  }
  if (!wfs.ok || !prefs.ok) {
    state.banner = {
      source: "load",
      message:
        "Could not load saved settings. Showing defaults until a successful write happens.",
    };
  } else if (loadWarning !== null) {
    state.banner = { source: "load", message: loadWarning };
  }
  render();
}

// Repair recoverable shape drift in a stored Workflow candidate.
// Returns the repaired Workflow on success, or null when the
// shape is too broken to fix (no id, name, url, promptTemplate,
// or autoRun).
//
// Recoverable cases:
//   - missing `headers` → default to `{}`
//   - `headers` is null / array / non-object → default to `{}`
//   - header values that aren't strings → coerced via `String(...)`
//
// Non-recoverable cases (return null):
//   - the whole value isn't an object
//   - id / name / url / promptTemplate isn't a string
//   - autoRun isn't a boolean
//
// Callers (so far: only bootstrap) surface a single warning to the
// user when any entry was dropped, so they know their stored state
// isn't fully visible until they re-save.
function repairWorkflow(value: unknown): Workflow | null {
  if (value === null || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  // SPEC §7.4 says new ids should be UUID v4. We DON'T enforce that
  // shape at load time, though — a stricter check would hide
  // pre-existing workflows from older versions of Subflow (or from
  // any future bulk-import path that uses its own id scheme),
  // which would be data loss on upgrade. The id only needs to be a
  // non-empty string so downstream code (move / edit / delete by
  // id) can address each row. New ids issued by the editor still
  // come from crypto.randomUUID() and ARE UUID v4 — the SPEC
  // requirement is preserved for creation, just not enforced as a
  // load-time filter.
  if (typeof w.id !== "string" || w.id.length === 0) return null;
  if (typeof w.name !== "string") return null;
  if (typeof w.url !== "string") return null;
  if (typeof w.promptTemplate !== "string") return null;
  if (typeof w.autoRun !== "boolean") return null;
  // Object.create(null) avoids prototype pollution if the stored
  // headers contain a key like "__proto__" / "constructor"; on a
  // plain `{}`, assigning headers["__proto__"] = "x" would mutate
  // Object.prototype. The Workflow type tolerates this because
  // it's a Record, not a class instance.
  const headers = Object.create(null) as Record<string, string>;
  if (w.headers !== null && typeof w.headers === "object" && !Array.isArray(w.headers)) {
    for (const [k, v] of Object.entries(w.headers as Record<string, unknown>)) {
      headers[k] = typeof v === "string" ? v : String(v);
    }
  }
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    promptTemplate: w.promptTemplate,
    autoRun: w.autoRun,
    headers,
  };
}

function render(): void {
  root.setAttribute("aria-busy", "false");
  root.replaceChildren(...renderApp());
}

function renderApp(): HTMLElement[] {
  const h1 = el("h1", {}, "Subflow");
  const langSection = renderLanguageSection();
  const workflowsSection =
    state.edit.mode === "edit"
      ? renderEditForm(state.edit.draft, state.edit.headerRows, state.edit.isNew)
      : renderWorkflowsList();
  const globalErr =
    state.banner !== null
      ? [el("p", { class: "error global", role: "alert" }, state.banner.message)]
      : [];
  return [h1, ...globalErr, langSection, workflowsSection];
}

// --- Language priority section ------------------------------------

function renderLanguageSection(): HTMLElement {
  const section = el("section", { "aria-labelledby": "lang-h2" });
  section.appendChild(el("h2", { id: "lang-h2" }, "Language priority"));
  section.appendChild(
    el(
      "p",
      { class: "muted" },
      "BCP-47 codes in priority order. Subflow picks the first match for each video.",
    ),
  );
  const list = el("div", { class: "lang-prefs" });
  state.languagePriority.forEach((lang, idx) => {
    const row = el("div", { class: "header-row" });
    const input = el("input", {
      type: "text",
      value: lang,
      "aria-label": `Language ${idx + 1}`,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      state.languagePriority[idx] = input.value;
    });
    const total = state.languagePriority.length;
    const up = iconButton(
      "↑",
      `Move language ${idx + 1} up`,
      () => moveLang(idx, idx - 1),
      { disabled: idx === 0 },
    );
    const down = iconButton(
      "↓",
      `Move language ${idx + 1} down`,
      () => moveLang(idx, idx + 1),
      { disabled: idx === total - 1 },
    );
    // Disambiguate the visible "Remove" buttons for screen readers
    // — they all share the same visible text but appear in a
    // repeated list, so a row-scoped aria-label is needed.
    const labelHint = lang.trim().length > 0 ? lang : `language ${idx + 1}`;
    const del = labelledButton(
      "Remove",
      `Remove ${labelHint}`,
      () => removeLang(idx),
      "danger",
    );
    row.append(input, up, down, del);
    list.appendChild(row);
  });
  // Inline error for THIS section, rendered next to the inputs per
  // SPEC §7.6 ("inline 錯誤緊鄰相關欄位"). Not folded into the
  // top-of-page banner so the user's eye is drawn to the section
  // they need to fix.
  if (state.languageError !== null) {
    list.appendChild(
      el("p", { class: "error", role: "alert" }, state.languageError),
    );
  }
  const addRow = el("div", { class: "header-row" });
  const addBtn = button("Add language", () => addLang());
  addRow.appendChild(addBtn);
  const saveBtn = button("Save languages", saveLanguages, "primary");
  addRow.appendChild(saveBtn);
  section.append(list, addRow);
  return section;
}

function addLang(): void {
  state.languagePriority.push("");
  render();
}
function removeLang(idx: number): void {
  state.languagePriority.splice(idx, 1);
  render();
}
function moveLang(from: number, to: number): void {
  if (to < 0 || to >= state.languagePriority.length) return;
  const [item] = state.languagePriority.splice(from, 1);
  state.languagePriority.splice(to, 0, item!);
  render();
}
async function saveLanguages(): Promise<void> {
  // SPEC §7.4: every entry must be a non-empty BCP-47 code AFTER
  // trimming, and the list must contain at least one entry. Blank /
  // whitespace-only entries block the save rather than getting
  // silently dropped — otherwise the user would think their entry
  // saved when it didn't. Errors live in `state.languageError` so
  // they render INSIDE the language section (SPEC §7.6) rather than
  // as a global banner.
  const trimmed = state.languagePriority.map((s) => s.trim());
  if (trimmed.length === 0) {
    state.languageError =
      "Add at least one language code before saving (e.g. en, zh-TW).";
    render();
    return;
  }
  const blankIndex = trimmed.findIndex((s) => s.length === 0);
  if (blankIndex !== -1) {
    state.languageError = `Language ${blankIndex + 1} is empty. Remove the blank entry or fill it in before saving.`;
    render();
    return;
  }
  const result = await setPreferences({ languagePriority: trimmed });
  if (!result.ok) {
    state.languageError = `Could not save language priority: ${result.error.type}: ${result.error.message}`;
    render();
    return;
  }
  state.languagePriority = trimmed;
  state.languageError = null;
  // A successful setPreferences clears any preferences-class banner
  // AND any "load" banner (storage path is provably working again).
  // Workflow-class banners survive.
  clearBannerIfResolvedBy(["preferences", "load"]);
  render();
}

// --- Workflow list section ----------------------------------------

function renderWorkflowsList(): HTMLElement {
  const section = el("section", { "aria-labelledby": "wf-h2" });
  section.appendChild(el("h2", { id: "wf-h2" }, "Workflows"));
  // Render against the latest INTENT (queued / in-flight), not the
  // committed state. Otherwise a re-render triggered while a reorder
  // write is in flight (e.g. the user starts typing in the language
  // field) would paint old order rows + new pending boundary
  // disable-states, which looks broken. By using the same source as
  // the boundary check, rows + disabled flags stay consistent
  // round-trip.
  const visible = latestPending() ?? state.workflows;
  if (visible.length === 0) {
    section.appendChild(
      el(
        "p",
        { class: "empty" },
        'No workflows yet. Click "New workflow" to add one.',
      ),
    );
  } else {
    const ul = el("ul", { class: "workflow-list" });
    const total = visible.length;
    // Pass idx + total directly into the row renderer so boundary
    // computation is O(1) per row instead of O(N) via findIndex.
    // Without this, rendering N rows is O(N²) on every render() —
    // wasteful even at small N when render() runs on every input
    // event.
    visible.forEach((w, idx) =>
      ul.appendChild(renderWorkflowRow(w, idx, total)),
    );
    section.appendChild(ul);
  }
  const actions = el("div", { class: "actions" });
  actions.appendChild(button("New workflow", startNew, "primary"));
  section.appendChild(actions);
  return section;
}

function renderWorkflowRow(w: Workflow, idx: number, total: number): HTMLElement {
  const li = el("li");
  const meta = el("div", { class: "meta" });
  const nameSpan = el("div", { class: "name" }, w.name);
  if (w.autoRun) {
    nameSpan.appendChild(el("span", { class: "muted" }, " (auto-run)"));
  }
  const urlDiv = el("div", { class: "url" }, w.url);
  meta.append(nameSpan, urlDiv);
  // Boundary state comes directly from idx + total. The caller passes
  // the same indices it iterated over, which already match the
  // pending list because renderWorkflowsList sources its iteration
  // from latestPending() ?? state.workflows.
  const isFirst = idx === 0;
  const isLast = idx === total - 1;
  const up = iconButton(
    "↑",
    `Move workflow "${w.name}" up`,
    () => moveWorkflow(w, "up"),
    { disabled: isFirst },
  );
  const down = iconButton(
    "↓",
    `Move workflow "${w.name}" down`,
    () => moveWorkflow(w, "down"),
    { disabled: isLast },
  );
  const edit = button("Edit", () => startEdit(w));
  const del = button("Delete", () => deleteWorkflow(w), "danger");
  li.append(meta, up, down, edit, del);
  return li;
}

// Reorder/delete derive `next` from `pendingNext ?? state.workflows`
// AND `(from, to)` is provided as workflow IDs rather than as
// indices, because the rendered list could be one click out of date
// with `pendingNext` after rapid clicks. Index-based mutations on a
// stale view of the list would shuffle the wrong rows. ID-based
// lookups always identify the right row in the latest pending list.
function moveWorkflow(workflow: Workflow, direction: "up" | "down"): void {
  const base = latestPending() ?? state.workflows;
  const idx = base.findIndex((w) => w.id === workflow.id);
  if (idx === -1) return;
  const to = direction === "up" ? idx - 1 : idx + 1;
  if (to < 0 || to >= base.length) return;
  const next = [...base];
  const [item] = next.splice(idx, 1);
  next.splice(to, 0, item!);
  void enqueuePersist(next);
}

function deleteWorkflow(w: Workflow): void {
  const confirmed = confirm(`Delete workflow "${w.name}"?`);
  if (!confirmed) return;
  const base = latestPending() ?? state.workflows;
  const next = base.filter((x) => x.id !== w.id);
  void enqueuePersist(next);
}

// Serialise persistence calls. Rapid reorder clicks (or any
// concurrent caller) would otherwise let two setWorkflows() promises
// resolve out of order, committing an older `next` after a newer
// one. The queue tracks only the LATEST pending array, so older
// queued writes are coalesced — we don't need to ship every
// intermediate ordering to storage, only the final one the user
// stopped on.
//
// We expose `pendingNext` to the mutation helpers via
// `latestPending()` so they can base their next mutation on the most
// recent INTENT (queued OR in-flight), not on the now-stale
// state.workflows. Without that, a click landing while a write was
// in flight would compute its mutation from old data.
let persistQueue: Promise<void> = Promise.resolve();
let queuedNext: Workflow[] | null = null;
let inFlightNext: Workflow[] | null = null;

function latestPending(): Workflow[] | null {
  return queuedNext ?? inFlightNext;
}

function enqueuePersist(next: Workflow[]): Promise<void> {
  queuedNext = next;
  persistQueue = persistQueue.then(async () => {
    if (queuedNext === null) return;
    const toWrite = queuedNext;
    queuedNext = null;
    inFlightNext = toWrite;
    try {
      await persistAndCommit(toWrite);
    } finally {
      inFlightNext = null;
    }
  });
  return persistQueue;
}

// SPEC §6.6 / §7.4: a failed write must NOT leave the in-memory
// state ahead of persisted state, otherwise the UI lies about what
// the user has saved. Compute the proposed next array, write it,
// and only commit `state.workflows` after success.
async function persistAndCommit(next: Workflow[]): Promise<void> {
  const result = await setWorkflows(next);
  if (!result.ok) {
    state.banner = {
      source: "workflows",
      message: `Could not save workflows: ${result.error.type}: ${result.error.message}`,
    };
    // On a failed write, drop this attempt from `inFlightNext` so
    // the renderer doesn't keep painting the unsaved-pending order
    // as if it were the latest intent. Without this, the workflow
    // list would show the would-be reorder forever even though the
    // write failed and state.workflows wasn't committed. (The
    // enqueuePersist finally also clears inFlightNext, but it does
    // so AFTER this function returns; the render() below would
    // catch the stale value if we didn't clear here first.)
    inFlightNext = null;
    render();
    return;
  }
  state.workflows = next;
  clearBannerIfResolvedBy(["workflows", "load"]);
  render();
}

// --- Edit form ----------------------------------------------------

function startNew(): void {
  state.edit = {
    mode: "edit",
    draft: {
      id: crypto.randomUUID(),
      name: "",
      url: "",
      promptTemplate: "",
      autoRun: false,
      headers: {},
    },
    headerRows: [],
    isNew: true,
  };
  state.validationErrors = [];
  render();
}
function startEdit(w: Workflow): void {
  state.edit = {
    mode: "edit",
    draft: { ...w, headers: { ...w.headers } },
    // Coerce header values to strings defensively. The Workflow type
    // says `Record<string, string>` but loading malformed stored
    // data can violate that; converting here means the user sees
    // SOMETHING they can edit rather than having `[object Object]`
    // round-tripped back to storage.
    headerRows: Object.entries(w.headers).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value: typeof value === "string" ? value : String(value),
    })),
    isNew: false,
  };
  state.validationErrors = [];
  render();
}
function cancelEdit(): void {
  state.edit = { mode: "list" };
  state.validationErrors = [];
  render();
}

function renderEditForm(
  draft: Workflow,
  headerRows: HeaderRow[],
  isNew: boolean,
): HTMLElement {
  const section = el("section", { "aria-labelledby": "edit-h2" });
  section.appendChild(
    el("h2", { id: "edit-h2" }, isNew ? "New workflow" : "Edit workflow"),
  );

  section.appendChild(
    field("Name", "name", "wf-name", textInput(draft.name, (v) => (draft.name = v))),
  );
  section.appendChild(
    field("URL", "url", "wf-url", textInput(draft.url, (v) => (draft.url = v), "url")),
  );
  section.appendChild(
    field(
      "Prompt template",
      "promptTemplate",
      "wf-prompt",
      textarea(draft.promptTemplate, (v) => (draft.promptTemplate = v)),
      "Use {{transcript}}, {{title}}, {{video_id}}, {{video_url}}, {{language}}, {{duration_seconds}}, {{transcript_with_timestamps}}.",
    ),
  );

  // autoRun — a labelled checkbox is the standard pattern for a
  // boolean toggle.
  const autoRow = el("div", { class: "field" });
  const checkbox = el("input", {
    type: "checkbox",
    id: "wf-auto",
  }) as HTMLInputElement;
  checkbox.checked = draft.autoRun;
  checkbox.addEventListener("change", () => {
    draft.autoRun = checkbox.checked;
  });
  const autoLabel = el("label", { for: "wf-auto" });
  autoLabel.append(
    checkbox,
    document.createTextNode(" Auto-run on every video"),
  );
  autoRow.appendChild(autoLabel);
  section.appendChild(autoRow);

  section.appendChild(renderHeadersField(headerRows));

  const actions = el("div", { class: "actions" });
  actions.appendChild(
    button(
      "Save",
      () => {
        draft.headers = collapseHeaders(headerRows);
        void saveWorkflow(draft, isNew);
      },
      "primary",
    ),
  );
  actions.appendChild(button("Cancel", cancelEdit));
  section.appendChild(actions);

  return section;
}

function collapseHeaders(rows: HeaderRow[]): Record<string, string> {
  // Skip blank-name rows entirely (the user is still typing); last
  // write wins for duplicates, which is the only sensible thing we
  // can do once the user has committed to ambiguous data. Use
  // Object.create(null) so a user-entered key like "__proto__"
  // becomes a regular property assignment instead of mutating
  // Object.prototype.
  const out = Object.create(null) as Record<string, string>;
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    out[key] = row.value;
  }
  return out;
}

function renderHeadersField(rows: HeaderRow[]): HTMLElement {
  // Headers is a multi-row group, not a single input — there's no
  // sensible target for a <label for=…>. Use the group-labelling
  // pattern instead: a styled <span> heading gets an id and the
  // wrapper becomes role="group" + aria-labelledby. The HTML <label>
  // element is reserved for actual form-control association, so
  // using it as a group title would be invalid markup.
  const wrap = el("div", {
    class: "field",
    role: "group",
    "aria-labelledby": "headers-label",
  });
  // role+aria-level expose the heading semantics to assistive tech
  // without forcing visual sizing (CSS targets `.field > .group-title`).
  const heading = el(
    "span",
    {
      id: "headers-label",
      class: "group-title",
      role: "heading",
      "aria-level": "3",
    },
    "Headers",
  );
  wrap.appendChild(heading);
  wrap.appendChild(
    el(
      "p",
      { class: "muted" },
      "Do not include Content-Type — Subflow always sets it to application/json.",
    ),
  );
  const list = el("div", { class: "headers-list" });
  rows.forEach((row, idx) => list.appendChild(renderHeaderRow(rows, row, idx)));
  const addBtn = button("Add header", () => {
    rows.push({ id: crypto.randomUUID(), key: "", value: "" });
    render();
  });
  list.appendChild(addBtn);
  wrap.appendChild(list);
  const headerErr = errorFor("headers");
  if (headerErr !== null) wrap.appendChild(headerErr);
  return wrap;
}

function renderHeaderRow(
  rows: HeaderRow[],
  row: HeaderRow,
  idx: number,
): HTMLElement {
  const wrapper = el("div", { class: "header-row" });
  const keyInput = el("input", {
    type: "text",
    value: row.key,
    "aria-label": `Header ${idx + 1} name`,
    placeholder: "Header name",
  }) as HTMLInputElement;
  const valueInput = el("input", {
    type: "text",
    value: row.value,
    "aria-label": `Header ${idx + 1} value`,
    placeholder: "Header value",
  }) as HTMLInputElement;
  const labelHint =
    row.key.trim().length > 0 ? `header "${row.key}"` : `header ${idx + 1}`;
  const del = labelledButton(
    "Remove",
    `Remove ${labelHint}`,
    () => {
      const i = rows.findIndex((r) => r.id === row.id);
      if (i !== -1) rows.splice(i, 1);
      render();
    },
    "danger",
  );
  // Both inputs write to the SAME HeaderRow via id (not key), so
  // typing the name doesn't race with value updates and no stray
  // half-typed entries appear in the collapsed headers Record.
  keyInput.addEventListener("input", () => {
    row.key = keyInput.value;
  });
  valueInput.addEventListener("input", () => {
    row.value = valueInput.value;
  });
  wrapper.append(keyInput, valueInput, del);
  return wrapper;
}

async function saveWorkflow(draft: Workflow, isNew: boolean): Promise<void> {
  // Sanitize trim-able fields BEFORE validating so the persisted
  // value is the user's intended URL / name / template, without
  // accidental whitespace that the validator already tolerates.
  draft.url = draft.url.trim();
  draft.name = draft.name.trim();
  draft.promptTemplate = draft.promptTemplate.trim();
  state.validationErrors = validateWorkflow(draft);
  if (state.validationErrors.length > 0) {
    render();
    return;
  }
  const baseWorkflows = latestPending() ?? state.workflows;
  const next = isNew
    ? [...baseWorkflows, draft]
    : baseWorkflows.map((w) => (w.id === draft.id ? draft : w));
  // Route through the persist queue so saveWorkflow can't race a
  // reorder/delete still in flight. enqueuePersist's commit path
  // handles state.workflows assignment + the banner clear.
  await enqueuePersist(next);
  // Exit edit mode regardless of write outcome — if the write
  // failed, the banner already reflects that and the user can
  // re-enter edit mode from the list to retry.
  state.edit = { mode: "list" };
  state.validationErrors = [];
  render();
}

// --- Helpers -------------------------------------------------------

function field(
  label: string,
  validationField: WorkflowValidationError["field"],
  inputId: string,
  input: HTMLElement,
  hint?: string,
): HTMLElement {
  const wrap = el("div", { class: "field" });
  input.id = inputId;
  // Associate the visible <label> with the input so screen readers
  // announce the label when the input takes focus.
  wrap.appendChild(el("label", { for: inputId }, label));
  const hintId = `${inputId}-hint`;
  if (hint !== undefined) {
    const hintEl = el("p", { class: "muted", id: hintId }, hint);
    wrap.appendChild(hintEl);
    input.setAttribute("aria-describedby", hintId);
  }
  wrap.appendChild(input);
  const err = errorFor(validationField);
  if (err !== null) {
    const errId = `${inputId}-err`;
    err.id = errId;
    input.setAttribute("aria-invalid", "true");
    // Append aria-describedby so the error AND the hint are both
    // announced. Order: existing describedby (hint) first, then the
    // error, so the error is the last thing heard.
    const prior = input.getAttribute("aria-describedby");
    input.setAttribute(
      "aria-describedby",
      prior === null ? errId : `${prior} ${errId}`,
    );
    wrap.appendChild(err);
  }
  return wrap;
}

function errorFor(
  field: WorkflowValidationError["field"],
): HTMLElement | null {
  // validateWorkflow can emit multiple errors against the same field
  // (e.g. headers can have both a Content-Type collision AND a
  // non-string value). Render all of them so the user can fix the
  // form in one pass instead of finding hidden problems after each
  // save attempt.
  const matching = state.validationErrors.filter((e) => e.field === field);
  if (matching.length === 0) return null;
  if (matching.length === 1) {
    return el("p", { class: "error", role: "alert" }, matching[0]!.message);
  }
  const wrap = el("div", { class: "error", role: "alert" });
  const list = el("ul");
  for (const err of matching) {
    list.appendChild(el("li", {}, err.message));
  }
  wrap.appendChild(list);
  return wrap;
}

function textInput(
  value: string,
  onChange: (v: string) => void,
  type: "text" | "url" = "text",
): HTMLElement {
  const input = el("input", { type, value }) as HTMLInputElement;
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function textarea(value: string, onChange: (v: string) => void): HTMLElement {
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.value = value;
  ta.addEventListener("input", () => onChange(ta.value));
  return ta;
}

function button(
  label: string,
  onClick: () => void | Promise<void>,
  variant?: "primary" | "danger",
): HTMLElement {
  const b = el("button", { type: "button" });
  if (variant !== undefined) b.classList.add(variant);
  b.textContent = label;
  b.addEventListener("click", () => {
    void onClick();
  });
  return b;
}

// Icon-only button (e.g. up/down arrows). The visible glyph is
// ambiguous on its own, so screen readers get a real description
// via aria-label. The `disabled` option drops the button into the
// native disabled state, which:
//   - communicates unavailability via the native ARIA mapping
//   - blocks pointer / keyboard / screen-reader activation
// at one stroke, so we don't need to also set aria-disabled.
function iconButton(
  glyph: string,
  ariaLabel: string,
  onClick: () => void | Promise<void>,
  options: { disabled?: boolean } = {},
): HTMLElement {
  const b = el("button", { type: "button", "aria-label": ariaLabel });
  b.textContent = glyph;
  if (options.disabled === true) {
    (b as HTMLButtonElement).disabled = true;
  }
  b.addEventListener("click", () => {
    void onClick();
  });
  return b;
}

// Text-labelled button with an explicit aria-label override — used
// when the same visible text ("Remove") appears in a repeated list
// so each instance gets a row-scoped accessible name.
function labelledButton(
  label: string,
  ariaLabel: string,
  onClick: () => void | Promise<void>,
  variant?: "primary" | "danger",
): HTMLElement {
  const b = el("button", { type: "button", "aria-label": ariaLabel });
  if (variant !== undefined) b.classList.add(variant);
  b.textContent = label;
  b.addEventListener("click", () => {
    void onClick();
  });
  return b;
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}
