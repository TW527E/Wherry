import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanXLinks } from './text.js';
import { normalizeMentionTarget, normalizeXHandle, type MentionTargets } from './mentions.js';
import type { Batch, Classification, Destination, EventRecord, Job, JobState, Reminder, ReminderState, RemoteRef, ReviewNotice, ReviewNoticeState, SourcePlatform, SourcePost, StoredPost } from './types.js';

type Row = Record<string, unknown>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
/**
 * How long a downstream post stays a *pending* mirror — the window in which the owner might still be
 * manually copying it to X. `mirrors()` keeps returning it for a further 7 days as weaker fuzzy
 * evidence, but only an unexpired candidate can produce a conclusive automatic match.
 */
export const MIRROR_PENDING_MS = 72 * 3600_000;

const schema = [
  'PRAGMA journal_mode=WAL', 'PRAGMA foreign_keys=ON', 'PRAGMA busy_timeout=5000',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS posts (key TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, payload TEXT NOT NULL, classification TEXT NOT NULL, reason TEXT NOT NULL, batch_id TEXT, first_seen_at TEXT NOT NULL, UNIQUE(platform,external_id))',
  'CREATE INDEX IF NOT EXISTS posts_batch ON posts(batch_id)',
  'CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, platform TEXT NOT NULL, root_id TEXT NOT NULL, root_created_at TEXT NOT NULL, cutoff_at TEXT NOT NULL, settle_at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL)',
  "CREATE TABLE IF NOT EXISTS mirrors (id TEXT PRIMARY KEY, post_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', matched_x_id TEXT)",
  'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, UNIQUE(kind,aggregate_id,destination))',
  'CREATE TABLE IF NOT EXISTS steps (job_id TEXT NOT NULL REFERENCES jobs(id), step_key TEXT NOT NULL, state TEXT NOT NULL, content TEXT NOT NULL, result TEXT, started_at TEXT NOT NULL, PRIMARY KEY(job_id,step_key))',
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, entity_id TEXT)',
  'CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS manual_x_links (mirror_id TEXT NOT NULL REFERENCES mirrors(id), x_id TEXT NOT NULL, PRIMARY KEY(mirror_id,x_id))',
  "CREATE TABLE IF NOT EXISTS reminders (message_id INTEGER NOT NULL, chat_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, mirror_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'offered', x_url TEXT, at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, synced_revision INTEGER NOT NULL DEFAULT 0, edit_after TEXT, PRIMARY KEY(chat_id,message_id))",
  "CREATE TABLE IF NOT EXISTS review_notices (batch_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'offered', synced_sig TEXT NOT NULL DEFAULT '', edit_after TEXT, at TEXT NOT NULL)",
] as const;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    for (const statement of schema) this.db.prepare(statement).run();
    if (!this.db.prepare('PRAGMA table_info(mirrors)').all().some(row => row.name === 'matched_x_id')) {
      this.db.prepare('ALTER TABLE mirrors ADD COLUMN matched_x_id TEXT').run();
    }
    if (!this.db.prepare('PRAGMA table_info(reminders)').all().some(row => row.name === 'revision')) {
      this.transaction(() => {
        this.db.prepare('ALTER TABLE reminders RENAME TO reminders_legacy').run();
        this.db.prepare("CREATE TABLE reminders (message_id INTEGER NOT NULL, chat_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, mirror_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'offered', x_url TEXT, at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, synced_revision INTEGER NOT NULL DEFAULT 0, edit_after TEXT, PRIMARY KEY(chat_id,message_id))").run();
        this.db.prepare("INSERT INTO reminders(message_id,chat_id,aggregate_id,mirror_id,state,x_url,at,revision) SELECT message_id,chat_id,aggregate_id,mirror_id,state,x_url,at,CASE WHEN state='offered' THEN 0 ELSE 1 END FROM reminders_legacy").run();
        this.db.prepare('DROP TABLE reminders_legacy').run();
      });
    }
    this.db.prepare('INSERT OR IGNORE INTO manual_x_links SELECT id,matched_x_id FROM mirrors WHERE matched_x_id IS NOT NULL').run();
    // One-off repair: a baseline sweep used to register a downstream account's whole history as pending
    // mirrors, which could only park new X posts in review. Only `pending` rows: a `matched` one is a
    // confirmed pairing that manual_x_links still references.
    const pruned = Number(this.db.prepare("DELETE FROM mirrors WHERE state='pending' AND post_key IN (SELECT key FROM posts WHERE classification='baseline')").run().changes);
    if (pruned) this.event('info', `Dropped ${pruned} baseline history posts that had been registered as pending manual mirrors; they could only hold new X posts for review`);
    // One-off repair: owner actions used to move only the batch, leaving its posts showing `collecting`
    // forever. Bring those posts in line with the batch they belong to.
    this.db.prepare(`UPDATE posts SET
      classification=(SELECT CASE state WHEN 'sealed' THEN 'ready' WHEN 'mirror' THEN 'manual_mirror' WHEN 'ignored' THEN 'ignored' ELSE 'mirror_review' END FROM batches WHERE id=posts.batch_id),
      reason=(SELECT reason FROM batches WHERE id=posts.batch_id)
      WHERE classification='collecting' AND batch_id IN (SELECT id FROM batches WHERE state<>'open')`).run();
    // One-off repair: Bluesky post URLs used to percent-encode the DID (did%3Aplc%3A…), which bsky.app
    // rejects as "Invalid DID or handle". Posts are INSERT OR IGNORE, so stored rows never refresh on their own.
    for (const table of ['posts', 'mirrors']) {
      this.db.prepare(`UPDATE ${table} SET payload=replace(replace(payload,'bsky.app/profile/did%3Aplc%3A','bsky.app/profile/did:plc:'),'bsky.app/profile/did%3Aweb%3A','bsky.app/profile/did:web:') WHERE instr(payload,'bsky.app/profile/did%3A')`).run();
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  acquireRuntimeLock(): () => void {
    const token = randomUUID();
    this.transaction(() => {
      const previous = this.db.prepare('SELECT pid FROM runtime_lock WHERE id=1').get();
      if (previous) {
        let alive = true;
        try { process.kill(Number(previous.pid), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('DATA_DIR is already in use; stop the service before running another CLI command');
      }
      this.db.prepare('INSERT INTO runtime_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid, token);
    });
    return () => { this.db.prepare('DELETE FROM runtime_lock WHERE id=1 AND token=?').run(token); };
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.prepare('BEGIN IMMEDIATE').run();
    try { const result = fn(); this.db.prepare('COMMIT').run(); return result; }
    catch (error) { this.db.prepare('ROLLBACK').run(); throw error; }
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? decode<T>(row.value) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  mentionMapping(handle: string): MentionTargets {
    return this.setting<MentionTargets>(`mention:x:${normalizeXHandle(handle)}`, {});
  }
  mentionMappings(): Map<string, MentionTargets> {
    return new Map(this.db.prepare("SELECT key,value FROM settings WHERE key GLOB 'mention:x:*' ORDER BY key").all()
      .map(row => [String(row.key).slice('mention:x:'.length), decode<MentionTargets>(row.value)]));
  }
  setMentionMapping(handle: string, patch: Partial<Record<Destination, string | null>>): MentionTargets {
    const key = `mention:x:${normalizeXHandle(handle)}`;
    if (!Object.keys(patch).length) throw new Error('請至少提供一個平台 ID。');
    return this.transaction(() => {
      const mapping = this.setting<MentionTargets>(key, {});
      for (const [destination, value] of Object.entries(patch)) {
        if (value === null) delete mapping[destination as Destination];
        else if (typeof value === 'string') mapping[destination as Destination] = normalizeMentionTarget(destination, value);
        else throw new Error('平台 ID 必須是文字。');
      }
      if (Object.keys(mapping).length) this.setSetting(key, mapping);
      else this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
      return mapping;
    });
  }
  deleteMentionMapping(handle: string): boolean {
    return Number(this.db.prepare('DELETE FROM settings WHERE key=?').run(`mention:x:${normalizeXHandle(handle)}`).changes) > 0;
  }
  event(level: EventRecord['level'], message: string, entityId?: string): void {
    this.db.prepare('INSERT INTO events(at,level,message,entity_id) VALUES(?,?,?,?)').run(new Date().toISOString(), level, message, entityId || null);
  }
  events(limit = 100): EventRecord[] {
    return this.db.prepare('SELECT at,level,message,entity_id FROM events ORDER BY id DESC LIMIT ?').all(limit).map(r => ({ at: String(r.at), level: r.level as EventRecord['level'], message: String(r.message), entityId: r.entity_id ? String(r.entity_id) : undefined }));
  }
  /** Highest event row id so far (0 when there are none). Used to seed the Telegram error offset. */
  maxEventId(): number { const row = this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get(); return Number(row?.id ?? 0); }
  /** Error events with id greater than `afterId`, oldest first, for forwarding to Telegram in order. */
  errorEventsAfter(afterId: number, limit = 20): Array<{ id: number; at: string; message: string; entityId?: string }> {
    return this.db.prepare("SELECT id,at,message,entity_id FROM events WHERE level='error' AND id>? ORDER BY id ASC LIMIT ?").all(afterId, limit)
      .map(r => ({ id: Number(r.id), at: String(r.at), message: String(r.message), entityId: r.entity_id ? String(r.entity_id) : undefined }));
  }
  static postKey(platform: SourcePlatform, id: string): string { return `${platform}:${id}`; }
  addPost(post: SourcePost, classification: Classification, reason: string, now: string, batchId?: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO posts VALUES(?,?,?,?,?,?,?,?)').run(Store.postKey(post.platform, post.id), post.platform, post.id, JSON.stringify(post), classification, reason, batchId || null, now).changes) > 0;
  }
  private postRow(row: Row): StoredPost {
    return { key: String(row.key), post: decode<SourcePost>(row.payload), classification: row.classification as Classification,
      reason: String(row.reason), batchId: row.batch_id ? String(row.batch_id) : undefined, firstSeenAt: String(row.first_seen_at) };
  }
  getPost(platform: SourcePlatform, id: string): StoredPost | undefined {
    const row = this.db.prepare('SELECT * FROM posts WHERE platform=? AND external_id=?').get(platform, id);
    return row ? this.postRow(row) : undefined;
  }
  postByKey(key: string): StoredPost | undefined {
    const row = this.db.prepare('SELECT * FROM posts WHERE key=?').get(key);
    return row ? this.postRow(row) : undefined;
  }
  updatePost(key: string, classification: Classification, reason: string): void {
    this.db.prepare('UPDATE posts SET classification=?,reason=? WHERE key=?').run(classification, reason, key);
  }
  posts(limit = 100): StoredPost[] { return this.db.prepare('SELECT * FROM posts ORDER BY first_seen_at DESC, key DESC LIMIT ?').all(limit).map(r => this.postRow(r)); }
  batchPosts(id: string): StoredPost[] {
    return this.db.prepare('SELECT * FROM posts WHERE batch_id=?').all(id).map(r => this.postRow(r)).sort((a, b) => a.post.createdAt.localeCompare(b.post.createdAt) || a.post.id.localeCompare(b.post.id));
  }
  addBatch(batch: Batch): void {
    this.db.prepare('INSERT OR IGNORE INTO batches VALUES(?,?,?,?,?,?,?,?)').run(batch.id, batch.platform, batch.rootId, batch.rootCreatedAt, batch.cutoffAt, batch.settleAt, batch.state, batch.reason);
  }
  private batchRow(r: Row): Batch {
    return { id: String(r.id), platform: r.platform as SourcePlatform, rootId: String(r.root_id), rootCreatedAt: String(r.root_created_at), cutoffAt: String(r.cutoff_at), settleAt: String(r.settle_at), state: r.state as Batch['state'], reason: String(r.reason) };
  }
  getBatch(id: string): Batch | undefined { const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id); return row ? this.batchRow(row) : undefined; }
  batches(limit = 100): Batch[] { return this.db.prepare('SELECT * FROM batches ORDER BY root_created_at DESC LIMIT ?').all(limit).map(r => this.batchRow(r)); }
  openBatches(): Batch[] { return this.db.prepare("SELECT * FROM batches WHERE state='open'").all().map(r => this.batchRow(r)); }
  updateBatch(id: string, state: Batch['state'], reason: string): void { this.db.prepare('UPDATE batches SET state=?,reason=? WHERE id=?').run(state, reason, id); }
  addMirror(post: SourcePost, now: string): string {
    const key = Store.postKey(post.platform, post.id);
    const id = `mirror:${key}`;
    this.db.prepare('INSERT OR IGNORE INTO mirrors(id,post_key,payload,expires_at) VALUES(?,?,?,?)').run(id, key, JSON.stringify(post), new Date(Date.parse(now) + MIRROR_PENDING_MS).toISOString());
    return id;
  }
  /**
   * Unclaimed downstream posts within the search window. A matched one is already the manual copy of an
   * X post, and one downstream post mirrors at most one X post, so it is evidence for nothing else.
   */
  mirrors(now: string): Array<{ id: string; post: SourcePost; expired: boolean }> {
    const threshold = new Date(Date.parse(now) - 7 * 86400_000).toISOString();
    return this.db.prepare("SELECT * FROM mirrors WHERE state='pending' AND expires_at >= ?").all(threshold).map(r => ({ id: String(r.id), post: decode<SourcePost>(r.payload), expired: String(r.expires_at) < now }));
  }
  matchMirror(id: string, xId: string): void {
    if (!this.db.prepare('SELECT 1 FROM mirrors WHERE id=?').get(id)) throw new Error('Mirror not found');
    this.db.prepare('INSERT OR IGNORE INTO manual_x_links(mirror_id,x_id) VALUES(?,?)').run(id, xId);
    this.db.prepare("UPDATE mirrors SET state='matched',matched_x_id=? WHERE id=?").run(xId, id);
  }
  mirrorMatchesXId(xId: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM manual_x_links WHERE x_id=? LIMIT 1').get(xId)); }
  /** A single mirror candidate by its id, if it still exists and has not expired past the search window. */
  getMirror(id: string, now: string): { id: string; post: SourcePost; expired: boolean; state: string } | undefined {
    const threshold = new Date(Date.parse(now) - 7 * 86400_000).toISOString();
    const row = this.db.prepare('SELECT * FROM mirrors WHERE id=? AND expires_at >= ?').get(id, threshold);
    return row ? { id: String(row.id), post: decode<SourcePost>(row.payload), expired: String(row.expires_at) < now, state: String(row.state) } : undefined;
  }
  armReminder(messageId: number, chatId: string, aggregateId: string, mirrorId: string, now: string): void {
    this.db.prepare("INSERT OR IGNORE INTO reminders(message_id,chat_id,aggregate_id,mirror_id,state,at) VALUES(?,?,?,?,'offered',?)").run(messageId, chatId, aggregateId, mirrorId, now);
  }
  private reminderRow(row: Row): Reminder {
    return { messageId: Number(row.message_id), chatId: String(row.chat_id), aggregateId: String(row.aggregate_id), mirrorId: String(row.mirror_id), state: row.state as ReminderState,
      xUrl: row.x_url ? String(row.x_url) : undefined, revision: Number(row.revision), syncedRevision: Number(row.synced_revision), editAfter: row.edit_after ? String(row.edit_after) : undefined };
  }
  getReminder(messageId: number, chatId: string): Reminder | undefined {
    const row = this.db.prepare('SELECT * FROM reminders WHERE message_id=? AND chat_id=?').get(messageId, chatId);
    return row ? this.reminderRow(row) : undefined;
  }
  remindersNeedingEdit(now: string): Reminder[] {
    return this.db.prepare('SELECT * FROM reminders WHERE revision>synced_revision AND (edit_after IS NULL OR edit_after<=?) ORDER BY at LIMIT 20').all(now).map(row => this.reminderRow(row));
  }
  pendingReminders(chatId: string): Reminder[] {
    return this.db.prepare("SELECT * FROM reminders WHERE chat_id=? AND state IN ('offered','awaiting_link') ORDER BY at LIMIT 20").all(chatId).map(row => this.reminderRow(row));
  }
  setReminderState(messageId: number, chatId: string, state: ReminderState, xUrl?: string): void {
    this.db.prepare('UPDATE reminders SET state=?,x_url=COALESCE(?,x_url),revision=revision+1,edit_after=NULL WHERE message_id=? AND chat_id=?').run(state, xUrl || null, messageId, chatId);
  }
  reminderEdited(reminder: Reminder): void {
    this.db.prepare('UPDATE reminders SET synced_revision=MAX(synced_revision,?),edit_after=NULL WHERE message_id=? AND chat_id=?').run(reminder.revision, reminder.messageId, reminder.chatId);
  }
  deferReminderEdit(reminder: Reminder, after: string): void {
    this.db.prepare('UPDATE reminders SET edit_after=? WHERE message_id=? AND chat_id=? AND revision=?').run(after, reminder.messageId, reminder.chatId, reminder.revision);
  }
  /** Record the Telegram message that carries a review batch's buttons, so a tap resolves the batch. */
  armReviewNotice(batchId: string, chatId: string, messageId: number, now: string): void {
    this.db.prepare("INSERT OR IGNORE INTO review_notices(batch_id,chat_id,message_id,state,at) VALUES(?,?,?,'offered',?)").run(batchId, chatId, messageId, now);
  }
  private reviewNoticeRow(row: Row): ReviewNotice {
    return { batchId: String(row.batch_id), chatId: String(row.chat_id), messageId: Number(row.message_id), state: row.state as ReviewNoticeState,
      editAfter: row.edit_after ? String(row.edit_after) : undefined, at: String(row.at) };
  }
  /** True once a review batch already has (or is queued to get) a notice — guards against re-notifying. */
  hasReviewNotice(batchId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM review_notices WHERE batch_id=? LIMIT 1").get(batchId)
      || this.db.prepare("SELECT 1 FROM jobs WHERE kind='ops' AND aggregate_id=? LIMIT 1").get(batchId));
  }
  getReviewNotice(messageId: number, chatId: string): ReviewNotice | undefined {
    const row = this.db.prepare('SELECT * FROM review_notices WHERE message_id=? AND chat_id=?').get(messageId, chatId);
    return row ? this.reviewNoticeRow(row) : undefined;
  }
  setReviewNoticeState(batchId: string, state: ReviewNoticeState): void {
    this.db.prepare("UPDATE review_notices SET state=?,synced_sig='',edit_after=NULL WHERE batch_id=? AND state<>?").run(state, batchId, state);
  }
  // Keep the legacy column; the notice body is now determined solely by its state.
  reviewNoticeSynced(notice: ReviewNotice): void {
    this.db.prepare('UPDATE review_notices SET synced_sig=?,edit_after=NULL WHERE batch_id=? AND state=?').run(notice.state, notice.batchId, notice.state);
  }
  deferReviewNoticeEdit(notice: ReviewNotice, after: string): void {
    this.db.prepare('UPDATE review_notices SET edit_after=? WHERE batch_id=? AND state=?').run(after, notice.batchId, notice.state);
  }
  reviewNoticesNeedingEdit(now: string): ReviewNotice[] {
    return this.db.prepare("SELECT * FROM review_notices WHERE state<>'offered' AND synced_sig<>state AND (edit_after IS NULL OR edit_after<=?) ORDER BY at LIMIT 20").all(now).map(row => this.reviewNoticeRow(row));
  }
  enqueue(kind: Job['kind'], aggregateId: string, destination: Destination, now: string, dueAt = now): string {
    const existing = this.db.prepare('SELECT id FROM jobs WHERE kind=? AND aggregate_id=? AND destination=?').get(kind, aggregateId, destination);
    if (existing) return String(existing.id);
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs(id,kind,aggregate_id,destination,state,due_at,created_at) VALUES(?,?,?,?,'pending',?,?)").run(id, kind, aggregateId, destination, dueAt, now);
    return id;
  }
  private jobRow(row: Row): Job {
    return { id: String(row.id), kind: row.kind as Job['kind'], aggregateId: String(row.aggregate_id), destination: row.destination as Destination,
      state: row.state as JobState, attempts: Number(row.attempts), dueAt: String(row.due_at), error: row.error ? String(row.error) : undefined };
  }
  getJob(id: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return row ? this.jobRow(row) : undefined; }
  jobsForAggregate(id: string): Job[] { return this.db.prepare('SELECT * FROM jobs WHERE aggregate_id=?').all(id).map(r => this.jobRow(r)); }
  hasDeliveryEvidence(jobId: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM steps WHERE job_id=? AND state IN ('started','succeeded') LIMIT 1").get(jobId)); }
  jobs(limit = 100): Job[] { return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(r => this.jobRow(r)); }
  dueJobs(now: string): Job[] { return this.db.prepare("SELECT * FROM jobs WHERE state='pending' AND due_at<=? ORDER BY due_at,created_at LIMIT 20").all(now).map(r => this.jobRow(r)); }
  claimJob(id: string): boolean { return Number(this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=? AND state='pending'").run(id).changes) === 1; }
  updateJob(id: string, state: JobState, error?: string, dueAt?: string): void {
    this.db.prepare('UPDATE jobs SET state=?,error=?,due_at=COALESCE(?,due_at) WHERE id=?').run(state, error || null, dueAt || null, id);
  }
  recoverInterrupted(): void {
    this.db.prepare("UPDATE jobs SET state='unknown',error='Process stopped during delivery; reconcile before retry' WHERE state='running'").run();
  }
  getStep(jobId: string, key: string): { state: string; content: string; result?: RemoteRef } | undefined {
    const row = this.db.prepare('SELECT * FROM steps WHERE job_id=? AND step_key=?').get(jobId, key);
    return row ? { state: String(row.state), content: String(row.content), result: row.result ? decode<RemoteRef>(row.result) : undefined } : undefined;
  }
  beginStep(jobId: string, key: string, content: unknown, now: string): void {
    this.db.prepare("INSERT INTO steps VALUES(?,?,'started',?,NULL,?) ON CONFLICT(job_id,step_key) DO UPDATE SET state='started',started_at=excluded.started_at").run(jobId, key, JSON.stringify(content), now);
  }
  /** The receipt of one delivered part of a publish, e.g. where an earlier X post landed downstream. */
  deliveredStep(aggregateId: string, destination: Destination, key: string): RemoteRef | undefined {
    const row = this.db.prepare("SELECT s.result FROM steps s JOIN jobs j ON j.id=s.job_id WHERE j.kind='publish' AND j.aggregate_id=? AND j.destination=? AND s.step_key=? AND s.state='succeeded' AND s.result IS NOT NULL")
      .get(aggregateId, destination, key);
    return row ? decode<RemoteRef>(row.result) : undefined;
  }
  finishStep(jobId: string, key: string, ref: RemoteRef): void { this.db.prepare("UPDATE steps SET state='succeeded',result=? WHERE job_id=? AND step_key=?").run(JSON.stringify(ref), jobId, key); }
  rejectStep(jobId: string, key: string): void { this.db.prepare("UPDATE steps SET state='rejected' WHERE job_id=? AND step_key=?").run(jobId, key); }
  /** Reconciliation: discard the uncertain (started-but-unconfirmed) steps of a job so a retry re-runs
   * them from scratch. Succeeded steps keep their receipts, so only the unconfirmed parts are redone. */
  discardStartedSteps(jobId: string): number { return Number(this.db.prepare("UPDATE steps SET state='rejected' WHERE job_id=? AND state='started'").run(jobId).changes); }
  outbound(platform: SourcePlatform, id: string, text: string): 'known' | 'possible' | undefined {
    const rows = this.db.prepare('SELECT s.state,s.content,s.result FROM steps s JOIN jobs j ON j.id=s.job_id WHERE j.destination=?').all(platform);
    for (const row of rows) {
      if (row.result) { const ref = decode<RemoteRef>(row.result); if (ref.id === id || ref.uri === id) return 'known'; }
      if (row.state === 'started' && cleanXLinks(decode<{ text: string }>(row.content).text) === text) return 'possible';
    }
    return undefined;
  }
}
