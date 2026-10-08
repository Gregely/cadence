import { generateHTML } from '@tiptap/core';

import { api } from '../api';
import { buildExtensions } from '../editor/extensions';
import { dayLabel, timeLabel } from '../lib/dates';
import { h } from '../lib/dom';
import type { DocFull, KindDef } from '../types';

/** A dated stream of every document in a kind, newest first, to scroll. */
export function streamScreen(kind: KindDef, host: { back(): void; open(id: number): void; newDocument(): void }): HTMLElement {
  const extensions = buildExtensions(kind, { history: false });
  const list = h('div', { class: 'stream' });
  const more = h('button', { type: 'button', class: 'quiet', hidden: true }, 'Show older');
  let offset = 0;
  let lastDay = '';

  const card = (d: DocFull): HTMLElement => {
    const body = h('div', { class: `prose kind-${kind.id} stream-body` });
    try {
      // generateHTML builds DOM through the editor schema: no raw HTML from storage.
      body.innerHTML = generateHTML(JSON.parse(d.content_json), extensions);
    } catch {
      body.textContent = d.plain_text ?? '';
    }
    return h('article', {
      class: 'stream-item',
      tabindex: '0',
      onclick: () => host.open(d.id),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') host.open(d.id); },
    },
    h('div', { class: 'item-meta' }, timeLabel(d.created_at)),
    d.title ? h('h3', { class: 'stream-title' }, d.title) : null,
    body);
  };

  const load = async () => {
    const page = await api.stream(kind.id, offset, 50);
    for (const d of page.documents) {
      const day = dayLabel(d.created_at);
      if (day !== lastDay) {
        list.appendChild(h('h2', { class: 'stream-day' }, day));
        lastDay = day;
      }
      list.appendChild(card(d));
    }
    offset += page.documents.length;
    more.hidden = !page.more;
  };
  more.addEventListener('click', () => void load());
  void load();
  return h('section', { class: 'screen stream-screen', 'aria-label': `${kind.label} stream` },
    h('header', { class: 'screen-head' },
      h('button', { type: 'button', class: 'quiet', onclick: () => host.back() }, '‹ Back to writing'),
      h('h1', null, kind.label),
      h('button', { type: 'button', onclick: () => host.newDocument() }, `New ${kind.item_label.toLowerCase()}`)),
    list, more);
}
