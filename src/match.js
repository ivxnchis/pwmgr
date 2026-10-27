// URL helpers deciding which saved credentials belong to a page.

export function parseUrl(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(str) ? str : `https://${str}`);
  } catch {
    return null;
  }
}

export function normHost(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

export function hostOf(raw) {
  const u = parseUrl(raw);
  return u && /^https?:$/.test(u.protocol) ? normHost(u.hostname) : '';
}

// Returns 2 for a same-host match, 1 when the page is a subdomain of the saved host, 0 otherwise.
export function matchScore(entryUrl, pageUrl) {
  const e = parseUrl(entryUrl);
  const p = parseUrl(pageUrl);
  if (!e || !p) return 0;
  if (!/^https?:$/.test(e.protocol) || !/^https?:$/.test(p.protocol)) return 0;
  // Never hand an https credential to a plain http page.
  if (e.protocol === 'https:' && p.protocol !== 'https:') return 0;
  const eh = normHost(e.hostname);
  const ph = normHost(p.hostname);
  if (!eh || !ph) return 0;
  if (eh === ph) return 2;
  if (ph.endsWith(`.${eh}`)) return 1;
  return 0;
}

export function findMatches(entries, pageUrl) {
  return entries
    .map((entry) => ({ entry, score: matchScore(entry.url, pageUrl) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (b.entry.lastUsed || 0) - (a.entry.lastUsed || 0))
    .map((m) => m.entry);
}
