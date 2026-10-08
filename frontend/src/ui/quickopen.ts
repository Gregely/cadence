import { h, clear } from '../lib/dom';
import { fuzzyScore } from '../lib/text';
import type { DocSummary, KindDef } from '../types';
import { docLabel } from './sidebar';

/**
 * Ctrl+P: find a document by title within the current kind. Purely local:
 * it filters the titles the sidebar already has.
 */
export function quickOpen(opts: {
  kind: KindDef;
  docs: DocSummary[];
  folderPath: (folderId: number | null) => string;
  onPick: (doc: DocSummary) => void;
  title?: string;
}): void {
  document.querySelector('.quick-open')?.remove();
  const previous = document.activeElement as HTMLElement | null;
  const input = h('input', {
    type: 'text',
    class: 'quick-input',
    placeholder: `Find ${opts.kind.label.toLowerCase()} by title`,
    'aria-label': opts.title ?? 'Quick open',
    autocomplete: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'quick-list',
  }) as HTMLInputElement;
  const list = h('ul', { class: 'quick-list', id: 'quick-list', role: 'listbox' });
  const box = h('div', { class: 'quick-open', role: 'dialog', 'aria-label': opts.title ?? 'Quick open' },
    opts.title ? h('div', { class: 'quick-title' }, opts.title) : null, input, list);
  const backdrop = h('div', { class: 'modal-backdrop light' }, box);
  let results: DocSummary[] = [];
  let active = 0;

  const close = (restore = true) => {
    backdrop.remove();
    if (restore) previous?.focus?.({ preventScroll: true });
  };

  const render = () => {
    const q = input.value;
    const scored = opts.docs
      .map((d) => ({ d, s: fuzzyScore(q, docLabel(opts.kind, d)) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (q ? (b.s! - a.s!) : (b.d.last_opened_at ?? '').localeCompare(a.d.last_opened_at ?? '')));
    results = scored.slice(0, 30).map((x) => x.d);
    active = Math.min(active, Math.max(0, results.length - 1));
    clear(list);
    results.forEach((d, i) => {
      const path = opts.folderPath(d.folder_id);
      const li = h('li', {
        role: 'option',
        id: `qo-${d.id}`,
        'aria-selected': String(i === active),
        class: i === active ? 'active' : '',
        onmousedown: (e: Event) => {
          e.preventDefault();
          close(false);
          opts.onPick(d);
        },
      }, h('span', { class: 'label' }, docLabel(opts.kind, d)), path ? h('span', { class: 'path' }, path) : null);
      list.appendChild(li);
    });
    if (!results.length) list.appendChild(h('li', { class: 'none' }, 'No match'));
    input.setAttribute('aria-activedescendant', results[active] ? `qo-${results[active]!.id}` : '');
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      close(false);
      if (pick) opts.onPick(pick);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  render();
  input.focus();
}
