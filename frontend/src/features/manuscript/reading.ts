import { generateHTML, type JSONContent } from '@tiptap/core';

import { api } from '../../api';
import type { App } from '../../app';
import { buildExtensions } from '../../editor/extensions';
import { TODO_RE } from '../../editor/manuscript';
import { h } from '../../lib/dom';
import { inManuscript } from '../../lib/roles';
import type { FolderNode } from '../../lib/tree';
import type { DocSummary } from '../../types';

/** A copy of a document without its [[...]] markers. */
export function withoutMarkers(node: JSONContent): JSONContent {
  const out: JSONContent = { ...node };
  if (node.type === 'text') {
    out.text = (node.text ?? '').replace(TODO_RE, '').replace(/[ \t]{2,}/g, ' ');
    return out;
  }
  if (node.content) out.content = node.content.map(withoutMarkers).filter((n) => !(n.type === 'text' && !n.text));
  return out;
}

type Block = { heading: string; level: number } | { doc: DocSummary; first: boolean };

function blocks(app: App, folder: FolderNode, depth = 0, out: Block[] = []): Block[] {
  for (const sub of folder.folders) {
    out.push({ heading: sub.folder.name, level: Math.min(4, depth + 2) });
    blocks(app, sub, depth + 1, out);
  }
  let first = true;
  for (const d of folder.docs) {
    // Misc notes and unwritten scenes have nothing to read.
    if (!inManuscript(app.kind, d.doc) || (d.doc.words ?? 0) === 0) continue;
    out.push({ doc: d.doc, first });
    first = false;
  }
  return out;
}

/**
 * Reading mode: the chapter (or scene) as pages, with no editing controls.
 * Pages turn with a tap on either side, the arrow keys, Page Up/Down or the
 * space bar; each turn replaces the whole page, which suits e-ink.
 */
export async function openReading(app: App, target: { folder?: FolderNode; doc?: DocSummary }): Promise<void> {
  await app.flushAll();
  const kind = app.kind;
  const title = target.folder ? target.folder.folder.name : target.doc!.title || 'Untitled';
  const list: Block[] = target.folder ? blocks(app, target.folder) : [{ doc: target.doc!, first: true }];
  const extensions = buildExtensions(kind, { history: false });
  const pages = h('div', { class: `reader-pages prose kind-${kind.id}` }, h('h1', { class: 'reader-title' }, title));
  const docs = await Promise.all(list.map((b) => ('doc' in b ? api.getDocument(b.doc.id) : Promise.resolve(null))));
  list.forEach((b, i) => {
    if ('heading' in b) {
      pages.appendChild(h(`h${b.level}` as 'h2', { class: 'reader-heading' }, b.heading));
      return;
    }
    if (!b.first) pages.appendChild(h('p', { class: 'reader-break', 'aria-label': 'Scene break' }, '#'));
    const section = h('div', { class: 'reader-doc' });
    try {
      section.innerHTML = generateHTML(withoutMarkers(JSON.parse(docs[i]!.content_json)), extensions);
    } catch {
      section.textContent = '';
    }
    pages.appendChild(section);
  });

  const win = h('div', { class: 'reader-window' }, pages);
  const counter = h('span', { class: 'reader-count', role: 'status', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'quiet', 'aria-label': 'Previous page' }, '‹ Previous');
  const next = h('button', { type: 'button', class: 'quiet', 'aria-label': 'Next page' }, 'Next ›');
  const close = h('button', { type: 'button', class: 'quiet' }, 'Close');
  const reader = h('section', { class: 'reader', role: 'dialog', 'aria-label': `Reading: ${title}`, tabindex: '-1', style: app.el.getAttribute('style') ?? '' },
    win, h('footer', { class: 'reader-bar' }, prev, counter, next, h('span', { class: 'spacer' }), close));
  document.body.appendChild(reader);

  const GAP = 48;
  let page = 0;
  let total = 1;
  const layout = () => {
    const w = win.clientWidth;
    pages.style.columnWidth = `${w}px`;
    pages.style.columnGap = `${GAP}px`;
    pages.style.height = `${win.clientHeight}px`;
    total = Math.max(1, Math.round((pages.scrollWidth + GAP) / (w + GAP)));
    page = Math.min(page, total - 1);
    show();
  };
  const show = () => {
    pages.style.transform = `translateX(${-page * (win.clientWidth + GAP)}px)`;
    counter.textContent = `Page ${page + 1} of ${total}`;
    prev.toggleAttribute('disabled', page === 0);
    next.toggleAttribute('disabled', page >= total - 1);
  };
  const turn = (by: number) => {
    page = Math.max(0, Math.min(total - 1, page + by));
    show();
  };
  const done = () => {
    reader.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', layout);
    app.editor?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); turn(1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); turn(-1); }
    else if (e.key === 'Home') { e.preventDefault(); page = 0; show(); }
    else if (e.key === 'End') { e.preventDefault(); page = total - 1; show(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
  };
  win.addEventListener('click', (e) => {
    const r = win.getBoundingClientRect();
    turn((e as MouseEvent).clientX - r.left < r.width * 0.3 ? -1 : 1);
  });
  prev.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));
  close.addEventListener('click', done);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', layout);
  await document.fonts?.ready;
  layout();
  reader.focus();
}
