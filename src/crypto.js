// Vault encryption: PBKDF2-SHA256 derives an AES-GCM-256 key from the master password.
// Everything runs through WebCrypto, nothing leaves the machine.

export const KDF_ITERATIONS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(password, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so the key can be kept in chrome.storage.session while unlocked
    ['encrypt', 'decrypt']
  );
}

export async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key));
}

export async function importKey(b64) {
  return crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function encryptJSON(key, value) {
  const iv = randomBytes(12);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: toB64(iv), data: toB64(data) };
}

// Throws if the key is wrong (AES-GCM authentication fails).
export async function decryptJSON(key, { iv, data }) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data));
  return JSON.parse(dec.decode(plain));
}
