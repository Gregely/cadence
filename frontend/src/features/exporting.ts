import type { App, Feature } from '../app';
import { h } from '../lib/dom';
import { panel } from '../ui/dialogs';

/** Trigger a same-origin download; the server names the file. */
export function download(url: string): void {
  const a = h('a', { href: url, download: '', hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function chooseFormat(title: string, base: string): void {
  panel(title, (close) => h('div', { class: 'export-choices' },
    h('p', { class: 'quiet-text' }, 'Choose a format. The file is made on your Cadence server and downloaded here.'),
    h('div', { class: 'row-actions' },
      ...[['md', 'Markdown (.md)'], ['html', 'Web page (.html)'], ['docx', 'Word (.docx)']].map(([fmt, label]) =>
        h('button', { type: 'button', onclick: () => { close(); download(`${base}?format=${fmt}`); } }, label)))));
}

export const exportFeature: Feature = {
  documentMenu(app: App) {
    if (!app.doc || !app.kind.exportable || app.kind.encrypted) return [];
    const id = app.doc.id;
    return [{ label: 'Export…', run: () => { void app.saver.flush().then(() => chooseFormat('Export', `/api/documents/${id}/export`)); } }];
  },
  settingsMenu() {
    return [{ label: 'Export everything (backup .zip)', run: () => download('/api/export/full') }];
  },
};
