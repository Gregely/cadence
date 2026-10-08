import { describe, expect, it } from 'vitest';

import { inManuscript, isStub, manuscriptWords, statusSymbol } from '../src/lib/roles';
import type { DocSummary } from '../src/types';
import { kind } from './kinds';

const d = (id: number, role: string | null, words: number, status: string | null = null): DocSummary => ({
  id, kind: 'fiction', folder_id: 1, sort_order: id, title: `D${id}`, status, word_target: null,
  created_at: '', updated_at: '', last_opened_at: null, role, words,
});

describe('roles', () => {
  const fiction = kind('fiction');
  const essay = kind('essay');

  it('only manuscript roles count', () => {
    expect(inManuscript(fiction, d(1, 'scene', 10))).toBe(true);
    expect(inManuscript(fiction, d(2, 'misc', 10))).toBe(false);
    expect(inManuscript(fiction, d(3, null, 10))).toBe(true); // default role
    expect(manuscriptWords(fiction, [d(1, 'scene', 10), d(2, 'misc', 99), d(3, 'scene', 5)])).toBe(15);
    expect(inManuscript(essay, d(4, null, 1))).toBe(true);
  });

  it('stubs are empty manuscript documents', () => {
    expect(isStub(fiction, d(1, 'scene', 0))).toBe(true);
    expect(isStub(fiction, d(2, 'misc', 0))).toBe(false);
    expect(isStub(fiction, d(3, 'scene', 4))).toBe(false);
  });

  it('every fiction status has its own shape', () => {
    const shapes = fiction.statuses.map((s) => statusSymbol(fiction, s));
    expect(new Set(shapes).size).toBe(4);
    expect(statusSymbol(essay, 'draft')).toBe('');
  });
});
