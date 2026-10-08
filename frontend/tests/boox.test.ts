import { describe, expect, it } from 'vitest';

import { sampleDoc } from '../src/boox';

describe('boox test document', () => {
  it('has about 5,000 words and is deterministic', () => {
    const a = sampleDoc();
    expect(a.words).toBeGreaterThanOrEqual(5000);
    expect(a.words).toBeLessThan(5200);
    expect(JSON.stringify(sampleDoc().doc)).toBe(JSON.stringify(a.doc));
  });
});
