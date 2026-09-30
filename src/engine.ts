import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import twitterText from 'twitter-text';
import type { AppConfig } from './config.js';
import { Store, MIRROR_PENDING_MS } from './store.js';
import { BLUESKY_SENSITIVE_LABELS, contentWarning, isSensitiveContent, warningPrefix } from './content-warning.js';
import { cleanXLinks, fixupUrl, graphemes, htmlEscape, normalizeText, similarity, splitText } from './text.js';
import { prepareImages } from './media.js';
import { prepareVideo, MAX_VIDEO_SECONDS } from './video.js';
import { formatXPoll, nativePollPayload, pollSnapshotSchema, xPollUrl } from './poll.js';
import { renderXMentions, sliceMentions, validTextMentions, type MentionText } from './mentions.js';
import { describe } from './labels.js';
import { resolveBlueskyMentions } from './platforms/bluesky.js';
import type { Attachment, Batch, Collector, Destination, Job, PublishPart, Publisher, RemoteRef, SourcePost, SourceSnapshot, TextRange, Transport } from './types.js';

// Media locations cross a trust boundary here: the /api/schedule body is untrusted, and collector
// output is re-validated on the way in. zod's `.url()` accepts ANY scheme, so `javascript:` and
// `file:` used to be stored and only rejected mid-publish by the transport — as a failed job with a
// confusing message instead of a clean rejection. The loaders remain the authoritative check; these
// two just stop the bad value from entering the database at all.
const mediaUrl = z.string().url().refine(value => /^https?:\/\//i.test(value), 'Media URLs must be http(s)');
const mediaPath = z.string().refine(value => !value.split(/[\\/]/).includes('..'), 'Media paths must not traverse');
const attachmentSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'unknown']), url: mediaUrl.optional(), path: mediaPath.optional(),
  mimeType: z.string().optional(), alt: z.string().default(''), sha256: z.string().optional(),
  width: z.number().positive().optional(), height: z.number().positive().optional(), size: z.number().nonnegative().optional(),
  animated: z.boolean().optional(), durationSeconds: z.number().positive().optional(),
});
export const sourcePostSchema = z.object({
  platform: z.enum(['x', 'bluesky', 'sharkey', 'local']), id: z.string().min(1), authorId: z.string().min(1),
  createdAt: z.string().datetime(), text: z.string().max(100_000), url: z.string().url().optional(), rootId: z.string().optional(),
  mentions: z.array(z.object({ handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })).max(1000).optional(),
  replyToId: z.string().nullable().optional(), replyToAuthorId: z.string().nullable().optional(), relationKnown: z.boolean(),
  visibility: z.enum(['public', 'restricted', 'unknown']), repost: z.boolean().optional(), quoteUrl: mediaUrl.optional(), poll: z.boolean().optional(),
  pollData: pollSnapshotSchema.optional(),
  cw: z.string().optional(), sensitive: z.boolean().optional(), sensitiveLabels: z.array(z.enum(BLUESKY_SENSITIVE_LABELS)).max(4).optional(),
  attachments: z.array(attachmentSchema).max(100), metadataComplete: z.boolean(),
}).refine(post => !post.mentions?.length || (post.platform === 'x' && validTextMentions(post.text, post.mentions)), 'Invalid source mention ranges');
export const snapshotSchema = z.object({
  platform: z.enum(['x', 'bluesky', 'sharkey']), accountId: z.string().min(1), posts: z.array(sourcePostSchema).max(1000),
  fetchedAt: z.string().datetime(), complete: z.boolean(), watermark: z.string().datetime().optional(), warnings: z.array(z.string()),
});

// After this many consecutive failed collections, a downstream mirror source's seal-freshness gate is
// downgraded from "seen within sourceFreshnessSeconds" to "ever seen", so a temporarily unreachable
// downstream cannot block X→downstream publishing indefinitely. Never applied to X itself.
const DEGRADE_SEAL_FRESHNESS_AFTER_FAILURES = 3;
// A batch still unsealed this long after its settle time is stuck rather than catching up; say so once.
const SEAL_STUCK_ALERT_MS = 30 * 60_000;

// A text-only mirror match is only conclusive when the text is distinctive. A short generic phrase that
// happens to equal a recent downstream post ("早安") is far more likely to be a coincidence than a
// manual copy, and a wrong automatic match silently drops a post the owner meant to sync — so a shorter
// match is routed to review, where the owner confirms or rejects it, instead of being auto-suppressed.
//
// Measured in UTF-8 BYTES, not code units. Code units are a Latin-only proxy for "how much is actually
// being said": a CJK character costs 3 bytes but carries roughly a whole word, so a 20-code-unit floor
// made essentially every Chinese post "too short" — including ones as specific as
// 「這部電影真的很好看，推薦大家去看」 — and sent all of them to review. Bytes put the two scripts on
// comparable footing: 「早安」 is 6 and still asks, while that sentence is 48 and matches outright.
const MIRROR_MATCH_MIN_TEXT_BYTES = 20;

// X's own post limit, measured the way X measures it: every URL counts as 23 characters (the t.co
// length) and CJK counts double. The collector expands t.co links to their real destinations before a
// post reaches the engine, so counting raw characters would flag a normal tweet as over-limit purely
// because a link inside it was expanded.
const X_WEIGHTED_LIMIT = 280;
// The tightest single-post limit among the destinations (Bluesky's 300 graphemes / 3000 UTF-8 bytes),
// the same budget `parts()` splits with. A body that fits this fits Sharkey and Telegram too, so it
// publishes as ONE post everywhere and there is nothing for the owner to review.
const SINGLE_PART_LIMIT = { graphemes: 300, utf8Bytes: 3000 } as const;

/** True when X itself counts the post as beyond a normal post (i.e. a Premium/long post). */
export function exceedsXLimit(text: string): boolean {
  return twitterText.parseTweet(text).weightedLength > X_WEIGHTED_LIMIT;
}

/** True when publishing this body would split it into more than one downstream post. */
function requiresSplit(text: string): boolean {
  try { return splitText(text, SINGLE_PART_LIMIT).length > 1; }
  // A body that cannot be split at all (e.g. a single URL longer than the whole budget) also cannot
  // go out as one post, so it needs the same manual review.
  catch { return true; }
}

/**
 * The content holds a manual approve can still publish. Only the long-post hold qualifies: there the
 * content itself is fully supported — text the publishers accept and media they can carry — and only
 * its length needs a human decision, because publishing splits it into as many posts as it takes.
 * Every other reason describes content that cannot be published at all, so approving it would either
 * drop part of the post silently or fail the delivery job.
 */
export function holdIsApprovable(reason: string | undefined): boolean {
  return reason === 'long_x_post_requires_manual_review';
}

export function unsupportedReason(post: SourcePost, videoEnabled = false): string | undefined {
  if (!post.metadataComplete) return 'incomplete_metadata';
  if (post.visibility !== 'public') return 'non_public_content';
  // Warnings are carried by publishers; they do not make otherwise supported public content unpublishable.
  if (post.poll || post.pollData !== undefined) {
    if (post.platform !== 'x') return 'poll_not_supported';
    if (!pollSnapshotSchema.safeParse(post.pollData).success) return 'poll_details_unavailable';
    if (!xPollUrl(post)) return 'poll_source_url_invalid';
  }
  if (post.attachments.length > 4) return 'more_than_four_images';
  const video = post.attachments.find(a => a.kind === 'video');
  if (video) {
    // A single video only, never mixed with images, and only when the operator opted in. An X video is
    // an HLS stream behind a blob: URL, so the collector resolves a progressive MP4 through the public
    // syndication endpoint; when that yields nothing the attachment arrives with neither url nor path
    // and the post is held with a clear reason instead of being force-published text-only.
    if (!videoEnabled) return 'video_sync_disabled';
    if (post.attachments.length > 1) return 'video_must_be_the_only_attachment';
    // An X animated GIF also renders as a <video>; this project publishes no animations, so holding it
    // here keeps it from being silently transcoded into one.
    if (video.animated) return 'animated_video_not_supported';
    // Reject an over-length source before spending the download budget on it. prepareVideo enforces the
    // same ceiling, but only once the bytes are already on disk.
    if (video.durationSeconds !== undefined && video.durationSeconds > MAX_VIDEO_SECONDS) return 'video_exceeds_duration_limit';
    if (!video.url && !video.path) return 'x_video_has_no_downloadable_source';
  } else if (post.attachments.some(a => a.kind !== 'image' || a.animated)) {
    return 'only_static_images_or_video';
  }
  // Hold a long post only when BOTH hold: X itself counted it as beyond a normal post, and publishing
  // it would really be split into several downstream posts. Either condition alone over-holds — a short
  // tweet whose t.co link expanded into a long URL is not a long post, and a non-Latin post that X
  // weighs past 280 may still fit a single downstream post, leaving nothing to review.
  if (post.platform === 'x' && exceedsXLimit(post.text) && requiresSplit(post.text)) return 'long_x_post_requires_manual_review';
  if (!post.text.trim() && !post.attachments.length && !post.pollData) return 'empty_content';
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
    // A repeated question is not proof of the same poll. The native collectors do not retain poll
    // choices, so only an explicit owner link can conclusively identify these manual mirrors.
    const hasPoll = posts.some(post => post.poll || post.pollData) || candidate.post.poll || candidate.post.pollData;
    // Text alone is only evidence when it is distinctive; a media fingerprint is evidence on its own.
    // A short text match leaves `evidence` false, which drops it into the `possible` check below and so
    // reaches the owner as a review notice rather than being suppressed without a word.
    const evidence = (Boolean(expected) && Buffer.byteLength(expected, 'utf8') >= MIRROR_MATCH_MIN_TEXT_BYTES)
      || (media.length > 0 && mediaMatch === 'same');
    if (textEqual && mediaMatch === 'same' && evidence && !candidate.expired && !hasPoll) { exact.push(candidate.id); continue; }
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

  ingest(value: unknown, now: string = new Date().toISOString()): { added: number; baseline: boolean } {
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
          // A baseline snapshot is history we deliberately never backfill, and it arrives with the
          // account's whole recent feed (up to 300 notes per platform). Registering ALL of it as pending
          // mirrors made anti-echo compare every new X post against months of the owner's own older
          // downstream copies — so almost any short post resembled something and was parked in
          // mirror_review. A pending mirror means "the owner may still be copying this to X by hand",
          // which only a post inside that window can be; older history is not evidence of anything.
          if (post.platform !== 'x' && post.replyToId === null && !post.repost && !post.quoteUrl && post.visibility === 'public'
            && Date.parse(now) - Date.parse(post.createdAt) < MIRROR_PENDING_MS) this.store.addMirror(post, now);
          continue;
        }
        if (Date.parse(post.createdAt) > Date.parse(snapshot.fetchedAt) + 60_000) {
          this.parkWithoutBatch(post, 'source_clock_invalid', now); added++; continue;
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
    const unsupported = unsupportedReason(post, this.config.media.video);
    const key = Store.postKey(post.platform, post.id);
    this.store.addPost(post, unsupported ? 'unsupported' : 'ready', unsupported || 'manual_x_reminder', now);
    this.store.addMirror(post, now);
    if (unsupported) { this.store.event('warn', `Native post held: ${unsupported}`, key); return; }
    // The reminder is only a notification; the post itself is already recorded as ready for a manual X
    // post, so with no carrier for the notice there is nothing worth queueing.
    if (this.canNotifyOwner()) this.store.enqueue('reminder', key, 'telegram', now);
  }

  /**
   * Park a post that needs the owner's decision but has no batch to hang an interactive notice on.
   * `mirror_review` raises no notice by itself and `notifyHeldBatch` needs a batch id, so without this
   * the post surfaces only in the Web UI's post list — the "it sat there and nobody told me" case.
   * Recorded at `error` level because that is the only level the Telegram forwarder picks up, and the
   * whole point is that this must not wait for the owner to go looking.
   */
  private parkWithoutBatch(post: SourcePost, reason: string, now: string): void {
    this.store.addPost(post, 'mirror_review', reason, now);
    this.store.event('error', `${post.platform} post ${post.id} is held for your decision (${reason}) and has no batch to attach a notice to; it will not sync until you handle it`, Store.postKey(post.platform, post.id));
  }

  private ingestX(post: SourcePost, now: string): void {
    if (post.repost || post.visibility !== 'public') { this.store.addPost(post, 'ignored', 'repost_or_non_public', now); return; }
    if (!post.relationKnown || post.replyToId === undefined) { this.parkWithoutBatch(post, 'reply_relationship_unknown', now); return; }
    // Deterministic anti-echo: the owner told us (via the reminder's "要發" flow) that this exact X
    // post is their manual copy of a downstream post, so never sync it back.
    if (this.store.mirrorMatchesXId(post.id)) { this.store.addPost(post, 'ignored', 'manual_mirror_registered', now); return; }
    if (post.replyToId === null) {
      const id = `x:${post.id}`;
      const unsupported = unsupportedReason(post, this.config.media.video);
      this.store.addBatch({ id, platform: 'x', rootId: post.id, rootCreatedAt: post.createdAt,
        cutoffAt: new Date(Date.parse(post.createdAt) + this.config.threadWindowSeconds * 1000).toISOString(),
        settleAt: new Date(Math.max(Date.parse(post.createdAt) + this.config.threadWindowSeconds * 1000, Date.parse(now)) + this.config.settleSeconds * 1000).toISOString(),
        state: unsupported ? 'review' : 'open', reason: unsupported || 'collecting_initial_thread' });
      this.store.addPost(post, unsupported ? 'unsupported' : 'collecting', unsupported || 'root', now, id);
      if (unsupported) this.notifyHeldBatch(id, now);
      return;
    }
    if (!post.replyToAuthorId || post.replyToAuthorId.toLowerCase() !== post.authorId.toLowerCase()) {
      // Replying to somebody else never syncs and is not a decision, so it stays silent. A parent whose
      // author we could not read is different: it may well be your own thread, so it needs you.
      if (post.replyToAuthorId) this.store.addPost(post, 'ignored', 'reply_to_other', now);
      else this.parkWithoutBatch(post, 'parent_author_unknown', now);
      return;
    }
    const parent = this.store.getPost('x', post.replyToId);
    const batch = parent?.batchId ? this.store.getBatch(parent.batchId) : undefined;
    if (!batch || !parent) {
      this.store.addPost(post, 'ignored', 'self_reply_outside_new_batch', now);
      // A parent we DID collect and deliberately left unbatched (a baseline post, or a thread already
      // synced) is a decision, so it needs no notice. A parent we never collected at all is a coverage
      // gap that would otherwise drop this reply without a word, so say so once — `warn` rather than
      // `error` because there is nothing to action beyond posting it manually or scanning more often.
      if (!parent) this.store.event('warn', `X self-reply ${post.id} continues ${post.replyToId}, which was never collected; not synced (raise X_MAX_PAGES or scan more often)`, Store.postKey('x', post.id));
      return;
    }
    if (batch.state !== 'open' || post.createdAt > batch.cutoffAt || post.createdAt < parent.post.createdAt) {
      this.store.addPost(post, 'ignored', 'skipped_late_self_reply', now);
      // This is a self-reply the owner wrote that will never sync, and nothing else reports it: the
      // classification is `ignored`, so it raises no notice and shows up nowhere the owner looks. The
      // usual cause is a THREAD_WINDOW_SECONDS shorter than it actually takes to type the next tweet,
      // which silently truncates every thread — so name the window and the overshoot, not just the fact.
      const late = Math.round((Date.parse(post.createdAt) - Date.parse(batch.cutoffAt)) / 1000);
      this.store.event('warn', late > 0
        ? `X self-reply ${post.id} came ${late}s after its thread window closed (THREAD_WINDOW_SECONDS=${this.config.threadWindowSeconds}); not synced, and the rest of the thread will be dropped too`
        : `X self-reply ${post.id} could not join batch ${batch.id} (state ${batch.state}); not synced`,
        Store.postKey('x', post.id));
      return;
    }
    const members = this.store.batchPosts(batch.id);
    const tail = members.at(-1)?.post;
    if (tail?.id !== post.replyToId) {
      this.store.addPost(post, 'mirror_review', 'branch_in_thread', now, batch.id);
      this.store.updateBatch(batch.id, 'review', 'thread_is_not_linear');
      this.notifyHeldBatch(batch.id, now);
      return;
    }
    const unsupported = unsupportedReason(post, this.config.media.video);
    this.store.addPost(post, unsupported ? 'unsupported' : 'collecting', unsupported || 'initial_self_thread', now, batch.id);
    if (unsupported) { this.store.updateBatch(batch.id, 'review', unsupported); this.notifyHeldBatch(batch.id, now); }
  }

  /** The content reason that keeps this batch out of the automatic publish path, if any. */
  holdReason(posts: SourcePost[]): string | undefined {
    return posts.map(p => unsupportedReason(p, this.config.media.video)).find(Boolean);
  }

  /**
   * Whether a reminder/ops notice actually has a carrier. Those jobs exist only to notify the owner
   * over Telegram, so this mirrors what createRuntime wires: in live mode a real client (enabled with a
   * token), in preview mode the stub publisher for any configured destination. Without a carrier the
   * job could only ever fail, leaving a failed job and an error event behind for every native post —
   * noise with nothing the owner could act on — so it is never enqueued.
   */
  private canNotifyOwner(): boolean {
    return this.config.mode === 'live'
      ? this.config.telegram.enabled && Boolean(this.config.telegram.token)
      : this.config.destinations.includes('telegram');
  }

  /**
   * Announce a batch the engine parked in `review` on purpose, as one interactive Telegram notice.
   * `sealReady` only walks `open` batches, so a batch that went to `review` at ingest time would
   * otherwise never be reported: the owner would have to stumble on it in /pending or the Web UI while
   * the content silently never synced. `hasReviewNotice` keeps a batch from being announced twice.
   */
  private notifyHeldBatch(batchId: string, now: string): void {
    if (!this.canNotifyOwner() || this.store.hasReviewNotice(batchId)) return;
    this.store.enqueue('ops', batchId, 'telegram', now);
  }

  /**
   * `cycleStart` is when the collect cycle that just ran began. Freshness is measured from there, not
   * from `now`: a source scanned in this cycle is as current as it can be, however long the scans took.
   * Measuring from `now` made a slow X scan (minutes in a real browser) age every source past
   * SOURCE_FRESHNESS_SECONDS by the time the cycle ended, so nothing ever sealed.
   */
  sealReady(now: string = new Date().toISOString(), cycleStart: string = now): number {
    if (this.store.setting('paused', false)) return 0;
    let count = 0;
    for (const batch of this.store.openBatches()) {
      if (batch.settleAt > now) continue;
      const sources: Array<'x' | 'bluesky' | 'sharkey'> = batch.platform === 'x' ? ['x'] : [];
      if (this.config.destinations.includes('bluesky')) sources.push('bluesky');
      if (this.config.destinations.includes('sharkey')) sources.push('sharkey');
      const degradedStale: string[] = [];
      const blocker = sources.find(source => {
        const fresh = this.store.setting<string>(`fresh:${source}`, '');
        if (!fresh) return true;                                    // never observed at all — always blocks
        const stale = Date.parse(cycleStart) - Date.parse(fresh) > this.config.sourceFreshnessSeconds * 1000;
        // X freshness is never relaxed: without a current scan of the source itself we cannot know the
        // thread, so a stale or pre-cutoff X watermark always blocks.
        if (source === 'x') return stale || fresh < batch.cutoffAt;
        if (!stale) return false;
        // A downstream that has repeatedly failed to collect has its freshness downgraded from "seen
        // recently" to "ever seen": a temporarily unreachable mirror source (e.g. a Cloudflare 522 on
        // Sharkey, which is both a destination and a collected source) must not block X→downstream sync
        // forever. Anti-echo still runs against the last observed mirror data; the counter resets to 0
        // on the next successful collect, restoring the strict freshness gate.
        if (this.store.setting<number>(`collect_failures:${source}`, 0) >= DEGRADE_SEAL_FRESHNESS_AFTER_FAILURES) { degradedStale.push(source); return false; }
        return true;
      });
      if (blocker) {
        // Waiting on a scan is normal and silent, but a batch still blocked long after it should have
        // sealed sits in `open`, which raises no notice — the owner only found these in the Web UI.
        // `error` is the level the Telegram forwarder picks up.
        const alerted = `seal_stuck:${batch.id}`;
        if (Date.parse(now) - Date.parse(batch.settleAt) > SEAL_STUCK_ALERT_MS && !this.store.setting(alerted, false)) {
          this.store.setSetting(alerted, true);
          this.store.event('error', `${batch.id} is still unpublished ${Math.round((Date.parse(now) - Date.parse(batch.settleAt)) / 60_000)} min after it should have sealed: no fresh enough ${blocker} scan (last ${this.store.setting<string>(`fresh:${blocker}`, '') || 'never'}, SOURCE_FRESHNESS_SECONDS=${this.config.sourceFreshnessSeconds}). Send /approve ${batch.id} to publish it now`, batch.id);
        }
        continue;
      }
      if (degradedStale.length) this.store.event('warn', `Sealing ${batch.id} with stale downstream mirror data (${degradedStale.join(', ')} unreachable); manual-mirror detection may be incomplete`, batch.id);
      const posts = this.store.batchPosts(batch.id).map(p => p.post);
      const mirror = batch.platform === 'x' ? decideMirror(posts, this.store.mirrors(now)) : { state: 'none', reason: 'local_schedule' } as MirrorDecision;
      this.store.transaction(() => {
        if (mirror.state !== 'none') {
          this.store.updateBatch(batch.id, mirror.state === 'match' ? 'mirror' : 'review', mirror.reason);
          for (const post of posts) this.store.updatePost(Store.postKey(post.platform, post.id), mirror.state === 'match' ? 'manual_mirror' : 'mirror_review', mirror.reason);
          if (mirror.mirrorId) this.store.matchMirror(mirror.mirrorId, batch.rootId);
          this.store.event('warn', `X batch held: ${mirror.reason}`, batch.id);
          if (mirror.state === 'review') this.notifyHeldBatch(batch.id, now);
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

  schedule(input: { text: string; attachments?: Attachment[]; dueAt: string }, now: string = new Date().toISOString()): string {
    const due = new Date(input.dueAt).toISOString();
    if (due < now) throw new Error('Schedule must be in the future');
    const post = sourcePostSchema.parse({ platform: 'local', id: randomUUID(), authorId: 'owner', text: input.text,
      createdAt: now, replyToId: null, relationKnown: true, visibility: 'public', attachments: input.attachments || [], metadataComplete: true }) as SourcePost;
    const unsupported = unsupportedReason(post, this.config.media.video);
    if (unsupported) throw new Error(unsupported);
    const id = Store.postKey('local', post.id);
    this.store.transaction(() => {
      this.store.addBatch({ id, platform: 'local', rootId: post.id, rootCreatedAt: now, cutoffAt: now, settleAt: due, state: 'sealed', reason: 'scheduled_no_x_url_yet' });
      this.store.addPost(post, 'ready', 'local_scheduled', now, id);
      this.store.addMirror(post, now);
      for (const destination of this.config.destinations) this.store.enqueue('publish', id, destination, now, due);
      // Same as a native post: the reminder exists only to notify, so it is queued only when it can reach
      // the owner. The scheduled post still publishes to every enabled destination either way.
      if (this.canNotifyOwner()) this.store.enqueue('reminder', id, 'telegram', now, due);
    });
    return id;
  }

  /** Close a batch (if it exists) as the owner's manual mirror and cancel its undelivered echo jobs. */
  private closeAsMirror(batchId: string): void {
    this.store.updateBatch(batchId, 'mirror', 'manual_mirror_registered');
    for (const member of this.store.batchPosts(batchId)) this.store.updatePost(member.key, 'manual_mirror', 'manual_mirror_registered');
    for (const job of this.store.jobsForAggregate(batchId)) {
      if (['pending', 'failed', 'review'].includes(job.state)) this.store.updateJob(job.id, 'cancelled', 'manual_mirror_registered');
    }
  }

  private hasInFlightDelivery(jobs: ReturnType<Store['jobsForAggregate']>): boolean {
    return jobs.some(job => ['running', 'succeeded', 'unknown'].includes(job.state) || this.store.hasDeliveryEvidence(job.id));
  }

  registerManualMirror(aggregateId: string, xId: string, now: string = new Date().toISOString()): { alreadyDelivered: boolean } {
    if (!/^[1-9]\d{0,24}$/.test(xId)) throw new Error('Invalid X post ID');
    const source = this.store.postByKey(aggregateId);
    if (!source || source.post.platform === 'x') throw new Error('Native reminder source not found');
    const existing = this.store.getPost('x', xId);
    if (existing && existing.post.replyToId !== null) throw new Error('Please register the X thread root, not a reply');
    const batchId = existing?.batchId ?? `x:${xId}`;
    const jobs = this.store.jobsForAggregate(batchId);
    const alreadyDelivered = this.hasInFlightDelivery(jobs);
    this.store.transaction(() => {
      this.store.addMirror(source.post, now);
      this.store.matchMirror(`mirror:${aggregateId}`, xId);
      this.closeAsMirror(batchId);
      if (existing) this.store.updatePost(existing.key, 'manual_mirror', 'manual_mirror_registered');
      this.store.event(alreadyDelivered ? 'error' : 'info', alreadyDelivered
        ? 'Manual mirror registered after delivery started; inspect remote posts, no automatic deletion was attempted'
        : 'Manual X mirror registered; pending echo deliveries cancelled', aggregateId);
    });
    return { alreadyDelivered };
  }

  action(action: 'skip' | 'mirror' | 'approve' | 'retry' | 'reconcile' | 'cancel', id: string, now: string = new Date().toISOString()): void {
    // Callers include a web endpoint whose body is untrusted and whose TS types are erased at
    // runtime; validate here so no caller can drive a state change with an unexpected verb or id.
    if (!['skip', 'mirror', 'approve', 'retry', 'reconcile', 'cancel'].includes(action)) throw new Error('action must be one of skip|mirror|approve|retry|reconcile|cancel');
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw new Error('id must be a plain identifier');
    if (action === 'retry') {
      const job = this.store.getJob(id);
      if (!job || !['failed', 'review'].includes(job.state)) throw new Error('Only explicitly failed/review jobs can retry; unknown deliveries require reconciliation');
      this.store.updateJob(id, 'pending', undefined, now); return;
    }
    if (action === 'cancel') {
      // The owner gives up on a delivery that cannot or need not happen (an expired poll, or an unknown
      // delivery the owner found already posted). Nothing is sent; the worker only ever picks pending
      // jobs, so these states are never mid-delivery. The original error stays as the record of why.
      const job = this.store.getJob(id);
      if (!job || !['failed', 'review', 'unknown'].includes(job.state)) throw new Error('Only failed/review/unknown jobs can be cancelled');
      this.store.updateJob(id, 'cancelled', job.error);
      this.store.event('info', 'Owner cancelled a job; it will not be sent or retried', id);
      return;
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
    if (this.hasInFlightDelivery(jobs)) throw new Error('Already delivered/in-flight batch cannot be rewritten; inspect remote posts first');
    if (action === 'approve') {
      if (!['open', 'review', 'sealed'].includes(batch.state)) throw new Error('Only open/review/sealed batches can be approved');
      const members = this.store.batchPosts(id);
      const held = members.map(m => unsupportedReason(m.post, this.config.media.video)).filter(Boolean);
      if (held.some(reason => !holdIsApprovable(reason))) throw new Error('Unsupported/private/incomplete content cannot be force-published');
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
  mirrorCandidates(now: string = new Date().toISOString()): Array<{ id: string; platform: SourcePost['platform']; postId: string }> {
    return this.store.mirrors(now)
      .filter(candidate => !candidate.expired)
      .map(candidate => ({ id: candidate.id, platform: candidate.post.platform, postId: candidate.post.id }));
  }

  /**
   * Confirm a held X batch as the owner's manual mirror of one or more downstream posts. The owner's
   * reply carries mirror code(s) (the candidate ids the notice listed); each valid code is linked to
   * this batch's X root so reverse sync is blocked, the batch is closed as a mirror, and any pending
   * echo jobs are cancelled. Returns how many codes matched: zero means the reply carried no usable
   * code, so the caller re-prompts instead of silently closing the batch.
   */
  confirmReviewMirror(batchId: string, replyText: string, now: string = new Date().toISOString()): { matched: number } {
    const batch = this.store.getBatch(batchId);
    if (!batch || batch.platform !== 'x') throw new Error('Review batch not found');
    if (!['review', 'open'].includes(batch.state)) throw new Error('This batch is no longer awaiting a decision');
    const codes = [...new Set((replyText.match(/mirror:[^\s]+/gu) ?? []).map(code => code.replace(/[).,!?;、，。]+$/u, '')))]
      .filter(code => this.store.getMirror(code, now));
    if (!codes.length) return { matched: 0 };
    this.store.transaction(() => {
      for (const code of codes) this.store.matchMirror(code, batch.rootId);
      this.closeAsMirror(batchId);
      this.store.event('info', `X batch confirmed as manual mirror of ${codes.length} downstream post(s); reverse sync blocked`, batchId);
    });
    return { matched: codes.length };
  }

  /**
   * Build the interactive Telegram notice for a held X batch: what it is, the X root link, the
   * suspected-mirror reason, and the downstream mirror codes to reply with. Kept as a string so the
   * worker delivers it through the same durable step as any other Telegram part.
   */
  reviewNoticeText(batch: Batch, now: string = new Date().toISOString()): string {
    const posts = this.store.batchPosts(batch.id).map(p => p.post);
    const root = posts[0];
    const url = root ? fixupUrl(root.url || `https://x.com/${root.authorId}/status/${root.id}`) : undefined;
    const excerpt = root ? Array.from(cleanXLinks(root.text)).slice(0, 100).join('') : '';
    const hold = this.holdReason(posts);
    // Plain text only: the Telegram notice path HTML-escapes the whole body before sending, so any
    // markup here would render as literal tags. Mirror codes stay copyable as plain text.
    const lines = hold ? [
      '⚠️ 這則 X 內容不會自動同步到其他平台，需要你決定。',
      `原因：${describe(hold)}`,
      url ? `X 原文：${url}` : `批次：${batch.id}`,
      excerpt ? `摘要：${excerpt}` : '',
      '',
      ...(holdIsApprovable(hold)
        ? ['• 按「仍要發送到其他平台」＝這則其實可以同步（只是較長，發布時會自動分段成一串貼文）。',
           '• 按「略過」＝不要同步這則，之後不再提醒。']
        : ['• 這種內容（投票資料不完整、不支援的媒體格式等）無法自動同步；需要的話請自行手動貼到其他平台。',
           '• 按「略過」＝關閉這則提醒。']),
    ] : [
      '🕵️ 有一則 X 內容需要你決定是否同步到其他平台。',
      `原因：${describe(batch.reason)}`,
      url ? `X 原文：${url}` : `批次：${batch.id}`,
      excerpt ? `摘要：${excerpt}` : '',
      '',
      '• 按「發送到其他平台」＝這是新內容，立刻同步到下游。',
      '• 按「略過」＝不要同步這則。',
    ];
    lines.push('• 按「這是我手動鏡像的」後，回覆本則訊息並附上「鏡像代碼 + 對應平台貼文連結」，即可登記為手動鏡像、阻止反向同步。');
    const candidates = this.mirrorCandidates(now);
    if (candidates.length) {
      lines.push('', '可用的鏡像代碼（回覆本訊息時貼上代碼與該平台的貼文連結，順序不限）：');
      for (const candidate of candidates) lines.push(`${candidate.platform}：${candidate.id}`);
    } else {
      lines.push('', '（目前沒有待認領的下游貼文；若確定是手動鏡像，仍可回覆代碼與連結，或用網頁後台處理。）');
    }
    return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
  }

  async parts(job: Job, now: string = new Date().toISOString()): Promise<PublishPart[]> {
    if (job.kind === 'ops') {
      const batch = this.store.getBatch(job.aggregateId);
      if (!batch) throw new Error('Job source not found');
      const hold = this.holdReason(this.store.batchPosts(batch.id).map(p => p.post));
      const approvable = !hold || holdIsApprovable(hold);
      return [{
        key: 'notice', sourcePostId: batch.rootId, text: this.reviewNoticeText(batch),
        images: [], buttons: [
          // Incomplete polls and unsupported media have no publish path, even with owner approval.
          ...(approvable ? [{ text: hold ? '✅ 仍要發送到其他平台' : '✅ 發送到其他平台', data: 'rev:a' }] : []),
          { text: '🚫 略過', data: 'rev:s' },
          { text: '🪞 這是我手動鏡像的', data: 'rev:m' },
        ],
      }];
    }
    const batch = job.kind === 'publish' ? this.store.getBatch(job.aggregateId) : undefined;
    const members = job.kind === 'publish' ? this.store.batchPosts(job.aggregateId).map(p => p.post) : [this.store.postByKey(job.aggregateId)?.post].filter((p): p is SourcePost => Boolean(p));
    if (!members.length) throw new Error('Job source not found');
    const planKey = `mention-plan:${job.id}`;
    let bodies = this.store.setting<MentionText[] | undefined>(planKey, undefined);
    // Pin the rewrite the first time it matters: editing a mapping between attempts must not re-split
    // text whose earlier parts may already be delivered. A job that already delivered part of itself
    // predates the pin, so it keeps the plain rendering rather than shifting under its own receipts.
    if (!bodies && job.kind === 'publish' && !this.store.hasDeliveryEvidence(job.id) && members.some(post => post.mentions?.length)) {
      const mappings = this.store.mentionMappings();
      bodies = members.map(post => renderXMentions(post, job.destination, mappings));
      if (job.destination === 'bluesky' && this.config.mode === 'live') await resolveBlueskyMentions(bodies, this.config.bluesky.publicUrl, this.transport);
      this.store.setSetting(planKey, bodies);
    }
    const output: PublishPart[] = [];
    if (job.kind === 'reminder') output.push({
      key: 'notice', sourcePostId: members[0]!.id,
      text: `🔔 你在 ${members[0]!.platform} 發了新內容。要不要也發到 X？\n下方是可直接複製的內容。請選擇：`,
      images: [], buttons: [{ text: '1️⃣ 要發', data: 'rem:y' }, { text: '2️⃣ 不發', data: 'rem:n' }],
    });
    for (const [postIndex, post] of members.entries()) {
      const unsupported = unsupportedReason(post, this.config.media.video);
      // An owner-approved long post IS published here (its body is split into parts below). Any other
      // hold means the content is not publishable at all, so fail loudly rather than send a degraded post.
      if (unsupported && !holdIsApprovable(unsupported)) throw new Error(unsupported);
      const poll = post.platform === 'x' ? post.pollData : undefined;
      const sensitive = isSensitiveContent(post);
      if (poll && job.destination !== 'bluesky') {
        if (post.attachments.length) throw new Error('A native X poll cannot be combined with media');
        if (job.destination === 'telegram' && sensitive) throw new Error('Telegram cannot hide native poll questions/options with a spoiler; sensitive polls require review');
      }
      const videoAttachment = this.config.media.video ? post.attachments.find(a => a.kind === 'video') : undefined;
      const video = videoAttachment
        ? await prepareVideo(videoAttachment, { dataDir: this.config.dataDir, maxDownloadBytes: this.config.maxDownloadBytes, ffmpegPath: this.config.media.ffmpegPath, ffprobePath: this.config.media.ffprobePath }, this.transport)
        : undefined;
      const images = video ? [] : await prepareImages(post.attachments, this.config, this.transport);
      const body = bodies?.[postIndex] ?? { text: cleanXLinks(post.text), mentions: [] };
      let text = body.text;
      const mentions = body.mentions;
      if (post.quoteUrl) text += `\n引用：${fixupUrl(post.quoteUrl) || post.quoteUrl}`;
      const sourceUrl = post.platform === 'x' ? fixupUrl(post.url || `https://x.com/${post.authorId}/status/${post.id}`) : undefined;
      if (poll) {
        const pollText = job.destination === 'bluesky' ? formatXPoll(poll, xPollUrl(post)!)
          : `🗳️ 此平台為獨立投票，票數不與 X 或其他平台合併。\n截止時間${poll.expiresAtEstimated ? '（依 X 倒數估算）' : ''}：${poll.expiresAt}\nX 原投票：${xPollUrl(post)!}`;
        text += `${text ? '\n\n' : ''}${pollText}`;
      }
      const marking = sensitive ? { sensitive: true, cw: contentWarning(post), sensitiveLabels: post.sensitiveLabels } : {};
      const prefix = warningPrefix(marking);
      const key = createHash('sha256').update(post.id).digest('hex').slice(0, 16);
      if (job.destination === 'telegram') {
        // A tweet's images belong to ONE post, so send them as a single album (sendMediaGroup)
        // with the whole caption on the first photo — not one message per image, which stranded
        // every image after the first with an empty caption and a repeated footer link. Telegram
        // counts rendered HTML and caps an album caption at 1024, a text message at 4096, so the
        // caption chunk fits the album and any overflow continues as plain follow-up messages.
        const chunks = splitHtml(text, images.length || video ? 1024 : 4096,
          (sourceUrl ? 120 : 0) + htmlEscape(prefix).length + (sensitive ? '<tg-spoiler></tg-spoiler>'.length : 0), mentions);
        const caption = chunks[0] ?? '';
        output.push({ key: `${key}:0`, sourcePostId: post.id, text: caption, images, video, sourceUrl, ...marking });
        for (let i = 1; i < chunks.length; i++) {
          output.push({ key: `${key}:${i}`, sourcePostId: post.id, text: chunks[i]!, images: [], sourceUrl, ...marking });
        }
        if (poll) {
          const question = body.text.trim();
          output.push({ key: `${key}:poll`, sourcePostId: post.id,
            text: !question ? '🗳️ X 投票' : Array.from(question).length <= 300 ? question : '🗳️ 請參閱上一則貼文的投票問題',
            images: [], poll, sourceUrl: xPollUrl(post)! });
        }
      } else {
        // Sharkey renders MFM, so instead of a trailing reply carrying the X link (Bluesky's footer),
        // an X-sourced note gets the configured attribution appended to its own body — a blank line then
        // the signature, with `{url}` resolved to this post's source link. An empty signature disables it.
        const signature = job.destination === 'sharkey' && sourceUrl && this.config.sharkey.signature
          ? this.config.sharkey.signature.replaceAll('{url}', sourceUrl) : '';
        // Reserve room for the signature (plus the blank line) inside the note limit so the last chunk still fits.
        const utf16 = signature ? Math.max(1, 3000 - signature.length - 2) : 3000;
        const chunks = splitText(text, job.destination === 'bluesky'
          ? { graphemes: 300 - graphemes(prefix).length, utf8Bytes: 3000 - Buffer.byteLength(prefix, 'utf8') }
          : { utf16 }, mentions);
        let offset = 0;
        chunks.forEach((chunk, index) => {
          const rendered = signature && index === chunks.length - 1 ? `${chunk}\n\n${signature}` : chunk;
          const partMentions = sliceMentions(mentions, offset, offset + chunk.length);
          offset += chunk.length;
          output.push({ key: `${key}:${index}`, sourcePostId: post.id, text: rendered, images: index === 0 ? images : [], video: index === 0 ? video : undefined, sourceUrl, ...marking,
            ...(partMentions.length && job.destination === 'bluesky' ? { mentions: partMentions } : {}),
            ...(poll && job.destination === 'sharkey' && index === chunks.length - 1 ? { poll } : {}) });
        });
      }
    }
    if (batch?.platform === 'x' && job.destination !== 'telegram' && job.destination !== 'sharkey') {
      const root = members[0]!;
      const url = fixupUrl(root.url || `https://x.com/${root.authorId}/status/${root.id}`);
      if (!url) throw new Error('X root URL invalid');
      output.push({ key: 'footer', sourcePostId: batch.rootId, text: `🔗 X 原推文：${url}`, images: [], sourceUrl: url, isFooter: true });
    }
    if (job.destination !== 'bluesky') {
      for (const part of output) {
        if (!part.poll) continue;
        const prior = this.store.getStep(job.id, part.key);
        // Receipts survive expiry; an uncertain creation must reach reconciliation, not a fresh-poll check.
        if (prior?.state === 'started' || (prior?.state === 'succeeded' && prior.result)) continue;
        nativePollPayload(part.poll, job.destination, Date.parse(now));
      }
    }
    return output;
  }
}

export class Worker {
  private stopping = false;
  private active?: Promise<number>;
  constructor(readonly engine: Engine, readonly publishers: Map<Destination, Publisher>) {}
  async stop(): Promise<void> { this.stopping = true; await this.active; }
  run(now: string = new Date().toISOString()): Promise<number> {
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
        const parts = await this.engine.parts(job, now);
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
              if (job.kind === 'ops') store.armReviewNotice(job.aggregateId, prior.result.chatId, prior.result.messageIds[0], now);
              else store.armReminder(prior.result.messageIds[0], prior.result.chatId, job.aggregateId, `mirror:${job.aggregateId}`, now);
            } else {
              parent = prior.result; root ??= prior.result;
            }
            continue;
          }
          if (prior?.state === 'started') throw Object.assign(new Error('Uncertain previous remote delivery; reconciliation required'), { uncertain: true });
          store.beginStep(job.id, part.key, { text: part.text, sourcePostId: part.sourcePostId, imageHashes: part.images.map(i => i.sha256), ...(part.poll ? { poll: part.poll } : {}) }, now);
          const ref = await publisher.publish(part, {
            root: part.key === 'notice' ? undefined : root,
            parent: part.key === 'notice' ? undefined : parent,
            audience: job.kind === 'reminder' || job.kind === 'ops' ? 'private' : 'public', idempotencyKey: `${job.id}:${part.key}`,
          });
          store.transaction(() => {
            store.finishStep(job.id, part.key, ref);
            if (part.key === 'notice' && ref.chatId && ref.messageIds?.[0]) {
              if (job.kind === 'ops') store.armReviewNotice(job.aggregateId, ref.chatId, ref.messageIds[0], now);
              else if (job.kind === 'reminder') store.armReminder(ref.messageIds[0], ref.chatId, job.aggregateId, `mirror:${job.aggregateId}`, now);
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
export function splitHtml(text: string, escapedLimit: number, reserve = 0, protectedRanges: TextRange[] = []): string[] {
  let budget = Math.max(1, escapedLimit - reserve);
  for (let attempt = 0; attempt < 12; attempt++) {
    const chunks = splitText(text, { utf16: budget }, protectedRanges);
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
      // A clean collect resets the consecutive-failure counter, restoring the strict seal-freshness gate.
      engine.store.setSetting(`collect_failures:${collector.platform}`, 0);
      if (collector.platform === 'x') engine.store.setSetting('x:session_state', 'authenticated');
    } catch (error) {
      // A shutdown aborts the in-flight collect; that is a clean stop, not a failure. Don't count it
      // and don't alert — it self-recovers on the next start.
      if (signal?.aborted) break;
      // Count consecutive failures so sealReady can downgrade a persistently unreachable downstream's
      // freshness requirement rather than letting it block X→downstream sync forever.
      const failures = engine.store.setting<number>(`collect_failures:${collector.platform}`, 0) + 1;
      engine.store.setSetting(`collect_failures:${collector.platform}`, failures);
      if (collector.platform === 'x') engine.store.setSetting('x:session_state', 'error');
      // A single blip (Cloudflare 502/522, a dropped connection) self-recovers next cycle, so it stays a
      // warning in /status and the web log. Only a persistent outage — the same threshold that degrades
      // the seal gate — escalates to an error the owner is paged about on Telegram, and only on the
      // crossing so a long outage doesn't page every cycle.
      const level = failures === DEGRADE_SEAL_FRESHNESS_AFTER_FAILURES ? 'error' : 'warn';
      engine.store.event(level, `${collector.platform} collection failed: ${safeError(error)}`);
    }
  }
}
