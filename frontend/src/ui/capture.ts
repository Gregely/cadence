import { api } from '../api';
import { h } from '../lib/dom';
import type { KindDef } from '../types';

/**
 * Global capture: a one-line box that saves to the inbox, tagged with the
 * current kind, and puts focus back exactly where it was.
 */
export function openCapture(kind: KindDef | null, onSaved?: () => void): void {
  if (document.querySelector('.capture')) {
    document.querySelector<HTMLInputElement>('.capture input')?.focus();
    return;
  }
  const previous = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const restore = () => {
    previous?.focus?.({ preventScroll: true });
    if (range && previous?.isContentEditable) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  if (kind && !kind.capture_allowed) {
    const note = h('div', { class: 'capture', role: 'status' },
      h('p', null, `Capture is off in ${kind.label}: the inbox is not encrypted.`));
    document.body.appendChild(note);
    window.setTimeout(() => note.remove(), 3000);
    return;
  }

  const input = h('input', {
    type: 'text',
    placeholder: kind ? `Capture to inbox (from ${kind.label})` : 'Capture to inbox',
    'aria-label': 'Capture to inbox',
    autocomplete: 'off',
    maxlength: '4000',
  }) as HTMLInputElement;
  const status = h('span', { class: 'capture-status', role: 'status' });
  const box = h('form', { class: 'capture', role: 'dialog', 'aria-label': 'Capture' }, input, status);
  const close = () => {
    box.remove();
    restore();
  };
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      close();
      return;
    }
    input.disabled = true;
    try {
      await api.capture(text, kind ? kind.id : null);
      status.textContent = 'Saved to inbox';
      onSaved?.();
      window.setTimeout(close, 600);
    } catch (err) {
      input.disabled = false;
      status.textContent = err instanceof Error ? err.message : 'Could not save';
      input.focus();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (document.body.contains(box) && !box.contains(document.activeElement) && !input.disabled && !input.value.trim()) {
        box.remove();
      }
    }, 150);
  });
  document.body.appendChild(box);
  input.focus();
}
