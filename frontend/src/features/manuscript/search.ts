import { api } from '../../api';
import type { App } from '../../app';
import { clear, h, highlighted } from '../../lib/dom';
import { roleLabel } from '../../lib/roles';
import type { FolderNode } from '../../lib/tree';
import { contextProject } from './context';
import { hidePane, showPane } from './sidepane';

/** Search scenes and misc notes, in this project by default. */
export async function openProjectSearch(app: App, start?: FolderNode | null): Promise<void> {
  const project = contextProject(app, start);
  const kind = app.kind;
  let wholeKind = !project;
  const input = h('input', { type: 'search', 'aria-label': 'Search the project', placeholder: project ? `Search ${project.folder.name}` : `Search ${kind.label.toLowerCase()}`, autocomplete: 'off' }) as HTMLInputElement;
  const scope = h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: wholeKind, disabled: !project, onchange: (e: Event) => { wholeKind = (e.target as HTMLInputElement).checked; void run(); } }),
    ` All ${kind.label.toLowerCase()}`);
  const results = h('div', { class: 'search-results' });
  const run = async () => {
    const q = input.value.trim();
    clear(results);
    if (!q) return;
    await app.flushAll();
    const hits = await api.search(q, kind.id, false, 50, wholeKind ? null : project?.id);
    if (!hits.length) results.appendChild(h('p', { class: 'quiet-text' }, 'Nothing found.'));
    for (const hit of hits) {
      const path = hit.folder_path.slice(project && !wholeKind ? 1 : 0);
      results.appendChild(h('button', { type: 'button', class: 'hit', onclick: () => void app.jumpTo(hit.id) },
        h('span', { class: 'hit-title' }, hit.title || 'Untitled', hit.role && roleLabel(kind, hit.role) && kind.roles[0]?.id !== hit.role
          ? h('span', { class: 'tag' }, ` ${roleLabel(kind, hit.role).toLowerCase()}`) : null),
        h('span', { class: 'item-meta' }, path.join(' / ') || kind.label),
        h('span', { class: 'hit-snippet' }, highlighted(hit.snippet))));
    }
  };
  let timer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hidePane(app, 'search');
    }
  });
  const root = h('aside', { class: 'side-list', 'aria-label': 'Search the project' },
    h('div', { class: 'pane-top' }, h('strong', null, 'Search'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close search', onclick: () => hidePane(app, 'search') }, '×')),
    input, scope, results);
  await showPane(app, { id: 'search', close: () => undefined }, root);
  input.focus();
}
