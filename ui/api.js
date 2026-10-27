// Thin wrapper over messaging to the background service worker.
export async function call(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
  return res;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node[k] = v;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

export async function copy(text) {
  await navigator.clipboard.writeText(text);
}

export function generatePassword(length = 20) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+?';
  const out = [];
  const rnd = new Uint32Array(length);
  crypto.getRandomValues(rnd);
  for (const n of rnd) out.push(chars[n % chars.length]);
  return out.join('');
}
