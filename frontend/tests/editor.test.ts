import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildExtensions } from '../src/editor/extensions';
import { poemSlice } from '../src/editor/nodes';
import { KINDS, kind } from './kinds';

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

function make(kindId: string, content?: object): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const e = new Editor({ element: el, extensions: buildExtensions(kind(kindId)), content, injectCSS: false });
  editors.push(e);
  return e;
}

function press(e: Editor, key: string, shift = false): void {
  e.view.someProp('handleKeyDown', (f) => f(e.view, new KeyboardEvent('keydown', { key, shiftKey: shift })));
}

describe('kind editors', () => {
  it('builds an editor for every kind in the registry', () => {
    for (const k of KINDS) {
      const e = make(k.id);
      expect(e.schema.nodes.paragraph).toBeTruthy();
    }
  });

  it('only includes the node and mark types a kind allows', () => {
    const poetry = make('poetry');
    expect(Object.keys(poetry.schema.marks)).toEqual(['italic']);
    expect(poetry.schema.nodes.heading).toBeUndefined();
    const essay = make('essay');
    for (const n of ['heading', 'blockquote', 'footnote', 'sectionBreak', 'hardBreak']) expect(essay.schema.nodes[n]).toBeTruthy();
    for (const m of ['bold', 'italic', 'link', 'citation']) expect(essay.schema.marks[m]).toBeTruthy();
  });

  it('skips unknown extension names so a new kind never breaks the editor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const custom = { ...kind('note'), id: 'letters', extensions: ['italic', 'somethingNew'] };
    const exts = buildExtensions(custom);
    expect(exts.some((x) => x.name === 'italic')).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('poetry: Enter breaks the line, Enter on a blank line starts a stanza', () => {
    const e = make('poetry');
    e.commands.insertContent('first line');
    press(e, 'Enter');
    e.commands.insertContent('second line');
    press(e, 'Enter');
    press(e, 'Enter');
    e.commands.insertContent('new stanza');
    const json = e.getJSON();
    expect(json.content).toHaveLength(2);
    expect(json.content![0]!.content!.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    expect((json.content![1]!.content![0] as { text?: string }).text).toBe('new stanza');
  });

  it('poetry: Tab indents and Shift-Tab removes the indent', () => {
    const e = make('poetry');
    press(e, 'Tab');
    e.commands.insertContent('indented');
    expect(e.getText()).toBe('\tindented');
    press(e, 'Tab', true);
    expect(e.getText()).toBe('indented');
  });

  it('poetry: pasted text keeps lines, stanzas and indentation', () => {
    const e = make('poetry');
    const slice = poemSlice(e.schema, 'one\n    two\n\nthree');
    const paras: string[] = [];
    slice.content.forEach((p) => {
      const parts: string[] = [];
      p.forEach((c) => parts.push(c.type.name === 'hardBreak' ? '/' : c.text!));
      paras.push(parts.join(''));
    });
    expect(paras).toEqual(['one/    two', 'three']);
  });

  it('typography: smart quotes and em dashes', () => {
    const e = make('essay');
    // Input rules fire on typed text; simulate typing character by character.
    for (const ch of '"Hi" -- ') {
      const { from, to } = e.state.selection;
      const handled = e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
    }
    expect(e.getText()).toBe('“Hi” — ');
  });

  it('essay: footnotes and section breaks round-trip through JSON', () => {
    const e = make('essay');
    e.commands.insertContent('Claim');
    e.commands.insertFootnote({ text: 'Source, p. 4' });
    e.commands.insertSectionBreak();
    const json = JSON.stringify(e.getJSON());
    expect(json).toContain('"type":"footnote"');
    expect(json).toContain('"text":"Source, p. 4"');
    expect(json).toContain('"type":"sectionBreak"');
    const again = make('essay', JSON.parse(json));
    expect(JSON.stringify(again.getJSON())).toBe(json);
  });
});
