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
