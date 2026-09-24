import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { BlueskyClient } from '../src/platforms/bluesky.js';
import { SharkeyClient } from '../src/platforms/sharkey.js';
import type { HttpResponse, Transport } from '../src/types.js';

const did = 'did:web:author.example';
const instant = '2026-09-24T00:00:00.000Z';
const json = (value: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) });

test('Bluesky retains rotated sessions without a persistence callback and retries with the refreshed token', async () => {
  const requests: Array<{ method: string; token?: string }> = [];
  let loginCalls = 0, refreshCalls = 0, createCalls = 0;
  const transport: Transport = { async request(url, options) {
    const method = url.split('/xrpc/')[1];
    requests.push({ method: method ?? 'did', token: options?.headers?.authorization });
    if (!method) return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] });
    if (method === 'com.atproto.server.createSession') {
      loginCalls++;
      return json({ did, handle: 'author.example', accessJwt: 'first', refreshJwt: 'refresh-first' });
    }
    if (method === 'com.atproto.server.refreshSession') {
      refreshCalls++;
      assert.equal(options?.headers?.authorization, 'Bearer refresh-first');
      return json({ did, handle: 'author.example', accessJwt: 'second', refreshJwt: 'refresh-second' });
    }
    if (method === 'com.atproto.repo.createRecord') {
      if (++createCalls === 1) return json({ error: 'ExpiredToken' }, 401);
      assert.equal(options?.headers?.authorization, 'Bearer second');
      const request = JSON.parse(String(options?.body));
      return json({ uri: `at://${did}/app.bsky.feed.post/${request.rkey}`, cid: 'offline-cid', validationStatus: 'valid' });
    }
    throw new Error('Unexpected request');
  } };
  const client = new BlueskyClient(loadConfig({ BLUESKY_IDENTIFIER: did, BLUESKY_APP_PASSWORD: 'offline' }).bluesky, transport);
  for (const key of ['first-post', 'next-post']) {
    await client.publish({ key, sourcePostId: key, text: key, images: [] }, { idempotencyKey: key });
  }
  assert.equal(loginCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(createCalls, 3);
  assert.equal(requests.at(-1)!.token, 'Bearer second');
});

test('native collectors retain their three-page bound and refuse an uncovered backlog', async () => {
  for (const platform of ['bluesky', 'sharkey'] as const) {
    let pages = 0;
    const transport: Transport = { async request(url, options) {
      if (url.endsWith('/.well-known/did.json')) return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] });
      if (url.endsWith('/users/show')) return json({ id: 'owner', username: 'owner', host: null });
      pages++;
      if (platform === 'bluesky') {
        assert.equal(new URL(url).searchParams.get('cursor'), pages === 1 ? null : String(pages - 1));
        return json({ cursor: String(pages), feed: [{ post: { uri: `at://${did}/app.bsky.feed.post/post${pages}`, cid: 'offline-cid',
          author: { did, labels: [] }, labels: [], record: { $type: 'app.bsky.feed.post', text: 'body', createdAt: instant } } }] });
      }
      const body = JSON.parse(String(options?.body));
      assert.equal(body.untilId, pages === 1 ? undefined : `note${(pages - 1) * 100 - 1}`);
      assert.equal(body.sinceId, undefined);
      return json(Array.from({ length: 100 }, (_, i) => ({ id: `note${(pages - 1) * 100 + i}`, userId: 'owner', user: { id: 'owner', host: null },
        text: 'body', createdAt: instant, cw: null, replyId: null, renoteId: null, files: [], localOnly: false, visibility: 'public' })));
    } };
    const config = loadConfig({ BLUESKY_IDENTIFIER: did, SHARKEY_USERNAME: 'owner' });
    const client = platform === 'bluesky' ? new BlueskyClient(config.bluesky, transport) : new SharkeyClient(config.sharkey, transport);
    const snapshot = await client.collect('2026-09-23T00:00:00.000Z');
    assert.equal(pages, 3);
    assert.equal(snapshot.complete, false);
    assert.ok(snapshot.warnings.some(warning => /page budget/.test(warning)));
  }
});
