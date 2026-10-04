import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { BlueskyClient } from '../src/platforms/bluesky.js';
import { SharkeyClient } from '../src/platforms/sharkey.js';
import { XCollector } from '../src/platforms/x.js';
import type { Page } from 'playwright-core';
import type { HttpResponse, Transport } from '../src/types.js';

const did = 'did:web:author.example';
const instant = '2026-09-24T00:00:00.000Z';
const json = (value: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) });

test('X reloads only the exact Posts timeline, never a thread or Replies page', async () => {
  const profile = 'https://x.com/TW527E';
  const stop = new Error('Stop before reading the timeline');
  for (const current of [profile, `${profile}/status/2101987919871557884?s=20`, `${profile}/with_replies`, `${profile}_other`, 'about:blank']) {
    const calls: string[] = [];
    const page = {
      isClosed: () => false,
      url: () => current,
      async goto(url: string) { calls.push(`goto ${url}`); },
      async reload() { calls.push(`reload ${current}`); },
      async title() { throw stop; },
    } as unknown as Page;
    const collector = new XCollector(loadConfig({ X_HANDLE: 'TW527E' }).x);
    collector['page'] = page;
    await assert.rejects(() => collector.collect(), error => error === stop);
    assert.deepEqual(calls, [current === profile ? `reload ${profile}` : `goto ${profile}`], current);
  }
});

test('an X scan that scrolls past the checkpoint is complete even though every scroll keeps loading older tweets', async () => {
  // Newest first, one hour apart; each scroll renders four more, so the timeline never stops growing.
  const dates = Array.from({ length: 30 }, (_, i) => new Date(Date.parse(instant) - i * 3600_000).toISOString());
  let rendered = 5;
  const article = (i: number) => ({ locator: () => ({ first: () => ({ getAttribute: async () => `/TW527E/status/${1000 + i}` }) }) });
  const locator = (selector: string) => ({
    innerText: async () => '',
    count: async () => selector.startsWith('article') ? rendered : 1,
    all: async () => Array.from({ length: rendered }, (_, i) => article(i)),
    first() { return this; },
  });
  const page = {
    isClosed: () => false, url: () => 'https://x.com/TW527E', async reload() {}, async title() { return 'X'; },
    locator, waitForTimeout: async () => undefined,
    mouse: { async wheel() { rendered = Math.min(rendered + 4, dates.length); } },
  } as unknown as Page;
  const collector = new XCollector(loadConfig({ X_HANDLE: 'TW527E', X_MAX_PAGES: '4' }).x);
  collector['page'] = page;
  collector['hasReplyConnectorBelow'] = async () => false;
  collector['parseArticle'] = async (_article: unknown, ctx: { own: string; authorId: string }) => ({
    articleText: '',
    parsed: { id: ctx.own, authorId: ctx.authorId, createdAt: dates[Number(ctx.own) - 1000], text: '', replyToId: null, relationKnown: true,
      repost: false, attachments: [], poll: false, sensitive: false, metadataComplete: true },
  });
  const snapshot = await collector.collect(dates[10]);
  assert.equal(snapshot.complete, true, snapshot.warnings.join('; '));
  assert.ok(snapshot.posts.some(post => post.createdAt <= dates[10]!));
});

test('the X video lookup asks syndication once per tweet, skips it when video is off, and degrades to held', async () => {
  const xConfig = (): ReturnType<typeof loadConfig>['x'] => loadConfig({ X_HANDLE: 'TW527E' }).x;
  const media = { video: true, maxDownloadBytes: 20_000_000 };
  const mp4 = 'https://video.twimg.com/amplify_video/1/vid/a.mp4';
  const payload = { mediaDetails: [{ type: 'video', video_info: { duration_millis: 10_000,
    variants: [{ content_type: 'video/mp4', bitrate: 800_000, url: mp4 }] } }] };
  const calls: string[] = [];
  const collector = new XCollector(xConfig(), { async request(url) { calls.push(url); return json(payload); } }, media);
  assert.equal((await collector['resolveMedia']('123'))?.[0]?.url, mp4);
  await collector['resolveMedia']('123');
  assert.equal(calls.length, 1, 'the answer is cached per tweet id, not re-fetched on every scan');
  // A wrong parameter name here would 404 every lookup and be indistinguishable from "no video source".
  assert.match(calls[0]!, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=123&token=[0-9a-z]+&lang=en$/);

  // With video sync off the post is held as video_sync_disabled regardless, so nothing is requested.
  const off = new XCollector(xConfig(), { async request(url) { calls.push(url); return json(payload); } }, { ...media, video: false });
  assert.equal(await off['resolveMedia']('456'), undefined);
  assert.equal(calls.length, 1);

  // Every failure path must land on "no source", which is the behaviour that existed before this lookup.
  const failing: Transport[] = [
    { async request() { return json({ error: 'gone' }, 404); } },
    { async request() { return json({ mediaDetails: [{ type: 'photo' }] }); } },
    { async request() { return { status: 200, headers: {}, body: Buffer.from('not json') }; } },
    { async request() { throw new Error('offline'); } },
  ];
  for (const transport of failing) {
    assert.equal(await new XCollector(xConfig(), transport, media)['resolveMedia']('789'), undefined);
  }
});

// The real PDS answers an expired access token with HTTP 400 ExpiredToken; 401 is kept for other servers.
for (const expiredStatus of [400, 401]) test(`Bluesky retains rotated sessions without a persistence callback and retries with the refreshed token (HTTP ${expiredStatus})`, async () => {
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
      if (++createCalls === 1) return json({ error: 'ExpiredToken', message: 'Token has expired' }, expiredStatus);
      assert.equal(options?.headers?.authorization, 'Bearer second');
      const request = JSON.parse(String(options?.body));
      return json({ uri: `at://${did}/app.bsky.feed.post/${request.rkey}`, cid: 'offline-cid', validationStatus: 'valid' });
    }
    throw new Error('Unexpected request');
  } };
  const client = new BlueskyClient(loadConfig({ BLUESKY_IDENTIFIER: did, BLUESKY_APP_PASSWORD: 'offline' }).bluesky, transport);
  for (const key of ['first-post', 'next-post']) {
    const ref = await client.publish({ key, sourcePostId: key, text: key, media: [] }, { idempotencyKey: key });
    // bsky.app rejects a percent-encoded DID ("Invalid DID or handle").
    assert.ok(ref.url?.startsWith(`https://bsky.app/profile/${did}/post/`), ref.url);
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

test('native collectors only warn about incomplete posts newer than the last scan', async () => {
  const since = '2026-09-23T00:00:00.000Z';
  for (const platform of ['bluesky', 'sharkey'] as const) {
    const transport: Transport = { async request(url) {
      if (url.endsWith('/.well-known/did.json')) return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] });
      if (url.endsWith('/users/show')) return json({ id: 'owner', username: 'owner', host: null });
      // Both posts are incomplete (unknown embed / fileIds pointing at a deleted drive file); only the new one should warn.
      if (platform === 'bluesky') return json({ feed: [instant, '2023-07-29T00:00:00.000Z'].map((createdAt, i) => ({ post: { uri: `at://${did}/app.bsky.feed.post/p${i}`, cid: 'offline-cid',
        author: { did, labels: [] }, labels: [], embed: {}, record: { $type: 'app.bsky.feed.post', text: 'body', createdAt } } })) });
      return json([instant, '2023-07-29T00:00:00.000Z'].map((createdAt, i) => ({ id: `note${i}`, userId: 'owner', user: { id: 'owner', host: null },
        text: 'body', createdAt, cw: null, replyId: null, renoteId: null, files: [], fileIds: ['gone'], localOnly: false, visibility: 'public' })));
    } };
    const config = loadConfig({ BLUESKY_IDENTIFIER: did, SHARKEY_USERNAME: 'owner' });
    const client = platform === 'bluesky' ? new BlueskyClient(config.bluesky, transport) : new SharkeyClient(config.sharkey, transport);
    assert.equal((await client.collect(since)).warnings.length, 1, platform);
    const old = await client.collect(instant);
    assert.deepEqual(old.warnings, [], platform);
    assert.equal(old.complete, true, platform);
  }
});
