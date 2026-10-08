import type { DocSummary, KindDef } from '../types';

/** Is this document part of the manuscript (counted, in the flow, compiled)? */
export function inManuscript(kind: KindDef, doc: Pick<DocSummary, 'role'>): boolean {
  if (!kind.roles.length) return true;
  const role = kind.roles.find((r) => r.id === (doc.role ?? kind.default_role));
  return role ? role.manuscript : true;
}

export function roleLabel(kind: KindDef, role: string | null): string {
  return kind.roles.find((r) => r.id === role)?.label ?? '';
}

/** A stub: a manuscript document with no text yet. */
export function isStub(kind: KindDef, doc: DocSummary): boolean {
  return inManuscript(kind, doc) && (doc.words ?? 0) === 0;
}

export function statusSymbol(kind: KindDef, status: string | null): string {
  return status ? kind.status_symbols[status] ?? '' : '';
}

/** Words of the manuscript documents in a list. */
export function manuscriptWords(kind: KindDef, docs: DocSummary[]): number {
  return docs.filter((d) => inManuscript(kind, d)).reduce((n, d) => n + (d.words ?? 0), 0);
}
