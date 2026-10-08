import { api } from '../../api';
import type { App } from '../../app';
import { clear, h } from '../../lib/dom';
import { store } from '../../lib/storage';
import { formatCount } from '../../lib/text';
import type { FolderNode } from '../../lib/tree';
import { panel, toast } from '../../ui/dialogs';
import { download } from '../exporting';
import { contextFolders } from './context';

/**
 * Compile a project, part or chapter to a manuscript. A warning about
 * unresolved TODO markers is shown, but never stops the compile.
 */
export function openCompile(app: App, start?: FolderNode | null, showTodos?: () => void): void {
  const chain = contextFolders(app, start);
  if (!chain.length) {
    toast(`Open a ${app.kind.folder_label.toLowerCase()} or one of its scenes first.`);
    return;
  }
  panel('Compile', (close) => {
    const kind = app.kind;
    const levels = ['Project', 'Part', 'Chapter', 'Section'];
    let scope = chain[chain.length - 1]!.id;
    const scopeField = h('fieldset', { class: 'compile-field' }, h('legend', null, 'What to compile'),
      chain.map((f, i) => {
        const input = h('input', { type: 'radio', name: 'compile-scope', value: String(f.id), checked: f.id === scope }) as HTMLInputElement;
        input.addEventListener('change', () => { scope = f.id; void refresh(); });
        const label = chain.length === 1 ? kind.folder_label : levels[Math.min(i, levels.length - 1)];
        return h('label', { class: 'check' }, input, ` ${label}: ${f.folder.name}`);
      }));
    let format = 'docx';
    const formats: [string, string][] = [['docx', 'Word manuscript (.docx)'], ['md', 'Markdown (.md)'], ['html', 'Web page (.html)']];
    const formatField = h('fieldset', { class: 'compile-field' }, h('legend', null, 'Format'),
      formats.map(([value, label]) => {
        const input = h('input', { type: 'radio', name: 'compile-format', value, checked: value === format }) as HTMLInputElement;
        input.addEventListener('change', () => { format = value; });
        return h('label', { class: 'check' }, input, ` ${label}`);
      }));
    const titlePage = h('input', { type: 'checkbox', checked: store.get('cadence.compile.titlePage') !== '0' }) as HTMLInputElement;
    const author = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name (optional)', value: store.get('cadence.compile.author') ?? '' }) as HTMLInputElement;
    const summary = h('p', { class: 'quiet-text', role: 'status' });
    const warning = h('p', { class: 'compile-warning', role: 'note', hidden: true });

    const refresh = async () => {
      const c = await api.compileCheck(scope).catch(() => null);
      clear(summary);
      clear(warning);
      warning.hidden = true;
      if (!c) return;
      summary.textContent = `${c.scenes} ${kind.item_label.toLowerCase()}${c.scenes === 1 ? '' : 's'} · ${formatCount(c.words)} words. Misc notes are left out.`;
      if (c.todos > 0) {
        warning.hidden = false;
        warning.append(`${c.todos} TODO marker${c.todos === 1 ? ' is' : 's are'} still in the text. ${c.todos === 1 ? 'It' : 'They'} will be left out of the compiled file. `);
        if (showTodos) warning.appendChild(h('button', { type: 'button', class: 'linkish', onclick: () => { close(); showTodos(); } }, 'Show them'));
      }
    };
    void refresh();
    return h('form', {
      class: 'compile-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        store.set('cadence.compile.author', author.value.trim());
        store.set('cadence.compile.titlePage', titlePage.checked ? '1' : '0');
        const params = new URLSearchParams({ format, title_page: String(titlePage.checked), author: author.value.trim() });
        void app.flushAll().then(() => {
          download(`/api/folders/${scope}/compile?${params}`);
          close();
        });
      },
    },
    scopeField, formatField,
    h('label', { class: 'check' }, titlePage, ' Title page with word count'),
    h('label', { class: 'field' }, h('span', null, 'Author name'), author),
    summary, warning,
    h('div', { class: 'dialog-actions' }, h('button', { type: 'submit' }, 'Compile')));
  });
}
