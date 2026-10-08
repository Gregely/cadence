import { ApiError, OfflineError, api } from './api';
import { clearPending, savePending } from './lib/pending';
import type { DocFull } from './types';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'offline' | 'error';

export interface SaverOptions {
  /** Build the PATCH body (content already encoded for the kind). */
  body: () => Promise<Record<string, unknown>>;
  onSaved: (doc: DocFull) => void;
  onConflict: (body: Record<string, unknown>) => Promise<void>;
  onState: (state: SaveState, message?: string) => void;
}

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 4000;
const RETRY_MS = 5000;

/**
 * Autosave for one document: debounced, never overlapping, with a local
 * copy of the outgoing body kept until the server confirms it.
 */
export class Saver {
  private docId: number | null = null;
  private base = '';
  private dirty = false;
  private timer = 0;
  private firstDirtyAt = 0;
  private running: Promise<void> | null = null;
  private retryTimer = 0;
  state: SaveState = 'saved';

  constructor(private opts: SaverOptions) {}

  bind(docId: number, base: string): void {
    this.docId = docId;
    this.base = base;
    this.dirty = false;
    this.setState('saved');
  }

  get boundId(): number | null {
    return this.docId;
  }

  get baseUpdatedAt(): string {
    return this.base;
  }

  rebase(updatedAt: string): void {
    this.base = updatedAt;
  }

  touch(): void {
    if (this.docId === null) return;
    if (!this.dirty) this.firstDirtyAt = Date.now();
    this.dirty = true;
    this.setState('unsaved');
    window.clearTimeout(this.timer);
    const waited = Date.now() - this.firstDirtyAt;
    this.timer = window.setTimeout(() => void this.flush(), waited > MAX_WAIT_MS ? 0 : DEBOUNCE_MS);
  }

  isDirty(): boolean {
    return this.dirty || this.running !== null;
  }

  /** Save now if anything is pending; resolves when the server has it (or failed). */
  async flush(keepalive = false): Promise<void> {
    window.clearTimeout(this.timer);
    if (this.running) {
      await this.running;
      if (!this.dirty) return;
    }
    if (!this.dirty || this.docId === null) return;
    this.running = this.save(keepalive).finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async save(keepalive: boolean): Promise<void> {
    const docId = this.docId!;
    this.dirty = false;
    this.setState('saving');
    let body: Record<string, unknown>;
    try {
      body = { ...(await this.opts.body()), if_updated_at: this.base };
    } catch (err) {
      this.dirty = true;
      this.setState('error', err instanceof Error ? err.message : 'Could not prepare the save');
      return;
    }
    savePending({ docId, base: this.base, body, at: new Date().toISOString() });
    try {
      const doc = await api.updateDocument(docId, body, keepalive ? { keepalive: true } : undefined);
      if (this.docId !== docId) return;
      this.base = doc.updated_at;
      clearPending(docId);
      this.opts.onSaved(doc);
      this.setState(this.dirty ? 'unsaved' : 'saved');
      if (this.dirty) this.touch();
    } catch (err) {
      if (this.docId !== docId) return;
      if (err instanceof OfflineError) {
        this.dirty = true;
        this.setState('offline');
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => void this.flush(), RETRY_MS);
      } else if (err instanceof ApiError && err.status === 409) {
        await this.opts.onConflict(body);
        clearPending(docId);
      } else {
        this.dirty = true;
        this.setState('error', err instanceof Error ? err.message : 'Not saved');
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => void this.flush(), RETRY_MS * 3);
      }
    }
  }

  unbind(): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.retryTimer);
    this.docId = null;
    this.dirty = false;
  }

  private setState(state: SaveState, message?: string): void {
    this.state = state;
    this.opts.onState(state, message);
  }
}
