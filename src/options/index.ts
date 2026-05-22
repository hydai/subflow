// Subflow options page (SPEC §6.8 / §7.4 / §7.6).
//
// Pure DOM rendering — no framework — keyed off two pieces of state:
// the `Workflow[]` array and the `string[]` language priority. Every
// mutation routes through `setWorkflows` / `setLanguagePriority` and
// the page re-renders from the post-mutation state, so the UI is
// always a reflection of `chrome.storage.local` (modulo the in-flight
// edit form's local state).
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

type EditState =
  | { mode: "list" }
  | { mode: "edit"; draft: Workflow; isNew: boolean };

interface AppState {
  workflows: Workflow[];
  languagePriority: string[];
  edit: EditState;
  validationErrors: WorkflowValidationError[];
  saveError: string | null;
}

const state: AppState = {
  workflows: [],
  languagePriority: [],
  edit: { mode: "list" },
  validationErrors: [],
  saveError: null,
};

void bootstrap();

async function bootstrap(): Promise<void> {
  const [wfs, prefs] = await Promise.all([getWorkflows(), getPreferences()]);
  state.workflows = wfs.ok ? wfs.value : [];
  state.languagePriority = prefs.ok ? prefs.value.languagePriority : [];
  if (!wfs.ok || !prefs.ok) {
    state.saveError =
      "Could not load saved settings. Showing defaults until a successful write happens.";
  }
  render();
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
      ? renderEditForm(state.edit.draft, state.edit.isNew)
      : renderWorkflowsList();
  const globalErr =
    state.saveError !== null
      ? [el("p", { class: "error global", role: "alert" }, state.saveError)]
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
    const up = button("↑", () => moveLang(idx, idx - 1));
    const down = button("↓", () => moveLang(idx, idx + 1));
    const del = button("Remove", () => removeLang(idx), "danger");
    row.append(input, up, down, del);
    list.appendChild(row);
  });
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
  const sanitized = state.languagePriority
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result = await setPreferences({ languagePriority: sanitized });
  if (!result.ok) {
    state.saveError = `Could not save language priority: ${result.error.type}: ${result.error.message}`;
    render();
    return;
  }
  state.languagePriority = sanitized;
  state.saveError = null;
  render();
}

// --- Workflow list section ----------------------------------------

function renderWorkflowsList(): HTMLElement {
  const section = el("section", { "aria-labelledby": "wf-h2" });
  section.appendChild(el("h2", { id: "wf-h2" }, "Workflows"));
  if (state.workflows.length === 0) {
    section.appendChild(
      el(
        "p",
        { class: "empty" },
        'No workflows yet. Click "New workflow" to add one.',
      ),
    );
  } else {
    const ul = el("ul", { class: "workflow-list" });
    state.workflows.forEach((w, idx) =>
      ul.appendChild(renderWorkflowRow(w, idx)),
    );
    section.appendChild(ul);
  }
  const actions = el("div", { class: "actions" });
  actions.appendChild(button("New workflow", startNew, "primary"));
  section.appendChild(actions);
  return section;
}

function renderWorkflowRow(w: Workflow, idx: number): HTMLElement {
  const li = el("li");
  const meta = el("div", { class: "meta" });
  const nameSpan = el("div", { class: "name" }, w.name);
  if (w.autoRun) {
    nameSpan.appendChild(el("span", { class: "muted" }, " (auto-run)"));
  }
  const urlDiv = el("div", { class: "url" }, w.url);
  meta.append(nameSpan, urlDiv);
  const up = button("↑", () => moveWorkflow(idx, idx - 1));
  const down = button("↓", () => moveWorkflow(idx, idx + 1));
  const edit = button("Edit", () => startEdit(w));
  const del = button("Delete", () => deleteWorkflow(w), "danger");
  li.append(meta, up, down, edit, del);
  return li;
}

function moveWorkflow(from: number, to: number): void {
  if (to < 0 || to >= state.workflows.length) return;
  const [item] = state.workflows.splice(from, 1);
  state.workflows.splice(to, 0, item!);
  void persistWorkflows();
}

function deleteWorkflow(w: Workflow): void {
  const confirmed = confirm(`Delete workflow "${w.name}"?`);
  if (!confirmed) return;
  state.workflows = state.workflows.filter((x) => x.id !== w.id);
  void persistWorkflows();
}

async function persistWorkflows(): Promise<void> {
  const result = await setWorkflows(state.workflows);
  if (!result.ok) {
    state.saveError = `Could not save workflows: ${result.error.type}: ${result.error.message}`;
  } else {
    state.saveError = null;
  }
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
    isNew: true,
  };
  state.validationErrors = [];
  render();
}
function startEdit(w: Workflow): void {
  state.edit = {
    mode: "edit",
    draft: { ...w, headers: { ...w.headers } },
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

function renderEditForm(draft: Workflow, isNew: boolean): HTMLElement {
  const section = el("section", { "aria-labelledby": "edit-h2" });
  section.appendChild(
    el("h2", { id: "edit-h2" }, isNew ? "New workflow" : "Edit workflow"),
  );

  section.appendChild(
    field("Name", "name", textInput(draft.name, (v) => (draft.name = v))),
  );
  section.appendChild(
    field("URL", "url", textInput(draft.url, (v) => (draft.url = v), "url")),
  );
  section.appendChild(
    field(
      "Prompt template",
      "promptTemplate",
      textarea(draft.promptTemplate, (v) => (draft.promptTemplate = v)),
      "Use {{transcript}}, {{title}}, {{video_id}}, {{video_url}}, {{language}}, {{duration_seconds}}, {{transcript_with_timestamps}}.",
    ),
  );

  // autoRun
  const autoRow = el("div", { class: "field" });
  const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  checkbox.checked = draft.autoRun;
  checkbox.addEventListener("change", () => {
    draft.autoRun = checkbox.checked;
  });
  const autoLabel = el("label");
  autoLabel.append(checkbox, document.createTextNode(" Auto-run on every video"));
  autoRow.appendChild(autoLabel);
  section.appendChild(autoRow);

  // Headers
  section.appendChild(renderHeadersField(draft));

  const actions = el("div", { class: "actions" });
  actions.appendChild(
    button("Save", () => saveWorkflow(draft, isNew), "primary"),
  );
  actions.appendChild(button("Cancel", cancelEdit));
  section.appendChild(actions);

  return section;
}

function renderHeadersField(draft: Workflow): HTMLElement {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(el("label", {}, "Headers"));
  wrap.appendChild(
    el(
      "p",
      { class: "muted" },
      "Do not include Content-Type — Subflow always sets it to application/json.",
    ),
  );
  const list = el("div", { class: "headers-list" });
  const entries = Object.entries(draft.headers);
  entries.forEach(([key, value], idx) => {
    list.appendChild(renderHeaderRow(draft, idx, key, value));
  });
  const addBtn = button("Add header", () => {
    const newKey = newHeaderKey(draft.headers);
    draft.headers[newKey] = "";
    render();
  });
  list.appendChild(addBtn);
  wrap.appendChild(list);
  const headerErr = errorFor("headers");
  if (headerErr !== null) wrap.appendChild(headerErr);
  return wrap;
}

function newHeaderKey(headers: Record<string, string>): string {
  let n = 1;
  let key = `Header-${n}`;
  while (key in headers) {
    n += 1;
    key = `Header-${n}`;
  }
  return key;
}

function renderHeaderRow(
  draft: Workflow,
  idx: number,
  key: string,
  value: string,
): HTMLElement {
  const row = el("div", { class: "header-row" });
  const keyInput = el("input", {
    type: "text",
    value: key,
    "aria-label": `Header ${idx + 1} name`,
    placeholder: "Header name",
  }) as HTMLInputElement;
  const valueInput = el("input", {
    type: "text",
    value,
    "aria-label": `Header ${idx + 1} value`,
    placeholder: "Header value",
  }) as HTMLInputElement;
  const del = button(
    "Remove",
    () => {
      delete draft.headers[key];
      render();
    },
    "danger",
  );
  keyInput.addEventListener("change", () => {
    const oldVal = draft.headers[key];
    delete draft.headers[key];
    draft.headers[keyInput.value] = oldVal ?? valueInput.value;
    render();
  });
  valueInput.addEventListener("input", () => {
    draft.headers[keyInput.value] = valueInput.value;
  });
  row.append(keyInput, valueInput, del);
  return row;
}

function saveWorkflow(draft: Workflow, isNew: boolean): void {
  state.validationErrors = validateWorkflow(draft);
  if (state.validationErrors.length > 0) {
    render();
    return;
  }
  if (isNew) {
    state.workflows = [...state.workflows, draft];
  } else {
    state.workflows = state.workflows.map((w) => (w.id === draft.id ? draft : w));
  }
  state.edit = { mode: "list" };
  state.validationErrors = [];
  void persistWorkflows();
}

// --- Helpers -------------------------------------------------------

function field(
  label: string,
  id: string,
  input: HTMLElement,
  hint?: string,
): HTMLElement {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(el("label", {}, label));
  if (hint !== undefined) wrap.appendChild(el("p", { class: "muted" }, hint));
  wrap.appendChild(input);
  const err = errorFor(id as WorkflowValidationError["field"]);
  if (err !== null) {
    input.setAttribute("aria-invalid", "true");
    wrap.appendChild(err);
  }
  return wrap;
}

function errorFor(
  field: WorkflowValidationError["field"],
): HTMLElement | null {
  const err = state.validationErrors.find((e) => e.field === field);
  if (err === undefined) return null;
  return el("p", { class: "error", role: "alert" }, err.message);
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
