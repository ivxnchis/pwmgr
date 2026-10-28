import { call, copy, el } from '../ui/api.js';
import { decodeQr, prettyCode } from '../ui/qr.js';
import { parseTotpInput, totpCode } from '../src/totp.js';

const $ = (id) => document.getElementById(id);
let tab = null;

function show(section) {
  for (const id of ['setup', 'locked', 'unlocked']) $(id).classList.toggle('hidden', id !== section);
  $('lock').classList.toggle('hidden', section !== 'unlocked');
}

function siteUrl() {
  return tab?.url && /^https?:/.test(tab.url) ? tab.url : '';
}

// Live 2FA codes shown in the list, refreshed every second.
let tickers = [];
setInterval(() => tickers.forEach((t) => t()), 1000);

function totpRow(e, flash) {
  const code = el('span', { class: 'code' });
  const left = el('span', { class: 'left' });
  let current = '';
  const tick = async () => {
    const r = await totpCode(e.totp);
    current = r.code;
    code.textContent = prettyCode(r.code);
    left.textContent = `${r.remaining}s`;
  };
  tick();
  tickers.push(tick);
  return el(
    'div',
    { class: 'totp', title: '2FA code' },
    code,
    left,
    el('button', { class: 'small', textContent: 'Copy code', onclick: () => copy(current).then(() => flash('Copied')) })
  );
}

// Looks for a 2FA QR code on the visible part of the current tab; falls back to the editor.
async function setUpTotp(e, flash) {
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const text = await decodeQr(await (await fetch(shot)).blob());
    const accounts = text ? parseTotpInput(text).accounts : [];
    if (accounts.length === 1) {
      await call('setTotp', { id: e.id, totp: accounts[0] });
      flash('2FA linked');
      return loadSiteMatches();
    }
  } catch {
    // fall through to the editor
  }
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#edit=${encodeURIComponent(e.id)}&totp=1`) });
  window.close();
}

function renderList(entries, { showFill }) {
  const list = $('list');
  list.replaceChildren();
  tickers = [];
  $('empty').classList.toggle('hidden', entries.length > 0);
  for (const e of entries) {
    const status = el('span', { class: 'copied' });
    const flash = (msg) => {
      status.textContent = msg;
      setTimeout(() => (status.textContent = ''), 1500);
    };
    list.append(
      el(
        'li',
        {},
        el('div', { class: 'ellipsis', title: e.username }, el('strong', { textContent: e.username || '(no username)' })),
        el('div', { class: 'muted ellipsis', textContent: e.name || e.url }),
        e.totp ? totpRow(e, flash) : null,
        el(
          'div',
          { class: 'actions' },
          showFill
            ? el('button', {
                class: 'small primary',
                textContent: 'Fill',
                onclick: async () => {
                  await call('fillInTab', { tabId: tab.id, id: e.id }).catch(() => {});
                  window.close();
                },
              })
            : null,
          el('button', { class: 'small', textContent: 'Copy user', onclick: () => copy(e.username).then(() => flash('Copied')) }),
          el('button', { class: 'small', textContent: 'Copy password', onclick: () => copy(e.password).then(() => flash('Copied')) }),
          showFill && !e.totp
            ? el('button', {
                class: 'small',
                textContent: 'Add 2FA',
                title: 'Scan the 2FA QR code shown on this page, or enter the key',
                onclick: () => setUpTotp(e, flash),
              })
            : null,
          status
        )
      )
    );
  }
}

async function loadSiteMatches() {
  const url = siteUrl();
  $('list-title').textContent = url ? `This site — ${new URL(url).hostname}` : 'This site';
  $('add-site').classList.toggle('hidden', !url);
  const { entries } = url ? await call('matchesForUrl', { url }) : { entries: [] };
  renderList(entries, { showFill: true });
}

async function search(q) {
  if (!q) return loadSiteMatches();
  const { entries } = await call('listEntries');
  const needle = q.toLowerCase();
  const hits = entries.filter((e) => `${e.name} ${e.url} ${e.username}`.toLowerCase().includes(needle)).slice(0, 50);
  $('list-title').textContent = `Search results (${hits.length})`;
  renderList(hits, { showFill: false });
}

async function refresh() {
  const { hasVault, locked, passkeys } = await call('status');
  if (!hasVault) return show('setup');
  if (locked) {
    show('locked');
    $('passkey-unlock').classList.toggle('hidden', !passkeys);
    $('passkey-or').classList.toggle('hidden', !passkeys);
    $('unlock-pw').focus();
    return;
  }
  show('unlocked');
  await loadSiteMatches();
}

$('setup-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const pw = $('setup-pw').value;
  if (pw !== $('setup-pw2').value) return ($('setup-error').textContent = 'Passwords do not match.');
  try {
    await call('createVault', { password: pw });
    await refresh();
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
});

$('unlock-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('unlock-btn').disabled = true;
  $('unlock-error').textContent = '';
  try {
    await call('unlock', { password: $('unlock-pw').value });
    $('unlock-pw').value = '';
    await refresh();
  } catch (err) {
    $('unlock-error').textContent = err.message;
  } finally {
    $('unlock-btn').disabled = false;
  }
});

// Windows Hello / Touch ID prompts close toolbar popups, so passkey unlock runs in its own window.
$('passkey-unlock').addEventListener('click', async () => {
  await call('openUnlockWindow');
  window.close();
});

$('lock').addEventListener('click', async () => {
  await call('lock');
  await refresh();
});

$('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('add-site').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html#add=${encodeURIComponent(new URL(siteUrl()).origin)}`) });
});

let searchTimer;
$('search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(ev.target.value.trim()), 150);
});

[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
refresh();
