import { describe, expect, it } from 'vitest';

import { countWords, fuzzyScore, smarten } from '../src/lib/text';

describe('text helpers', () => {
  it('counts words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  one two\nthree\t four ')).toBe(4);
  });

  it('smartens quotes and dashes', () => {
    expect(smarten(`"Hello," she said -- it's 'fine'...`)).toBe('“Hello,” she said — it’s ‘fine’…');
  });

  it('fuzzy matches subsequences and prefers direct hits', () => {
    expect(fuzzyScore('wlk', 'On walking slowly')).not.toBeNull();
    expect(fuzzyScore('xyz', 'On walking slowly')).toBeNull();
    expect(fuzzyScore('walk', 'Walking')!).toBeGreaterThan(fuzzyScore('walk', 'We all like kites')!);
  });
});

describe('docText', async () => {
  const { docText } = await import('../src/lib/text');
  it('keeps lines and stanzas', () => {
    expect(docText({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: '\tb' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
    ] })).toBe('a\n\tb\n\nc');
  });
});
