import type { Feature } from '../../app';
import { h } from '../../lib/dom';
import { settings, updateSettings } from '../../settings';
import { openCompile } from './compile';
import { openDraftSets } from './draftsets';
import { closeInspectorFor, inspectorOpen, renderInspector, toggleInspector } from './inspector';

/** Manuscript tools, each gated by its flag in the kinds registry. */
export const manuscriptFeature: Feature = {
  async beforeKind(app, kind) {
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
        type: 'button', class: `quiet${inspectorOpen() ? ' on' : ''}`, title: 'Details: status, synopsis, point of view, date, target',
        'aria-pressed': String(inspectorOpen()), onclick: () => void toggleInspector(app),
      }, 'Details'));
    }
    return out;
  },
  documentMenu(app) {
    const k = app.kind;
    if (!k.tools.compile && !k.tools.draft_sets) return [];
    return [
      { label: '', run: () => undefined, separator: true },
      k.tools.compile ? { label: 'Compile…', run: () => openCompile(app) } : null,
      k.tools.draft_sets ? { label: 'Draft sets…', run: () => openDraftSets(app) } : null,
    ];
  },
  folderMenu(app, node) {
    const k = app.kind;
    return [
      k.tools.compile ? { label: 'Compile…', run: () => openCompile(app, node) } : null,
      k.tools.draft_sets ? { label: 'Draft sets…', run: () => openDraftSets(app, node) } : null,
    ];
  },
  onDocument(app) {
    if (app.kind.tools.inspector) void renderInspector(app);
  },
};
