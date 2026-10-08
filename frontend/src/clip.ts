import { api } from './api';
import { clipForm } from './features/research';
import { h } from './lib/dom';
import { applyTheme, settings } from './settings';

/**
 * /clip: a small page for a bookmarklet. Opens with the selected text, page
 * title and address filled in; saves the quote and its source in one step.
 */
export async function clipPage(root: HTMLElement): Promise<void> {
  applyTheme(settings().theme);
  document.title = 'Clip a quote · Cadence';
  const params = new URLSearchParams(window.location.search);
  const kinds = (await api.kinds()).filter((k) => k.tools.research_pane && !k.encrypted);
  const docs = (await Promise.all(kinds.map((k) => api.tree(k.id)))).flatMap((t) => t.documents);
  docs.sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''));
  const select = h('select', { 'aria-label': 'Attach to' },
    h('option', { value: '' }, 'Not attached to a document'),
    docs.map((d, i) => h('option', { value: String(d.id), selected: i === 0 }, d.title || 'Untitled'))) as HTMLSelectElement;
  const done = h('p', { class: 'lock-status', role: 'status' });
  const form = clipForm({
    initial: { quote: params.get('quote') ?? '', title: params.get('title') ?? '', url: params.get('url') ?? '' },
    submitLabel: 'Save quote',
    onSubmit: async (data) => {
      await api.clip({ ...data, document_ids: select.value ? [Number(select.value)] : [] });
      form.hidden = true;
      done.textContent = 'Saved. You can close this window.';
    },
  });
  root.appendChild(h('div', { class: 'layout clip-page' }, h('main', { class: 'screen' },
    h('h1', null, 'Clip a quote'),
    h('label', { class: 'field' }, h('span', null, 'Attach to'), select),
    form, done)));
  form.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}
