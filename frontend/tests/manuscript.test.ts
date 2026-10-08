import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildExtensions } from '../src/editor/extensions';
import { findMarkers, forwardKey } from '../src/editor/manuscript';
import { kind } from './kinds';

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function make(content: object): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const e = new Editor({ element: el, extensions: buildExtensions(kind('fiction')), content, injectCSS: false });
  editors.push(e);
  return e;
}

const p = (...nodes: object[]) => ({ type: 'paragraph', content: nodes });
const t = (text: string, marks?: object[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text });

describe('TODO markers', () => {
  it('finds markers, also across italics', () => {
    const e = make({ type: 'doc', content: [
      p(t('One [[fix: this]] two.')),
      p(t('Start [['), t('check', [{ type: 'italic' }]), t(' date]] end, [[again]].')),
    ] });
    const found = findMarkers(e.state.doc);
    expect(found.map((m) => m[2])).toEqual(['fix: this', 'check date', 'again']);
    const [from, to] = found[1]!;
    expect(e.state.doc.textBetween(from, to)).toBe('[[check date]]');
    expect(e.view.dom.querySelectorAll('.todo-marker').length).toBeGreaterThanOrEqual(3);
  });

  it('ignores single brackets and multi-line spans', () => {
    const e = make({ type: 'doc', content: [p(t('[not one] and [[ ]] [[a')), p(t('b]]'))] });
    expect(findMarkers(e.state.doc).map((m) => m[2])).toEqual(['']);
  });
});

describe('forward-only drafting', () => {
  function setup() {
    const e = make({ type: 'doc', content: [p(t('First.')), p(t('Second.')), p(t('Third.'))] });
    const end = e.state.doc.content.size - 1;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, end)));
    return e;
  }

  it('is off by default', () => {
    const e = setup();
    expect(forwardKey.getState(e.state)!.on).toBe(false);
    e.commands.insertContentAt(1, 'X');
    expect(e.getText().startsWith('XFirst.')).toBe(true);
  });

  it('keeps earlier paragraphs read-only and lets you write forward', () => {
    const e = setup();
    e.view.dispatch(e.state.tr.setMeta(forwardKey, { on: true, atCursor: true }));
    const before = e.getText();
    e.commands.insertContentAt(1, 'X'); // inside the first paragraph
    expect(e.getText()).toBe(before);
    e.view.dispatch(e.state.tr.delete(1, 4));
    expect(e.getText()).toBe(before);
    expect(e.view.dom.querySelectorAll('.forward-locked').length).toBe(2);
    expect(e.view.dom.querySelector('.forward-locked')!.getAttribute('contenteditable')).toBe('false');
    // Writing in the current paragraph works, and so does starting a new one.
    e.commands.insertContent(' More');
    e.commands.splitBlock();
    e.commands.insertContent('Fourth.');
    expect(e.getText()).toBe('First.\n\nSecond.\n\nThird. More\n\nFourth.');
    // The frontier moved on: "Third." is now locked too.
    const third = e.state.doc.child(0).nodeSize + e.state.doc.child(1).nodeSize + 1;
    e.commands.insertContentAt(third, 'Y');
    expect(e.getText()).not.toContain('YThird');
    // Backspace at the start of the current paragraph would join it with a locked one.
    e.commands.setTextSelection(e.state.doc.content.size - 'Fourth.'.length - 1);
    e.commands.joinBackward();
    expect(e.state.doc.childCount).toBe(4);
    // Switched off, everything is editable again.
    e.view.dispatch(e.state.tr.setMeta(forwardKey, { on: false, atCursor: true }));
    e.commands.insertContentAt(1, 'Z');
    expect(e.getText().startsWith('ZFirst.')).toBe(true);
  });

  it('when not at the cursor, only the last paragraph is open', () => {
    const e = setup();
    e.commands.setTextSelection(1);
    e.view.dispatch(e.state.tr.setMeta(forwardKey, { on: true, atCursor: false }));
    expect(e.view.dom.querySelectorAll('.forward-locked').length).toBe(2);
  });
});
