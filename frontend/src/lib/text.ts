/** Count words the way a writer would: runs of non-space characters. */
export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

/** Curly quotes and dashes for short single-line fields (titles, notes). */
export function smarten(text: string): string {
  return text
    .replace(/(^|[\s([{—-])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—-])'/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/---/g, '—')
    .replace(/--/g, '—')
    .replace(/\.\.\./g, '…');
}

/** Simple subsequence scoring for quick-open. Higher is better; null = no match. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - Math.min(found - ti, 10);
    if (found === 0 || /[\s\-_:]/.test(t[found - 1] ?? '')) score += 8;
    ti = found + 1;
  }
  return score;
}

interface JsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'listItem']);

/** Plain text of a ProseMirror JSON document, keeping line and stanza breaks. */
export function docText(doc: JsonNode | null | undefined): string {
  const out: string[] = [];
  const walk = (n: JsonNode) => {
    if (n.type === 'text') out.push(n.text ?? '');
    else if (n.type === 'hardBreak') out.push('\n');
    else if (n.type === 'sectionBreak') out.push('* * *\n\n');
    else if (n.type === 'footnote') out.push(` [${String(n.attrs?.text ?? '')}]`);
    for (const c of n.content ?? []) walk(c);
    if (n.type && BLOCKS.has(n.type)) out.push('\n\n');
  };
  if (doc) walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
