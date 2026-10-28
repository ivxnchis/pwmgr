// Service worker: owns the vault, the unlocked key and every decision about what a page may see.
// Content scripts only ever receive credentials that match the URL Chrome reports for their frame.

import * as C from './crypto.js';
import { findMatches, hostOf, matchScore } from './match.js';
import { makeEntry, mergeImport } from './vault.js';

const DEFAULT_SETTINGS = {
  autofillOnLoad: true, // fill matching credentials as soon as a login form appears
  loginFormsOnly: true, // only fill on load when the form looks like a sign-in form
  offerToSave: true,
  autoLockMinutes: 0, // 0 = stay unlocked until the browser closes
};
const EMPTY_BLOCKED = { fields: [], sites: [], neverSave: [] };
const PENDING_TTL_MS = 2 * 60 * 1000;

let key = null;
let entries = null;
let loading = null;

// ---------- storage helpers ----------

async function getLocal(name) {
  return (await chrome.storage.local.get(name))[name];
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await getLocal('settings')) };
}

async function getBlocked() {
  return { ...EMPTY_BLOCKED, ...(await getLocal('blocked')) };
}

// ---------- vault lifecycle ----------

async function ensureUnlocked() {
  if (key && entries) return true;
  loading ??= (async () => {
    const { sessionKey } = await chrome.storage.session.get('sessionKey');
    const vault = await getLocal('vault');
    if (!sessionKey || !vault) return false;
    try {
      const k = await C.importKey(sessionKey);
      entries = (await C.decryptJSON(k, vault)).entries;
      key = k;
      return true;
    } catch {
      await lock();
      return false;
    }
  })().finally(() => (loading = null));
  return loading;
}

async function requireUnlocked() {
  if (!(await ensureUnlocked())) throw new Error('Vault is locked.');
}

async function persist() {
  const vault = await getLocal('vault');
  const sealed = await C.encryptJSON(key, { entries });
  await chrome.storage.local.set({ vault: { ...vault, ...sealed } });
}

async function startSession(k, list) {
  key = k;
  entries = list;
  await chrome.storage.session.set({ sessionKey: await C.exportKey(k) });
  await touch();
  broadcast({ type: 'vaultChanged' });
}

async function createVault(password) {
  if (await getLocal('vault')) throw new Error('A vault already exists.');
  if (!password || password.length < 8) throw new Error('Use a master password of at least 8 characters.');
  const salt = C.randomBytes(16);
  const k = await C.deriveKey(password, salt);
  const sealed = await C.encryptJSON(k, { entries: [] });
  await chrome.storage.local.set({
    vault: { version: 1, kdf: { name: 'PBKDF2-SHA256', salt: C.toB64(salt), iterations: C.KDF_ITERATIONS }, ...sealed },
  });
  await startSession(k, []);
}

async function openVault(password) {
  const vault = await getLocal('vault');
  if (!vault) throw new Error('No vault yet.');
  const k = await C.deriveKey(password, C.fromB64(vault.kdf.salt), vault.kdf.iterations);
  let data;
  try {
    data = await C.decryptJSON(k, vault);
  } catch {
    throw new Error('Wrong master password.');
  }
  return { k, data };
}

async function unlock(password) {
  const { k, data } = await openVault(password);
  await startSession(k, data.entries);
}

async function changePassword(current, next) {
  if (!next || next.length < 8) throw new Error('Use a master password of at least 8 characters.');
  const { data } = await openVault(current);
  const salt = C.randomBytes(16);
  const k = await C.deriveKey(next, salt);
  const sealed = await C.encryptJSON(k, data);
  await chrome.storage.local.set({
    vault: { version: 1, kdf: { name: 'PBKDF2-SHA256', salt: C.toB64(salt), iterations: C.KDF_ITERATIONS }, ...sealed },
  });
  await startSession(k, data.entries);
  // Passkeys wrap the old key, so they can't unlock the re-encrypted vault.
  const removed = (await getPasskeys()).length;
  await chrome.storage.local.remove('passkeys');
  return { passkeysRemoved: removed };
}

// ---------- passkey / fingerprint unlock (WebAuthn PRF) ----------
// The extension page runs the WebAuthn ceremony and hands us the PRF output. That secret
// wraps the vault key, so only the same authenticator (fingerprint, Windows Hello, Touch ID,
// security key...) can unwrap it again. The master password keeps working as a fallback.

async function getPasskeys() {
  return (await getLocal('passkeys')) || [];
}

async function enrollPasskey({ credentialId, salt, prf, label }) {
  await requireUnlocked();
  if (!credentialId || !salt || !prf) throw new Error('Incomplete passkey data.');
  const wrap = await C.deriveWrapKey(C.fromB64(prf));
  const sealed = await C.encryptJSON(wrap, { key: await C.exportKey(key) });
  const list = (await getPasskeys()).filter((p) => p.id !== credentialId);
  list.push({ id: credentialId, salt, label: String(label || 'Passkey').slice(0, 80), created: Date.now(), ...sealed });
  await chrome.storage.local.set({ passkeys: list });
}

async function unlockWithPasskey({ credentialId, prf }) {
  const pk = (await getPasskeys()).find((p) => p.id === credentialId);
  if (!pk) throw new Error('That passkey is not set up for PwMgr.');
  let raw;
  try {
    raw = (await C.decryptJSON(await C.deriveWrapKey(C.fromB64(prf)), pk)).key;
  } catch {
    throw new Error('That passkey could not unlock the vault.');
  }
  const k = await C.importKey(raw);
  let data;
  try {
    data = await C.decryptJSON(k, await getLocal('vault'));
  } catch {
    throw new Error('This passkey is out of date. Unlock with your master password and set it up again.');
  }
  await startSession(k, data.entries);
}

let unlockWindowId = null;

async function openUnlockWindow() {
  if (unlockWindowId !== null) {
    try {
      await chrome.windows.update(unlockWindowId, { focused: true });
      return {};
    } catch {
      unlockWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('unlock/unlock.html'),
    type: 'popup',
    width: 400,
    height: 480,
    focused: true,
  });
  unlockWindowId = win.id;
  return {};
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === unlockWindowId) unlockWindowId = null;
});

async function lock() {
  key = null;
  entries = null;
  await chrome.storage.session.clear();
  await chrome.alarms.clear('autolock');
  broadcast({ type: 'vaultChanged' });
}

async function touch() {
  const { autoLockMinutes } = await getSettings();
  if (autoLockMinutes > 0) chrome.alarms.create('autolock', { delayInMinutes: autoLockMinutes });
  else chrome.alarms.clear('autolock');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') lock();
});

// ---------- tabs ----------

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
}

function setBadge(tabId, text, color, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setTitle({ tabId, title: title || 'PwMgr' }).catch(() => {});
}

// ---------- context menu ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pwmgr-toggle-field',
      title: 'Turn autofill off / on for this field',
      contexts: ['editable'],
    });
    chrome.contextMenus.create({
      id: 'pwmgr-toggle-site',
      title: 'Turn autofill off / on for this whole site',
      contexts: ['editable', 'page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const type = info.menuItemId === 'pwmgr-toggle-field' ? 'ctx-toggle-field' : 'ctx-toggle-site';
  chrome.tabs.sendMessage(tab.id, { type }, { frameId: info.frameId ?? 0 }).catch(() => {});
});

// ---------- messages from content scripts ----------

function summary(e) {
  return { id: e.id, username: e.username, name: e.name };
}

const contentHandlers = {
  async pageInit(_, sender) {
    const host = hostOf(sender.url);
    const [settings, blocked, vault] = await Promise.all([getSettings(), getBlocked(), getLocal('vault')]);
    const unlocked = await ensureUnlocked();
    return {
      hasVault: !!vault,
      locked: !unlocked,
      settings,
      credentials: unlocked ? findMatches(entries, sender.url).map(summary) : [],
      blockedKeys: blocked.fields.filter((f) => f.host === host).map((f) => f.key),
      siteBlocked: blocked.sites.includes(host),
    };
  },

  async getCredential({ id }, sender) {
    await requireUnlocked();
    const entry = entries.find((e) => e.id === id);
    if (!entry || !matchScore(entry.url, sender.url)) throw new Error('No matching credential.');
    entry.lastUsed = Date.now();
    persist();
    touch();
    return { username: entry.username, password: entry.password };
  },

  async loginFormSeen({ count }, sender) {
    if (sender.frameId !== 0 && count === 0) return {};
    const [vault, unlocked] = [await getLocal('vault'), await ensureUnlocked()];
    if (!vault) return {};
    if (!unlocked) setBadge(sender.tab.id, '!', '#d97706', 'PwMgr is locked — click to unlock and autofill');
    else setBadge(sender.tab.id, count ? String(count) : '', '#2563eb', `PwMgr — ${count} saved login(s) for this site`);
    return {};
  },

  async captureCredentials({ username, password }, sender) {
    if (typeof password !== 'string' || !password || typeof username !== 'string') return {};
    const settings = await getSettings();
    if (!settings.offerToSave || !(await ensureUnlocked())) return {};
    const host = hostOf(sender.url);
    if (!host || (await getBlocked()).neverSave.includes(host)) return {};

    const matches = findMatches(entries, sender.url);
    if (matches.some((e) => e.password === password && (e.username === username || !username))) return {};
    const existing = username ? matches.find((e) => e.username === username) : null;
    await chrome.storage.session.set({
      [`pending:${sender.tab.id}`]: {
        url: new URL(sender.url).origin,
        host,
        username,
        password,
        existingId: existing?.id || null,
        time: Date.now(),
        shows: 0,
      },
    });
    return {};
  },

  async peekPendingSave(_, sender) {
    const slot = `pending:${sender.tab.id}`;
    const pending = (await chrome.storage.session.get(slot))[slot];
    if (!pending || Date.now() - pending.time > PENDING_TTL_MS || pending.shows >= 2) return { pending: null };
    pending.shows++;
    await chrome.storage.session.set({ [slot]: pending });
    return { pending: { host: pending.host, username: pending.username, isUpdate: !!pending.existingId } };
  },

  async resolvePendingSave({ action }, sender) {
    const slot = `pending:${sender.tab.id}`;
    const pending = (await chrome.storage.session.get(slot))[slot];
    await chrome.storage.session.remove(slot);
    if (!pending) return {};
    if (action === 'never') {
      const blocked = await getBlocked();
      if (!blocked.neverSave.includes(pending.host)) blocked.neverSave.push(pending.host);
      await chrome.storage.local.set({ blocked });
    } else if (action === 'save') {
      await requireUnlocked();
      const existing = pending.existingId && entries.find((e) => e.id === pending.existingId);
      if (existing) Object.assign(existing, { password: pending.password, updated: Date.now() });
      else entries.push(makeEntry({ url: pending.url, username: pending.username, password: pending.password }));
      await persist();
      broadcast({ type: 'vaultChanged' });
    }
    return {};
  },

  async toggleBlockedField({ key: fieldKey, label }, sender) {
    const host = hostOf(sender.url);
    if (!host || !fieldKey) throw new Error('Cannot block this field.');
    const blocked = await getBlocked();
    const at = blocked.fields.findIndex((f) => f.host === host && f.key === fieldKey);
    if (at >= 0) blocked.fields.splice(at, 1);
    else blocked.fields.push({ host, key: fieldKey, label: String(label || '').slice(0, 120), added: Date.now() });
    await chrome.storage.local.set({ blocked });
    return { blocked: at < 0 };
  },

  openUnlockWindow: () => openUnlockWindow(),

  async toggleSiteBlocked(_, sender) {
    const host = hostOf(sender.url);
    if (!host) throw new Error('Cannot block this page.');
    const blocked = await getBlocked();
    const at = blocked.sites.indexOf(host);
    if (at >= 0) blocked.sites.splice(at, 1);
    else blocked.sites.push(host);
    await chrome.storage.local.set({ blocked });
    return { blocked: at < 0, host };
  },
};

// ---------- messages from the popup / options page ----------

const pageHandlers = {
  async status() {
    return {
      hasVault: !!(await getLocal('vault')),
      locked: !(await ensureUnlocked()),
      passkeys: (await getPasskeys()).length,
    };
  },
  createVault: ({ password }) => createVault(password),
  unlock: ({ password }) => unlock(password),
  lock: () => lock(),
  changePassword: ({ current, next }) => changePassword(current, next),

  async deleteVault() {
    await lock();
    await chrome.storage.local.remove(['vault', 'passkeys']);
  },

  async listPasskeys() {
    return { passkeys: (await getPasskeys()).map(({ id, salt, label, created }) => ({ id, salt, label, created })) };
  },
  enrollPasskey: (msg) => enrollPasskey(msg),
  unlockWithPasskey: (msg) => unlockWithPasskey(msg),
  async removePasskey({ id }) {
    await chrome.storage.local.set({ passkeys: (await getPasskeys()).filter((p) => p.id !== id) });
    return {};
  },
  openUnlockWindow: () => openUnlockWindow(),

  async listEntries() {
    await requireUnlocked();
    touch();
    return { entries };
  },

  async matchesForUrl({ url }) {
    await requireUnlocked();
    touch();
    return { entries: findMatches(entries, url) };
  },

  async saveEntry({ entry }) {
    await requireUnlocked();
    if (!entry.url || !entry.password) throw new Error('Website and password are required.');
    const at = entry.id ? entries.findIndex((e) => e.id === entry.id) : -1;
    if (at >= 0) entries[at] = { ...makeEntry({ ...entries[at], ...entry }), created: entries[at].created };
    else entries.push(makeEntry(entry));
    await persist();
    broadcast({ type: 'vaultChanged' });
    return {};
  },

  async deleteEntry({ id }) {
    await requireUnlocked();
    entries = entries.filter((e) => e.id !== id);
    await persist();
    broadcast({ type: 'vaultChanged' });
    return {};
  },

  async importEntries({ rows }) {
    await requireUnlocked();
    const result = mergeImport(entries, rows);
    entries = result.entries;
    await persist();
    broadcast({ type: 'vaultChanged' });
    return { added: result.added, updated: result.updated, unchanged: result.unchanged };
  },

  async fillInTab({ tabId, id }) {
    await requireUnlocked();
    await chrome.tabs.sendMessage(tabId, { type: 'fillCredential', id });
    return {};
  },

  async getSettings() {
    return { settings: await getSettings() };
  },

  async setSettings({ settings }) {
    const next = { ...(await getSettings()), ...settings };
    next.autoLockMinutes = Math.max(0, Math.min(1440, Number(next.autoLockMinutes) || 0));
    await chrome.storage.local.set({ settings: next });
    if (await ensureUnlocked()) await touch();
    broadcast({ type: 'vaultChanged' });
    return { settings: next };
  },

  async getBlocked() {
    return { blocked: await getBlocked() };
  },

  async unblock({ list, host, key: fieldKey }) {
    const blocked = await getBlocked();
    if (list === 'fields') blocked.fields = blocked.fields.filter((f) => !(f.host === host && f.key === fieldKey));
    else if (list === 'sites' || list === 'neverSave') blocked[list] = blocked[list].filter((h) => h !== host);
    await chrome.storage.local.set({ blocked });
    broadcast({ type: 'vaultChanged' });
    return { blocked };
  },
};

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const table = isExtensionPage(sender) ? pageHandlers : sender.tab && sender.url ? contentHandlers : null;
  if (!table || !Object.hasOwn(table, msg.type)) return false;

  Promise.resolve()
    .then(() => table[msg.type](msg, sender))
    .then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) })
    );
  return true;
});
