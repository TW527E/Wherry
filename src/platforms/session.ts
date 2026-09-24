/**
 * X session portability: export the login from a logged-in browser profile as a small,
 * transferable file, and install it into a headless profile on another machine.
 *
 * The file is a Playwright storageState narrowed to X/Twitter cookies. It carries the real
 * account session (auth_token / ct0), so it is a SECRET — treat it like a password. It is not
 * a way to post; it only grants the same read access the interactive login would.
 */

import type { BrowserContext } from 'playwright-core';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Serialized session file: the storage state plus a small self-describing envelope. */
export interface SessionFile {
  kind: 'crosspost-x-session';
  version: 1;
  handle: string;
  exportedAt: string;
  state: StorageState;
}

/** Max bytes we will accept for an uploaded/loaded session file. A real X session is a few KB. */
export const MAX_SESSION_BYTES = 256 * 1024;

const X_DOMAIN = /(^|\.)(x\.com|twitter\.com)$/i;
/** Cookies X actually needs to be authenticated; presence of auth_token is our "is this a login" test. */
const REQUIRED_COOKIE = 'auth_token';

function isXCookieDomain(domain: string): boolean {
  return X_DOMAIN.test(domain.replace(/^\./, ''));
}

/** Keep only X/Twitter cookies and origins, dropping anything unrelated the profile may hold. */
export function filterXState(state: StorageState): StorageState {
  return {
    cookies: (state.cookies || []).filter(cookie => isXCookieDomain(cookie.domain)),
    origins: (state.origins || []).filter(origin => {
      try { return isXCookieDomain(new URL(origin.origin).hostname); } catch { return false; }
    }),
  };
}

export function buildSessionFile(state: StorageState, handle: string): SessionFile {
  const filtered = filterXState(state);
  if (!filtered.cookies.some(cookie => cookie.name === REQUIRED_COOKIE && cookie.value.trim())) {
    throw new Error('This profile has no X auth cookie (auth_token). Log in first with `login`, then export.');
  }
  return { kind: 'crosspost-x-session', version: 1, handle, exportedAt: new Date().toISOString(), state: filtered };
}

/**
 * Parse and validate bytes claimed to be a session file. Rejects anything that is not our
 * envelope or lacks a usable X auth cookie, so a stray upload can never seed a broken profile.
 */
export function parseSessionFile(bytes: Uint8Array): SessionFile {
  if (bytes.length > MAX_SESSION_BYTES) throw new Error(`Session file too large (> ${MAX_SESSION_BYTES} bytes); this does not look like an X session`);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Session file is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Session file is not an object');
  const file = parsed as Partial<SessionFile>;
  if (file.kind !== 'crosspost-x-session') throw new Error('Not a crosspost X session file (wrong kind)');
  if (file.version !== 1) throw new Error(`Unsupported session file version: ${String(file.version)}`);
  const state = file.state;
  if (!state || !Array.isArray(state.cookies)) throw new Error('Session file has no cookies');
  const cookies: StorageState['cookies'] = state.cookies
    .filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string'
      && typeof cookie.domain === 'string' && isXCookieDomain(cookie.domain))
    .map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
      expires: typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) ? cookie.expires : -1,
      httpOnly: cookie.httpOnly === true, secure: cookie.secure !== false,
      sameSite: (['Strict', 'Lax', 'None'] as const).includes(cookie.sameSite) ? cookie.sameSite : 'Lax',
    }));
  if (!cookies.some(cookie => cookie.name === REQUIRED_COOKIE && cookie.value.trim())) {
    throw new Error('Session file has no X auth cookie (auth_token); refusing to install');
  }
  return {
    kind: 'crosspost-x-session', version: 1,
    handle: typeof file.handle === 'string' ? file.handle : '',
    exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
    state: { cookies, origins: [] },
  };
}
