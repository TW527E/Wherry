import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRuntime, createWeb } from '../src/app.js';
import { Engine, Worker } from '../src/engine.js';
import { Store } from '../src/store.js';
import { TelegramClient, telegramMessageLinks } from '../src/platforms/telegram.js';
import { deletionButtons, handleCallback, TelegramNotifications } from '../src/telegram-notifications.js';
import type { Destination, RemoteRef, SourcePost, Transport } from '../src/types.js';

const base = Date.parse('2026-10-24T00:00:00.000Z');
const hour = 3600_000;
const at = (hours: number) => new Date(base + hours * hour).toISOString();
const ref: RemoteRef = { id: '123', chatId: '-1001234567890', messageIds: [123, 124] };

function receipt(store: Store, id = '100', destination: Destination = 'telegram', extra: Partial<RemoteRef> = {}) {
  const job = store.enqueue('publish', `x:${id}`, destination, at(0));
  store.beginStep(job, id, { sourcePostId: id, text: 'body' }, at(0));
  store.finishStep(job, id, { ...ref, ...extra });
  store.updateJob(job, 'succeeded');
  return job;
}

function failure(store: Store, id = '100') {
  const publish = receipt(store, id);
  const job = store.enqueue('retract', `x:${id}`, 'telegram', at(49));
  store.updateJob(job, 'failed', "Telegram deleteMessage: message can't be deleted");
  return { publish, job };
}

test('every Telegram copy gets a 47-hour source check using its delivery time, without the normal quota or age cutoff', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 7; i++) {
      const post: SourcePost = { platform: 'x', id: String(i + 1), authorId: 'owner', text: 'old source, delayed delivery',
        createdAt: at(-40 * 24), replyToId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true };
      store.addPost(post, 'ready', 'thread_closed', at(-40 * 24));
      receipt(store, post.id, 'telegram', { sentAt: at(1) });
      store.markChecked(`x:${post.id}`, at(47.99));
    }
    assert.equal(store.xPostsToRecheck(at(47.999)).length, 0, 'not yet 47 hours since delivery');
    assert.equal(store.xPostsToRecheck(at(48), 1).length, 7, 'all seven bypass the one-post normal quota despite a recent check');
    for (const post of store.xPostsToRecheck(at(48))) store.markChecked(post.key, at(48));
    assert.equal(store.xPostsToRecheck(at(48)).length, 0, 'a check at hour 47 settles this deadline');
    assert.equal(store.xPostsToRecheck(at(48.5)).length, 0, 'does not repeat the deadline check every scan');
    // A later split part has its own deadline even though the original part was already checked.
    const job = store.jobsForAggregate('x:1')[0]!;
    store.beginStep(job.id, 'later-part', { sourcePostId: '1', text: 'later part' }, at(1));
    store.finishStep(job.id, 'later-part', { ...ref, sentAt: at(2) });
    assert.deepEqual(store.xPostsToRecheck(at(49)).map(post => post.key), ['x:1']);
    store.retractStep(job.id, 'later-part');
    assert.equal(store.xPostsToRecheck(at(49)).length, 0, 'already retracted parts have no deadline');
    // Legacy receipts still work, using their durable step time.
    const legacy = store.jobsForAggregate('x:2')[0]!;
    store.finishStep(legacy.id, '2', ref);
    store.markChecked('x:2', at(46.99));
    assert.deepEqual(store.xPostsToRecheck(at(47)).map(post => post.key), ['x:2']);
  } finally { store.close(); }
});

test('Telegram message links cover albums and usernames without inventing links for private or basic chats', () => {
  assert.deepEqual(telegramMessageLinks(ref), ['https://t.me/c/1234567890/123', 'https://t.me/c/1234567890/124']);
  assert.deepEqual(telegramMessageLinks({ ...ref, chatId: '@Wherry_feed' }), ['https://t.me/Wherry_feed/123', 'https://t.me/Wherry_feed/124']);
  for (const chatId of ['1', '-12345', '@evil/../../', '-100']) assert.deepEqual(telegramMessageLinks({ ...ref, chatId }), []);
  assert.deepEqual(telegramMessageLinks({ ...ref, messageIds: [-1, 0, 1.5, 12] }), ['https://t.me/c/1234567890/12']);
});

test('the deadline check still requires a live X control before removing copies and prioritizes deletion delivery', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let healthy = false;
  const transport: Transport = { async request(url) {
    const id = new URL(url).searchParams.get('id');
    return healthy && id === '999' ? { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ id_str: id })) }
      : { status: 404, headers: {}, body: new Uint8Array() };
  } };
  const engine = new Engine(store, loadConfig({}), transport);
  const source: SourcePost = { platform: 'x', id: '100', authorId: 'owner', text: 'body', createdAt: at(0),
    replyToId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true };
  store.addPost(source, 'ready', 'thread_closed', at(0));
  receipt(store);
  store.markChecked('x:100', at(46.99));
  const snapshot = { platform: 'x' as const, posts: [{ ...source, id: '999' }], checkpoint: '999', fetchedAt: at(47), complete: true };
  assert.equal(await engine.retractDeleted(snapshot, at(47)), 0);
  assert.equal(store.getPost('x', '100')!.classification, 'ready');
  healthy = true;
  for (let i = 0; i < 21; i++) store.enqueue('publish', `local:${i}`, 'bluesky', at(0));
  assert.equal(await engine.retractDeleted(snapshot, at(47)), 1);
  assert.equal(store.dueJobs(at(47))[0]!.kind, 'retract');
  const removed: string[] = [];
  const worker = new Worker(engine, new Map([['telegram', { destination: 'telegram' as const,
    async publish() { throw new Error('Not expected'); }, async retract(value: RemoteRef) { removed.push(value.id); } }]]));
  await worker.run(at(47));
  assert.deepEqual(removed, ['123']);
  assert.equal(store.deliveredCopies('100', 'telegram').length, 0);
});

test('manual deletion closes only a failed Telegram retract and preserves other destinations and thread members', () => {
  const store = new Store(':memory:');
  const transport: Transport = { async request() { throw new Error('No network'); } };
  const engine = new Engine(store, loadConfig({}), transport);
  try {
    const { publish, job } = failure(store);
    receipt(store, '101');
    receipt(store, '100', 'bluesky');
    assert.throws(() => engine.action('deleted', publish), /Only failed Telegram/);
    const other = store.enqueue('retract', 'x:100', 'bluesky', at(49));
    store.updateJob(other, 'failed', 'permission denied');
    assert.throws(() => engine.action('deleted', other), /Only failed Telegram/);
    engine.action('deleted', job);
    assert.equal(store.getJob(job)!.state, 'succeeded');
    assert.equal(store.getJob(job)!.error, 'owner_manually_deleted');
    assert.equal(store.deliveredCopies('100', 'telegram').length, 0);
    assert.equal(store.deliveredCopies('100', 'bluesky').length, 1);
    assert.equal(store.deliveredCopies('101', 'telegram').length, 1);
    assert.deepEqual(store.telegramDeletionFailures(), []);
    assert.throws(() => engine.action('deleted', job), /Only failed Telegram/);
    const second = failure(store, '102');
    engine.action('cancel', second.job);
    assert.equal(store.deliveredCopies('102', 'telegram').length, 1, 'cancel does not claim the remote copy was deleted');
    const interrupted = failure(store, '103');
    store.updateJob(interrupted.job, 'unknown', 'Process stopped during deletion');
    engine.action('retry', interrupted.job);
    assert.equal(store.getJob(interrupted.job)!.state, 'pending', 'interrupted deletion is safe to retry without a resend confirmation');
    store.updateJob(interrupted.publish, 'unknown', 'Process stopped during delivery');
    assert.throws(() => engine.action('retry', interrupted.publish), /unknown deliveries require reconciliation/);
  } finally { store.close(); }
});

test('Telegram deletion notices contain working owner-only actions and message links after error redaction', async t => {
  const config = loadConfig({ APP_MODE: 'live', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'secret-token', TELEGRAM_OWNER_ID: '1' });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const transport: Transport = { async request(url, options) {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(options?.body)) });
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: true, result: true })) };
  } };
  const engine = new Engine(store, config, transport);
  const telegram = new TelegramClient(config.telegram, transport);
  const worker = new Worker(engine, new Map());
  const context = { config, store, engine, telegram, worker };
  const notifications = new TelegramNotifications(context);
  const { job } = failure(store);
  store.updateJob(job, 'failed', 'secret-token https://api.telegram.org/botsecret-token/deleteMessage');
  store.event('error', 'telegram: could not remove a copy of a post deleted on X: refused', job);
  await notifications.flush();
  const message = calls.find(call => call.method === 'sendMessage')!.body;
  assert.match(message.text, /刪除失敗/);
  assert.match(message.text, /https:\/\/t.me\/c\/1234567890\/123/);
  assert.match(message.text, /https:\/\/t.me\/c\/1234567890\/124/);
  assert.doesNotMatch(message.text, /secret-token|api.telegram.org/);
  assert.deepEqual(message.reply_markup.inline_keyboard.flat().map((button: { text: string }) => button.text), ['重試', '取消', '我已手動刪除']);
  const data = deletionButtons(store.getJob(job)!)[2]!.data;
  assert.ok(Buffer.byteLength(data) <= 64);
  const tap = (ownerId: number) => handleCallback({ id: 'tap', data, from: { id: ownerId }, message: { message_id: 50, chat: { id: 1, type: 'private' } } }, context);
  await tap(2);
  assert.equal(store.getJob(job)!.state, 'failed');
  await tap(1);
  assert.equal(store.getJob(job)!.state, 'succeeded');
  assert.equal(calls.at(-1)!.method, 'editMessageText');
  assert.match(calls.at(-1)!.body.text, /工作已完成/);
  const edits = calls.filter(call => call.method === 'editMessageText').length;
  await tap(1);
  assert.equal(calls.filter(call => call.method === 'editMessageText').length, edits, 'a stale button cannot change a settled job');
  assert.ok(!calls.some(call => call.method === 'deleteMessage'), 'confirmation records the owner action without deleting anything');
  for (const [id, button, state] of [['101', 1, 'cancelled'], ['102', 0, 'pending']] as const) {
    const failed = failure(store, id);
    store.setSetting('paused', true);
    await handleCallback({ id: 'tap', data: deletionButtons(store.getJob(failed.job)!)[button]!.data, from: { id: 1 },
      message: { message_id: 51, chat: { id: 1, type: 'private' } } }, context);
    await worker.run();
    assert.equal(store.getJob(failed.job)!.state, state);
    assert.equal(store.deliveredCopies(id, 'telegram').length, 1);
  }
});

test('a Telegram deadline is checked every minute through the embed endpoint only, never by an extra browser scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'wherry-deadline-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, APP_MODE: 'live', X_ENABLED: 'true', X_HANDLE: 'owner',
    TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_POLL_COMMANDS: 'false', POLL_SECONDS: '86400' }));
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  let scans = 0;
  runtime.collectors.splice(0, runtime.collectors.length, { platform: 'x', async collect() {
    scans++;
    return { platform: 'x', posts: [], checkpoint: '1', fetchedAt: new Date().toISOString(), complete: true };
  } });
  runtime.telegram!.setMyCommands = async () => {};
  const due = t.mock.method(runtime.store, 'telegramPostsToRecheck', () => [] as ReturnType<Store['telegramPostsToRecheck']>);
  const checks = t.mock.method(runtime.engine, 'checkTelegramDeadlines', async () => 0);
  runtime.start();
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.mock.callCount(), 0, 'nothing to check without a deadline');
  due.mock.mockImplementation(() => [{} as ReturnType<Store['telegramPostsToRecheck']>[number]]);
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks.mock.callCount(), 1);
  assert.equal(scans, 0, 'the deadline check never starts a browser scan');
});

test('a failed between-scan deadline check backs off instead of retrying every minute', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let requests = 0;
  let healthy = false;
  const transport: Transport = { async request(url) {
    requests++;
    const id = new URL(url).searchParams.get('id');
    if (!healthy) return { status: 503, headers: {}, body: new Uint8Array() };
    return id === '999' ? { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ id_str: id })) } : { status: 404, headers: {}, body: new Uint8Array() };
  } };
  const engine = new Engine(store, loadConfig({}), transport);
  const source: SourcePost = { platform: 'x', id: '100', authorId: 'owner', text: 'body', createdAt: at(0),
    replyToId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true };
  store.addPost(source, 'ready', 'thread_closed', at(0));
  receipt(store);
  store.markChecked('x:100', at(46.5));
  store.setSetting('x:deletion_oracle', '999');
  assert.equal(await engine.checkTelegramDeadlines(at(47)), 0);
  assert.equal(requests, 1, 'only the oracle was asked');
  assert.equal(await engine.checkTelegramDeadlines(at(47.05)), 0);
  assert.equal(requests, 1, 'within the back-off window nothing is requested');
  healthy = true;
  assert.equal(await engine.checkTelegramDeadlines(at(47.1)), 1, 'after the back-off the deleted source is found');
  assert.equal(store.getPost('x', '100')!.classification, 'deleted');
  assert.equal(store.jobsForAggregate('x:100').filter(job => job.kind === 'retract').length, 1);
});

test('web status keeps a deletion failure listed even beyond the job history limit and resolves it through the shared action', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-deletion-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory }));
  const app = await createWeb(runtime);
  t.after(async () => { await app.close(); await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const { job } = failure(runtime.store);
  for (let i = 0; i < 101; i++) runtime.store.enqueue('publish', `local:${i}`, 'telegram', at(50));
  const status = (await app.inject('/api/status')).json();
  assert.ok(status.jobs.some((entry: { id: string }) => entry.id === job), 'a stuck job is listed by state, not by recency');
  assert.equal(status.deletions[0].id, job);
  assert.equal(status.deletions[0].links.length, 2);
  const response = await app.inject({ method: 'POST', url: '/api/action', headers: { 'content-type': 'application/json' }, payload: { action: 'deleted', id: job } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((await app.inject('/api/status')).json().deletions, []);
});

test('Telegram /pending resurfaces a saved deletion failure with all three actions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-pending-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, APP_MODE: 'live', TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_POLL_COMMANDS: 'true' }));
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const { job } = failure(runtime.store);
  const sent: Array<Parameters<TelegramClient['sendPlain']>> = [];
  const delivered = Promise.withResolvers<void>();
  let polled = false;
  runtime.telegram!.getUpdates = async () => {
    if (polled) return [];
    polled = true;
    return [{ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/pending' } }];
  };
  runtime.telegram!.setMyCommands = async () => {};
  runtime.telegram!.sendPlain = async (...args) => {
    sent.push(args);
    if (args[2]?.length) delivered.resolve();
    return { id: '50', messageIds: [50], chatId: '1' };
  };
  runtime.start();
  await delivered.promise;
  assert.match(sent[0]![0], /1 筆 Telegram 刪除失敗/);
  assert.match(sent[1]![0], /t.me\/c\/1234567890\/124/);
  assert.deepEqual(sent[1]![2], deletionButtons(runtime.store.getJob(job)!));
});
