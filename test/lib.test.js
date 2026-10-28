import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, parseBrowserExport, toCSV } from '../src/csv.js';
import { matchScore, findMatches, hostOf } from '../src/match.js';
import { mergeImport } from '../src/vault.js';
import * as C from '../src/crypto.js';

test('parses a Chrome export, including quotes, commas and newlines', () => {
  const csv = '﻿name,url,username,password,note\r\n' +
    'example.com,https://example.com/login,alice,"p,a""ss",\r\n' +
    'site,https://site.org/,bob,secret,"line1\nline2"\r\n' +
    'empty,https://x.com/,carol,,\r\n';
  const { entries, skipped } = parseBrowserExport(csv);
  assert.equal(skipped, 1);
  assert.deepEqual(entries[0], { name: 'example.com', url: 'https://example.com/login', username: 'alice', password: 'p,a"ss', note: '', totp: null });
  assert.equal(entries[1].note, 'line1\nline2');
});

test('parses an Edge export without a note column', () => {
  const { entries } = parseBrowserExport('name,url,username,password\nedge,https://e.com/,u,p\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].note, '');
});

test('rejects files that are not password exports', () => {
  assert.throws(() => parseBrowserExport('a,b\n1,2\n'), /Unrecognised/);
});

test('CSV export round-trips', () => {
  const rows = [{ name: 'n', url: 'https://a.com', username: 'u"x', password: 'p,\nq', note: '', totp: null }];
  assert.deepEqual(parseBrowserExport(toCSV(rows)).entries, rows);
  assert.equal(parseCSV(toCSV(rows)).length, 2);
});

test('URL matching', () => {
  assert.equal(matchScore('https://www.example.com/login', 'https://example.com/other'), 2);
  assert.equal(matchScore('https://example.com', 'https://accounts.example.com/'), 1);
  assert.equal(matchScore('https://accounts.example.com', 'https://example.com/'), 0);
  assert.equal(matchScore('https://example.com', 'https://notexample.com/'), 0);
  assert.equal(matchScore('https://example.com', 'http://example.com/'), 0, 'no https creds on http');
  assert.equal(matchScore('android://hash@com.example/', 'https://com.example/'), 0);
  assert.equal(hostOf('example.com/path'), 'example.com');
  const list = [
    { id: 'sub', url: 'https://example.com', lastUsed: 5 },
    { id: 'exact', url: 'https://app.example.com', lastUsed: 1 },
    { id: 'other', url: 'https://other.com' },
  ];
  assert.deepEqual(findMatches(list, 'https://app.example.com/x').map((e) => e.id), ['exact', 'sub']);
});

test('import merge adds, updates and skips duplicates', () => {
  const existing = [{ id: '1', name: 'a', url: 'https://a.com', username: 'u', password: 'old', note: '' }];
  const r = mergeImport(existing, [
    { url: 'https://www.a.com/login', username: 'u', password: 'new' },
    { url: 'https://a.com', username: 'u', password: 'new' },
    { url: 'https://b.com', username: 'v', password: 'p' },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 1);
  assert.equal(r.entries.find((e) => e.id === '1').password, 'new');
});

test('encryption round-trips and rejects a wrong password', async () => {
  const salt = C.randomBytes(16);
  const key = await C.deriveKey('correct horse', salt, 1000);
  const sealed = await C.encryptJSON(key, { entries: [{ password: 'x' }] });
  assert.deepEqual(await C.decryptJSON(await C.importKey(await C.exportKey(key)), sealed), { entries: [{ password: 'x' }] });
  const wrong = await C.deriveKey('wrong', salt, 1000);
  await assert.rejects(C.decryptJSON(wrong, sealed));
});
