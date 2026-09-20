import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionFile, parseSessionFile, filterXState, MAX_SESSION_BYTES, type StorageState } from '../src/platforms/session.js';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function stateWith(cookies: Array<{ name: string; domain: string }>): StorageState {
  return {
    cookies: cookies.map(c => ({ name: c.name, value: 'v', domain: c.domain, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const })),
    origins: [],
  };
}

test('buildSessionFile keeps only X cookies and requires auth_token', () => {
  const state = stateWith([
    { name: 'auth_token', domain: '.x.com' },
    { name: 'ct0', domain: 'x.com' },
    { name: 'unrelated', domain: '.google.com' },
  ]);
  const file = buildSessionFile(state, 'owner');
  assert.equal(file.kind, 'crosspost-x-session');
  assert.equal(file.handle, 'owner');
  assert.ok(file.state.cookies.every(c => /x\.com|twitter\.com/.test(c.domain)));
  assert.ok(!file.state.cookies.some(c => c.name === 'unrelated'));
});

test('buildSessionFile refuses a profile with no auth_token', () => {
  assert.throws(() => buildSessionFile(stateWith([{ name: 'ct0', domain: 'x.com' }]), 'owner'), /auth_token/);
});

test('filterXState drops non-X origins', () => {
  const filtered = filterXState({
    cookies: [],
    origins: [{ origin: 'https://x.com', localStorage: [] }, { origin: 'https://evil.example', localStorage: [] }],
  });
  assert.equal(filtered.origins.length, 1);
  assert.equal(filtered.origins[0]!.origin, 'https://x.com');
});

test('parseSessionFile round-trips a valid file', () => {
  const file = buildSessionFile(stateWith([{ name: 'auth_token', domain: '.x.com' }]), 'owner');
  const parsed = parseSessionFile(encode(file));
  assert.equal(parsed.handle, 'owner');
  assert.ok(parsed.state.cookies.some(c => c.name === 'auth_token'));
});

test('parseSessionFile rejects non-JSON', () => {
  assert.throws(() => parseSessionFile(new TextEncoder().encode('not json')), /valid JSON/);
});

test('parseSessionFile rejects the wrong envelope kind', () => {
  assert.throws(() => parseSessionFile(encode({ kind: 'something-else', version: 1, state: { cookies: [] } })), /wrong kind/);
});

test('parseSessionFile rejects a file with no X auth cookie', () => {
  assert.throws(() => parseSessionFile(encode({ kind: 'crosspost-x-session', version: 1, handle: 'o', exportedAt: '', state: { cookies: [{ name: 'ct0', value: 'v', domain: 'x.com' }] } })), /auth_token/);
});

test('parseSessionFile rejects an oversized file before parsing', () => {
  const big = new Uint8Array(MAX_SESSION_BYTES + 1);
  assert.throws(() => parseSessionFile(big), /too large/);
});
