import { api } from './api';
import type { KindDef } from './types';

const IDLE_MS = 20 * 60 * 1000;
const PROMPT_AFTER_MS = 5 * 60 * 1000;
const PROMPT_AFTER_WORDS = 50;

interface Current {
  id: number | null;
  docId: number;
  wordsStart: number;
  startedAt: number;
  starting: Promise<void> | null;
  checkpoints: ('flowing' | 'fighting')[];
}

export interface SessionHost {
  words(docId: number): number;
  /** Ask for the one-line re-entry note for a finished session. */
  promptNote(sessionId: number, docId: number, checkpoints: ('flowing' | 'fighting')[]): void;
  onChange(): void;
}

/**
 * A writing session starts with the first edit to a document and ends when
 * you end it, switch away, go idle for 20 minutes, or close the page.
 */
export class Sessions {
  current: Current | null = null;
  private idleTimer = 0;

  constructor(private host: SessionHost) {
    window.addEventListener('pagehide', () => void this.end('pagehide'));
  }

  edited(docId: number, kind: KindDef): void {
    if (!kind.sessions_allowed) return;
    if (this.current && this.current.docId !== docId) void this.end('switch');
    if (!this.current) {
      const cur: Current = {
        id: null,
        docId,
        wordsStart: this.host.words(docId),
        startedAt: Date.now(),
        starting: null,
        checkpoints: [],
      };
      cur.starting = api.startSession(docId, cur.wordsStart)
        .then((s) => { cur.id = s.id; })
        .catch(() => { /* offline: the session simply is not recorded */ })
        .finally(() => { cur.starting = null; });
      this.current = cur;
      this.host.onChange();
    }
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => void this.end('idle'), IDLE_MS);
  }

  elapsedMinutes(): number {
    return this.current ? Math.floor((Date.now() - this.current.startedAt) / 60000) : 0;
  }

  async checkpoint(feeling: 'flowing' | 'fighting'): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.checkpoints.push(feeling);
    if (cur.starting) await cur.starting;
    if (cur.id !== null) await api.checkpoint(cur.id, feeling).catch(() => undefined);
  }

  /** End the session. With a prompt (explicit end or switching), ask for the note. */
  async end(reason: 'explicit' | 'switch' | 'idle' | 'pagehide'): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    window.clearTimeout(this.idleTimer);
    this.host.onChange();
    if (cur.starting) await cur.starting;
    if (cur.id === null) return;
    const words = this.host.words(cur.docId);
    const keepalive = reason === 'pagehide';
    await api.endSession(cur.id, { words_end: words }, keepalive).catch(() => undefined);
    // Ask for the note when you end deliberately, or when leaving a session
    // that amounted to something; a quick touch-up passes silently.
    const substantial = Date.now() - cur.startedAt >= PROMPT_AFTER_MS || Math.abs(words - cur.wordsStart) >= PROMPT_AFTER_WORDS;
    if (reason === 'explicit' || (reason !== 'pagehide' && substantial)) {
      this.host.promptNote(cur.id, cur.docId, cur.checkpoints);
    }
  }
}
