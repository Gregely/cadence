import type { JSONContent } from '@tiptap/core';

import { ApiError, api } from './api';
import { DocEditor } from './editor/doc-editor';
import { CombinedView, lastView, rememberView } from './views/combined';
import type { DocPane } from './views/docpane';
import { hasExtension } from './editor/extensions';
import { longDate } from './lib/dates';
import { clear, h, isTypingTarget } from './lib/dom';
import { clearPending, loadPending } from './lib/pending';
import { store } from './lib/storage';
import { formatCount, smarten } from './lib/text';
import { type FolderNode, type Move, type Node, folderPath } from './lib/tree';
import { Saver, type SaveState } from './saver';
import { Sessions } from './session';
import { type Settings, applyTheme, onSettings, settings, updateSettings } from './settings';
import type { DocFull, DocSummary, KindDef, Tree } from './types';
import { chooseFormat } from './features/exporting';
import { openCapture } from './ui/capture';
import { ask, confirmAction, dialogOpen, inform, menu, type MenuItem, panel, toast } from './ui/dialogs';
import { quickOpen } from './ui/quickopen';
import { inboxScreen, type ScreenHost, trashScreen } from './ui/screens';
import { Sidebar, type SidebarHost, docLabel } from './ui/sidebar';
import { streamScreen } from './ui/stream';

/** Turns stored content into editor JSON and back. Encrypted kinds plug in here. */
export interface Codec {
  decode(raw: string): Promise<JSONContent>;
  encode(doc: JSONContent): Promise<string>;
}

export const plainCodec: Codec = {
  decode: async (raw) => JSON.parse(raw) as JSONContent,
  encode: async (doc) => JSON.stringify(doc),
};

/** Extra behaviour added by later stages (diary vault, snapshots, export, research). */
export interface Feature {
  /** Called before a kind is shown; return false to stop (e.g. a locked vault). */
  beforeKind?(app: App, kind: KindDef, docId?: number): Promise<boolean>;
  codec?(app: App, kind: KindDef): Codec | null;
  topbar?(app: App): HTMLElement[];
  documentMenu?(app: App): (MenuItem | null)[];
  settingsMenu?(app: App): (MenuItem | null)[];
  onDocument?(app: App): void;
  onKey?(app: App, e: KeyboardEvent): boolean;
  sidePane?(app: App): void;
  /** Called on every editor change. */
  onEdit?(app: App): void;
}

const MOBILE = '(max-width: 760px)';

export class App implements SidebarHost, ScreenHost {
  kinds: KindDef[] = [];
  kind!: KindDef;
  tree!: Tree;
  doc: DocFull | null = null;
  editor: DocEditor | null = null;
  /** The combined folder view, when a folder is open instead of one document. */
  view: CombinedView | null = null;
  readonly features: Feature[] = [];
  /** Every document editor besides the main one (combined view, split view). */
  readonly panes = new Set<DocPane>();

  readonly el: HTMLElement;
  readonly sidebar: Sidebar;
  readonly main: HTMLElement;
  readonly topbar: HTMLElement;
  readonly toolSlot: HTMLElement;
  readonly sidePaneSlot: HTMLElement;
  private crumbs: HTMLElement;
  private statusSelect: HTMLSelectElement;
  private reentry: HTMLElement;
  private scroller: HTMLElement;
  private page: HTMLElement;
  private titleInput: HTMLInputElement;
  private dateTitle: HTMLElement;
  private mount: HTMLElement;
  private screenHolder: HTMLElement;
  private saveLabel: HTMLElement;
  private wordLabel: HTMLElement;
  private timerLabel: HTMLElement;
  private promptBar: HTMLElement;
  /** Shown only in draft mode, beside the word count. */
  readonly draftControls: HTMLElement;
  readonly saver: Saver;
  readonly sessions: Sessions;
  private opening = 0;
  private titleDirty = false;
  private lastCheckpointAt = 0;
  private cursorTimer = 0;
  private wordTimer = 0;

  constructor(root: HTMLElement) {
    this.sidebar = new Sidebar(this);
    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Location' });
    this.statusSelect = h('select', { class: 'status-select', 'aria-label': 'Status', hidden: true }) as HTMLSelectElement;
    this.statusSelect.addEventListener('change', () => void this.setStatus(this.statusSelect.value));
    this.toolSlot = h('span', { class: 'tool-slot' });
    const moreButton = h('button', {
      type: 'button', class: 'icon', title: 'Document menu', 'aria-label': 'Document menu', 'aria-haspopup': 'menu',
      onclick: (e: Event) => this.documentMenu(e.currentTarget as HTMLElement),
    }, '⋯');
    this.topbar = h('header', { class: 'topbar' },
      h('button', {
        type: 'button', class: 'icon toggle-sidebar', title: 'Library (Ctrl+\\)', 'aria-label': 'Show or hide library',
        onclick: () => this.toggleSidebar(),
      }, '☰'),
      this.crumbs,
      h('span', { class: 'spacer' }),
      this.statusSelect,
      this.toolSlot,
      h('button', { type: 'button', class: 'quiet focus-toggle', title: 'Focus mode (Ctrl+Shift+F)', onclick: () => this.toggleFocus() }, 'Focus'),
      moreButton,
    );
    this.reentry = h('div', { class: 'reentry', hidden: true, role: 'note' });
    this.titleInput = h('input', {
      class: 'doc-title', type: 'text', 'aria-label': 'Title', autocomplete: 'off', maxlength: '300',
    }) as HTMLInputElement;
    this.titleInput.addEventListener('input', () => this.onTitleInput());
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && this.titleInput.selectionStart === this.titleInput.value.length)) {
        e.preventDefault();
        this.editor?.focusAt('start');
      }
    });
    this.dateTitle = h('div', { class: 'doc-date', hidden: true });
    this.mount = h('div', { class: 'editor-mount' });
    this.page = h('article', { class: 'page' }, this.dateTitle, this.titleInput, this.mount);
    this.scroller = h('div', { class: 'writing', tabindex: '-1' }, this.page);
    this.scroller.addEventListener('mousedown', (e) => {
      // Clicking the margins below the text puts the cursor at the end.
      if (e.target === this.scroller || e.target === this.page) {
        e.preventDefault();
        this.editor?.focusAt('end');
      }
    });
    this.screenHolder = h('div', { class: 'screen-holder', hidden: true });
    this.saveLabel = h('span', { class: 'save-state', role: 'status', 'aria-live': 'polite' });
    this.wordLabel = h('button', { type: 'button', class: 'word-count quiet', title: 'Hide word count', onclick: () => updateSettings({ wordCount: false }) });
    this.timerLabel = h('span', { class: 'timer' });
    this.draftControls = h('span', { class: 'draft-controls' },
      h('button', {
        type: 'button', class: 'quiet draft-exit', title: 'Leave draft mode (Ctrl+Shift+D)', 'aria-label': 'Leave draft mode',
        onclick: () => this.toggleDraftMode(false),
      }, '×'));
    const status = h('footer', { class: 'statusbar' }, this.saveLabel, h('span', { class: 'spacer' }), this.timerLabel, this.wordLabel, this.draftControls);
    this.promptBar = h('div', { class: 'prompt-bar', hidden: true });
    this.main = h('main', { class: 'main' }, this.topbar, this.reentry, this.scroller, this.screenHolder, status, this.promptBar);
    this.sidePaneSlot = h('div', { class: 'side-pane', hidden: true });
    this.el = h('div', { class: 'layout' }, this.sidebar.el, this.main, this.sidePaneSlot,
      h('div', { class: 'scrim', onclick: () => this.setSidebar(false) }));
    root.appendChild(this.el);

    this.saver = new Saver({
      body: () => this.saveBody(),
      onSaved: (doc) => this.onSaved(doc),
      onConflict: (body) => this.onConflict(body),
      onState: (s, m) => this.showSaveState(s, m),
    });
    this.sessions = new Sessions({
      words: (docId) => (this.doc?.id === docId && this.editor ? this.editor.words() : this.tree?.documents.find((d) => d.id === docId)?.words ?? 0),
      promptNote: (sid, docId, cps) => this.promptReentry(sid, docId, cps),
      onChange: () => this.updateTimer(),
    });

    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void this.saver.flush(true);
        void this.view?.flush(true);
      }
    });
    window.addEventListener('popstate', () => void this.route());
    onSettings((s) => this.applySettings(s));
    window.setInterval(() => this.updateTimer(), 30_000);
    window.matchMedia(MOBILE).addEventListener?.('change', () => this.applySettings(settings()));
  }

  use(feature: Feature): void {
    this.features.push(feature);
  }

  // ------------------------------------------------------------ boot and routing

  async boot(): Promise<void> {
    applyTheme(settings().theme);
    this.applySettings(settings());
    try {
      this.kinds = await api.kinds();
    } catch {
      this.fatal('Cadence cannot reach its server. Check that it is running, then reload.');
      return;
    }
    await this.route();
  }

  private fatal(message: string): void {
    clear(this.el);
    this.el.appendChild(h('div', { class: 'fatal' }, h('p', null, message)));
  }

  private async route(): Promise<void> {
    const path = window.location.pathname;
    const m = path.match(/^\/d\/(\d+)/);
    if (m) {
      await this.openDocument(Number(m[1]), { push: false });
      return;
    }
    const f = path.match(/^\/f\/(\d+)/);
    if (f) {
      const id = Number(f[1]);
      const lv = lastView();
      if (!(await this.openFolder(id, { push: false, focusDoc: lv?.folder === id ? lv.doc : null }))) await this.openLast();
      return;
    }
    if (path === '/inbox' || path === '/trash' || path.startsWith('/stream/')) {
      if (!this.kind) await this.openLast();
      if (path === '/inbox') this.openInbox(false);
      else if (path === '/trash') this.openTrash(false);
      else {
        const k = this.kinds.find((x) => x.id === path.split('/')[2]);
        if (k && k.id !== this.kind.id) await this.switchKind(k.id);
        this.openStream(false);
      }
      return;
    }
    await this.openLast();
  }

  /** Open straight to the last document, wherever it was. Never a dashboard. */
  private async openLast(): Promise<void> {
    const state = await api.state().catch(() => ({ last_document: null }));
    const lv = lastView();
    if (state.last_document && lv && lv.doc === state.last_document.id) {
      // We were writing this document inside its folder's combined view.
      if (await this.openFolder(lv.folder, { push: false, replace: true, focusDoc: lv.doc })) return;
    }
    if (state.last_document) {
      const ok = await this.openDocument(state.last_document.id, { push: false, replace: true });
      // Opened, or stopped at a lock screen: either way, stay there.
      if (ok || !this.screenHolder.hidden) return;
    }
    await this.switchKind(this.kinds[0]!.id);
  }

  // ------------------------------------------------------------ kinds

  kindById(id: string): KindDef | undefined {
    return this.kinds.find((k) => k.id === id);
  }

  get currentKind(): KindDef {
    return this.kind;
  }

  codec(kind: KindDef = this.kind): Codec {
    for (const f of this.features) {
      const c = f.codec?.(this, kind);
      if (c) return c;
    }
    return plainCodec;
  }

  private async prepareKind(kind: KindDef, docId?: number): Promise<boolean> {
    for (const f of this.features) {
      if (f.beforeKind && !(await f.beforeKind(this, kind, docId))) return false;
    }
    return true;
  }

  /**
   * Show a kind with nothing open and a screen (the diary lock) in place of
   * the editor. Any decrypted text in the editor is destroyed.
   */
  async showLocked(kind: KindDef, screen: HTMLElement): Promise<void> {
    await this.leaveDocument();
    this.opening++;
    this.editor?.destroy();
    this.editor = null;
    clear(this.mount);
    this.doc = null;
    this.saver.unbind();
    this.applyKind(kind);
    await this.refreshTree();
    this.titleInput.value = '';
    this.fillChrome();
    this.sidebar.setCurrent(null);
    document.title = `${kind.label} · Cadence`;
    this.showScreen(screen, window.location.pathname, false);
  }

  applyKind(kind: KindDef): void {
    this.kind = kind;
    this.el.dataset.kind = kind.id;
    const style = this.el.style;
    for (let i = style.length - 1; i >= 0; i--) {
      const prop = style[i]!;
      if (prop.startsWith('--k-')) style.removeProperty(prop);
    }
    for (const [key, value] of Object.entries(kind.theme)) {
      style.setProperty(`--k-${key.replace(/_/g, '-')}`, value);
    }
    this.statusSelect.hidden = !kind.tools.status || kind.tools.inspector;
    this.el.classList.toggle('draft-mode', kind.tools.draft_mode && store.get(`cadence.draftMode.${kind.id}`) === '1');
    clear(this.statusSelect);
    this.statusSelect.appendChild(h('option', { value: '' }, 'No status'));
    for (const s of kind.statuses) this.statusSelect.appendChild(h('option', { value: s }, s));
    this.renderTools();
  }

  renderTools(): void {
    clear(this.toolSlot);
    for (const f of this.features) for (const el of f.topbar?.(this) ?? []) this.toolSlot.appendChild(el);
  }

  async switchKind(id: string, opts: { openLast?: boolean } = {}): Promise<boolean> {
    const kind = this.kindById(id);
    if (!kind) return false;
    if (!(await this.prepareKind(kind))) return false;
    await this.leaveDocument();
    this.applyKind(kind);
    await this.refreshTree();
    this.closeScreen();
    const target = opts.openLast === false ? null : this.tree.last_document_id;
    if (target !== null) {
      const ok = await this.openDocument(target, { push: true });
      if (ok) return true;
    }
    this.startDraft();
    return true;
  }

  openKindSwitcher(anchor?: HTMLElement): void {
    const items: MenuItem[] = this.kinds.map((k, i) => ({
      label: k.label,
      hint: i < 9 ? `Alt+${i + 1}` : undefined,
      checked: k.id === this.kind?.id,
      run: () => void this.switchKind(k.id),
    }));
    menu(anchor ?? this.sidebar.el.querySelector<HTMLElement>('.kind-button') ?? this.topbar, items);
  }

  async refreshTree(): Promise<void> {
    this.tree = await api.tree(this.kind.id);
    this.sidebar.setData(this.kind, this.tree, this.doc?.id ?? null);
  }

  // ------------------------------------------------------------ documents

  /** Open a document (switching kind if needed). Returns false if it could not be opened. */
  async openDocument(id: number, opts: { push?: boolean; replace?: boolean; focus?: boolean } = {}): Promise<boolean> {
    if (this.doc?.id === id && this.editor) {
      this.closeScreen();
      if (window.matchMedia(MOBILE).matches) this.setSidebar(false);
      this.editor.focus();
      return true;
    }
    const ticket = ++this.opening;
    let doc: DocFull;
    try {
      doc = await api.getDocument(id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return false;
      toast(err instanceof Error ? err.message : 'Could not open');
      return false;
    }
    const kind = this.kindById(doc.kind);
    if (!kind) return false;
    if (!(await this.prepareKind(kind, id))) return false;
    if (ticket !== this.opening) return false;
    await this.leaveDocument();
    try {
      doc = await api.openDocument(id);
    } catch {
      return false;
    }
    if (ticket !== this.opening) return false;
    if (!this.kind || kind.id !== this.kind.id) {
      this.applyKind(kind);
      await this.refreshTree();
    }
    let content: JSONContent;
    try {
      content = await this.codec(kind).decode(doc.content_json);
    } catch {
      toast('This document could not be read.');
      return false;
    }
    if (ticket !== this.opening) return false;

    // Unsaved edits left on this device from a dropped connection?
    const pending = loadPending(doc.id);
    let restoredPending = false;
    if (pending) {
      const body = pending.body as { content_json?: string; title?: string };
      if (pending.base === doc.updated_at && body.content_json) {
        try {
          content = await this.codec(kind).decode(body.content_json);
          if (typeof body.title === 'string') doc.title = body.title;
          restoredPending = true;
        } catch {
          clearPending(doc.id);
        }
      } else if (body.content_json) {
        await api.createSnapshot(doc.id, 'Unsaved edits from this device', body.content_json).catch(() => undefined);
        clearPending(doc.id);
        toast('Edits from this device that never reached the server were kept as a snapshot.');
      }
    }

    this.doc = doc;
    this.closeScreen();
    const cursor = this.storedCursor(doc);
    this.createEditor(content, cursor);
    this.saver.bind(doc.id, doc.updated_at);
    if (restoredPending) {
      this.saver.touch();
      toast('Restored edits that had not reached the server yet.');
    }
    this.fillChrome();
    this.sidebar.setCurrent(doc.id);
    rememberView(null);
    const url = `/d/${doc.id}`;
    if (opts.replace) history.replaceState(null, '', url);
    else if (opts.push !== false && window.location.pathname !== url) history.pushState(null, '', url);
    if (window.matchMedia(MOBILE).matches) this.setSidebar(false);
    if (opts.focus !== false) this.editor?.focus();
    for (const f of this.features) f.onDocument?.(this);
    return true;
  }

  // ------------------------------------------------------------ combined folder view

  /** Open every document in a folder at once (kinds with tools.combined_view). */
  async openFolder(folderId: number, opts: { push?: boolean; replace?: boolean; focusDoc?: number | null } = {}): Promise<boolean> {
    let tree = this.tree;
    let kind = this.kind;
    let folder = tree && this.sidebar.root?.byFolder.get(folderId);
    if (!folder) {
      // Not in the current kind: find which kind it belongs to.
      for (const k of this.kinds.filter((x) => x.tools.combined_view)) {
        const t = await api.tree(k.id);
        if (t.folders.some((x) => x.id === folderId)) {
          if (!(await this.prepareKind(k))) return false;
          await this.leaveDocument();
          this.applyKind(k);
          this.tree = t;
          this.sidebar.setData(k, t, null);
          kind = k;
          tree = t;
          folder = this.sidebar.root.byFolder.get(folderId);
          break;
        }
      }
    }
    if (!folder || !kind.tools.combined_view) return false;
    const ticket = ++this.opening;
    await this.leaveDocument();
    if (ticket !== this.opening) return false;
    this.editor?.destroy();
    this.editor = null;
    clear(this.mount);
    this.doc = null;
    this.saver.unbind();
    this.closeScreen();
    this.page.hidden = true;
    this.reentry.hidden = true;
    const view = new CombinedView(this, kind, folder, this.scroller);
    this.view = view;
    this.scroller.appendChild(view.el);
    this.scroller.scrollTop = 0;
    this.fillViewChrome();
    this.sidebar.setCurrent(null);
    this.sidebar.setCurrentFolder(folderId);
    const url = `/f/${folderId}`;
    if (opts.replace) history.replaceState(null, '', url);
    else if (opts.push !== false && window.location.pathname !== url) history.pushState(null, '', url);
    if (window.matchMedia(MOBILE).matches) this.setSidebar(false);
    rememberView({ folder: folderId, doc: opts.focusDoc ?? null });
    await view.open(opts.focusDoc ?? null);
    for (const f of this.features) f.onDocument?.(this);
    return true;
  }

  private async closeView(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.view = null;
    await view.close();
    this.page.hidden = false;
    this.sidebar.setCurrentFolder(null);
  }

  private fillViewChrome(): void {
    const view = this.view;
    if (!view) return;
    this.saveLabel.textContent = '';
    this.saveLabel.dataset.state = '';
    this.statusSelect.hidden = true;
    clear(this.crumbs);
    this.crumbs.classList.add('view-crumbs');
    this.crumbs.appendChild(h('button', { type: 'button', class: 'crumb', onclick: () => this.openKindSwitcher() }, this.kind.label));
    for (const f of folderPath(this.sidebar.root, view.folder.id)) {
      this.crumbs.appendChild(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
      this.crumbs.appendChild(h('button', { type: 'button', class: 'crumb', onclick: () => void this.openFolder(f.id) }, f.folder.name));
    }
    document.title = `${view.folder.folder.name} · Cadence`;
  }

  /** A document inside the combined view got the cursor. */
  onViewFocus(_pane: DocPane): void {
    for (const f of this.features) f.onDocument?.(this);
  }

  /** The document being written: the open one, or the focused one in a folder view. */
  activeDocId(): number | null {
    return this.view?.active?.id ?? this.doc?.id ?? null;
  }

  setWordLabel(text: string | null): void {
    const show = settings().wordCount && this.kind?.tools.word_count && text !== null;
    this.wordLabel.hidden = !show;
    if (show) this.wordLabel.textContent = text;
  }

  /** After a metadata change: every editor of that document saves on top of the new version. */
  rebaseDoc(docId: number, updatedAt: string): void {
    if (this.doc?.id === docId) {
      this.saver.rebase(updatedAt);
      this.doc.updated_at = updatedAt;
    }
    for (const p of this.panes) if (p.id === docId) p.rebase(updatedAt);
  }

  /** Save every editor showing this document. */
  async flushDoc(docId: number): Promise<void> {
    if (this.doc?.id === docId) await this.saver.flush();
    await Promise.all([...this.panes].filter((p) => p.id === docId).map((p) => p.flush()));
  }

  /** Reload the open document from the server (after a restore, say). */
  async reloadDocument(): Promise<void> {
    if (!this.doc) return;
    const fresh = await api.getDocument(this.doc.id);
    const json = await this.codec().decode(fresh.content_json);
    this.doc = { ...this.doc, ...fresh };
    this.createEditor(json, this.editor?.cursor() ?? null);
    this.saver.bind(fresh.id, fresh.updated_at);
    this.fillChrome();
    await this.refreshTree();
    this.sidebar.setCurrent(fresh.id);
  }

  private storedCursor(doc: DocFull): number | null {
    const local = Number(store.get(`cadence.cursor.${doc.id}`));
    const remote = typeof doc.meta?.cursor === 'number' ? (doc.meta.cursor as number) : null;
    return remote ?? (Number.isFinite(local) && local > 0 ? local : null);
  }

  private createEditor(content: JSONContent | null, cursor: number | null): void {
    this.editor?.destroy();
    clear(this.mount);
    this.editor = new DocEditor({
      kind: this.kind,
      mount: this.mount,
      scroller: this.scroller,
      content,
      cursor,
      spellcheck: !this.kind.encrypted,
      typewriter: () => settings().typewriter,
      onChange: () => this.onEdit(),
      onSelection: () => this.onSelection(),
      askLink: (current) => ask({ title: 'Link address', value: current, placeholder: 'https://', ok: 'Set link', hint: 'Leave empty to remove the link.' }),
    });
    this.updateWords();
  }

  /** A blank page for a kind with nothing open: the document is created on the first keystroke. */
  private startDraft(): void {
    this.doc = null;
    this.saver.unbind();
    this.saveLabel.textContent = '';
    this.saveLabel.dataset.state = '';
    this.createEditor(null, null);
    this.fillChrome();
    this.sidebar.setCurrent(null);
    if (window.location.pathname.startsWith('/d/')) history.pushState(null, '', '/');
    this.editor?.focus();
  }

  private creating: Promise<void> | null = null;

  private async createFromDraft(): Promise<void> {
    if (this.creating || this.doc) return;
    const kind = this.kind;
    this.creating = (async () => {
      try {
        const body: Record<string, unknown> = {
          kind: kind.id,
          content_json: await this.codec(kind).encode(this.editor!.getJSON()),
        };
        if (kind.title_mode !== 'generated') body.title = this.titleInput.value;
        const doc = await api.createDocument(body);
        if (this.kind.id !== kind.id) return;
        this.doc = doc;
        this.saver.bind(doc.id, doc.updated_at);
        await api.openDocument(doc.id).catch(() => undefined);
        history.replaceState(null, '', `/d/${doc.id}`);
        await this.refreshTree();
        this.sidebar.setCurrent(doc.id);
        this.fillChrome(false);
        // Anything typed while creating gets saved normally.
        this.saver.touch();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not create the document');
      } finally {
        this.creating = null;
      }
    })();
    await this.creating;
  }

  async newDocument(folderId: number | null = null): Promise<void> {
    if (!this.kind) return;
    if (!(await this.prepareKind(this.kind))) return;
    await this.leaveDocument();
    const body: Record<string, unknown> = { kind: this.kind.id, folder_id: this.kind.folders_enabled ? folderId : null };
    body.content_json = await this.codec().encode({ type: 'doc', content: [{ type: 'paragraph' }] });
    const doc = await api.createDocument(body);
    await this.refreshTree();
    await this.openDocument(doc.id, { focus: false });
    if (this.kind.title_mode === 'required') this.titleInput.focus();
    else this.editor?.focus();
  }

  /** Flush saves and end the session before leaving the current document. */
  async leaveDocument(): Promise<void> {
    window.clearTimeout(this.cursorTimer);
    if (this.creating) await this.creating;
    if (this.view) await this.closeView();
    if (this.doc && this.editor) {
      this.rememberCursor();
      await this.saver.flush();
      await this.sessions.end('switch');
    }
  }

  private rememberCursor(): void {
    if (!this.doc || !this.editor) return;
    const pos = this.editor.cursor();
    store.set(`cadence.cursor.${this.doc.id}`, String(pos));
    if (this.doc.meta?.cursor !== pos) {
      this.doc.meta = { ...this.doc.meta, cursor: pos };
      void api.updateDocument(this.doc.id, { meta: { cursor: pos } }).catch(() => undefined);
    }
  }

  private async saveBody(): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      content_json: await this.codec().encode(this.editor!.getJSON()),
    };
    if (this.kind.title_mode !== 'generated') body.title = this.titleInput.value;
    return body;
  }

  private onSaved(doc: DocFull): void {
    if (!this.doc || doc.id !== this.doc.id) return;
    this.doc = { ...this.doc, ...doc };
    this.sidebar.patchDoc(doc);
    if (this.titleDirty) {
      this.titleDirty = false;
      this.fillCrumbs();
    }
  }

  private async onConflict(body: Record<string, unknown>): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const content = body.content_json as string;
    await api.createSnapshot(doc.id, 'Edits from this device (changed elsewhere)', content).catch(() => undefined);
    const fresh = await api.getDocument(doc.id);
    this.doc = { ...doc, ...fresh };
    const json = await this.codec().decode(fresh.content_json);
    const cursor = this.editor?.cursor() ?? null;
    this.createEditor(json, cursor);
    this.titleInput.value = fresh.title;
    this.saver.bind(fresh.id, fresh.updated_at);
    void inform('Changed on another device',
      'This document was edited somewhere else at the same time. You are now seeing that version; ' +
      'what you had here was saved as a snapshot, so nothing is lost.');
  }

  private onEdit(): void {
    if (!this.editor) return;
    if (!this.doc) {
      void this.createFromDraft();
    } else {
      this.saver.touch();
      this.sessions.edited(this.doc.id, this.kind);
    }
    // Counting words walks the whole document; do it when typing pauses.
    window.clearTimeout(this.wordTimer);
    this.wordTimer = window.setTimeout(() => this.updateWords(), 300);
    if (this.kind.tools.reentry !== 'prominent') this.reentry.hidden = true;
    for (const f of this.features) f.onEdit?.(this);
  }

  private onSelection(): void {
    window.clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => {
      if (this.doc && this.editor) store.set(`cadence.cursor.${this.doc.id}`, String(this.editor.cursor()));
    }, 1000);
  }

  private onTitleInput(): void {
    const el = this.titleInput;
    const before = el.value;
    const after = smarten(before);
    if (after !== before) {
      const pos = el.selectionStart ?? after.length;
      el.value = after;
      el.setSelectionRange(pos, pos);
    }
    this.titleDirty = true;
    if (!this.doc) void this.createFromDraft();
    else {
      this.saver.touch();
      this.sessions.edited(this.doc.id, this.kind);
    }
  }

  async setStatus(status: string): Promise<void> {
    if (!this.doc) return;
    const doc = await api.updateDocument(this.doc.id, { status: status || null });
    this.saver.rebase(doc.updated_at);
    this.doc = { ...this.doc, ...doc };
    this.sidebar.patchDoc(doc);
    await this.refreshTree();
  }

  // ------------------------------------------------------------ chrome

  private fillChrome(resetTitle = true): void {
    const k = this.kind;
    const d = this.doc;
    if (resetTitle) this.titleInput.value = d?.title ?? '';
    this.titleInput.hidden = k.title_mode === 'generated';
    this.titleInput.placeholder = k.title_mode === 'optional' ? 'Title (optional)' : 'Untitled';
    this.dateTitle.hidden = k.title_mode !== 'generated';
    this.dateTitle.textContent = k.title_mode === 'generated' ? longDate(d?.created_at ?? new Date().toISOString()) : '';
    this.statusSelect.value = d?.status ?? '';
    this.statusSelect.disabled = !d;
    this.fillCrumbs();
    this.fillReentry();
    this.updateWords();
    this.updateTimer();
    document.title = d && k.title_mode !== 'generated' && d.title ? `${d.title} · Cadence` : `${k.label} · Cadence`;
  }

  private fillCrumbs(): void {
    clear(this.crumbs);
    this.crumbs.classList.remove('view-crumbs');
    const kindLink = h('button', { type: 'button', class: 'crumb', onclick: () => this.openKindSwitcher() }, this.kind.label);
    this.crumbs.appendChild(kindLink);
    if (!this.doc || !this.sidebar.root) return;
    for (const f of folderPath(this.sidebar.root, this.doc.folder_id)) {
      this.crumbs.appendChild(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'));
      this.crumbs.appendChild(h('span', { class: 'crumb' }, f.folder.name));
    }
  }

  private fillReentry(): void {
    const note = this.doc?.reentry_note;
    const mode = this.kind.tools.reentry;
    clear(this.reentry);
    if (!note || mode === 'off') {
      this.reentry.hidden = true;
      return;
    }
    this.reentry.hidden = false;
    this.reentry.className = `reentry ${mode}`;
    this.reentry.append(
      h('span', { class: 'reentry-label' }, 'Last time: '),
      h('span', { class: 'reentry-text' }, note),
      h('button', { type: 'button', class: 'quiet close', 'aria-label': 'Dismiss', onclick: () => { this.reentry.hidden = true; } }, '×'),
    );
  }

  private updateWords(): void {
    if (this.view) {
      this.view.updateWords();
      return;
    }
    const show = settings().wordCount && this.kind?.tools.word_count && !!this.editor;
    this.wordLabel.hidden = !show;
    if (!show || !this.editor) return;
    const words = this.editor.words();
    const target = this.kind.tools.word_target ? this.doc?.word_target : null;
    this.wordLabel.textContent = target ? `${formatCount(words)} / ${formatCount(target)} words` : `${formatCount(words)} words`;
  }

  showSaveState(state: SaveState, message?: string): void {
    const text: Record<SaveState, string> = {
      saved: 'Saved',
      saving: 'Saving…',
      unsaved: 'Editing',
      offline: 'Offline · kept on this device',
      error: `Not saved${message ? `: ${message}` : ''}`,
    };
    this.saveLabel.textContent = text[state];
    this.saveLabel.dataset.state = state;
  }

  private updateTimer(): void {
    const s = settings();
    const on = s.timer && this.kind?.tools.session_timer && this.sessions.current !== null;
    clear(this.timerLabel);
    if (!on) {
      this.lastCheckpointAt = 0;
      return;
    }
    const mins = this.sessions.elapsedMinutes();
    this.timerLabel.appendChild(document.createTextNode(`${mins} min`));
    if (!this.lastCheckpointAt) this.lastCheckpointAt = Date.now();
    if (Date.now() - this.lastCheckpointAt >= s.timerMinutes * 60_000) {
      const pick = (f: 'flowing' | 'fighting') => {
        void this.sessions.checkpoint(f);
        this.lastCheckpointAt = Date.now();
        this.updateTimer();
      };
      this.timerLabel.append(' · ',
        h('button', { type: 'button', class: 'quiet', onclick: () => pick('flowing') }, 'flowing'), ' or ',
        h('button', { type: 'button', class: 'quiet', onclick: () => pick('fighting') }, 'fighting'), '?');
    }
  }

  /** The one-line re-entry note, asked for when a session ends. */
  private promptReentry(sessionId: number, docId: number, checkpoints: ('flowing' | 'fighting')[]): void {
    const doc = this.tree?.documents.find((d) => d.id === docId);
    const kind = this.kindById(doc?.kind ?? this.kind.id) ?? this.kind;
    if (kind.tools.reentry === 'off') return;
    clear(this.promptBar);
    const input = h('input', {
      type: 'text', maxlength: '280', autocomplete: 'off',
      placeholder: 'Where to pick up next time? (one line)',
      'aria-label': 'Note for next time',
    }) as HTMLInputElement;
    const close = () => {
      this.promptBar.hidden = true;
      clear(this.promptBar);
    };
    const form = h('form', { class: 'prompt-form' },
      h('span', { class: 'prompt-label' }, doc ? `${docLabel(kind, doc)}:` : 'Next time:'),
      input,
      h('button', { type: 'submit' }, 'Save'),
      h('button', { type: 'button', class: 'quiet', onclick: close }, 'Skip'));
    if (checkpoints.length) {
      form.appendChild(h('span', { class: 'prompt-meta' }, checkpoints.join(', ')));
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = smarten(input.value.trim());
      close();
      if (!note) return;
      await api.endSession(sessionId, { reentry_note: note }).catch(() => toast('The note could not be saved.'));
      if (this.doc?.id === docId) {
        this.doc.reentry_note = note;
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        this.editor?.focus();
      }
    });
    this.promptBar.appendChild(form);
    this.promptBar.hidden = false;
    input.focus();
  }

  async endSession(): Promise<void> {
    if (!this.sessions.current) {
      toast('No writing session is running.');
      return;
    }
    await this.saver.flush();
    await this.sessions.end('explicit');
  }

  // ------------------------------------------------------------ layout and settings

  private applySettings(s: Settings): void {
    applyTheme(s.theme);
    const mobile = window.matchMedia(MOBILE).matches;
    const open = mobile ? this.el.classList.contains('sidebar-open') && this.sidebarTouched : (s.sidebar ?? true);
    this.el.classList.toggle('sidebar-open', open);
    this.el.classList.toggle('mobile', mobile);
    this.updateWords();
    this.updateTimer();
  }

  private sidebarTouched = false;

  setSidebar(open: boolean): void {
    this.sidebarTouched = true;
    this.el.classList.toggle('sidebar-open', open);
    if (!window.matchMedia(MOBILE).matches) updateSettings({ sidebar: open });
    if (open) this.sidebar.focus();
  }

  toggleSidebar(): void {
    this.setSidebar(!this.el.classList.contains('sidebar-open'));
  }

  hide(): void {
    this.setSidebar(false);
    this.editor?.focus();
  }

  toggleFocus(on?: boolean): void {
    const next = on ?? !this.el.classList.contains('focus-mode');
    this.el.classList.toggle('focus-mode', next);
    const btn = this.topbar.querySelector('.focus-toggle');
    if (btn) btn.textContent = next ? 'Leave focus' : 'Focus';
    this.editor?.focus();
  }

  /**
   * Draft mode (kinds with tools.draft_mode): only the text, the word count
   * and the next-document button. Remembered per kind on this device.
   */
  toggleDraftMode(on?: boolean): void {
    if (!this.kind?.tools.draft_mode) return;
    const next = on ?? !this.el.classList.contains('draft-mode');
    this.el.classList.toggle('draft-mode', next);
    store.set(`cadence.draftMode.${this.kind.id}`, next ? '1' : '0');
    if (this.view) this.view.active?.editor?.focus();
    else this.editor?.focus();
  }

  // ------------------------------------------------------------ screens

  private showScreen(el: HTMLElement, path: string, push: boolean): void {
    void this.saver.flush();
    clear(this.screenHolder);
    this.screenHolder.appendChild(el);
    this.screenHolder.hidden = false;
    this.scroller.hidden = true;
    this.reentry.hidden = true;
    this.el.classList.add('on-screen');
    if (push && window.location.pathname !== path) history.pushState(null, '', path);
    if (window.matchMedia(MOBILE).matches) this.setSidebar(false);
    el.querySelector<HTMLElement>('button, input')?.focus();
  }

  closeScreen(): void {
    if (this.screenHolder.hidden) return;
    clear(this.screenHolder);
    this.screenHolder.hidden = true;
    this.scroller.hidden = false;
    this.el.classList.remove('on-screen');
    this.fillReentry();
  }

  back(): void {
    this.closeScreen();
    if (this.doc) history.pushState(null, '', `/d/${this.doc.id}`);
    else history.pushState(null, '', '/');
    this.editor?.focus();
  }

  openInbox(push = true): void {
    this.showScreen(inboxScreen(this), '/inbox', push);
  }

  openTrash(push = true): void {
    this.showScreen(trashScreen(this), '/trash', push);
  }

  openStream(push = true): void {
    this.showScreen(streamScreen(this.kind, {
      back: () => this.back(),
      open: (id) => void this.openDocument(id),
      newDocument: () => void this.newDocument(null),
    }), `/stream/${this.kind.id}`, push);
  }

  // ------------------------------------------------------------ pickers

  openQuickOpen(): void {
    quickOpen({
      kind: this.kind,
      docs: this.tree.documents,
      folderPath: (fid) => folderPath(this.sidebar.root, fid).map((f) => f.folder.name).join(' / '),
      onPick: (d) => void this.openDocument(d.id),
    });
  }

  async pickDocument(kind: KindDef, title: string): Promise<DocSummary | null> {
    const tree = kind.id === this.kind.id ? this.tree : await api.tree(kind.id);
    return new Promise((resolve) => {
      let picked = false;
      quickOpen({
        kind,
        docs: tree.documents,
        folderPath: () => '',
        title,
        onPick: (d) => {
          picked = true;
          resolve(d);
        },
      });
      const obs = new MutationObserver(() => {
        if (!document.querySelector('.quick-open')) {
          obs.disconnect();
          if (!picked) resolve(null);
        }
      });
      obs.observe(document.body, { childList: true });
    });
  }

  capture(): void {
    openCapture(this.kind ?? null);
  }

  // ------------------------------------------------------------ library actions

  async newFolder(parentId: number | null): Promise<void> {
    if (!this.kind.folders_enabled) return;
    const name = await ask({ title: `New ${this.kind.folder_label.toLowerCase()}`, placeholder: 'Name', ok: 'Create' });
    if (!name?.trim()) return;
    try {
      await api.createFolder(this.kind.id, smarten(name.trim()), parentId);
      await this.refreshTree();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the folder');
    }
  }

  async renameFolder(node: FolderNode): Promise<void> {
    const name = await ask({ title: `Rename ${this.kind.folder_label.toLowerCase()}`, value: node.folder.name, ok: 'Rename' });
    if (!name?.trim() || name.trim() === node.folder.name) return;
    await api.renameFolder(node.id, smarten(name.trim()));
    await this.refreshTree();
    this.fillCrumbs();
  }

  async renameDocument(doc: DocSummary): Promise<void> {
    if (this.doc?.id === doc.id) {
      this.titleInput.focus();
      this.titleInput.select();
      return;
    }
    const title = await ask({ title: 'Rename', value: doc.title, ok: 'Rename' });
    if (title === null) return;
    await api.updateDocument(doc.id, { title: smarten(title.trim()) });
    await this.refreshTree();
  }

  async deleteFolder(node: FolderNode): Promise<void> {
    const ok = await confirmAction(`Move “${node.folder.name}” and everything in it to the trash?`, 'Move to trash',
      'You can restore it from the trash for 30 days.');
    if (!ok) return;
    const containsCurrent = this.doc && folderPath(this.sidebar.root, this.doc.folder_id).some((f) => f.id === node.id);
    if (containsCurrent) await this.leaveDocument();
    await api.deleteFolder(node.id);
    await this.refreshTree();
    if (containsCurrent) {
      this.doc = null;
      this.startDraft();
    }
    toast('Moved to trash');
  }

  async deleteDocument(doc: DocSummary): Promise<void> {
    const ok = await confirmAction(`Move “${docLabel(this.kind, doc)}” to the trash?`, 'Move to trash',
      'You can restore it from the trash for 30 days.');
    if (!ok) return;
    const current = this.doc?.id === doc.id;
    if (current) await this.leaveDocument();
    await api.deleteDocument(doc.id);
    if (current) {
      this.doc = null;
      this.saver.unbind();
    }
    await this.refreshTree();
    if (current) this.startDraft();
    toast('Moved to trash');
  }

  async move(m: Move): Promise<void> {
    try {
      if (m.type === 'folder') await api.moveFolder(m.id, m.parent, m.index);
      else await api.moveDocument(m.id, m.parent, m.index);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not move');
    }
    await this.refreshTree();
    if (this.doc && m.type === 'doc' && m.id === this.doc.id) this.doc.folder_id = m.parent;
    this.fillCrumbs();
  }

  exportFolder(node: FolderNode): void {
    chooseFormat(`Export “${node.folder.name}” as one document`, `/api/folders/${node.id}/export`);
  }

  exportDocument(doc: DocSummary): void {
    void this.saver.flush().then(() => chooseFormat('Export', `/api/documents/${doc.id}/export`));
  }

  moveToDialog(node: Node): void {
    const root = this.sidebar.root;
    panel('Move to…', (close) => {
      const list = h('div', { class: 'move-list', role: 'listbox' });
      const option = (label: string, parent: number | null, level: number, disabled: boolean) =>
        h('button', {
          type: 'button', class: 'move-option', style: `--level:${level}`, disabled,
          onclick: () => { close(); void this.move({ type: node.type, id: node.id, parent }); },
        }, label);
      list.appendChild(option(`${this.kind.label} (top level)`, null, 0, node.parent === null));
      const walk = (folders: FolderNode[], level: number) => {
        for (const f of folders) {
          const self = node.type === 'folder' && (f.id === node.id);
          const tooDeep = node.type === 'folder' && f.depth + subtreeHeightOf(node as FolderNode) > 4;
          list.appendChild(option(f.folder.name, f.id, level, self || tooDeep || f.id === node.parent));
          if (!self) walk(f.folders, level + 1);
        }
      };
      walk(root.folders, 1);
      return list;
    });
  }

  // ------------------------------------------------------------ menus

  private documentMenu(anchor: HTMLElement): void {
    const k = this.kind;
    const e = this.editor;
    const items: (MenuItem | null)[] = [
      { label: 'Focus mode', hint: 'Ctrl+Shift+F', checked: this.el.classList.contains('focus-mode'), run: () => this.toggleFocus() },
      { label: 'Library', hint: 'Ctrl+\\', checked: this.el.classList.contains('sidebar-open'), run: () => this.toggleSidebar() },
      k.tools.draft_mode ? { label: 'Draft mode', hint: 'Ctrl+Shift+D', checked: this.el.classList.contains('draft-mode'), run: () => this.toggleDraftMode() } : null,
      { label: '', run: () => undefined, separator: true },
      e && hasExtension(k, 'footnote') ? { label: 'Insert footnote', hint: 'Ctrl+Alt+F', run: () => e.addFootnote() } : null,
      e && hasExtension(k, 'sectionBreak') ? { label: 'Insert section break', hint: '* * *', run: () => e.editor.chain().focus().insertSectionBreak().run() } : null,
      k.tools.word_target && this.doc ? { label: 'Word target…', run: () => void this.setWordTarget() } : null,
      k.sessions_allowed && this.sessions.current ? { label: 'End session…', hint: 'Ctrl+.', run: () => void this.endSession() } : null,
      ...this.features.flatMap((f) => f.documentMenu?.(this) ?? []),
      { label: '', run: () => undefined, separator: true },
      this.doc ? { label: 'Move to trash', run: () => void this.deleteDocument(this.doc!) } : null,
      { label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => this.showShortcuts() },
    ];
    menu(anchor, items);
  }

  openSettings(anchor: HTMLElement): void {
    const s = settings();
    const items: (MenuItem | null)[] = [
      { label: 'Paper', checked: s.theme === 'paper', run: () => updateSettings({ theme: 'paper' }) },
      { label: 'Dark', checked: s.theme === 'dark', run: () => updateSettings({ theme: 'dark' }) },
      { label: 'E-ink (high contrast)', checked: s.theme === 'eink', run: () => updateSettings({ theme: 'eink' }) },
      { label: '', run: () => undefined, separator: true },
      { label: 'Typewriter scrolling', checked: s.typewriter, run: () => updateSettings({ typewriter: !s.typewriter }) },
      { label: 'Word count', checked: s.wordCount, run: () => updateSettings({ wordCount: !s.wordCount }) },
      { label: 'Session timer', checked: s.timer, run: () => updateSettings({ timer: !s.timer }) },
      s.timer ? { label: `Check in every ${s.timerMinutes} min…`, run: () => void this.setTimerMinutes() } : null,
      ...this.features.flatMap((f) => f.settingsMenu?.(this) ?? []),
      { label: '', run: () => undefined, separator: true },
      { label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => this.showShortcuts() },
    ];
    menu(anchor, items);
  }

  private async setTimerMinutes(): Promise<void> {
    const v = await ask({ title: 'Check in every how many minutes?', value: String(settings().timerMinutes), type: 'number' });
    const n = Number(v);
    if (v !== null && Number.isFinite(n) && n >= 5 && n <= 180) updateSettings({ timerMinutes: Math.round(n) });
  }

  private async setWordTarget(): Promise<void> {
    if (!this.doc) return;
    const v = await ask({
      title: 'Word target', value: this.doc.word_target ? String(this.doc.word_target) : '', type: 'number',
      hint: 'Leave empty to remove the target.', ok: 'Set',
    });
    if (v === null) return;
    const n = v.trim() === '' ? null : Math.round(Number(v));
    if (n !== null && (!Number.isFinite(n) || n <= 0)) return;
    const doc = await api.updateDocument(this.doc.id, { meta: { word_target: n } });
    this.saver.rebase(doc.updated_at);
    this.doc = { ...this.doc, ...doc };
    this.updateWords();
  }

  showShortcuts(): void {
    const rows: [string, string][] = [
      ['Ctrl+P', 'Find a document by title'],
      ['Ctrl+K', 'Switch kind (Alt+1…9 directly)'],
      ['Ctrl+Shift+Space', 'Capture a thought to the inbox'],
      ['Ctrl+\\', 'Show or hide the library'],
      ['Ctrl+Shift+F', 'Focus mode (Esc leaves)'],
      ['Ctrl+Alt+N', 'New document'],
      ['Ctrl+S', 'Save now'],
      ['Ctrl+Shift+S', 'Take a snapshot'],
      ['Ctrl+.', 'End the writing session'],
      ['Ctrl+B / Ctrl+I', 'Bold / italic'],
      ['Ctrl+Shift+U', 'Link'],
      ['Ctrl+Alt+F', 'Footnote (essays)'],
      ['* * *', 'Section break on an empty line'],
      ['Ctrl+Shift+E', 'Research pane (essays)'],
      ['Ctrl+Shift+D', 'Draft mode: only the text (fiction)'],
      ['Library: ↑ ↓ ← →', 'Move between items'],
      ['Library: Alt+Shift+↑ ↓', 'Move item up or down'],
      ['Library: Alt+Shift+→ ←', 'Indent or outdent'],
      ['Library: F2 / Del', 'Rename / move to trash'],
    ];
    panel('Keyboard shortcuts', () => h('table', { class: 'shortcuts' },
      rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))));
  }

  // ------------------------------------------------------------ keyboard

  private onKey(e: KeyboardEvent): void {
    if (dialogOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    for (const f of this.features) if (f.onKey?.(this, e)) return;
    if (mod && e.shiftKey && (e.code === 'Space' || key === ' ')) {
      e.preventDefault();
      this.capture();
    } else if (mod && !e.shiftKey && !e.altKey && key === 'p') {
      e.preventDefault();
      this.openQuickOpen();
    } else if (mod && !e.shiftKey && !e.altKey && key === 'k') {
      e.preventDefault();
      this.openKindSwitcher();
    } else if (e.altKey && !mod && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      const k = this.kinds[Number(e.code.slice(5)) - 1];
      if (k) {
        e.preventDefault();
        void this.switchKind(k.id);
      }
    } else if (mod && key === '\\') {
      e.preventDefault();
      this.toggleSidebar();
    } else if (mod && e.shiftKey && key === 'f') {
      e.preventDefault();
      this.toggleFocus();
    } else if (mod && e.shiftKey && !e.altKey && key === 'd' && this.kind?.tools.draft_mode) {
      e.preventDefault();
      this.toggleDraftMode();
    } else if (mod && e.altKey && key === 'n') {
      e.preventDefault();
      void this.newDocument(this.sidebar.contextFolder());
    } else if (mod && !e.shiftKey && key === 's') {
      e.preventDefault();
      void this.saver.flush().then(() => this.rememberCursor());
      void this.view?.flush();
    } else if (mod && key === '.') {
      e.preventDefault();
      void this.endSession();
    } else if (mod && e.shiftKey && key === 'u') {
      e.preventDefault();
      void this.editor?.editLink();
    } else if (mod && key === '/') {
      e.preventDefault();
      this.showShortcuts();
    } else if (e.key === 'Escape' && this.el.classList.contains('focus-mode') && !isTypingTarget(e.target) ) {
      this.toggleFocus(false);
    } else if (e.key === 'Escape' && this.el.classList.contains('focus-mode') && (e.target as HTMLElement)?.isContentEditable) {
      if (!document.querySelector('.menu, .popover, .capture')) this.toggleFocus(false);
    }
  }
}

function subtreeHeightOf(node: FolderNode): number {
  return 1 + Math.max(0, ...node.folders.map(subtreeHeightOf));
}

