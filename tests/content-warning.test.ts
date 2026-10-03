import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppBskyFeedPost, DEFAULT_LABEL_SETTINGS, moderatePost } from '@atproto/api';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CONTENT_WARNING, contentWarning, isSensitiveContent, warningPrefix } from '../src/content-warning.js';
import { Engine, Worker } from '../src/engine.js';
import { Store } from '../src/store.js';
import { BlueskyClient } from '../src/platforms/bluesky.js';
import { SharkeyClient } from '../src/platforms/sharkey.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import { graphemes, htmlEscape } from '../src/text.js';
import type { HttpOptions, HttpResponse, PreparedImage, PreparedVideo, PublishPart, SourcePost, Transport } from '../src/types.js';

const instant = '2026-09-22T00:00:00.000Z';
const did = 'did:web:author.example';
const pds = 'https://pds.example';
const session = { did, handle: 'author.example', pds, accessJwt: 'offline-access', refreshJwt: 'offline-refresh' };
const json = (value: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(value)) });
const bodyText = (options?: HttpOptions): string => typeof options?.body === 'string' ? options.body : Buffer.from(options?.body ?? []).toString('utf8');
const requestBody = (options?: HttpOptions): Record<string, any> => JSON.parse(bodyText(options));
const field = (body: string, name: string): string | undefined => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1];
const image = (index = 1): PreparedImage => ({ bytes: new Uint8Array([index]), mimeType: 'image/jpeg', alt: `alt ${index}`, width: 4, height: 4, sha256: String(index) });
const part = (overrides: Partial<PublishPart> = {}): PublishPart => ({ key: 'part', sourcePostId: '123', text: 'example body', media: [], ...overrides });
const mock = (request: Transport['request']): Transport => ({ request });
const noNetwork = mock(async () => { throw new Error('Network is not available in this test'); });

function videoFixture(path: string): PreparedVideo {
  const bytes = Buffer.from('offline prepared video');
  writeFileSync(path, bytes);
  return { path, mimeType: 'video/mp4', alt: 'clip', width: 4, height: 4, durationSeconds: 1, size: bytes.length, sha256: 'video-hash' };
}

function blueskyFixture(label = 'graphic-media') {
  const records: Record<string, any>[] = [], serviceAuth: URLSearchParams[] = [];
  const transport = mock(async (url, options) => {
    if (url === 'https://author.example/.well-known/did.json') {
      return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] });
    }
    if (url === `${pds}/xrpc/com.atproto.repo.uploadBlob`) {
      return json({ blob: { $type: 'blob', ref: { $link: 'bafkrei-offline-image' }, mimeType: 'image/jpeg', size: (options!.body as Uint8Array).length } });
    }
    if (url.startsWith(`${pds}/xrpc/com.atproto.server.getServiceAuth?`)) { serviceAuth.push(new URL(url).searchParams); return json({ token: 'offline-service' }); }
    if (url.startsWith('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?')) {
      return json({ jobStatus: { blob: { $type: 'blob', ref: { $link: 'bafkrei-offline-video' }, mimeType: 'video/mp4', size: (options!.body as Uint8Array).length } } });
    }
    if (url === `${pds}/xrpc/com.atproto.repo.createRecord`) {
      const body = requestBody(options);
      records.push(body.record);
      return json({ uri: `at://${did}/app.bsky.feed.post/${body.rkey}`, cid: 'bafkrei-offline-record', validationStatus: 'valid' });
    }
    throw new Error(`Unexpected offline request: ${url}`);
  });
  const client = new BlueskyClient(loadConfig({ BLUESKY_SENSITIVE_LABEL: label }).bluesky, transport, { session, now: () => new Date(instant) });
  return { client, records, serviceAuth };
}

function engineFixture(t: { after(fn: () => void): void }, source: Partial<SourcePost>, destination: 'bluesky' | 'sharkey' | 'telegram') {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-warning-'));
  const config = loadConfig({ DATA_DIR: directory, DESTINATIONS: destination, BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'true' });
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = new Engine(store, config, noNetwork);
  const post: SourcePost = { platform: 'x', id: '123', authorId: 'owner', createdAt: instant, text: 'body',
    replyToId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, ...source };
  store.addBatch({ id: 'x:123', platform: 'x', rootId: '123', rootCreatedAt: instant, cutoffAt: instant, settleAt: instant, state: 'sealed', reason: 'owner_confirmed_new_content' });
  store.addPost(post, 'ready', 'owner_confirmed_new_content', instant, 'x:123');
  const id = store.enqueue('publish', 'x:123', destination, instant);
  return { engine, store, job: store.getJob(id)! };
}

test('warning mapping preserves source CW including empty folded CW and leaves ordinary content alone', () => {
  assert.equal(isSensitiveContent({}), false);
  assert.equal(contentWarning({}), undefined);
  assert.equal(warningPrefix({}), '');
  for (const input of [{ sensitive: true }, { cw: '' }, { cw: '  ' }]) {
    assert.equal(isSensitiveContent(input), true);
    assert.equal(contentWarning(input), DEFAULT_CONTENT_WARNING);
  }
  assert.equal(contentWarning({ cw: '醫療照片 <請留意>' }), '醫療照片 <請留意>');
  assert.equal(isSensitiveContent({ sensitiveLabels: ['nudity'] }), true);
});

test('Bluesky fallback labels have a documented default and reject ineffective self-labels', () => {
  assert.equal(loadConfig({}).bluesky.sensitiveLabel, 'graphic-media');
  for (const label of ['porn', 'sexual', 'nudity', 'graphic-media']) assert.equal(loadConfig({ BLUESKY_SENSITIVE_LABEL: label }).bluesky.sensitiveLabel, label);
  for (const label of ['', '!warn', '!hide', 'sensitive', 'typo']) assert.throws(() => loadConfig({ BLUESKY_SENSITIVE_LABEL: label }));
});

test('Bluesky sends selfLabels and a visible CW for text-only posts, while ordinary posts stay unchanged', async () => {
  const { client, records } = blueskyFixture();
  await client.publish(part({ sensitive: true }), { idempotencyKey: 'flagged' });
  await client.publish(part(), { idempotencyKey: 'plain' });
  assert.deepEqual(records[0]!.labels, { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'graphic-media' }] });
  assert.equal(records[0]!.text, `CW: ${DEFAULT_CONTENT_WARNING}\n\nexample body`);
  assert.equal(AppBskyFeedPost.validateRecord(records[0]).success, true);
  assert.equal(records[1]!.labels, undefined);
  assert.equal(records[1]!.text, 'example body');
});

test('Bluesky preserves known categories instead of replacing them with the fallback', async () => {
  const { client, records } = blueskyFixture('sexual');
  await client.publish(part({ sensitive: true }), { idempotencyKey: 'fallback' });
  await client.publish(part({ cw: '來源警告', sensitiveLabels: ['nudity', 'porn', 'nudity'] }), { idempotencyKey: 'known' });
  assert.deepEqual(records[0]!.labels.values, [{ val: 'sexual' }]);
  assert.deepEqual(records[1]!.labels.values, [{ val: 'nudity' }, { val: 'porn' }]);
  assert.equal(records[1]!.text, 'CW: 來源警告\n\nexample body');
});

test('Bluesky sensitive labels accompany both image and video embeds', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const video = videoFixture(join(directory, 'clip.mp4'));
  const { client, records, serviceAuth } = blueskyFixture();
  await client.publish(part({ sensitive: true, media: [image()] }), { idempotencyKey: 'image' });
  await client.publish(part({ sensitive: true, media: [video] }), { idempotencyKey: 'video' });
  assert.equal(records[0]!.embed.$type, 'app.bsky.embed.images');
  assert.equal(records[1]!.embed.$type, 'app.bsky.embed.video');
  // The video service stores the processed blob on the account's PDS with this token, so it must be
  // scoped to that PDS's uploadBlob (as the official app mints it), not to the video service itself.
  assert.deepEqual(serviceAuth.map(query => [query.get('aud'), query.get('lxm')]), [['did:web:pds.example', 'com.atproto.repo.uploadBlob']]);
  for (const record of records) assert.deepEqual(record.labels.values, [{ val: 'graphic-media' }]);
});

test('the installed Bluesky moderation rules honor the media label but not a self-issued !warn', async () => {
  const { client, records } = blueskyFixture();
  await client.publish(part({ sensitive: true }), { idempotencyKey: 'moderation' });
  assert.ok(records[0]);
  const record = records[0];
  const view = (value: string) => ({ uri: `at://${did}/app.bsky.feed.post/3mabcde234567`, cid: 'offline-cid', indexedAt: instant,
    author: { did, handle: 'author.example' }, record, labels: [{ src: did, uri: `at://${did}/app.bsky.feed.post/3mabcde234567`, val: value, cts: instant }] });
  const options = { userDid: 'did:web:viewer.example', prefs: { adultContentEnabled: true, labels: DEFAULT_LABEL_SETTINGS, labelers: [], mutedWords: [], hiddenPosts: [] } };
  const value = records[0]!.labels.values[0].val;
  assert.equal(moderatePost(view(value), options).ui('contentMedia').blur, true);
  assert.equal(moderatePost(view('!warn'), options).ui('contentMedia').blur, false);
});

test('Bluesky collection keeps label categories for downstream marking and still restricts hidden content', async () => {
  const transport = mock(async url => {
    if (url === 'https://author.example/.well-known/did.json') return json({ id: did, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] });
    if (url.includes('/xrpc/app.bsky.feed.getAuthorFeed?')) {
      const feed = [['porn', 'nudity', 'gore'], ['!hide']].map((values, index) => ({ post: {
        uri: `at://${did}/app.bsky.feed.post/post${index}`, cid: 'offline-cid', author: { did, handle: 'author.example', labels: [] }, labels: [],
        record: { $type: 'app.bsky.feed.post', text: 'source body', createdAt: instant, labels: { $type: 'com.atproto.label.defs#selfLabels', values: values.map(val => ({ val })) } },
      } }));
      return json({ feed });
    }
    throw new Error(`Unexpected offline request: ${url}`);
  });
  const client = new BlueskyClient(loadConfig({}).bluesky, transport, { session });
  const result = await client.collect();
  assert.equal(result.complete, true);
  assert.deepEqual(result.posts[0]!.sensitiveLabels, ['porn', 'nudity', 'graphic-media']);
  assert.equal(result.posts[0]!.sensitive, true);
  assert.equal(result.posts[1]!.visibility, 'restricted');
});

test('Sharkey sends default or source CW and marks every uploaded file, including video', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const video = videoFixture(join(directory, 'clip.mp4'));
  const notes: Record<string, any>[] = [], uploads: string[] = [];
  const transport = mock(async (url, options) => {
    const method = url.split('/api/')[1];
    if (method === 'users/show') return json({ id: 'user1', username: 'owner', host: null });
    if (method === 'meta') return json({ maxNoteTextLength: 3000, maxCwLength: 500, maxFileCommentLength: 2000 });
    if (method === 'drive/files/create') {
      const body = bodyText(options); uploads.push(body);
      return json({ id: `file${uploads.length}`, comment: field(body, 'comment'), isSensitive: field(body, 'isSensitive') === 'true' });
    }
    if (method === 'notes/create') { notes.push(requestBody(options)); return json({ createdNote: { id: `note${notes.length}` } }); }
    throw new Error(`Unexpected offline request: ${url}`);
  });
  const client = new SharkeyClient(loadConfig({ SHARKEY_TOKEN: 'offline', SHARKEY_USERNAME: 'owner', SHARKEY_DRIVE_FOLDER: '' }).sharkey, transport);
  await client.publish(part({ sensitive: true, media: [image(1), image(2)] }), { idempotencyKey: 'images' });
  await client.publish(part({ cw: '來源 CW', media: [video] }), { idempotencyKey: 'video' });
  await client.publish(part({ sensitive: true }), { idempotencyKey: 'text' });
  await client.publish(part(), { idempotencyKey: 'plain' });
  assert.deepEqual(notes.map(note => note.cw), [DEFAULT_CONTENT_WARNING, '來源 CW', DEFAULT_CONTENT_WARNING, undefined]);
  assert.deepEqual(notes[0]!.fileIds, ['file1', 'file2']);
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every(body => field(body, 'isSensitive') === 'true'));
});

test('Sharkey refuses an upload that loses the sensitive marker before creating the note', async () => {
  let noteCreated = false;
  const transport = mock(async url => {
    const method = url.split('/api/')[1];
    if (method === 'users/show') return json({ id: 'user1', username: 'owner', host: null });
    if (method === 'meta') return json({ maxNoteTextLength: 3000 });
    if (method === 'drive/files/create') return json({ id: 'file1', isSensitive: false });
    if (method === 'notes/create') noteCreated = true;
    throw new Error('Unexpected request');
  });
  const client = new SharkeyClient(loadConfig({ SHARKEY_TOKEN: 'offline', SHARKEY_USERNAME: 'owner', SHARKEY_DRIVE_FOLDER: '' }).sharkey, transport);
  await assert.rejects(client.publish(part({ sensitive: true, media: [image()] }), { idempotencyKey: 'lost-marker' }));
  assert.equal(noteCreated, false);
});

test('Telegram marks photos, every album item, videos and text without leaking a link preview', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const video = videoFixture(join(directory, 'clip.mp4'));
  const calls: Array<{ method: string; body: string }> = [];
  const transport = mock(async (url, options) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ method, body: bodyText(options) });
    return json({ ok: true, result: method === 'sendMediaGroup' ? [{ message_id: 1 }, { message_id: 2 }] : { message_id: 1 } });
  });
  const client = new TelegramClient(loadConfig({ TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_PUBLIC_CHAT_ID: '2' }).telegram, transport);
  const warning = { cw: '警告 <醫療> & 注意', text: '<hidden body> & https://example.com', sourceUrl: 'https://fixupx.com/owner/status/123' };
  await client.publish(part({ ...warning, media: [image()] }), { idempotencyKey: 'photo' });
  await client.publish(part({ ...warning, media: [image(1), image(2)] }), { idempotencyKey: 'album' });
  await client.publish(part({ ...warning, media: [video] }), { idempotencyKey: 'video' });
  await client.publish(part(warning), { idempotencyKey: 'text' });
  await client.publish(part(), { idempotencyKey: 'plain' });
  assert.deepEqual(calls.map(call => call.method), ['sendPhoto', 'sendMediaGroup', 'sendVideo', 'sendMessage', 'sendMessage']);
  assert.equal(field(calls[0]!.body, 'has_spoiler'), 'true');
  assert.equal(field(calls[2]!.body, 'has_spoiler'), 'true');
  const album = JSON.parse(field(calls[1]!.body, 'media')!);
  assert.ok(album.every((item: Record<string, any>) => item.has_spoiler === true));
  const text = JSON.parse(calls[3]!.body);
  for (const rendered of [field(calls[0]!.body, 'caption'), album[0].caption, field(calls[2]!.body, 'caption'), text.text]) {
    assert.match(rendered, /^CW: 警告 &lt;醫療&gt; &amp; 注意\n\n<tg-spoiler>&lt;hidden body&gt; &amp;/);
    assert.match(rendered, /<\/tg-spoiler>\n\n<a href=/);
  }
  assert.deepEqual(text.link_preview_options, { is_disabled: true });
  assert.equal(JSON.parse(calls[4]!.body).text, 'example body');
  assert.equal(JSON.parse(calls[4]!.body).link_preview_options, undefined);
});

test('mixed photos and videos go out as one Telegram album and one Sharkey note in order; a Bluesky post refuses the mix', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const video = videoFixture(join(directory, 'clip.mp4'));
  const mixed = [video, image(1), video];

  const calls: Array<{ method: string; body: string }> = [];
  const telegram = new TelegramClient(loadConfig({ TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_PUBLIC_CHAT_ID: '2' }).telegram, mock(async (url, options) => {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: bodyText(options) });
    return json({ ok: true, result: [{ message_id: 1 }, { message_id: 2 }, { message_id: 3 }] });
  }));
  const ref = await telegram.publish(part({ sensitive: true, media: mixed, sourceUrl: 'https://fixupx.com/owner/status/123' }), { idempotencyKey: 'mixed' });
  assert.deepEqual(calls.map(call => call.method), ['sendMediaGroup'], 'photos and videos share one album');
  const album = JSON.parse(field(calls[0]!.body, 'media')!);
  assert.deepEqual(album.map((item: Record<string, any>) => [item.type, item.media]), [['video', 'attach://video0'], ['photo', 'attach://photo1'], ['video', 'attach://video2']]);
  assert.ok(album.every((item: Record<string, any>) => item.has_spoiler === true), 'every item, video included, is hidden');
  assert.match(album[0].caption, /原文連結/);
  assert.match(calls[0]!.body, /filename="crosspost-0\.mp4"[\s\S]*filename="crosspost-1\.jpg"[\s\S]*filename="crosspost-2\.mp4"/);
  assert.deepEqual(ref.messageIds, [1, 2, 3]);

  const notes: Record<string, any>[] = [], uploads: string[] = [];
  const sharkey = new SharkeyClient(loadConfig({ SHARKEY_TOKEN: 'offline', SHARKEY_USERNAME: 'owner', SHARKEY_DRIVE_FOLDER: '' }).sharkey, mock(async (url, options) => {
    const method = url.split('/api/')[1];
    if (method === 'users/show') return json({ id: 'user1', username: 'owner', host: null });
    if (method === 'meta') return json({ maxNoteTextLength: 3000, maxCwLength: 500, maxFileCommentLength: 2000 });
    if (method === 'drive/files/create') {
      const body = bodyText(options); uploads.push(body);
      return json({ id: `file${uploads.length}`, comment: field(body, 'comment'), isSensitive: false });
    }
    if (method === 'notes/create') { notes.push(requestBody(options)); return json({ createdNote: { id: 'note1' } }); }
    throw new Error(`Unexpected offline request: ${url}`);
  }));
  await sharkey.publish(part({ media: mixed }), { idempotencyKey: 'mixed' });
  assert.deepEqual(uploads.map(body => body.match(/filename="[^"]*\.(\w+)"/)?.[1]), ['mp4', 'jpg', 'mp4']);
  assert.deepEqual(notes[0]!.fileIds, ['file1', 'file2', 'file3']);

  const { client: bluesky, records } = blueskyFixture();
  for (const media of [[image(1), video], [video, video]]) {
    await assert.rejects(bluesky.publish(part({ media }), { idempotencyKey: 'mixed' }), /either images or a single video/);
  }
  assert.equal(records.length, 0, 'the engine splits a mix before Bluesky ever sees one');
});

test('an X GIF is presented as a looping GIF where the platform has one, and as a video inside an album', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gif = { ...videoFixture(join(directory, 'gif.mp4')), animated: true };
  const calls: Array<{ method: string; body: string }> = [];
  const telegram = new TelegramClient(loadConfig({ TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_PUBLIC_CHAT_ID: '2' }).telegram, mock(async (url, options) => {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: bodyText(options) });
    return json({ ok: true, result: url.endsWith('sendMediaGroup') ? [{ message_id: 1 }, { message_id: 2 }] : { message_id: 1 } });
  }));
  await telegram.publish(part({ media: [gif] }), { idempotencyKey: 'gif' });
  await telegram.publish(part({ media: [image(1), gif] }), { idempotencyKey: 'album' });
  assert.deepEqual(calls.map(call => call.method), ['sendAnimation', 'sendMediaGroup']);
  assert.match(calls[0]!.body, /name="animation"; filename="crosspost\.mp4"/);
  assert.equal(field(calls[0]!.body, 'supports_streaming'), undefined);
  // Albums take no animations, so there the GIF goes as a video.
  assert.deepEqual(JSON.parse(field(calls[1]!.body, 'media')!).map((item: Record<string, any>) => item.type), ['photo', 'video']);

  const { client: bluesky, records } = blueskyFixture();
  await bluesky.publish(part({ media: [gif] }), { idempotencyKey: 'gif' });
  await bluesky.publish(part({ media: [videoFixture(join(directory, 'clip.mp4'))] }), { idempotencyKey: 'clip' });
  assert.deepEqual(records.map(record => record.embed.presentation), ['gif', undefined]);
});

test('Bluesky warning prefixes fit on every split part and preserve the complete source text', async t => {
  const sourceText = '中'.repeat(400);
  const { engine, job } = engineFixture(t, { text: sourceText, cw: '醫療照片，請斟酌觀看', sensitiveLabels: ['graphic-media'] }, 'bluesky');
  const parts = (await engine.parts(job)).filter(item => !item.isFooter);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(item => item.text).join(''), sourceText);
  const { client, records } = blueskyFixture();
  for (const item of parts) {
    assert.equal(item.cw, '醫療照片，請斟酌觀看');
    assert.deepEqual(item.sensitiveLabels, ['graphic-media']);
    const text = warningPrefix(item) + item.text;
    assert.ok(graphemes(text).length <= 300);
    assert.ok(Buffer.byteLength(text) <= 3000);
    await client.publish(item, { idempotencyKey: item.key });
  }
  assert.ok(records.every(record => record.text.startsWith('CW: 醫療照片，請斟酌觀看\n\n') && record.labels.values[0].val === 'graphic-media'));
});

test('Telegram HTML escaping, warning and spoiler overhead are reserved on every chunk', async t => {
  const sourceText = '<&'.repeat(1100);
  const { engine, job } = engineFixture(t, { text: sourceText, cw: '注意 <劇透>' }, 'telegram');
  const parts = await engine.parts(job);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(item => item.text).join(''), sourceText);
  const rendered: string[] = [];
  const client = new TelegramClient(loadConfig({ TELEGRAM_PUBLIC_CHAT_ID: '2' }).telegram, mock(async (_url, options) => {
    rendered.push(requestBody(options).text);
    return json({ ok: true, result: { message_id: rendered.length } });
  }));
  for (const item of parts) await client.publish(item, { idempotencyKey: item.key });
  assert.ok(rendered.every(text => text.length <= 4096 && text.startsWith(htmlEscape('CW: 注意 <劇透>\n\n')) && text.includes('<tg-spoiler>')));
});

test('an overlong CW fails before any publication instead of being dropped', async t => {
  const { engine, store, job } = engineFixture(t, { text: 'body', cw: 'warning'.repeat(100) }, 'bluesky');
  let sent = 0;
  const worker = new Worker(engine, new Map([['bluesky', { destination: 'bluesky' as const, async publish() { sent++; return { id: 'unexpected' }; } }]]));
  await worker.run(instant);
  assert.equal(sent, 0);
  assert.equal(store.getJob(job.id)?.state, 'review');
});
