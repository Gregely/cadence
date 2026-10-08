import { store } from './storage';

/**
 * Unsaved edits kept on this device until the server confirms them, so a
 * dropped connection or closed tab never loses writing.
 *
 * What is stored is exactly the request body that would be sent. For
 * encrypted kinds that body only ever holds ciphertext.
 */
export interface Pending {
  docId: number;
  base: string; // updated_at the edits were made on top of
  body: Record<string, unknown>;
  at: string;
}

const PREFIX = 'cadence.pending.';

export function savePending(p: Pending): void {
  store.set(PREFIX + p.docId, JSON.stringify(p));
}

export function loadPending(docId: number): Pending | null {
  const p = store.json<Pending | null>(PREFIX + docId, null);
  return p && p.docId === docId && p.body ? p : null;
}

export function clearPending(docId: number): void {
  store.remove(PREFIX + docId);
}

export function allPending(): Pending[] {
  return store.keys(PREFIX).map((k) => store.json<Pending | null>(k, null)).filter((p): p is Pending => !!p);
}
