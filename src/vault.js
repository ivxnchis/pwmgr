// Pure helpers for manipulating the decrypted list of entries.

import { hostOf } from './match.js';
import { normalizeTotp } from './totp.js';

export function makeEntry(fields, now = Date.now()) {
  const url = String(fields.url || '').trim();
  return {
    id: fields.id || crypto.randomUUID(),
    name: String(fields.name || '').trim() || hostOf(url) || url,
    url,
    username: String(fields.username ?? ''),
    password: String(fields.password ?? ''),
    note: String(fields.note ?? ''),
    totp: normalizeTotp(fields.totp),
    created: fields.created || now,
    updated: now,
    lastUsed: fields.lastUsed || 0,
  };
}

function identity(e) {
  return `${hostOf(e.url) || e.url}\n${e.username}`;
}

// Merges imported rows into the vault. Same site + same username updates the password,
// identical rows are left alone, everything else is added.
export function mergeImport(entries, incoming, now = Date.now()) {
  const out = entries.slice();
  const index = new Map(out.map((e, i) => [identity(e), i]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of incoming) {
    const entry = makeEntry(row, now);
    const at = index.get(identity(entry));
    if (at === undefined) {
      index.set(identity(entry), out.length);
      out.push(entry);
      added++;
    } else if (
      out[at].password !== entry.password ||
      (entry.note && out[at].note !== entry.note) ||
      (entry.totp && entry.totp.secret !== out[at].totp?.secret)
    ) {
      out[at] = {
        ...out[at],
        password: entry.password,
        note: entry.note || out[at].note,
        totp: entry.totp || out[at].totp || null,
        updated: now,
      };
      updated++;
    } else {
      unchanged++;
    }
  }
  return { entries: out, added, updated, unchanged };
}
