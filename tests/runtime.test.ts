import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, createWeb } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

test('runtime shutdown drains an owner-triggered worker before releasing the database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-stop-'));
  const config = loadConfig({ DATA_DIR: directory, DESTINATIONS: 'telegram' });
  const runtime = createRuntime(config);
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  runtime.publishers.set('telegram', { destination: 'telegram', async publish() {
    started.resolve();
    await release.promise;
    return { id: 'offline', messageIds: [1], chatId: '1' };
  } });
  const instant = new Date().toISOString();
  const batchId = runtime.engine.schedule({ text: 'offline body', dueAt: instant }, instant);
  const job = runtime.store.jobsForAggregate(batchId).find(job => job.kind === 'publish')!;
  const running = runtime.worker.run(instant);
  await started.promise;
  let stopped = false;
  const stopping = runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'shutdown must wait for the active publication receipt');
  release.resolve();
  await Promise.all([running, stopping]);
  const store = new Store(config.databasePath);
  try {
    assert.equal(store.getJob(job.id)!.state, 'succeeded');
    assert.ok(store.hasDeliveryEvidence(job.id));
    const unlock = store.acquireRuntimeLock();
    unlock();
  } finally { store.close(); }
});

test('command polling retains only live timer handles between polls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const clear = t.mock.method(globalThis, 'clearInterval');
  const directory = mkdtempSync(join(tmpdir(), 'wherry-timers-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, APP_MODE: 'live', TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_OWNER_ID: '1', TELEGRAM_POLL_COMMANDS: 'true' }));
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  let polls = 0;
  runtime.telegram!.getUpdates = async () => { polls++; return []; };
  runtime.telegram!.setMyCommands = async () => {};
  runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(500);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(polls, 6);
  await runtime.stop();
  assert.equal(clear.mock.callCount(), 3, 'only two intervals and the next pending poll require cleanup');
});

test('web UI: held batches say whether approve can publish, and a schedule without dueAt means now', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-web-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, DESTINATIONS: 'telegram' }));
  const app = await createWeb(runtime);
  t.after(async () => { await app.close(); await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const post = (id: string, extra: object) => ({ platform: 'x' as const, id, authorId: 'owner', createdAt: now, text: `post ${id}`, url: `https://x.com/owner/status/${id}`,
    relationKnown: true, visibility: 'public' as const, attachments: [], metadataComplete: true, replyToId: null, ...extra });
  for (const [id, reason, extra] of [['1', 'possible_manual_mirror', {}], ['2', 'poll_details_unavailable', { poll: true }]] as const) {
    runtime.store.addBatch({ id: `x:${id}`, platform: 'x', rootId: id, rootCreatedAt: now, cutoffAt: now, settleAt: now, state: 'review', reason });
    runtime.store.addPost(post(id, extra), 'mirror_review', reason, now, `x:${id}`);
  }
  const status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.deepEqual(Object.fromEntries(status.held.map((b: { id: string; approvable: boolean }) => [b.id, b.approvable])), { 'x:1': true, 'x:2': false });
  assert.equal(status.held.find((b: { id: string }) => b.id === 'x:1').text, 'post 1');
  const scheduled = await app.inject({ method: 'POST', url: '/api/schedule', headers: { 'content-type': 'application/json' }, payload: { text: 'right now' } });
  assert.equal(scheduled.statusCode, 200, scheduled.body);
});
