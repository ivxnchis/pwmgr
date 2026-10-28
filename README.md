# PwMgr — offline password manager extension

A Chrome/Edge (Manifest V3) extension that keeps your passwords **only on your computer**, encrypted with a master password, and fills them in automatically like the browser's own password manager.

## Features

- **Automatic autofill.** When a page with a sign-in form loads, the matching login is filled in without opening the extension (filled fields get Chrome's light-blue tint). Clicking a username or password field shows a dropdown to pick another saved login.
- **Turn autofill off for one field.** Right-click any field → **PwMgr → Turn autofill off / on for this field**. The block is remembered for that field on that site. Fields that are blocked also get `autocomplete="off"` / `new-password`, and if Chrome's own password manager still fills them, PwMgr puts back the value the page originally had. There is also **Turn autofill off / on for this whole site**. You can review and undo blocks in *Manage → No-autofill fields*.
- **No overwriting your data.** Autofill on page load only fills empty fields, and by default only on small sign-in forms. Edit forms with many fields (a player's details, for example) are skipped. The dropdown still works there if you want it.
- **Import from Chrome or Edge.** Supports the CSV that *Export passwords* creates (Firefox CSVs work too). Logins for the same site and username are updated rather than duplicated.
- **Export** to a Chrome-compatible CSV for backups.
- **2FA codes (TOTP, same as Google Authenticator).** You can link an authenticator key to any saved login in three ways:
  - **Type the key.** Edit the login and enter the setup key the site shows, or an `otpauth://` link.
  - **QR image.** In the same field, choose a picture of the QR code or paste a screenshot with Ctrl+V.
  - **Scan the page.** While the site's 2FA setup page shows the QR code, open the popup and click **Add 2FA**. It reads the QR code straight from the page.

  To move existing accounts out of Google Authenticator, use *Manage → Import / Export → Import 2FA codes*. Take screenshots of the app's *Transfer accounts → Export* QR codes and choose them there; each account is matched to a saved login for you to confirm. Codes then fill automatically into verification-code fields (single field or six separate digit boxes), show in the field dropdown, and appear with a countdown and **Copy code** button in the popup and the manage page.
- **Fingerprint / passkey unlock.** Under *Manage → Settings → Fingerprint / passkey unlock*, add Windows Hello, Touch ID, a phone passkey or a FIDO2 security key, then unlock with it instead of typing the master password. You can unlock from the toolbar popup, from the manage page, or from the **🔒 Unlock PwMgr** item that appears when you click a login field while the vault is locked. The master password always keeps working as a backup.
- **Offers to save** new or changed passwords after you sign in (Save / Never for this site / Not now).
- Popup: unlock, logins for the current site (Fill / copy), and search across all logins. The manage page lets you add, edit, delete, reveal and generate passwords.

## Install

Ready-made packages are in [`dist/`](dist/): `pwmgr.zip` and `pwmgr.crx`. The extension ID is always `llacdoihjbcfebjdojdkpfmgpglnadkf`, so updating keeps your saved passwords.

**Recommended (works everywhere): ZIP + Load unpacked**

1. Download `dist/pwmgr.zip` and unzip it somewhere permanent, for example `Documents/pwmgr`. Don't delete that folder later: the browser loads the extension from it.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped `pwmgr` folder.

To update, unzip the new version over the same folder and click the reload ↻ icon on the extension's card.

**CRX file**

Drag `dist/pwmgr.crx` onto the `chrome://extensions` / `edge://extensions` page with Developer mode on. Chrome on **Windows and macOS refuses** `.crx` files that don't come from the Chrome Web Store (you'll see an error such as *CRX_REQUIRED_PROOF_MISSING*, or the extension gets disabled). It works on Linux and in browsers managed by enterprise policy. If it's refused, use the ZIP instead.

**Then:**

4. Click the PwMgr toolbar icon and create a master password.
5. **Turn off the browser's own password manager** so the two don't both fill fields:
   - Chrome: `chrome://password-manager/settings` → turn off *Offer to save passwords* and *Sign in automatically*.
   - Edge: `edge://settings/passwords` → turn off *Offer to save passwords* and *Autofill passwords*.
   - If the unwanted fill is addresses or names rather than passwords, also turn off `chrome://settings/addresses`.

## Import your passwords

- **Chrome:** `chrome://password-manager/settings` → *Export passwords* → *Download file*.
- **Edge:** `edge://wallet/passwords` (or `edge://settings/passwords`) → *⋯* → *Export passwords*.

Then go to PwMgr → *Manage* → *Import / Export*, choose the CSV and click **Import**. **Delete the CSV afterwards**: it holds every password in plain text.

(Extensions can't read the browser's password store directly, so exporting a CSV is the only way to import.)

## Security model

- The vault is encrypted with AES-256-GCM. The key is derived from your master password with PBKDF2-SHA256 (600,000 iterations) and saved in `chrome.storage.local`.
- After you unlock, the key is held in `chrome.storage.session`. That storage is memory only, cleared when the browser closes, and not readable by web pages or content scripts. An optional auto-lock timer is under *Settings*.
- Pages never get the vault itself. A content script asks the background worker for one credential at a time, and the worker checks it against the URL Chrome reports for that frame. A credential saved for `https://` is never filled on `http://`, and a parent domain's login is never offered to a different domain.
- 2FA keys are stored inside the encrypted vault like passwords. Pages only ever receive the current 6–8 digit code, and only for a login that matches the page's site. Keeping your password and 2FA key in the same vault is convenient, but it means the vault alone gets past both. If you'd rather keep them separate for critical accounts (email, bank), keep those 2FA keys on your phone only.
- Passkey unlock uses the WebAuthn **PRF** extension. The authenticator derives a secret that only it can reproduce, after your fingerprint/PIN check, and that secret encrypts a copy of the vault key. Nothing that could unlock the vault without the authenticator is stored. Authenticators without PRF support are refused rather than falling back to something weaker. Changing the master password removes the passkeys; add them again afterwards.
- No network permissions are used and nothing is uploaded anywhere.
- Your master password **cannot be recovered**. Keep an exported backup somewhere safe if you need one.

## Develop

```bash
npm test
```

To rebuild the packages, run the command below. Signing the `.crx` needs the private key `pwmgr-key.pem`, which is kept out of git. Without it, only the ZIP is built.

```bash
scripts/build.sh path/to/pwmgr-key.pem
```

The unit tests cover CSV import/export, URL matching, import merging, encryption and TOTP (including the RFC 6238 test vectors and Google Authenticator export parsing). No build step or dependencies are needed.

Layout: `src/background.js` (vault and message handling), `src/content.js` (form detection, autofill, dropdown, blocking, save prompt), `src/crypto.js`, `src/csv.js`, `src/match.js`, `src/vault.js`, `popup/`, `options/`, `ui/`.

## Known limitations

- Only time-based (TOTP) 2FA is supported. Counter-based (HOTP) accounts in a Google Authenticator export are skipped and reported. SMS and email codes can't be generated.
- QR decoding uses the bundled [jsQR](https://github.com/cozmo/jsQR) library (Apache-2.0, `vendor/`), so it works offline.
- Passkey unlock needs an authenticator with PRF support: Google Password Manager or iCloud Keychain passkeys, a recent Windows 11 Windows Hello, or most FIDO2 security keys. Older Windows Hello versions may refuse; the setup screen tells you if so.

- Fields inside shadow DOM (some web components) are not detected yet.
- Logins inside cross-origin iframes are matched to the iframe's site, not the top page.
- On username-first sign-in flows (email on one page, password on the next), the save prompt may not see the username.
