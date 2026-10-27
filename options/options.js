import { call, copy, el, generatePassword } from '../ui/api.js';
import { parseBrowserExport, toCSV } from '../src/csv.js';

const $ = (id) => document.getElementById(id);
let entries = [];
let gateMode = 'unlock';

// ---------- gate (create / unlock) ----------

function showGate(mode) {
  gateMode = mode;
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

$('lock').addEventListener('click', async () => {
  await call('lock');
  showGate('unlock');
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

function renderEntries() {
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
          pw
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

function openEditor(entry = {}) {
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
      },
    });
    $('editor').close();
    await loadEntries();
  } catch (err) {
    $('editor-error').textContent = err.message;
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

const SETTING_IDS = ['autofillOnLoad', 'loginFormsOnly', 'offerToSave', 'autoLockMinutes'];

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

$('change-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('cp-msg');
  msg.className = 'error';
  if ($('cp-next').value !== $('cp-next2').value) return (msg.textContent = 'New passwords do not match.');
  try {
    await call('changePassword', { current: $('cp-current').value, next: $('cp-next').value });
    ev.target.reset();
    msg.className = 'success';
    msg.textContent = 'Master password changed.';
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
  const { hasVault, locked } = await call('status');
  if (!hasVault) return showGate('create');
  if (locked) return showGate('unlock');
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('lock').classList.remove('hidden');
  await Promise.all([loadEntries(), loadSettings()]);

  const add = new URLSearchParams(location.hash.slice(1)).get('add');
  if (add) {
    history.replaceState(null, '', location.pathname);
    openEditor({ url: add });
  }
}

start();
