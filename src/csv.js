// CSV import/export compatible with the files Chrome, Edge (and Firefox) produce
// from their "Export passwords" option.

import { parseTotpInput, toOtpauth } from './totp.js';

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ''));
}

const COLUMN_ALIASES = {
  name: ['name', 'title'],
  url: ['url', 'origin', 'website', 'login_uri'],
  username: ['username', 'login', 'user', 'email', 'login_username'],
  password: ['password', 'login_password'],
  note: ['note', 'notes', 'comment', 'extra'],
  totp: ['totp', 'login_totp', 'otpauth', 'otp'],
};

// Parses a browser password export. Returns { entries, skipped }.
export function parseBrowserExport(text) {
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('The file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    col[key] = header.findIndex((h) => aliases.includes(h));
  }
  if (col.url < 0 || col.password < 0) {
    throw new Error('Unrecognised CSV: expected at least "url" and "password" columns (Chrome/Edge export format).');
  }

  const entries = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const get = (k) => (col[k] >= 0 ? (r[col[k]] ?? '') : '');
    const url = get('url').trim();
    const password = get('password');
    if (!url || !password) {
      skipped++;
      continue;
    }
    entries.push({
      name: get('name').trim(),
      url,
      username: get('username'),
      password,
      note: get('note'),
      totp: parseTotpColumn(get('totp')),
    });
  }
  return { entries, skipped };
}

function parseTotpColumn(value) {
  if (!value.trim()) return null;
  try {
    return parseTotpInput(value).accounts[0] || null;
  } catch {
    return null;
  }
}

function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Same layout Chrome uses, so the file can be imported back into Chrome/Edge (which ignore
// the extra "totp" column; PwMgr and Bitwarden-style importers read it).
export function toCSV(entries) {
  const lines = [['name', 'url', 'username', 'password', 'note', 'totp'].join(',')];
  for (const e of entries) {
    lines.push([e.name, e.url, e.username, e.password, e.note, e.totp ? toOtpauth(e.totp) : ''].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
