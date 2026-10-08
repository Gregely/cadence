import { api } from '../api';
import type { App } from '../app';
import { clear, h } from '../lib/dom';
import { store } from '../lib/storage';
import { formatCount } from '../lib/text';
import type { FolderNode } from '../lib/tree';
import type { SaveState } from '../saver';
import type { DocSummary, KindDef } from '../types';
import { docLabel } from '../ui/sidebar';
import { DocPane } from './docpane';

const SEVERITY: SaveState[] = ['saved', 'unsaved', 'saving', 'offline', 'error'];

/** Rough height of a document's text before it is mounted, so scrolling stays steady. */
function estimateHeight(words: number): number {
  return Math.max(40, Math.round(words * 3.2));
}

export interface LastView {
  folder: number;
  doc: number | null;
}

export function rememberView(view: LastView | null): void {
  if (view) store.set('cadence.lastView', JSON.stringify(view));
  else store.remove('cadence.lastView');
}

export function lastView(): LastView | null {
  return store.json<LastView | null>('cadence.lastView', null);
}

/**
 * Every document inside a folder, recursively, in library order. Each
 * document is its own small editor (a DocPane) with its own autosave;
 * editors are created only as their section scrolls near the screen, so a
 * folder of a hundred scenes opens as fast as one.
 */
export class CombinedView {
  readonly el: HTMLElement;
  readonly panes = new Map<number, DocPane>();
  active: DocPane | null = null;
  private observer: IntersectionObserver | null = null;
  private sections = new Map<number, HTMLElement>();
  private wordTimer = 0;
  private openTimer = 0;

  constructor(
    readonly app: App,
    readonly kind: KindDef,
    readonly folder: FolderNode,
    private scroller: HTMLElement,
  ) {
    this.el = h('div', { class: `combined kind-${kind.id}`, role: 'region', 'aria-label': `${folder.folder.name}, all documents` });
  }

  /** Build the view; mount and focus one document if asked. */
  async open(focusDoc: number | null): Promise<void> {
    clear(this.el);
    this.el.appendChild(h('h1', { class: 'combined-title' }, this.folder.folder.name));
    const body = h('div', { class: 'combined-body' });
    this.renderFolder(body, this.folder, 0);
    if (!this.sections.size) {
      body.appendChild(h('p', { class: 'quiet-text combined-empty' }, `Nothing in this ${this.kind.folder_label.toLowerCase()} yet.`));
    }
    this.el.appendChild(body);
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = Number((entry.target as HTMLElement).dataset.doc);
        this.observer?.unobserve(entry.target);
        void this.panes.get(id)?.mount();
      }
    }, { root: this.scroller, rootMargin: '800px 0px' });
    for (const section of this.sections.values()) this.observer.observe(section);
    this.updateWords();
    if (focusDoc !== null && this.panes.has(focusDoc)) await this.focusDoc(focusDoc, 'cursor');
  }

  /** Subfolders first, then documents: the same order as the library. */
  protected renderFolder(parent: HTMLElement, node: FolderNode, depth: number): void {
    for (const sub of node.folders) {
      const level = Math.min(4, depth + 2);
      parent.appendChild(h(`h${level}` as 'h2', { class: 'folder-heading', dataset: { folder: String(sub.id) } },
        h('button', { type: 'button', class: 'linkish', title: `Open ${sub.folder.name} on its own`, onclick: () => void this.app.openFolder(sub.id) }, sub.folder.name)));
      this.renderFolder(parent, sub, depth + 1);
    }
    for (const d of node.docs) parent.appendChild(this.section(d.doc));
  }

  protected section(doc: DocSummary): HTMLElement {
    const bodyEl = h('div', { class: 'doc-body', style: `min-height:${estimateHeight(doc.words ?? 0)}px` });
    const section = h('section', { class: 'combined-doc', dataset: { doc: String(doc.id) } },
      h('div', { class: 'doc-heading' },
        h('button', { type: 'button', class: 'linkish', title: 'Open on its own', onclick: () => void this.app.openDocument(doc.id) },
          docLabel(this.kind, doc))),
      bodyEl);
    const pane = new DocPane({
      app: this.app,
      kind: this.kind,
      scroller: this.scroller,
      onFocus: (p) => this.onFocus(p),
      onChange: () => this.scheduleWords(),
      onState: () => this.showState(),
      onSaved: (p, saved) => {
        this.app.sidebar.patchDoc({ ...p.summary, ...saved });
        this.scheduleWords();
      },
    }, doc, bodyEl);
    this.panes.set(doc.id, pane);
    this.sections.set(doc.id, section);
    return section;
  }

  /** Mount (if needed), scroll to and focus a document. */
  async focusDoc(id: number, where: 'start' | 'end' | 'cursor' = 'cursor'): Promise<void> {
    const pane = this.panes.get(id);
    const section = this.sections.get(id);
    if (!pane || !section) return;
    section.scrollIntoView({ block: 'start' });
    await pane.mount(where);
    this.onFocus(pane);
  }

  private onFocus(pane: DocPane): void {
    if (this.active === pane) return;
    this.active = pane;
    for (const s of this.sections.values()) s.classList.toggle('active', s === this.sections.get(pane.id));
    this.app.sidebar.setCurrent(pane.id);
    rememberView({ folder: this.folder.id, doc: pane.id });
    // Mark it as the last-open document (quietly, once focus settles).
    window.clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => void api.openDocument(pane.id).catch(() => undefined), 600);
    this.app.onViewFocus(pane);
  }

  private scheduleWords(): void {
    window.clearTimeout(this.wordTimer);
    this.wordTimer = window.setTimeout(() => this.updateWords(), 300);
  }

  /** Total words of the documents in the flow. */
  words(): number {
    let n = 0;
    for (const pane of this.panes.values()) if (this.inFlow(pane.summary)) n += pane.words();
    return n;
  }

  protected inFlow(_doc: DocSummary): boolean {
    return true;
  }

  updateWords(): void {
    this.app.setWordLabel(`${formatCount(this.words())} words`);
  }

  private showState(): void {
    let worst: SaveState = 'saved';
    for (const p of this.panes.values()) if (SEVERITY.indexOf(p.state) > SEVERITY.indexOf(worst)) worst = p.state;
    this.app.showSaveState(worst);
  }

  async flush(keepalive = false): Promise<void> {
    await Promise.all([...this.panes.values()].map((p) => p.flush(keepalive)));
  }

  /** Save everything and remove every editor. */
  async close(): Promise<void> {
    window.clearTimeout(this.wordTimer);
    window.clearTimeout(this.openTimer);
    this.observer?.disconnect();
    await this.flush();
    for (const p of this.panes.values()) p.destroy();
    this.panes.clear();
    this.sections.clear();
    this.el.remove();
  }
}
