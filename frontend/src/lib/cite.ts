import type { Source } from '../types';

/** "Thoreau, “Walking”, 1862, p. 4" — used for footnotes. */
export function footnoteText(s: Pick<Source, 'author' | 'title' | 'published'>, page = ''): string {
  const bits = [s.author, s.title ? `“${s.title}”` : '', s.published].filter(Boolean);
  return bits.join(', ') + (page ? `, p. ${page}` : '');
}

/** "(Thoreau 1862, p. 4)" — an author–date inline citation. */
export function inlineCitation(s: Pick<Source, 'author' | 'title' | 'published'>, page = ''): string {
  const name = s.author.trim() ? s.author.trim().split(/\s+/).pop()! : s.title.trim();
  const year = s.published.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] ?? '';
  return `(${[name, year].filter(Boolean).join(' ')}${page ? `, p. ${page}` : ''})`;
}
