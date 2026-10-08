import { api } from '../api';
import type { App } from '../app';
import { clear, h } from '../lib/dom';
import { store } from '../lib/storage';
import { inManuscript, isStub, roleLabel } from '../lib/roles';
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
  /** Documents whose editor is created when they scroll near. */
  private lazy = new Set<number>();
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
    for (const id of this.lazy) this.observer.observe(this.sections.get(id)!);
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
    // Manuscript documents make the flow; the others (fiction: misc notes)
    // wait in a collapsed strip at the end of their folder.
    const flow = node.docs.filter((d) => inManuscript(this.kind, d.doc));
    const notes = node.docs.filter((d) => !inManuscript(this.kind, d.doc));
    flow.forEach((d, i) => {
      if (i > 0 && this.kind.roles.length) parent.appendChild(h('div', { class: 'scene-break', role: 'separator', 'aria-label': 'Scene break' }, '#'));
      parent.appendChild(this.section(d.doc));
    });
    if (notes.length) parent.appendChild(this.notesStrip(notes.map((n) => n.doc)));
  }

  private notesStrip(docs: DocSummary[]): HTMLElement {
    const label = roleLabel(this.kind, docs[0]!.role) || 'Notes';
    return h('details', { class: 'notes-strip' },
      h('summary', null, `${label}s · ${docs.length}`),
      h('ul', null, docs.map((d) => h('li', null,
        h('button', { type: 'button', class: 'linkish', title: 'Open on its own', onclick: () => void this.app.openDocument(d.id) }, docLabel(this.kind, d)),
        ...(this.app.noteActions?.(d) ?? [])))));
  }

  /** A scene with no text: a placeholder showing its synopsis, so gaps show. */
  private stub(doc: DocSummary, bodyEl: HTMLElement, pane: DocPane): HTMLElement {
    const open = () => {
      stub.remove();
      bodyEl.hidden = false;
      void pane.mount('start').then(() => this.onFocus(pane));
    };
    const stub = h('div', {
      class: 'stub-block', role: 'button', tabindex: '0', title: 'Start writing this scene',
      onclick: open,
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    },
    h('span', { class: 'stub-mark' }, 'Not written yet'),
    h('span', { class: 'stub-text' }, doc.synopsis || 'No synopsis. Click to write.'));
    bodyEl.hidden = true;
    return stub;
  }

  protected section(doc: DocSummary): HTMLElement {
    const stubbed = this.kind.roles.length > 0 && isStub(this.kind, doc);
    const bodyEl = h('div', { class: 'doc-body', style: stubbed ? '' : `min-height:${estimateHeight(doc.words ?? 0)}px` });
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
    if (stubbed) {
      section.classList.add('is-stub');
      section.insertBefore(this.stub(doc, bodyEl, pane), bodyEl);
    } else this.lazy.add(doc.id);
    if (this.kind.tools.next_document && inManuscript(this.kind, doc)) {
      section.appendChild(h('button', {
        type: 'button', class: 'quiet next-doc', title: `New ${this.kind.item_label.toLowerCase()} below (Ctrl+Shift+Enter)`,
        onclick: () => void this.app.nextDocument(doc.id),
      }, `+ Next ${this.kind.item_label.toLowerCase()}`));
    }
    return section;
  }

  /** Show a document's new synopsis on its stub (after an inspector edit). */
  updateSummary(doc: DocSummary): void {
    const pane = this.panes.get(doc.id);
    if (pane) pane.summary = { ...pane.summary, ...doc };
    const text = this.sections.get(doc.id)?.querySelector('.stub-text');
    if (text) text.textContent = doc.synopsis || 'No synopsis. Click to write.';
  }

  /** Mount (if needed), scroll to and focus a document. */
  async focusDoc(id: number, where: 'start' | 'end' | 'cursor' = 'cursor'): Promise<void> {
    const pane = this.panes.get(id);
    const section = this.sections.get(id);
    if (!pane || !section) return;
    section.querySelector('.stub-block')?.remove();
    section.querySelector<HTMLElement>('.doc-body')!.hidden = false;
    section.scrollIntoView({ block: 'start' });
    await pane.mount(where);
    this.onFocus(pane);
  }

  private onFocus(pane: DocPane): void {
    if (this.active === pane) return;
    this.active = pane;
    for (const s of this.sections.values()) s.classList.toggle('active', s === this.sections.get(pane.id));
    this.app.sidebar.setCurrent(pane.id);
    this.updateWords();
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

  protected inFlow(doc: DocSummary): boolean {
    return inManuscript(this.kind, doc);
  }

  updateWords(): void {
    this.app.setWordLabel(`${formatCount(this.words())} words`);
    const active = this.active;
    this.app.renderTarget(active ? active.words() : 0, active?.summary.word_target ?? null);
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
