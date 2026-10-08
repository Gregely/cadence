/**
 * Diary encryption, entirely in the browser with WebCrypto.
 *
 * key      = PBKDF2-SHA256(passphrase, salt, iterations) -> AES-GCM 256,
 *            created non-extractable and kept only in memory
 * envelope = {"v":1,"alg":"AES-GCM","iv":<12 random bytes>,"ct":<ciphertext+tag>}
 *            with additional data "cadence:v1"
 *
 * The server stores the salt, the iteration count and an encrypted check
 * value; it never sees the passphrase, the key or any plain text.
 */

export const KDF = 'PBKDF2-SHA256';
export const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('cadence:v1');
const CHECK = { check: 'cadence' };

export interface VaultParams {
  kdf: string;
  iterations: number;
  salt: string;
  check_envelope: string;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export function randomSalt(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(passphrase: string, salt: string, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // never extractable: the key cannot be read back out, even by this page
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, data));
  return JSON.stringify({ v: 1, alg: 'AES-GCM', iv: toB64(iv), ct: toB64(ct) });
}

export class WrongKey extends Error {
  constructor() {
    super('This could not be decrypted with the current passphrase.');
  }
}

export async function unseal<T = unknown>(key: CryptoKey, raw: string): Promise<T> {
  let env: { v?: number; alg?: string; iv?: string; ct?: string };
  try {
    env = JSON.parse(raw);
  } catch {
    throw new WrongKey();
  }
  if (env.v !== 1 || env.alg !== 'AES-GCM' || !env.iv || !env.ct) throw new WrongKey();
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: AAD }, key, fromB64(env.ct));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    throw new WrongKey();
  }
}

/** Make vault parameters for a new passphrase. */
export async function newVault(passphrase: string, iterations = ITERATIONS): Promise<{ params: VaultParams; key: CryptoKey }> {
  const salt = randomSalt();
  const key = await deriveKey(passphrase, salt, iterations);
  return { params: { kdf: KDF, iterations, salt, check_envelope: await seal(key, CHECK) }, key };
}

/** Derive the key and prove it opens the check value; null if the passphrase is wrong. */
export async function unlock(passphrase: string, params: VaultParams): Promise<CryptoKey | null> {
  if (params.kdf !== KDF) throw new Error(`Unsupported key derivation ${params.kdf}`);
  const key = await deriveKey(passphrase, params.salt, params.iterations);
  try {
    const check = await unseal<{ check?: string }>(key, params.check_envelope);
    return check.check === CHECK.check ? key : null;
  } catch {
    return null;
  }
}
