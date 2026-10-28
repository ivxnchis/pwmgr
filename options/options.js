import { call, copy, el, generatePassword } from '../ui/api.js';
import { parseBrowserExport, toCSV } from '../src/csv.js';
import { addPasskey, passkeysSupported, unlockWithPasskey } from '../ui/passkey.js';
import { decodeQr, imageFromClipboard, prettyCode } from '../ui/qr.js';
import { parseTotpInput, toOtpauth, totpCode } from '../src/totp.js';
import { hostOf } from '../src/match.js';

const $ = (id) => document.getElementById(id);
let entries = [];
let gateMode = 'unlock';

// ---------- gate (create / unlock) ----------

function showGate(mode, passkeys = 0) {
  gateMode = mode;
  $('gate-passkey').classList.toggle('hidden', mode !== 'unlock' || !passkeys || !passkeysSupported());
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('lock').classList.add('hidden');
  const create = mode === 'create';
  $('gate-title').textContent = create ? 'Create your vault' : 'Unlock PwMgr';
  $('gate-text').textContent = create
    ? 'Choose a master password (8+ characters). It encrypts everything on this computer and cannot be recovered if forgotten.'
    : 'Enter your master password.';
  $('gate-confirm-wrap').classList.toggle('hidden', !create);
  $('gate-btn').textContent = create ? 'Create vault' : 'Unlock';
  $('gate-pw').focus();
}

$('gate-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('gate-error').textContent = '';
  const password = $('gate-pw').value;
  try {
    if (gateMode === 'create') {
      if (password !== $('gate-pw2').value) throw new Error('Passwords do not match.');
      await call('createVault', { password });
    } else {
      $('gate-btn').disabled = true;
      await call('unlock', { password });
    }
    $('gate-pw').value = $('gate-pw2').value = '';
    await start();
  } catch (err) {
    $('gate-error').textContent = err.message;
  } finally {
    $('gate-btn').disabled = false;
  }
});

$('gate-passkey-btn').addEventListener('click', async () => {
  $('gate-passkey-error').textContent = '';
  try {
    await unlockWithPasskey();
    await start();
  } catch (err) {
    $('gate-passkey-error').textContent = err.message;
  }
});

$('lock').addEventListener('click', async () => {
  await call('lock');
  await start();
});

// ---------- tabs ----------

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('[id^="tab-"]')) s.classList.toggle('hidden', s.id !== `tab-${name}`);
  if (name === 'blocked') renderBlocked();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// ---------- passwords ----------

async function loadEntries() {
  entries = (await call('listEntries')).entries;
  renderEntries();
}

// Live 2FA codes, refreshed every second.
let tickers = [];
setInterval(() => tickers.forEach((t) => t()), 1000);

function totpRow(totp) {
  const code = el('span', { class: 'code' });
  const left = el('span', { class: 'left' });
  let current = '';
  const tick = async () => {
    const r = await totpCode(totp);
    current = r.code;
    code.textContent = prettyCode(r.code);
    left.textContent = `${r.remaining}s`;
  };
  tick();
  tickers.push(tick);
  return el('div', { class: 'totp' }, code, left, el('button', { class: 'small', textContent: 'Copy code', onclick: () => copy(current) }));
}

function renderEntries() {
  tickers = [];
  const q = $('filter').value.trim().toLowerCase();
  const shown = entries
    .filter((e) => !q || `${e.name} ${e.url} ${e.username}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.username.localeCompare(b.username));
  $('count').textContent = `${shown.length} of ${entries.length} saved logins`;
  $('entries').replaceChildren(
    ...shown.map((e) => {
      const pw = el('span', { class: 'pw muted', textContent: '••••••••' });
      let revealed = false;
      return el(
        'div',
        { class: 'entry' },
        el(
          'div',
          { class: 'meta' },
          el('div', { class: 'ellipsis' }, el('strong', { textContent: e.name })),
          el('div', { class: 'muted ellipsis', textContent: e.url }),
          el('div', { class: 'ellipsis', textContent: e.username || '(no username)' }),
          pw,
          e.totp ? totpRow(e.totp) : null
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            class: 'small',
            textContent: 'Show',
            onclick: (ev) => {
              revealed = !revealed;
              pw.textContent = revealed ? e.password : '••••••••';
              ev.target.textContent = revealed ? 'Hide' : 'Show';
            },
          }),
          el('button', { class: 'small', textContent: 'Copy', onclick: () => copy(e.password) }),
          el('button', { class: 'small', textContent: 'Edit', onclick: () => openEditor(e) }),
          e.totp ? null : el('button', { class: 'small', textContent: 'Add 2FA', onclick: () => openTotpDialog(e.id) }),
          el('button', {
            class: 'small danger',
            textContent: 'Delete',
            onclick: async () => {
              if (!confirm(`Delete the login for ${e.username || '(no username)'} on ${e.name}?`)) return;
              await call('deleteEntry', { id: e.id });
              await loadEntries();
            },
          })
        )
      );
    })
  );
}

$('filter').addEventListener('input', renderEntries);

// ---------- editor ----------

let editing = null;
let editorTotp = null;

function showTotpStatus(text, isError = false) {
  $('e-totp-status').textContent = text;
  $('e-totp-status').className = `${isError ? 'error' : 'muted'} small-text`;
}

async function previewTotp() {
  if (!editorTotp) return showTotpStatus('Type the setup key the website shows, choose a picture of its QR code, or paste a screenshot here (Ctrl+V).');
  const { code, remaining } = await totpCode(editorTotp);
  const who = [editorTotp.issuer, editorTotp.account].filter(Boolean).join(' · ');
  showTotpStatus(`✔ Current code: ${prettyCode(code)} (changes in ${remaining}s)${who ? ` — ${who}` : ''}`);
}

// Picks the account from a (possibly multi-account) key/QR that fits the login being edited.
function applyTotpText(text) {
  if (!text.trim()) {
    editorTotp = null;
    return previewTotp();
  }
  try {
    const { accounts } = parseTotpInput(text);
    if (!accounts.length) throw new Error('No time-based 2FA accounts found in that code.');
    const user = $('e-username').value.trim().toLowerCase();
    editorTotp = accounts.find((a) => user && a.account.toLowerCase() === user) || accounts[0];
    if (/^otpauth-migration:/i.test(text.trim())) $('e-totp').value = toOtpauth(editorTotp);
    previewTotp();
  } catch (err) {
    editorTotp = null;
    showTotpStatus(err.message, true);
  }
}

async function totpFromImage(blob) {
  showTotpStatus('Reading QR code…');
  const text = await decodeQr(blob).catch(() => null);
  if (!text) return showTotpStatus('No QR code found in that image. Try a sharper or closer picture.', true);
  $('e-totp').value = text;
  applyTotpText(text);
}

const isDefaultTotp = (t) => t.algorithm === 'SHA1' && t.digits === 6 && t.period === 30;

setInterval(() => $('editor').open && editorTotp && previewTotp(), 1000);
$('e-totp').addEventListener('input', () => applyTotpText($('e-totp').value));
$('e-totp-scan').addEventListener('click', () => $('e-totp-file').click());
$('e-totp-file').addEventListener('change', (ev) => ev.target.files[0] && totpFromImage(ev.target.files[0]));
$('e-totp-clear').addEventListener('click', () => {
  $('e-totp').value = '';
  applyTotpText('');
});
$('editor').addEventListener('paste', (ev) => {
  const image = imageFromClipboard(ev);
  if (image) {
    ev.preventDefault();
    totpFromImage(image);
  }
});

function openEditor(entry = {}) {
  editorTotp = entry.totp || null;
  $('e-totp').value = editorTotp ? (isDefaultTotp(editorTotp) ? editorTotp.secret.replace(/(.{4})(?=.)/g, '$1 ') : toOtpauth(editorTotp)) : '';
  $('e-totp-file').value = '';
  previewTotp();
  editing = entry.id || null;
  $('editor-title').textContent = editing ? 'Edit login' : 'Add login';
  $('e-url').value = entry.url || '';
  $('e-name').value = entry.name || '';
  $('e-username').value = entry.username || '';
  $('e-password').value = entry.password || '';
  $('e-password').type = 'password';
  $('e-reveal').textContent = 'Show';
  $('e-note').value = entry.note || '';
  $('editor-error').textContent = '';
  $('editor').showModal();
}

$('add').addEventListener('click', () => openEditor());
$('e-cancel').addEventListener('click', () => $('editor').close());
$('e-reveal').addEventListener('click', () => {
  const show = $('e-password').type === 'password';
  $('e-password').type = show ? 'text' : 'password';
  $('e-reveal').textContent = show ? 'Hide' : 'Show';
});
$('e-generate').addEventListener('click', () => {
  $('e-password').value = generatePassword();
  $('e-password').type = 'text';
  $('e-reveal').textContent = 'Hide';
});

$('editor-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await call('saveEntry', {
      entry: {
        id: editing || undefined,
        url: $('e-url').value.trim(),
        name: $('e-name').value.trim(),
        username: $('e-username').value,
        password: $('e-password').value,
        note: $('e-note').value,
        totp: editorTotp,
      },
    });
    $('editor').close();
    await loadEntries();
  } catch (err) {
    $('editor-error').textContent = err.message;
  }
});

// ---------- "Add 2FA key" dialog ----------

let dialogTotp = null;

function tStatus(text, isError = false) {
  $('t-status').textContent = text;
  $('t-status').className = `${isError ? 'error' : 'muted'} small-text`;
}

function fillEntryChoices(selectedId) {
  const q = $('t-search').value.trim().toLowerCase();
  const keep = selectedId ?? $('t-entry').value;
  const shown = entries
    .filter((e) => !q || `${e.name} ${e.url} ${e.username}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.username.localeCompare(b.username));
  $('t-entry').replaceChildren(
    ...shown.map((e) =>
      el('option', { value: e.id, textContent: `${e.name} — ${e.username || '(no username)'}${e.totp ? '  (already has 2FA)' : ''}` })
    )
  );
  if (shown.some((e) => e.id === keep)) $('t-entry').value = keep;
}

async function tPreview() {
  if (!dialogTotp) return;
  const { code, remaining } = await totpCode(dialogTotp);
  const who = [dialogTotp.issuer, dialogTotp.account].filter(Boolean).join(' · ');
  tStatus(`✔ Valid key. Current code: ${prettyCode(code)} (changes in ${remaining}s)${who ? ` — ${who}` : ''}`);
}

function tApply(text) {
  dialogTotp = null;
  if (!text.trim()) return tStatus('Paste the link or key, choose a picture of the QR code, or paste a screenshot (Ctrl+V).');
  try {
    const { accounts } = parseTotpInput(text);
    if (!accounts.length) throw new Error('No time-based 2FA accounts found in that code.');
    if (accounts.length > 1) throw new Error('That QR code holds several accounts — use Import / Export → Import 2FA codes instead.');
    dialogTotp = accounts[0];
    // Pre-select the login the key seems to belong to, unless one was chosen already.
    const guess = !$('t-entry').value && suggestEntry(dialogTotp);
    if (guess) {
      $('t-search').value = '';
      fillEntryChoices(guess.id);
    }
    tPreview();
  } catch (err) {
    tStatus(err.message, true);
  }
}

async function tFromImage(blob) {
  tStatus('Reading QR code…');
  const text = await decodeQr(blob).catch(() => null);
  if (!text) return tStatus('No QR code found in that image. Try a sharper or closer picture.', true);
  $('t-input').value = text;
  tApply(text);
}

function openTotpDialog(entryId = '') {
  dialogTotp = null;
  $('t-input').value = '';
  $('t-search').value = '';
  $('t-error').textContent = '';
  $('t-file').value = '';
  fillEntryChoices(entryId);
  if (!entryId) $('t-entry').value = '';
  tApply('');
  $('totp-dialog').showModal();
  $('t-input').focus();
}

setInterval(() => $('totp-dialog').open && dialogTotp && tPreview(), 1000);
$('add-totp').addEventListener('click', () => openTotpDialog());
$('t-cancel').addEventListener('click', () => $('totp-dialog').close());
$('t-input').addEventListener('input', () => tApply($('t-input').value));
$('t-search').addEventListener('input', () => fillEntryChoices());
$('t-entry').addEventListener('change', () => ($('t-error').textContent = ''));
$('t-scan').addEventListener('click', () => $('t-file').click());
$('t-file').addEventListener('change', (ev) => ev.target.files[0] && tFromImage(ev.target.files[0]));
$('totp-dialog').addEventListener('paste', (ev) => {
  const image = imageFromClipboard(ev);
  if (image) {
    ev.preventDefault();
    tFromImage(image);
  }
});

$('totp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('t-error').textContent = '';
  const target = entries.find((e) => e.id === $('t-entry').value);
  if (!dialogTotp) return ($('t-error').textContent = 'Enter a valid 2FA key or otpauth:// link first.');
  if (!target) return ($('t-error').textContent = 'Choose the saved login to link it to.');
  if (target.totp && !confirm(`${target.name} — ${target.username} already has a 2FA key. Replace it?`)) return;
  try {
    await call('setTotp', { id: target.id, totp: dialogTotp });
    $('totp-dialog').close();
    await loadEntries();
  } catch (err) {
    $('t-error').textContent = err.message;
  }
});

// ---------- import / export ----------

let pendingRows = null;

$('import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  pendingRows = null;
  $('import-btn').disabled = true;
  $('import-result').textContent = '';
  if (!file) return ($('import-preview').textContent = '');
  try {
    const { entries: rows, skipped } = parseBrowserExport(await file.text());
    pendingRows = rows;
    $('import-preview').textContent = `Found ${rows.length} logins${skipped ? ` (${skipped} rows without a site or password will be skipped)` : ''}.`;
    $('import-btn').disabled = rows.length === 0;
  } catch (err) {
    $('import-preview').textContent = err.message;
  }
});

$('import-btn').addEventListener('click', async () => {
  if (!pendingRows) return;
  $('import-btn').disabled = true;
  try {
    const r = await call('importEntries', { rows: pendingRows });
    $('import-result').className = 'success';
    $('import-result').textContent = `Done: ${r.added} added, ${r.updated} updated, ${r.unchanged} already up to date. Remember to delete the CSV file.`;
    $('import-file').value = '';
    $('import-preview').textContent = '';
    pendingRows = null;
    await loadEntries();
  } catch (err) {
    $('import-result').className = 'error';
    $('import-result').textContent = err.message;
    $('import-btn').disabled = false;
  }
});

// ---------- Google Authenticator / QR import ----------

let gaAccounts = [];

function suggestEntry(acc) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const issuer = norm(acc.issuer);
  const user = acc.account.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const e of entries) {
    const site = `${norm(e.name)} ${norm(hostOf(e.url))}`;
    const issuerHit = issuer && site.includes(issuer);
    const userHit = user && e.username.toLowerCase() === user;
    // With an issuer it must match the site; the username alone is reused across sites.
    const score = issuer ? (issuerHit ? 2 + (userHit ? 1 : 0) : 0) : userHit ? 1 : 0;
    if (score > bestScore) [best, bestScore] = [e, score];
  }
  return best;
}

function renderGa() {
  const options = entries
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ value: e.id, label: `${e.name} — ${e.username || '(no username)'}${e.totp ? ' (has 2FA)' : ''}` }));
  $('ga-list').replaceChildren(
    ...gaAccounts.map((acc, i) => {
      const select = el('select', { onchange: (ev) => (gaAccounts[i].target = ev.target.value) });
      select.append(el('option', { value: '', textContent: "— Don't link —" }));
      for (const o of options) select.append(el('option', { value: o.value, textContent: o.label }));
      select.value = acc.target || '';
      return el('li', {}, el('span', { class: 'ellipsis grow', textContent: [acc.issuer, acc.account].filter(Boolean).join(' · ') || 'Unnamed account' }), select);
    })
  );
  $('ga-link').classList.toggle('hidden', !gaAccounts.length);
}

async function addGaImages(files) {
  $('ga-result').textContent = '';
  let found = 0;
  let failed = 0;
  let skipped = 0;
  for (const file of files) {
    const text = await decodeQr(file).catch(() => null);
    try {
      if (!text) throw new Error();
      const r = parseTotpInput(text);
      skipped += r.skipped;
      for (const acc of r.accounts) {
        if (gaAccounts.some((a) => a.secret === acc.secret)) continue;
        gaAccounts.push({ ...acc, target: suggestEntry(acc)?.id || '' });
        found++;
      }
    } catch {
      failed++;
    }
  }
  $('ga-status').textContent =
    `${gaAccounts.length} account(s) ready.` +
    (failed ? ` ${failed} image(s) had no readable 2FA QR code.` : '') +
    (skipped ? ` ${skipped} counter-based (HOTP) account(s) skipped — only time-based codes are supported.` : '') +
    (found || gaAccounts.length ? ' Check the login each one is linked to.' : '');
  renderGa();
}

$('ga-files').addEventListener('change', async (ev) => {
  await addGaImages([...ev.target.files]);
  ev.target.value = '';
});

document.addEventListener('paste', (ev) => {
  if ($('editor').open || $('totp-dialog').open || $('tab-import').classList.contains('hidden')) return;
  const image = imageFromClipboard(ev);
  if (image) addGaImages([image]);
});

$('ga-link').addEventListener('click', async () => {
  const chosen = gaAccounts.filter((a) => a.target);
  if (!chosen.length) return ($('ga-result').textContent = 'Pick a login for at least one account.');
  const overwrite = chosen.filter((a) => entries.find((e) => e.id === a.target)?.totp);
  if (overwrite.length && !confirm(`${overwrite.length} of these logins already have a 2FA key. Replace it?`)) return;
  for (const { target, issuer, account, secret, algorithm, digits, period } of chosen) {
    await call('setTotp', { id: target, totp: { issuer, account, secret, algorithm, digits, period } });
  }
  gaAccounts = gaAccounts.filter((a) => !a.target);
  $('ga-result').className = 'success';
  $('ga-result').textContent = `Linked ${chosen.length} 2FA account(s). Remember to delete the QR screenshots.`;
  $('ga-status').textContent = '';
  await loadEntries();
  renderGa();
});

$('export-btn').addEventListener('click', async () => {
  if (!confirm('The exported file will contain all your passwords in plain text. Continue?')) return;
  const { entries: all } = await call('listEntries');
  const url = URL.createObjectURL(new Blob([toCSV(all)], { type: 'text/csv' }));
  el('a', { href: url, download: `pwmgr-export-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------- blocked fields / sites ----------

async function renderBlocked() {
  const { blocked } = await call('getBlocked');
  const item = (text, onRemove) =>
    el('li', {}, el('span', { class: 'ellipsis grow', textContent: text }), el('button', { class: 'small', textContent: 'Allow again', onclick: onRemove }));
  const empty = (text) => el('li', { class: 'muted', textContent: text });
  const unblock = (data) => async () => {
    await call('unblock', data);
    renderBlocked();
  };

  $('blocked-fields').replaceChildren(
    ...(blocked.fields.length
      ? blocked.fields
          .slice()
          .sort((a, b) => a.host.localeCompare(b.host))
          .map((f) => item(`${f.host} — ${f.label || f.key}`, unblock({ list: 'fields', host: f.host, key: f.key })))
      : [empty('None yet.')])
  );
  $('blocked-sites').replaceChildren(
    ...(blocked.sites.length ? blocked.sites.map((h) => item(h, unblock({ list: 'sites', host: h }))) : [empty('None.')])
  );
  $('never-save').replaceChildren(
    ...(blocked.neverSave.length ? blocked.neverSave.map((h) => item(h, unblock({ list: 'neverSave', host: h }))) : [empty('None.')])
  );
}

// ---------- settings ----------

const SETTING_IDS = ['autofillOnLoad', 'loginFormsOnly', 'autofillTotp', 'offerToSave', 'autoLockMinutes'];

async function loadSettings() {
  const { settings } = await call('getSettings');
  for (const k of SETTING_IDS) {
    const input = $(`s-${k}`);
    if (input.type === 'checkbox') input.checked = !!settings[k];
    else input.value = settings[k];
  }
}

for (const k of SETTING_IDS) {
  $(`s-${k}`).addEventListener('change', async (ev) => {
    const value = ev.target.type === 'checkbox' ? ev.target.checked : Number(ev.target.value);
    await call('setSettings', { settings: { [k]: value } });
    $('settings-saved').textContent = 'Saved.';
    setTimeout(() => ($('settings-saved').textContent = ''), 1500);
  });
}

async function renderPasskeys() {
  const { passkeys } = await call('listPasskeys');
  $('passkey-list').replaceChildren(
    ...(passkeys.length
      ? passkeys.map((p) =>
          el(
            'li',
            {},
            el('span', { class: 'ellipsis grow', textContent: `${p.label} — added ${new Date(p.created).toLocaleDateString()}` }),
            el('button', {
              class: 'small danger',
              textContent: 'Remove',
              onclick: async () => {
                if (!confirm(`Stop using "${p.label}" to unlock PwMgr?`)) return;
                await call('removePasskey', { id: p.id });
                renderPasskeys();
              },
            })
          )
        )
      : [el('li', { class: 'muted', textContent: 'None set up.' })])
  );
}

$('passkey-add').addEventListener('click', async () => {
  const msg = $('passkey-msg');
  msg.className = 'error';
  msg.textContent = '';
  if (!passkeysSupported()) return (msg.textContent = 'This browser does not support passkeys.');
  $('passkey-add').disabled = true;
  try {
    await addPasskey($('passkey-label').value.trim() || 'Passkey');
    $('passkey-label').value = '';
    msg.className = 'success';
    msg.textContent = 'Passkey added. You can now unlock with it.';
    renderPasskeys();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    $('passkey-add').disabled = false;
  }
});

$('change-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('cp-msg');
  msg.className = 'error';
  if ($('cp-next').value !== $('cp-next2').value) return (msg.textContent = 'New passwords do not match.');
  try {
    const r = await call('changePassword', { current: $('cp-current').value, next: $('cp-next').value });
    ev.target.reset();
    msg.className = 'success';
    msg.textContent = r.passkeysRemoved
      ? 'Master password changed. Your passkeys were removed — add them again below.'
      : 'Master password changed.';
    renderPasskeys();
  } catch (err) {
    msg.textContent = err.message;
  }
});

$('delete-vault').addEventListener('click', async () => {
  if (!confirm('Delete the vault and ALL saved passwords? This cannot be undone.')) return;
  if (prompt('Type DELETE to confirm.') !== 'DELETE') return;
  await call('deleteVault');
  showGate('create');
});

// ---------- startup ----------

async function start() {
  const { hasVault, locked, passkeys } = await call('status');
  if (!hasVault) return showGate('create');
  if (locked) return showGate('unlock', passkeys);
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('lock').classList.remove('hidden');
  await Promise.all([loadEntries(), loadSettings(), renderPasskeys()]);

  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (params.get('add')) openEditor({ url: params.get('add') });
  const target = params.get('edit') && entries.find((e) => e.id === params.get('edit'));
  if (target) {
    openEditor(target);
    if (params.get('totp')) {
      $('e-totp').focus();
      showTotpStatus("Couldn't find a 2FA QR code on that page. Type the setup key, choose a picture of the QR code, or paste a screenshot (Ctrl+V).");
    }
  }
}

start();
