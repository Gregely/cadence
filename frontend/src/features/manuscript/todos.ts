import { api } from '../../api';
import type { App } from '../../app';
import { clear, h } from '../../lib/dom';
import type { FolderNode } from '../../lib/tree';
import { toast } from '../../ui/dialogs';
import { contextProject } from './context';
import { hidePane, showPane } from './sidepane';

/** Every [[...]] marker in the project, with chapter and scene; click to jump. */
export async function openTodos(app: App, start?: FolderNode | null): Promise<void> {
  const project = contextProject(app, start);
  if (!project) {
    toast(`Open a ${app.kind.folder_label.toLowerCase()} or one of its scenes first.`);
    return;
  }
  await app.flushAll();
  const list = h('div', { class: 'todo-list' });
  const root = h('aside', { class: 'side-list', 'aria-label': 'TODO markers' },
    h('div', { class: 'pane-top' }, h('strong', null, 'TODOs'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close TODOs', onclick: () => hidePane(app, 'todos') }, '×')),
    h('p', { class: 'item-meta' }, `${project.folder.name}: markers written as [[...]] in the text. They are left out when you compile.`),
    list);
  await showPane(app, { id: 'todos', close: () => undefined }, root);
  const out = await api.todos(project.id);
  clear(list);
  if (!out.todos.length) {
    list.appendChild(h('p', { class: 'quiet-text' }, 'No markers. Type [[ ... ]] anywhere in a scene to leave one.'));
    return;
  }
  for (const t of out.todos) {
    list.appendChild(h('button', {
      type: 'button', class: 'hit todo-hit',
      onclick: () => void app.jumpTo(t.document_id, t.index),
    },
    h('span', { class: 'hit-title' }, `[[${t.text}]]`),
    h('span', { class: 'item-meta' }, [...t.path.slice(1), t.title || 'Untitled'].join(' / ') + (t.role === 'misc' ? ' (misc note)' : ''))));
  }
}
