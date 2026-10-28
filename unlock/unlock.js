// Stand-alone unlock window. Toolbar popups close when Windows Hello / Touch ID takes focus,
// so passkey unlock runs here instead.
import { call } from '../ui/api.js';
import { passkeysSupported, unlockWithPasskey } from '../ui/passkey.js';

const $ = (id) => document.getElementById(id);

function done() {
  $('main').classList.add('hidden');
  $('done').classList.remove('hidden');
  setTimeout(() => window.close(), 700);
}

async function tryPasskey() {
  $('pk-error').textContent = '';
  $('pk-btn').disabled = true;
  try {
    await unlockWithPasskey();
    done();
  } catch (err) {
    $('pk-error').textContent = err.message;
  } finally {
    $('pk-btn').disabled = false;
  }
}

$('pk-btn').addEventListener('click', tryPasskey);

$('pw-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('pw-error').textContent = '';
  $('pw-btn').disabled = true;
  try {
    await call('unlock', { password: $('pw').value });
    done();
  } catch (err) {
    $('pw-error').textContent = err.message;
  } finally {
    $('pw-btn').disabled = false;
  }
});

const { hasVault, locked, passkeys } = await call('status');
if (!hasVault || !locked) done();
else if (passkeys && passkeysSupported()) {
  $('pk').classList.remove('hidden');
  tryPasskey();
} else {
  $('pw').focus();
}
