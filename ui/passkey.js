// Passkey / fingerprint unlock using the WebAuthn PRF extension. The authenticator derives a
// secret from a per-passkey salt; the background worker uses it to wrap the vault key.
import { call } from './api.js';
import { fromB64, randomBytes, toB64 } from '../src/crypto.js';

const b64url = (buf) => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

const NO_PRF =
  "This authenticator can't produce the secret PwMgr needs (WebAuthn PRF). Try a different option in the " +
  "browser's prompt, e.g. saving the passkey in Google Password Manager or iCloud Keychain, a recent " +
  'Windows Hello, or a FIDO2 security key.';

export function passkeysSupported() {
  return typeof PublicKeyCredential !== 'undefined' && !!navigator.credentials;
}

function friendly(err) {
  if (err?.name === 'NotAllowedError') return new Error('Cancelled or timed out.');
  if (err?.name === 'InvalidStateError') return new Error('That authenticator is already set up.');
  if (err?.name === 'SecurityError') return new Error('This browser does not allow passkeys for extensions.');
  return err instanceof Error ? err : new Error(String(err));
}

async function assertion(passkeys) {
  let cred;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        userVerification: 'required',
        timeout: 120000,
        allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: fromB64url(p.id) })),
        extensions: { prf: { evalByCredential: Object.fromEntries(passkeys.map((p) => [p.id, { first: fromB64url(p.salt) }])) } },
      },
    });
  } catch (err) {
    throw friendly(err);
  }
  const out = cred.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new Error(NO_PRF);
  return { credentialId: b64url(cred.rawId), prf: toB64(out) };
}

export async function addPasskey(label) {
  const salt = randomBytes(32);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'PwMgr' },
        user: { id: randomBytes(16), name: 'PwMgr vault', displayName: 'PwMgr vault' },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        timeout: 120000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (err) {
    throw friendly(err);
  }
  const ext = cred.getClientExtensionResults();
  if (!ext.prf?.enabled) throw new Error(NO_PRF);
  const credentialId = b64url(cred.rawId);
  // Some authenticators only return the PRF secret on sign-in, which costs a second touch.
  const prf = ext.prf.results?.first
    ? toB64(ext.prf.results.first)
    : (await assertion([{ id: credentialId, salt: b64url(salt) }])).prf;
  await call('enrollPasskey', { credentialId, salt: b64url(salt), prf, label });
}

export async function unlockWithPasskey() {
  const { passkeys } = await call('listPasskeys');
  if (!passkeys.length) throw new Error('No passkey is set up yet.');
  await call('unlockWithPasskey', await assertion(passkeys));
}
