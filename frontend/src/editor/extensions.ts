import type { AnyExtension } from '@tiptap/core';
import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Heading, { type Level } from '@tiptap/extension-heading';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Typography from '@tiptap/extension-typography';
import { Dropcursor, Gapcursor, UndoRedo } from '@tiptap/extensions';

import type { KindDef } from '../types';
import { Citation, CurrentBlock, Footnote, Indent, PoetryLines, SectionBreak } from './nodes';

const SAFE_HREF = /^(https?:|mailto:|#)/i;

/**
 * Registry of extension names a kind may list. A new kind that uses these
 * names needs no code changes; an unknown name is skipped with a warning.
 */
export const EXTENSION_FACTORIES: Record<string, (arg?: string) => AnyExtension[]> = {
  typography: () => [
    Typography.configure({
      // Smart quotes, dashes and ellipses only; nothing surprising.
      leftArrow: false,
      rightArrow: false,
      copyright: false,
      trademark: false,
      servicemark: false,
      registeredTrademark: false,
      oneHalf: false,
      oneQuarter: false,
      threeQuarters: false,
      plusMinus: false,
      notEqual: false,
      laquo: false,
      raquo: false,
      multiplication: false,
      superscriptTwo: false,
      superscriptThree: false,
    }),
  ],
  heading: (arg) => {
    const levels = (arg ?? '2,3').split(',').map(Number).filter((n) => n >= 1 && n <= 6) as Level[];
    return [Heading.configure({ levels })];
  },
  bold: () => [Bold],
  italic: () => [Italic],
  link: () => [
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      isAllowedUri: (url) => SAFE_HREF.test(url),
    }),
  ],
  blockquote: () => [Blockquote],
  footnote: () => [Footnote],
  citation: () => [Citation],
  sectionBreak: () => [SectionBreak],
  hardBreak: () => [HardBreak],
  bulletList: () => [BulletList, ListItem, ListKeymap],
  orderedList: () => [OrderedList, ListItem, ListKeymap],
  poetryLines: () => [PoetryLines],
  indent: () => [Indent],
};

export function hasExtension(kind: KindDef, name: string): boolean {
  return kind.extensions.some((e) => e.split(':')[0] === name);
}

export function headingLevels(kind: KindDef): number[] {
  const ext = kind.extensions.find((e) => e.startsWith('heading'));
  if (!ext) return [];
  return (ext.split(':')[1] ?? '2,3').split(',').map(Number);
}

export function buildExtensions(kind: KindDef, opts: { history?: boolean } = {}): AnyExtension[] {
  const out: AnyExtension[] = [Document, Paragraph, Text, Dropcursor.configure({ color: false, width: 2 }), Gapcursor, CurrentBlock];
  if (opts.history !== false) out.push(UndoRedo.configure({ depth: 200 }));
  const seen = new Set<string>();
  for (const spec of kind.extensions) {
    const [name, arg] = spec.split(':');
    const factory = EXTENSION_FACTORIES[name!];
    if (!factory) {
      console.warn(`Cadence: unknown editor extension "${spec}" in kind "${kind.id}"`);
      continue;
    }
    for (const ext of factory(arg)) {
      if (seen.has(ext.name)) continue;
      seen.add(ext.name);
      out.push(ext);
    }
  }
  return out;
}
