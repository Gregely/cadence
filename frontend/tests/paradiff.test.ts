import { describe, expect, it } from 'vitest';

import { paragraphDiff, paragraphs } from '../src/lib/paradiff';

describe('paragraph diff', () => {
  it('splits a document into paragraphs', () => {
    const doc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One.' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two.' }] },
    ] };
    expect(paragraphs(doc)).toEqual(['One.', 'Two.']);
  });

  it('marks whole paragraphs added and removed', () => {
    expect(paragraphDiff(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
  });
});
