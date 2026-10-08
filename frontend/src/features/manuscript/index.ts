import type { Feature } from '../../app';
import { h } from '../../lib/dom';
import { settings, updateSettings } from '../../settings';
import { openCompile } from './compile';
import { contextFolders, contextProject } from './context';
import { openDraftSets } from './draftsets';
import { closeInspectorFor, inspectorOpen, renderInspector, toggleInspector } from './inspector';
import { openReading } from './reading';
import { openProjectSearch } from './search';
import { hidePane, paneOwner } from './sidepane';
import { closeBeside, openBeside, pickBeside } from './split';
import { datedScenes, openTimeline } from './timeline';
import { openTodos } from './todos';

const sep = { label: '', run: () => undefined, separator: true };

/** Manuscript tools, each gated by its flag in the kinds registry. */
export const manuscriptFeature: Feature = {
  async beforeKind(app, kind) {
    if (app.kind && kind.id !== app.kind.id) {
      if (paneOwner() === 'split') await closeBeside(app);
      for (const id of ['todos', 'search']) hidePane(app, id);
    }
    if (!kind.tools.inspector) closeInspectorFor(app);
    return true;
  },
  settingsMenu(app) {
    if (app.kind?.list_view !== 'ordered') return [];
    const s = settings();
    return [{ label: 'Word counts in library', checked: s.libraryCounts, run: () => { updateSettings({ libraryCounts: !s.libraryCounts }); void app.refreshTree(); } }];
  },
  topbar(app) {
    const k = app.kind;
    const out: HTMLElement[] = [];
    if (k.tools.inspector) {
      out.push(h('button', {
        type: 'button', class: `quiet${inspectorOpen() ? ' on' : ''}`, title: 'Details: status, synopsis, point of view, date, target, beats',
        'aria-pressed': String(inspectorOpen()), onclick: () => void toggleInspector(app),
      }, 'Details'));
    }
    return out;
  },
  documentMenu(app) {
    const k = app.kind;
    const t = k.tools;
    if (!(t.compile || t.draft_sets || t.todo_markers || t.split_view || t.project_search || t.reading_mode || t.timeline || t.forward_only)) return [];
    const project = contextProject(app);
    const activeId = app.activeDocId();
    const active = activeId !== null ? app.tree.documents.find((d) => d.id === activeId) : undefined;
    const chain = contextFolders(app);
    const chapter = chain[chain.length - 1] ?? null;
    return [
      sep,
      t.forward_only && (app.editor || app.view) ? { label: 'Forward-only drafting', checked: app.forwardOnly, run: () => app.setForwardOnly(!app.forwardOnly) } : null,
      t.split_view ? { label: 'Open beside…', run: () => pickBeside(app) } : null,
      t.project_search ? { label: 'Search this project…', hint: 'Ctrl+Shift+P', run: () => void openProjectSearch(app) } : null,
      t.todo_markers && project ? { label: 'TODOs in this project', run: () => void openTodos(app) } : null,
      t.reading_mode && chapter ? { label: `Read “${chapter.folder.name}”`, run: () => void openReading(app, { folder: chapter }) } : null,
      t.reading_mode && active && !app.view ? { label: `Read this ${k.item_label.toLowerCase()}`, run: () => void openReading(app, { doc: active }) } : null,
      t.timeline && project && datedScenes(app, project).length >= 2 ? { label: 'Timeline', run: () => openTimeline(app) } : null,
      t.compile ? { label: 'Compile…', run: () => openCompile(app, null, () => void openTodos(app)) } : null,
      t.draft_sets ? { label: 'Draft sets…', run: () => openDraftSets(app) } : null,
    ];
  },
  folderMenu(app, node) {
    const t = app.kind.tools;
    const project = contextProject(app, node);
    return [
      t.reading_mode ? { label: 'Read', run: () => void openReading(app, { folder: node }) } : null,
      t.project_search ? { label: 'Search in here…', run: () => void openProjectSearch(app, node) } : null,
      t.todo_markers ? { label: 'TODOs', run: () => void openTodos(app, node) } : null,
      t.timeline && project && datedScenes(app, project).length >= 2 ? { label: 'Timeline', run: () => openTimeline(app, node) } : null,
      t.compile ? { label: 'Compile…', run: () => openCompile(app, node, () => void openTodos(app, node)) } : null,
      t.draft_sets ? { label: 'Draft sets…', run: () => openDraftSets(app, node) } : null,
    ];
  },
  docMenu(app, doc) {
    return app.kind.tools.split_view && doc.id !== app.activeDocId() ? [{ label: 'Open beside', run: () => void openBeside(app, doc) }] : [];
  },
  noteActions(app, doc) {
    if (!app.kind.tools.split_view) return [];
    return [h('button', { type: 'button', class: 'quiet small', title: 'Open beside the text', onclick: () => void openBeside(app, doc) }, 'Beside')];
  },
  onDocument(app) {
    if (app.kind.tools.inspector) void renderInspector(app);
  },
  onKey(app, e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p' && app.kind?.tools.project_search) {
      e.preventDefault();
      void openProjectSearch(app);
      return true;
    }
    return false;
  },
};
