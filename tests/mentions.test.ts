import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRuntime } from '../src/app.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { renderXMentions, sliceMentions } from '../src/mentions.js';
import { parseTweetText } from '../src/platforms/x.js';
import { BlueskyClient, resolveBlueskyMentions } from '../src/platforms/bluesky.js';
import { splitText } from '../src/text.js';
import type { HttpResponse, SourcePost, Transport } from '../src/types.js';

const instant = '2026-09-25T00:00:00.000Z';
const did = 'did:web:author.example';
const pds = 'https://pds.example';
const json = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });
const mock = (request: Transport['request']): Transport => ({ request });
const post = (overrides: Partial<SourcePost>): SourcePost => ({ platform: 'x', id: '200', authorId: 'owner', createdAt: instant,
  text: '嗨@alice 和 @bob', mentions: [{ handle: 'alice', start: 1, end: 7 }, { handle: 'bob', start: 10, end: 14 }],
  replyToId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, ...overrides });

test('only an X profile anchor inside the body counts as a mention', () => {
  const parsed = parseTweetText('hi <a href="https://x.com/Alice">@Alice</a> and <a href="https://twitter.com/bob?ref=1">@bob</a> plain @carol');
  assert.equal(parsed.text, 'hi @Alice and @bob plain @carol');
  assert.deepEqual(parsed.mentions, [{ handle: 'Alice', start: 3, end: 9 }]);
  assert.equal(parsed.text.slice(3, 9), '@Alice', 'offsets address the text a consumer actually receives');
  // A bare @word is text, not an account. Neither is a link that merely LOOKS like a mention.
  assert.deepEqual(parseTweetText('ask @carol about it').mentions, []);
  assert.deepEqual(parseTweetText('<a href="https://x.com/mallory">@alice</a>').mentions, []);
  assert.deepEqual(parseTweetText('<a href="https://x.com/alice/status/9">@alice</a>').mentions, []);
  assert.deepEqual(parseTweetText('<a href="https://example.com/alice">@alice</a>').mentions, []);
  // A quoted tweet's mention belongs to the quoted author, never to this body.
  assert.deepEqual(parseTweetText('<div data-testid="quoteTweet"><div data-testid="tweetText"><a href="https://x.com/dave">@dave</a></div></div>').mentions, []);
  // A hashtag/cashtag anchor and a link anchor keep their visible text; a truncated link keeps its href.
  const links = parseTweetText('<a href="https://x.com/hashtag/x">#x</a> <a href="https://x.com/cashtag/x">$x</a> <a href="https://example.com/a/b">example.com/…</a> <a href="https://example.com/plain">example.com/plain</a> <img alt="🍵">');
  assert.equal(links.text, '#x $x https://example.com/a/b example.com/plain 🍵');
  assert.deepEqual(links.mentions, []);
});

test('mapped mentions become native IDs, unmapped ones a boundary-safe X link', () => {
  const mapped = renderXMentions(post({}), 'telegram', new Map([['alice', { telegram: 'alice_tg' }]]));
  assert.equal(mapped.text, '嗨@alice_tg 和 https://x.com/bob');
  assert.deepEqual(mapped.mentions, [{ handle: 'alice_tg', start: 1, end: 10 }]);
  assert.equal(mapped.text.slice(1, 10), '@alice_tg');
  // The fallback link is a real URL, so it needs whitespace on either side of adjacent text/punctuation.
  assert.deepEqual(renderXMentions(post({ text: '@bob。', mentions: [{ handle: 'bob', start: 0, end: 4 }] }), 'sharkey', new Map()),
    { text: 'https://x.com/bob 。', mentions: [] });
  // An @word with no recorded mention is never rewritten, even when a mapping for it exists.
  assert.deepEqual(renderXMentions(post({ text: '只有 @carol', mentions: [] }), 'telegram', new Map([['carol', { telegram: 'carol_tg' }]])),
    { text: '只有 @carol', mentions: [] });
});

test('splitting never cuts a mention in half', () => {
  const mention = { handle: 'alice', start: 299, end: 305 };
  const text = `${'x'.repeat(299)}@alice`;
  const chunks = splitText(text, { graphemes: 300 }, [mention]);
  assert.deepEqual(chunks, ['x'.repeat(299), '@alice']);
  assert.deepEqual(chunks.map((chunk, index) => sliceMentions([mention], index * 299, index * 299 + chunk.length)), [[], [{ ...mention, start: 0, end: 6 }]]);
  assert.throws(() => splitText('@alice', { graphemes: 3 }, [{ start: 0, end: 6 }]), /mention exceeds/);
  assert.throws(() => splitText('plain', { graphemes: 5 }, [{ start: 4, end: 99 }]), /Invalid protected text range/);
});

test('mapping storage validates, merges and clears per platform', () => {
  const store = new Store(':memory:');
  store.setMentionMapping('@Alice', { bluesky: 'Alice.Bsky.Social', telegram: '@alice_tg' });
  assert.deepEqual(store.mentionMapping('alice'), { bluesky: 'alice.bsky.social', telegram: 'alice_tg' });
  store.setMentionMapping('alice', { sharkey: '@alice@dvd.chat' });
  assert.deepEqual(store.mentionMapping('alice'), { bluesky: 'alice.bsky.social', sharkey: 'alice@dvd.chat', telegram: 'alice_tg' });
  assert.deepEqual([...store.mentionMappings().keys()], ['alice']);
  store.setMentionMapping('alice', { telegram: null });
  assert.deepEqual(store.mentionMapping('alice'), { bluesky: 'alice.bsky.social', sharkey: 'alice@dvd.chat' });
  for (const [handle, patch] of [['bad handle', { telegram: 'alice_tg' }], ['alice', { bluesky: 'no domain' }],
    ['alice', { sharkey: 'a@b@c' }], ['alice', { telegram: '12345' }], ['alice', { twitter: 'alice' }]] as const) {
    assert.throws(() => store.setMentionMapping(handle, patch as never));
  }
  assert.equal(store.deleteMentionMapping('alice'), true);
  assert.equal(store.deleteMentionMapping('alice'), false);
  assert.deepEqual(store.mentionMapping('alice'), {}, 'a deleted mapping falls back to the X link');
  store.close();
});

test('an X post with mentions renders native IDs, a Bluesky facet and an X link fallback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-mention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = loadConfig({ DATA_DIR: directory, APP_MODE: 'live', DESTINATIONS: 'telegram', BLUESKY_ENABLED: 'true' });
  const transport = mock(async url => url.includes('/xrpc/com.atproto.identity.resolveHandle?')
    ? json({ did: 'did:web:mapped.example' }) : Promise.reject(new Error(`Unexpected request: ${url}`)));
  const engine = new Engine(store, config, transport);
  const seal = (value: SourcePost): void => {
    store.addBatch({ id: `x:${value.id}`, platform: 'x', rootId: value.id, rootCreatedAt: instant, cutoffAt: instant, settleAt: instant, state: 'sealed', reason: 'thread_closed' });
    store.addPost(value, 'ready', 'thread_closed', instant, `x:${value.id}`);
  };
  store.setMentionMapping('alice', { bluesky: 'alice.bsky.social', telegram: 'alice_tg' });
  seal(post({}));

  const telegram = store.getJob(store.enqueue('publish', 'x:200', 'telegram', instant))!;
  const body = (await engine.parts(telegram)).map(part => part.text).join('');
  assert.match(body, /嗨@alice_tg 和 https:\/\/x\.com\/bob/);
  assert.doesNotMatch(body, /@bob\b/, 'an unmapped ID is never left as a bare @word');

  const bluesky = store.getJob(store.enqueue('publish', 'x:200', 'bluesky', instant))!;
  const parts = await engine.parts(bluesky);
  assert.deepEqual(parts[0]!.mentions, [{ handle: 'alice.bsky.social', start: 1, end: 19, did: 'did:web:mapped.example' }]);
  assert.match(parts.map(part => part.text).join(''), /嗨@alice\.bsky\.social 和 https:\/\/x\.com\/bob/);

  // A delivery keeps the plan it pinned: a later mapping edit cannot re-split text that may already be out.
  store.setMentionMapping('alice', { telegram: 'alice_new' });
  assert.match((await engine.parts(telegram)).map(part => part.text).join(''), /@alice_tg/);
  seal(post({ id: '201' }));
  assert.match((await engine.parts(store.getJob(store.enqueue('publish', 'x:201', 'telegram', instant))!)).map(part => part.text).join(''), /@alice_new/);
});

test('the Telegram mapping commands answer the owner and never apply rejected input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'wherry-map-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, APP_MODE: 'live', TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_POLL_COMMANDS: 'true' }));
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const replies: string[] = [];
  const queued = [
    { update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/map@WherryBot alice bluesky=Alice.Bsky.Social telegram=@alice_tg' } },
    { update_id: 2, message: { message_id: 2, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/map alice telegram=12345' } },
    { update_id: 3, message: { message_id: 3, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/maps' } },
    { update_id: 4, message: { message_id: 4, chat: { id: 2, type: 'private' }, from: { id: 2 }, text: '/unmap alice' } },
  ];
  runtime.telegram!.getUpdates = async () => queued.splice(0);
  runtime.telegram!.setMyCommands = async () => {};
  runtime.telegram!.sendPlain = async (text: string) => { replies.push(text); return { id: String(replies.length), messageIds: [replies.length], chatId: '1' }; };
  runtime.start();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(500); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(runtime.store.mentionMapping('alice'), { bluesky: 'alice.bsky.social', telegram: 'alice_tg' });
  assert.equal(replies.length, 3, 'a message from another chat is ignored entirely');
  assert.match(replies[0]!, /已儲存 ID 映射/);
  assert.match(replies[1]!, /未變更/);
  assert.match(replies[1]!, /Telegram ID/, 'the rejected value names the rule that refused it');
  assert.match(replies[2]!, /X @alice\n  bluesky：@alice\.bsky\.social/);
});

test('Bluesky publishes a mapped handle as a mention facet and refuses an unresolved one', async () => {
  const records: Array<Record<string, any>> = [];
  const transport = mock(async (url, options) => {
    if (url === 'https://author.example/.well-known/did.json') {
      return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] });
    }
    if (url.includes('/xrpc/com.atproto.identity.resolveHandle?')) {
      assert.equal(new URL(url).searchParams.get('handle'), 'alice.bsky.social');
      return json({ did: 'did:web:alice.example' });
    }
    if (url === `${pds}/xrpc/com.atproto.repo.createRecord`) {
      const body = JSON.parse(String(options?.body));
      records.push(body.record);
      return json({ uri: `at://${did}/app.bsky.feed.post/${body.rkey}`, cid: 'offline-cid', validationStatus: 'valid' });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const session = { did, handle: 'author.example', pds, accessJwt: 'offline', refreshJwt: 'offline-refresh' };
  const client = new BlueskyClient(loadConfig({ BLUESKY_IDENTIFIER: did, BLUESKY_APP_PASSWORD: 'offline' }).bluesky, transport, { session });
  const bodies = [{ text: 'hi @alice.bsky.social', mentions: [{ handle: 'alice.bsky.social', start: 3, end: 21 }] }];
  await resolveBlueskyMentions(bodies, 'https://public.api.bsky.app', transport);
  assert.equal(bodies[0]!.mentions[0]!.did, 'did:web:alice.example');
  await client.publish({ key: 'k', sourcePostId: '1', text: bodies[0]!.text, mentions: bodies[0]!.mentions, media: [] }, { idempotencyKey: 'k' });
  assert.deepEqual(records[0]!.facets, [{ index: { byteStart: 3, byteEnd: 21 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:web:alice.example' }] }]);
  const unresolved = bodies[0]!.mentions.map(({ handle, start, end }) => ({ handle, start, end }));
  await assert.rejects(client.publish({ key: 'k2', sourcePostId: '2', text: bodies[0]!.text, mentions: unresolved, media: [] }, { idempotencyKey: 'k2' }), /resolved DIDs/);
  assert.equal(records.length, 1, 'an unresolved mention never reaches the createRecord mutation');
});
