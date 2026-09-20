import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { Store } from './store.js';
import { cleanXLinks, fixupUrl, graphemes, htmlEscape, normalizeText, similarity, splitText } from './text.js';
import { prepareImages } from './media.js';
import type { Attachment, Batch, Collector, Destination, Job, PublishPart, Publisher, RemoteRef, SourcePost, SourceSnapshot, Transport } from './types.js';

const attachmentSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'unknown']), url: z.string().url().optional(), path: z.string().optional(),
  mimeType: z.string().optional(), alt: z.string().default(''), sha256: z.string().optional(), perceptualHash: z.string().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(), size: z.number().nonnegative().optional(), animated: z.boolean().optional(),
});
export const sourcePostSchema = z.object({
  platform: z.enum(['x', 'bluesky', 'sharkey', 'local']), id: z.string().min(1), authorId: z.string().min(1),
  createdAt: z.string().datetime(), text: z.string().max(100_000), url: z.string().url().optional(), rootId: z.string().optional(),
  replyToId: z.string().nullable().optional(), replyToAuthorId: z.string().nullable().optional(), relationKnown: z.boolean(),
  visibility: z.enum(['public', 'restricted', 'unknown']), repost: z.boolean().optional(), quoteUrl: z.string().optional(), poll: z.boolean().optional(),
  cw: z.string().optional(), sensitive: z.boolean().optional(), attachments: z.array(attachmentSchema).max(100), metadataComplete: z.boolean(),
});
export const snapshotSchema = z.object({
  platform: z.enum(['x', 'bluesky', 'sharkey']), accountId: z.string().min(1), posts: z.array(sourcePostSchema).max(1000),
  fetchedAt: z.string().datetime(), complete: z.boolean(), warnings: z.array(z.string()),
});

export function unsupportedReason(post: SourcePost): string | undefined {
  if (!post.metadataComplete) return 'incomplete_metadata';
  if (post.visibility !== 'public') return 'non_public_content';
  if (post.sensitive || post.cw) return 'sensitive_content_requires_manual_review';
  if (post.poll) return 'poll_not_supported';
  if (post.attachments.length > 4) return 'more_than_four_images';
  if (post.attachments.some(a => a.kind !== 'image' || a.animated)) return 'only_static_images_in_phase_one';
  if (post.platform === 'x' && graphemes(post.text).length > 280) return 'long_x_post_requires_manual_review';
  if (!post.text.trim() && !post.attachments.length) return 'empty_content';
  return undefined;
}

function compatibleMedia(a: Attachment[], b: Attachment[]): 'same' | 'possible' | 'different' {
  if (!a.length && !b.length) return 'same';
  if (a.length !== b.length) return 'different';
  if (a.every((m, i) => m.sha256 && b[i]?.sha256 === m.sha256)) return 'same';
  if (a.some((m, i) => m.kind !== b[i]?.kind)) return 'different';
  return 'possible';
}

export interface MirrorDecision { state: 'none' | 'match' | 'review'; mirrorId?: string; reason: string }
/**
 * Decides whether a new X batch is a manual copy of something already seen on a downstream platform.
 * A missed mirror publishes a duplicate, so ambiguous evidence is deliberately routed to review
 * (a notification) rather than silently published.
 */
export function decideMirror(posts: SourcePost[], candidates: ReturnType<Store['mirrors']>): MirrorDecision {
  const text = normalizeText(posts.map(p => p.text).join(''));
  const spaced = normalizeText(posts.map(p => p.text).join('\n'));
  const media = posts.flatMap(p => p.attachments);
  const exact: string[] = [];
  let possible = false;
  for (const candidate of candidates) {
    const expected = normalizeText(candidate.post.text);
    const textEqual = expected === text || expected === spaced;
    const mediaMatch = compatibleMedia(candidate.post.attachments, media);
    const evidence = Boolean(expected) || (media.length > 0 && mediaMatch === 'same');
    if (textEqual && mediaMatch === 'same' && evidence && !candidate.expired) { exact.push(candidate.id); continue; }
    const sameMediaHash = media.some(a => a.sha256 && candidate.post.attachments.some(b => b.sha256 === a.sha256));
    const shorter = Math.min(expected.length, spaced.length), longer = Math.max(expected.length, spaced.length);
    const containment = longer > 0 && shorter / longer >= 0.3 && (expected.includes(spaced) || spaced.includes(expected));
    if ((expected && spaced && (similarity(expected, spaced) >= 0.5 || containment))
      || (textEqual && !evidence)
      || (!text && media.length > 0 && candidate.post.attachments.length > 0)
      || sameMediaHash) possible = true;
  }
  if (exact.length > 0) return exact.length === 1 && !possible
    ? { state: 'match', mirrorId: exact[0], reason: 'unique_text_and_media_match' }
    : { state: 'review', reason: 'multiple_possible_manual_mirrors' };
  return possible ? { state: 'review', reason: 'possible_manual_mirror' } : { state: 'none', reason: 'no_mirror_evidence' };
}

export class Engine {
  constructor(readonly store: Store, readonly config: AppConfig, readonly transport: Transport) {}

  ingest(value: unknown, now = new Date().toISOString()): { added: number; baseline: boolean } {
    const snapshot = snapshotSchema.parse(value) as SourceSnapshot;
    if (!snapshot.complete) throw new Error(`Incomplete ${snapshot.platform} snapshot; checkpoint unchanged${snapshot.warnings.length ? ` (${snapshot.warnings.join('; ')})` : ''}`);
    if (Date.parse(snapshot.fetchedAt) > Date.parse(now) + 60_000) throw new Error('Snapshot clock is in the future');
    // A repost legitimately carries the original author's id, not the account's, so it is exempt
    // from the identity guard; every original post must still belong to the collected account.
    if (snapshot.posts.some(p => p.platform !== snapshot.platform || (!p.repost && p.authorId.toLowerCase() !== snapshot.accountId.toLowerCase()))) {
      throw new Error('Snapshot contains mismatched platform/account');
    }
    const identity = this.store.setting<string | undefined>(`account:${snapshot.platform}`, undefined);
    if (identity && identity !== snapshot.accountId) throw new Error('Collector account changed; manual reconfiguration required');
    return this.store.transaction(() => {
      this.store.setSetting(`account:${snapshot.platform}`, snapshot.accountId);
      const baselineAt = this.store.setting<string | undefined>(`baseline:${snapshot.platform}`, undefined);
      let added = 0;
      const sorted = [...snapshot.posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const post of sorted) {
        if (this.store.getPost(post.platform, post.id)) continue;
        if (!baselineAt || post.createdAt <= baselineAt) {
          if (this.store.addPost(post, 'baseline', 'first_snapshot_no_backfill', now)) added++;
          if (post.platform !== 'x' && post.replyToId === null && !post.repost && !post.quoteUrl && post.visibility === 'public') this.store.addMirror(post, now);
          continue;
        }
        if (Date.parse(post.createdAt) > Date.parse(snapshot.fetchedAt) + 60_000) {
          this.store.addPost(post, 'mirror_review', 'source_clock_invalid', now); added++; continue;
        }
        if (post.platform === 'x') this.ingestX(post, now);
        else this.ingestNative(post, now);
        added++;
      }
      if (!baselineAt) this.store.setSetting(`baseline:${snapshot.platform}`, snapshot.fetchedAt);
      this.store.setSetting(`fresh:${snapshot.platform}`, snapshot.fetchedAt);
      this.store.event('info', `${snapshot.platform}: ${added} new records from ${snapshot.posts.length} collected${baselineAt ? '' : ' (baseline only)'}${snapshot.warnings.length ? ` — ${snapshot.warnings.join('; ')}` : ''}`);
      return { added, baseline: !baselineAt };
    });
  }

  private ingestNative(post: SourcePost, now: string): void {
    const outbound = this.store.outbound(post.platform, post.id, cleanXLinks(post.text));
    if (outbound) {
      this.store.addPost(post, outbound === 'known' ? 'ignored' : 'mirror_review', `outbound_${outbound}`, now);
      return;
    }
    if (!post.relationKnown || post.replyToId === undefined || !post.metadataComplete) {
      this.store.addPost(post, 'mirror_review', 'native_relationship_unknown', now); return;
    }
    if (post.replyToId !== null || post.repost || post.quoteUrl || post.visibility !== 'public') {
      this.store.addPost(post, 'ignored', 'ignored_native_non_root_or_private', now); return;
    }
    const unsupported = unsupportedReason(post);
    const key = Store.postKey(post.platform, post.id);
    this.store.addPost(post, unsupported ? 'unsupported' : 'ready', unsupported || 'manual_x_reminder', now);
    this.store.addMirror(post, now);
    if (!unsupported) this.store.enqueue('reminder', key, 'telegram', now);
    else this.store.event('warn', `Native post held: ${unsupported}`, key);
  }

  private ingestX(post: SourcePost, now: string): void {
    if (post.repost || post.visibility !== 'public') { this.store.addPost(post, 'ignored', 'repost_or_non_public', now); return; }
    if (!post.relationKnown || post.replyToId === undefined) { this.store.addPost(post, 'mirror_review', 'reply_relationship_unknown', now); return; }
    if (post.replyToId === null) {
      const id = `x:${post.id}`;
      const unsupported = unsupportedReason(post);
      this.store.addBatch({ id, platform: 'x', rootId: post.id, rootCreatedAt: post.createdAt,
        cutoffAt: new Date(Date.parse(post.createdAt) + this.config.threadWindowSeconds * 1000).toISOString(),
        settleAt: new Date(Math.max(Date.parse(post.createdAt) + this.config.threadWindowSeconds * 1000, Date.parse(now)) + this.config.settleSeconds * 1000).toISOString(),
        state: unsupported ? 'review' : 'open', reason: unsupported || 'collecting_initial_thread' });
      this.store.addPost(post, unsupported ? 'unsupported' : 'collecting', unsupported || 'root', now, id);
      return;
    }
    if (!post.replyToAuthorId || post.replyToAuthorId.toLowerCase() !== post.authorId.toLowerCase()) {
      this.store.addPost(post, post.replyToAuthorId ? 'ignored' : 'mirror_review', post.replyToAuthorId ? 'reply_to_other' : 'parent_author_unknown', now); return;
    }
    const parent = this.store.getPost('x', post.replyToId);
    const batch = parent?.batchId ? this.store.getBatch(parent.batchId) : undefined;
    if (!batch || !parent) { this.store.addPost(post, 'ignored', 'self_reply_outside_new_batch', now); return; }
    if (batch.state !== 'open' || post.createdAt > batch.cutoffAt || post.createdAt < parent.post.createdAt) {
      this.store.addPost(post, 'ignored', 'skipped_late_self_reply', now); return;
    }
    const members = this.store.batchPosts(batch.id);
    const tail = members.at(-1)?.post;
    if (tail?.id !== post.replyToId) {
      this.store.addPost(post, 'mirror_review', 'branch_in_thread', now, batch.id);
      this.store.updateBatch(batch.id, 'review', 'thread_is_not_linear'); return;
    }
    const unsupported = unsupportedReason(post);
    this.store.addPost(post, unsupported ? 'unsupported' : 'collecting', unsupported || 'initial_self_thread', now, batch.id);
    if (unsupported) this.store.updateBatch(batch.id, 'review', unsupported);
  }

  sealReady(now = new Date().toISOString()): number {
    if (this.store.setting('paused', false)) return 0;
    let count = 0;
    for (const batch of this.store.openBatches()) {
      if (batch.settleAt > now) continue;
      const sources: Array<'x' | 'bluesky' | 'sharkey'> = batch.platform === 'x' ? ['x'] : [];
      if (this.config.destinations.includes('bluesky')) sources.push('bluesky');
      if (this.config.destinations.includes('sharkey')) sources.push('sharkey');
      if (sources.some(source => {
        const fresh = this.store.setting<string>(`fresh:${source}`, '');
        return !fresh || Date.parse(now) - Date.parse(fresh) > this.config.sourceFreshnessSeconds * 1000
          || (source === 'x' && fresh < batch.cutoffAt);
      })) continue;
      const posts = this.store.batchPosts(batch.id).map(p => p.post);
      const mirror = batch.platform === 'x' ? decideMirror(posts, this.store.mirrors(now)) : { state: 'none', reason: 'local_schedule' } as MirrorDecision;
      this.store.transaction(() => {
        if (mirror.state !== 'none') {
          this.store.updateBatch(batch.id, mirror.state === 'match' ? 'mirror' : 'review', mirror.reason);
          for (const post of posts) this.store.updatePost(Store.postKey(post.platform, post.id), mirror.state === 'match' ? 'manual_mirror' : 'mirror_review', mirror.reason);
          if (mirror.mirrorId) this.store.matchMirror(mirror.mirrorId, batch.rootId);
          this.store.event('warn', `X batch held: ${mirror.reason}`, batch.id);
        } else {
          this.store.updateBatch(batch.id, 'sealed', 'thread_closed');
          for (const post of posts) this.store.updatePost(Store.postKey(post.platform, post.id), 'ready', 'thread_closed');
          for (const destination of this.config.destinations) this.store.enqueue('publish', batch.id, destination, now);
          count++;
        }
      });
    }
    return count;
  }

  schedule(input: { text: string; attachments?: Attachment[]; dueAt: string }, now = new Date().toISOString()): string {
    const due = new Date(input.dueAt).toISOString();
    if (due < now) throw new Error('Schedule must be in the future');
    const post = sourcePostSchema.parse({ platform: 'local', id: randomUUID(), authorId: 'owner', text: input.text,
      createdAt: now, replyToId: null, relationKnown: true, visibility: 'public', attachments: input.attachments || [], metadataComplete: true }) as SourcePost;
    const unsupported = unsupportedReason(post);
    if (unsupported) throw new Error(unsupported);
    const id = Store.postKey('local', post.id);
    this.store.transaction(() => {
      this.store.addBatch({ id, platform: 'local', rootId: post.id, rootCreatedAt: now, cutoffAt: now, settleAt: due, state: 'sealed', reason: 'scheduled_no_x_url_yet' });
      this.store.addPost(post, 'ready', 'local_scheduled', now, id);
      this.store.addMirror(post, now);
      for (const destination of this.config.destinations) this.store.enqueue('publish', id, destination, now, due);
      this.store.enqueue('reminder', id, 'telegram', now, due);
    });
    return id;
  }

  action(action: 'skip' | 'mirror' | 'approve' | 'retry', id: string, now = new Date().toISOString()): void {
    // Callers include a web endpoint whose body is untrusted and whose TS types are erased at
    // runtime; validate here so no caller can drive a state change with an unexpected verb or id.
    if (!['skip', 'mirror', 'approve', 'retry'].includes(action)) throw new Error('action must be one of skip|mirror|approve|retry');
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw new Error('id must be a plain identifier');
    if (action === 'retry') {
      const job = this.store.getJob(id);
      if (!job || !['failed', 'review'].includes(job.state)) throw new Error('Only explicitly failed/review jobs can retry; unknown deliveries require reconciliation');
      this.store.updateJob(id, 'pending', undefined, now); return;
    }
    const batch = this.store.getBatch(id);
    if (!batch) throw new Error('Batch not found');
    const jobs = this.store.jobs(10000).filter(j => j.aggregateId === id);
    if (jobs.some(j => ['running', 'succeeded', 'unknown'].includes(j.state))) throw new Error('Already delivered/in-flight batch cannot be rewritten; inspect remote posts first');
    if (action === 'approve') {
      const members = this.store.batchPosts(id);
      if (members.some(m => unsupportedReason(m.post))) throw new Error('Unsupported/private/incomplete content cannot be force-published');
      if (members.some(m => !m.post.relationKnown)) throw new Error('Unknown reply relationship cannot be force-published');
      this.store.updateBatch(id, 'sealed', 'owner_confirmed_new_content');
      for (const destination of this.config.destinations) this.store.enqueue('publish', id, destination, now);
    } else {
      this.store.updateBatch(id, action === 'mirror' ? 'mirror' : 'ignored', 'owner_override');
      for (const job of jobs) this.store.updateJob(job.id, 'cancelled', 'owner_override');
    }
    this.store.event('info', `Owner action: ${action}`, id);
  }

  async parts(job: Job): Promise<PublishPart[]> {
    const batch = job.kind === 'publish' ? this.store.getBatch(job.aggregateId) : undefined;
    const members = job.kind === 'publish' ? this.store.batchPosts(job.aggregateId).map(p => p.post) : [this.store.postByKey(job.aggregateId)?.post].filter((p): p is SourcePost => Boolean(p));
    if (!members.length) throw new Error('Job source not found');
    const output: PublishPart[] = [];
    if (job.kind === 'reminder') output.push({ key: 'notice', sourcePostId: members[0]!.id, text: `🔔 ${members[0]!.platform} 有新內容，請手動發到 X。\n任務：${job.aggregateId}\n下方為可複製的內容。發出後可用 /mirror ${job.aggregateId} <X網址> 登記。`, images: [] });
    for (const post of members) {
      const unsupported = unsupportedReason(post);
      if (unsupported) throw new Error(unsupported);
      const images = await prepareImages(post.attachments, this.config, this.transport);
      let text = cleanXLinks(post.text);
      if (post.quoteUrl) text += `\n引用：${fixupUrl(post.quoteUrl) || post.quoteUrl}`;
      const sourceUrl = post.platform === 'x' ? fixupUrl(post.url || `https://x.com/${post.authorId}/status/${post.id}`) : undefined;
      const key = createHash('sha256').update(post.id).digest('hex').slice(0, 16);
      if (job.destination === 'telegram') {
        // Telegram counts the rendered HTML, not the raw text, so the escaped balloon must fit the limit.
        const chunks = splitHtml(text, images.length ? 1024 : 4096, sourceUrl ? 120 : 0);
        for (let i = 0; i < Math.max(chunks.length, images.length, 1); i++) {
          output.push({ key: `${key}:${i}`, sourcePostId: post.id, text: chunks[i] || '', images: images[i] ? [images[i]!] : [], sourceUrl });
        }
      } else {
        const chunks = splitText(text, job.destination === 'bluesky' ? { graphemes: 300, utf8Bytes: 3000 } : { utf16: 3000 });
        chunks.forEach((chunk, index) => output.push({ key: `${key}:${index}`, sourcePostId: post.id, text: chunk, images: index === 0 ? images : [], sourceUrl }));
      }
    }
    if (batch?.platform === 'x' && job.destination !== 'telegram') {
      const root = members[0]!;
      const url = fixupUrl(root.url || `https://x.com/${root.authorId}/status/${root.id}`);
      if (!url) throw new Error('X root URL invalid');
      output.push({ key: 'footer', sourcePostId: batch.rootId, text: `🔗 X 原推文：${url}`, images: [], sourceUrl: url, isFooter: true });
    }
    return output;
  }
}

export class Worker {
  constructor(readonly engine: Engine, readonly publishers: Map<Destination, Publisher>) {}
  async run(now = new Date().toISOString()): Promise<number> {
    const { store } = this.engine;
    // Which publishers exist is decided when the runtime is built: preview mode wires stub
    // publishers, live mode wires real clients. The worker itself never invents a remote call.
    if (store.setting('paused', false)) return 0;
    let count = 0;
    for (const job of store.dueJobs(now)) {
      const publisher = this.publishers.get(job.destination);
      if (!publisher) {
        store.updateJob(job.id, 'failed', `No ${job.destination} publisher is configured for this destination`);
        store.event('error', `No publisher configured for ${job.destination}`, job.id);
        continue;
      }
      if (job.kind === 'publish' && store.getBatch(job.aggregateId)?.state !== 'sealed') continue;
      if (!store.claimJob(job.id)) continue;
      let activeKey: string | undefined;
      try {
        const parts = await this.engine.parts(job);
        let root: RemoteRef | undefined, parent: RemoteRef | undefined;
        for (const part of parts) {
          activeKey = part.key;
          const prior = store.getStep(job.id, part.key);
          if (prior?.state === 'succeeded' && prior.result) {
            if (part.key !== 'notice') { parent = prior.result; root ??= prior.result; }
            continue;
          }
          if (prior?.state === 'started') throw Object.assign(new Error('Uncertain previous remote delivery; reconciliation required'), { uncertain: true });
          store.beginStep(job.id, part.key, { text: part.text, sourcePostId: part.sourcePostId, imageHashes: part.images.map(i => i.sha256) }, now);
          const ref = await publisher.publish(part, {
            root: part.key === 'notice' ? undefined : root,
            parent: part.key === 'notice' ? undefined : parent,
            audience: job.kind === 'reminder' ? 'private' : 'public', idempotencyKey: `${job.id}:${part.key}`,
          });
          store.finishStep(job.id, part.key, ref);
          if (part.key !== 'notice') { parent = ref; root ??= ref; }
        }
        store.updateJob(job.id, 'succeeded');
        store.event('info', `${job.destination}: delivered ${parts.length} parts`, job.id);
        count++;
      } catch (error) {
        const value = error as { message?: string; status?: number; retryAfter?: number; uncertain?: boolean };
        const message = safeError(error);
        if (value.uncertain || (activeKey && value.uncertain !== false && !value.status)) {
          store.updateJob(job.id, 'unknown', message);
        } else {
          if (activeKey) store.rejectStep(job.id, activeKey);
          const transient = value.status === 429 || (value.status !== undefined && value.status >= 500);
          if (transient && job.attempts + 1 < this.engine.config.maxAttempts) {
            const delay = Math.max(value.retryAfter || 0, 30 * 2 ** job.attempts);
            store.updateJob(job.id, 'pending', message, new Date(Date.parse(now) + delay * 1000).toISOString());
          } else store.updateJob(job.id, activeKey ? 'failed' : 'review', message);
        }
        store.event('error', `${job.destination}: ${message}`, job.id);
      }
    }
    return count;
  }
}

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown error')
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/(?:bearer\s+)[\w.-]+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+/g, '[bot-token]').slice(0, 350);
}

/**
 * Splits raw text so that the HTML-escaped rendering fits the destination limit.
 * Splitting happens on the raw string, so an entity such as `&amp;` is never cut in half.
 */
export function splitHtml(text: string, escapedLimit: number, reserve = 0): string[] {
  let budget = Math.max(1, escapedLimit - reserve);
  for (let attempt = 0; attempt < 12; attempt++) {
    const chunks = splitText(text, { utf16: budget });
    if (chunks.every(chunk => htmlEscape(chunk).length <= escapedLimit - reserve)) return chunks;
    const longest = Math.max(...chunks.map(chunk => htmlEscape(chunk).length));
    budget = Math.max(1, Math.floor(budget * ((escapedLimit - reserve) / longest)) - 1);
  }
  throw new Error('Text cannot be split to fit the Telegram HTML limit without changing content');
}

export async function collectCycle(engine: Engine, collectors: Collector[], now = new Date().toISOString()): Promise<void> {
  const sorted = [...collectors].sort((a, b) => Number(a.platform === 'x') - Number(b.platform === 'x'));
  for (const collector of sorted) {
    // Pass the last successful fetch watermark so the collector pages back only as far as needed
    // and can tell whether it closed the whole gap since the previous scan.
    const since = engine.store.setting<string | undefined>(`fresh:${collector.platform}`, undefined);
    try { engine.ingest(await collector.collect(since), now); }
    catch (error) { engine.store.event('error', `${collector.platform} collection failed: ${safeError(error)}`); }
  }
  engine.sealReady(now);
}
