import { diffWordsWithSpace } from 'diff';

import { api } from '../api';
import type { App, Feature } from '../app';
import { dateTimeLabel } from '../lib/dates';
import { clear, h } from '../lib/dom';
import { docText } from '../lib/text';
import type { Snapshot } from '../types';
import { ask, confirmAction, panel, toast } from '../ui/dialogs';

/** Named versions: one click to take, compare against the current text, restore. */
async function takeSnapshot(app: App, named: boolean): Promise<void> {
  if (!app.doc) {
    toast('Write something first.');
    return;
  }
  const now = new Date();
  let label = `Snapshot ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${now.toTimeString().slice(0, 5)}`;
  if (named) {
    const value = await ask({ title: 'Snapshot name', value: label, ok: 'Take snapshot' });
    if (value === null) return;
    label = value.trim() || label;
  }
  await app.saver.flush();
  const snap = await api.createSnapshot(app.doc.id, label);
  toast(`Snapshot taken: ${snap.label}`);
}

function diffView(before: string, after: string): HTMLElement {
  const box = h('div', { class: 'diff', 'aria-label': 'Differences' });
  const parts = diffWordsWithSpace(before, after);
  let changes = 0;
  for (const p of parts) {
    if (p.added) {
      changes++;
      box.appendChild(h('ins', { title: 'Only in the current text' }, p.value));
    } else if (p.removed) {
      changes++;
      box.appendChild(h('del', { title: 'Only in the snapshot' }, p.value));
    } else box.appendChild(document.createTextNode(p.value));
  }
  if (!changes) box.appendChild(h('p', { class: 'quiet-text' }, 'No differences.'));
  return box;
}

function openPanel(app: App): void {
  const doc = app.doc;
  if (!doc) {
    toast('Nothing to snapshot yet.');
    return;
  }
  panel('Snapshots', (close) => {
    const list = h('div', { class: 'snap-list' });
    const detail = h('div', { class: 'snap-detail' });
    const take = h('button', { type: 'button', onclick: async () => { await takeSnapshot(app, true); await load(); } }, 'Take snapshot…');

    const compare = async (s: Snapshot) => {
      clear(detail);
      const full = await api.snapshot(s.id);
      const then = docText(await app.codec().decode(full.content_json!) as never);
      const now = docText(app.editor?.getJSON() as never);
      detail.append(
        h('div', { class: 'snap-detail-head' },
          h('strong', null, s.label), ' ',
          h('span', { class: 'quiet-text' }, `${dateTimeLabel(s.created_at)} — struck through: only in the snapshot; underlined: only now`)),
        diffView(then, now),
      );
    };

    const restore = async (s: Snapshot) => {
      const ok = await confirmAction(`Restore “${s.label}”?`, 'Restore',
        'The current text is kept as a new snapshot first, so nothing is lost.');
      if (!ok) return;
      await app.saver.flush();
      await app.sessions.end('switch');
      await api.restoreSnapshot(s.id);
      await app.reloadDocument();
      toast(`Restored “${s.label}”`);
      close();
    };

    const row = (s: Snapshot) => h('div', { class: 'snap-row' },
      h('div', { class: 'snap-info' }, h('span', { class: 'snap-label' }, s.label), h('span', { class: 'item-meta' }, dateTimeLabel(s.created_at))),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', onclick: () => void compare(s) }, 'Compare'),
        h('button', { type: 'button', onclick: () => void restore(s) }, 'Restore'),
        h('button', { type: 'button', class: 'quiet', onclick: async () => {
          const label = await ask({ title: 'Rename snapshot', value: s.label, ok: 'Rename' });
          if (label?.trim()) { await api.renameSnapshot(s.id, label.trim()); await load(); }
        } }, 'Rename'),
        h('button', { type: 'button', class: 'quiet', onclick: async () => {
          if (await confirmAction(`Delete snapshot “${s.label}”?`, 'Delete')) { await api.deleteSnapshot(s.id); await load(); }
        } }, 'Delete')));

    const load = async () => {
      const snaps = await api.snapshots(doc.id);
      clear(list);
      if (!snaps.length) list.appendChild(h('p', { class: 'quiet-text' }, 'No snapshots of this document yet.'));
      for (const s of snaps) list.appendChild(row(s));
    };
    void load();
    return h('div', { class: 'snapshots' }, h('div', { class: 'row-actions' }, take), list, detail);
  }, true);
}

export const snapshotsFeature: Feature = {
  topbar(app) {
    if (app.kind.tools.snapshots !== 'prominent') return [];
    return [
      h('button', { type: 'button', class: 'quiet', title: 'Take a snapshot now (Ctrl+Shift+S)', onclick: () => void takeSnapshot(app, false) }, 'Snapshot'),
      h('button', { type: 'button', class: 'quiet', title: 'Compare or restore snapshots', onclick: () => openPanel(app) }, 'Versions'),
    ];
  },
  documentMenu(app) {
    if (app.kind.tools.snapshots === 'off' || !app.doc) return [];
    return [
      { label: '', run: () => undefined, separator: true },
      { label: 'Take snapshot', hint: 'Ctrl+Shift+S', run: () => void takeSnapshot(app, false) },
      { label: 'Snapshots…', run: () => openPanel(app) },
    ];
  },
  onKey(app, e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (app.kind.tools.snapshots !== 'off') void takeSnapshot(app, true);
      return true;
    }
    return false;
  },
};
