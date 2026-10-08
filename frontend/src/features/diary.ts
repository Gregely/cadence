import { api } from '../api';
import type { App, Codec, Feature } from '../app';
import { ITERATIONS, type VaultParams, cryptoAvailable, newVault, seal, unlock, unseal } from '../crypto/vault';
import { longDate, timeLabel } from '../lib/dates';
import { clear, h } from '../lib/dom';
import { toMarkdown } from '../lib/markdown';
import { clearPending } from '../lib/pending';
import { settings, updateSettings } from '../settings';
import type { KindDef } from '../types';
import { ask, confirmAction, panel, toast } from '../ui/dialogs';

/**
 * Encrypted kinds: unlock with a passphrase, keep the key in memory only,
 * lock again after inactivity. Nothing decrypted is ever stored.
 */
const keys = new Map<string, CryptoKey>();
let lastActivity = Date.now();
let watching = false;

function touch(): void {
  lastActivity = Date.now();
}

function watchActivity(app: App): void {
  if (watching) return;
  watching = true;
  for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
    document.addEventListener(ev, touch, { capture: true, passive: true });
  }
  const check = () => {
    if (!keys.size) return;
    const limit = settings().autolockMinutes * 60_000;
    if (Date.now() - lastActivity >= limit) void lockAll(app, 'Locked after inactivity.');
  };
  window.setInterval(check, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  // A page restored from the back/forward cache still has the key in memory.
  window.addEventListener('pageshow', check);
}

export function isUnlocked(kindId: string): boolean {
  return keys.has(kindId);
}

/** Drop every key and anything decrypted on screen. */
export async function lockAll(app: App, message?: string): Promise<void> {
  if (!keys.size) return;
  const current = app.kind;
  if (current?.encrypted && keys.has(current.id)) {
    // Save what is typed (this still needs the key), then forget it.
    await app.saver.flush();
  }
  keys.clear();
  app.renderTools();
  for (const el of document.querySelectorAll('.modal-backdrop, .menu, .popover, .format-bar:not([hidden])')) el.remove();
  if (current?.encrypted) await app.showLocked(current, lockScreen(app, current, app.doc?.id, message));
}

function codecFor(kind: KindDef): Codec {
  return {
    decode: async (raw) => {
      const key = keys.get(kind.id);
      if (!key) throw new Error('locked');
      return (await unseal<{ doc: never }>(key, raw)).doc;
    },
    encode: async (doc) => {
      const key = keys.get(kind.id);
      if (!key) throw new Error(`${kind.label} is locked`);
      return seal(key, { doc });
    },
  };
}

function passwordInput(label: string, autocomplete: string): HTMLInputElement {
  return h('input', {
    type: 'password', autocomplete, 'aria-label': label, placeholder: label, spellcheck: 'false',
    autocapitalize: 'off', autocorrect: 'off',
  }) as HTMLInputElement;
}

function lockScreen(app: App, kind: KindDef, docId?: number, message?: string): HTMLElement {
  const box = h('section', { class: 'screen lock-screen', 'aria-label': `${kind.label} is locked` });
  const status = h('p', { class: 'lock-status', role: 'status' }, message ?? '');
  const proceed = async () => {
    watchActivity(app);
    touch();
    app.renderTools();
    app.closeScreen();
    const ok = docId !== undefined && (await app.openDocument(docId, { push: false }));
    if (!ok) await app.switchKind(kind.id);
  };

  if (!cryptoAvailable()) {
    box.append(h('h1', null, `${kind.label} needs a secure connection`),
      h('p', null, 'Encryption in the browser only works over HTTPS or on localhost. Open Cadence through its tailscale serve HTTPS address.'));
    return box;
  }

  void api.vault(kind.id).then(({ vault }) => {
    clear(box);
    if (vault) renderUnlock(vault);
    else renderSetup();
  }).catch(() => { status.textContent = 'The server could not be reached.'; box.append(status); });

  const renderUnlock = (vault: VaultParams) => {
    const input = passwordInput('Passphrase', 'current-password');
    const button = h('button', { type: 'submit' }, 'Unlock') as HTMLButtonElement;
    const form = h('form', { class: 'lock-form' }, h('h1', null, `${kind.label} is locked`), input, h('div', { class: 'row-actions' }, button), status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = input.value;
      if (!pass) return;
      button.disabled = true;
      status.textContent = 'Unlocking…';
      try {
        const key = await unlock(pass, vault);
        if (!key) {
          status.textContent = 'That passphrase does not open the diary.';
          input.select();
          return;
        }
        keys.set(kind.id, key);
        input.value = '';
        await proceed();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Could not unlock.';
      } finally {
        button.disabled = false;
      }
    });
    box.append(form);
    input.focus();
  };

  const renderSetup = () => {
    const pass = passwordInput('New passphrase', 'new-password');
    const again = passwordInput('Repeat the passphrase', 'new-password');
    const understood = h('input', { type: 'checkbox', id: 'lost-means-lost' }) as HTMLInputElement;
    const button = h('button', { type: 'submit' }, `Encrypt my ${kind.label.toLowerCase()}`) as HTMLButtonElement;
    const form = h('form', { class: 'lock-form' },
      h('h1', null, `Set a passphrase for your ${kind.label.toLowerCase()}`),
      h('p', null, `Entries are encrypted in this browser before they are saved. The server only ever stores ciphertext, so they are not searchable and never appear in the inbox.`),
      h('p', { class: 'warning', role: 'note' },
        h('strong', null, 'If you lose this passphrase, your entries are lost. '),
        'There is no reset and no recovery, by anyone. Write it down and keep it somewhere safe. ',
        'You can save a decrypted copy of all entries at any time from the document menu (“Export diary, decrypted”).'),
      h('p', { class: 'quiet-text' }, 'Use several words; at least 10 characters. Unlocking takes a moment by design.'),
      pass, again,
      h('label', { class: 'check', for: 'lost-means-lost' }, understood, ' I understand that a lost passphrase means lost entries.'),
      h('div', { class: 'row-actions' }, button), status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pass.value.length < 10) { status.textContent = 'Use at least 10 characters.'; return; }
      if (pass.value !== again.value) { status.textContent = 'The two passphrases differ.'; return; }
      if (!understood.checked) { status.textContent = 'Please tick the box to confirm you understand.'; return; }
      button.disabled = true;
      status.textContent = 'Setting up…';
      try {
        const { params, key } = await newVault(pass.value, ITERATIONS);
        await api.createVault(kind.id, params);
        keys.set(kind.id, key);
        pass.value = '';
        again.value = '';
        await proceed();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Could not set up encryption.';
        button.disabled = false;
      }
    });
    box.append(form);
    pass.focus();
  };

  box.append(h('p', { class: 'quiet-text' }, 'Loading…'));
  return box;
}

/** Decrypt every entry here in the browser and save one Markdown file. */
async function decryptedExport(app: App, kind: KindDef): Promise<void> {
  const ok = await confirmAction(`Save all ${kind.label.toLowerCase()} entries as a readable file?`, 'Save decrypted copy',
    'The file is made here in your browser and contains your entries as plain text. Keep it somewhere private.');
  if (!ok) return;
  await app.saver.flush();
  const key = keys.get(kind.id);
  if (!key) return;
  const tree = await api.tree(kind.id);
  const docs = [...tree.documents].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const parts = [`# ${kind.label}\n`];
  for (const d of docs) {
    const full = await api.getDocument(d.id);
    const { doc } = await unseal<{ doc: never }>(key, full.content_json);
    parts.push(`## ${longDate(d.created_at)}, ${timeLabel(d.created_at)}\n\n${toMarkdown(doc, 1)}\n`);
  }
  const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${kind.id}-${new Date().toISOString().slice(0, 10)}.md`, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(`Saved ${docs.length} entr${docs.length === 1 ? 'y' : 'ies'}.`);
}

async function changePassphrase(app: App, kind: KindDef): Promise<void> {
  panel('Change passphrase', (close) => {
    const current = passwordInput('Current passphrase', 'current-password');
    const pass = passwordInput('New passphrase', 'new-password');
    const again = passwordInput('Repeat the new passphrase', 'new-password');
    const status = h('p', { class: 'lock-status', role: 'status' });
    const button = h('button', { type: 'submit' }, 'Change passphrase') as HTMLButtonElement;
    const form = h('form', { class: 'lock-form' },
      h('p', { class: 'warning' }, 'Every entry and snapshot is re-encrypted with the new passphrase. The old one will no longer work.'),
      current, pass, again, h('div', { class: 'row-actions' }, button), status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pass.value.length < 10) { status.textContent = 'Use at least 10 characters.'; return; }
      if (pass.value !== again.value) { status.textContent = 'The two new passphrases differ.'; return; }
      button.disabled = true;
      try {
        status.textContent = 'Checking…';
        const { vault } = await api.vault(kind.id);
        const oldKey = vault ? await unlock(current.value, vault) : null;
        if (!oldKey) { status.textContent = 'The current passphrase is not right.'; button.disabled = false; return; }
        await app.saver.flush();
        status.textContent = 'Re-encrypting…';
        const items = await api.vaultItems(kind.id);
        const { params, key } = await newVault(pass.value, ITERATIONS);
        const reseal = async (map: Record<string, string>) => {
          const out: Record<string, string> = {};
          for (const [id, raw] of Object.entries(map)) out[id] = await seal(key, await unseal(oldKey, raw));
          return out;
        };
        await api.rekey(kind.id, { vault: params, documents: await reseal(items.documents), snapshots: await reseal(items.snapshots) });
        keys.set(kind.id, key);
        for (const id of Object.keys(items.documents)) clearPending(Number(id));
        current.value = pass.value = again.value = '';
        close();
        toast('Passphrase changed.');
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Could not change the passphrase.';
        button.disabled = false;
      }
    });
    return form;
  });
}

export const diaryFeature: Feature = {
  async beforeKind(app, kind, docId) {
    if (!kind.encrypted || keys.has(kind.id)) return true;
    await app.showLocked(kind, lockScreen(app, kind, docId));
    return false;
  },
  codec(_app, kind) {
    return kind.encrypted ? codecFor(kind) : null;
  },
  topbar(app) {
    if (!app.kind.encrypted || !keys.has(app.kind.id)) return [];
    return [h('button', { type: 'button', class: 'quiet', title: 'Lock now', onclick: () => void lockAll(app) }, 'Lock')];
  },
  documentMenu(app) {
    if (!app.kind.encrypted || !keys.has(app.kind.id)) return [];
    const kind = app.kind;
    return [
      { label: '', run: () => undefined, separator: true },
      { label: `Export ${kind.label.toLowerCase()}, decrypted…`, run: () => void decryptedExport(app, kind) },
      { label: 'Change passphrase…', run: () => void changePassphrase(app, kind) },
      { label: 'Lock now', run: () => void lockAll(app) },
    ];
  },
  settingsMenu(app) {
    if (!app.kinds.some((k) => k.encrypted)) return [];
    return [
      { label: '', run: () => undefined, separator: true },
      { label: `Auto-lock after ${settings().autolockMinutes} min…`, run: () => void (async () => {
        const v = await ask({ title: 'Lock the diary after how many minutes without activity?', value: String(settings().autolockMinutes), type: 'number' });
        const n = Number(v);
        if (v !== null && Number.isFinite(n) && n >= 1 && n <= 120) updateSettings({ autolockMinutes: Math.round(n) });
      })() },
      keys.size ? { label: 'Lock diary now', run: () => void lockAll(app) } : null,
    ];
  },
  onEdit() {
    touch();
  },
};
