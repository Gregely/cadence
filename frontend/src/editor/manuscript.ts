import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** [[fix: tighten this]], [[check the date]]: any text on one line. */
export const TODO_RE = /\[\[([^[\]\n]+?)\]\]/g;

/** Where each marker is in a document: [from, to, text]. */
export function findMarkers(doc: PMNode): [number, number, string][] {
  const out: [number, number, string][] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Build the block's text with a position for every character.
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) at.push(start + i);
        text += child.text;
      } else {
        at.push(start);
        text += '￼';
      }
    });
    for (const m of text.matchAll(TODO_RE)) {
      const i = m.index!;
      out.push([at[i]!, at[i + m[0].length - 1]! + 1, m[1]!.trim()]);
    }
    return false;
  });
  return out;
}

const todoKey = new PluginKey<DecorationSet>('todoMarkers');

/** Highlights [[...]] markers (outlined, so it works without colour). */
export const TodoMarkers = Extension.create({
  name: 'todoMarkers',
  addProseMirrorPlugins() {
    const build = (doc: PMNode) =>
      DecorationSet.create(doc, findMarkers(doc).map(([from, to]) => Decoration.inline(from, to, { class: 'todo-marker' })));
    return [
      new Plugin<DecorationSet>({
        key: todoKey,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations: (state) => todoKey.getState(state),
        },
      }),
    ];
  },
});

interface ForwardState {
  on: boolean;
  /** Position before the first top-level block that may still be edited. */
  frontier: number;
}

export const forwardKey = new PluginKey<ForwardState>('forwardOnly');

function blockStart(state: EditorState, pos: number): number {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
  return $pos.depth >= 1 ? $pos.before(1) : pos;
}

function lastBlockStart(doc: PMNode): number {
  let start = 0;
  doc.forEach((_node, offset) => {
    start = offset;
  });
  return start;
}

/** Does this transaction change anything before the frontier? */
function touchesLocked(tr: Transaction, frontier: number): boolean {
  let bad = false;
  for (const step of tr.steps) {
    step.getMap().forEach((oldStart) => {
      if (oldStart < frontier) bad = true;
    });
  }
  return bad;
}

/**
 * Forward-only drafting: while on, paragraphs before the one being written
 * are read-only; that paragraph and anything after it (new paragraphs
 * included) stay editable. Off unless switched on.
 */
export const ForwardOnly = Extension.create({
  name: 'forwardOnly',
  addProseMirrorPlugins() {
    return [
      new Plugin<ForwardState>({
        key: forwardKey,
        state: {
          init: () => ({ on: false, frontier: 0 }),
          apply: (tr, prev, _old, state) => {
            const meta = tr.getMeta(forwardKey) as { on: boolean; atCursor: boolean } | undefined;
            if (meta) {
              if (!meta.on) return { on: false, frontier: 0 };
              const frontier = meta.atCursor ? blockStart(state, state.selection.head) : lastBlockStart(state.doc);
              return { on: true, frontier };
            }
            if (!prev.on || !tr.docChanged) return prev;
            // Moving on to a later paragraph moves the frontier with you.
            const mapped = tr.mapping.map(prev.frontier, -1);
            return { on: true, frontier: Math.max(mapped, blockStart(state, state.selection.head)) };
          },
        },
        filterTransaction: (tr, state) => {
          const fs = forwardKey.getState(state);
          if (!fs?.on || !tr.docChanged || tr.getMeta(forwardKey) || tr.getMeta('forwardOnlyAllow')) return true;
          return !touchesLocked(tr, fs.frontier);
        },
        props: {
          handleDOMEvents: {
            // A click in a read-only paragraph would park the browser's
            // selection where nothing can be typed; keep the cursor where
            // you were writing instead.
            mousedown: (view, event) => {
              const fs = forwardKey.getState(view.state);
              if (!fs?.on || !(event.target instanceof Element) || !event.target.closest('.forward-locked')) return false;
              event.preventDefault();
              view.focus();
              return true;
            },
          },
          // The browser's own Ctrl+End/Home stop at the read-only blocks;
          // move the cursor here instead, to the writable part.
          handleKeyDown: (view, event) => {
            const fs = forwardKey.getState(view.state);
            if (!fs?.on || !(event.ctrlKey || event.metaKey) || event.shiftKey) return false;
            const { state } = view;
            if (event.key === 'End') {
              view.dispatch(state.tr.setSelection(Selection.atEnd(state.doc)).scrollIntoView());
              return true;
            }
            if (event.key === 'Home') {
              const pos = Math.min(fs.frontier + 1, state.doc.content.size);
              view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))).scrollIntoView());
              return true;
            }
            return false;
          },
          decorations: (state) => {
            const fs = forwardKey.getState(state);
            if (!fs?.on) return null;
            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (offset < fs.frontier) {
                // Not editable in the page itself, so typing cannot slip in.
                decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'forward-locked', contenteditable: 'false' }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});
