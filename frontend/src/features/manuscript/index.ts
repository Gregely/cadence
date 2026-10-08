import type { Feature } from '../../app';
import { h } from '../../lib/dom';
import { settings, updateSettings } from '../../settings';
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
  onDocument(app) {
    if (app.kind.tools.inspector) void renderInspector(app);
  },
};
