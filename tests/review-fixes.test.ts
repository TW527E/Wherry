import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createRuntime, createWeb } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Engine, Worker } from '../src/engine.js';
import { pruneMedia, rasterFormat } from '../src/media.js';
import { Store } from '../src/store.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import { handleCallback, TelegramNotifications } from '../src/telegram-notifications.js';
import type { SourcePost, Transport } from '../src/types.js';

const json = { 'content-type': 'application/json' };

async function web(t: { after(fn: () => Promise<void>): void }, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-fixes-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, DESTINATIONS: 'telegram', ...env }));
  const app = await createWeb(runtime);
  t.after(async () => { await app.close(); await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { runtime, app, directory };
}

test('without a token, a DNS-rebinding Host is refused even when its Origin matches, while a tunnelled loopback port works', async t => {
  const { app, runtime } = await web(t);
  const rebound = { host: 'evil.example:3000', origin: 'http://evil.example:3000' };
  const write = await app.inject({ method: 'POST', url: '/api/schedule', headers: { ...json, ...rebound }, payload: { text: 'injected' } });
  assert.equal(write.statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/status', headers: rebound })).statusCode, 403);
  assert.equal(runtime.store.scheduledBatches().length, 0, 'nothing was scheduled');
  for (const host of ['localhost:8080', '127.0.0.1:3000', '[::1]:3000']) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/status', headers: { host } })).statusCode, 200, host);
  }
  const crossOrigin = await app.inject({ method: 'POST', url: '/api/scan', headers: { ...json, host: 'localhost:3000', origin: 'http://evil.example' } });
  assert.equal(crossOrigin.statusCode, 403);
  const form = await app.inject({ method: 'POST', url: '/api/scan', headers: { host: 'localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1' });
  assert.equal(form.statusCode, 415);
});

test('with a token, every data route needs it, reads included; the page shell and health probe stay open', async t => {
  const token = 'x'.repeat(40);
  const { app } = await web(t, { WEB_TOKEN: token });
  for (const url of ['/api/status', '/api/posts']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong' } })).statusCode, 401, url);
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/status?x=1' })).statusCode, 401, 'a query string does not bypass the check');
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/scan', headers: json })).statusCode, 401);
});

test('a schedule due now is delivered immediately, can target a subset of destinations, and refuses unknown ones', async t => {
  const { app, runtime } = await web(t, { DESTINATIONS: 'telegram,bluesky,sharkey', BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'true' });
  const now = await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: 'right now', destinations: ['telegram'] } });
  assert.equal(now.statusCode, 200, now.body);
  await runtime.worker.run();
  const jobs = runtime.store.jobsForAggregate(now.json().id).filter(job => job.kind === 'publish');
  assert.deepEqual(jobs.map(job => [job.destination, job.state]), [['telegram', 'succeeded']]);
  for (const destinations of [['x'], [], 'telegram']) {
    const bad = await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: 'bad', destinations } });
    assert.equal(bad.statusCode, 400, JSON.stringify(destinations));
  }
  const status = (await app.inject('/api/status')).json();
  assert.equal(status.jobs[0].summary.text, 'right now', 'jobs carry a readable summary');
});

test('a scheduled post is listed until delivery and can be called off, which also withdraws its mirror candidate', async t => {
  const { app, runtime } = await web(t);
  const due = new Date(Date.now() + 3 * 3600_000).toISOString();
  const { id } = (await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: 'later today', dueAt: due } })).json();
  const listed = (await app.inject('/api/status')).json().scheduled;
  assert.deepEqual(listed.map((b: { id: string; text: string; dueAt: string; destinations: string[] }) => [b.id, b.text, b.dueAt, b.destinations]), [[id, 'later today', due, ['telegram']]]);
  assert.equal(runtime.store.mirrors(new Date().toISOString()).length, 1);
  const cancel = await app.inject({ method: 'POST', url: '/api/action', headers: json, payload: { action: 'skip', id } });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.deepEqual((await app.inject('/api/status')).json().scheduled, []);
  assert.ok(runtime.store.jobsForAggregate(id).every(job => job.state === 'cancelled'));
  assert.equal(runtime.store.mirrors(new Date().toISOString()).length, 0, 'a called-off post is no mirror evidence');
});

test('schedule images are sniffed, decoded and stored under media/uploads; SVG and junk never reach the decoder', async t => {
  const { app, runtime, directory } = await web(t);
  const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#3a8' } }).png().toBuffer();
  const due = new Date(Date.now() + 3600_000).toISOString();
  const ok = await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: '', dueAt: due, images: [{ data: png.toString('base64'), alt: 'a square' }] } });
  assert.equal(ok.statusCode, 200, ok.body);
  const [attachment] = runtime.store.batchPosts(ok.json().id)[0]!.post.attachments;
  assert.equal(attachment!.alt, 'a square');
  assert.ok(attachment!.path!.startsWith(join(directory, 'media', 'uploads')));
  assert.ok(existsSync(attachment!.path!));
  for (const data of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('junk')]) {
    const bad = await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: 'x', images: [{ data: data.toString('base64') }] } });
    assert.equal(bad.statusCode, 400);
  }
  const five = Array.from({ length: 5 }, () => ({ data: png.toString('base64') }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/schedule', headers: json, payload: { text: 'x', images: five } })).statusCode, 400);
  assert.equal(rasterFormat(png), 'png');
  assert.equal(rasterFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(rasterFormat(Buffer.from('<?xml version="1.0"?><svg/>')), undefined);
});

test('stuck jobs and held batches stay listed by state however much newer history piles up', () => {
  const store = new Store(':memory:');
  try {
    const now = new Date().toISOString();
    const failed = store.enqueue('publish', 'x:1', 'telegram', '2026-01-01T00:00:00.000Z');
    store.updateJob(failed, 'failed', 'boom');
    store.addBatch({ id: 'x:old', platform: 'x', rootId: 'old', rootCreatedAt: '2026-01-01T00:00:00.000Z', cutoffAt: now, settleAt: now, state: 'review', reason: 'possible_manual_mirror' });
    for (let i = 0; i < 150; i++) {
      store.enqueue('publish', `local:${i}`, 'telegram', now);
      store.addBatch({ id: `x:${i + 100}`, platform: 'x', rootId: String(i + 100), rootCreatedAt: now, cutoffAt: now, settleAt: now, state: 'sealed', reason: 'thread_closed' });
    }
    assert.ok(!store.jobs(100).some(job => job.id === failed));
    assert.ok(store.visibleJobs(100).some(job => job.id === failed));
    assert.ok(!store.batches(100).some(batch => batch.id === 'x:old'));
    assert.deepEqual(store.heldBatches().map(batch => batch.id), ['x:old']);
  } finally { store.close(); }
});

test('housekeeping prunes old events and finished bookkeeping, and outbound matches receipts without scanning them all', () => {
  const store = new Store(':memory:');
  try {
    store.db.prepare("INSERT INTO events(at,level,message) VALUES('2020-01-01T00:00:00.000Z','info','ancient')").run();
    for (let i = 0; i < 3; i++) store.event('info', `recent ${i}`);
    const done = store.enqueue('publish', 'x:1', 'telegram', '2026-01-01T00:00:00.000Z');
    store.updateJob(done, 'succeeded');
    const open = store.enqueue('publish', 'x:2', 'telegram', '2026-01-01T00:00:00.000Z');
    store.setSetting(`mention-plan:${done}`, []);
    store.setSetting(`mention-plan:${open}`, []);
    store.addBatch({ id: 'x:9', platform: 'x', rootId: '9', rootCreatedAt: '2026-01-01T00:00:00.000Z', cutoffAt: '2026-01-01T00:00:00.000Z', settleAt: '2026-01-01T00:00:00.000Z', state: 'ignored', reason: 'owner_override' });
    store.setSetting('seal_stuck:x:9', true);
    store.setSetting('review_choices:x:9', ['mirror:a']);
    const result = store.prune(new Date().toISOString(), 30, 2);
    assert.deepEqual(result, { events: 1, settings: 3 });
    assert.ok(!store.events().some(event => event.message === 'ancient'));
    assert.deepEqual(store.setting(`mention-plan:${open}`, 'gone'), [], 'an unfinished job keeps its pinned plan');
    store.beginStep(open, 'p', { text: 'copy text', sourcePostId: '2' }, '2026-01-01T00:00:00.000Z');
    assert.equal(store.outbound('telegram', 'nope', 'copy text'), 'possible');
    store.finishStep(open, 'p', { id: 'remote-7', uri: 'at://remote/7' });
    assert.equal(store.outbound('telegram', 'remote-7', 'other'), 'known');
    assert.equal(store.outbound('telegram', 'at://remote/7', 'other'), 'known');
    assert.equal(store.outbound('telegram', 'remote-8', 'other'), undefined);
    const sent = store.enqueue('publish', 'x:5', 'telegram', '2026-01-01T00:00:00.000Z');
    store.beginStep(sent, 'p', { text: 'five', sourcePostId: '5' }, '2026-01-01T00:00:00.000Z');
    store.finishStep(sent, 'p', { id: '9', messageIds: [9], chatId: '1', sentAt: '2026-01-01T06:00:00.000Z' } as never);
    assert.equal(store.telegramDeleteBy('5'), '2026-01-03T06:00:00.000Z', 'the bot can delete for 48 hours after sending');
    assert.equal(store.telegramDeleteBy('6'), undefined);
  } finally { store.close(); }
});

test('media pruning removes stale transcodes and unused uploads but keeps what an undelivered post still needs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-media-'));
  try {
    const uploads = join(directory, 'media', 'uploads');
    mkdirSync(uploads, { recursive: true });
    const old = Date.now() / 1000 - 10 * 86400;
    const files = { video: join(directory, 'media', 'a.mp4'), keep: join(uploads, 'k.png'), drop: join(uploads, 'd.png'), fresh: join(uploads, 'f.png'), other: join(directory, 'media', 'note.txt') };
    for (const path of Object.values(files)) writeFileSync(path, 'x');
    for (const path of [files.video, files.keep, files.drop, files.other]) utimesSync(path, old, old);
    assert.equal(await pruneMedia(directory, new Set([files.keep]), Date.now()), 2);
    assert.deepEqual(Object.entries(files).filter(([, path]) => existsSync(path)).map(([name]) => name), ['keep', 'fresh', 'other']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a manual-mirror review offers the candidates as buttons and one tap links the chosen one', async t => {
  const config = loadConfig({ APP_MODE: 'live', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1' });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const transport: Transport = { async request(url, options) {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(options?.body)) });
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: true, result: true })) };
  } };
  const engine = new Engine(store, config, transport);
  const telegram = new TelegramClient(config.telegram, transport);
  const context = { config, store, engine, telegram, worker: new Worker(engine, new Map()) };
  const notifications = new TelegramNotifications(context);
  const now = new Date().toISOString();
  store.addBatch({ id: 'x:100', platform: 'x', rootId: '100', rootCreatedAt: now, cutoffAt: now, settleAt: now, state: 'review', reason: 'possible_manual_mirror' });
  const post: SourcePost = { platform: 'x', id: '100', authorId: 'owner', createdAt: now, text: 'example body',
    relationKnown: true, replyToId: null, visibility: 'public', attachments: [], metadataComplete: true };
  store.addPost(post, 'mirror_review', 'possible_manual_mirror', now, 'x:100');
  store.armReviewNotice('x:100', '1', 10, now);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const older = store.addMirror({ ...post, platform: 'bluesky', id: 'at://did:plc:x/1', createdAt: hourAgo, text: 'unrelated note' }, now);
  const newer = store.addMirror({ ...post, platform: 'sharkey', id: 'note2', text: 'the copy I made' }, now);
  const close = store.addMirror({ ...post, platform: 'bluesky', id: 'at://did:plc:x/2', createdAt: hourAgo, text: 'example body!' }, now);
  const tap = (data: string) => handleCallback({ id: 'tap', data, from: { id: 1 }, message: { message_id: 10, chat: { id: 1, type: 'private' } } }, context);
  await tap('rev:m');
  await notifications.flush();
  const edits = () => calls.filter(call => call.method === 'editMessageText').map(call => call.body);
  const keys = (body: Record<string, any>) => body.reply_markup.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
  const buttons = keys(edits()[0]!);
  assert.deepEqual(buttons.map(button => button.callback_data), ['rev:c:0', 'rev:c:1', 'rev:c:2', 'rev:c:x', 'rev:c:back']);
  assert.match(buttons[0]!.text, /^Bluesky · 1 小時前「example body!」$/, 'closest wording first, with its age');
  assert.match(buttons[1]!.text, /^Sharkey · 剛剛/, 'then newest');
  assert.ok([older, newer, close].every(code => edits()[0]!.text.includes(code)), 'codes stay available for multi-candidate replies');
  // Backing out restores the original three choices; picking again offers the candidates again.
  await tap('rev:c:back');
  assert.equal(store.getReviewNotice(10, '1')!.state, 'offered');
  assert.deepEqual(keys(edits()[1]!).map(button => button.callback_data), ['rev:a', 'rev:s', 'rev:m']);
  await tap('rev:m');
  await notifications.flush();
  await tap('rev:c:1');
  assert.equal(store.getBatch('x:100')!.state, 'mirror');
  assert.equal(store.getReviewNotice(10, '1')!.state, 'mirrored');
  assert.equal(store.getMirror(newer, now)!.state, 'matched');
  assert.equal(store.getMirror(close, now)!.state, 'pending');
  await tap('rev:c:0');
  assert.equal(store.getMirror(close, now)!.state, 'pending', 'a settled notice ignores further taps');
});
