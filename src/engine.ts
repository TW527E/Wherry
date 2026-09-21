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
  fetchedAt: z.string().datetime(), complete: z.boolean(), watermark: z.string().datetime().optional(), warnings: z.array(z.string()),
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
    // A snapshot that neither completed nor tells us how far it safely reached is a structural
    // failure (nothing rendered, schema broken): refuse it so the checkpoint does not advance.
    // But a snapshot that ran out of scroll budget yet parsed cleanly carries a `watermark` — the
    // oldest post it did reach — and IS ingested, advancing the checkpoint only to that point.
    // Otherwise the checkpoint stays pinned to an old time the budget can never reach, and every
    // scan re-scrolls the same range forever, blocking the queue and starving shutdown.
    if (!snapshot.complete && !snapshot.watermark) throw new Error(`Incomplete ${snapshot.platform} snapshot; checkpoint unchanged${snapshot.warnings.length ? ` (${snapshot.warnings.join('; ')})` : ''}`);
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
      // A complete scan covered the whole gap up to fetchedAt, so the checkpoint moves there. A
      // budget-limited scan only reached `watermark` (the oldest post it rendered), so the
      // checkpoint moves there instead — never past unseen posts — and always strictly forward of
      // the previous watermark, which is what breaks the re-scroll loop. Guard against going
      // backwards if a partial scan somehow reached older than the last checkpoint.
      const priorFresh = this.store.setting<string | undefined>(`fresh:${snapshot.platform}`, undefined);
      const advanceTo = snapshot.complete ? snapshot.fetchedAt
        : [snapshot.watermark!, priorFresh].filter((v): v is string => Boolean(v)).sort().at(-1)!;
      this.store.setSetting(`fresh:${snapshot.platform}`, advanceTo);
      // Newest collected post vs. baseline: if newest <= baseline, the scrape isn't seeing anything
      // newer than the watermark (either nothing new was posted, or the collector missed it).
      const newest = sorted.length ? sorted[sorted.length - 1]!.createdAt : '(none)';
      this.store.event('info', `${snapshot.platform}: ${added} new records from ${snapshot.posts.length} collected${baselineAt ? '' : ' (baseline only)'}; newest=${newest} baseline=${baselineAt ?? snapshot.fetchedAt}${snapshot.warnings.length ? ` — ${snapshot.warnings.join('; ')}` : ''}`);
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
    // Deterministic anti-echo: the owner told us (via the reminder's "要發" flow) that this exact X
    // post is their manual copy of a downstream post, so never sync it back.
    if (this.store.mirrorMatchesXId(post.id)) { this.store.addPost(post, 'ignored', 'manual_mirror_registered', now); return; }
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

  registerManualMirror(aggregateId: string, xId: string, now = new Date().toISOString()): { alreadyDelivered: boolean } {
    if (!/^[1-9]\d{0,24}$/.test(xId)) throw new Error('Invalid X post ID');
    const source = this.store.postByKey(aggregateId);
    if (!source || source.post.platform === 'x') throw new Error('Native reminder source not found');
    const existing = this.store.getPost('x', xId);
    if (existing && existing.post.replyToId !== null) throw new Error('Please register the X thread root, not a reply');
    const batchId = existing?.batchId ?? `x:${xId}`;
    const jobs = this.store.jobsForAggregate(batchId);
    const alreadyDelivered = jobs.some(job => ['running', 'succeeded', 'unknown'].includes(job.state) || this.store.hasDeliveryEvidence(job.id));
    this.store.transaction(() => {
      this.store.addMirror(source.post, now);
      this.store.matchMirror(`mirror:${aggregateId}`, xId);
      if (this.store.getBatch(batchId)) {
        this.store.updateBatch(batchId, 'mirror', 'manual_mirror_registered');
        for (const member of this.store.batchPosts(batchId)) this.store.updatePost(member.key, 'manual_mirror', 'manual_mirror_registered');
      }
      for (const job of jobs) {
        if (['pending', 'failed', 'review'].includes(job.state)) this.store.updateJob(job.id, 'cancelled', 'manual_mirror_registered');
      }
      if (existing) this.store.updatePost(existing.key, 'manual_mirror', 'manual_mirror_registered');
      this.store.event(alreadyDelivered ? 'error' : 'info', alreadyDelivered
        ? 'Manual mirror registered after delivery started; inspect remote posts, no automatic deletion was attempted'
        : 'Manual X mirror registered; pending echo deliveries cancelled', aggregateId);
    });
    return { alreadyDelivered };
  }

  action(action: 'skip' | 'mirror' | 'approve' | 'retry' | 'reconcile', id: string, now = new Date().toISOString()): void {
    // Callers include a web endpoint whose body is untrusted and whose TS types are erased at
    // runtime; validate here so no caller can drive a state change with an unexpected verb or id.
    if (!['skip', 'mirror', 'approve', 'retry', 'reconcile'].includes(action)) throw new Error('action must be one of skip|mirror|approve|retry|reconcile');
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw new Error('id must be a plain identifier');
    if (action === 'retry') {
      const job = this.store.getJob(id);
      if (!job || !['failed', 'review'].includes(job.state)) throw new Error('Only explicitly failed/review jobs can retry; unknown deliveries require reconciliation');
      this.store.updateJob(id, 'pending', undefined, now); return;
    }
    if (action === 'reconcile') {
      // The owner has inspected the remote and confirmed the uncertain delivery left no usable post.
      // Discard only the unconfirmed (started) steps — succeeded parts keep their receipts and are not
      // resent — then re-queue so the worker re-runs just the unconfirmed parts. This is the deliberate
      // manual escape hatch for `unknown` jobs, which are never auto-retried to avoid duplicate posts.
      const job = this.store.getJob(id);
      if (!job || job.state !== 'unknown') throw new Error('Only unknown deliveries can be reconciled; use retry for failed jobs');
      this.store.transaction(() => {
        this.store.discardStartedSteps(id);
        this.store.updateJob(id, 'pending', undefined, now);
        this.store.event('warn', 'Owner reconciled an unknown delivery; unconfirmed parts will be re-sent', id);
      });
      return;
    }
    const batch = this.store.getBatch(id);
    if (!batch) throw new Error('Batch not found');
    const jobs = this.store.jobsForAggregate(id);
    if (jobs.some(j => ['running', 'succeeded', 'unknown'].includes(j.state) || this.store.hasDeliveryEvidence(j.id))) throw new Error('Already delivered/in-flight batch cannot be rewritten; inspect remote posts first');
    if (action === 'approve') {
      if (!['open', 'review', 'sealed'].includes(batch.state)) throw new Error('Only open/review/sealed batches can be approved');
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

  /**
   * The downstream mirror candidates a held X batch might be a manual copy of, within the search
   * window. Their ids double as the "mirror codes" the notice shows: the owner replies with a code
   * plus the matching downstream URL to confirm the manual mirror. Only genuine, unexpired
   * candidates are listed so a code always resolves to a real downstream post.
   */
  mirrorCandidates(now = new Date().toISOString()): Array<{ id: string; platform: SourcePost['platform']; postId: string }> {
    return this.store.mirrors(now)
      .filter(candidate => !candidate.expired && candidate.state === 'pending')
      .map(candidate => ({ id: candidate.id, platform: candidate.post.platform, postId: candidate.post.id }));
  }

  /**
   * Build the interactive Telegram notice for a held X batch: what it is, the X root link, the
   * suspected-mirror reason, and the downstream mirror codes to reply with. Kept as a string so the
   * worker delivers it through the same durable step as any other Telegram part.
   */
  reviewNoticeText(batch: Batch, now = new Date().toISOString()): string {
    const posts = this.store.batchPosts(batch.id).map(p => p.post);
    const root = posts[0];
    const url = root ? fixupUrl(root.url || `https://x.com/${root.authorId}/status/${root.id}`) : undefined;
    const excerpt = root ? Array.from(cleanXLinks(root.text)).slice(0, 100).join('') : '';
    const candidates = this.mirrorCandidates(now);
    const lines = [
      '🕵️ 有一則 X 內容需要你決定是否同步到其他平台。',
      `原因：${batch.reason}`,
      url ? `X 原文：${url}` : `批次：${batch.id}`,
      excerpt ? `摘要：${htmlEscape(excerpt)}` : '',
      '',
      '• 按「發送到其他平台」＝這是新內容，立刻同步到下游。',
      '• 按「略過」＝不要同步這則。',
      '• 按「這是我手動鏡像的」後，回覆本則訊息並附上「鏡像代碼 + 對應平台貼文連結」，即可登記為手動鏡像、阻止反向同步。',
    ];
    if (candidates.length) {
      lines.push('', '可用的鏡像代碼（點一下即可複製，回覆時貼上代碼與該平台的貼文連結，順序不限）：');
      for (const candidate of candidates) lines.push(`${candidate.platform}：<code>${htmlEscape(candidate.id)}</code>`);
    } else {
      lines.push('', '（目前沒有待認領的下游貼文；若確定是手動鏡像，仍可回覆代碼與連結，或用網頁後台處理。）');
    }
    return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
  }

  async parts(job: Job): Promise<PublishPart[]> {
    if (job.kind === 'ops') {
      const batch = this.store.getBatch(job.aggregateId);
      if (!batch) throw new Error('Job source not found');
      return [{
        key: 'notice', sourcePostId: batch.rootId, text: this.reviewNoticeText(batch),
        images: [], buttons: [
          { text: '✅ 發送到其他平台', data: `rev:a:${batch.id}` },
          { text: '🚫 略過', data: `rev:s:${batch.id}` },
          { text: '🪞 這是我手動鏡像的', data: `rev:m:${batch.id}` },
        ],
      }];
    }
    const batch = job.kind === 'publish' ? this.store.getBatch(job.aggregateId) : undefined;
    const members = job.kind === 'publish' ? this.store.batchPosts(job.aggregateId).map(p => p.post) : [this.store.postByKey(job.aggregateId)?.post].filter((p): p is SourcePost => Boolean(p));
    if (!members.length) throw new Error('Job source not found');
    const output: PublishPart[] = [];
    if (job.kind === 'reminder') output.push({
      key: 'notice', sourcePostId: members[0]!.id,
      text: `🔔 你在 ${members[0]!.platform} 發了新內容。要不要也發到 X？\n下方是可直接複製的內容。請選擇：`,
      images: [], buttons: [{ text: '1️⃣ 要發', data: 'rem:y' }, { text: '2️⃣ 不發', data: 'rem:n' }],
    });
    for (const post of members) {
      const unsupported = unsupportedReason(post);
      if (unsupported) throw new Error(unsupported);
      const images = await prepareImages(post.attachments, this.config, this.transport);
      let text = cleanXLinks(post.text);
      if (post.quoteUrl) text += `\n引用：${fixupUrl(post.quoteUrl) || post.quoteUrl}`;
      const sourceUrl = post.platform === 'x' ? fixupUrl(post.url || `https://x.com/${post.authorId}/status/${post.id}`) : undefined;
      const key = createHash('sha256').update(post.id).digest('hex').slice(0, 16);
      if (job.destination === 'telegram') {
        // A tweet's images belong to ONE post, so send them as a single album (sendMediaGroup)
        // with the whole caption on the first photo — not one message per image, which stranded
        // every image after the first with an empty caption and a repeated footer link. Telegram
        // counts rendered HTML and caps an album caption at 1024, a text message at 4096, so the
        // caption chunk fits the album and any overflow continues as plain follow-up messages.
        const chunks = splitHtml(text, images.length ? 1024 : 4096, sourceUrl ? 120 : 0);
        const caption = chunks[0] ?? '';
        output.push({ key: `${key}:0`, sourcePostId: post.id, text: caption, images, sourceUrl });
        for (let i = 1; i < chunks.length; i++) {
          output.push({ key: `${key}:${i}`, sourcePostId: post.id, text: chunks[i]!, images: [], sourceUrl });
        }
      } else {
        // Sharkey renders MFM, so instead of a trailing reply carrying the X link (Bluesky's footer),
        // an X-sourced note gets the configured attribution appended to its own body — a blank line then
        // the signature, with `{url}` resolved to this post's source link. An empty signature disables it.
        const signature = job.destination === 'sharkey' && sourceUrl && this.config.sharkey.signature
          ? this.config.sharkey.signature.replaceAll('{url}', sourceUrl) : '';
        // Reserve room for the signature (plus the blank line) inside the note limit so the last chunk still fits.
        const utf16 = signature ? Math.max(1, 3000 - signature.length - 2) : 3000;
        const chunks = splitText(text, job.destination === 'bluesky' ? { graphemes: 300, utf8Bytes: 3000 } : { utf16 });
        chunks.forEach((chunk, index) => {
          const body = signature && index === chunks.length - 1 ? `${chunk}\n\n${signature}` : chunk;
          output.push({ key: `${key}:${index}`, sourcePostId: post.id, text: body, images: index === 0 ? images : [], sourceUrl });
        });
      }
    }
    if (batch?.platform === 'x' && job.destination !== 'telegram' && job.destination !== 'sharkey') {
      const root = members[0]!;
      const url = fixupUrl(root.url || `https://x.com/${root.authorId}/status/${root.id}`);
      if (!url) throw new Error('X root URL invalid');
      output.push({ key: 'footer', sourcePostId: batch.rootId, text: `🔗 X 原推文：${url}`, images: [], sourceUrl: url, isFooter: true });
    }
    return output;
  }
}

export class Worker {
  private stopping = false;
  private active?: Promise<number>;
  constructor(readonly engine: Engine, readonly publishers: Map<Destination, Publisher>) {}
  stop(): void { this.stopping = true; }
  run(now = new Date().toISOString()): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.active) return this.active;
    this.active = this.deliver(now).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async deliver(now: string): Promise<number> {
    const { store } = this.engine;
    // Which publishers exist is decided when the runtime is built: preview mode wires stub
    // publishers, live mode wires real clients. The worker itself never invents a remote call.
    if (store.setting('paused', false)) return 0;
    let count = 0;
    for (const job of store.dueJobs(now)) {
      if (this.stopping) break;
      if (job.kind === 'publish' && this.engine.config.mode === 'live' && store.db.prepare("SELECT 1 FROM steps WHERE job_id=? AND result LIKE '%preview:%' LIMIT 1").get(job.id)) {
        store.updateJob(job.id, 'review', 'Preview receipts cannot be used for live replies; use a separate live DATA_DIR');
        continue;
      }
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
        let interrupted = false;
        for (const part of parts) {
          if (this.stopping) { store.updateJob(job.id, 'pending', undefined, now); interrupted = true; break; }
          if (job.kind === 'publish' && store.getBatch(job.aggregateId)?.state !== 'sealed') {
            store.updateJob(job.id, 'cancelled', 'Batch no longer approved for publication'); interrupted = true; break;
          }
          if (job.kind === 'reminder') {
            const notice = store.getStep(job.id, 'notice')?.result;
            if (notice?.chatId && notice.messageIds?.[0] && store.getReminder(notice.messageIds[0], notice.chatId)?.state === 'declined') {
              store.updateJob(job.id, 'cancelled', 'Owner declined X reminder'); interrupted = true; break;
            }
          }
          activeKey = part.key;
          const prior = store.getStep(job.id, part.key);
          if (prior?.state === 'succeeded' && prior.result) {
            if (part.key === 'notice' && prior.result.chatId && prior.result.messageIds?.[0]) {
              store.armReminder(prior.result.messageIds[0], prior.result.chatId, job.aggregateId, `mirror:${job.aggregateId}`, now);
            } else {
              parent = prior.result; root ??= prior.result;
            }
            continue;
          }
          if (prior?.state === 'started') throw Object.assign(new Error('Uncertain previous remote delivery; reconciliation required'), { uncertain: true });
          store.beginStep(job.id, part.key, { text: part.text, sourcePostId: part.sourcePostId, imageHashes: part.images.map(i => i.sha256) }, now);
          const ref = await publisher.publish(part, {
            root: part.key === 'notice' ? undefined : root,
            parent: part.key === 'notice' ? undefined : parent,
            audience: job.kind === 'reminder' ? 'private' : 'public', idempotencyKey: `${job.id}:${part.key}`,
          });
          store.transaction(() => {
            store.finishStep(job.id, part.key, ref);
            if (part.key === 'notice' && job.kind === 'reminder' && ref.chatId && ref.messageIds?.[0]) {
              store.armReminder(ref.messageIds[0], ref.chatId, job.aggregateId, `mirror:${job.aggregateId}`, now);
            }
          });
          if (part.key !== 'notice') { parent = ref; root ??= ref; }
        }
        if (interrupted) continue;
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

export async function collectCycle(engine: Engine, collectors: Collector[], now?: string, signal?: AbortSignal): Promise<void> {
  const sorted = [...collectors].sort((a, b) => Number(a.platform === 'x') - Number(b.platform === 'x'));
  for (const collector of sorted) {
    // A shutdown between collectors ends the cycle rather than starting the next (heavy) scan.
    if (signal?.aborted) break;
    // Pass the last successful fetch watermark so the collector pages back only as far as needed
    // and can tell whether it closed the whole gap since the previous scan.
    const since = engine.store.setting<string | undefined>(`fresh:${collector.platform}`, undefined);
    try {
      engine.ingest(await collector.collect(since, signal), now);
      if (collector.platform === 'x') engine.store.setSetting('x:session_state', 'authenticated');
    } catch (error) {
      if (collector.platform === 'x') engine.store.setSetting('x:session_state', 'error');
      engine.store.event('error', `${collector.platform} collection failed: ${safeError(error)}`);
    }
  }
}
