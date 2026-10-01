import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import { contentWarning, isSensitiveContent } from '../content-warning.js';
import { nativePollPayload } from '../poll.js';
import type { Attachment, Collector, PublishContext, PublishPart, Publisher, RemoteRef, SourcePost, SourceSnapshot, Transport } from '../types.js';
import {
  PlatformError, httpsBase, isoDate, jsonBody, multipart, nonempty, object, own, positiveInteger,
  requestJson, schemaError, validateImage, warning, webUrl, type JsonObject,
} from './parse.js';

export type SharkeyConfig = AppConfig['sharkey'];
export interface SharkeyOptions {
  now?: () => Date;
}
export interface SharkeyLimits {
  maxNoteTextLength: number;
  maxCwLength: number;
  maxAltTextLength: number;
  maxFileBytes?: number;
  canPublicNote: boolean;
}
interface SharkeyAccount { id: string; username: string; policies?: JsonObject }
interface ParsedNote { post?: SourcePost; valid: boolean; reason?: string }
const noteId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function parseNote(value: unknown, accountId: string, baseUrl: string): ParsedNote {
  const note = object(value), user = object(note?.user);
  if (!note || !noteId(note.id) || note.userId !== accountId || !isoDate(note.createdAt)
    || (note.text !== null && typeof note.text !== 'string')) return { valid: false, reason: 'note id/userId/createdAt/text shape' };
  let valid = true;
  let reason: string | undefined;
  // Record the first field that fails so a rejected snapshot names its cause instead of a generic error.
  const fail = (field: string): void => { valid = false; reason ??= field; };
  if (!user || user.id !== accountId || (user.host !== null && user.host !== undefined)) fail('user.id/host');
  if (!own(note, 'cw') || (note.cw !== null && typeof note.cw !== 'string')) fail('cw');
  if (!own(note, 'replyId') || (note.replyId !== null && !noteId(note.replyId))) fail('replyId');
  if (!own(note, 'renoteId') || (note.renoteId !== null && !noteId(note.renoteId))) fail('renoteId');
  if (!Array.isArray(note.files) || note.files.length > 16) fail('files');
  if (typeof note.localOnly !== 'boolean') fail('localOnly');
  const knownVisibility = ['public', 'home', 'followers', 'specified'].includes(String(note.visibility));
  if (!knownVisibility) fail('visibility');
  if (own(note, 'isSensitive') && typeof note.isSensitive !== 'boolean') fail('isSensitive');

  const files = Array.isArray(note.files) ? note.files : [];
  let sensitive = note.isSensitive === true;
  const attachments: Attachment[] = [];
  for (const raw of files) {
    const file = object(raw), props = object(file?.properties);
    const mime = typeof file?.type === 'string' ? file.type : '';
    const url = webUrl(file?.url);
    const alt = typeof file?.comment === 'string' ? file.comment : '';
    if (!file || !noteId(file.id) || !mime || !url || !positiveInteger(file.size)
      || !own(file, 'comment') || (file.comment !== null && typeof file.comment !== 'string') || typeof file.isSensitive !== 'boolean') fail('file shape');
    if (file?.isSensitive === true) sensitive = true;
    if (props && ((own(props, 'width') && !positiveInteger(props.width)) || (own(props, 'height') && !positiveInteger(props.height)))) fail('file dimensions');
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'unknown';
    attachments.push({ kind, url, mimeType: mime || undefined, alt,
      size: positiveInteger(file?.size) ? file.size : undefined,
      width: positiveInteger(props?.width) ? props.width : undefined,
      height: positiveInteger(props?.height) ? props.height : undefined,
      animated: mime === 'image/gif' || mime === 'image/apng' || props?.isAnimated === true ? true : undefined });
  }
  if (own(note, 'fileIds')) {
    if (!Array.isArray(note.fileIds) || note.fileIds.length !== files.length
      || note.fileIds.some((id, index) => !noteId(id) || id !== object(files[index])?.id)) fail('fileIds');
  }

  let poll = false;
  if (own(note, 'poll') && note.poll !== null) {
    poll = true;
    const detail = object(note.poll);
    if (!detail || typeof detail.multiple !== 'boolean' || !Array.isArray(detail.choices) || detail.choices.length < 2
      || detail.choices.some(choice => typeof object(choice)?.text !== 'string' || !count(object(choice)?.votes))) fail('poll');
    if (detail && own(detail, 'expiresAt') && detail.expiresAt !== null && !isoDate(detail.expiresAt)) fail('poll.expiresAt');
  }

  let relationKnown = own(note, 'replyId') && (note.replyId === null || noteId(note.replyId));
  let rootId: string | undefined = note.replyId === null ? note.id : undefined;
  let replyToAuthorId: string | null | undefined = note.replyId === null ? null : undefined;
  if (noteId(note.replyId)) {
    const parent = object(note.reply);
    if (!parent || parent.id !== note.replyId || !noteId(parent.userId)) relationKnown = false;
    else {
      replyToAuthorId = parent.userId;
      const visited = new Set<string>([note.id]);
      let ancestor: JsonObject | undefined = parent;
      for (let depth = 0; ancestor && depth < 10; depth++) {
        if (!noteId(ancestor.id) || visited.has(ancestor.id)) { relationKnown = false; break; }
        visited.add(ancestor.id);
        if (ancestor.replyId === null) { rootId = ancestor.id; break; }
        const next = object(ancestor.reply);
        if (!next || next.id !== ancestor.replyId) break;
        ancestor = next;
      }
    }
  }
  if (!relationKnown) fail('reply relation');
  const text = note.text ?? '';
  const cw = typeof note.cw === 'string' ? note.cw : undefined;
  const renote = noteId(note.renoteId) ? note.renoteId : undefined;
  const repost = Boolean(renote && !text && !files.length && !poll && !cw);
  const quoteUrl = renote && !repost ? `${baseUrl}/notes/${encodeURIComponent(renote)}` : undefined;
  const restricted = note.visibility !== 'public' || note.localOnly === true || note.channelId != null;
  return { valid, reason, post: {
    platform: 'sharkey', id: note.id, authorId: accountId, createdAt: note.createdAt, text,
    url: `${baseUrl}/notes/${encodeURIComponent(note.id)}`, rootId,
    replyToId: note.replyId === null ? null : noteId(note.replyId) ? note.replyId : undefined,
    replyToAuthorId, relationKnown,
    visibility: !knownVisibility ? 'unknown' : restricted ? 'restricted' : 'public',
    repost, quoteUrl, poll, cw, sensitive, attachments, metadataComplete: valid,
  } };
}

/** Uses only the injected transport. No remote request happens in the constructor. */
export class SharkeyClient implements Publisher, Collector {
  readonly destination = 'sharkey' as const;
  readonly platform = 'sharkey' as const;
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private account?: SharkeyAccount;
  private accountPromise?: Promise<SharkeyAccount>;
  private limits?: SharkeyLimits;
  private limitsPromise?: Promise<SharkeyLimits>;
  // Resolved once per process: null means "upload to the drive root" (folder disabled or empty name),
  // a string is the target folder's id. `undefined` = not resolved yet.
  private folderId?: string | null;
  private folderPromise?: Promise<string | null>;

  constructor(private readonly config: SharkeyConfig, private readonly transport: Transport, options: SharkeyOptions = {}) {
    this.baseUrl = httpsBase(config.baseUrl, 'Sharkey instance');
    this.now = options.now ?? (() => new Date());
  }

  private api(method: string, body: JsonObject, mutation = false): Promise<unknown> {
    return requestJson(this.transport, `${this.baseUrl}/api/${method}`,
      jsonBody({ ...body, ...(this.config.token ? { i: this.config.token } : {}) }), `Sharkey ${method}`, mutation);
  }

  private async discover(): Promise<SharkeyAccount> {
    if (this.account) return this.account;
    if (this.accountPromise) return this.accountPromise;
    this.accountPromise = (async () => {
      const body: JsonObject = this.config.userId ? { userId: this.config.userId } : { username: this.config.username, host: null };
      if (!this.config.token && !this.config.userId && !this.config.username) throw new PlatformError('Configure a Sharkey token, user ID or username', { code: 'MissingAccount' });
      // Prefer the public users/show when an id/username is configured: it needs no read scope, so a
      // write-only token (write:notes/write:drive) still works. Only fall back to `i` (needs
      // read:account) when neither is set.
      const useSelf = !this.config.userId && !this.config.username;
      const result = object(await this.api(useSelf ? 'i' : 'users/show', useSelf ? {} : body));
      if (!noteId(result?.id) || !nonempty(result?.username) || (result.host !== null && result.host !== undefined)) throw schemaError('Sharkey account discovery');
      if ((this.config.userId && this.config.userId !== result.id) || (this.config.username && this.config.username.toLowerCase() !== result.username.toLowerCase())) {
        throw new PlatformError('The Sharkey token belongs to a different configured account', { code: 'AccountMismatch' });
      }
      if (own(result, 'policies') && !object(result.policies)) throw schemaError('Sharkey account policies');
      this.account = { id: result.id, username: result.username, policies: object(result.policies) };
      return this.account;
    })();
    try { return await this.accountPromise; } finally { this.accountPromise = undefined; }
  }

  /**
   * Build the Drive filename from the configured template. A per-publish timestamp keeps every file
   * in one note grouped, while {index} keeps them distinct. The result is validated at config load,
   * and multipart() re-checks it, so an unsafe name can never reach the wire.
   */
  private uploadFilename(index: number, ext: string, stamp: string): string {
    return this.config.uploadName
      .replaceAll('{timestamp}', stamp)
      .replaceAll('{index}', String(index))
      .replaceAll('{ext}', ext);
  }

  /**
   * Resolve the configured Drive folder to an id, uploading media into it instead of the root.
   * The folder is matched by exact name among the account's top-level folders and created on first
   * use if absent (needs read:drive + write:drive). An empty configured name resolves to null =
   * upload to the root. The result is cached for the process; on error the cache is left unset so a
   * later publish retries the lookup rather than being poisoned by one transient failure.
   */
  private async resolveFolder(): Promise<string | null> {
    if (this.folderId !== undefined) return this.folderId;
    const name = this.config.driveFolder;
    if (!name) { this.folderId = null; return null; }
    if (this.folderPromise) return this.folderPromise;
    this.folderPromise = (async () => {
      // folders/find lists matching folders; folderId:null scopes the search to the drive root so a
      // same-named nested folder is never picked. Finding is a read, not a mutation.
      const found = await this.api('drive/folders/find', { name, folderId: null });
      if (!Array.isArray(found)) throw schemaError('Sharkey drive folder lookup');
      for (const raw of found) {
        const folder = object(raw);
        // Only accept a top-level folder (parentId null) whose name matches exactly.
        if (folder && noteId(folder.id) && folder.name === name && (folder.parentId === null || folder.parentId === undefined)) return folder.id;
      }
      // None at the root: create it. A duplicate is harmless (Sharkey allows same-named folders), so
      // this stays a plain non-uncertain call the worker may safely retry.
      const created = object(await this.api('drive/folders/create', { name, parentId: null }, false));
      if (!created || !noteId(created.id)) throw schemaError('Sharkey drive folder creation', false);
      return created.id;
    })();
    try { const id = await this.folderPromise; this.folderId = id; return id; }
    finally { this.folderPromise = undefined; }
  }

  async getLimits(): Promise<SharkeyLimits> {
    if (this.limits) return { ...this.limits };
    if (this.limitsPromise) return { ...await this.limitsPromise };
    this.limitsPromise = (async () => {
      const account = await this.discover();
      const meta = object(await this.api('meta', { detail: true }));
      if (!meta || !positiveInteger(meta.maxNoteTextLength) || (own(meta, 'policies') && !object(meta.policies))) throw schemaError('Sharkey instance policies');
      const policies = { ...object(meta.policies), ...account.policies };
      const maxCwLength = meta.maxCwLength ?? 500;
      const maxAltTextLength = meta.maxFileCommentLength ?? 20_000;
      if (!positiveInteger(maxCwLength) || !positiveInteger(maxAltTextLength)) throw schemaError('Sharkey text policies');
      if (own(policies, 'canPublicNote') && typeof policies.canPublicNote !== 'boolean') throw schemaError('Sharkey publication policy');
      const fileCeilings: number[] = [];
      if (own(meta, 'maxFileSize')) {
        if (!count(meta.maxFileSize)) throw schemaError('Sharkey instance file policy');
        fileCeilings.push(meta.maxFileSize);
      }
      if (own(policies, 'maxFileSizeMb')) {
        if (typeof policies.maxFileSizeMb !== 'number' || !Number.isFinite(policies.maxFileSizeMb) || policies.maxFileSizeMb < 0) throw schemaError('Sharkey role file policy');
        fileCeilings.push(Math.floor(policies.maxFileSizeMb * 1024 * 1024));
      }
      // Do not invent a 100 MB limit. Missing/proxy/parser ceilings remain server-enforced (413 / quota errors).
      this.limits = { maxNoteTextLength: meta.maxNoteTextLength, maxCwLength, maxAltTextLength,
        maxFileBytes: fileCeilings.length ? Math.min(...fileCeilings) : undefined, canPublicNote: policies.canPublicNote !== false };
      return this.limits;
    })();
    try { return { ...await this.limitsPromise }; } finally { this.limitsPromise = undefined; }
  }

  async publish(part: PublishPart, context: PublishContext): Promise<RemoteRef> {
    if (!this.config.token) throw new PlatformError('A Sharkey API token is required for publishing', { code: 'MissingCredentials' });
    if (!nonempty(context.idempotencyKey)) throw new PlatformError('A durable idempotency key is required', { code: 'MissingIdempotencyKey' });
    if (!Array.isArray(part.images) || part.images.length > 4) throw new PlatformError('Phase 1 accepts at most four static images', { code: 'TooManyImages' });
    if (part.video && part.images.length) throw new PlatformError('A Sharkey note cannot carry both a video and images', { code: 'MixedMedia' });
    if (part.poll) {
      if (part.images.length || part.video) throw new PlatformError('An X poll cannot be combined with media', { code: 'MixedMedia' });
      nativePollPayload(part.poll, 'sharkey', this.now().getTime());
    }
    if (typeof part.text !== 'string' || (!part.text.trim() && !part.images.length && !part.video && !part.poll)) throw new PlatformError('Cannot publish an empty Sharkey note', { code: 'EmptyPost' });
    if (part.cw !== undefined && typeof part.cw !== 'string') throw new PlatformError('Sharkey CW must be text', { code: 'InvalidCW' });
    const cw = contentWarning(part);
    const sensitive = isSensitiveContent(part);
    if (context.parent && !noteId(context.parent.id)) throw new PlatformError('Sharkey replies require a note ID', { code: 'InvalidReply' });
    if (context.root && !context.parent) throw new PlatformError('A thread root without a parent is not a valid reply', { code: 'InvalidReply' });
    for (const image of part.images) validateImage(image);
    const limits = await this.getLimits();
    if (!limits.canPublicNote) throw new PlatformError('The account role cannot create public notes', { code: 'PublicNotesNotAllowed' });
    if (part.text.length > limits.maxNoteTextLength || (cw?.length ?? 0) > limits.maxCwLength) throw new PlatformError('Split text/CW to the Sharkey instance limits before publishing', { code: 'TextTooLong' });
    for (const image of part.images) {
      validateImage(image, limits.maxFileBytes);
      if (image.alt.length > limits.maxAltTextLength) throw new PlatformError('Image alt text exceeds the Sharkey instance limit', { code: 'AltTooLong' });
    }
    if (part.video) {
      if (limits.maxFileBytes !== undefined && part.video.size > limits.maxFileBytes) throw new PlatformError('Video exceeds the Sharkey instance file size limit', { code: 'VideoTooLarge' });
      if (part.video.alt.length > limits.maxAltTextLength) throw new PlatformError('Video alt text exceeds the Sharkey instance limit', { code: 'AltTooLong' });
    }
    const fileIds: string[] = [];
    const folderId = (part.images.length || part.video) ? await this.resolveFolder() : null;
    const uploadStamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    // A video never shares a note with images (checked above), so this is either the images or the one video.
    const uploads = part.video
      ? [{ ext: 'mp4', alt: part.video.alt, mimeType: part.video.mimeType, bytes: await readFile(part.video.path) }]
      : part.images.map(image => ({ ext: image.mimeType === 'image/png' ? 'png' : 'jpg', alt: image.alt, mimeType: image.mimeType, bytes: image.bytes }));
    const operation = part.video ? 'Sharkey video upload' : 'Sharkey image upload';
    for (const [index, upload] of uploads.entries()) {
      const form = multipart({ i: this.config.token, comment: upload.alt, isSensitive: String(sensitive), force: 'true', ...(folderId ? { folderId } : {}) }, [
        { field: 'file', filename: this.uploadFilename(index, upload.ext, uploadStamp), mimeType: upload.mimeType, bytes: upload.bytes },
      ]);
      // Uploading a drive file is a PRE-publish step, not the publish itself: the note is only created
      // after every upload succeeds. A failed/uncertain upload therefore cannot leave a visible duplicate
      // (worst case an orphaned, unreferenced file), so it is NOT treated as an uncertain mutation —
      // a timeout/5xx here is a plain transient error the worker may safely retry. Only notes/create below
      // stays a true mutation. (mutation=false on both the request and the schema check.)
      const file = object(await requestJson(this.transport, `${this.baseUrl}/api/drive/files/create`,
        { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body }, operation, false));
      // Misskey/Sharkey stores an empty comment as null and echoes it back as null, so treat null and
      // '' as the same "no alt" value; only a genuine mismatch of non-empty image alt text is a real error.
      if (!noteId(file?.id) || (sensitive && file.isSensitive !== true)
        || (!part.video && file.comment !== undefined && (file.comment ?? '') !== upload.alt)) throw schemaError(operation, false);
      fileIds.push(file.id);
    }
    // Sharkey does not promise a notes/create idempotency nonce. Never automatically replay an uncertain mutation.
    const result = object(await this.api('notes/create', {
      text: part.text || null, visibility: 'public', localOnly: false,
      ...(cw !== undefined ? { cw } : {}), ...(fileIds.length ? { fileIds } : {}),
      ...(part.poll ? { poll: nativePollPayload(part.poll, 'sharkey', this.now().getTime()) } : {}),
      ...(context.parent ? { replyId: context.parent.id } : {}),
    }, true));
    const note = object(result?.createdNote);
    if (!noteId(note?.id)) throw schemaError('Sharkey note creation', true);
    if (part.poll) {
      const createdPoll = object(note.poll);
      if (!createdPoll || createdPoll.multiple !== false || !isoDate(createdPoll.expiresAt)
        || Date.parse(createdPoll.expiresAt) !== Date.parse(part.poll.expiresAt!)
        || !Array.isArray(createdPoll.choices) || createdPoll.choices.length !== part.poll.options.length
        || createdPoll.choices.some((choice, index) => object(choice)?.text !== part.poll!.options[index]!.text)) throw schemaError('Sharkey poll creation', true);
    }
    return { id: note.id, uri: webUrl(note.uri), url: `${this.baseUrl}/notes/${encodeURIComponent(note.id)}` };
  }

  async collect(since?: string): Promise<SourceSnapshot> {
    const fetchedAt = this.now().toISOString();
    let accountId = this.config.userId || this.config.username;
    let complete = true;
    const warnings: string[] = [];
    const posts = new Map<string, SourcePost>();
    let oldest: string | undefined;
    let reachedWatermark = !since;
    try {
      const account = await this.discover();
      accountId = account.id;
      let untilId: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < 3; page++) {
        const result = await this.api('users/notes', {
          userId: account.id, limit: 100, withReplies: true, withRenotes: true, withChannelNotes: true,
          ...(untilId ? { untilId } : {}),
        });
        if (!Array.isArray(result) || result.length > 100) { complete = false; warnings.push('Sharkey notes response is not a bounded note array'); break; }
        let progress = 0;
        for (const raw of result) {
          const parsed = parseNote(raw, account.id, this.baseUrl);
          // A note we cannot fully parse is held individually by the engine (metadataComplete:false);
          // record it as a warning rather than rejecting the whole window. Notes at/before the last
          // scan were already handled, so re-reporting them every scan is noise (e.g. a 2023 note
          // whose drive file was deleted keeps failing fileIds forever).
          if (!parsed.valid && parsed.reason && (!since || !parsed.post || parsed.post.createdAt > since)) warnings.push(`note incomplete: ${parsed.reason}${parsed.post ? ` (id ${parsed.post.id})` : ''}`);
          if (!parsed.post) complete = false;
          if (parsed.post) {
            if (parsed.post.createdAt && (!oldest || parsed.post.createdAt < oldest)) oldest = parsed.post.createdAt;
            if (!posts.has(parsed.post.id)) { posts.set(parsed.post.id, parsed.post); progress++; }
            // A repeated id within a page is a real gap in the feed, not just a quality issue.
            else { complete = false; warnings.push('Sharkey feed repeated a note ID'); }
          }
        }
        // Once the oldest note seen is at/older than the last fetch, the gap since then is covered.
        if (since && oldest && oldest <= since) { reachedWatermark = true; break; }
        if (result.length < 100) { reachedWatermark = true; break; } // reached the end of the feed
        const next = object(result[result.length - 1])?.id;
        if (!noteId(next) || cursors.has(next) || progress === 0) { complete = false; warnings.push('Sharkey pagination did not make progress'); break; }
        cursors.add(next); untilId = next;
      }
    } catch (error) { complete = false; warnings.push(warning(error)); }
    // Budget exhausted before reaching the watermark = a real backlog gap: hold and tell the operator.
    if (complete && !reachedWatermark) { complete = false; warnings.push('Sharkey backlog since the last scan exceeds the page budget; scan more often'); }
    if (!complete && !warnings.length) warnings.push('Some Sharkey notes have incomplete relation, visibility or media metadata');
    return { platform: this.platform, accountId, posts: [...posts.values()], fetchedAt, complete, warnings: [...new Set(warnings)] };
  }
}

