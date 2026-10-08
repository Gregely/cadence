import type { App } from '../../app';
import { clear } from '../../lib/dom';

/**
 * The side pane is shared by the manuscript tools (details, split view,
 * project lists). Only one is shown at a time.
 */
export interface PaneOwner {
  id: string;
  close(): void | Promise<void>;
}

let current: PaneOwner | null = null;

export function paneOwner(): string | null {
  return current?.id ?? null;
}

export async function showPane(app: App, owner: PaneOwner, el: HTMLElement): Promise<void> {
  if (current && current.id !== owner.id) await current.close();
  current = owner;
  clear(app.sidePaneSlot);
  app.sidePaneSlot.hidden = false;
  app.sidePaneSlot.dataset.owner = owner.id;
  app.sidePaneSlot.appendChild(el);
}

export function hidePane(app: App, ownerId: string): void {
  if (current?.id !== ownerId) return;
  current = null;
  clear(app.sidePaneSlot);
  app.sidePaneSlot.hidden = true;
  delete app.sidePaneSlot.dataset.owner;
}
