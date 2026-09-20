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

export interface PublishPart {
  key: string;
  sourcePostId: string;
  text: string;
  cw?: string;
  images: PreparedImage[];
  sourceUrl?: string;
  isFooter?: boolean;
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
  collect(): Promise<SourceSnapshot>;
  close?(): Promise<void>;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
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

export interface EventRecord {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  entityId?: string;
}
