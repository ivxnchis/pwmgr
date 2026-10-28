import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, totpCode, parseOtpauth, parseMigration, parseTotpInput, toOtpauth } from '../src/totp.js';
import { parseBrowserExport, toCSV } from '../src/csv.js';

const ascii = (s) => base32Encode(new TextEncoder().encode(s));

test('RFC 6238 test vectors', async () => {
  const sha1 = { secret: ascii('12345678901234567890'), digits: 8 };
  const sha256 = { secret: ascii('12345678901234567890123456789012'), digits: 8, algorithm: 'SHA256' };
  const sha512 = { secret: ascii('1234567890'.repeat(6) + '1234'), digits: 8, algorithm: 'SHA512' };
  assert.equal((await totpCode(sha1, 59000)).code, '94287082');
  assert.equal((await totpCode(sha1, 1111111109000)).code, '07081804');
  assert.equal((await totpCode(sha1, 20000000000000)).code, '65353130');
  assert.equal((await totpCode(sha256, 59000)).code, '46119246');
  assert.equal((await totpCode(sha512, 59000)).code, '90693936');
  const r = await totpCode({ secret: 'JBSWY3DPEHPK3PXP' }, 65000);
  assert.equal(r.code.length, 6);
  assert.equal(r.remaining, 25);
});

test('base32 round trip and tolerant input', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 7, 9]);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.deepEqual(base32Decode('jbsw y3dp-ehpk 3pxp'), base32Decode('JBSWY3DPEHPK3PXP'));
  assert.throws(() => base32Decode('NOT*VALID'));
});

test('parses otpauth links', () => {
  const t = parseOtpauth('otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256');
  assert.deepEqual(t, { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60, issuer: 'GitHub', account: 'alice@example.com' });
  assert.deepEqual(parseOtpauth(toOtpauth(t)), t);
  assert.throws(() => parseOtpauth('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'), /time-based/);
  assert.equal(parseTotpInput('JBSW Y3DP EHPK 3PXP').accounts[0].secret, 'JBSWY3DPEHPK3PXP');
});

// Minimal protobuf encoder to build a Google Authenticator export payload.
function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return out;
}
const bytesField = (f, b) => [...varint((f << 3) | 2), ...varint(b.length), ...b];
const intField = (f, v) => [...varint(f << 3), ...varint(v)];
const str = (s) => [...new TextEncoder().encode(s)];

test('parses Google Authenticator export QR data', () => {
  const secret = [...base32Decode('JBSWY3DPEHPK3PXP')];
  const otp1 = [...bytesField(1, secret), ...bytesField(2, str('alice@example.com')), ...bytesField(3, str('GitHub')), ...intField(4, 1), ...intField(5, 1), ...intField(6, 2)];
  const otp2 = [...bytesField(1, secret), ...bytesField(2, str('Bank:bob')), ...intField(4, 2), ...intField(5, 2), ...intField(6, 2)];
  const hotp = [...bytesField(1, secret), ...bytesField(2, str('old')), ...intField(6, 1)];
  const payload = new Uint8Array([...bytesField(1, otp1), ...bytesField(1, otp2), ...bytesField(1, hotp), ...intField(2, 1)]);
  const data = encodeURIComponent(btoa(String.fromCharCode(...payload)));
  const { accounts, skipped } = parseMigration(`otpauth-migration://offline?data=${data}`);
  assert.equal(skipped, 1);
  assert.deepEqual(accounts[0], { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'GitHub', account: 'alice@example.com' });
  assert.deepEqual(accounts[1], { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 30, issuer: 'Bank', account: 'bob' });
});

test('CSV keeps TOTP secrets', () => {
  const totp = { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, issuer: 'X', account: 'u' };
  const rows = [{ name: 'n', url: 'https://a.com', username: 'u', password: 'p', note: '', totp }];
  assert.deepEqual(parseBrowserExport(toCSV(rows)).entries, rows);
});
