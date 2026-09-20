import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine, decideMirror, unsupportedReason } from '../src/engine.js';
import type { Destination, SourcePost, SourceSnapshot, Transport } from '../src/types.js';

const base = Date.parse('2026-09-19T00:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(base + offsetSeconds * 1000).toISOString();

/** Engine tests never perform I/O, so no credentials or real endpoints are configured here. */
function makeConfig(destinations: Destination[] = ['bluesky', 'sharkey', 'telegram']) {
  return loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: destinations.join(','),
    BLUESKY_ENABLED: destinations.includes('bluesky') ? 'true' : 'false',
    SHARKEY_ENABLED: destinations.includes('sharkey') ? 'true' : 'false',
    X_ENABLED: 'true',
    X_HANDLE: 'owner',
  });
}

const transport: Transport = {
  async request() { throw new Error('network is not available in tests'); },
  async json<T>() { throw new Error('network is not available in tests') as T; },
};

function post(overrides: Partial<SourcePost> & { id: string; createdAt: string }): SourcePost {
  return {
    platform: 'x', authorId: 'owner', text: `post ${overrides.id}`, replyToId: null, replyToAuthorId: null,
    relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true, ...overrides,
  };
}

function snapshot(posts: SourcePost[], fetchedAt: string, platform: 'x' | 'bluesky' | 'sharkey' = 'x', accountId = 'owner'): SourceSnapshot {
  return { platform, accountId, posts: posts.map(p => ({ ...p, platform })), fetchedAt, complete: true, warnings: [] };
}

function setup(destinations: Destination[] = ['bluesky', 'sharkey', 'telegram']) {
  const config = makeConfig(destinations);
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  // Establish the baseline so later snapshots are treated as new content.
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  for (const source of ['bluesky', 'sharkey'] as const) {
    if (destinations.includes(source)) engine.ingest(snapshot([], at(0), source, `${source}-account`), at(0));
  }
  return { config, store, engine };
}

test('engine.action rejects an unknown verb and a malformed id', () => {
  const { engine } = setup();
  assert.throws(() => engine.action('drop' as never, 'batch-1'), /action must be one of/);
  assert.throws(() => engine.action('skip', "'; DROP TABLE batches; --"), /plain identifier/);
  assert.throws(() => engine.action('skip', ''), /plain identifier/);
  // A well-formed but unknown id passes validation and fails later on lookup, not on injection.
  assert.throws(() => engine.action('skip', 'no-such-batch'), /Batch not found/);
});

test('the first snapshot becomes a baseline and never backfills', () => {
  const config = makeConfig();
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  const result = engine.ingest(snapshot([post({ id: '1', createdAt: at(-60) }), post({ id: '2', createdAt: at(-30) })], at(0)), at(0));
  assert.equal(result.baseline, true);
  assert.equal(store.getPost('x', '1')?.classification, 'baseline');
  assert.equal(store.jobs(100).length, 0);
});

test('an incomplete snapshot is rejected without advancing the checkpoint', () => {
  const { store, engine } = setup();
  const incomplete: SourceSnapshot = { ...snapshot([post({ id: '5', createdAt: at(10) })], at(20)), complete: false };
  assert.throws(() => engine.ingest(incomplete, at(20)), /Incomplete/);
  assert.equal(store.getPost('x', '5'), undefined);
});

test('a destination without its own source observation is refused at configuration time', () => {
  assert.throws(() => loadConfig({ DESTINATIONS: 'bluesky', BLUESKY_ENABLED: 'false' }), /BLUESKY_ENABLED must also be true/);
  assert.throws(() => loadConfig({ DESTINATIONS: 'sharkey', SHARKEY_ENABLED: 'false' }), /SHARKEY_ENABLED must also be true/);
  assert.doesNotThrow(() => loadConfig({ DESTINATIONS: 'telegram' }));
});

test('a root opens a collecting batch and nothing publishes before it settles', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([post({ id: '100', createdAt: at(10) })], at(20)), at(20));
  assert.equal(store.getPost('x', '100')?.classification, 'collecting');
  assert.equal(store.getBatch('x:100')?.state, 'open');
  assert.equal(engine.sealReady(at(30)), 0, 'cannot settle before the thread window closes');
  assert.equal(store.jobs(100).length, 0);
});

test('a linear self-thread inside the window joins the batch and seals after the cutoff', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([post({ id: '100', createdAt: at(10) })], at(20)), at(20));
  engine.ingest(snapshot([
    post({ id: '100', createdAt: at(10) }),
    post({ id: '101', createdAt: at(60), replyToId: '100', replyToAuthorId: 'owner' }),
    post({ id: '102', createdAt: at(120), replyToId: '101', replyToAuthorId: 'owner' }),
  ], at(620)), at(620));
  const members = store.batchPosts('x:100');
  assert.deepEqual(members.map(m => m.post.id), ['100', '101', '102']);
  assert.equal(store.getPost('x', '101')?.classification, 'collecting');
  // Sealing additionally requires a recent downstream observation, so refresh both mirrors first.
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  assert.equal(store.getBatch('x:100')?.state, 'sealed');
  const jobs = store.jobs(100);
  assert.deepEqual(jobs.map(j => j.destination).sort(), ['bluesky', 'sharkey', 'telegram']);
  assert.ok(!jobs.some(j => j.destination === ('x' as Destination)), 'X must never receive a publish job');
});

test('late self-replies, replies to others and orphan self-replies are excluded', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([post({ id: '200', createdAt: at(10) })], at(20)), at(20));
  engine.ingest(snapshot([
    post({ id: '200', createdAt: at(10) }),
    post({ id: '201', createdAt: at(700), replyToId: '200', replyToAuthorId: 'owner' }),
    post({ id: '202', createdAt: at(30), replyToId: '999', replyToAuthorId: 'someone-else' }),
    post({ id: '203', createdAt: at(40), replyToId: '555', replyToAuthorId: 'owner' }),
  ], at(800)), at(800));
  assert.equal(store.getPost('x', '201')?.reason, 'skipped_late_self_reply');
  assert.equal(store.getPost('x', '202')?.classification, 'ignored');
  assert.equal(store.getPost('x', '203')?.reason, 'self_reply_outside_new_batch');
  assert.deepEqual(store.batchPosts('x:200').map(m => m.post.id), ['200']);
});

test('a branching thread is held for review rather than flattened', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([post({ id: '300', createdAt: at(10) })], at(20)), at(20));
  engine.ingest(snapshot([
    post({ id: '300', createdAt: at(10) }),
    post({ id: '301', createdAt: at(60), replyToId: '300', replyToAuthorId: 'owner' }),
    post({ id: '302', createdAt: at(90), replyToId: '300', replyToAuthorId: 'owner' }),
  ], at(700)), at(700));
  assert.equal(store.getPost('x', '302')?.reason, 'branch_in_thread');
  assert.equal(store.getBatch('x:300')?.state, 'review');
  assert.equal(engine.sealReady(at(900)), 0);
});

test('thread closure waits for a fresh scan of every downstream platform', () => {
  const { engine, store } = setup();
  engine.ingest(snapshot([post({ id: '400', createdAt: at(10) })], at(650)), at(650));
  // bluesky/sharkey were last seen at t=0, which is before this batch cutoff.
  assert.equal(engine.sealReady(at(900)), 0);
  assert.equal(store.getBatch('x:400')?.state, 'open');
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
});

test('media-only and ambiguous mirrors are held, unique matches are marked as mirror', () => {
  const candidates = [{
    id: 'mirror:bluesky:at://1', state: 'pending', expired: false,
    post: post({ id: 'at://1', platform: 'bluesky', createdAt: at(0), text: 'hello world' }),
  }];
  const exact = decideMirror([post({ id: '500', createdAt: at(10), text: 'hello world' })], candidates);
  assert.equal(exact.state, 'match');

  const noEvidence = decideMirror([post({ id: '501', createdAt: at(10), text: 'totally unrelated' })], candidates);
  assert.equal(noEvidence.state, 'none');

  const partial = decideMirror([post({ id: '502', createdAt: at(10), text: 'hello world, edited a bit' })], candidates);
  assert.equal(partial.state, 'review');

  const mediaOnly = decideMirror([post({ id: '503', createdAt: at(10), text: '',
    attachments: [{ kind: 'image', alt: '', url: 'https://example.com/a.jpg' }] })], [{
    id: 'mirror:bluesky:at://2', state: 'pending', expired: false,
    post: post({ id: 'at://2', platform: 'bluesky', createdAt: at(0), text: '',
      attachments: [{ kind: 'image', alt: '', url: 'https://example.com/b.jpg' }] }),
  }]);
  assert.equal(mediaOnly.state, 'review', 'a media-only candidate with no hashes must not be auto-approved');
});

test('a batch matching a pending mirror is suppressed and never publishes', () => {
  const { store, engine } = setup();
  const native = post({ id: 'at://did:plc:x/1', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'cross post me' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  assert.equal(store.jobs(100).filter(j => j.kind === 'reminder').length, 1, 'a native root produces a manual X reminder');

  engine.ingest(snapshot([post({ id: '600', createdAt: at(10), text: 'cross post me' })], at(650)), at(650));
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  engine.sealReady(at(900));
  assert.equal(store.getBatch('x:600')?.state, 'mirror');
  assert.equal(store.getPost('x', '600')?.classification, 'manual_mirror');
  assert.equal(store.jobs(100).filter(j => j.kind === 'publish').length, 0);
});

test('unsupported phase-one content is held instead of being silently degraded', () => {
  const notes = [
    post({ id: '700', createdAt: at(10), attachments: [{ kind: 'video', alt: '' }] }),
    post({ id: '701', createdAt: at(10), poll: true }),
    post({ id: '702', createdAt: at(10), sensitive: true }),
    post({ id: '703', createdAt: at(10), visibility: 'restricted' }),
    post({ id: '704', createdAt: at(10), metadataComplete: false }),
  ];
  assert.equal(unsupportedReason(notes[0]!), 'only_static_images_in_phase_one');
  assert.equal(unsupportedReason(notes[1]!), 'poll_not_supported');
  assert.equal(unsupportedReason(notes[2]!), 'sensitive_content_requires_manual_review');
  assert.equal(unsupportedReason(notes[3]!), 'non_public_content');
  assert.equal(unsupportedReason(notes[4]!), 'incomplete_metadata');
  const { store, engine } = setup();
  engine.ingest(snapshot(notes, at(650)), at(650));
  // Keep the mirror watchers fresh so the hold is caused by the content, not by stale observers.
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  for (const note of notes) {
    const stored = store.getPost('x', note.id);
    // Non-public content is excluded as a privacy decision before the phase-one content check runs.
    if (note.visibility !== 'public') assert.equal(stored?.classification, 'ignored', `expected ${note.id} to be ignored`);
    else assert.equal(stored?.classification, 'unsupported', `expected ${note.id} to be held`);
  }
  assert.equal(engine.sealReady(at(900)), 0);
  assert.equal(store.getBatch('x:700')?.state, 'review');
  assert.equal(store.getBatch('x:703'), undefined, 'non-public content is dropped before a batch is opened');
  assert.equal(store.jobs(100).filter(j => j.kind === 'publish').length, 0);
});

test('Bluesky targets and footers are assembled with the X root link only', async () => {
  const { store, engine } = setup(['bluesky']);
  engine.ingest(snapshot([post({ id: '800', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  const job = store.jobs(100).find(j => j.destination === 'bluesky')!;
  const parts = await engine.parts(job);
  assert.equal(parts.at(-1)?.isFooter, true);
  assert.equal(parts.at(-1)?.text, '🔗 X 原推文：https://fixupx.com/owner/status/800');
});

test('a local schedule publishes downstream and reminds the owner but never writes to X', async () => {
  const { store, engine } = setup(['bluesky', 'telegram']);
  const id = engine.schedule({ text: 'scheduled body', dueAt: at(3600) }, at(0));
  const jobs = store.jobs(100);
  assert.deepEqual(jobs.filter(j => j.kind === 'publish').map(j => j.destination).sort(), ['bluesky', 'telegram']);
  assert.equal(jobs.filter(j => j.kind === 'reminder').length, 1);
  const publishJob = jobs.find(j => j.kind === 'publish' && j.destination === 'bluesky')!;
  const parts = await engine.parts(publishJob);
  assert.equal(parts.at(-1)?.isFooter, undefined, 'a scheduled post has no X status URL yet');
  assert.ok(parts.every(p => p.sourceUrl === undefined));
  assert.equal(id.startsWith('local:'), true);
});

test('the owner can hold or retry, and already delivered batches are protected', () => {
  const { store, engine } = setup(['bluesky']);
  engine.ingest(snapshot([post({ id: '900', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  engine.sealReady(at(900));
  assert.equal(store.getBatch('x:900')?.state, 'sealed');

  engine.ingest(snapshot([post({ id: '901', createdAt: at(10), poll: true })], at(650)), at(650));
  assert.equal(store.getBatch('x:901')?.state, 'review');
  engine.action('skip', 'x:901');
  assert.equal(store.getBatch('x:901')?.state, 'ignored');
  assert.throws(() => engine.action('approve', 'x:901'), /Unsupported|not supported|cannot/i);

  // Simulate a completed delivery, then confirm the batch can no longer be rewritten.
  const delivered = store.jobs(100).find(j => j.aggregateId === 'x:900' && j.destination === 'bluesky')!;
  assert.equal(store.claimJob(delivered.id), true);
  store.updateJob(delivered.id, 'succeeded');
  assert.throws(() => engine.action('skip', 'x:900'), /in-flight|delivered/i);
  assert.throws(() => engine.action('retry', delivered.id), /unknown|failed|review/i);
  store.updateJob(delivered.id, 'failed', 'explicit rejection');
  assert.doesNotThrow(() => engine.action('retry', delivered.id));
  assert.equal(store.getJob(delivered.id)?.state, 'pending');
});
