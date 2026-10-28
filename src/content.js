// Runs in every page/frame: finds login forms, autofills them, shows the credential dropdown,
// honours per-field / per-site blocks and offers to save new passwords.
(() => {
  if (window.__pwmgrLoaded) return;
  window.__pwmgrLoaded = true;

  const TEXT_TYPES = new Set(['text', 'email', 'tel']);
  const USER_HINT = /user|e-?mail|login|account|identifier|phone|correo|usuario|cuenta/i;
  const OTP_HINT = /one.?time|\botp\b|totp|2fa|mfa|two.?factor|verification.?code|verify.?code|security.?code|auth(entication)?.?code|passcode|\btoken\b|c[oó]digo/i;
  const OTP_EXCLUDE = /cvv|cvc|card|promo|coupon|discount|gift|zip|postal|phone|captcha|referral/i;
  const SUBMIT_HINT = /log ?in|sign ?in|continue|next|submit|enter|entrar|iniciar|acceder|siguiente|ingresar/i;
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  let state = {
    hasVault: false,
    locked: true,
    settings: {},
    credentials: [],
    blockedKeys: new Set(),
    siteBlocked: false,
  };
  const handled = new WeakSet(); // fields we already considered for on-load autofill
  const filledByUs = new WeakMap(); // field -> value we wrote
  let lastContextTarget = null;
  let badgeSent = false;

  // ---------- messaging ----------

  async function send(msg) {
    try {
      return (await chrome.runtime.sendMessage(msg)) || { ok: false };
    } catch {
      return { ok: false }; // extension reloaded / context invalidated
    }
  }

  // ---------- field helpers ----------

  function isVisible(el) {
    if (!el.isConnected || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }

  function isTextLike(el) {
    return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type) && !el.readOnly;
  }

  function labelOf(el) {
    const text =
      el.labels?.[0]?.textContent ||
      el.getAttribute('aria-label') ||
      (el.getAttribute('aria-labelledby') &&
        el.getAttribute('aria-labelledby').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')) ||
      el.getAttribute('placeholder') ||
      '';
    return text.replace(/\s+/g, ' ').trim();
  }

  // A stable identifier for a field so a block survives reloads (and different records on the same site).
  function fieldKey(el) {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}|name=${name}`;
    const id = el.id;
    if (id && !/\d{3,}|^:r|[-_][a-f0-9]{6,}/i.test(id)) return `${tag}|id=${id}`;
    const label = labelOf(el);
    if (label) return `${tag}|label=${label.slice(0, 60)}`;
    const scope = el.form || document;
    return `${tag}|idx=${[...scope.querySelectorAll('input,textarea,select')].indexOf(el)}`;
  }

  function describe(el) {
    return labelOf(el) || el.getAttribute('name') || el.id || el.type || 'field';
  }

  function isBlocked(el) {
    return state.siteBlocked || state.blockedKeys.has(fieldKey(el));
  }

  function setValue(el, value) {
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Smallest ancestor of a password field that also holds text inputs before it (its "form").
  function scopeOf(pwd) {
    if (pwd.form) return pwd.form;
    let node = pwd.parentElement;
    for (let depth = 0; node && node !== document.documentElement && depth < 8; depth++, node = node.parentElement) {
      const before = [...node.querySelectorAll('input')].some(
        (i) => isTextLike(i) && i.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (before) return node;
    }
    return pwd.parentElement || document.body;
  }

  function findUsernameField(pwd, scope) {
    const before = [...scope.querySelectorAll('input')].filter(
      (i) => isTextLike(i) && isVisible(i) && i.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const hinted = (i) =>
      i.type === 'email' || USER_HINT.test(`${i.name} ${i.id} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`);
    return (
      before.find((i) => /\b(username|email)\b/.test(i.autocomplete)) ||
      [...before].reverse().find(hinted) ||
      before[before.length - 1] ||
      null
    );
  }

  // Heuristic: a small form with a single password field is a sign-in form. Edit pages
  // with many inputs (e.g. a player's details) are not, so we don't fill them on load.
  function looksLikeLogin(pwd, scope) {
    if (/new-password/.test(pwd.autocomplete)) return false;
    const fields = [...scope.querySelectorAll('input,select,textarea')].filter(
      (i) => i !== pwd && isVisible(i) && !['hidden', 'submit', 'button', 'checkbox', 'radio', 'image', 'reset'].includes(i.type)
    );
    if (fields.some((i) => i.type === 'password')) return false;
    return fields.length <= 3;
  }

  function findGroups() {
    const groups = [];
    for (const pwd of document.querySelectorAll('input[type=password]')) {
      if (!isVisible(pwd) || pwd.readOnly) continue;
      const scope = scopeOf(pwd);
      groups.push({ pwd, user: findUsernameField(pwd, scope), scope, isLogin: looksLikeLogin(pwd, scope) });
    }
    if (!groups.length) {
      // Username-first sign-in pages (password asked on the next step).
      for (const user of document.querySelectorAll('input[autocomplete~="username"]')) {
        if (isTextLike(user) && isVisible(user)) groups.push({ pwd: null, user, scope: user.form || document.body, isLogin: true });
      }
    }
    return groups;
  }

  // ---------- 2FA (TOTP) code fields ----------

  function isOtpInput(el) {
    if (!(el instanceof HTMLInputElement) || !['text', 'tel', 'number'].includes(el.type) || el.readOnly) return false;
    if (/\bone-time-code\b/.test(el.autocomplete)) return true;
    const hay = `${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${labelOf(el)}`;
    if (!OTP_HINT.test(hay) || OTP_EXCLUDE.test(hay)) return false;
    return !(el.maxLength > 0 && (el.maxLength < 6 || el.maxLength > 10));
  }

  // Returns [{ otp: [inputs] }]: either one code field or a row of 6–8 one-digit boxes.
  function findOtpGroups() {
    const groups = [];
    const singles = [...document.querySelectorAll('input')].filter(
      (i) => i.maxLength === 1 && ['text', 'tel', 'password'].includes(i.type) && !i.readOnly && isVisible(i)
    );
    const byContainer = new Map();
    for (const i of singles) {
      let node = i.parentElement;
      let found = null;
      for (let depth = 0; node && depth < 3 && !found; depth++, node = node.parentElement) {
        if (singles.filter((s) => node.contains(s)).length >= 6) found = node;
      }
      if (!found) continue;
      node = found;
      if (!byContainer.has(node)) byContainer.set(node, []);
      byContainer.get(node).push(i);
    }
    const inSplit = new Set();
    for (const digits of byContainer.values()) {
      if (digits.length < 6 || digits.length > 8) continue;
      groups.push({ otp: digits });
      digits.forEach((d) => inSplit.add(d));
    }
    for (const el of document.querySelectorAll('input')) {
      if (!inSplit.has(el) && isOtpInput(el) && isVisible(el)) groups.push({ otp: [el] });
    }
    return groups;
  }

  function otpGroupFor(el) {
    return findOtpGroups().find((g) => g.otp.includes(el)) || null;
  }

  async function fillOtp(group, id, { onlyEmpty }) {
    const fields = group.otp;
    if (fields.some(isBlocked) || (onlyEmpty && fields.some((f) => f.value))) return false;
    const res = await send({ type: 'getTotp', id });
    if (!res.ok) return false;
    if (fields.length === 1) markFilled(fields[0], res.code);
    else [...res.code].forEach((digit, i) => fields[i] && markFilled(fields[i], digit));
    return true;
  }

  async function autofillTotp() {
    if (!state.settings.autofillTotp || state.siteBlocked || state.locked) return;
    const cred = state.credentials.find((c) => c.hasTotp);
    if (!cred) return;
    for (const g of findOtpGroups()) {
      if (handled.has(g.otp[0])) continue;
      handled.add(g.otp[0]);
      await fillOtp(g, cred.id, { onlyEmpty: true });
    }
  }

  function groupFor(el) {
    return findGroups().find((g) => g.pwd === el || g.user === el) || null;
  }

  // ---------- filling ----------

  function markFilled(el, value) {
    setValue(el, value);
    filledByUs.set(el, value);
    el.setAttribute('data-pwmgr-filled', '');
  }

  async function fillGroup(group, id, { onlyEmpty }) {
    const res = await send({ type: 'getCredential', id });
    if (!res.ok) return false;
    const { user, pwd } = group;
    if (user && res.username && !isBlocked(user) && !(onlyEmpty && user.value)) markFilled(user, res.username);
    if (pwd && !isBlocked(pwd) && !(onlyEmpty && pwd.value)) markFilled(pwd, res.password);
    return true;
  }

  async function autofillOnLoad() {
    const { settings, credentials } = state;
    if (!settings.autofillOnLoad || state.siteBlocked || state.locked || !credentials.length) return;
    for (const g of findGroups()) {
      const anchor = g.pwd || g.user;
      if (handled.has(anchor)) continue;
      handled.add(anchor);
      if (settings.loginFormsOnly && !g.isLogin) continue;
      // If a username is already typed, only fill the password that belongs to it.
      const typed = g.user?.value;
      const cred = typed ? credentials.find((c) => c.username === typed) : credentials[0];
      if (cred) await fillGroup(g, cred.id, { onlyEmpty: true });
    }
  }

  // ---------- blocked fields: also undo the browser's own autofill there ----------

  function restoreField(el) {
    const original = el.defaultValue || '';
    nativeSetter.call(el, original === ' ' ? '' : ' ');
    setValue(el, original);
    el.removeAttribute('data-pwmgr-filled');
    filledByUs.delete(el);
  }

  function applyBlocks() {
    for (const el of document.querySelectorAll('input,textarea')) {
      const blocked = isBlocked(el);
      if (blocked && !el.hasAttribute('data-pwmgr-blocked')) {
        el.setAttribute('data-pwmgr-blocked', '');
        el.setAttribute('autocomplete', el.type === 'password' ? 'new-password' : 'off');
        if (el instanceof HTMLInputElement && (filledByUs.get(el) === el.value || el.matches(':-webkit-autofill'))) restoreField(el);
      } else if (!blocked && el.hasAttribute('data-pwmgr-blocked')) {
        el.removeAttribute('data-pwmgr-blocked');
      }
    }
  }

  function injectStyle() {
    if (document.getElementById('pwmgr-style')) return;
    const style = document.createElement('style');
    style.id = 'pwmgr-style';
    style.textContent = `
      input[data-pwmgr-filled]{background-color:#e8f0fe !important;background-image:none !important}
      @keyframes pwmgr-native-autofill{from{outline-color:inherit}to{outline-color:inherit}}
      input[data-pwmgr-blocked]:-webkit-autofill{animation:pwmgr-native-autofill 1ms}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Chrome starts this animation whenever it autofills a field we marked as blocked.
  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName === 'pwmgr-native-autofill' && e.target instanceof HTMLInputElement) restoreField(e.target);
    },
    true
  );

  document.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && e.target instanceof HTMLInputElement && e.target.hasAttribute('data-pwmgr-filled')) {
        e.target.removeAttribute('data-pwmgr-filled');
        filledByUs.delete(e.target);
      }
    },
    true
  );

  // ---------- in-page UI (shadow DOM so the site's CSS can't touch it) ----------

  const UI_CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .menu{position:fixed;z-index:2147483647;min-width:220px;max-width:360px;background:#fff;color:#1f2937;
      border:1px solid #d1d5db;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;overflow:hidden}
    .item{display:flex;flex-direction:column;padding:7px 10px;border-radius:6px;cursor:pointer}
    .item:hover,.item.active{background:#eef2ff}
    .u{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .s{color:#6b7280;font-size:12px}
    .note{padding:8px 10px;color:#4b5563}
    .foot{border-top:1px solid #e5e7eb;margin-top:4px;padding:6px 10px 3px;color:#6b7280;font-size:11px}
    .toast{position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111827;color:#fff;padding:10px 14px;
      border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:340px}
    .banner{position:fixed;z-index:2147483647;top:12px;right:12px;width:320px;background:#fff;color:#1f2937;
      border:1px solid #d1d5db;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.2);padding:14px}
    .banner h3{margin:0 0 4px;font-size:14px;font-weight:600}
    .banner p{margin:0 0 12px;color:#4b5563;word-break:break-all}
    .row{display:flex;gap:8px;justify-content:flex-end}
    button{border:1px solid #d1d5db;background:#fff;color:#1f2937;border-radius:6px;padding:6px 12px;cursor:pointer}
    button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
    @media (prefers-color-scheme: dark){
      .menu,.banner{background:#1f2937;color:#f3f4f6;border-color:#374151}
      .item:hover,.item.active{background:#374151}
      .s,.note,.foot,.banner p{color:#9ca3af}
      .foot{border-color:#374151}
      button{background:#111827;color:#f3f4f6;border-color:#4b5563}
    }
  `;

  function makeHost() {
    const host = document.createElement('pwmgr-ui');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    root.appendChild(style);
    document.documentElement.appendChild(host);
    return { host, root };
  }

  // ----- dropdown -----

  let menu = null; // { host, root, box, target, group, items, active }

  function hideMenu() {
    menu?.host.remove();
    menu = null;
  }

  function positionMenu() {
    if (!menu) return;
    const r = menu.target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return hideMenu();
    menu.box.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 230))}px`;
    menu.box.style.top = `${r.bottom + 4}px`;
    menu.box.style.minWidth = `${Math.max(220, r.width)}px`;
  }

  function showMenu(target, group) {
    hideMenu();
    const { host, root } = makeHost();
    const box = document.createElement('div');
    box.className = 'menu';
    box.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
    root.appendChild(box);
    menu = { host, root, box, target, group, items: [], active: -1 };

    if (state.locked) {
      const unlockItem = document.createElement('div');
      unlockItem.className = 'item';
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = '🔒 Unlock PwMgr';
      const s = document.createElement('span');
      s.className = 's';
      s.textContent = 'Fingerprint, passkey or master password';
      unlockItem.append(u, s);
      unlockItem.addEventListener('click', () => {
        hideMenu();
        send({ type: 'openUnlockWindow' });
      });
      box.appendChild(unlockItem);
    } else {
      for (const cred of group.otp ? state.credentials.filter((c) => c.hasTotp) : state.credentials) {
        const item = document.createElement('div');
        item.className = 'item';
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = group.otp ? `🔢 2FA code — ${cred.username || cred.name}` : cred.username || '(no username)';
        const s = document.createElement('span');
        s.className = 's';
        s.textContent = cred.name;
        item.append(u, s);
        item.addEventListener('click', () => pick(cred.id));
        box.appendChild(item);
        menu.items.push({ item, id: cred.id });
      }
      const foot = document.createElement('div');
      foot.className = 'foot';
      foot.textContent = 'Right-click a field → PwMgr to stop autofill there';
      box.appendChild(foot);
    }
    positionMenu();
  }

  async function pick(id) {
    const group = menu?.group;
    hideMenu();
    if (group?.otp) await fillOtp(group, id, { onlyEmpty: false });
    else if (group) await fillGroup(group, id, { onlyEmpty: false });
  }

  function setActive(i) {
    if (!menu?.items.length) return;
    menu.active = (i + menu.items.length) % menu.items.length;
    menu.items.forEach((it, n) => it.item.classList.toggle('active', n === menu.active));
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !state.hasVault) return;
      if (menu?.target === el) return;
      const otp = otpGroupFor(el);
      if (otp) {
        if (!isBlocked(el) && !state.locked && state.credentials.some((c) => c.hasTotp)) showMenu(el, otp);
        else hideMenu();
        return;
      }
      const group = groupFor(el);
      if (!group || isBlocked(el)) return hideMenu();
      if (state.locked ? el === group.pwd : state.credentials.length) showMenu(el, group);
      else hideMenu();
    },
    true
  );
  document.addEventListener('focusout', (e) => menu?.target === e.target && setTimeout(() => menu?.target !== document.activeElement && hideMenu(), 100), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (!menu || e.target !== menu.target) return;
      if (e.key === 'Escape') hideMenu();
      else if (e.key === 'ArrowDown') (setActive(menu.active + 1), e.preventDefault());
      else if (e.key === 'ArrowUp') (setActive(menu.active - 1), e.preventDefault());
      else if (e.key === 'Enter' && menu.active >= 0) (e.preventDefault(), pick(menu.items[menu.active].id));
      else if (e.key.length === 1 || e.key === 'Backspace') hideMenu();
    },
    true
  );
  addEventListener('scroll', positionMenu, true);
  addEventListener('resize', positionMenu);

  // ----- toast -----

  function toast(text) {
    const { host, root } = makeHost();
    const box = document.createElement('div');
    box.className = 'toast';
    box.textContent = text;
    root.appendChild(box);
    setTimeout(() => host.remove(), 2800);
  }

  // ----- save banner (top frame only) -----

  let bannerShown = false;

  async function checkPendingSave() {
    if (window !== window.top || bannerShown) return;
    const res = await send({ type: 'peekPendingSave' });
    if (!res.ok || !res.pending) return;
    bannerShown = true;
    const { host, root } = makeHost();
    const box = document.createElement('div');
    box.className = 'banner';
    const h = document.createElement('h3');
    h.textContent = res.pending.isUpdate ? `Update password for ${res.pending.host}?` : `Save password for ${res.pending.host}?`;
    const p = document.createElement('p');
    p.textContent = res.pending.username ? `Username: ${res.pending.username}` : 'No username detected';
    const row = document.createElement('div');
    row.className = 'row';
    const button = (label, action, primary) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', async () => {
        host.remove();
        bannerShown = false;
        await send({ type: 'resolvePendingSave', action });
      });
      return b;
    };
    row.append(button('Never for this site', 'never'), button('Not now', 'dismiss'), button(res.pending.isUpdate ? 'Update' : 'Save', 'save', true));
    box.append(h, p, row);
    root.appendChild(box);
  }

  // ---------- capturing submitted credentials ----------

  function capture(scope) {
    if (!state.hasVault || state.locked) return;
    const pwds = [...(scope || document).querySelectorAll('input[type=password]')].filter((p) => p.value);
    if (!pwds.length) return;
    const pwd = pwds.find((p) => /new-password/.test(p.autocomplete)) || pwds[pwds.length === 3 ? 1 : pwds.length - 1];
    const pScope = scopeOf(pwd);
    let user = findUsernameField(pwd, pScope);
    if (!user?.value) user = pScope.querySelector('input[autocomplete~="username"]') || user;
    send({ type: 'captureCredentials', username: (user?.value || '').trim(), password: pwd.value });
    setTimeout(checkPendingSave, 1200);
  }

  document.addEventListener('submit', (e) => capture(e.target), true);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      const btn = e.target.closest('button,input[type=submit],input[type=button],[role=button]');
      if (!btn) return;
      const isSubmit = (btn.type === 'submit' && btn.form) || SUBMIT_HINT.test(btn.textContent || btn.value || '');
      if (isSubmit) capture(btn.form || document);
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.isTrusted && e.target instanceof HTMLInputElement && !menu) capture(e.target.form || document);
    },
    true
  );

  // ---------- context menu actions ----------

  document.addEventListener('contextmenu', (e) => (lastContextTarget = e.composedPath()[0]), true);

  async function toggleField() {
    const el = lastContextTarget;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      toast('PwMgr: right-click directly on a text field.');
      return;
    }
    const k = fieldKey(el);
    const res = await send({ type: 'toggleBlockedField', key: k, label: describe(el) });
    if (!res.ok) return toast(`PwMgr: ${res.error || 'could not update this field.'}`);
    if (res.blocked) state.blockedKeys.add(k);
    else state.blockedKeys.delete(k);
    applyBlocks();
    hideMenu();
    toast(res.blocked ? `Autofill is now OFF for “${describe(el)}” on this site.` : `Autofill is back ON for “${describe(el)}”.`);
  }

  async function toggleSite() {
    const res = await send({ type: 'toggleSiteBlocked' });
    if (!res.ok) return;
    state.siteBlocked = res.blocked;
    applyBlocks();
    hideMenu();
    toast(res.blocked ? `Autofill is now OFF for all of ${res.host}.` : `Autofill is back ON for ${res.host}.`);
  }

  // ---------- lifecycle ----------

  async function init() {
    const res = await send({ type: 'pageInit' });
    if (!res.ok) return;
    state = {
      hasVault: res.hasVault,
      locked: res.locked,
      settings: res.settings,
      credentials: res.credentials,
      blockedKeys: new Set(res.blockedKeys),
      siteBlocked: res.siteBlocked,
    };
    injectStyle();
    await scan();
    checkPendingSave();
  }

  async function scan() {
    applyBlocks();
    const groups = findGroups();
    if (groups.length && !badgeSent) {
      badgeSent = true;
      send({ type: 'loginFormSeen', count: state.credentials.length });
    }
    await autofillOnLoad();
    await autofillTotp();
  }

  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ctx-toggle-field') toggleField();
    else if (msg?.type === 'ctx-toggle-site') toggleSite();
    else if (msg?.type === 'vaultChanged') {
      badgeSent = false;
      hideMenu();
      init();
    } else if (msg?.type === 'fillCredential') {
      const groups = findGroups();
      const group = groups.find((g) => g.scope.contains(document.activeElement)) || groups[0];
      if (group) fillGroup(group, msg.id, { onlyEmpty: false });
      const otp = findOtpGroups()[0];
      if (otp) fillOtp(otp, msg.id, { onlyEmpty: false });
    }
  });

  init();
  // Late-rendering pages and the browser's own autofill both happen a little after load.
  for (const ms of [600, 1500, 3500]) setTimeout(scan, ms);
})();
