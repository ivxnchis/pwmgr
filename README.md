# PwMgr — offline password manager extension

A Chrome/Edge (Manifest V3) extension that keeps your passwords **only on your computer**, encrypted with a master password, and fills them in automatically like the browser's own password manager.

## Features

- **Automatic autofill.** When a page with a sign-in form loads, the matching login is filled in without opening the extension (filled fields get Chrome's light-blue tint). Clicking a username or password field shows a dropdown to pick another saved login.
- **Turn autofill off for one field.** Right-click any field → **PwMgr → Turn autofill off / on for this field**. The block is remembered for that field on that site. Fields that are blocked also get `autocomplete="off"` / `new-password`, and if Chrome's own password manager still fills them, PwMgr puts back the value the page originally had. There is also **Turn autofill off / on for this whole site**. You can review and undo blocks in *Manage → No-autofill fields*.
- **No overwriting your data.** Autofill on page load only fills empty fields, and by default only on small sign-in forms. Edit forms with many fields (a player's details, for example) are skipped. The dropdown still works there if you want it.
- **Import from Chrome or Edge.** Supports the CSV that *Export passwords* creates (Firefox CSVs work too). Logins for the same site and username are updated rather than duplicated.
- **Export** to a Chrome-compatible CSV for backups.
- **Offers to save** new or changed passwords after you sign in (Save / Never for this site / Not now).
- Popup: unlock, logins for the current site (Fill / copy), and search across all logins. The manage page lets you add, edit, delete, reveal and generate passwords.

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder (the one that contains `manifest.json`).
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
- No network permissions are used and nothing is uploaded anywhere.
- Your master password **cannot be recovered**. Keep an exported backup somewhere safe if you need one.

## Develop

```bash
npm test
```

The unit tests cover CSV import/export, URL matching, import merging and encryption. No build step or dependencies are needed.

Layout: `src/background.js` (vault and message handling), `src/content.js` (form detection, autofill, dropdown, blocking, save prompt), `src/crypto.js`, `src/csv.js`, `src/match.js`, `src/vault.js`, `popup/`, `options/`, `ui/`.

## Known limitations

- Fields inside shadow DOM (some web components) are not detected yet.
- Logins inside cross-origin iframes are matched to the iframe's site, not the top page.
- On username-first sign-in flows (email on one page, password on the next), the save prompt may not see the username.
