import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, createWeb } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Classification, SourcePost } from '../src/types.js';

const argonEnv = { ARGON_ENABLED: 'true', ARGON_URL: 'https://blog.example.com', ARGON_USERNAME: 'wherry', ARGON_APP_PASSWORD: 'abcd efgh ijkl mnop' };
const at = (minutes: number): string => new Date(Date.parse('2026-10-01T00:00:00.000Z') + minutes * 60_000).toISOString();

function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-backfill-'));
  const runtime = createRuntime(loadConfig({ DATA_DIR: directory, DESTINATIONS: 'telegram,argon', ...argonEnv }));
  t.after(async () => { await runtime.stop(); rmSync(directory, { recursive: true, force: true }); });
  const synced = (id: string, minutes: number, jobs: Record<string, 'succeeded' | 'failed'>, options: { state?: 'sealed' | 'review'; classification?: Classification } = {}): void => {
    const post: SourcePost = { platform: 'x', id, authorId: 'owner', createdAt: at(minutes), text: `post ${id}`, url: `https://x.com/owner/status/${id}`,
      relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, replyToId: null, replyToAuthorId: null };
    runtime.store.addBatch({ id: `x:${id}`, platform: 'x', rootId: id, rootCreatedAt: at(minutes), cutoffAt: at(minutes), settleAt: at(minutes), state: options.state ?? 'sealed', reason: 'thread_closed' });
    runtime.store.addPost(post, options.classification ?? 'ready', 'root', at(minutes), `x:${id}`);
    for (const [destination, state] of Object.entries(jobs)) {
      runtime.store.updateJob(runtime.store.enqueue('publish', `x:${id}`, destination as 'telegram', at(minutes)), state);
    }
  };
  return { runtime, synced };
}

test('backfill lists only synced X posts that a configured destination never had, newest first', async t => {
  const { runtime, synced } = setup(t);
  synced('1', 0, { telegram: 'succeeded' });
  synced('2', 10, { telegram: 'succeeded', argon: 'succeeded' });
  synced('3', 20, { telegram: 'failed' });
  synced('4', 30, { telegram: 'succeeded' }, { classification: 'deleted' });
  synced('5', 40, { telegram: 'succeeded' }, { state: 'review' });
  synced('6', 50, { telegram: 'succeeded', argon: 'failed' });
  synced('7', 60, { telegram: 'succeeded' });
  assert.deepEqual(runtime.engine.backfillCandidates().map(item => [item.id, item.missing]), [['x:7', ['argon']], ['x:1', ['argon']]],
    'never delivered anywhere, deleted on X, still under review, or already tried there: none of these is a backfill');
  assert.deepEqual(runtime.engine.backfillCandidates()[1], { id: 'x:1', rootCreatedAt: at(0), text: 'post 1', url: 'https://x.com/owner/status/1', count: 1, missing: ['argon'] });
});

test('backfill queues only the missing destinations, once, and records who asked', async t => {
  const { runtime, synced } = setup(t);
  synced('1', 0, { telegram: 'succeeded' });
  synced('2', 10, { telegram: 'succeeded', argon: 'succeeded' });
  assert.throws(() => runtime.engine.backfill('1', undefined), /X batch id/);
  assert.throws(() => runtime.engine.backfill('x:2', undefined), /never reached: \(none\)/, 'already on every destination');
  assert.throws(() => runtime.engine.backfill('x:9', undefined), /already synced/);
  assert.throws(() => runtime.engine.backfill('x:1', ['telegram']), /never reached: argon/, 'a destination that already has it is never sent twice');
  assert.throws(() => runtime.engine.backfill('x:1', []), /non-empty/);
  assert.deepEqual(runtime.store.jobsForAggregate('x:1').map(job => job.destination), ['telegram'], 'a refusal queues nothing');

  assert.deepEqual(runtime.engine.backfill('x:1', undefined, at(100)), ['argon']);
  const job = runtime.store.jobsForAggregate('x:1').find(job => job.destination === 'argon')!;
  assert.deepEqual([job.state, job.dueAt], ['pending', at(100)]);
  assert.match(runtime.store.events(5).map(event => event.message).join('\n'), /Owner backfilled x:1 to argon/);
  assert.deepEqual(runtime.engine.backfillCandidates(), [], 'once queued it leaves the list');
  assert.throws(() => runtime.engine.backfill('x:1', ['argon']), /never reached: \(none\)/);
});

test('the web console backfills picked posts and they go out oldest first', async t => {
  const { runtime, synced } = setup(t);
  const delivered: string[] = [];
  runtime.publishers.set('argon', { destination: 'argon', async publish(part) {
    delivered.push(part.sourcePostId);
    return { id: String(delivered.length), url: `https://blog.example.com/shuoshuo/${delivered.length}/` };
  } });
  synced('1', 0, { telegram: 'succeeded' });
  synced('2', 10, { telegram: 'succeeded' });
  const app = await createWeb(runtime);
  t.after(async () => { await app.close(); });
  const status = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.deepEqual(status.backfill.map((item: { id: string }) => item.id), ['x:2', 'x:1']);

  // The console sends the oldest first; the worker it kicks may still be busy when the second arrives.
  const send = (id: string, destinations?: string[]) => app.inject({ method: 'POST', url: '/api/backfill', headers: { 'content-type': 'application/json' }, payload: { id, destinations } });
  const refused = await send('x:1', ['telegram']);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /never reached: argon/);
  for (const id of ['x:1', 'x:2']) {
    const response = await send(id, ['argon']);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, destinations: ['argon'] });
  }
  await runtime.worker.run();
  assert.deepEqual(delivered, ['1', '2']);
  assert.ok(runtime.store.jobsForAggregate('x:2').every(job => job.state === 'succeeded'));
});
