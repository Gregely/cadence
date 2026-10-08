import { describe, expect, it } from 'vitest';

import { WrongKey, deriveKey, newVault, seal, unlock, unseal } from '../src/crypto/vault';
import fixture from './fixtures/vault.json';

describe('diary encryption', () => {
  it('seals and unseals with AES-GCM and a fresh IV each time', async () => {
    const { params, key } = await newVault('a long passphrase', 100_000);
    const a = await seal(key, { doc: 'hello' });
    const b = await seal(key, { doc: 'hello' });
    expect(a).not.toBe(b);
    expect(Object.keys(JSON.parse(a)).sort()).toEqual(['alg', 'ct', 'iv', 'v']);
    expect(a).not.toContain('hello');
    expect(await unseal(key, a)).toEqual({ doc: 'hello' });
    expect(params.iterations).toBe(100_000);
  });

  it('refuses a wrong passphrase and tampered ciphertext', async () => {
    const { params, key } = await newVault('right passphrase', 100_000);
    expect(await unlock('wrong passphrase', params)).toBeNull();
    expect(await unlock('right passphrase', params)).not.toBeNull();
    const env = JSON.parse(await seal(key, { x: 1 }));
    const ct = atob(env.ct);
    env.ct = btoa(String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1));
    await expect(unseal(key, JSON.stringify(env))).rejects.toBeInstanceOf(WrongKey);
  });

  it('keys are not extractable', async () => {
    const key = await deriveKey('x'.repeat(12), btoa('0123456789abcdef'), 1000);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
  });

  it('opens envelopes produced by the Python test helpers (same format)', async () => {
    const key = await unlock(fixture.passphrase, fixture.vault);
    expect(key).not.toBeNull();
    const out = await unseal<{ doc: { content: { content: { text: string }[] }[] } }>(key!, fixture.entry);
    expect(out.doc.content[0]!.content[0]!.text).toBe('written in python');
  });
});
