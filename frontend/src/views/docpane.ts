import type { JSONContent } from '@tiptap/core';

import { api } from '../api';
import type { App } from '../app';
import { DocEditor } from '../editor/doc-editor';
import { clear } from '../lib/dom';
import { clearPending, loadPending } from '../lib/pending';
import { store } from '../lib/storage';
import { Saver, type SaveState } from '../saver';
import { settings } from '../settings';
import type { DocFull, DocSummary, KindDef } from '../types';
import { toast } from '../ui/dialogs';

export interface PaneHost {
  app: App;
  kind: KindDef;
  scroller: HTMLElement;
  onFocus?(pane: DocPane): void;
  onChange?(pane: DocPane): void;
  onState?(pane: DocPane, state: SaveState, message?: string): void;
  onSaved?(pane: DocPane, doc: DocFull): void;
}

/**
 * One document's editor with its own autosave, its own local copy of
 * unsaved edits and its own conflict handling. Used wherever several
 * documents are on screen at once (the combined folder view, split view):
 * every document keeps saving to itself, never through a shared editor.
 */
export class DocPane {
  doc: DocFull | null = null;
  editor: DocEditor | null = null;
  readonly saver: Saver;
  state: SaveState = 'saved';
  private loading: Promise<void> | null = null;
  private destroyed = false;

  constructor(private host: PaneHost, public summary: DocSummary, readonly mountEl: HTMLElement) {
    this.saver = new Saver({
      body: async () => ({ content_json: await host.app.codec(host.kind).encode(this.editor!.getJSON()) }),
      onSaved: (doc) => {
        this.doc = this.doc ? { ...this.doc, ...doc } : doc;
        this.summary = { ...this.summary, ...doc };
        host.onSaved?.(this, doc);
      },
      onConflict: (body) => this.conflict(body),
      onState: (s, m) => {
        this.state = s;
        host.onState?.(this, s, m);
      },
    });
    host.app.panes.add(this);
  }

  get id(): number {
    return this.summary.id;
  }

  get mounted(): boolean {
    return this.editor !== null;
  }

  /** Load the document and create its editor (once). */
  mount(focus?: 'start' | 'end' | 'cursor'): Promise<void> {
    if (!this.loading) this.loading = this.load();
    return this.loading.then(() => {
      if (!focus || !this.editor) return;
      if (focus === 'cursor') {
        const pos = Number(store.get(`cadence.cursor.${this.id}`));
        if (Number.isFinite(pos) && pos > 0) this.editor.setCursor(pos);
        this.editor.focus();
      } else this.editor.focusAt(focus);
    });
  }

  private async load(): Promise<void> {
    const kind = this.host.kind;
    const codec = this.host.app.codec(kind);
    let doc: DocFull;
    let content: JSONContent;
    try {
      doc = await api.getDocument(this.id);
      content = await codec.decode(doc.content_json);
    } catch {
      this.mountEl.textContent = 'This document could not be opened.';
      return;
    }
    if (this.destroyed) return;
    // Edits that never reached the server, as in the single-document view.
    const pending = loadPending(doc.id);
    let restored = false;
    if (pending) {
      const body = pending.body as { content_json?: string };
      if (pending.base === doc.updated_at && body.content_json) {
        try {
          content = await codec.decode(body.content_json);
          restored = true;
        } catch {
          clearPending(doc.id);
        }
      } else if (body.content_json) {
        await api.createSnapshot(doc.id, 'Unsaved edits from this device', body.content_json).catch(() => undefined);
        clearPending(doc.id);
        toast('Edits from this device that never reached the server were kept as a snapshot.');
      }
    }
    this.doc = doc;
    this.createEditor(content);
    this.saver.bind(doc.id, doc.updated_at);
    if (restored) this.saver.touch();
  }

  private createEditor(content: JSONContent): void {
    this.editor?.destroy();
    clear(this.mountEl);
    this.mountEl.style.minHeight = ''; // the estimate held the space until now
    const kind = this.host.kind;
    this.editor = new DocEditor({
      kind,
      mount: this.mountEl,
      scroller: this.host.scroller,
      content,
      spellcheck: !kind.encrypted,
      typewriter: () => settings().typewriter && this.editor?.editor.isFocused === true,
      onChange: () => {
        if (!this.doc) return;
        this.saver.touch();
        this.host.app.sessions.edited(this.doc.id, kind);
        this.host.onChange?.(this);
      },
      onSelection: () => {
        if (this.editor) store.set(`cadence.cursor.${this.id}`, String(this.editor.cursor()));
      },
    });
    this.editor.editor.on('focus', () => this.host.onFocus?.(this));
    if (this.host.app.forwardOnly) this.editor.setForwardOnly(true, false);
  }

  words(): number {
    return this.editor ? this.editor.words() : this.summary.words ?? 0;
  }

  isEmpty(): boolean {
    return this.editor ? this.editor.isEmpty() : (this.summary.words ?? 0) === 0;
  }

  rebase(updatedAt: string): void {
    this.saver.rebase(updatedAt);
    if (this.doc) this.doc.updated_at = updatedAt;
  }

  flush(keepalive = false): Promise<void> {
    return this.saver.flush(keepalive);
  }

  /** The document changed elsewhere: keep this version as a snapshot, show theirs. */
  private async conflict(body: Record<string, unknown>): Promise<void> {
    await api.createSnapshot(this.id, 'Edits from this device (changed elsewhere)', body.content_json as string).catch(() => undefined);
    const fresh = await api.getDocument(this.id);
    this.doc = fresh;
    this.createEditor(await this.host.app.codec(this.host.kind).decode(fresh.content_json));
    this.saver.bind(fresh.id, fresh.updated_at);
    toast(`“${fresh.title || 'Untitled'}” was changed elsewhere; your version was kept as a snapshot.`);
  }

  /** Reload from the server (after a restore elsewhere). */
  async reload(): Promise<void> {
    if (!this.editor) return;
    await this.flush();
    const fresh = await api.getDocument(this.id);
    this.doc = fresh;
    this.summary = { ...this.summary, ...fresh };
    this.createEditor(await this.host.app.codec(this.host.kind).decode(fresh.content_json));
    this.saver.bind(fresh.id, fresh.updated_at);
  }

  async close(): Promise<void> {
    await this.flush();
    this.destroy();
  }

  destroy(): void {
    this.destroyed = true;
    this.saver.unbind();
    this.editor?.destroy();
    this.editor = null;
    this.host.app.panes.delete(this);
  }
}
