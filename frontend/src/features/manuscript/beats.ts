import { h } from '../../lib/dom';
import type { Beat } from '../../types';

/**
 * A scene's beats: short items with tick boxes, collapsed until opened.
 * Stored in the document's details; never part of the text or compile.
 */
export function beatsEditor(initial: Beat[], save: (beats: Beat[]) => Promise<void>): HTMLElement {
  let beats = initial.map((b) => ({ ...b }));
  const list = h('ul', { class: 'beats-list' });
  const summary = h('summary', null);
  const commit = () => {
    render();
    void save(beats);
  };
  const render = () => {
    const done = beats.filter((b) => b.done).length;
    summary.textContent = beats.length ? `Beats · ${done} of ${beats.length}` : 'Beats';
    list.replaceChildren(...beats.map((b, i) => {
      const box = h('input', { type: 'checkbox', checked: b.done, 'aria-label': `Done: ${b.text}` }) as HTMLInputElement;
      box.addEventListener('change', () => { beats[i] = { ...b, done: box.checked }; commit(); });
      const text = h('input', { type: 'text', value: b.text, maxlength: '200', 'aria-label': 'Beat' }) as HTMLInputElement;
      text.addEventListener('change', () => {
        const v = text.value.trim();
        beats = v ? beats.map((x, j) => (j === i ? { ...x, text: v } : x)) : beats.filter((_, j) => j !== i);
        commit();
      });
      const remove = h('button', { type: 'button', class: 'icon', 'aria-label': `Remove beat: ${b.text}`, title: 'Remove', onclick: () => { beats = beats.filter((_, j) => j !== i); commit(); } }, '×');
      return h('li', { class: b.done ? 'done' : '' }, box, text, remove);
    }));
  };
  const add = h('input', { type: 'text', placeholder: 'Add a beat', maxlength: '200', 'aria-label': 'New beat' }) as HTMLInputElement;
  add.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = add.value.trim();
    if (!v) return;
    beats = [...beats, { text: v, done: false }];
    add.value = '';
    commit();
    add.focus();
  });
  render();
  return h('details', { class: 'beats', dataset: { field: 'beats' } }, summary, list, add,
    h('small', { class: 'quiet-text' }, 'Beats are notes for you; they are never compiled.'));
}
