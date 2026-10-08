import { Extension, Mark, Node, mergeAttributes, nodeInputRule } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: (attrs?: { text?: string; sourceId?: number | null }) => ReturnType;
    };
    sectionBreak: {
      insertSectionBreak: () => ReturnType;
    };
    citation: {
      insertCitation: (attrs: { text: string; sourceId: number; locator?: string }) => ReturnType;
    };
  }
}

/** Fired when a footnote marker is activated, so the UI can open its editor. */
export const FOOTNOTE_EVENT = 'cadence:footnote';

export interface FootnoteEventDetail {
  pos: number;
  text: string;
  sourceId: number | null;
  rect: DOMRect;
}

/**
 * Footnote: an inline atom holding its own text. Numbered by CSS counters,
 * so numbering is always right after edits.
 */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-footnote') ?? '',
        renderHTML: (attrs) => ({ 'data-footnote': attrs.text }),
      },
      sourceId: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-source-id');
          return v ? Number(v) : null;
        },
        renderHTML: (attrs) => (attrs.sourceId ? { 'data-source-id': String(attrs.sourceId) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes({ class: 'footnote' }, HTMLAttributes)];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('sup');
      dom.className = 'footnote';
      dom.setAttribute('role', 'button');
      dom.setAttribute('aria-label', 'Footnote');
      dom.contentEditable = 'false';
      let current = node;
      const open = (event: Event) => {
        event.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos === null || pos === undefined) return;
        editor.view.dom.dispatchEvent(
          new CustomEvent<FootnoteEventDetail>(FOOTNOTE_EVENT, {
            bubbles: true,
            detail: {
              pos,
              text: String(current.attrs.text ?? ''),
              sourceId: (current.attrs.sourceId as number | null) ?? null,
              rect: dom.getBoundingClientRect(),
            },
          }),
        );
      };
      dom.addEventListener('mousedown', open);
      dom.title = String(node.attrs.text ?? '');
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'footnote') return false;
          current = updated;
          dom.title = String(updated.attrs.text ?? '');
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (event) => event.type === 'mousedown',
      };
    };
  },

  addCommands() {
    return {
      insertFootnote:
        (attrs = {}) =>
        ({ chain, state }) => {
          const pos = state.selection.to;
          return chain()
            .insertContentAt(pos, { type: this.name, attrs: { text: attrs.text ?? '', sourceId: attrs.sourceId ?? null } })
            .run();
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-f': () => {
        this.editor.commands.insertFootnote();
        const pos = this.editor.state.selection.from - 1;
        const dom = this.editor.view.nodeDOM(pos);
        if (dom instanceof HTMLElement) dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return true;
      },
    };
  },
});

/** Section break: a block atom shown as a centred ornament. */
export const SectionBreak = Node.create({
  name: 'sectionBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'hr' }, { tag: 'div[data-section-break]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-section-break': '', class: 'section-break', role: 'separator' }, HTMLAttributes)];
  },

  addCommands() {
    return {
      insertSectionBreak:
        () =>
        ({ chain, state }) => {
          const { $to } = state.selection;
          const after = $to.after($to.depth > 0 ? 1 : 0);
          return chain()
            .insertContentAt(after, [{ type: this.name }, { type: 'paragraph' }])
            .setTextSelection(after + 2)
            .run();
        },
    };
  },

  addInputRules() {
    // "***" or "* * *" on an empty line.
    return [nodeInputRule({ find: /^(?:\*\s?\*\s?\*|---)\s$/, type: this.type })];
  },
});

/** Citation: a mark linking text to a research source. */
export const Citation = Mark.create({
  name: 'citation',
  inclusive: false,
  addAttributes() {
    return {
      sourceId: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-source-id')) || null,
        renderHTML: (attrs) => (attrs.sourceId ? { 'data-source-id': String(attrs.sourceId) } : {}),
      },
      locator: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-locator') ?? '',
        renderHTML: (attrs) => (attrs.locator ? { 'data-locator': attrs.locator } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'cite[data-source-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['cite', mergeAttributes({ class: 'citation' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      insertCitation:
        ({ text, sourceId, locator }) =>
        ({ chain, state }) => {
          const pos = state.selection.to;
          return chain()
            .insertContentAt(pos, { type: 'text', text, marks: [{ type: this.name, attrs: { sourceId, locator: locator ?? '' } }] })
            .run();
        },
    };
  },
});

/**
 * Poetry lines: Enter makes a new line inside the stanza; Enter on a blank
 * line (or Shift-Enter) starts a new stanza. Pasted plain text keeps its line
 * breaks, blank-line stanza breaks and leading indentation.
 */
export const PoetryLines = Extension.create({
  name: 'poetryLines',
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const { $from, empty } = state.selection;
        if (!empty) return editor.chain().deleteSelection().setHardBreak().run();
        if ($from.parent.type.name !== 'paragraph') return false;
        const before = $from.nodeBefore;
        if (before && before.type.name === 'hardBreak') {
          return editor
            .chain()
            .command(({ tr }) => {
              tr.delete($from.pos - 1, $from.pos);
              return true;
            })
            .splitBlock()
            .run();
        }
        if ($from.parent.content.size === 0) return false; // empty stanza: default split
        return editor.commands.setHardBreak();
      },
      'Shift-Enter': ({ editor }) => editor.commands.splitBlock(),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('poetryPaste'),
        props: {
          clipboardTextParser: (text, _context, _plain, view) => poemSlice(view.state.schema, text),
        },
      }),
    ];
  },
});

export function poemSlice(schema: Schema, text: string): Slice {
  const stanzas = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const paragraphs: PMNode[] = [];
  for (const stanza of stanzas) {
    const lines = stanza.split('\n');
    const inline: PMNode[] = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push(schema.nodes.hardBreak!.create());
      if (line) inline.push(schema.text(line));
    });
    paragraphs.push(schema.nodes.paragraph!.create(null, inline));
  }
  return new Slice(Fragment.from(paragraphs), 1, 1);
}

/** Indentation: Tab inserts a tab, Shift-Tab removes one just before the cursor or at the line start. */
export const Indent = Extension.create({
  name: 'indent',
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => editor.commands.insertContent('\t'),
      'Shift-Tab': ({ editor }) => {
        const { state, view } = editor;
        const { $from } = state.selection;
        // Find the start of the current line (after the last hard break).
        let lineStart = $from.start();
        $from.parent.forEach((child, offset) => {
          const abs = $from.start() + offset;
          if (child.type.name === 'hardBreak' && abs < $from.pos) lineStart = abs + 1;
        });
        const lineText = state.doc.textBetween(lineStart, $from.pos, '\n', '\n');
        if (lineText.startsWith('\t')) {
          view.dispatch(state.tr.delete(lineStart, lineStart + 1));
        } else if (lineText.startsWith('    ')) {
          view.dispatch(state.tr.delete(lineStart, lineStart + 4));
        }
        return true;
      },
    };
  },
});

/** Marks the top-level block holding the cursor, for focus-mode dimming. */
export const CurrentBlock = Extension.create({
  name: 'currentBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('currentBlock'),
        props: {
          decorations(state) {
            const { $head } = state.selection;
            if ($head.depth < 1) return null;
            const start = $head.before(1);
            const node = state.doc.nodeAt(start);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(start, start + node.nodeSize, { class: 'is-current' }),
            ]);
          },
        },
      }),
    ];
  },
});

/** Put the cursor at a stored position, clamped to the document. */
export function selectionAt(doc: PMNode, pos: number): Selection {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  return TextSelection.near(doc.resolve(clamped));
}
