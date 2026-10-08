import { dayLabel, longDate, monthName, timeLabel } from '../lib/dates';
import { clear, h } from '../lib/dom';
import { store } from '../lib/storage';
import { inManuscript, isStub, manuscriptWords, roleLabel, statusSymbol } from '../lib/roles';
import { formatCount } from '../lib/text';
import { settings } from '../settings';
import {
  type DocNode, type DropPosition, type FolderNode, type Move, type Node, type Root,
  buildTree, docsInFolder, dropMove, flatten, groupByMonth, indent, moveDown, moveUp, outdent,
} from '../lib/tree';
import type { DocSummary, KindDef, Tree } from '../types';
import { menu, type MenuItem } from './dialogs';

export interface SidebarHost {
  kinds: KindDef[];
  openDocument(id: number): void;
  newDocument(folderId: number | null): void;
  newFolder(parentId: number | null): void;
  renameFolder(node: FolderNode): void;
  renameDocument(doc: DocSummary): void;
  deleteFolder(node: FolderNode): void;
  deleteDocument(doc: DocSummary): void;
  move(move: Move): Promise<void>;
  moveToDialog(node: Node): void;
  exportFolder?(node: FolderNode): void;
  exportDocument?(doc: DocSummary): void;
  /** Extra menu items from optional tools (compile, draft sets, ...). */
  folderMenuExtra?(node: FolderNode): (MenuItem | null)[];
  docMenuExtra?(doc: DocSummary): (MenuItem | null)[];
  openStream(): void;
  /** Kinds with tools.combined_view: show every document in the folder. */
  openFolder?(folderId: number): unknown;
  openKindSwitcher(anchor: HTMLElement): void;
  openQuickOpen(): void;
  openInbox(): void;
  openTrash(): void;
  openSettings(anchor: HTMLElement): void;
  capture(): void;
  hide(): void;
}

export function docLabel(kind: KindDef, d: DocSummary): string {
  if (kind.title_mode === 'generated') return `${longDate(d.created_at)}`;
  const title = d.title.trim();
  if (title) return title;
  const excerpt = (d.excerpt ?? '').trim();
  if (excerpt) return excerpt.length > 60 ? `${excerpt.slice(0, 58)}…` : excerpt;
  return 'Untitled';
}

export class Sidebar {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private kindButton: HTMLButtonElement;
  private newFolderButton: HTMLButtonElement;
  private kind!: KindDef;
  private tree!: Tree;
  root!: Root;
  private currentId: number | null = null;
  private currentFolder: number | null = null;
  private collapsed = new Set<number>();
  private focusKey: string | null = null;
  private dragging: Node | null = null;

  constructor(private host: SidebarHost) {
    this.kindButton = h('button', {
      type: 'button',
      class: 'kind-button',
      title: 'Switch kind (Ctrl+K, or Alt+1…9)',
      'aria-haspopup': 'menu',
      onclick: () => host.openKindSwitcher(this.kindButton),
    }) as HTMLButtonElement;
    this.newFolderButton = h('button', {
      type: 'button', class: 'icon', title: 'New folder', 'aria-label': 'New folder',
      onclick: () => host.newFolder(null),
    }, '+▢') as HTMLButtonElement;
    this.body = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Library' });
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('dragover', (e) => this.onDragOver(e, null));
    this.body.addEventListener('drop', (e) => this.onDrop(e, null));
    const settingsButton = h('button', {
      type: 'button', class: 'quiet', onclick: (e: Event) => host.openSettings(e.currentTarget as HTMLElement),
    }, 'Settings') as HTMLButtonElement;
    this.el = h('aside', { class: 'sidebar', 'aria-label': 'Library' },
      h('div', { class: 'sidebar-head' },
        this.kindButton,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon', title: 'Quick open (Ctrl+P)', 'aria-label': 'Quick open', onclick: () => host.openQuickOpen() }, '⌕'),
        this.newFolderButton,
        h('button', { type: 'button', class: 'icon', title: 'New document (Ctrl+Alt+N)', 'aria-label': 'New document', onclick: () => host.newDocument(this.contextFolder()) }, '+'),
        h('button', { type: 'button', class: 'icon hide-sidebar', title: 'Hide library (Ctrl+\\)', 'aria-label': 'Hide library', onclick: () => host.hide() }, '‹'),
      ),
      this.body,
      h('div', { class: 'sidebar-foot' },
        h('button', { type: 'button', class: 'quiet', title: 'Capture a thought (Ctrl+Shift+Space)', onclick: () => host.capture() }, 'Capture'),
        h('button', { type: 'button', class: 'quiet', onclick: () => host.openInbox() }, 'Inbox'),
        h('button', { type: 'button', class: 'quiet', onclick: () => host.openTrash() }, 'Trash'),
        settingsButton,
      ),
    );
  }

  setData(kind: KindDef, tree: Tree, currentId: number | null): void {
    if (!this.kind || this.kind.id !== kind.id) {
      this.collapsed = new Set(store.json<number[]>(`cadence.collapsed.${kind.id}`, []));
    }
    this.kind = kind;
    this.tree = tree;
    this.currentId = currentId;
    const order = kind.list_view === 'stream' || kind.list_view === 'by-month' ? 'newest' : 'manual';
    this.root = buildTree(tree.folders, tree.documents, order);
    this.kindButton.textContent = `${kind.label} ▾`;
    this.newFolderButton.hidden = !kind.folders_enabled;
    this.newFolderButton.title = `New ${kind.folder_label.toLowerCase()}`;
    this.render();
  }

  setCurrent(id: number | null): void {
    this.currentId = id;
    for (const row of this.body.querySelectorAll<HTMLElement>('[data-doc]')) {
      const on = Number(row.dataset.doc) === id;
      row.classList.toggle('current', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }

  setCurrentFolder(id: number | null): void {
    this.currentFolder = id;
    for (const row of this.body.querySelectorAll<HTMLElement>('.row.folder')) {
      const on = Number(row.dataset.folder) === id;
      row.classList.toggle('current', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  }

  /** Update one document's label/words in place (after autosave). */
  patchDoc(doc: DocSummary): void {
    const i = this.tree.documents.findIndex((d) => d.id === doc.id);
    if (i >= 0) this.tree.documents[i] = { ...this.tree.documents[i]!, ...doc };
    const merged = this.tree.documents[i] ?? doc;
    const node = this.root.byDoc.get(doc.id);
    if (node) node.doc = merged;
    const label = this.body.querySelector<HTMLElement>(`[data-doc="${doc.id}"] .label`);
    if (label) label.textContent = docLabel(this.kind, merged);
    if (label && 'status' in doc && Object.keys(this.kind.status_symbols).length) {
      const row = label.parentElement!;
      row.querySelector(':scope > .status-symbol')?.remove();
      const symbol = statusSymbol(this.kind, merged.status);
      if (symbol) row.insertBefore(h('span', { class: 'status-symbol', title: merged.status!, 'aria-label': merged.status! }, symbol), label);
    }
    if (this.kind.list_view === 'ordered') this.patchCounts(merged);
  }

  /**
   * Update word counts and the stub marker in place (no re-render, so an
   * e-ink screen only repaints the numbers that changed).
   */
  private patchCounts(doc: DocSummary): void {
    const row = this.body.querySelector<HTMLElement>(`[data-doc="${doc.id}"]`);
    if (row && this.kind.roles.length) row.classList.toggle('stub', isStub(this.kind, doc));
    if (!settings().libraryCounts || !inManuscript(this.kind, doc)) return;
    const setMeta = (el: HTMLElement | null, words: number) => {
      if (!el) return;
      let meta = el.querySelector<HTMLElement>(':scope > .meta');
      if (!meta && words > 0) {
        meta = h('span', { class: 'meta' });
        el.insertBefore(meta, el.querySelector(':scope > .more'));
      }
      if (meta && meta.textContent !== formatCount(words)) meta.textContent = words > 0 ? formatCount(words) : '';
    };
    setMeta(row, doc.words ?? 0);
    let parent = doc.folder_id !== null ? this.root.byFolder.get(doc.folder_id) : undefined;
    while (parent) {
      setMeta(this.body.querySelector<HTMLElement>(`[data-folder="${parent.id}"]`), manuscriptWords(this.kind, docsInFolder(parent)));
      parent = parent.parent !== null ? this.root.byFolder.get(parent.parent) : undefined;
    }
  }

  focus(): void {
    const target = this.body.querySelector<HTMLElement>('.row.current') ?? this.body.querySelector<HTMLElement>('.row');
    target?.focus();
  }

  /** Folder that "new document" should go into: the open document's folder. */
  contextFolder(): number | null {
    if (!this.kind?.folders_enabled) return null;
    const active = document.activeElement as HTMLElement | null;
    if (active && this.body.contains(active) && active.dataset.folder) return Number(active.dataset.folder);
    const cur = this.currentId !== null ? this.root.byDoc.get(this.currentId) : undefined;
    return cur ? cur.parent : null;
  }

  private persistCollapsed(): void {
    store.set(`cadence.collapsed.${this.kind.id}`, JSON.stringify([...this.collapsed]));
  }

  // ------------------------------------------------------------ rendering

  render(): void {
    const scroll = this.body.scrollTop;
    clear(this.body);
    if (this.kind.list_view === 'by-month') this.renderMonths();
    else {
      if (this.kind.list_view === 'stream') {
        this.body.appendChild(h('button', { type: 'button', class: 'row stream-link', onclick: () => this.host.openStream() },
          h('span', { class: 'label' }, 'Stream')));
      }
      this.renderTree();
    }
    this.body.scrollTop = scroll;
    if (this.focusKey) {
      const el = this.body.querySelector<HTMLElement>(`[data-key="${this.focusKey}"]`);
      if (el) el.focus({ preventScroll: false });
      this.focusKey = null;
    }
  }

  private renderTree(): void {
    const rows = flatten(this.root, this.collapsed);
    const numbered = this.kind.list_view === 'ordered';
    // Numbers count manuscript documents only (fiction: scenes, not misc notes).
    const numbers = new Map<number, number>();
    if (numbered) {
      const counters = new Map<number | null, number>();
      for (const row of rows) {
        if (row.node.type !== 'doc' || !inManuscript(this.kind, row.node.doc)) continue;
        const n = (counters.get(row.node.parent) ?? 0) + 1;
        counters.set(row.node.parent, n);
        numbers.set(row.node.id, n);
      }
    }
    let lastDay = '';
    for (const row of rows) {
      const node = row.node;
      if (node.type === 'folder') {
        this.body.appendChild(this.folderRow(node, row.level, numbered));
      } else {
        if (this.kind.list_view === 'stream' && node.parent === null) {
          const day = dayLabel(node.doc.created_at);
          if (day !== lastDay) {
            this.body.appendChild(h('div', { class: 'group-head', role: 'presentation' }, day));
            lastDay = day;
          }
        }
        this.body.appendChild(this.docRow(node, row.level, numbered ? numbers.get(node.id) ?? null : null));
      }
    }
  }

  private renderMonths(): void {
    const now = new Date();
    let year = -1;
    for (const group of groupByMonth(this.tree.documents)) {
      if (group.year !== year) {
        year = group.year;
        if (year !== now.getFullYear()) this.body.appendChild(h('div', { class: 'group-head year' }, String(year)));
      }
      this.body.appendChild(h('div', { class: 'group-head' }, monthName(group.month)));
      for (const d of group.docs) {
        const dt = new Date(d.created_at);
        const label = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()]} ${dt.getDate()} · ${timeLabel(d.created_at)}`;
        const node: DocNode = { type: 'doc', id: d.id, parent: null, depth: 0, doc: d };
        const row = this.docRow(node, 0, null, label);
        row.draggable = false;
        this.body.appendChild(row);
      }
    }
  }

  private folderRow(node: FolderNode, level: number, numbered: boolean): HTMLElement {
    const open = !this.collapsed.has(node.id);
    const words = numbered && settings().libraryCounts ? manuscriptWords(this.kind, docsInFolder(node)) : null;
    const toggle = () => {
      if (open) this.collapsed.add(node.id);
      else this.collapsed.delete(node.id);
      this.persistCollapsed();
      this.focusKey = `f${node.id}`;
      this.render();
    };
    const opensView = this.kind.tools.combined_view && !!this.host.openFolder;
    const current = opensView && node.id === this.currentFolder;
    const twisty = h('span', { class: 'twisty', 'aria-hidden': 'true' }, open ? '▾' : '▸');
    const row = h('div', {
      class: `row folder${current ? ' current' : ''}`,
      'aria-current': current ? 'true' : undefined,
      role: 'treeitem',
      tabindex: '-1',
      'aria-expanded': String(open),
      'aria-level': String(level + 1),
      draggable: 'true',
      dataset: { key: `f${node.id}`, folder: String(node.id) },
      style: `--level:${level}`,
    },
    twisty,
    h('span', { class: 'label' }, node.folder.name),
    words !== null && words > 0 ? h('span', { class: 'meta', title: 'Words in the manuscript' }, formatCount(words)) : null,
    this.moreButton(() => this.folderMenu(node)));
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.more')) return;
      // In a combined-view kind the folder opens; its arrow still folds it.
      if (opensView && e.target !== twisty) this.host.openFolder!(node.id);
      else toggle();
    });
    (row as HTMLElement & { _toggle?: () => void })._toggle = toggle;
    (row as HTMLElement & { _open?: () => void })._open = opensView ? () => this.host.openFolder!(node.id) : toggle;
    this.wireDrag(row, node);
    return row;
  }

  private docRow(node: DocNode, level: number, number: number | null, label?: string): HTMLElement {
    const d = node.doc;
    const current = d.id === this.currentId;
    const k = this.kind;
    const manuscript = inManuscript(k, d);
    const symbol = statusSymbol(k, d.status);
    const stub = k.roles.length > 0 && isStub(k, d);
    const row = h('div', {
      class: `row doc${current ? ' current' : ''}${manuscript ? '' : ' misc'}${stub ? ' stub' : ''}`,
      role: 'treeitem',
      tabindex: '-1',
      'aria-level': String(level + 1),
      'aria-current': current ? 'true' : undefined,
      draggable: 'true',
      dataset: { key: `d${d.id}`, doc: String(d.id) },
      style: `--level:${level}`,
    },
    number !== null ? h('span', { class: 'num' }, `${number}.`) : null,
    // Status as a shape (and its name for screen readers), never colour alone.
    symbol ? h('span', { class: 'status-symbol', title: d.status!, 'aria-label': d.status! }, symbol) : null,
    h('span', { class: 'label' }, label ?? docLabel(this.kind, d)),
    !manuscript ? h('span', { class: 'tag' }, roleLabel(k, d.role).toLowerCase()) : null,
    d.status && !symbol ? h('span', { class: 'tag' }, d.status) : null,
    this.kind.list_view === 'ordered' && manuscript && d.words && settings().libraryCounts ? h('span', { class: 'meta' }, formatCount(d.words)) : null,
    this.moreButton(() => this.docMenu(node)));
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.more')) return;
      this.host.openDocument(d.id);
    });
    this.wireDrag(row, node);
    return row;
  }

  private moreButton(items: () => (MenuItem | null)[]): HTMLElement {
    const b = h('button', { type: 'button', class: 'more', tabindex: '-1', 'aria-label': 'Actions', title: 'Actions' }, '⋯');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      menu(b, items());
    });
    return b;
  }

  private moveItems(node: Node): MenuItem[] {
    if (this.kind.list_view === 'by-month') return [];
    const manualDocs = this.kind.list_view !== 'stream';
    const up = moveUp(this.root, node);
    const down = moveDown(this.root, node);
    const ind = this.kind.folders_enabled ? indent(this.root, node) : null;
    const out = this.kind.folders_enabled ? outdent(this.root, node) : null;
    const canOrder = node.type === 'folder' || manualDocs;
    return [
      { label: '', run: () => undefined, separator: true },
      { label: 'Move up', hint: 'Alt+Shift+↑', run: () => void this.doMove(up), disabled: !up || !canOrder },
      { label: 'Move down', hint: 'Alt+Shift+↓', run: () => void this.doMove(down), disabled: !down || !canOrder },
      ...(this.kind.folders_enabled
        ? [
          { label: 'Indent', hint: 'Alt+Shift+→', run: () => void this.doMove(ind), disabled: !ind },
          { label: 'Outdent', hint: 'Alt+Shift+←', run: () => void this.doMove(out), disabled: !out },
          { label: 'Move to…', run: () => this.host.moveToDialog(node) },
        ]
        : []),
    ];
  }

  private folderMenu(node: FolderNode): (MenuItem | null)[] {
    const k = this.kind;
    return [
      k.tools.combined_view && this.host.openFolder ? { label: 'Open all', hint: 'Enter', run: () => this.host.openFolder!(node.id) } : null,
      { label: `New ${k.item_label.toLowerCase()} here`, run: () => this.host.newDocument(node.id) },
      { label: `New ${k.folder_label.toLowerCase()} inside`, run: () => this.host.newFolder(node.id), disabled: node.depth >= 4 },
      { label: 'Rename…', hint: 'F2', run: () => this.host.renameFolder(node) },
      ...this.moveItems(node),
      this.host.exportFolder && k.exportable && !k.tools.compile ? { label: 'Export as one document…', run: () => this.host.exportFolder!(node) } : null,
      ...(this.host.folderMenuExtra?.(node) ?? []),
      { label: '', run: () => undefined, separator: true },
      { label: 'Move to trash', hint: 'Del', run: () => this.host.deleteFolder(node) },
    ];
  }

  private docMenu(node: DocNode): (MenuItem | null)[] {
    const k = this.kind;
    return [
      { label: 'Open', run: () => this.host.openDocument(node.id) },
      k.title_mode !== 'generated' ? { label: 'Rename…', hint: 'F2', run: () => this.host.renameDocument(node.doc) } : null,
      ...this.moveItems(node),
      this.host.exportDocument && k.exportable ? { label: 'Export…', run: () => this.host.exportDocument!(node.doc) } : null,
      ...(this.host.docMenuExtra?.(node.doc) ?? []),
      { label: '', run: () => undefined, separator: true },
      { label: 'Move to trash', hint: 'Del', run: () => this.host.deleteDocument(node.doc) },
    ];
  }

  private async doMove(m: Move | null): Promise<void> {
    if (!m) return;
    this.focusKey = `${m.type === 'folder' ? 'f' : 'd'}${m.id}`;
    if (m.parent !== null) this.collapsed.delete(m.parent);
    await this.host.move(m);
  }

  // ------------------------------------------------------------ keyboard

  private rows(): HTMLElement[] {
    return [...this.body.querySelectorAll<HTMLElement>('.row[role="treeitem"]')];
  }

  private nodeFor(el: HTMLElement): Node | null {
    if (el.dataset.folder) return this.root.byFolder.get(Number(el.dataset.folder)) ?? null;
    if (el.dataset.doc) {
      const id = Number(el.dataset.doc);
      const n = this.root.byDoc.get(id);
      if (n) return n;
      const d = this.tree.documents.find((x) => x.id === id);
      return d ? { type: 'doc', id, parent: null, depth: 0, doc: d } : null;
    }
    return null;
  }

  private onKey(e: KeyboardEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.row[role="treeitem"]');
    if (!el) return;
    const rows = this.rows();
    const i = rows.indexOf(el);
    const node = this.nodeFor(el);
    if (!node) return;
    const go = (j: number) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
    if (e.altKey && e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      if (this.kind.list_view === 'by-month') return;
      if (node.type === 'doc' && this.kind.list_view === 'stream' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return;
      const fn = { ArrowUp: moveUp, ArrowDown: moveDown, ArrowRight: indent, ArrowLeft: outdent }[e.key]!;
      if (!this.kind.folders_enabled && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      void this.doMove(fn(this.root, node));
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i + 1); break;
      case 'ArrowUp': e.preventDefault(); go(i - 1); break;
      case 'Home': e.preventDefault(); go(0); break;
      case 'End': e.preventDefault(); go(rows.length - 1); break;
      case 'ArrowRight':
        if (node.type === 'folder') {
          e.preventDefault();
          if (this.collapsed.has(node.id)) (el as HTMLElement & { _toggle?: () => void })._toggle?.();
          else go(i + 1);
        }
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (node.type === 'folder' && !this.collapsed.has(node.id)) {
          (el as HTMLElement & { _toggle?: () => void })._toggle?.();
        } else if (node.parent !== null) {
          this.body.querySelector<HTMLElement>(`[data-key="f${node.parent}"]`)?.focus();
        }
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (node.type === 'folder') (el as HTMLElement & { _open?: () => void })._open?.();
        else this.host.openDocument(node.id);
        break;
      case 'F2':
        e.preventDefault();
        if (node.type === 'folder') this.host.renameFolder(node);
        else if (this.kind.title_mode !== 'generated') this.host.renameDocument(node.doc);
        break;
      case 'Delete':
        e.preventDefault();
        if (node.type === 'folder') this.host.deleteFolder(node);
        else this.host.deleteDocument(node.doc);
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) break;
        e.preventDefault();
        el.querySelector<HTMLButtonElement>('.more')?.click();
        break;
      default:
    }
  }

  // ------------------------------------------------------------ drag and drop

  private wireDrag(row: HTMLElement, node: Node): void {
    if (this.kind.list_view === 'by-month') return;
    row.addEventListener('dragstart', (e) => {
      this.dragging = node;
      e.dataTransfer?.setData('text/plain', `${node.type}:${node.id}`);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      row.classList.remove('dragging');
      this.clearDropMarks();
    });
    row.addEventListener('dragover', (e) => {
      e.stopPropagation();
      this.onDragOver(e, node, row);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.stopPropagation();
      this.onDrop(e, node, row);
    });
  }

  private position(e: DragEvent, row: HTMLElement, target: Node): DropPosition {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    if (target.type === 'folder' && this.kind.folders_enabled) {
      if (y < 0.25) return 'before';
      if (y > 0.75 && this.collapsed.has(target.id)) return 'after';
      return 'inside';
    }
    return y < 0.5 ? 'before' : 'after';
  }

  private clearDropMarks(): void {
    for (const r of this.body.querySelectorAll('.drop-before, .drop-after, .drop-inside, .drop-root')) {
      r.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-root');
    }
  }

  private onDragOver(e: DragEvent, target: Node | null, row?: HTMLElement): void {
    if (!this.dragging) return;
    const pos: DropPosition = target && row ? this.position(e, row, target) : 'after';
    const m = target && target.id === this.dragging.id && target.type === this.dragging.type
      ? null
      : dropMove(this.root, this.dragging, target, pos);
    this.clearDropMarks();
    if (!m || (m.parent !== null && !this.kind.folders_enabled)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (row) row.classList.add(`drop-${pos}`);
    else this.body.classList.add('drop-root');
  }

  private onDrop(e: DragEvent, target: Node | null, row?: HTMLElement): void {
    if (!this.dragging) return;
    e.preventDefault();
    const pos: DropPosition = target && row ? this.position(e, row, target) : 'after';
    const m = dropMove(this.root, this.dragging, target, pos);
    this.clearDropMarks();
    this.dragging = null;
    if (m) void this.doMove(m);
  }
}
