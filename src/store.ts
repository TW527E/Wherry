import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Batch, Classification, Destination, EventRecord, Job, JobState, RemoteRef, SourcePlatform, SourcePost, StoredPost } from './types.js';

type Row = Record<string, unknown>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
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
  'CREATE TABLE IF NOT EXISTS command_receipts (update_id INTEGER PRIMARY KEY, at TEXT NOT NULL)',
] as const;

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    for (const statement of schema) this.db.prepare(statement).run();
    if (path !== ':memory:') chmodSync(path, 0o600);
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
  event(level: EventRecord['level'], message: string, entityId?: string): void {
    this.db.prepare('INSERT INTO events(at,level,message,entity_id) VALUES(?,?,?,?)').run(new Date().toISOString(), level, message, entityId || null);
  }
  events(limit = 100): EventRecord[] {
    return this.db.prepare('SELECT at,level,message,entity_id FROM events ORDER BY id DESC LIMIT ?').all(limit).map(r => ({ at: String(r.at), level: r.level as EventRecord['level'], message: String(r.message), entityId: r.entity_id ? String(r.entity_id) : undefined }));
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
  updatePost(key: string, classification: Classification, reason: string, post?: SourcePost): void {
    this.db.prepare('UPDATE posts SET classification=?,reason=?,payload=COALESCE(?,payload) WHERE key=?').run(classification, reason, post ? JSON.stringify(post) : null, key);
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
    this.db.prepare('INSERT OR IGNORE INTO mirrors(id,post_key,payload,expires_at) VALUES(?,?,?,?)').run(id, key, JSON.stringify(post), new Date(Date.parse(now) + 72 * 3600_000).toISOString());
    return id;
  }
  mirrors(now: string): Array<{ id: string; post: SourcePost; expired: boolean; state: string }> {
    const threshold = new Date(Date.parse(now) - 7 * 86400_000).toISOString();
    return this.db.prepare('SELECT * FROM mirrors WHERE expires_at >= ?').all(threshold).map(r => ({ id: String(r.id), post: decode<SourcePost>(r.payload), expired: String(r.expires_at) < now, state: String(r.state) }));
  }
  matchMirror(id: string, xId: string): void { this.db.prepare("UPDATE mirrors SET state='matched',matched_x_id=? WHERE id=?").run(xId, id); }
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
  finishStep(jobId: string, key: string, ref: RemoteRef): void { this.db.prepare("UPDATE steps SET state='succeeded',result=? WHERE job_id=? AND step_key=?").run(JSON.stringify(ref), jobId, key); }
  rejectStep(jobId: string, key: string): void { this.db.prepare("UPDATE steps SET state='rejected' WHERE job_id=? AND step_key=?").run(jobId, key); }
  outbound(platform: SourcePlatform, id: string, text: string): 'known' | 'possible' | undefined {
    const rows = this.db.prepare('SELECT s.state,s.content,s.result FROM steps s JOIN jobs j ON j.id=s.job_id WHERE j.destination=?').all(platform);
    for (const row of rows) {
      if (row.result) { const ref = decode<RemoteRef>(row.result); if (ref.id === id || ref.uri === id) return 'known'; }
      if (row.state === 'started' && decode<{ text: string }>(row.content).text === text) return 'possible';
    }
    return undefined;
  }
  commandOnce(id: number, now: string): boolean { return Number(this.db.prepare('INSERT OR IGNORE INTO command_receipts VALUES(?,?)').run(id, now).changes) === 1; }
}
