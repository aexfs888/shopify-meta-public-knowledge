import crypto from 'node:crypto';
import { OFFICIAL_HOSTS } from './constants.mjs';

export function canonicalizeUrl(input) {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+/g, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function isAllowedOfficialUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password || url.port) return false;
    return OFFICIAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function sourceIdForUrl(url, publisher = 'official') {
  const canonical = canonicalizeUrl(url);
  const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const prefix = String(publisher).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'official';
  return `${prefix}-${digest}`;
}

export function resolveOfficialLink(baseUrl, href) {
  try {
    const resolved = canonicalizeUrl(new URL(href, baseUrl).toString());
    return isAllowedOfficialUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

