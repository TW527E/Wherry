import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Engine, Worker, decideMirror, sourcePostSchema, unsupportedReason } from '../src/engine.js';
import { Store } from '../src/store.js';
import { nativePollPayload, pollSnapshotSchema } from '../src/poll.js';
import { parseXPoll } from '../src/platforms/x-poll.js';
import { parseTweetFacts } from '../src/platforms/x.js';
import { BlueskyClient } from '../src/platforms/bluesky.js';
import { SharkeyClient } from '../src/platforms/sharkey.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import { cleanXLinks, fitsText } from '../src/text.js';
import type { Destination, HttpOptions, HttpResponse, PollSnapshot, PublishContext, PublishPart, Publisher, SourcePost, Transport } from '../src/types.js';

const instant = '2026-09-24T00:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(instant) + seconds * 1000).toISOString();
const poll: PollSnapshot = { options: [{ text: '茶 🍵', percentage: 60 }, { text: '咖啡 ☕', percentage: 40 }],
  status: 'open', capturedAt: instant, expiresAt: at(3600), expiresAtEstimated: true, totalVotes: 10 };
const source: SourcePost = { platform: 'x', id: '123', authorId: 'owner', createdAt: instant, text: '今天喝什麼？',
  relationKnown: true, replyToId: null, visibility: 'public', metadataComplete: true, attachments: [], poll: true, pollData: poll };
const json = (value: unknown): HttpResponse => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });
const body = (options?: HttpOptions): Record<string, any> => JSON.parse(String(options?.body));
const mock = (request: Transport['request']): Transport => ({ request, async json() { throw new Error('Unexpected JSON request'); } });
const noNetwork = mock(async () => { throw new Error('Network is unavailable in tests'); });
const part = (overrides: Partial<PublishPart> = {}): PublishPart => ({ key: 'poll', sourcePostId: '123', text: source.text,
  images: [], poll, sourceUrl: 'https://x.com/owner/status/123', ...overrides });

function engineFixture(t: { after(fn: () => void): void }, posts: SourcePost[] = [source], destinations: Destination[] = ['bluesky', 'sharkey', 'telegram']) {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-poll-'));
  const config = loadConfig({ DATA_DIR: directory, DESTINATIONS: destinations.join(','), BLUESKY_ENABLED: 'true', SHARKEY_ENABLED: 'true', THREAD_SETTLE_SECONDS: '30' });
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const engine = new Engine(store, config, noNetwork);
  for (const platform of ['x', 'bluesky', 'sharkey'] as const) {
    engine.ingest({ platform, accountId: 'owner', posts: [], fetchedAt: at(-1), complete: true, warnings: [] }, at(-1));
  }
  // Scan at t=600 (the thread window has closed) so the batch's settleAt (scan + 30s) lands before the
  // t=650 the tests use for parts/delivery; without this the batch never seals and no jobs are created.
  engine.ingest({ platform: 'x', accountId: 'owner', posts, fetchedAt: at(600), complete: true, warnings: [] }, at(600));
  for (const platform of ['bluesky', 'sharkey'] as const) store.setSetting(`fresh:${platform}`, at(600));
  engine.sealReady(at(645));
  return { engine, store, jobs: store.jobs(100).filter(job => job.kind === 'publish') };
}

const openHtml = (status: string): string => `<article><div data-testid="tweetText">選哪個？</div><div data-testid="cardPoll">
  <div role="radiogroup"><div role="radio" aria-setsize="2" aria-posinset="1"><span>茶 <img alt="🍵"></span></div>
  <div role="radio" aria-setsize="2" aria-posinset="2"><span>咖啡 ☕</span></div></div>
  <span data-testid="pollTotalVotes">1.2K votes</span><span data-testid="pollTimeRemaining">${status}</span></div></article>`;
const resultsHtml = `<div data-testid="cardPoll"><ul>
  <li><div dir="auto">茶 🍵</div><div dir="auto">60%</div></li>
  <li><div dir="auto">咖啡 ☕</div><div dir="auto">40%</div></li>
  </ul><span>10 votes · Final results</span></div>`;

test('X poll parsing keeps complete choices and fixed, explicitly estimated countdown deadlines', () => {
  for (const [status, seconds] of [['1 hour 30 minutes left', 5400], ['剩餘 1 天 2 小時', 93600], ['還剩 59 分鐘', 3540], ['残り2時間', 7200]] as const) {
    const result = parseXPoll(openHtml(status), instant);
    assert.equal(result.detected, true);
    assert.deepEqual(result.pollData?.options, [{ text: '茶 🍵' }, { text: '咖啡 ☕' }]);
    assert.equal(result.pollData?.status, 'open');
    assert.equal(result.pollData?.expiresAt, at(seconds));
    assert.equal(result.pollData?.expiresAtEstimated, true);
    assert.equal(result.pollData?.totalVotes, undefined, 'abbreviated counts are not invented');
    assert.equal(result.pollData?.totalVotesText, '1.2K votes');
  }
  const facts = parseTweetFacts({ id: '123', authorId: 'owner', createdAt: instant, pollData: poll }, 'owner');
  assert.equal(facts.poll, true);
  assert.deepEqual(facts.pollData, poll);
  assert.deepEqual(sourcePostSchema.parse(source).pollData, poll);
});

test('X results are parsed independently of bars, while quotes and incomplete widgets fail closed', () => {
  const result = parseXPoll(resultsHtml, instant);
  assert.deepEqual(result.pollData?.options, poll.options);
  assert.equal(result.pollData?.status, 'closed');
  assert.equal(result.pollData?.totalVotes, 10);
  assert.equal(result.pollData?.expiresAt, undefined);
  assert.deepEqual(parseXPoll(`<article><div data-testid="quoteTweet">${resultsHtml}</div></article>`, instant), { detected: false });
  assert.deepEqual(parseXPoll('<div data-testid="tweetText">poll results: 60% 40%</div>', instant), { detected: false });
  for (const html of [resultsHtml.replace('40%', '30%'), resultsHtml.replace('<div dir="auto">40%</div>', ''),
    openHtml('1 hour left').replace('aria-setsize="2"', 'aria-setsize="3"'), resultsHtml + resultsHtml,
    '<div data-testid="cardPoll"><span>Loading…</span></div>', 'x'.repeat(256_001)]) {
    assert.deepEqual(parseXPoll(html, instant), { detected: true });
  }
  const unknown = parseXPoll(openHtml('Soon'), instant).pollData!;
  assert.equal(unknown.status, 'open');
  assert.equal(unknown.expiresAt, undefined);
  assert.throws(() => nativePollPayload(unknown, 'telegram', Date.parse(instant)), /deadline is unavailable/);
  assert.equal(pollSnapshotSchema.safeParse({ ...poll, options: [{ text: 'A', percentage: 50 }, { text: 'B' }] }).success, false);
});

test('native payloads copy choices, never votes, and reject expired, unknown or incompatible polls', () => {
  assert.deepEqual(nativePollPayload(poll, 'sharkey', Date.parse(instant)), { choices: ['茶 🍵', '咖啡 ☕'], multiple: false, expiresAt: Date.parse(at(3600)) });
  assert.deepEqual(nativePollPayload(poll, 'telegram', Date.parse(at(60))), nativePollPayload(poll, 'telegram', Date.parse(instant)));
  for (const invalid of [{ ...poll, status: 'closed' as const }, { ...poll, status: 'unknown' as const },
    { ...poll, expiresAt: undefined, expiresAtEstimated: undefined }]) {
    assert.throws(() => nativePollPayload(invalid, 'sharkey', Date.parse(instant)));
  }
  assert.throws(() => nativePollPayload(poll, 'telegram', Date.parse(at(3596))), /remaining poll duration/);
  assert.throws(() => nativePollPayload(poll, 'sharkey', Date.parse(at(3600))), /expired/);
  const tooLong = { ...poll, options: [{ text: 'x'.repeat(51) }, { text: 'B' }] };
  assert.throws(() => nativePollPayload(tooLong, 'sharkey', Date.parse(instant)), /not be truncated/);
  assert.doesNotThrow(() => nativePollPayload(tooLong, 'telegram', Date.parse(instant)));
  assert.throws(() => nativePollPayload({ ...poll, options: [{ text: 'A' }, { text: 'A' }] }, 'telegram', Date.parse(instant)), /distinct/);
  assert.equal(unsupportedReason(source), undefined);
  assert.equal(unsupportedReason({ ...source, text: '' }), undefined);
  assert.equal(unsupportedReason({ ...source, pollData: undefined }), 'poll_details_unavailable');
  assert.equal(unsupportedReason({ ...source, platform: 'sharkey' }), 'poll_not_supported');
});

test('engine creates one native poll per supported destination and a complete Bluesky fallback', async t => {
  const { engine, store, jobs } = engineFixture(t);
  assert.equal(jobs.length, 3);
  for (const job of jobs) {
    const parts = await engine.parts(job, at(650));
    if (job.destination === 'bluesky') {
      assert.ok(parts.every(item => item.poll === undefined));
      const content = parts.filter(item => !item.isFooter).map(item => item.text).join('');
      assert.match(content, /Bluesky 不支援原生投票/);
      assert.match(content, /茶 🍵 — 60%/);
      assert.match(content, /https:\/\/x\.com\/owner\/status\/123/);
      assert.ok(parts.every(item => fitsText(item.text, { graphemes: 300, utf8Bytes: 3000 })));
    } else {
      assert.equal(parts.filter(item => item.poll).length, 1);
      assert.deepEqual(parts.at(-1)!.poll, poll);
      assert.match(parts.map(item => item.text).join(''), /票數不與 X 或其他平台合併/);
      assert.doesNotMatch(parts.map(item => item.text).join(''), /60%|總票數：10/);
      if (job.destination === 'telegram') {
        assert.equal(parts.at(-1)!.key.endsWith(':poll'), true);
        assert.equal(parts.at(-1)!.text, source.text);
      }
    }
  }
  engine.ingest({ platform: 'x', accountId: 'owner', posts: [{ ...source, pollData: { ...poll, totalVotes: 20 } }], fetchedAt: at(700), complete: true, warnings: [] }, at(700));
  assert.equal(store.getPost('x', '123')!.post.pollData!.totalVotes, 10, 're-scans do not rewrite receipts or restart the deadline');
});

test('unsupported native duration does not prevent Bluesky fallback or send a partial Telegram post', async t => {
  const { engine, store, jobs } = engineFixture(t, [{ ...source, pollData: { ...poll, status: 'closed' } }]);
  const calls: Destination[] = [];
  const publishers = new Map<Destination, Publisher>(jobs.map(job => [job.destination, { destination: job.destination,
    async publish() { calls.push(job.destination); return { id: 'offline' }; } }]));
  assert.equal(await new Worker(engine, publishers).run(at(700)), 1);
  assert.ok(calls.length > 0 && calls.every(destination => destination === 'bluesky'));
  assert.equal(store.getJob(jobs.find(job => job.destination === 'telegram')!.id)!.state, 'review');
  assert.equal(store.getJob(jobs.find(job => job.destination === 'sharkey')!.id)!.state, 'review');
});

test('Sharkey creates a native poll with its deadline and CW, and refuses a response that lost the poll', async () => {
  const notes: Record<string, any>[] = [];
  let dropPoll = false;
  const transport = mock(async (url, options) => {
    if (url.endsWith('/users/show')) return json({ id: 'owner', username: 'owner', host: null });
    if (url.endsWith('/meta')) return json({ maxNoteTextLength: 3000 });
    if (url.endsWith('/notes/create')) {
      const request = body(options); notes.push(request);
      return json({ createdNote: { id: `note${notes.length}`, ...(dropPoll ? {} : { poll: { multiple: false,
        expiresAt: new Date(request.poll.expiresAt).toISOString(), choices: request.poll.choices.map((text: string) => ({ text, votes: 0 })) } }) } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const client = new SharkeyClient(loadConfig({ SHARKEY_TOKEN: 'offline', SHARKEY_USERNAME: 'owner' }).sharkey, transport, { now: () => new Date(instant) });
  await client.publish(part({ cw: '注意', text: '問題\n票數獨立' }), { idempotencyKey: 'sharkey-poll', parent: { id: 'parent' } });
  assert.deepEqual(notes[0]!.poll, { choices: ['茶 🍵', '咖啡 ☕'], multiple: false, expiresAt: Date.parse(at(3600)) });
  assert.equal(notes[0]!.cw, '注意');
  assert.equal(notes[0]!.replyId, 'parent');
  dropPoll = true;
  await assert.rejects(client.publish(part(), { idempotencyKey: 'lost-poll' }), (error: any) => error.uncertain === true);
});

test('Telegram sends an anonymous single-choice native poll with a source button and unchanged closing time', async () => {
  const requests: Record<string, any>[] = [];
  let clock = instant;
  let dropPoll = false;
  const client = new TelegramClient(loadConfig({ TELEGRAM_BOT_TOKEN: 'offline', TELEGRAM_PUBLIC_CHAT_ID: '2' }).telegram,
    mock(async (url, options) => {
      assert.equal(url.endsWith('/sendPoll'), true);
      const request = body(options); requests.push(request);
      return json({ ok: true, result: { message_id: requests.length, chat: { id: 2 },
        ...(dropPoll ? {} : { poll: { ...request, id: 'poll-id' } }) } });
    }), () => new Date(clock));
  const context = { idempotencyKey: 'telegram-poll', parent: { id: '5', messageIds: [5], chatId: '2' } };
  await client.publish(part(), context);
  clock = at(60);
  await client.publish(part(), { ...context, idempotencyKey: 'another' });
  assert.equal(requests[0]!.close_date, Date.parse(at(3600)) / 1000);
  assert.equal(requests[1]!.close_date, requests[0]!.close_date);
  assert.equal(requests[0]!.open_period, undefined);
  assert.equal(requests[0]!.is_anonymous, true);
  assert.equal(requests[0]!.allows_multiple_answers, false);
  assert.deepEqual(requests[0]!.options, [{ text: '茶 🍵' }, { text: '咖啡 ☕' }]);
  assert.deepEqual(requests[0]!.reply_parameters, { message_id: 5, allow_sending_without_reply: false });
  assert.equal(requests[0]!.reply_markup.inline_keyboard[0][0].url, 'https://x.com/owner/status/123');
  assert.equal(requests[0]!.parse_mode, undefined, 'poll questions are plain text, not HTML');
  await assert.rejects(client.publish(part({ sensitive: true }), context), /cannot hide/);
  await assert.rejects(client.publish(part({ text: 'x'.repeat(301) }), context), /1–300/);
  assert.equal(requests.length, 2, 'invalid polls are rejected before I/O');
  dropPoll = true;
  await assert.rejects(client.publish(part(), context), (error: any) => error.uncertain === true);
});

test('sensitive polls retain Sharkey CW, but never expose unspoilerable Telegram options', async t => {
  const { engine, jobs } = engineFixture(t, [{ ...source, sensitive: true, cw: '來源警告' }]);
  const sharkey = await engine.parts(jobs.find(job => job.destination === 'sharkey')!, at(650));
  assert.equal(sharkey.at(-1)!.cw, '來源警告');
  await assert.rejects(engine.parts(jobs.find(job => job.destination === 'telegram')!, at(650)), /cannot hide/);
  const client = new BlueskyClient(loadConfig({}).bluesky, noNetwork);
  await assert.rejects(client.publish(part(), { idempotencyKey: 'unsupported' }), /no native polls/);
});

test('Telegram poll creation retries only the failed durable poll, not the already published question', async t => {
  const { engine, store, jobs } = engineFixture(t, [source], ['telegram']);
  const calls: Array<{ part: PublishPart; context: PublishContext }> = [];
  let fail = true;
  const publisher: Publisher = { destination: 'telegram', async publish(item, context) {
    calls.push({ part: item, context });
    if (item.poll && fail) { fail = false; throw Object.assign(new Error('explicit rejection'), { status: 400, uncertain: false }); }
    return { id: String(calls.length), messageIds: [calls.length], chatId: '2' };
  } };
  const worker = new Worker(engine, new Map([['telegram', publisher]]));
  await worker.run(at(700));
  assert.equal(store.getJob(jobs[0]!.id)!.state, 'failed');
  engine.action('retry', jobs[0]!.id, at(710));
  await worker.run(at(720));
  assert.equal(store.getJob(jobs[0]!.id)!.state, 'succeeded');
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(call => !call.part.poll).length, 1);
  assert.equal(calls[1]!.context.idempotencyKey, calls[2]!.context.idempotencyKey);
  assert.equal(calls[2]!.context.parent!.messageIds![0], 1);
  assert.deepEqual(JSON.parse(store.getStep(jobs[0]!.id, calls[2]!.part.key)!.content).poll, poll);
  assert.equal(await worker.run(at(800)), 0);
});

test('a succeeded poll does not block retrying a later thread member after the deadline', async t => {
  const reply: SourcePost = { ...source, id: '124', createdAt: at(60), text: '後續說明', replyToId: '123', replyToAuthorId: 'owner', poll: false, pollData: undefined };
  const { engine, store, jobs } = engineFixture(t, [source, reply], ['telegram']);
  const sent: PublishPart[] = [];
  let fail = true;
  const worker = new Worker(engine, new Map([['telegram', { destination: 'telegram' as const, async publish(item: PublishPart) {
    sent.push(item);
    if (item.sourcePostId === '124' && fail) { fail = false; throw Object.assign(new Error('rejected'), { status: 400, uncertain: false }); }
    return { id: String(sent.length), messageIds: [sent.length], chatId: '2' };
  } }]]));
  await worker.run(at(700));
  assert.equal(store.getJob(jobs[0]!.id)!.state, 'failed');
  engine.action('retry', jobs[0]!.id, at(3700));
  await worker.run(at(3800));
  assert.equal(store.getJob(jobs[0]!.id)!.state, 'succeeded');
  assert.equal(sent.filter(item => item.poll).length, 1, 'the closed native poll is not recreated');
});

test('uncertain native poll delivery stays unknown even after expiry', async t => {
  const { engine, store, jobs } = engineFixture(t, [source], ['telegram']);
  const items = await engine.parts(jobs[0]!, at(650));
  for (const item of items) {
    store.beginStep(jobs[0]!.id, item.key, { text: item.text, poll: item.poll }, at(700));
    if (!item.poll) store.finishStep(jobs[0]!.id, item.key, { id: '1', messageIds: [1], chatId: '2' });
  }
  let sent = 0;
  const worker = new Worker(engine, new Map([['telegram', { destination: 'telegram' as const, async publish() { sent++; return { id: 'unexpected' }; } }]]));
  await worker.run(at(3800));
  assert.equal(store.getJob(jobs[0]!.id)!.state, 'unknown');
  assert.equal(sent, 0);
});

test('identical questions do not auto-match different polls, and uncertain native copies cannot echo back', async t => {
  const distinctive = 'Which of these drinks should we serve at the next community meetup?';
  const native = { ...source, platform: 'sharkey' as const, id: 'native', text: distinctive, pollData: undefined };
  assert.equal(decideMirror([{ ...source, text: distinctive }], [{ id: 'mirror:sharkey:native', state: 'pending', expired: false, post: native }]).state, 'review');
  const { engine, store, jobs } = engineFixture(t, [source], ['sharkey']);
  const item = (await engine.parts(jobs[0]!, at(650)))[0]!;
  store.beginStep(jobs[0]!.id, item.key, { text: item.text }, at(700));
  assert.equal(store.outbound('sharkey', 'unconfirmed', cleanXLinks(item.text)), 'possible');
  store.finishStep(jobs[0]!.id, item.key, { id: 'native' });
  engine.ingest({ platform: 'sharkey', accountId: 'owner', posts: [{ ...native, text: item.text }], fetchedAt: at(710), complete: true, warnings: [] }, at(710));
  assert.equal(store.getPost('sharkey', 'native')!.reason, 'outbound_known');
  assert.equal(store.jobs(100).some(job => job.kind === 'reminder'), false);
});
