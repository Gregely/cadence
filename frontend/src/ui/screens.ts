import { api } from '../api';
import { dateTimeLabel } from '../lib/dates';
import { clear, h } from '../lib/dom';
import type { DocSummary, Folder, InboxItem, KindDef } from '../types';
import { ask, confirmAction, toast } from './dialogs';

export interface ScreenHost {
  kinds: KindDef[];
  currentKind: KindDef;
  back(): void;
  openDocument(id: number): unknown;
  pickDocument(kind: KindDef, title: string): Promise<DocSummary | null>;
  refreshTree(): Promise<void>;
}

function kindLabel(kinds: KindDef[], id: string | null): string {
  if (!id) return 'No kind';
  return kinds.find((k) => k.id === id)?.label ?? id;
}

/** Inbox review: deliberate, separate from writing. */
export function inboxScreen(host: ScreenHost): HTMLElement {
  const list = h('div', { class: 'screen-list' });
  let showHandled = false;
  const toggle = h('label', { class: 'check' },
    h('input', { type: 'checkbox', onchange: (e: Event) => { showHandled = (e.target as HTMLInputElement).checked; void load(); } }),
    ' Show handled');

  const targetKinds = host.kinds.filter((k) => !k.encrypted);

  const row = (item: InboxItem): HTMLElement => {
    const kind = host.kinds.find((k) => k.id === item.from_kind) ?? host.currentKind;
    const defaultKind = kind.encrypted ? targetKinds[0]! : kind;
    const text = h('p', { class: 'inbox-text' }, item.text);
    const kindSelect = h('select', { 'aria-label': 'Kind for new document' },
      targetKinds.map((k) => h('option', { value: k.id, selected: k.id === defaultKind.id }, k.label))) as HTMLSelectElement;
    const chosen = () => host.kinds.find((k) => k.id === kindSelect.value)!;
    const actions = h('div', { class: 'row-actions' },
      kindSelect,
      h('button', { type: 'button', onclick: async () => {
        const doc = await api.inboxToDocument(item.id, { kind: chosen().id });
        toast(`New ${chosen().item_label.toLowerCase()} created`);
        await host.refreshTree();
        host.openDocument(doc.id);
      } }, 'New document'),
      h('button', { type: 'button', onclick: async () => {
        const target = await host.pickDocument(chosen(), `Append to which ${chosen().item_label.toLowerCase()}?`);
        if (!target) return;
        await api.inboxToDocument(item.id, { kind: chosen().id, document_id: target.id });
        toast(`Added to “${target.title || 'Untitled'}”`);
        void load();
      } }, 'Append to…'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        const value = await ask({ title: 'Edit captured text', value: item.text, multiline: true, ok: 'Save' });
        if (value === null || !value.trim()) return;
        await api.updateInbox(item.id, { text: value });
        void load();
      } }, 'Edit'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        await api.updateInbox(item.id, { handled: !item.handled_at });
        void load();
      } }, item.handled_at ? 'Not done' : 'Done'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        if (!(await confirmAction('Delete this captured line?', 'Delete'))) return;
        await api.deleteInbox(item.id);
        void load();
      } }, 'Delete'),
    );
    return h('article', { class: `screen-item${item.handled_at ? ' handled' : ''}` },
      h('div', { class: 'item-meta' }, `${kindLabel(host.kinds, item.from_kind)} · ${dateTimeLabel(item.created_at)}`),
      text, actions);
  };

  const load = async () => {
    const items = await api.inbox(showHandled);
    clear(list);
    if (!items.length) list.appendChild(h('p', { class: 'quiet-text' }, 'Nothing here.'));
    for (const item of items) list.appendChild(row(item));
  };
  void load();
  return h('section', { class: 'screen', 'aria-label': 'Inbox' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'quiet', onclick: () => host.back() }, '‹ Back to writing'),
      h('h1', null, 'Inbox'), toggle),
    list);
}

/** Trash: restore or delete for good. Purged automatically after 30 days. */
export function trashScreen(host: ScreenHost): HTMLElement {
  const list = h('div', { class: 'screen-list' });
  let allKinds = false;
  const toggle = h('label', { class: 'check' },
    h('input', { type: 'checkbox', onchange: (e: Event) => { allKinds = (e.target as HTMLInputElement).checked; void load(); } }),
    ' All kinds');
  const note = h('p', { class: 'quiet-text' });

  const folderRow = (f: Folder) => h('article', { class: 'screen-item' },
    h('div', { class: 'item-meta' }, `${kindLabel(host.kinds, f.kind)} · ${host.kinds.find((k) => k.id === f.kind)?.folder_label ?? 'Folder'} · deleted ${dateTimeLabel(f.deleted_at!)}`),
    h('p', { class: 'inbox-text' }, `${f.name}`,
      f.contains ? h('span', { class: 'quiet-text' }, ` — ${f.contains.documents} document${f.contains.documents === 1 ? '' : 's'}${f.contains.folders ? `, ${f.contains.folders} folder${f.contains.folders === 1 ? '' : 's'}` : ''}`) : null),
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', onclick: async () => { await api.restoreFolder(f.id); toast('Restored'); await host.refreshTree(); void load(); } }, 'Restore'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        if (!(await confirmAction(`Delete “${f.name}” and everything in it for good?`, 'Delete for good', 'This cannot be undone.'))) return;
        await api.purgeFolder(f.id); void load();
      } }, 'Delete for good')));

  const docRow = (d: DocSummary) => h('article', { class: 'screen-item' },
    h('div', { class: 'item-meta' }, `${kindLabel(host.kinds, d.kind)} · deleted ${dateTimeLabel(d.deleted_at!)}`),
    h('p', { class: 'inbox-text' }, d.title || d.excerpt || 'Untitled'),
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', onclick: async () => { await api.restoreDocument(d.id); toast('Restored'); await host.refreshTree(); void load(); } }, 'Restore'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        if (!(await confirmAction('Delete this for good?', 'Delete for good', 'This cannot be undone.'))) return;
        await api.purgeDocument(d.id); void load();
      } }, 'Delete for good')));

  const load = async () => {
    const t = await api.trash(allKinds ? undefined : host.currentKind.id);
    note.textContent = `Items in the trash are deleted for good after ${t.purge_after_days} days.`;
    clear(list);
    if (!t.folders.length && !t.documents.length) list.appendChild(h('p', { class: 'quiet-text' }, 'The trash is empty.'));
    for (const f of t.folders) list.appendChild(folderRow(f));
    for (const d of t.documents) list.appendChild(docRow(d));
  };
  void load();
  return h('section', { class: 'screen', 'aria-label': 'Trash' },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'quiet', onclick: () => host.back() }, '‹ Back to writing'),
      h('h1', null, `Trash`), toggle),
    note, list);
}
