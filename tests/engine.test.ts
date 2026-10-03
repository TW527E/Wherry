import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Engine, collectCycle, decideMirror, exceedsXLimit, holdIsApprovable, unsupportedReason } from '../src/engine.js';
import { readableEvent } from '../src/labels.js';
import type { Attachment, Collector, Destination, SourcePost, SourceSnapshot, Transport } from '../src/types.js';

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

test('collectCycle threads the last fetch watermark into the next collect', async () => {
  // A bare engine with no prior snapshot, so the first scan genuinely has no watermark.
  const engine = new Engine(new Store(':memory:'), makeConfig(['bluesky']), transport);
  const sinceSeen: (string | undefined)[] = [];
  let clock = at(10);
  const collector: Collector = {
    platform: 'bluesky',
    async collect(since) {
      sinceSeen.push(since);
      // Complete, empty snapshot so the engine advances the fresh watermark to `clock`.
      return { platform: 'bluesky', accountId: 'bluesky-account', posts: [], fetchedAt: clock, complete: true, warnings: [] };
    },
  };
  await collectCycle(engine, [collector], clock);
  clock = at(20);
  await collectCycle(engine, [collector], clock);
  // First cycle has no watermark; the second sees the first cycle's fetchedAt.
  assert.equal(sinceSeen[0], undefined);
  assert.equal(sinceSeen[1], at(10));
});

test('collectCycle keeps transient failures out of Telegram but pages once on a persistent outage', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, makeConfig(['sharkey']), transport);
  const failing: Collector = {
    platform: 'sharkey',
    async collect() { throw new Error('Incomplete sharkey snapshot; checkpoint unchanged (Collection failed (TELEGRAM_522))'); },
  };
  // Blips 1 and 2 are warnings (visible in /status, never forwarded to Telegram).
  await collectCycle(engine, [failing], at(10));
  await collectCycle(engine, [failing], at(20));
  assert.equal(store.events(20).filter(e => e.level === 'error').length, 0, 'transient blips do not page');
  assert.ok(store.events(20).some(e => e.level === 'warn' && /collection failed/.test(e.message)), 'but are logged as warnings');
  // The third consecutive failure crosses the persistence threshold and pages exactly once.
  await collectCycle(engine, [failing], at(30));
  await collectCycle(engine, [failing], at(40));
  assert.equal(store.events(50).filter(e => e.level === 'error').length, 1, 'a persistent outage pages once, not every cycle');
});

test('collectCycle treats a shutdown abort as a clean stop, not a failure', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, makeConfig(['sharkey']), transport);
  const aborted: Collector = {
    platform: 'x',
    async collect() { throw new Error('X collection aborted before start'); },
  };
  await collectCycle(engine, [aborted], at(10), AbortSignal.abort());
  assert.equal(store.events(20).length, 0, 'an abort logs nothing');
  assert.equal(store.setting('collect_failures:x', 0), 0, 'and does not count as a failure');
});


test('a repost by another author does not reject the whole snapshot', () => {
  const { engine } = setup(['bluesky']);
  const repost = post({ id: 'r1', createdAt: at(30), authorId: 'someone-else', platform: 'bluesky', repost: true });
  const own = post({ id: 'o1', createdAt: at(31), authorId: 'bluesky-account', platform: 'bluesky' });
  // The repost carries the original author's id; the guard must accept it and the own post.
  assert.doesNotThrow(() => engine.ingest(snapshot([repost, own], at(32), 'bluesky', 'bluesky-account'), at(32)));
  // A non-repost by another author is still rejected.
  const foreign = post({ id: 'f1', createdAt: at(33), authorId: 'someone-else', platform: 'bluesky' });
  assert.throws(() => engine.ingest(snapshot([foreign], at(34), 'bluesky', 'bluesky-account'), at(34)), /mismatched platform\/account/);
});

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

test('an incomplete snapshot with no watermark is rejected without advancing the checkpoint', () => {
  const { store, engine } = setup();
  const incomplete: SourceSnapshot = { ...snapshot([post({ id: '5', createdAt: at(10) })], at(20)), complete: false };
  assert.throws(() => engine.ingest(incomplete, at(20)), /Incomplete/);
  assert.equal(store.getPost('x', '5'), undefined);
});

test('a budget-limited snapshot carrying a watermark is ingested and advances the checkpoint', () => {
  // The doom-loop case: the scan ran out of scroll budget (complete:false) but parsed cleanly and
  // reports how far back it reached (watermark). It must ingest what it saw and move `fresh:x`
  // forward to the watermark — never throw, which would pin the checkpoint and re-scroll forever.
  const { store, engine } = setup();
  const priorFresh = store.setting<string | undefined>('fresh:x', undefined);
  const limited: SourceSnapshot = {
    ...snapshot([post({ id: '5', createdAt: at(10) })], at(60)),
    complete: false, watermark: at(15),
  };
  assert.doesNotThrow(() => engine.ingest(limited, at(60)));
  // The parsed post landed instead of being discarded.
  assert.ok(store.getPost('x', '5'));
  // The checkpoint advanced to the watermark (the oldest post reached), strictly forward of before.
  const advanced = store.setting<string | undefined>('fresh:x', undefined);
  assert.equal(advanced, at(15));
  assert.ok(priorFresh === undefined || advanced! > priorFresh);
});

test('a budget-limited watermark never drags the checkpoint backwards', () => {
  // Guard the "always forward" invariant: if a partial scan somehow reports a watermark older than
  // the current checkpoint, the checkpoint must stay put rather than rewind and re-publish old work.
  const { store, engine } = setup();
  store.setSetting('fresh:x', at(100));
  const limited: SourceSnapshot = {
    ...snapshot([post({ id: '9', createdAt: at(50) })], at(120)),
    complete: false, watermark: at(30),
  };
  assert.doesNotThrow(() => engine.ingest(limited, at(120)));
  assert.equal(store.setting<string | undefined>('fresh:x', undefined), at(100));
});

test('a destination without its own source observation is refused at configuration time', () => {
  assert.throws(() => loadConfig({ DESTINATIONS: 'bluesky', BLUESKY_ENABLED: 'false' }), /BLUESKY_ENABLED must also be true/);
  assert.throws(() => loadConfig({ DESTINATIONS: 'sharkey', SHARKEY_ENABLED: 'false' }), /SHARKEY_ENABLED must also be true/);
  assert.doesNotThrow(() => loadConfig({ DESTINATIONS: 'telegram' }));
});

test('an unsafe SHARKEY_UPLOAD_NAME template is rejected at configuration time', () => {
  const sharkey = { DESTINATIONS: 'sharkey', SHARKEY_ENABLED: 'true', SHARKEY_URL: 'https://sharkey.example', SHARKEY_USERNAME: 'owner' };
  // A template with a path separator or spaces cannot yield a safe drive filename.
  assert.throws(() => loadConfig({ ...sharkey, SHARKEY_UPLOAD_NAME: 'a/b-{index}.{ext}' }), /SHARKEY_UPLOAD_NAME/);
  assert.throws(() => loadConfig({ ...sharkey, SHARKEY_UPLOAD_NAME: 'my file {index}.{ext}' }), /SHARKEY_UPLOAD_NAME/);
  // The default template and a plain custom one both resolve to safe names.
  assert.equal(loadConfig({ ...sharkey }).sharkey.uploadName, 'Wherry_{timestamp}-{index}.{ext}');
  assert.doesNotThrow(() => loadConfig({ ...sharkey, SHARKEY_UPLOAD_NAME: 'photo-{index}.{ext}' }));
  assert.doesNotThrow(() => loadConfig({ ...sharkey, SHARKEY_UPLOAD_NAME: '{index}-photo-{index}.{ext}' }));
});

test('a root opens a collecting batch and nothing publishes before it settles', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([post({ id: '100', createdAt: at(10) })], at(20)), at(20));
  assert.equal(store.getPost('x', '100')?.classification, 'collecting');
  assert.equal(store.getBatch('x:100')?.state, 'open');
  assert.equal(engine.sealReady(at(30)), 0, 'cannot settle before the thread window closes');
  assert.equal(store.jobs(100).length, 0);
});

/** A root post on a downstream platform, as the Bluesky collector would report it. */
function downstream(id: string, text: string, createdAt: string): SourcePost {
  return {
    platform: 'bluesky', id: `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/${id}`,
    authorId: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', createdAt, text, replyToId: null, replyToAuthorId: null,
    relationKnown: true, visibility: 'public', attachments: [], metadataComplete: true,
  };
}

test('a post held without a batch is pushed to the owner instead of only sitting in the Web UI', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([
    // Neither of these can open a batch, so notifyHeldBatch has nothing to attach an ops notice to —
    // they used to exist only in the post list, waiting for the owner to happen to look.
    post({ id: '800', createdAt: at(10), relationKnown: false, replyToId: '999' }),
    post({ id: '801', createdAt: at(11), replyToId: '998', replyToAuthorId: null }),
    // Replying to somebody else is not a decision and must stay silent, or every such reply pages you.
    post({ id: '802', createdAt: at(12), replyToId: '997', replyToAuthorId: 'someone-else' }),
  ], at(20)), at(20));
  for (const id of ['800', '801']) {
    assert.equal(store.getPost('x', id)?.classification, 'mirror_review');
    assert.equal(store.getPost('x', id)?.batchId, undefined, 'there is no batch to hang a notice on');
  }
  assert.equal(store.getPost('x', '802')?.classification, 'ignored');
  // `error` is the only level the Telegram forwarder picks up, so it is what stops this being silent.
  const alerts = store.events(50).filter(event => event.level === 'error');
  assert.deepEqual(alerts.map(a => a.entityId).sort(), ['x:800', 'x:801']);
  assert.match(alerts.find(a => a.entityId === 'x:800')!.message, /reply_relationship_unknown/);
  assert.match(alerts.find(a => a.entityId === 'x:801')!.message, /parent_author_unknown/);
});

test('a thread continuation dropped by the window says so instead of vanishing', () => {
  const { store, engine } = setup();
  // THREAD_WINDOW_SECONDS defaults to 600 here; the reply lands well past it.
  engine.ingest(snapshot([post({ id: '700', createdAt: at(10) })], at(20)), at(20));
  engine.ingest(snapshot([
    post({ id: '700', createdAt: at(10) }),
    post({ id: '701', createdAt: at(900), replyToId: '700', replyToAuthorId: 'owner' }),
  ], at(1000)), at(1000));
  assert.equal(store.getPost('x', '701')?.reason, 'skipped_late_self_reply');
  // `ignored` raises no notice anywhere, so without this event the owner never learns the thread broke.
  const dropped = store.events(50).filter(event => event.level === 'warn' && /thread window closed/.test(event.message));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!.message, /701/);
  assert.match(dropped[0]!.message, /THREAD_WINDOW_SECONDS=600/, 'the message names the knob that caused it');
});

test('a distinctive CJK post matches outright while a short greeting still asks', () => {
  const sentence = '這部電影真的很好看，推薦大家去看';
  const distinctive = new Store(':memory:');
  distinctive.addMirror(downstream('a', sentence, at(-3600)), at(0));
  // 16 code units but 48 UTF-8 bytes. Counting code units called this "too short to be sure" and sent
  // every post like it to review, even though an exact match on a whole specific sentence is no accident.
  assert.equal(decideMirror([post({ id: '1', createdAt: at(0), text: sentence })], distinctive.mirrors(at(0))).state, 'match');

  const greeting = new Store(':memory:');
  greeting.addMirror(downstream('b', '早安', at(-3600)), at(0));
  // 6 bytes: two posts can say this on the same morning independently, so the owner is still asked
  // rather than having the X post silently dropped.
  assert.equal(decideMirror([post({ id: '2', createdAt: at(0), text: '早安' })], greeting.mirrors(at(0))).state, 'review');
});

test('an existing database drops the baseline history it had registered as pending mirrors', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'crosspost-prune-')), 'crosspost.sqlite');
  const old = downstream('old', '早安', at(-30 * 86400));
  const native = downstream('native', '剛剛在 Bluesky 發的', at(-3600));
  const seeded = new Store(file);
  seeded.addPost(old, 'baseline', 'first_snapshot_no_backfill', at(0));
  seeded.addPost(native, 'ready', 'manual_x_reminder', at(0));
  seeded.addMirror(old, at(0));    // what the old code did for the whole collected downstream history
  seeded.addMirror(native, at(0)); // a genuine pending mirror, created alongside a manual-X reminder
  assert.equal(seeded.mirrors(at(0)).length, 2);
  seeded.close();
  // Reopening runs the repair, so a database that is already live gets the fix too — not just a fresh one.
  const reopened = new Store(file);
  assert.deepEqual(reopened.mirrors(at(0)).map(m => m.post.text), ['剛剛在 Bluesky 發的']);
  assert.ok(reopened.events(10).some(event => /baseline/i.test(event.message)), 'the repair is reported, not silent');
  reopened.close();
  // Idempotent: a second start has nothing left to remove and says nothing.
  const again = new Store(file);
  assert.equal(again.mirrors(at(0)).length, 1);
  assert.equal(again.events(20).filter(event => /baseline/i.test(event.message)).length, 1);
  again.close();
});

test('a baseline sweep of downstream history does not become pending mirror candidates', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, makeConfig(), transport);
  // The first snapshot of a downstream account is the baseline, and it arrives with that account's whole
  // recent feed — which, since X is the source, is mostly older copies of the owner's own X posts.
  engine.ingest({ platform: 'bluesky', accountId: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', fetchedAt: at(0), complete: true, warnings: [],
    posts: [downstream('old', '早安', at(-30 * 86400)), downstream('fresh', '剛剛在 Bluesky 發的', at(-3600))] }, at(0));
  const candidates = store.mirrors(at(0));
  assert.deepEqual(candidates.map(c => c.post.text), ['剛剛在 Bluesky 發的'],
    'only a post still inside the pending window can be awaiting a manual X copy');
  // So a month-old downstream copy can no longer park a brand-new short X post in review. Seeding the
  // whole history was what made almost every short post need a manual decision.
  assert.equal(decideMirror([post({ id: '1', createdAt: at(0), text: '早安' })], candidates).state, 'none');
});

test('a downstream post already paired with an X post stops being mirror evidence', () => {
  const store = new Store(':memory:');
  const mirrorId = store.addMirror(downstream('native', '早安', at(-3600)), at(0));
  const shortPost = (id: string): SourcePost[] => [post({ id, createdAt: at(0), text: '早安' })];
  // While unclaimed it is genuine evidence: a short exact match is ambiguous, so the owner is asked.
  assert.equal(decideMirror(shortPost('1'), store.mirrors(at(0))).state, 'review');
  store.matchMirror(mirrorId, '12345');
  // Once claimed by X post 12345 it cannot also be post 2's mirror, so it must stop holding batches.
  assert.equal(decideMirror(shortPost('2'), store.mirrors(at(0))).state, 'none');
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

test('a self-reply whose parent was never collected is reported, not dropped in silence', () => {
  const { store, engine } = setup();
  engine.ingest(snapshot([
    // A reply to someone else is recorded but never batched, so replying to IT is a decision, not a gap.
    post({ id: '901', createdAt: at(10), replyToId: '800', replyToAuthorId: 'someone-else' }),
    post({ id: '902', createdAt: at(20), replyToId: '901', replyToAuthorId: 'owner' }),
    // 999 was never collected at all; this continuation used to vanish without a single word anywhere.
    post({ id: '903', createdAt: at(30), replyToId: '999', replyToAuthorId: 'owner' }),
  ], at(100)), at(100));
  assert.equal(store.getPost('x', '902')?.reason, 'self_reply_outside_new_batch');
  assert.equal(store.getPost('x', '903')?.reason, 'self_reply_outside_new_batch');
  const gaps = store.events(50).filter(event => event.level === 'warn' && /never collected/.test(event.message));
  assert.equal(gaps.length, 1, 'only the genuinely uncollected parent is reported');
  assert.match(gaps[0]!.message, /903/);
  assert.match(gaps[0]!.message, /999/);
});

test('untrusted media locations are rejected at the API boundary, not mid-publish', () => {
  const { engine } = setup();
  // zod's .url() accepts any scheme, so these used to be stored and only rejected once the worker was
  // already delivering — a failed job with a transport error instead of a clean refusal up front.
  for (const attachment of [
    { kind: 'image', url: 'javascript:alert(1)' },
    { kind: 'image', url: 'file:///etc/passwd' },
    { kind: 'image', path: '../../../etc/passwd' },
  ]) {
    assert.throws(() => engine.schedule({ text: 'hi', attachments: [attachment] as never, dueAt: at(3600) }, at(0)), JSON.stringify(attachment));
  }
  const id = engine.schedule({ text: 'hi', attachments: [{ kind: 'image', url: 'https://example.com/a.jpg', alt: '' }], dueAt: at(3600) }, at(0));
  assert.match(id, /^local:/);
});

test('a held X video names the reason that actually applies', () => {
  const video = (extra: Partial<Attachment>): SourcePost => post({ id: '1', createdAt: at(0), attachments: [{ kind: 'video', alt: '', ...extra }] });
  const mp4 = 'https://video.twimg.com/amplify_video/1/vid/a.mp4';
  assert.equal(unsupportedReason(video({ url: mp4 }), false), 'video_sync_disabled');
  // An X GIF is a looping MP4 and syncs like any video; publishers present it as a GIF.
  assert.equal(unsupportedReason(video({ url: mp4, animated: true }), true), undefined);
  assert.equal(unsupportedReason(video({ animated: true }), true), 'x_video_has_no_downloadable_source');
  // prepareVideo enforces the same ceiling, but only after the bytes are already downloaded.
  assert.equal(unsupportedReason(video({ url: mp4, durationSeconds: 141 }), true), 'video_exceeds_duration_limit');
  assert.equal(unsupportedReason(video({}), true), 'x_video_has_no_downloadable_source');
  assert.equal(unsupportedReason(video({ url: mp4, durationSeconds: 140 }), true), undefined);
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

test('a slow collect cycle does not age its own scans out of the seal freshness gate', () => {
  const { engine } = setup();
  engine.ingest(snapshot([post({ id: '410', createdAt: at(10) })], at(650)), at(650));
  // The cycle starts at 700; Sharkey fails this round, then X takes minutes, so seal runs at 1100.
  engine.ingest(snapshot([], at(701), 'bluesky', 'bluesky-account'), at(701));
  engine.ingest(snapshot([], at(702)), at(702));
  assert.equal(engine.sealReady(at(1100), at(700)), 0, 'a source that missed this cycle still blocks');
  engine.ingest(snapshot([], at(703), 'sharkey', 'sharkey-account'), at(703));
  assert.equal(engine.sealReady(at(1100)), 0, 'measured from the end of the cycle, every scan looks stale');
  assert.equal(engine.sealReady(at(1100), at(700)), 1);
});

test('a batch stuck long past its settle time pages the owner once', () => {
  const { engine, store } = setup();
  engine.ingest(snapshot([post({ id: '420', createdAt: at(10) })], at(650)), at(650));
  const stuck = () => store.events(50).filter(e => e.level === 'error' && e.message.includes('/approve x:420'));
  engine.sealReady(at(830 + 1700));
  assert.equal(stuck().length, 0, 'waiting on a scan is silent at first');
  engine.sealReady(at(830 + 1900));
  engine.sealReady(at(830 + 2500));
  assert.equal(stuck().length, 1);
  assert.match(stuck()[0]!.message, /no fresh enough x scan/);
});

test('media-only and ambiguous mirrors are held, unique distinctive matches are marked as mirror', () => {
  const candidates = [{
    id: 'mirror:bluesky:at://1', state: 'pending', expired: false,
    post: post({ id: 'at://1', platform: 'bluesky', createdAt: at(0), text: 'a distinctive sentence that is long enough' }),
  }];
  const exact = decideMirror([post({ id: '500', createdAt: at(10), text: 'a distinctive sentence that is long enough' })], candidates);
  assert.equal(exact.state, 'match');

  // Identical, but too short to be conclusive: a coincidental collision ("早安") must not silently
  // suppress a post the owner meant to sync, so it reaches the owner as a review notice instead.
  const shortCandidates = [{
    id: 'mirror:bluesky:at://3', state: 'pending', expired: false,
    post: post({ id: 'at://3', platform: 'bluesky', createdAt: at(0), text: '早安' }),
  }];
  assert.equal(decideMirror([post({ id: '504', createdAt: at(10), text: '早安' })], shortCandidates).state, 'review');

  const noEvidence = decideMirror([post({ id: '501', createdAt: at(10), text: 'totally unrelated' })], candidates);
  assert.equal(noEvidence.state, 'none');

  const partial = decideMirror([post({ id: '502', createdAt: at(10), text: 'a distinctive sentence that is long enough, edited a bit' })], candidates);
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
  // The text must be distinctive: a short identical string is deliberately routed to review instead
  // (see the decideMirror cases), so an auto-suppressed mirror is a long, unmistakable one.
  const body = 'cross post me, this is a long enough sentence';
  const native = post({ id: 'at://did:plc:x/1', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: body });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  assert.equal(store.jobs(100).filter(j => j.kind === 'reminder').length, 1, 'a native root produces a manual X reminder');

  engine.ingest(snapshot([post({ id: '600', createdAt: at(10), text: body })], at(650)), at(650));
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  engine.sealReady(at(900));
  assert.equal(store.getBatch('x:600')?.state, 'mirror');
  assert.equal(store.getPost('x', '600')?.classification, 'manual_mirror');
  assert.equal(store.jobs(100).filter(j => j.kind === 'publish').length, 0);
});

test('an X post manually registered as a mirror is ignored on the next scan', () => {
  const { store, engine } = setup();
  // The owner posted natively, then (via the reminder "要發" flow) registered their manual X copy.
  const native = post({ id: 'at://did:plc:x/9', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'echo guard' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  store.matchMirror('mirror:bluesky:at://did:plc:x/9', '12345');
  assert.equal(store.mirrorMatchesXId('12345'), true);

  // That exact X id later shows up in an X scan; it must be dropped, not turned into a batch.
  engine.ingest(snapshot([post({ id: '12345', createdAt: at(20), text: 'echo guard' })], at(650)), at(650));
  assert.equal(store.getBatch('x:12345'), undefined, 'no batch is opened for a registered manual mirror');
  assert.equal(store.getPost('x', '12345')?.classification, 'ignored');
  assert.equal(store.getPost('x', '12345')?.reason, 'manual_mirror_registered');
});

test('unsupported phase-one content is held instead of being silently degraded', () => {
  const notes = [
    post({ id: '700', createdAt: at(10), attachments: [{ kind: 'video', alt: '' }] }),
    post({ id: '701', createdAt: at(10), poll: true }),
    post({ id: '703', createdAt: at(10), visibility: 'restricted' }),
    post({ id: '704', createdAt: at(10), metadataComplete: false }),
  ];
  assert.equal(unsupportedReason(notes[0]!), 'video_sync_disabled');
  assert.equal(unsupportedReason(notes[1]!), 'poll_details_unavailable');
  assert.equal(unsupportedReason(notes[2]!), 'non_public_content');
  assert.equal(unsupportedReason(notes[3]!), 'incomplete_metadata');
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

test('video gating: disabled holds video, enabled needs a downloadable source for every video, mixing is fine', () => {
  const withVideo = (attachments: SourcePost['attachments']): SourcePost => post({ id: '900', createdAt: at(10), attachments });
  const mp4 = 'https://example.com/v.mp4', jpg = 'https://example.com/i.jpg';
  const hlsOnly = withVideo([{ kind: 'video', alt: '' }]);                         // X: no url/path (HLS/blob)
  const realVideo = withVideo([{ kind: 'video', alt: 'clip', url: mp4 }]);
  const mixed = withVideo([{ kind: 'video', alt: '', url: mp4 }, { kind: 'image', alt: '', url: jpg }, { kind: 'video', alt: '', url: mp4 }]);
  // Opt-out (default): any video is held with the disabled reason.
  assert.equal(unsupportedReason(hlsOnly, false), 'video_sync_disabled');
  assert.equal(unsupportedReason(realVideo, false), 'video_sync_disabled');
  assert.equal(unsupportedReason(mixed, false), 'video_sync_disabled');
  // Opt-in: an X-style HLS video (no fetchable source) is still held, with a source-specific reason.
  assert.equal(unsupportedReason(hlsOnly, true), 'x_video_has_no_downloadable_source');
  // Opt-in with real downloadable sources is supported, alone or mixed with images and other videos, as X allows.
  assert.equal(unsupportedReason(realVideo, true), undefined);
  assert.equal(unsupportedReason(mixed, true), undefined);
  // Every video in a mix is checked, not only the first, and the rest of the mix must still be publishable.
  assert.equal(unsupportedReason(withVideo([{ kind: 'video', alt: '', url: mp4 }, { kind: 'video', alt: '' }]), true), 'x_video_has_no_downloadable_source');
  assert.equal(unsupportedReason(withVideo([{ kind: 'image', alt: '', url: jpg }, { kind: 'video', alt: '', url: mp4, animated: true }]), true), undefined, 'a GIF mixes like any video');
  assert.equal(unsupportedReason(withVideo([{ kind: 'image', alt: '', url: jpg, animated: true }]), true), 'only_static_images_or_video', 'an animated image file is still not supported');
  assert.equal(unsupportedReason(withVideo([{ kind: 'image', alt: '', url: jpg }, { kind: 'video', alt: '', url: mp4, durationSeconds: 141 }]), true), 'video_exceeds_duration_limit');
  assert.equal(unsupportedReason(withVideo([{ kind: 'video', alt: '', url: mp4 }, { kind: 'unknown', alt: '' }]), true), 'only_static_images_or_video');
  assert.equal(unsupportedReason(withVideo(Array.from({ length: 5 }, () => ({ kind: 'video' as const, alt: '', url: mp4 }))), true), 'more_than_four_images');
});

test('a post mixing photos and videos keeps every item in order: Bluesky spreads them over replies, the others take them at once', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'crosspost-mixed-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const media = join(dataDir, 'media');
  mkdirSync(media);
  const photo = join(media, 'photo.jpg'), clip = join(media, 'clip.mp4'), tool = join(dataDir, 'media-tool');
  writeFileSync(photo, await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c33' } }).jpeg().toBuffer());
  writeFileSync(clip, 'source');
  // Stands in for ffprobe and ffmpeg so the test needs neither installed.
  writeFileSync(tool, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('-show_entries')) process.stdout.write(JSON.stringify({ streams: [{ width: 4, height: 4 }], format: { duration: '1' } }));
else require('node:fs').writeFileSync(args.at(-1), 'prepared');
`, { mode: 0o700 });
  const config = loadConfig({ DATA_DIR: dataDir, DESTINATIONS: 'bluesky,sharkey,telegram', BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'true',
    X_ENABLED: 'true', X_HANDLE: 'owner', VIDEO_ENABLED: 'true', FFMPEG_PATH: tool, FFPROBE_PATH: tool });
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine(store, config, transport);
  const video: Attachment = { kind: 'video', alt: 'clip', path: clip }, image: Attachment = { kind: 'image', alt: 'photo', path: photo };
  store.addBatch({ id: 'x:950', platform: 'x', rootId: '950', rootCreatedAt: at(0), cutoffAt: at(0), settleAt: at(0), state: 'sealed', reason: 'thread_closed' });
  store.addPost(post({ id: '950', createdAt: at(0), text: 'mixed', attachments: [video, image, image, video] }), 'ready', 'thread_closed', at(0), 'x:950');
  const kinds = (part: { media: Array<{ mimeType: string }> }): string[] => part.media.map(item => item.mimeType === 'video/mp4' ? 'video' : 'image');
  const partsFor = async (destination: Destination) => engine.parts(store.getJob(store.enqueue('publish', 'x:950', destination, at(0)))!, at(1));

  // Bluesky embeds images or one video, never both: each run of images shares a post, each video gets its own.
  const bluesky = await partsFor('bluesky');
  assert.deepEqual(bluesky.map(part => [part.text, kinds(part)]), [['mixed', ['video']], ['', ['image', 'image']], ['', ['video']], ['🔗 X 原推文：https://fixupx.com/owner/status/950', []]]);
  assert.ok(bluesky.slice(1, 3).every(part => !part.quote && part.sourcePostId === '950'), 'the media-only replies belong to the same tweet');
  // Sharkey and Telegram carry the whole mix on one note / one album, in source order.
  for (const destination of ['sharkey', 'telegram'] as const) {
    const parts = await partsFor(destination);
    assert.equal(parts.length, 1, destination);
    assert.deepEqual(kinds(parts[0]!), ['video', 'image', 'image', 'video'], destination);
  }
});

test('a mixed-media post collected before mixing was supported stays manual: its stored media came from the old collector', () => {
  const config = loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')), DESTINATIONS: 'bluesky', BLUESKY_ENABLED: 'true', X_ENABLED: 'true', X_HANDLE: 'owner', VIDEO_ENABLED: 'true' });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  // What the old collector stored: the page's photos (possibly a video poster) plus only the first video.
  const attachments: Attachment[] = [{ kind: 'image', alt: '', url: 'https://pbs.twimg.com/media/A.jpg' }, { kind: 'video', alt: '', url: 'https://video.twimg.com/a.mp4' }];
  const held = (id: string, reason: string, seenAt: string): void => {
    store.addBatch({ id: `x:${id}`, platform: 'x', rootId: id, rootCreatedAt: at(0), cutoffAt: at(0), settleAt: at(0), state: 'review', reason });
    store.addPost(post({ id, createdAt: at(0), attachments }), 'unsupported', reason, seenAt, `x:${id}`);
  };
  // Held as a mix, or sitting unchecked in a branched thread, before the upgrade...
  held('960', 'video_must_be_the_only_attachment', at(0));
  held('962', 'thread_is_not_linear', at(0));
  engine.ingest(snapshot([], at(5)), at(5));   // ...the first scan after it...
  held('961', 'possible_manual_mirror', at(10)); // ...and the same media collected since.
  for (const id of ['x:960', 'x:962']) {
    assert.equal(engine.holdReason(id), 'collected_before_mixed_media', 'the web UI, /pending and the notice offer no approve');
    assert.throws(() => engine.action('approve', id, at(20)), /collected before mixed media was supported/);
  }
  assert.equal(store.jobs(100).length, 0);
  assert.equal(engine.holdReason('x:961'), undefined);
  engine.action('approve', 'x:961', at(20));
  assert.equal(store.getBatch('x:961')?.state, 'sealed');
});

test('a plain video held because its poster was stored as a photo is repaired on startup and can be published', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'crosspost-poster-'));
  const path = join(dataDir, 'crosspost.sqlite');
  const video: Attachment = { kind: 'video', alt: '', url: 'https://video.twimg.com/amplify_video/1/vid/a.mp4' };
  const poster: Attachment = { kind: 'image', alt: 'Embedded video', url: 'https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg' };
  const photo: Attachment = { kind: 'image', alt: '', url: 'https://pbs.twimg.com/media/A?format=jpg&name=orig' };
  const before = new Store(path);
  for (const [id, attachments] of [['970', [poster, video]], ['971', [photo, poster, video]]] as const) {
    before.addBatch({ id: `x:${id}`, platform: 'x', rootId: id, rootCreatedAt: at(0), cutoffAt: at(0), settleAt: at(0), state: 'review', reason: 'video_must_be_the_only_attachment' });
    before.addPost(post({ id, createdAt: at(0), attachments: [...attachments] }), 'unsupported', 'video_must_be_the_only_attachment', at(0), `x:${id}`);
  }
  before.close();

  const store = new Store(path);   // the upgraded service starting up
  const engine = new Engine(store, loadConfig({ DATA_DIR: dataDir, DESTINATIONS: 'bluesky', BLUESKY_ENABLED: 'true', X_ENABLED: 'true', X_HANDLE: 'owner', VIDEO_ENABLED: 'true' }), transport);
  assert.deepEqual(store.getPost('x', '970')?.post.attachments, [video]);
  assert.equal(store.getBatch('x:970')?.reason, 'video_poster_repaired');
  assert.equal(store.getPost('x', '970')?.reason, 'video_poster_repaired');
  assert.equal(engine.holdReason('x:970'), undefined, 'the web UI now offers to publish it');
  engine.action('approve', 'x:970', at(20));
  assert.equal(store.getBatch('x:970')?.state, 'sealed');
  // A real photo beside the video still came from the old collector (maybe missing later videos), so it stays manual.
  assert.deepEqual(store.getPost('x', '971')?.post.attachments, [photo, video]);
  assert.equal(engine.holdReason('x:971'), 'collected_before_mixed_media');
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('a held batch whose review notice already reached Telegram can still be approved or skipped', () => {
  const { store, engine } = setup(['bluesky']);
  for (const id of ['980', '981']) {
    store.addBatch({ id: `x:${id}`, platform: 'x', rootId: id, rootCreatedAt: at(0), cutoffAt: at(0), settleAt: at(0), state: 'review', reason: 'possible_manual_mirror' });
    store.addPost(post({ id, createdAt: at(0) }), 'mirror_review', 'possible_manual_mirror', at(0), `x:${id}`);
    store.updateJob(store.enqueue('ops', `x:${id}`, 'telegram', at(0)), 'succeeded');   // the notice was delivered
  }
  engine.action('approve', 'x:980', at(10));
  assert.equal(store.getBatch('x:980')?.state, 'sealed');
  engine.action('skip', 'x:981', at(10));
  assert.equal(store.getBatch('x:981')?.state, 'ignored');
  assert.equal(store.jobsForAggregate('x:981').find(job => job.kind === 'ops')?.state, 'succeeded', 'the delivered notice keeps its record');
  // A real downstream delivery still blocks rewriting the batch.
  const publish = store.jobsForAggregate('x:980').find(job => job.kind === 'publish')!;
  store.updateJob(publish.id, 'succeeded');
  assert.throws(() => engine.action('skip', 'x:980', at(20)), /Already delivered/);
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

test('a post delivered long after it was written keeps its own time on Bluesky only', async () => {
  const { store, engine } = setup(['bluesky', 'sharkey']);
  engine.ingest(snapshot([post({ id: '800', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  engine.ingest(snapshot([], at(700), 'sharkey', 'sharkey-account'), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  const bluesky = store.jobs(100).find(j => j.destination === 'bluesky')!;
  const sharkey = store.jobs(100).find(j => j.destination === 'sharkey')!;
  assert.ok((await engine.parts(bluesky, at(900))).every(p => p.backdate === undefined), 'on-time delivery publishes now');
  const late = await engine.parts(bluesky, at(3 * 86400));
  assert.ok(late.every(p => p.backdate === at(10)), 'the post and its footer keep the tweet time');
  assert.ok((await engine.parts(sharkey, at(3 * 86400))).every(p => p.backdate === undefined), 'Sharkey cannot set a time');
});

test('Sharkey appends the MFM signature to each note body and adds no reply footer', async () => {
  const { store, engine } = setup(['sharkey']);
  engine.ingest(snapshot([post({ id: '800', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'sharkey', 'sharkey-account'), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  const job = store.jobs(100).find(j => j.destination === 'sharkey')!;
  const parts = await engine.parts(job);
  // No separate footer part — the attribution lives inline at the bottom of the note.
  assert.ok(parts.every(p => p.isFooter !== true), 'Sharkey uses an inline signature, not a reply footer');
  const last = parts.at(-1)!;
  assert.match(last.text, /^post 800\n\n<center><small>\$\[sparkle \$\[blur 這是從 X 來的推文，/);
  assert.ok(last.text.includes('[點擊此處](https://fixupx.com/owner/status/800)前往原文'), 'the {url} placeholder resolves to this note source link');
  assert.ok(last.text.includes('前往項目倉庫]]</small></center>'));
});

test('quoting your own synced post quotes its downstream copy; anything else links the tweet', async () => {
  const { store, engine } = setup(['bluesky', 'sharkey', 'telegram']);
  const refs = { bluesky: { id: 'at://did:plc:abc/app.bsky.feed.post/k', uri: 'at://did:plc:abc/app.bsky.feed.post/k', cid: 'bafy' },
    sharkey: { id: 'note1' }, telegram: { id: '7', messageIds: [7], chatId: '@chan' } };
  // Post 800 was delivered everywhere; record its first part's receipt per destination.
  const key800 = createHash('sha256').update('800').digest('hex').slice(0, 16);
  for (const [destination, ref] of Object.entries(refs)) {
    const id = store.enqueue('publish', 'x:800', destination as Destination, at(0));
    store.beginStep(id, `${key800}:0`, {}, at(0)); store.finishStep(id, `${key800}:0`, ref);
  }
  engine.ingest(snapshot([post({ id: '900', createdAt: at(10), text: 'look', quoteUrl: 'https://x.com/owner/status/800' }),
    post({ id: '901', createdAt: at(11), text: 'other', quoteUrl: 'https://x.com/someone/status/1' })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  engine.ingest(snapshot([], at(700), 'sharkey', 'sharkey-account'), at(700));
  engine.sealReady(at(900));
  for (const [destination, ref] of Object.entries(refs)) {
    const jobs = store.jobs(100).filter(j => j.destination === destination && j.kind === 'publish');
    const own = (await engine.parts(jobs.find(j => j.aggregateId === 'x:900')!))[0]!;
    assert.deepEqual(own.quote, ref, `${destination} quotes its own copy`);
    assert.ok(own.text.startsWith('look') && !own.text.includes('引用推文'), `${destination} carries no link when quoting natively`);
    const other = (await engine.parts(jobs.find(j => j.aggregateId === 'x:901')!))[0]!;
    assert.equal(other.quote, undefined);
    assert.ok(other.text.startsWith(destination === 'sharkey' ? 'other\n\n[引用推文](https://fixupx.com/someone/status/1)' : 'other\n\n引用推文：https://fixupx.com/someone/status/1'), destination);
  }
});

test('an empty SHARKEY_SIGNATURE disables the inline attribution', async () => {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: 'sharkey', SHARKEY_ENABLED: 'true', SHARKEY_SIGNATURE: '', X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'sharkey', 'sharkey-account'), at(0));
  engine.ingest(snapshot([post({ id: '800', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'sharkey', 'sharkey-account'), at(700));
  assert.equal(engine.sealReady(at(900)), 1);
  const job = store.jobs(100).find(j => j.destination === 'sharkey')!;
  const parts = await engine.parts(job);
  assert.ok(parts.every(p => p.isFooter !== true));
  assert.equal(parts.at(-1)?.text, 'post 800', 'no signature is appended when it is cleared');
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
  assert.equal(store.getPost('x', '901')?.classification, 'ignored', 'the posts follow the owner action, not stay collecting');
  assert.throws(() => engine.action('approve', 'x:901'), /Unsupported|not supported|cannot|Only open/i);

  // Simulate a completed delivery, then confirm the batch can no longer be rewritten.
  const delivered = store.jobs(100).find(j => j.aggregateId === 'x:900' && j.destination === 'bluesky')!;
  assert.equal(store.claimJob(delivered.id), true);
  store.updateJob(delivered.id, 'succeeded');
  assert.throws(() => engine.action('skip', 'x:900'), /in-flight|delivered/i);
  // Guards the Web UI's translation against a reworded log line silently falling back to raw English.
  for (const e of store.events(100)) assert.ok(readableEvent(e.message), `untranslated event: ${e.message}`);
  assert.throws(() => engine.action('retry', delivered.id), /unknown|failed|review/i);
    store.updateJob(delivered.id, 'failed', 'explicit rejection');
    assert.doesNotThrow(() => engine.action('retry', delivered.id));
    assert.equal(store.getJob(delivered.id)?.state, 'pending');
});

test('a suspected-mirror X batch is surfaced as one ops notice, and a reply confirms the manual mirror', async () => {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: 'bluesky,sharkey,telegram',
    BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'true',
    TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1',
    X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(0), source, `${source}-account`), at(0));

  // A downstream post leaves a pending mirror candidate; an X root with near-identical (not identical)
  // text is an ambiguous match — held for review, neither auto-published nor auto-suppressed.
  const native = post({ id: 'at://did:plc:x/9', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'hello world' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  engine.ingest(snapshot([post({ id: '950', createdAt: at(10), text: 'hello world, edited a bit' })], at(650)), at(650));
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));

  assert.equal(engine.sealReady(at(900)), 0, 'an ambiguous batch is not sealed for publication');
  assert.equal(store.getBatch('x:950')?.state, 'review');
  const ops = store.jobs(100).filter(j => j.kind === 'ops');
  assert.equal(ops.length, 1, 'a review batch enqueues exactly one ops notice');
  assert.equal(ops[0]!.destination, 'telegram');
  assert.equal(ops[0]!.aggregateId, 'x:950');

  // Re-sealing must not enqueue a second notice for the same batch.
  engine.sealReady(at(905));
  assert.equal(store.jobs(100).filter(j => j.kind === 'ops').length, 1, 'the notice is not duplicated across cycles');

  // The ops job renders exactly one interactive notice with the three decision buttons, in plain text.
  const parts = await engine.parts(ops[0]!);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0]!.buttons?.map(b => b.data), ['rev:a', 'rev:s', 'rev:m']);
  assert.ok(!/<code>|&lt;/.test(parts[0]!.text), 'notice text is plain; the Telegram path escapes it before sending');

  // The owner confirms the manual mirror by replying with the candidate code: an unknown code matches
  // nothing, the real code closes the batch as a mirror and links the X id so reverse sync is blocked.
  // `now` is passed explicitly. Letting it default to the wall clock mixes this synthetic 2026-09-19
  // timeline with real time, and the candidate silently ages out of getMirror's window exactly ten days
  // after the base date — a test that passes for ten days and then fails on its own.
  const code = engine.mirrorCandidates(at(905)).find(c => c.postId === 'at://did:plc:x/9')!.id;
  assert.equal(engine.confirmReviewMirror('x:950', 'see mirror:nope:missing', at(905)).matched, 0);
  assert.equal(engine.confirmReviewMirror('x:950', `mirrored here: ${code}`, at(905)).matched, 1);
  assert.equal(store.getBatch('x:950')?.state, 'mirror');
  assert.equal(store.getPost('x', '950')?.classification, 'manual_mirror');
  assert.equal(store.mirrorMatchesXId('950'), true, 'the X id is linked so reverse sync is suppressed');
});

test('the long-post hold uses X weighted length and only fires when publishing would split', () => {
  const longUrl = `https://example.com/${'b'.repeat(80)}`;
  // A short tweet whose t.co link the collector expanded into a long URL. X counts every link as 23
  // characters, so the post was never long; counting raw characters held it for no reason at all.
  const expanded = `${'a'.repeat(250)} ${longUrl}`;
  assert.ok(expanded.length > 280, 'the expanded form is longer than 280 raw characters');
  assert.equal(unsupportedReason(post({ id: '980', createdAt: at(10), text: expanded })), undefined,
    'the expanded link does not make a normal tweet look over-limit');

  // X weighs CJK double, so a 150-character post is past 280 for X — but it still publishes as ONE
  // downstream post (Bluesky allows 300 graphemes), so there is nothing for the owner to review.
  const cjk = '中'.repeat(150);
  assert.equal(exceedsXLimit(cjk), true, 'X counts this as beyond a normal post');
  assert.equal(unsupportedReason(post({ id: '981', createdAt: at(10), text: cjk })), undefined,
    'a body that still fits a single downstream post needs no review');

  // Both conditions together are what the hold is for: X counts it long AND publishing would split it.
  assert.equal(unsupportedReason(post({ id: '982', createdAt: at(10), text: 'x'.repeat(400) })), 'long_x_post_requires_manual_review');

  // Only the long-post hold can be released by approve; content holds have no publish path at all.
  assert.equal(holdIsApprovable('long_x_post_requires_manual_review'), true);
  for (const reason of ['poll_not_supported', 'video_sync_disabled', 'sensitive_content_requires_manual_review',
    'more_than_four_images', 'only_static_images_or_video', 'x_video_has_no_downloadable_source', 'incomplete_metadata']) {
    assert.equal(holdIsApprovable(reason), false, `${reason} cannot be published, so it must not be approvable`);
  }
});

test('a long X post is announced and can be released instead of stalling as a silent dead end', async () => {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: 'bluesky,telegram',
    BLUESKY_ENABLED: 'true', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1',
    X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));

  const body = 'x'.repeat(400);
  engine.ingest(snapshot([post({ id: '970', createdAt: at(10), text: body })], at(650)), at(650));
  assert.equal(store.getBatch('x:970')?.state, 'review', 'a long post is held rather than published unreviewed');

  // The hold must be announced: a batch parked in review is not in sealReady's open-batch walk, so
  // without the notice the owner would never hear about it and the content would silently never sync.
  const ops = store.jobs(100).filter(j => j.kind === 'ops');
  assert.equal(ops.length, 1, 'a held batch is announced once');
  assert.equal(ops[0]!.aggregateId, 'x:970');
  const notice = (await engine.parts(ops[0]!))[0]!;
  assert.deepEqual(notice.buttons?.map(b => b.data), ['rev:a', 'rev:s', 'rev:m'], 'a long post offers the release button');
  assert.match(notice.text, /不會自動同步/, 'the notice explains why it is held');

  // Approving must genuinely publish it — not park it in another failing state.
  engine.action('approve', 'x:970');
  assert.equal(store.getBatch('x:970')?.state, 'sealed');
  assert.equal(store.getPost('x', '970')?.classification, 'ready');
  const job = store.jobs(100).find(j => j.kind === 'publish' && j.aggregateId === 'x:970' && j.destination === 'bluesky')!;
  const parts = await engine.parts(job);
  const bodies = parts.filter(p => !p.isFooter);
  assert.ok(bodies.length >= 2, 'the long body is split into several downstream parts');
  assert.equal(bodies.map(p => p.text).join(''), body, 'splitting preserves the text exactly');
});

test('a hard content hold is announced but offers no publish button', async () => {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: 'bluesky,telegram',
    BLUESKY_ENABLED: 'true', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1',
    X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));

  engine.ingest(snapshot([post({ id: '990', createdAt: at(10), poll: true })], at(650)), at(650));
  assert.equal(store.getBatch('x:990')?.state, 'review');
  const ops = store.jobs(100).filter(j => j.kind === 'ops');
  assert.equal(ops.length, 1, 'a poll hold is announced too, instead of only showing up in /pending');
  const notice = (await engine.parts(ops[0]!))[0]!;
  assert.deepEqual(notice.buttons?.map(b => b.data), ['rev:s', 'rev:m'], 'no publish button for content that cannot be published');
  assert.match(notice.text, /無法自動同步/);
  // Even if the verb is called directly, a poll cannot be force-published.
  assert.throws(() => engine.action('approve', 'x:990'), /cannot be force-published/i);
});

test('a short coincidental text match asks the owner instead of silently swallowing the post', async () => {
  const config = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    DESTINATIONS: 'bluesky,telegram',
    BLUESKY_ENABLED: 'true', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1',
    X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, config, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));

  // A downstream post leaves a pending candidate. The owner then posts a brand-new tweet that happens
  // to read exactly the same: within the candidate's 72h window an identical short string used to be
  // treated as a manual mirror, closing the batch in silence and dropping the new post.
  const native = post({ id: 'at://did:plc:x/88', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: '早安' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  engine.ingest(snapshot([post({ id: '999', createdAt: at(10), text: '早安' })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));

  assert.equal(engine.sealReady(at(900)), 0);
  assert.equal(store.getBatch('x:999')?.state, 'review', 'a short coincidental match is not auto-suppressed');
  assert.equal(store.getPost('x', '999')?.reason, 'possible_manual_mirror');
  const ops = store.jobs(100).filter(j => j.kind === 'ops');
  assert.equal(ops.length, 1, 'the owner is asked rather than left in the dark');
  assert.match((await engine.parts(ops[0]!))[0]!.text, /需要你決定/);
});

test('a reminder is not queued when Telegram has no way to deliver it', () => {
  // Live mode with Telegram off: createRuntime wires no Telegram publisher, so the job could only fail.
  const liveOff = loadConfig({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'crosspost-')),
    APP_MODE: 'live', DESTINATIONS: 'bluesky', BLUESKY_ENABLED: 'true', X_ENABLED: 'true', X_HANDLE: 'owner',
  });
  const store = new Store(':memory:');
  const engine = new Engine(store, liveOff, transport);
  engine.ingest(snapshot([], at(-1000)), at(-1000));
  engine.ingest(snapshot([], at(0), 'bluesky', 'bluesky-account'), at(0));
  const native = post({ id: 'at://did:plc:x/77', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'native post body' });
  engine.ingest(snapshot([native], at(10), 'bluesky', 'bluesky-account'), at(10));
  assert.equal(store.getPost('bluesky', 'at://did:plc:x/77')?.classification, 'ready', 'the post is still recorded for a manual X post');
  assert.equal(store.jobs(100).filter(j => j.kind === 'reminder').length, 0, 'no undeliverable reminder is queued');
  assert.equal(store.events(20).filter(e => e.level === 'error').length, 0, 'and nothing is left to fail later');

  // A scheduled post behaves the same way: it publishes, but no reminder is queued.
  const id = engine.schedule({ text: 'scheduled body', dueAt: at(3600) }, at(0));
  assert.equal(store.jobs(100).filter(j => j.kind === 'reminder').length, 0);
  assert.deepEqual(store.jobs(100).filter(j => j.kind === 'publish' && j.aggregateId === id).map(j => j.destination), ['bluesky']);

  // Preview mode with telegram among the destinations still queues it: the stub publisher delivers it.
  const { store: previewStore, engine: previewEngine } = setup(['bluesky', 'telegram']);
  const previewNative = post({ id: 'at://did:plc:x/78', platform: 'bluesky', authorId: 'bluesky-account', createdAt: at(5), text: 'native post body' });
  previewEngine.ingest(snapshot([previewNative], at(10), 'bluesky', 'bluesky-account'), at(10));
  assert.equal(previewStore.jobs(100).filter(j => j.kind === 'reminder').length, 1);
});

test('source-flagged sensitive content publishes with a marking instead of being held', async () => {
  const { store, engine } = setup(['bluesky', 'sharkey']);
  // Text-only so the parts render without network; what is under test is that the flag survives the trip.
  const flagged = post({ id: '710', createdAt: at(10), sensitive: true, text: 'flagged body' });
  assert.equal(unsupportedReason(flagged), undefined, 'a flagged post is publishable, not held');
  engine.ingest(snapshot([flagged], at(650)), at(650));
  for (const source of ['bluesky', 'sharkey'] as const) engine.ingest(snapshot([], at(700), source, `${source}-account`), at(700));
  assert.equal(engine.sealReady(at(900)), 1, 'the batch seals and publishes normally');
  assert.equal(store.getPost('x', '710')?.classification, 'ready');
  for (const destination of ['bluesky', 'sharkey'] as const) {
    const job = store.jobs(100).find(j => j.kind === 'publish' && j.destination === destination)!;
    for (const part of await engine.parts(job)) {
      if (part.isFooter) continue;
      assert.equal(part.sensitive, true, `${destination} carries the marking on every part`);
    }
  }

  // An unflagged post carries no marking, so nothing is over-labelled.
  engine.ingest(snapshot([post({ id: '711', createdAt: at(10), text: 'plain body' })], at(650)), at(650));
  engine.sealReady(at(900));
  const plainJob = store.jobs(100).find(j => j.kind === 'publish' && j.aggregateId === 'x:711' && j.destination === 'bluesky')!;
  assert.ok((await engine.parts(plainJob)).every(p => p.sensitive === undefined && p.cw === undefined));
});

test('a repeatedly failing downstream collector degrades seal freshness instead of blocking forever', () => {
  const { store, engine } = setup(['bluesky', 'sharkey']);
  engine.ingest(snapshot([post({ id: '960', createdAt: at(10) })], at(650)), at(650));
  engine.ingest(snapshot([], at(700), 'bluesky', 'bluesky-account'), at(700));
  engine.ingest(snapshot([], at(700), 'sharkey', 'sharkey-account'), at(700));
  // Refresh X far into the future so at seal time only the downstream watermarks are stale.
  engine.ingest(snapshot([], at(5000)), at(5000));
  // The downstream watermarks (at 700) are now well past SOURCE_FRESHNESS_SECONDS, so the batch is held.
  assert.equal(engine.sealReady(at(5001)), 0, 'a stale downstream mirror source blocks sealing');
  assert.equal(store.getBatch('x:960')?.state, 'open');
  // Once each downstream has failed to collect repeatedly, its freshness is downgraded to "ever seen".
  store.setSetting('collect_failures:bluesky', 3);
  store.setSetting('collect_failures:sharkey', 3);
  assert.equal(engine.sealReady(at(5002)), 1, 'a repeatedly-failing downstream no longer blocks the seal');
  assert.equal(store.getBatch('x:960')?.state, 'sealed');
  assert.ok(store.events(20).some(e => e.level === 'warn' && /stale downstream/.test(e.message)), 'the degraded seal is surfaced as a warning');
  // A single X source is never degraded: a stale X watermark still blocks regardless of failures.
  engine.ingest(snapshot([post({ id: '961', createdAt: at(5000) })], at(5001)), at(5001));
  store.setSetting('collect_failures:x', 9);
  assert.equal(store.getBatch('x:961')?.state, 'open');
  // Seal far enough ahead that X itself is stale; the X batch must remain unsealed.
  const farLater = new Date(Date.parse(at(5001)) + 4000_000).toISOString();
  engine.sealReady(farLater);
  assert.equal(store.getBatch('x:961')?.state, 'open', 'X freshness is never relaxed by the failure counter');
});

test('a native root with incomplete metadata is held loudly: error event for Telegram, mirror still registered', () => {
  const { store, engine } = setup();
  const native = post({ id: 'note1', platform: 'sharkey', authorId: 'sharkey-account', createdAt: at(5), metadataComplete: false });
  engine.ingest(snapshot([native], at(10), 'sharkey', 'sharkey-account'), at(10));
  assert.equal(store.getPost('sharkey', 'note1')?.classification, 'unsupported');
  assert.equal(store.jobs(100).filter(j => j.kind === 'reminder').length, 0);
  assert.deepEqual(store.mirrors(at(10)).map(m => m.post.id), ['note1'], 'a manual X copy must not echo back');
  assert.deepEqual(store.errorEventsAfter(0).map(e => e.message), ['Native post held: incomplete_metadata']);
});
