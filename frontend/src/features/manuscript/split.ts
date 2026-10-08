import type { App } from '../../app';
import { h } from '../../lib/dom';
import { roleLabel } from '../../lib/roles';
import type { DocSummary } from '../../types';
import { quickOpen } from '../../ui/quickopen';
import { docLabel } from '../../ui/sidebar';
import { DocPane } from '../../views/docpane';
import { hidePane, showPane } from './sidepane';

/**
 * Split view: another document (a scene or a misc note) beside the one
 * being written, both editable, each saving to itself.
 */
let pane: DocPane | null = null;

export async function openBeside(app: App, doc: DocSummary): Promise<void> {
  const kind = app.kind;
  if (pane) await closeBeside(app);
  const body = h('div', { class: 'split-body' });
  const root = h('aside', { class: 'split', 'aria-label': `Beside: ${docLabel(kind, doc)}` },
    h('div', { class: 'pane-top' },
      h('strong', null, docLabel(kind, doc)),
      doc.role && doc.role !== kind.default_role ? h('span', { class: 'tag' }, ` ${roleLabel(kind, doc.role).toLowerCase()}`) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'quiet', title: 'Open this on its own', onclick: () => void app.openDocument(doc.id) }, 'Open'),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close the document beside', onclick: () => void closeBeside(app) }, '×')),
    body);
  await showPane(app, { id: 'split', close: () => closeBeside(app) }, root);
  app.sidePaneSlot.classList.add('wide');
  const scroller = app.sidePaneSlot;
  pane = new DocPane({ app, kind, scroller, onState: () => undefined }, doc, body);
  await pane.mount('cursor');
}

export async function closeBeside(app: App): Promise<void> {
  const p = pane;
  pane = null;
  app.sidePaneSlot.classList.remove('wide');
  if (p) await p.close();
  hidePane(app, 'split');
}

export function besideId(): number | null {
  return pane?.id ?? null;
}

export function pickBeside(app: App): void {
  const current = app.activeDocId();
  quickOpen({
    kind: app.kind,
    docs: app.tree.documents.filter((d) => d.id !== current),
    folderPath: () => '',
    title: 'Open beside',
    onPick: (d) => void openBeside(app, d),
  });
}
