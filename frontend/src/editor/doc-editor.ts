import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection, Selection } from '@tiptap/pm/state';

import { h } from '../lib/dom';
import { countWords } from '../lib/text';
import type { KindDef } from '../types';
import { buildExtensions, hasExtension, headingLevels } from './extensions';
import { FOOTNOTE_EVENT, type FootnoteEventDetail, selectionAt } from './nodes';

export interface DocEditorOptions {
  kind: KindDef;
  mount: HTMLElement;
  scroller: HTMLElement;
  content: JSONContent | null;
  cursor?: number | null;
  editable?: boolean;
  spellcheck?: boolean;
  typewriter?: () => boolean;
  onChange?: (editor: DocEditor) => void;
  onSelection?: (editor: DocEditor) => void;
  askLink?: (current: string) => Promise<string | null>;
}

const EMPTY: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * A TipTap editor configured for one kind, plus the small behaviours around
 * it: floating format bar, footnote editing, typewriter scrolling.
 */
export class DocEditor {
  readonly editor: Editor;
  readonly kind: KindDef;
  private bar: HTMLElement;
  private footnotePop: HTMLElement | null = null;
  private pointerDown = false;
  private scrollFrame = 0;
  private wordCache: { version: number; words: number } = { version: -1, words: 0 };
  private version = 0;
  private suppress = 0;

  constructor(private opts: DocEditorOptions) {
    this.kind = opts.kind;
    this.editor = new Editor({
      element: opts.mount,
      extensions: buildExtensions(opts.kind),
      content: opts.content ?? EMPTY,
      editable: opts.editable !== false,
      autofocus: false,
      injectCSS: false,
      editorProps: {
        attributes: {
          class: `prose kind-${opts.kind.id}`,
          spellcheck: opts.spellcheck === false ? 'false' : 'true',
          autocorrect: opts.spellcheck === false ? 'off' : 'on',
          autocapitalize: 'sentences',
          'aria-label': `${opts.kind.item_label} text`,
          role: 'textbox',
          'aria-multiline': 'true',
        },
      },
      onUpdate: () => {
        this.version++;
        if (this.suppress === 0) opts.onChange?.(this);
      },
      onSelectionUpdate: () => {
        this.updateBar();
        opts.onSelection?.(this);
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged || transaction.selectionSet) this.maybeTypewriter(transaction.docChanged);
      },
      onBlur: () => {
        window.setTimeout(() => {
          if (!this.bar.contains(document.activeElement)) this.hideBar();
        }, 120);
      },
    });
    this.bar = this.buildBar();
    document.body.appendChild(this.bar);
    const dom = this.editor.view.dom;
    dom.addEventListener('pointerdown', () => (this.pointerDown = true));
    window.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener(FOOTNOTE_EVENT, this.onFootnote as EventListener);
    if (opts.cursor !== undefined && opts.cursor !== null) this.setCursor(opts.cursor);
  }

  private onPointerUp = () => {
    window.setTimeout(() => (this.pointerDown = false), 50);
  };

  // ------------------------------------------------------------ content

  getJSON(): JSONContent {
    return this.editor.getJSON();
  }

  setContent(content: JSONContent | null, cursor?: number | null): void {
    this.suppress++;
    try {
      this.editor.commands.setContent(content ?? EMPTY, { emitUpdate: false });
    } finally {
      this.suppress--;
    }
    this.version++;
    if (cursor !== undefined && cursor !== null) this.setCursor(cursor);
  }

  text(): string {
    return this.editor.state.doc.textBetween(0, this.editor.state.doc.content.size, '\n', ' ');
  }

  words(): number {
    if (this.wordCache.version !== this.version) {
      this.wordCache = { version: this.version, words: countWords(this.text()) };
    }
    return this.wordCache.words;
  }

  isEmpty(): boolean {
    return this.editor.isEmpty;
  }

  cursor(): number {
    return this.editor.state.selection.head;
  }

  setCursor(pos: number): void {
    const { state, view } = this.editor;
    view.dispatch(state.tr.setSelection(selectionAt(state.doc, pos)).setMeta('addToHistory', false));
  }

  focus(): void {
    this.editor.view.focus();
    this.scrollToCursor(true);
  }

  /**
   * Focus synchronously at the start or end. (TipTap's focus command waits
   * for the next frame, so a fast typist's first key could land elsewhere.)
   */
  focusAt(where: 'start' | 'end'): void {
    const { state, view } = this.editor;
    const sel = where === 'start' ? Selection.atStart(state.doc) : Selection.atEnd(state.doc);
    view.dispatch(state.tr.setSelection(sel).setMeta('addToHistory', false));
    view.focus();
    this.scrollToCursor(false);
  }

  setEditable(on: boolean): void {
    this.editor.setEditable(on);
  }

  destroy(): void {
    window.removeEventListener('pointerup', this.onPointerUp);
    cancelAnimationFrame(this.scrollFrame);
    this.closeFootnote();
    this.bar.remove();
    this.editor.destroy();
  }

  // ------------------------------------------------------------ typewriter

  private maybeTypewriter(docChanged: boolean): void {
    if (this.pointerDown && !docChanged) return;
    if (!this.opts.typewriter?.()) {
      if (docChanged) this.scrollToCursor(false);
      return;
    }
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => this.scrollToCursor(true));
  }

  /** Keep the caret line at a fixed height (typewriter), or just visible. */
  scrollToCursor(center: boolean): void {
    const view = this.editor.view;
    const scroller = this.opts.scroller;
    let coords: { top: number; bottom: number };
    try {
      coords = view.coordsAtPos(view.state.selection.head);
    } catch {
      return;
    }
    const box = scroller.getBoundingClientRect();
    if (center && this.opts.typewriter?.()) {
      const target = box.top + scroller.clientHeight * 0.42;
      const delta = coords.top - target;
      if (Math.abs(delta) > 2) scroller.scrollTop += delta;
      return;
    }
    const margin = 48;
    if (coords.bottom > box.bottom - margin) scroller.scrollTop += coords.bottom - (box.bottom - margin);
    else if (coords.top < box.top + margin) scroller.scrollTop -= box.top + margin - coords.top;
  }

  // ------------------------------------------------------------ floating bar

  private buildBar(): HTMLElement {
    const ed = () => this.editor;
    const btn = (label: string, title: string, run: () => void, _active: () => boolean, cls = '') =>
      h('button', {
        type: 'button',
        class: `fmt ${cls}`,
        title,
        'aria-label': title,
        onmousedown: (e: Event) => e.preventDefault(),
        onclick: () => {
          run();
          this.updateBar();
        },
        dataset: { active: 'false' },
      }, label) as HTMLButtonElement & { _active?: () => boolean };
    const buttons: (HTMLButtonElement & { _active?: () => boolean })[] = [];
    const add = (b: HTMLButtonElement & { _active?: () => boolean }, active: () => boolean) => {
      b._active = active;
      buttons.push(b);
    };
    const k = this.kind;
    if (hasExtension(k, 'bold')) {
      const a = () => ed().isActive('bold');
      add(btn('B', 'Bold (Ctrl+B)', () => ed().chain().focus().toggleBold().run(), a, 'b'), a);
    }
    if (hasExtension(k, 'italic')) {
      const a = () => ed().isActive('italic');
      add(btn('I', 'Italic (Ctrl+I)', () => ed().chain().focus().toggleItalic().run(), a, 'i'), a);
    }
    if (hasExtension(k, 'link')) {
      const a = () => ed().isActive('link');
      add(btn('Link', 'Link (Ctrl+Shift+U)', () => void this.editLink(), a), a);
    }
    for (const level of headingLevels(k)) {
      const a = () => ed().isActive('heading', { level });
      add(btn(`H${level}`, `Heading ${level}`, () => ed().chain().focus().toggleHeading({ level: level as 1 }).run(), a), a);
    }
    if (hasExtension(k, 'blockquote')) {
      const a = () => ed().isActive('blockquote');
      add(btn('“ ”', 'Block quote', () => ed().chain().focus().toggleBlockquote().run(), a), a);
    }
    if (hasExtension(k, 'bulletList')) {
      const a = () => ed().isActive('bulletList');
      add(btn('•', 'List', () => ed().chain().focus().toggleBulletList().run(), a), a);
    }
    if (hasExtension(k, 'footnote')) {
      add(btn('¹', 'Footnote (Ctrl+Alt+F)', () => this.addFootnote(), () => false), () => false);
    }
    const bar = h('div', { class: 'format-bar', role: 'toolbar', 'aria-label': 'Formatting', hidden: true }, buttons);
    (bar as HTMLElement & { _buttons?: typeof buttons })._buttons = buttons;
    return bar;
  }

  private updateBar(): void {
    const { state } = this.editor;
    const sel = state.selection;
    const buttons = (this.bar as HTMLElement & { _buttons?: (HTMLButtonElement & { _active?: () => boolean })[] })._buttons ?? [];
    if (sel.empty || sel instanceof NodeSelection || !this.editor.isEditable || buttons.length === 0) {
      this.hideBar();
      return;
    }
    for (const b of buttons) b.dataset.active = b._active?.() ? 'true' : 'false';
    const view = this.editor.view;
    let start: { top: number; left: number; bottom: number };
    let end: { top: number; left: number; bottom: number };
    try {
      start = view.coordsAtPos(sel.from);
      end = view.coordsAtPos(sel.to);
    } catch {
      return;
    }
    this.bar.hidden = false;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const width = this.bar.offsetWidth;
    const height = this.bar.offsetHeight;
    const centre = (Math.min(start.left, end.left) + Math.max(start.left, end.left)) / 2;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, centre - width / 2));
    // On touch screens the system selection menu sits above; go below.
    let top = coarse ? end.bottom + 12 : start.top - height - 8;
    if (top < 8) top = end.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, start.top - height - 8);
    this.bar.style.left = `${Math.round(left)}px`;
    this.bar.style.top = `${Math.round(top)}px`;
  }

  hideBar(): void {
    this.bar.hidden = true;
  }

  async editLink(): Promise<void> {
    const current = String(this.editor.getAttributes('link').href ?? '');
    const href = this.opts.askLink ? await this.opts.askLink(current) : window.prompt('Link address', current);
    const chain = this.editor.chain().focus().extendMarkRange('link');
    if (href === null) return;
    if (href.trim() === '') chain.unsetLink().run();
    else {
      const url = /^(https?:|mailto:|#)/i.test(href.trim()) ? href.trim() : `https://${href.trim()}`;
      chain.setLink({ href: url }).run();
    }
  }

  // ------------------------------------------------------------ footnotes

  addFootnote(text = '', sourceId: number | null = null): void {
    this.editor.chain().focus().insertFootnote({ text, sourceId }).run();
    if (text) return;
    const pos = this.editor.state.selection.from - 1;
    const dom = this.editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      this.openFootnote({ pos, text: '', sourceId, rect: dom.getBoundingClientRect() });
    }
  }

  private onFootnote = (e: CustomEvent<FootnoteEventDetail>) => {
    this.openFootnote(e.detail);
  };

  private openFootnote(detail: FootnoteEventDetail): void {
    this.closeFootnote();
    const area = h('textarea', { rows: '3', 'aria-label': 'Footnote text' }) as HTMLTextAreaElement;
    area.value = detail.text;
    const save = () => {
      const node = this.editor.state.doc.nodeAt(detail.pos);
      if (node?.type.name === 'footnote' && node.attrs.text !== area.value) {
        const tr = this.editor.state.tr.setNodeMarkup(detail.pos, undefined, { ...node.attrs, text: area.value });
        this.editor.view.dispatch(tr);
      }
    };
    const remove = () => {
      const node = this.editor.state.doc.nodeAt(detail.pos);
      if (node?.type.name === 'footnote') {
        this.editor.view.dispatch(this.editor.state.tr.delete(detail.pos, detail.pos + node.nodeSize));
      }
      this.closeFootnote();
      this.editor.commands.focus();
    };
    const done = () => {
      save();
      this.closeFootnote();
      this.editor.chain().focus().setTextSelection(detail.pos + 1).run();
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        done();
      }
    });
    const pop = h('div', { class: 'popover footnote-pop', role: 'dialog', 'aria-label': 'Footnote' },
      h('label', { class: 'pop-label' }, 'Footnote'),
      area,
      h('div', { class: 'pop-actions' },
        h('button', { type: 'button', class: 'quiet', onclick: remove }, 'Remove'),
        h('button', { type: 'button', onclick: done }, 'Done')),
    );
    document.body.appendChild(pop);
    const left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, detail.rect.left - 40));
    let top = detail.rect.bottom + 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, detail.rect.top - pop.offsetHeight - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    this.footnotePop = pop;
    area.focus();
    area.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (this.footnotePop === pop && !pop.contains(document.activeElement)) {
          save();
          this.closeFootnote();
        }
      }, 150);
    });
  }

  private closeFootnote(): void {
    this.footnotePop?.remove();
    this.footnotePop = null;
  }
}
