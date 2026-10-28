// TOTP (RFC 6238) codes compatible with Google Authenticator, plus parsers for the
// ways a 2FA secret is shared: a plain key, an otpauth:// QR code, or Google
// Authenticator's "Transfer accounts" export QR (otpauth-migration://).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('The key must only contain the letters A–Z and digits 2–7.');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Validates and fills in defaults. Returns null for an empty value.
export function normalizeTotp(t) {
  if (!t || !t.secret) return null;
  const secret = String(t.secret).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (base32Decode(secret).length < 5) throw new Error('That authenticator key is too short.');
  const algorithm = String(t.algorithm || 'SHA1').toUpperCase().replace('-', '');
  if (!ALGORITHMS[algorithm]) throw new Error(`Unsupported algorithm ${t.algorithm}.`);
  const digits = Number(t.digits || 6);
  const period = Number(t.period || 30);
  if (![6, 7, 8].includes(digits)) throw new Error('Codes must have 6–8 digits.');
  if (!(period >= 5 && period <= 300)) throw new Error('Unsupported code period.');
  return { secret, algorithm, digits, period, issuer: String(t.issuer || ''), account: String(t.account || '') };
}

export async function totpCode(totp, now = Date.now()) {
  const t = normalizeTotp(totp);
  const counter = Math.floor(now / 1000 / t.period);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', base32Decode(t.secret), { name: 'HMAC', hash: ALGORITHMS[t.algorithm] }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  const code = String(bin % 10 ** t.digits).padStart(t.digits, '0');
  const remaining = t.period - (Math.floor(now / 1000) % t.period);
  return { code, remaining, period: t.period };
}

// otpauth://totp/Issuer:account?secret=...&issuer=...&algorithm=...&digits=...&period=...
// The label (otpauth://totp/Issuer:account?...) is optional: otpauth://totp?secret=... works too.
export function parseOtpauth(uri) {
  const u = new URL(String(uri).replace(/\s+/g, ''));
  if (u.protocol !== 'otpauth:') throw new Error('Not an otpauth:// link.');
  const type = (u.host || u.pathname.replace(/^\/\//, '').split('/')[0]).toLowerCase();
  if (type !== 'totp') throw new Error('Only time-based (TOTP) codes are supported.');
  const label = decodeURIComponent(u.pathname.replace(/^\/*(totp\/)?/i, ''));
  const [labelIssuer, labelAccount] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
  const params = new Map([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v.trim()]));
  if (!params.get('secret')) throw new Error('That link has no secret=… value.');
  // parseInt tolerates text pasted right after the number (e.g. "period=30and").
  const int = (name, fallback) => parseInt(params.get(name), 10) || fallback;
  return normalizeTotp({
    secret: params.get('secret'),
    issuer: params.get('issuer') || labelIssuer.trim(),
    account: (labelAccount || '').trim(),
    algorithm: (params.get('algorithm') || 'SHA1').match(/^sha-?(1|256|512)/i)?.[0] || params.get('algorithm'),
    digits: int('digits', 6),
    period: int('period', 30),
  });
}

export function toOtpauth(t) {
  const label = t.issuer || t.account ? `/${encodeURIComponent(t.issuer ? `${t.issuer}:${t.account}` : t.account)}` : '';
  const q = new URLSearchParams({ secret: t.secret, algorithm: t.algorithm, digits: t.digits, period: t.period });
  if (t.issuer) q.set('issuer', t.issuer);
  return `otpauth://totp${label}?${q}`;
}

// ---------- Google Authenticator export (otpauth-migration://offline?data=<protobuf>) ----------

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('Corrupt export data.');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

function readMessage(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      let v;
      [v, pos] = readVarint(buf, pos);
      fields.push({ field, value: v });
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error('Corrupt export data.');
      fields.push({ field, value: buf.subarray(pos, end) });
      pos = end;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error('Corrupt export data.');
  }
  return fields;
}

const MIGRATION_ALGORITHMS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };

// Returns { accounts: [{issuer, account, secret, ...}], skipped } for one export QR.
export function parseMigration(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'otpauth-migration:') throw new Error('Not a Google Authenticator export code.');
  const data = u.searchParams.get('data');
  if (!data) throw new Error('The export code has no data.');
  const bin = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/').replace(/ /g, '+')), (c) => c.charCodeAt(0));
  const text = new TextDecoder();
  const accounts = [];
  let skipped = 0;
  for (const { field, value } of readMessage(bin)) {
    if (field !== 1) continue;
    const p = { algorithm: 1, digits: 1, type: 2 };
    for (const f of readMessage(value)) {
      if (f.field === 1) p.secret = f.value;
      else if (f.field === 2) p.name = text.decode(f.value);
      else if (f.field === 3) p.issuer = text.decode(f.value);
      else if (f.field === 4) p.algorithm = Number(f.value);
      else if (f.field === 5) p.digits = Number(f.value);
      else if (f.field === 6) p.type = Number(f.value);
    }
    if (p.type !== 2 || !p.secret || !MIGRATION_ALGORITHMS[p.algorithm]) {
      skipped++; // HOTP (counter-based) or MD5 accounts
      continue;
    }
    let account = p.name || '';
    let issuer = p.issuer || '';
    if (account.includes(':')) {
      const [a, b] = account.split(/:(.*)/s);
      issuer ||= a.trim();
      account = b.trim();
    }
    accounts.push(
      normalizeTotp({
        secret: base32Encode(p.secret),
        issuer,
        account,
        algorithm: MIGRATION_ALGORITHMS[p.algorithm],
        digits: p.digits === 2 ? 8 : 6,
        period: 30,
      })
    );
  }
  return { accounts, skipped };
}

// Accepts whatever the user pastes or scans: a plain key, an otpauth:// link or an export link.
// Always returns { accounts, skipped }.
export function parseTotpInput(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Enter a key or scan a QR code.');
  if (/^otpauth-migration:/i.test(s)) return parseMigration(s);
  if (/^otpauth:/i.test(s)) return { accounts: [parseOtpauth(s)], skipped: 0 };
  return { accounts: [normalizeTotp({ secret: s })], skipped: 0 };
}
