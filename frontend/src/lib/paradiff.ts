import { diffArrays } from 'diff';

import { docText } from './text';

export type ParaChange = { kind: 'same' | 'added' | 'removed'; text: string };

/** Paragraphs of a ProseMirror document (stanzas/lines kept inside). */
export function paragraphs(doc: unknown): string[] {
  return docText(doc as never).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

/** Paragraph-level difference from `before` to `after`. */
export function paragraphDiff(before: string[], after: string[]): ParaChange[] {
  const out: ParaChange[] = [];
  for (const part of diffArrays(before, after)) {
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'same';
    for (const text of part.value) out.push({ kind, text });
  }
  return out;
}
