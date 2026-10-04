import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Engine, Worker } from '../src/engine.js';
import { Store } from '../src/store.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import { handleCallback, handleReviewReply, TelegramNotifications } from '../src/telegram-notifications.js';
import type { SourcePost, Transport } from '../src/types.js';

function fixture(t: { after(fn: () => void): void }) {
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
  const worker = new Worker(engine, new Map());
  const context = { config, store, engine, telegram, worker };
  const notifications = new TelegramNotifications(context);
  const now = new Date().toISOString();
  const addBatch = (id: string, messageId: number) => {
    store.addBatch({ id, platform: 'x', rootId: id.slice(2), rootCreatedAt: now, cutoffAt: now, settleAt: now, state: 'review', reason: 'possible_manual_mirror' });
    const post: SourcePost = { platform: 'x', id: id.slice(2), authorId: 'owner', createdAt: now, text: 'example body',
      relationKnown: true, replyToId: null, visibility: 'public', attachments: [], metadataComplete: true };
    store.addPost(post, 'mirror_review', 'possible_manual_mirror', now, id);
    store.armReviewNotice(id, '1', messageId, now);
    return post;
  };
  const callback = (data: string, messageId = 10, ownerId = 1) => handleCallback({ id: 'tap', data, from: { id: ownerId },
    message: { message_id: messageId, chat: { id: 1, type: 'private' } } }, context);
  return { ...context, notifications, calls, now, addBatch, callback };
}

test('review buttons emitted by the engine work and legacy buttons remain tied to their stored batch', async t => {
  const f = fixture(t);
  f.addBatch('x:100', 10);
  const jobId = f.store.enqueue('ops', 'x:100', 'telegram', f.now);
  const [notice] = await f.engine.parts(f.store.getJob(jobId)!);
  const approve = notice!.buttons!.find(button => button.data === 'rev:a')!;
  assert.ok(approve);
  await f.callback(approve.data, 10, 2);
  assert.equal(f.store.getBatch('x:100')!.state, 'review');
  await f.callback('rev:a:x:999');
  assert.equal(f.store.getBatch('x:100')!.state, 'review');
  await f.callback(approve.data);
  assert.equal(f.store.getBatch('x:100')!.state, 'sealed');
  assert.equal(f.store.getReviewNotice(10, '1')!.state, 'approved');
  await f.worker.stop();
  f.addBatch('x:101', 11);
  await f.callback('rev:s:x:101', 11);
  assert.equal(f.store.getBatch('x:101')!.state, 'ignored');
  assert.equal(f.store.getReviewNotice(11, '1')!.state, 'skipped');
});

test('review edits advance past twenty settled notices and ignore stale edit receipts', async t => {
  const f = fixture(t);
  for (let i = 0; i < 21; i++) {
    f.addBatch(`x:${100 + i}`, i + 1);
    f.store.setReviewNoticeState(`x:${100 + i}`, 'skipped');
  }
  await f.notifications.flush();
  assert.equal(f.calls.filter(call => call.method === 'editMessageText').length, 20);
  await f.notifications.flush();
  assert.equal(f.calls.filter(call => call.method === 'editMessageText').length, 21);
  await f.notifications.flush();
  assert.equal(f.calls.filter(call => call.method === 'editMessageText').length, 21);
  const stale = f.store.getReviewNotice(1, '1')!;
  f.store.setReviewNoticeState(stale.batchId, 'mirrored');
  f.store.reviewNoticeSynced(stale);
  f.store.deferReviewNoticeEdit(stale, '9999-01-01T00:00:00.000Z');
  assert.equal(f.store.reviewNoticesNeedingEdit(new Date().toISOString())[0]!.state, 'mirrored');
  await f.notifications.flush();
  assert.match(f.calls.at(-1)!.body.text, /已登記為手動鏡像/);
  assert.deepEqual(f.store.reviewNoticesNeedingEdit(new Date().toISOString()), []);
});

test('the manual-mirror prompt retains usable candidate codes after editing the original notice', async t => {
  const f = fixture(t);
  const post = f.addBatch('x:100', 10);
  const code = f.store.addMirror({ ...post, platform: 'sharkey', id: 'native' }, f.now);
  await f.callback('rev:m');
  await f.notifications.flush();
  assert.ok(f.calls.find(call => call.method === 'editMessageText')!.body.text.includes(code));
  assert.equal(await handleReviewReply({ message_id: 20, chat: { id: 1, type: 'private' }, from: { id: 1 },
    reply_to_message: { message_id: 10 }, text: `${code} https://social.example/notes/native` }, f), true);
  assert.equal(f.store.getBatch('x:100')!.state, 'mirror');
  await f.notifications.flush();
  assert.match(f.calls.at(-1)!.body.text, /已登記為手動鏡像/);
});

test('forwarded error events reach Telegram in the same zh-Hant as the Web UI', async t => {
  const { store, notifications, calls } = fixture(t);
  store.event('error', 'Native post held: incomplete_metadata', 'sharkey:note1');
  await notifications.flush();
  const text = String(calls.find(call => call.method === 'sendMessage')?.body.text);
  assert.match(text, /貼文暫停同步：貼文資料不完整/);
  assert.doesNotMatch(text, /Native post held/);
});

test('plain Telegram replies mark "/command <id>" as code so one tap copies the whole command', async t => {
  const { calls, telegram } = fixture(t);
  const text = '待你決定：0 批（/pending 查看）\n  /retry 9549-acde\n  /cancel 9549-acde\n  /approve x:1 · /skip x:1 · /mirror x:1\n請先 /session 或 /mirror <id> <X_URL>，見 https://x.com/a/status/1';
  await telegram.sendPlain(text, 'private');
  const { entities } = calls.at(-1)!.body;
  assert.deepEqual(entities.map((e: { offset: number; length: number }) => text.slice(e.offset, e.offset + e.length)),
    ['/retry 9549-acde', '/cancel 9549-acde', '/approve x:1', '/skip x:1', '/mirror x:1']);
  assert.ok(entities.every((e: { type: string }) => e.type === 'code'));
});
