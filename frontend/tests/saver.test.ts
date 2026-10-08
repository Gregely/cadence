import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPending } from '../src/lib/pending';
import { Saver, type SaveState } from '../src/saver';

function setup(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }));
  const states: SaveState[] = [];
  const conflicts: Record<string, unknown>[] = [];
  let content = 'v1';
  const saver = new Saver({
    body: async () => ({ content_json: content }),
    onSaved: () => undefined,
    onConflict: async (b) => { conflicts.push(b); },
    onState: (s) => states.push(s),
  });
  return { saver, calls, states, conflicts, set: (c: string) => { content = c; } };
}

const ok = (updated: string) => () => new Response(JSON.stringify({ id: 1, updated_at: updated }), { status: 200 });

describe('Saver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('debounces edits into one save with the base timestamp', async () => {
    const t = setup([ok('t2')]);
    t.saver.bind(1, 't1');
    t.saver.touch();
    t.saver.touch();
    t.set('v2');
    t.saver.touch();
    await vi.advanceTimersByTimeAsync(800);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.body).toEqual({ content_json: 'v2', if_updated_at: 't1' });
    expect(t.saver.baseUpdatedAt).toBe('t2');
    expect(t.states.at(-1)).toBe('saved');
    expect(loadPending(1)).toBeNull();
  });

  it('keeps the edit on the device while offline and retries', async () => {
    const t = setup([() => Promise.reject(new TypeError('network')), ok('t2')]);
    t.saver.bind(1, 't1');
    t.saver.touch();
    await vi.advanceTimersByTimeAsync(800);
    expect(t.states.at(-1)).toBe('offline');
    expect(loadPending(1)?.body).toEqual({ content_json: 'v1', if_updated_at: 't1' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.calls).toHaveLength(2);
    expect(t.states.at(-1)).toBe('saved');
    expect(loadPending(1)).toBeNull();
  });

  it('hands a 409 to the conflict handler', async () => {
    const t = setup([() => new Response(JSON.stringify({ detail: 'changed' }), { status: 409 })]);
    t.saver.bind(1, 't1');
    t.saver.touch();
    await vi.advanceTimersByTimeAsync(800);
    expect(t.conflicts).toEqual([{ content_json: 'v1', if_updated_at: 't1' }]);
  });
});
