import { h } from '../../lib/dom';
import type { Beat } from '../../types';

/** Placeholder until the beats checklist (Stage D). */
export function beatsEditor(_beats: Beat[], _save: (beats: Beat[]) => Promise<void>): HTMLElement {
  return h('span', { hidden: true });
}
