import { api, ApiError } from '../../api';
import type { App } from '../../app';
import { h } from '../../lib/dom';
import { inManuscript } from '../../lib/roles';
import { store } from '../../lib/storage';
import { formatCount } from '../../lib/text';
import type { DocFull } from '../../types';
import { hidePane, paneOwner, showPane } from './sidepane';
import { beatsEditor } from './beats';

/**
 * Details of the document being written: status (as shapes), synopsis,
 * point of view, in-story date, word target and role. Hidden until asked
 * for; every field is optional and nothing here ever blocks writing.
 */
const OWNER = 'inspector';
/** Same rule as the server (library.STORY_DATE). */
export const STORY_DATE = /^-?\d{1,6}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d)?$/;
let wanted = store.get('cadence.inspector') === '1';
let shownFor: number | null = null;

export function inspectorOpen(): boolean {
  return paneOwner() === OWNER;
}

export async function toggleInspector(app: App, on = !inspectorOpen()): Promise<void> {
  wanted = on;
  store.set('cadence.inspector', on ? '1' : '0');
  if (on) await renderInspector(app, true);
  else close(app);
}

function close(app: App): void {
  shownFor = null;
  hidePane(app, OWNER);
  app.renderTools();
}

/** Save metadata for a document, keeping every open editor of it in step. */
export async function saveDetails(app: App, id: number, changes: Record<string, unknown>): Promise<DocFull> {
  await app.flushDoc(id);
  const doc = await api.updateDocument(id, changes);
  app.rebaseDoc(id, doc.updated_at);
  app.sidebar.patchDoc(doc);
  app.view?.updateSummary(doc);
  if (app.doc?.id === id) app.doc = { ...app.doc, ...doc };
  const i = app.tree.documents.findIndex((d) => d.id === id);
  if (i >= 0) app.tree.documents[i] = { ...app.tree.documents[i]!, ...doc };
  return doc;
}

export async function renderInspector(app: App, force = false): Promise<void> {
  if (!wanted || !app.kind?.tools.inspector) return;
  const id = app.activeDocId();
  if (!force && id === shownFor && inspectorOpen()) return;
  shownFor = id;
  const kind = app.kind;
  const root = h('aside', { class: 'inspector', 'aria-label': 'Details' });
  const head = h('div', { class: 'pane-top' },
    h('strong', null, 'Details'), h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'icon', 'aria-label': 'Close details', title: 'Close', onclick: () => void toggleInspector(app, false) }, '×'));
  root.appendChild(head);
  await showPane(app, { id: OWNER, close: () => { shownFor = null; } }, root);
  app.renderTools();
  if (id === null) {
    root.appendChild(h('p', { class: 'quiet-text' }, `Open a ${kind.item_label.toLowerCase()} to see its details.`));
    return;
  }
  let doc: DocFull;
  try {
    doc = await api.getDocument(id);
  } catch {
    return;
  }
  if (shownFor !== id) return;
  const meta = doc.meta as Record<string, unknown>;
  const message = h('p', { class: 'lock-status', role: 'status' });
  const save = async (changes: Record<string, unknown>) => {
    message.textContent = '';
    try {
      const saved = await saveDetails(app, id, changes);
      Object.assign(meta, saved.meta);
      if ('role' in changes) {
        // The flow changes: rebuild the folder view around the same document.
        await app.refreshTree();
        if (app.view) await app.openFolder(app.view.folder.id, { push: false, focusDoc: id });
      }
      if ('meta' in changes && 'word_target' in (changes.meta as object)) app.refreshWords();
    } catch (err) {
      message.textContent = err instanceof ApiError ? err.message : 'Not saved';
    }
  };
  const text = (label: string, key: string, opts: { placeholder?: string; max?: number; hint?: string; check?: (v: string) => string | null } = {}) => {
    const input = h('input', { type: 'text', autocomplete: 'off', maxlength: String(opts.max ?? 300), placeholder: opts.placeholder ?? '' }) as HTMLInputElement;
    input.value = String(meta[key] ?? '');
    input.addEventListener('change', () => {
      const problem = opts.check?.(input.value.trim()) ?? null;
      if (problem) {
        message.textContent = problem;
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      input.removeAttribute('aria-invalid');
      void save({ meta: { [key]: input.value.trim() } });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('label', { class: 'field', dataset: { field: key } }, h('span', null, label), input, opts.hint ? h('small', { class: 'quiet-text' }, opts.hint) : null);
  };

  const manuscript = inManuscript(kind, doc);
  root.appendChild(h('p', { class: 'inspector-title' }, doc.title || 'Untitled'));

  if (kind.tools.status && kind.statuses.length) {
    const group = h('fieldset', { class: 'status-field' }, h('legend', null, 'Status'));
    const choices = ['', ...kind.statuses];
    for (const s of choices) {
      const input = h('input', { type: 'radio', name: `status-${id}`, value: s, checked: (doc.status ?? '') === s }) as HTMLInputElement;
      input.addEventListener('change', () => void save({ status: s || null }));
      group.appendChild(h('label', { class: 'status-choice' }, input,
        h('span', { class: 'status-symbol', 'aria-hidden': 'true' }, s ? kind.status_symbols[s] ?? '' : '–'),
        ` ${s || 'none'}`));
    }
    root.appendChild(group);
  }
  if (kind.meta_fields.includes('synopsis')) root.appendChild(text('Synopsis (one line)', 'synopsis', { max: 300 }));
  if (kind.meta_fields.includes('pov')) root.appendChild(text('Point of view', 'pov', { max: 100 }));
  if (kind.meta_fields.includes('story_date')) {
    root.appendChild(text('In-story date', 'story_date', {
      placeholder: '1888-03-14', max: 20, hint: 'Year-month-day; add T21:30 for a time.',
      check: (v) => (!v || STORY_DATE.test(v) ? null : 'The story date must look like 1888-03-14 (a time may follow as T21:30).'),
    }));
  }
  if (kind.tools.word_target && manuscript) {
    const input = h('input', { type: 'number', min: '1', step: '100', inputmode: 'numeric' }) as HTMLInputElement;
    input.value = doc.word_target ? String(doc.word_target) : '';
    input.addEventListener('change', () => {
      const n = input.value.trim() === '' ? null : Math.round(Number(input.value));
      if (n !== null && (!Number.isFinite(n) || n <= 0)) return;
      void save({ meta: { word_target: n } });
    });
    const words = doc.words ?? 0;
    root.appendChild(h('label', { class: 'field', dataset: { field: 'word_target' } }, h('span', null, 'Word target'), input,
      doc.word_target ? h('small', { class: 'quiet-text' }, `${formatCount(words)} of ${formatCount(doc.word_target)}`) : null));
  }
  if (kind.roles.length > 1) {
    const select = h('select', { 'aria-label': 'Role' },
      kind.roles.map((r) => h('option', { value: r.id, selected: r.id === (doc.role ?? kind.default_role) }, r.label))) as HTMLSelectElement;
    select.addEventListener('change', () => void save({ role: select.value }));
    root.appendChild(h('label', { class: 'field', dataset: { field: 'role' } }, h('span', null, 'Role'), select,
      h('small', { class: 'quiet-text' }, 'Misc notes stay out of the manuscript, its word count and compile.')));
  }
  if (kind.meta_fields.includes('beats')) {
    root.appendChild(beatsEditor((meta.beats as { text: string; done: boolean }[] | undefined) ?? [], (beats) => save({ meta: { beats } })));
  }
  root.appendChild(message);
}

/** Leaving for a kind without details closes the pane. */
export function closeInspectorFor(app: App): void {
  if (inspectorOpen()) close(app);
}
