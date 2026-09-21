import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine, Worker } from '../src/engine.js';
import type { Destination, PublishContext, PublishPart, Publisher, RemoteRef, SourcePost, SourceSnapshot, Transport } from '../src/types.js';

const base = Date.parse('2026-09-19T00:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(base + offsetSeconds * 1000).toISOString();

const transport: Transport = {
  async request() { throw new Error('network is not available in tests'); },
  async json<T>() { throw new Error('network is not available in tests') as T; },
};

function config(destinations: Destination[] = ['bluesky']) {
  return loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: destinations.join(','), BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'false', X_ENABLED: 'true', X_HANDLE: 'owner' });
}

function post(overrides: Partial<SourcePost> & { id: string; createdAt: string }): SourcePost {
  return { platform: 'x', authorId: 'owner', text: `post ${overrides.id}`, replyToId: null, replyToAuthorId: null, relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, ...overrides };
}
const snapshot = (posts: SourcePost[], fetchedAt: string, platform: 'x' | 'bluesky' = 'x', accountId = 'owner'): SourceSnapshot =>
  ({ platform, accountId, posts: posts.map(p => ({ ...p, platform })), fetchedAt, complete: true, warnings: [] });

/** A sealed three-part batch: root, a self reply, and the trailing X source link. */
function sealedBatch() {
  const cfg = config();
  const store = new Store(':memory:');
  const engine = new Engine(store, cfg, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));
  engine.ingest(snapshot([
    post({ id: '10', createdAt: at(10) }),
    post({ id: '11', createdAt: at(60), replyToId: '10', replyToAuthorId: 'owner' }),
  ], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  return { cfg, store, engine };
}

class RecordingPublisher implements Publisher {
  readonly calls: string[] = [];
  constructor(readonly destination: Destination, private readonly behaviour: (part: PublishPart, index: number) => void | never) {}
  async publish(part: PublishPart, context: PublishContext): Promise<RemoteRef> {
    const index = this.calls.length;
    this.calls.push(part.key);
    this.behaviour(part, index);
    return { id: `${this.destination}-${part.key}`, messageIds: [index + 1], url: `https://example.test/${part.key}` };
  }
}

test('a successful delivery records every step and cannot run twice', async () => {
  const { store, engine } = sealedBatch();
  const publisher = new RecordingPublisher('bluesky', () => undefined);
  const worker = new Worker(engine, new Map<Destination, Publisher>([['bluesky', publisher]]));
  assert.equal(await worker.run(at(950)), 1);
  const job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  assert.equal(job.state, 'succeeded');
  assert.equal(publisher.calls.length, 3, 'root, reply and footer are each delivered once');
  const parts = await engine.parts(job);
  for (const part of parts) {
    const step = store.getStep(job.id, part.key);
    assert.equal(step?.state, 'succeeded');
    assert.ok(step?.result, 'a delivered step records its remote reference');
  }
  assert.equal(await worker.run(at(960)), 0, 'a settled job is not dispatched again');
  assert.equal(publisher.calls.length, 3);
});

test('a retry after a partial failure never repeats an already delivered part', async () => {
  const { store, engine } = sealedBatch();
  let failOnce = true;
  const publisher = new RecordingPublisher('bluesky', (_part, index) => {
    if (index === 1 && failOnce) {
      failOnce = false;
      throw Object.assign(new Error('explicit rejection'), { status: 400, uncertain: false });
    }
  });
  const worker = new Worker(engine, new Map<Destination, Publisher>([['bluesky', publisher]]));
  await worker.run(at(950));
  let job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  assert.equal(job.state, 'failed');
  assert.equal(publisher.calls.length, 2, 'the failure happens on the second part');

  store.updateJob(job.id, 'pending', undefined, at(950));
  await worker.run(at(960));
  job = store.getJob(job.id)!;
  assert.equal(job.state, 'succeeded');
  assert.equal(publisher.calls.length, 4, 'only the two remaining parts are retried');
  assert.deepEqual(publisher.calls, ['bluesky-root', 'bluesky-reply', 'bluesky-reply', 'bluesky-footer'].map((_, i) => publisher.calls[i]));
  const keys = publisher.calls;
  assert.equal(new Set(keys).size, 3, 'each part key is published at most once per successful step');
});

test('an uncertain transport outcome is parked for reconciliation instead of being retried', async () => {
  const { store, engine } = sealedBatch();
  const publisher = new RecordingPublisher('bluesky', () => { throw Object.assign(new Error('socket closed after send'), { uncertain: true }); });
  const worker = new Worker(engine, new Map<Destination, Publisher>([['bluesky', publisher]]));
  await worker.run(at(950));
  const job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  assert.equal(job.state, 'unknown');
  assert.match(job.error || '', /remote outcome|socket closed|uncertain/i);
  assert.equal(await worker.run(at(1200)), 0, 'an uncertain job is not automatically retried');
  assert.equal(publisher.calls.length, 1);
  assert.throws(() => engine.action('retry', job.id), /unknown|reconcil/i);
});

test('a rate limit reschedules the job with the server supplied delay', async () => {
  const { store, engine } = sealedBatch();
  const publisher = new RecordingPublisher('bluesky', () => { throw Object.assign(new Error('slow down'), { status: 429, retryAfter: 900 }); });
  const worker = new Worker(engine, new Map<Destination, Publisher>([['bluesky', publisher]]));
  await worker.run(at(950));
  const job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  assert.equal(job.state, 'pending');
  assert.equal(job.dueAt, at(1850), 'the retry honours retry_after');
  assert.equal(await worker.run(at(1000)), 0, 'nothing runs before the retry is due');
  store.updateJob(job.id, 'failed', 'test cleanup');
});

test('an interrupted delivery is recovered as unknown rather than replayed', () => {
  const { store, engine } = sealedBatch();
  const job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  store.claimJob(job.id);
  store.recoverInterrupted();
  assert.equal(store.getJob(job.id)?.state, 'unknown');
  assert.match(store.getJob(job.id)?.error || '', /reconcile/i);
});

test('a destination without a publisher fails loudly instead of spinning', async () => {
  const { store, engine } = sealedBatch();
  const worker = new Worker(engine, new Map<Destination, Publisher>());
  await worker.run(at(950));
  const job = store.jobs(10).find(j => j.destination === 'bluesky')!;
  assert.equal(job.state, 'failed');
  assert.match(job.error || '', /No bluesky publisher/);
  assert.equal(await worker.run(at(960)), 0);
});

test('a reminder delivery carries the interactive buttons and arms a reminder record', async () => {
  const cfg = config(['telegram']);
  const store = new Store(':memory:');
  const engine = new Engine(store, cfg, transport);
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));
  // A native root post enqueues a manual X reminder job.
  const native = post({ id: 'at://did:plc:x/1', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'remind me' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  const reminderJob = store.jobs(100).find(j => j.kind === 'reminder')!;
  assert.ok(reminderJob, 'a native root produced a reminder job');

  let noticeButtons: string[] | undefined;
  const publisher: Publisher = {
    destination: 'telegram',
    async publish(part) {
      if (part.key === 'notice') noticeButtons = part.buttons?.map(b => b.data);
      return { id: `tg-${part.key}`, messageIds: [777], chatId: '999' };
    },
  };
  const worker = new Worker(engine, new Map<Destination, Publisher>([['telegram', publisher]]));
  await worker.run(at(20));
  assert.deepEqual(noticeButtons, ['rem:y', 'rem:n'], 'the notice offers 要發 / 不發');
  const reminder = store.getReminder(777, '999');
  assert.ok(reminder, 'the reminder message is recorded for later button/link handling');
  assert.equal(reminder?.state, 'offered');
  assert.equal(reminder?.mirrorId, `mirror:${reminderJob.aggregateId}`);
});

test('preview mode records intended deliveries without any remote call', async () => {
  const { store, engine } = sealedBatch();
  const seen: string[] = [];
  const preview: Publisher = {
    destination: 'bluesky',
    async publish(part, context) { seen.push(part.text); return { id: `preview:${context.idempotencyKey}` }; },
  };
  const worker = new Worker(engine, new Map<Destination, Publisher>([['bluesky', preview]]));
  assert.equal(await worker.run(at(950)), 1);
  assert.equal(store.jobs(10).find(j => j.destination === 'bluesky')?.state, 'succeeded');
  assert.equal(seen.length, 3);
  assert.ok(seen.at(-1)?.startsWith('🔗 X 原推文'));
});
