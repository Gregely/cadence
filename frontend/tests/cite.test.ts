import { describe, expect, it } from 'vitest';

import { footnoteText, inlineCitation } from '../src/lib/cite';

describe('citations', () => {
  const s = { author: 'Henry David Thoreau', title: 'Walking', published: 'June 1862' };
  it('formats footnotes', () => {
    expect(footnoteText(s, '4')).toBe('Henry David Thoreau, “Walking”, June 1862, p. 4');
    expect(footnoteText({ author: '', title: 'Anon', published: '' })).toBe('“Anon”');
  });
  it('formats author–date citations', () => {
    expect(inlineCitation(s, '4')).toBe('(Thoreau 1862, p. 4)');
    expect(inlineCitation({ author: '', title: 'Field Notes', published: '' })).toBe('(Field Notes)');
  });
});
