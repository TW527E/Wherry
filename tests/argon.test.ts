import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { ArgonClient } from '../src/platforms/argon.js';
import type { HttpOptions, HttpResponse, PreparedImage, PublishPart, SourcePost, Transport } from '../src/types.js';

const base = Date.parse('2026-09-19T00:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(base + offsetSeconds * 1000).toISOString();
const argonEnv = { ARGON_ENABLED: 'true', ARGON_URL: 'https://blog.example.com', ARGON_USERNAME: 'wherry', ARGON_APP_PASSWORD: 'abcd efgh ijkl mnop' };
const offline: Transport = { async request() { throw new Error('network is not available in tests'); } };

function post(overrides: Partial<SourcePost> & { id: string; createdAt: string }): SourcePost {
  return {
    platform: 'x', authorId: 'owner', text: `post ${overrides.id}`, replyToId: null, replyToAuthorId: null,
    relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, ...overrides,
  };
}

interface Call { url: string; options: HttpOptions }
function wordpress(respond: (call: Call) => { status: number; body: unknown }): { transport: Transport; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, transport: {
    async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
      const call = { url, options }; calls.push(call);
      const { status, body } = respond(call);
      return { status, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) };
    },
  } };
}
const created = (call: Call): { status: number; body: unknown } => call.url.endsWith('/media')
  ? { status: 201, body: { id: 40 + call.url.length % 7, source_url: 'https://blog.example.com/wp-content/uploads/2026/09/a.jpg' } }
  : { status: 201, body: { id: 123, type: 'shuoshuo', link: 'https://blog.example.com/shuoshuo/123/' } };
const image = (alt: string): PreparedImage => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', alt, width: 4, height: 4, sha256: 'ab'.repeat(32) });
const text = (body: HttpOptions['body']): string => typeof body === 'string' ? body : Buffer.from(body ?? []).toString('utf8');

test('argon is only a destination when its publisher is enabled with an HTTPS site', () => {
  assert.throws(() => loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: 'argon' }), /ARGON_ENABLED/);
  assert.throws(() => loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: 'argon', ...argonEnv, ARGON_URL: 'http://blog.example.com' }), /ARGON_URL/);
  assert.throws(() => loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: 'argon', ...argonEnv, ARGON_URL: '' }), /ARGON_URL/);
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: 'argon', ...argonEnv, ARGON_URL: 'https://blog.example.com/' });
  assert.deepEqual(config.destinations, ['argon']);
  assert.equal(config.argon.baseUrl, 'https://blog.example.com');
  assert.match(config.argon.signature, /\{url\}/);
});

test('an X thread becomes one 說說 dated by its root, each post a section with its own media', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'crosspost-'));
  const media = join(dataDir, 'media'); mkdirSync(media);
  const photo = join(media, 'photo.jpg');
  writeFileSync(photo, await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c33' } }).jpeg().toBuffer());
  const config = loadConfig({ DATA_DIR: dataDir, DESTINATIONS: 'argon', ...argonEnv, X_ENABLED: 'true', X_HANDLE: 'owner' });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine(store, config, offline);
  store.addBatch({ id: 'x:700', platform: 'x', rootId: '700', rootCreatedAt: at(0), cutoffAt: at(600), settleAt: at(780), state: 'sealed', reason: 'thread_closed' });
  store.addPost(post({ id: '700', createdAt: at(0), text: 'hi @alice', mentions: [{ handle: 'alice', start: 3, end: 9 }] }), 'ready', 'root', at(0), 'x:700');
  store.addPost(post({ id: '701', createdAt: at(30), text: 'second', replyToId: '700', replyToAuthorId: 'owner', sensitive: true, cw: 'spoiler',
    attachments: [{ kind: 'image', alt: 'red', path: photo }] }), 'ready', 'initial_self_thread', at(30), 'x:700');

  const parts = await engine.parts(store.getJob(store.enqueue('publish', 'x:700', 'argon', at(800)))!, at(800));
  assert.equal(parts.length, 1, 'no footer and no split: the whole thread is one 說說');
  const [part] = parts as [PublishPart];
  assert.equal(part.key, `${createHash('sha256').update('700').digest('hex').slice(0, 16)}:0`, 'keyed like the root, so a later quote of it finds this 說說');
  assert.equal(part.sourcePostId, '700');
  assert.deepEqual(part.sections?.map(section => [section.text, section.media.length]), [['hi https://x.com/alice', 0], ['second', 1]]);
  assert.equal(part.media.length, 1);
  assert.equal(part.backdate, at(0));
  assert.equal(part.sourceUrl, 'https://fixupx.com/owner/status/700');
  assert.equal(part.cw, 'spoiler', 'one sensitive post folds the whole 說說');
});

test('the publisher uploads media, then creates a published 說說 in block markup', async () => {
  const { transport, calls } = wordpress(created);
  const client = new ArgonClient(loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), ...argonEnv }).argon, transport, () => new Date(at(900)));
  const ref = await client.publish({
    key: 'k:0', sourcePostId: '700', text: 'joined', media: [image('a "red" square')], sourceUrl: 'https://fixupx.com/owner/status/700', backdate: '2026-09-19T00:00:00.000Z',
    sections: [{ text: 'line one\nline two <b>\n\nsee https://example.com/a?b=1&c=2.', media: [] }, { text: 'second', media: [image('a "red" square')] }],
  }, { idempotencyKey: 'job:k:0' });
  assert.deepEqual(ref, { id: '123', url: 'https://blog.example.com/shuoshuo/123/' });
  assert.deepEqual(calls.map(call => [call.options.method, call.url]), [
    ['POST', 'https://blog.example.com/wp-json/wp/v2/media'],
    ['POST', 'https://blog.example.com/wp-json/wp/v2/shuoshuo'],
  ]);
  const auth = `Basic ${Buffer.from('wherry:abcd efgh ijkl mnop').toString('base64')}`;
  assert.ok(calls.every(call => call.options.headers?.authorization === auth));
  assert.match(text(calls[0]!.options.body), /name="alt_text"\r\n\r\na "red" square\r\n/);
  assert.match(text(calls[0]!.options.body), /filename="wherry-abababababababab-0\.jpg"/);

  const payload = JSON.parse(text(calls[1]!.options.body)) as { status: string; title: string; content: string; date_gmt: string };
  assert.equal(payload.status, 'publish');
  assert.equal(payload.title, '');
  assert.equal(payload.date_gmt, '2026-09-19T00:00:00');
  assert.ok(payload.content.includes('<p>line one<br>line two &lt;b&gt;</p>'), 'text is escaped and keeps its line breaks');
  assert.ok(payload.content.includes('<p>see <a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>.</p>'), 'URLs link, trailing punctuation stays text');
  assert.ok(payload.content.indexOf('<p>second</p>') < payload.content.indexOf('<img'), 'media follow their own section');
  assert.match(payload.content, /<!-- wp:image \{"id":\d+,"sizeSlug":"full","linkDestination":"none"\} -->/);
  assert.ok(payload.content.includes('alt="a &quot;red&quot; square"'));
  assert.ok(payload.content.endsWith('<a href="https://x.com/owner/status/700" target="_blank" rel="noopener">原文連結</a></p><!-- /wp:paragraph -->'), 'the signature links the X original');
  assert.ok(!payload.content.includes('<details'));
});

test('a sensitive 說說 folds behind its CW, and a future time never schedules it', async () => {
  const { transport, calls } = wordpress(created);
  const client = new ArgonClient(loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), ...argonEnv, ARGON_SIGNATURE: '' }).argon, transport, () => new Date(at(0)));
  await client.publish({ key: 'k:0', sourcePostId: '1', text: 'boo', media: [], sensitive: true, cw: '<spoiler>', sourceUrl: 'https://fixupx.com/owner/status/1', backdate: at(60) }, { idempotencyKey: 'k' });
  const payload = JSON.parse(text(calls[0]!.options.body)) as { content: string; date_gmt?: string };
  assert.equal(payload.date_gmt, undefined);
  assert.equal(payload.content, '<!-- wp:details -->\n<details class="wp-block-details"><summary>CW: &lt;spoiler&gt;</summary><!-- wp:paragraph -->\n<p>boo</p>\n<!-- /wp:paragraph --></details>\n<!-- /wp:details -->');
});

test('a site without the shuoshuo REST route fails with the fix, not a bare 404', async () => {
  const { transport } = wordpress(() => ({ status: 404, body: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } } }));
  const client = new ArgonClient(loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), ...argonEnv }).argon, transport);
  await assert.rejects(client.publish({ key: 'k:0', sourcePostId: '1', text: 'hi', media: [] }, { idempotencyKey: 'k' }), /show_in_rest/);
  await assert.rejects(client.retract({ id: '5' }), /show_in_rest/, 'a missing route is not an already-deleted 說說');
});

test('deleting on X moves the 說說 to the trash, and one already gone counts as deleted', async () => {
  const replies = [
    { status: 200, body: { id: 5, type: 'shuoshuo', status: 'trash' } },
    { status: 410, body: { code: 'rest_already_trashed', message: 'The post has already been deleted.', data: { status: 410 } } },
    { status: 404, body: { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } } },
    { status: 403, body: { code: 'rest_cannot_delete', message: 'Sorry, you are not allowed to delete this post.', data: { status: 403 } } },
  ];
  const { transport, calls } = wordpress(() => replies.shift()!);
  const client = new ArgonClient(loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), ...argonEnv }).argon, transport);
  for (let i = 0; i < 3; i++) await client.retract({ id: '5', url: 'https://blog.example.com/shuoshuo/5/' });
  await assert.rejects(client.retract({ id: '5' }), /HTTP 403/);
  assert.ok(calls.every(call => call.options.method === 'DELETE' && call.url === 'https://blog.example.com/wp-json/wp/v2/shuoshuo/5'), 'no force=true: the trash keeps it restorable');
  await assert.rejects(client.retract({ id: '../5' }), /Not an Argon/);
});
