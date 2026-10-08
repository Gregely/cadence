import { h } from '../lib/dom';

/** Small modal dialogs that work everywhere (no window.prompt on e-ink). */

let openCount = 0;
export function dialogOpen(): boolean {
  return openCount > 0;
}

function modal(content: HTMLElement, onClose: () => void, label: string): { close: () => void; root: HTMLElement } {
  const previous = document.activeElement as HTMLElement | null;
  const root = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, content));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    previous?.focus?.({ preventScroll: true });
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(root);
  openCount++;
  return { close, root };
}

export function ask(opts: {
  title: string;
  value?: string;
  placeholder?: string;
  ok?: string;
  hint?: string;
  type?: string;
  multiline?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = (opts.multiline
      ? h('textarea', { rows: '4', placeholder: opts.placeholder ?? '' })
      : h('input', { type: opts.type ?? 'text', placeholder: opts.placeholder ?? '', autocomplete: 'off' })) as
      HTMLInputElement | HTMLTextAreaElement;
    input.value = opts.value ?? '';
    const form = h('form', { class: 'dialog-form' },
      h('label', { class: 'dialog-title' }, opts.title, input),
      opts.hint ? h('p', { class: 'dialog-hint' }, opts.hint) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'quiet', onclick: () => m.close() }, 'Cancel'),
        h('button', { type: 'submit' }, opts.ok ?? 'OK')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = input.value;
      m.close();
    });
    if (opts.multiline) {
      input.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }
    const m = modal(form, () => resolve(result), opts.title);
    input.focus();
    if (input instanceof HTMLInputElement) input.select();
  });
}

export function confirmAction(message: string, ok = 'OK', detail?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const okBtn = h('button', { type: 'button', onclick: () => { result = true; m.close(); } }, ok);
    const body = h('div', { class: 'dialog-form' },
      h('p', { class: 'dialog-title' }, message),
      detail ? h('p', { class: 'dialog-hint' }, detail) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'quiet', onclick: () => m.close() }, 'Cancel'), okBtn));
    const m = modal(body, () => resolve(result), message);
    okBtn.focus();
  });
}

export function inform(title: string, content: Node | string): Promise<void> {
  return new Promise((resolve) => {
    const okBtn = h('button', { type: 'button', onclick: () => m.close() }, 'Close');
    const body = h('div', { class: 'dialog-form' },
      h('p', { class: 'dialog-title' }, title),
      typeof content === 'string' ? h('p', { class: 'dialog-hint' }, content) : content,
      h('div', { class: 'dialog-actions' }, okBtn));
    const m = modal(body, () => resolve(), title);
    okBtn.focus();
  });
}

/** A generic panel in a modal; the caller fills it. */
export function panel(title: string, build: (close: () => void) => HTMLElement, wide = false): { close: () => void } {
  const holder = h('div', { class: `panel-body${wide ? ' wide' : ''}` });
  const closeBtn = h('button', { type: 'button', class: 'quiet close', 'aria-label': 'Close', onclick: () => m.close() }, '×');
  const wrap = h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title), closeBtn), holder);
  const m = modal(wrap, () => undefined, title);
  holder.appendChild(build(() => m.close()));
  m.root.querySelector('.modal')?.classList.add(wide ? 'modal-wide' : 'modal-panel');
  const first = holder.querySelector<HTMLElement>('input, button, select, textarea, [tabindex="0"]');
  (first ?? closeBtn).focus();
  return m;
}

export interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
}

/** Popup menu anchored to an element; keyboard navigable. */
export function menu(anchor: HTMLElement, items: (MenuItem | null)[]): void {
  document.querySelector('.menu')?.remove();
  const list = items.filter((i): i is MenuItem => i !== null);
  const buttons: HTMLButtonElement[] = [];
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const item of list) {
    if (item.separator) {
      el.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const b = h('button', {
      type: 'button',
      role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': item.checked === undefined ? undefined : String(item.checked),
      disabled: item.disabled,
      onclick: () => {
        close();
        item.run();
      },
    },
    h('span', { class: 'menu-check' }, item.checked ? '✓' : ''),
    h('span', { class: 'menu-label' }, item.label),
    item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null) as HTMLButtonElement;
    buttons.push(b);
    el.appendChild(b);
  }
  const previous = document.activeElement as HTMLElement | null;
  const close = () => {
    el.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e: Event) => {
    if (!el.contains(e.target as Node) && e.target !== anchor) close();
  };
  const onKey = (e: KeyboardEvent) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      previous?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      enabled[(i + 1) % enabled.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  };
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.left));
  let top = r.bottom + 4;
  if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', onKey, true);
  buttons.find((b) => !b.disabled)?.focus();
}

/** A quiet transient message at the bottom of the screen. */
export function toast(message: string, ms = 3500): void {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}
