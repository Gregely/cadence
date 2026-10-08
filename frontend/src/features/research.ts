import { generateHTML } from '@tiptap/core';

import { api } from '../api';
import type { App, Feature } from '../app';
import { buildExtensions, hasExtension } from '../editor/extensions';
import { footnoteText, inlineCitation } from '../lib/cite';
import { clear, h, highlighted } from '../lib/dom';
import type { Clip, SearchHit, Source } from '../types';
import { confirmAction, toast } from '../ui/dialogs';

/**
 * The research pane (kinds with tools.research_pane): search my own
 * documents and sources, clip quotes, and cite them in the text.
 */
let open = false;

export function clipForm(opts: {
  initial?: { quote?: string; title?: string; author?: string; url?: string; page?: string; published?: string };
  submitLabel: string;
  onSubmit: (data: { quote: string; page: string; note: string; source: Partial<Source> }) => Promise<void>;
  onCancel?: () => void;
}): HTMLElement {
  const i = opts.initial ?? {};
  const field = (label: string, el: HTMLInputElement | HTMLTextAreaElement, value = '') => {
    el.value = value;
    return h('label', { class: 'field' }, h('span', null, label), el);
  };
  const quote = h('textarea', { rows: '5', required: true }) as HTMLTextAreaElement;
  const title = h('input', { type: 'text', required: true, autocomplete: 'off' }) as HTMLInputElement;
  const author = h('input', { type: 'text', autocomplete: 'off' }) as HTMLInputElement;
  const url = h('input', { type: 'url', autocomplete: 'off', placeholder: 'https://' }) as HTMLInputElement;
  const page = h('input', { type: 'text', autocomplete: 'off', class: 'short' }) as HTMLInputElement;
  const published = h('input', { type: 'text', autocomplete: 'off', class: 'short', placeholder: 'e.g. 1862' }) as HTMLInputElement;
  const note = h('textarea', { rows: '2' }) as HTMLTextAreaElement;
  const status = h('p', { class: 'lock-status', role: 'status' });
  const form = h('form', { class: 'clip-form' },
    field('Quote', quote, i.quote),
    field('Source title', title, i.title),
    field('Author', author, i.author),
    field('URL', url, i.url),
    h('div', { class: 'field-row' }, field('Page', page, i.page), field('Date', published, i.published)),
    field('Note (optional)', note),
    h('div', { class: 'row-actions' },
      h('button', { type: 'submit' }, opts.submitLabel),
      opts.onCancel ? h('button', { type: 'button', class: 'quiet', onclick: opts.onCancel }, 'Cancel') : null),
    status);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!quote.value.trim() || !title.value.trim()) {
      status.textContent = 'A quote and a source title are needed.';
      return;
    }
    try {
      await opts.onSubmit({
        quote: quote.value,
        page: page.value,
        note: note.value,
        source: { title: title.value, author: author.value, url: url.value, published: published.value },
      });
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'Could not save';
    }
  });
  return form;
}

function pane(app: App): HTMLElement {
  const input = h('input', { type: 'search', placeholder: 'Search my writing and sources', 'aria-label': 'Research search', autocomplete: 'off' }) as HTMLInputElement;
  const body = h('div', { class: 'research-body' });
  const mobile = () => window.matchMedia('(max-width: 760px)').matches;

  const docId = () => app.doc?.id ?? null;
  const editor = () => app.editor?.editor ?? null;

  const afterInsert = async (c: Clip) => {
    const id = docId();
    if (id !== null && !c.document_ids.includes(id)) {
      await api.attachClip(c.id, id).catch(() => undefined);
    }
    if (mobile()) toggle(app, false);
  };

  const insertQuote = async (c: Clip, s: Source) => {
    const ed = editor();
    if (!ed) return;
    const para: object[] = [{ type: 'text', text: c.quote }];
    if (hasExtension(app.kind, 'footnote')) para.push({ type: 'footnote', attrs: { text: footnoteText(s, c.page), sourceId: s.id } });
    else para.push({ type: 'text', text: ` ${inlineCitation(s, c.page)}` });
    const block = hasExtension(app.kind, 'blockquote') ? { type: 'blockquote', content: [{ type: 'paragraph', content: para }] } : { type: 'paragraph', content: para };
    ed.chain().focus().insertContent([block, { type: 'paragraph' }]).run();
    await afterInsert(c);
  };

  const insertCite = async (c: Clip | null, s: Source) => {
    const ed = editor();
    if (!ed) return;
    const text = inlineCitation(s, c?.page ?? '');
    if (hasExtension(app.kind, 'citation')) ed.chain().focus().insertCitation({ text, sourceId: s.id, locator: c?.page ?? '' }).run();
    else ed.chain().focus().insertContent(text).run();
    if (c) await afterInsert(c);
  };

  const insertFootnote = async (c: Clip | null, s: Source) => {
    if (!app.editor || !hasExtension(app.kind, 'footnote')) return;
    app.editor.addFootnote(footnoteText(s, c?.page ?? ''), s.id);
    if (c) await afterInsert(c);
  };

  const clipRow = (c: Clip, s: Source) => h('div', { class: 'clip' },
    h('blockquote', null, c.quote),
    h('div', { class: 'item-meta' }, [s.author, s.title].filter(Boolean).join(', ') + (c.page ? `, p. ${c.page}` : '')),
    c.note ? h('p', { class: 'clip-note' }, c.note) : null,
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', title: 'Insert as a block quote with its footnote', onclick: () => void insertQuote(c, s) }, 'Quote'),
      h('button', { type: 'button', title: 'Insert an author–date citation', onclick: () => void insertCite(c, s) }, 'Cite'),
      hasExtension(app.kind, 'footnote') ? h('button', { type: 'button', title: 'Insert a footnote citing this', onclick: () => void insertFootnote(c, s) }, 'Footnote') : null,
      h('button', { type: 'button', class: 'quiet', title: 'Delete this clip', onclick: async () => {
        if (await confirmAction('Delete this quote from your sources?', 'Delete')) { await api.deleteClip(c.id); void refresh(); }
      } }, 'Delete')));

  const sourceBlock = (s: Source) => h('section', { class: 'source' },
    h('h3', null, s.title),
    h('div', { class: 'item-meta' }, [s.author, s.published].filter(Boolean).join(' · ')),
    s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'source-url' }, s.url) : null,
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'quiet', onclick: () => void insertCite(null, s) }, 'Cite'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => {
        const doc = await api.readingNotes(s.id, app.kind.id, null);
        await app.refreshTree();
        await app.openDocument(doc.id);
        toast('Reading notes created');
      } }, 'Reading notes')),
    ...(s.clips ?? []).map((c) => clipRow(c, s)));

  const preview = async (hit: SearchHit) => {
    const p = await api.researchPreview(hit.id);
    const kind = app.kindById(p.kind);
    clear(body);
    const content = h('div', { class: `prose kind-${p.kind} research-preview` });
    try {
      content.innerHTML = generateHTML(JSON.parse(p.content_json), buildExtensions(kind!, { history: false }));
    } catch {
      content.textContent = '';
    }
    body.append(
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'quiet', onclick: () => void refresh() }, '‹ Results'),
        h('button', { type: 'button', class: 'quiet', onclick: () => void app.openDocument(p.id) }, 'Open')),
      h('h3', null, p.title || 'Untitled'),
      p.folder_path.length ? h('div', { class: 'item-meta' }, p.folder_path.join(' / ')) : '',
      content);
  };

  const showClipper = () => {
    clear(body);
    body.appendChild(clipForm({
      submitLabel: 'Save quote',
      onCancel: () => void refresh(),
      onSubmit: async (data) => {
        const id = docId();
        await api.clip({ ...data, document_ids: id !== null ? [id] : [] });
        toast('Quote saved');
        input.value = '';
        await refresh();
      },
    }));
    body.querySelector('textarea')?.focus();
  };

  const refresh = async () => {
    const q = input.value.trim();
    clear(body);
    if (!q) {
      const id = docId();
      body.appendChild(h('h3', { class: 'pane-head' }, 'Quotes in this document'));
      const clips = id !== null ? await api.documentClips(id) : [];
      if (!clips.length) body.appendChild(h('p', { class: 'quiet-text' }, 'None yet. Search above, or clip a quote.'));
      for (const c of clips) body.appendChild(clipRow(c, c.source!));
      return;
    }
    const res = await api.researchSearch(q);
    if (res.documents.length) {
      body.appendChild(h('h3', { class: 'pane-head' }, 'My writing'));
      for (const d of res.documents) {
        body.appendChild(h('button', { type: 'button', class: 'hit', onclick: () => void preview(d) },
          h('span', { class: 'hit-title' }, d.title || 'Untitled'),
          h('span', { class: 'item-meta' }, [app.kindById(d.kind)?.label, ...d.folder_path].filter(Boolean).join(' / ')),
          h('span', { class: 'hit-snippet' }, highlighted(d.snippet))));
      }
    }
    if (res.sources.length) {
      body.appendChild(h('h3', { class: 'pane-head' }, 'Sources'));
      for (const s of res.sources) body.appendChild(sourceBlock(s));
    }
    if (!res.documents.length && !res.sources.length) body.appendChild(h('p', { class: 'quiet-text' }, 'Nothing found.'));
  };

  let timer = 0;
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      toggle(app, false);
    }
  });
  void refresh();
  const root = h('div', { class: 'research', role: 'complementary', 'aria-label': 'Research' },
    h('div', { class: 'pane-top' },
      h('strong', null, 'Research'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'quiet', onclick: showClipper }, 'Clip a quote'),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close research', title: 'Close (Ctrl+Shift+E)', onclick: () => toggle(app, false) }, '×')),
    input, body);
  (root as HTMLElement & { refresh?: () => void }).refresh = () => void refresh();
  return root;
}

function toggle(app: App, on?: boolean): void {
  open = on ?? !open;
  if (!app.kind.tools.research_pane || app.kind.encrypted) open = false;
  const slot = app.sidePaneSlot;
  clear(slot);
  slot.hidden = !open;
  if (open) {
    slot.appendChild(pane(app));
    slot.querySelector<HTMLInputElement>('input')?.focus();
  } else {
    app.editor?.focus();
  }
}

export const researchFeature: Feature = {
  async beforeKind(app, kind) {
    if (open && (!kind.tools.research_pane || kind.encrypted)) {
      open = false;
      clear(app.sidePaneSlot);
      app.sidePaneSlot.hidden = true;
    }
    return true;
  },
  topbar(app) {
    if (!app.kind.tools.research_pane || app.kind.encrypted) return [];
    return [h('button', { type: 'button', class: 'quiet', title: 'Research pane (Ctrl+Shift+E)', onclick: () => toggle(app) }, 'Research')];
  },
  onDocument(app) {
    if (!app.kind.tools.research_pane) {
      if (open) toggle(app, false);
      return;
    }
    const el = app.sidePaneSlot.querySelector<HTMLElement & { refresh?: () => void }>('.research');
    el?.refresh?.();
  },
  onKey(app, e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (app.kind.tools.research_pane) toggle(app);
      return true;
    }
    return false;
  },
};
