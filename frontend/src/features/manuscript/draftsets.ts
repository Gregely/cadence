import { api } from '../../api';
import type { App } from '../../app';
import { dateTimeLabel } from '../../lib/dates';
import { clear, h } from '../../lib/dom';
import { paragraphDiff, paragraphs } from '../../lib/paradiff';
import { formatCount } from '../../lib/text';
import type { FolderNode } from '../../lib/tree';
import type { DraftSet } from '../../types';
import { ask, confirmAction, panel, toast } from '../../ui/dialogs';
import { contextProject } from './context';

/**
 * Draft sets: a named snapshot of a whole project. Compare a scene with a
 * set paragraph by paragraph, restore one scene or everything. A restore
 * always takes an automatic safety set first.
 */
export function openDraftSets(app: App, start?: FolderNode | null): void {
  const project = contextProject(app, start);
  if (!project) {
    toast(`Open a ${app.kind.folder_label.toLowerCase()} or one of its scenes first.`);
    return;
  }
  const activeId = app.activeDocId();
  const active = activeId !== null ? app.tree.documents.find((d) => d.id === activeId) : undefined;
  panel(`Draft sets · ${project.folder.name}`, (close) => {
    const list = h('div', { class: 'snap-list' });
    const detail = h('div', { class: 'snap-detail' });
    const name = h('input', { type: 'text', placeholder: 'Draft 1', 'aria-label': 'Name for the draft set', autocomplete: 'off' }) as HTMLInputElement;
    const take = h('form', {
      class: 'row-actions take-set',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const label = name.value.trim() || `Draft ${list.querySelectorAll('.set-row:not(.auto)').length + 1}`;
        await app.flushAll();
        const s = await api.takeDraftSet(project.id, label);
        name.value = '';
        toast(`Draft set “${s.name}” saved: ${s.documents} documents.`);
        await load();
      },
    }, name, h('button', { type: 'submit' }, 'Take draft set'));

    const reopen = async (docId: number | null) => {
      await app.refreshTree();
      if (app.view) await app.openFolder(app.view.folder.id, { push: false, focusDoc: docId });
      else if (app.doc) await app.reloadDocument();
    };

    const restore = async (s: DraftSet, docId?: number) => {
      const what = docId ? `this ${app.kind.item_label.toLowerCase()}` : 'the whole project';
      const ok = await confirmAction(`Restore ${what} from “${s.name}”?`, 'Restore',
        'First a safety set of the whole project is taken automatically, so you can come back to how things are now. '
        + 'Nothing is deleted; documents written after this set are left as they are.');
      if (!ok) return;
      await app.flushAll();
      const out = await api.restoreDraftSet(s.id, docId);
      await reopen(app.activeDocId() ?? docId ?? null);
      toast(`Restored ${out.restored.length + out.recreated.length}. Before: “${out.safety_set.name}”.`);
      close();
    };

    const compare = async (s: DraftSet) => {
      if (!active) return;
      clear(detail);
      await app.flushDoc(active.id);
      let item;
      try {
        item = await api.draftSetItem(s.id, active.id);
      } catch {
        detail.appendChild(h('p', { class: 'quiet-text' }, `“${active.title || 'Untitled'}” is not in this set.`));
        return;
      }
      const current = await api.getDocument(active.id);
      const changes = paragraphDiff(paragraphs(JSON.parse(item.content_json)), paragraphs(JSON.parse(current.content_json)));
      const box = h('div', { class: 'para-diff' });
      for (const c of changes) {
        const tag = c.kind === 'added' ? 'ins' : c.kind === 'removed' ? 'del' : 'p';
        const marker = c.kind === 'added' ? '+ ' : c.kind === 'removed' ? '− ' : '';
        box.appendChild(h(tag, { class: `para ${c.kind}` }, marker ? h('span', { class: 'para-mark', 'aria-hidden': 'true' }, marker) : null, c.text));
      }
      if (!changes.some((c) => c.kind !== 'same')) box.appendChild(h('p', { class: 'quiet-text' }, 'No differences.'));
      detail.append(
        h('div', { class: 'snap-detail-head' }, h('strong', null, `${current.title || 'Untitled'} — “${s.name}” and now`), ' ',
          h('span', { class: 'quiet-text' }, 'struck through (−): only in the set; underlined (+): only now')),
        box);
    };

    const row = (s: DraftSet) => h('div', { class: `snap-row set-row${s.automatic ? ' auto' : ''}` },
      h('div', { class: 'snap-info' },
        h('span', { class: 'snap-label' }, s.name, s.automatic ? h('span', { class: 'tag' }, ' (automatic)') : null),
        h('span', { class: 'item-meta' }, `${dateTimeLabel(s.created_at)} · ${s.documents} documents · ${formatCount(s.words)} words`)),
      h('div', { class: 'row-actions' },
        active ? h('button', { type: 'button', onclick: () => void compare(s) }, `Compare this ${app.kind.item_label.toLowerCase()}`) : null,
        active ? h('button', { type: 'button', onclick: () => void restore(s, active.id) }, `Restore this ${app.kind.item_label.toLowerCase()}`) : null,
        h('button', { type: 'button', onclick: () => void restore(s) }, 'Restore whole project'),
        h('button', { type: 'button', class: 'quiet', onclick: async () => {
          const label = await ask({ title: 'Rename draft set', value: s.name, ok: 'Rename' });
          if (label?.trim()) { await api.renameDraftSet(s.id, label.trim()); await load(); }
        } }, 'Rename'),
        h('button', { type: 'button', class: 'quiet', onclick: async () => {
          if (await confirmAction(`Delete the draft set “${s.name}”?`, 'Delete', 'Your documents are not affected.')) { await api.deleteDraftSet(s.id); await load(); }
        } }, 'Delete')));

    const load = async () => {
      const out = await api.draftSets(project.id);
      clear(list);
      if (!out.sets.length) list.appendChild(h('p', { class: 'quiet-text' }, 'No draft sets yet.'));
      for (const s of out.sets) list.appendChild(row(s));
    };
    void load();
    return h('div', { class: 'draft-sets' },
      h('p', { class: 'quiet-text' }, 'A draft set keeps the text of every document in the project as it is now.'),
      take, list, detail);
  }, true);
}
