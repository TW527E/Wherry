export type SourcePlatform = 'x' | 'bluesky' | 'sharkey' | 'local';
export type Destination = 'bluesky' | 'sharkey' | 'telegram';
export type Classification = 'baseline' | 'collecting' | 'ready' | 'manual_mirror' | 'mirror_review' | 'ignored' | 'unsupported';
export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'review' | 'cancelled';

export interface Attachment {
  kind: 'image' | 'video' | 'audio' | 'unknown';
  url?: string;
  path?: string;
  mimeType?: string;
  alt: string;
  sha256?: string;
  perceptualHash?: string;
  width?: number;
  height?: number;
  size?: number;
  animated?: boolean;
}

export interface SourcePost {
  platform: SourcePlatform;
  id: string;
  authorId: string;
  createdAt: string;
  text: string;
  url?: string;
  rootId?: string;
  replyToId?: string | null;
  replyToAuthorId?: string | null;
  relationKnown: boolean;
  visibility: 'public' | 'restricted' | 'unknown';
  repost?: boolean;
  quoteUrl?: string;
  poll?: boolean;
  cw?: string;
  sensitive?: boolean;
  attachments: Attachment[];
  metadataComplete: boolean;
}

export interface SourceSnapshot {
  platform: Exclude<SourcePlatform, 'local'>;
  accountId: string;
  posts: SourcePost[];
  fetchedAt: string;
  complete: boolean;
  /**
   * How far back the scan actually reached, as an ISO time (the oldest non-pinned post rendered).
   * Set only when `complete` is false because the page budget ran out BEFORE covering the whole
   * gap — the posts still parsed cleanly, the scan just did not scroll far enough. The engine then
   * advances the checkpoint to this point so the next scan resumes here instead of re-scrolling the
   * same range forever (the doom loop that otherwise blocks the queue). Left undefined for a
   * structural failure (nothing rendered, schema broken), where the checkpoint must NOT advance.
   */
  watermark?: string;
  warnings: string[];
}

export interface PreparedImage {
  bytes: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  alt: string;
  width: number;
  height: number;
  sha256: string;
}

export interface PreparedVideo {
  path: string;            // transcoded MP4 on disk (may be large; not held in memory)
  mimeType: 'video/mp4';
  alt: string;
  width: number;
  height: number;
  durationSeconds: number;
  size: number;
  sha256: string;
}

export interface InlineButton {
  text: string;
  data: string;
}

export interface PublishPart {
  key: string;
  sourcePostId: string;
  text: string;
  /** The source's own human-readable warning, carried through as-is (e.g. another platform's CW text). */
  cw?: string;
  /**
   * The source flagged this content as sensitive (X's media warning, or a source CW). NOT a hold: the
   * post still publishes, and each destination carries the marking its platform supports — Bluesky a
   * self-label, Sharkey a sensitive drive file, Telegram a media spoiler.
   */
  sensitive?: boolean;
  images: PreparedImage[];
  /**
   * A single transcoded video, mutually exclusive with images (X and Bluesky both forbid mixing).
   * Only ever set on the first part, and only when VIDEO_ENABLED and a downloadable source exists —
   * X's HLS/blob video has no direct URL, so those posts are held rather than reaching here.
   */
  video?: PreparedVideo;
  sourceUrl?: string;
  isFooter?: boolean;
  /** Inline keyboard, one row of buttons, attached only by Telegram (e.g. the interactive reminder). */
  buttons?: InlineButton[];
}

export interface RemoteRef {
  id: string;
  uri?: string;
  cid?: string;
  url?: string;
  messageIds?: number[];
  chatId?: string;
}

export interface PublishContext {
  parent?: RemoteRef;
  root?: RemoteRef;
  audience?: 'public' | 'private' | 'ops';
  idempotencyKey: string;
}

export interface Publisher {
  readonly destination: Destination;
  publish(part: PublishPart, context: PublishContext): Promise<RemoteRef>;
}

export interface Collector {
  readonly platform: Exclude<SourcePlatform, 'local'>;
  /**
   * Read the account's recent posts, newest first. `since` is the last successful fetch watermark
   * (ISO time); when set, the collector pages back until it reaches posts at/older than it — so a
   * snapshot is only `complete` when the whole gap since the last scan was covered. When unset
   * (first scan), the bounded page budget is the natural limit and the snapshot is a clean baseline.
   */
  collect(since?: string, signal?: AbortSignal): Promise<SourceSnapshot>;
  close?(): Promise<void>;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  // When false, a 3xx with a Location is returned verbatim (status + Location header) instead of
  // being followed. Used to read where a shortener (t.co) points without fetching the destination.
  followRedirects?: boolean;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface Transport {
  request(url: string, options?: HttpOptions): Promise<HttpResponse>;
  json<T = unknown>(url: string, options?: HttpOptions): Promise<T>;
}

export interface Job {
  id: string;
  kind: 'publish' | 'reminder' | 'ops';
  aggregateId: string;
  destination: Destination;
  state: JobState;
  attempts: number;
  dueAt: string;
  error?: string;
}

export interface StoredPost {
  key: string;
  post: SourcePost;
  classification: Classification;
  reason: string;
  batchId?: string;
  firstSeenAt: string;
}

export interface Batch {
  id: string;
  platform: SourcePlatform;
  rootId: string;
  rootCreatedAt: string;
  cutoffAt: string;
  settleAt: string;
  state: 'open' | 'sealed' | 'review' | 'mirror' | 'ignored';
  reason: string;
}

export type ReminderState = 'offered' | 'awaiting_link' | 'declined' | 'linked';

export interface Reminder {
  messageId: number;
  chatId: string;
  aggregateId: string;
  mirrorId: string;
  state: ReminderState;
  xUrl?: string;
  revision: number;
  syncedRevision: number;
  editAfter?: string;
}

/**
 * A held X batch (`review` state) surfaced to the owner as an interactive Telegram message.
 * `offered` = buttons live; `awaiting_link` = the owner tapped 手動鏡像 and we wait for the reply
 * carrying the downstream mirror code(s); `approved` = sent to the downstream queue; `skipped`
 * and `mirrored` are the two terminal decisions. `revision`/`syncedRevision`/`editAfter` drive the
 * same edit-when-changed, back-off-on-429 loop the reminder uses, so the one message keeps
 * reflecting per-platform delivery status without re-sending.
 */
export type ReviewNoticeState = 'offered' | 'awaiting_link' | 'approved' | 'skipped' | 'mirrored';

export interface ReviewNotice {
  batchId: string;
  chatId: string;
  messageId: number;
  state: ReviewNoticeState;
  /**
   * A hash of the message body last written to Telegram. The notice text also changes when the
   * per-platform delivery jobs advance (⏳ → ✅/❌) with no state change of its own, so flush edits
   * the message whenever the freshly-rendered signature differs from this — not on a revision
   * counter. Empty until the first edit.
   */
  syncedSig: string;
  /** Back-off timestamp after a Telegram 429, mirroring the reminder edit loop. */
  editAfter?: string;
  at: string;
}

export interface EventRecord {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  entityId?: string;
}
