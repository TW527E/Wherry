import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Attachment, Collector, HttpOptions, PublishContext, Publisher, PublishPart, RemoteRef, SourcePost, SourceSnapshot, Transport } from '../types.js';
import {
  PlatformError, canonicalJson, httpsBase, isoDate, jsonBody, nonempty, object, own,
  positiveInteger, requestJson, schemaError, uncertainError, validateImage, warning, webUrl,
  type JsonObject,
} from './parse.js';

export type BlueskyConfig = AppConfig['bluesky'];
export interface BlueskySession { did: string; handle: string; pds: string; accessJwt: string; refreshJwt: string }
export interface BlueskyOptions {
  maxPages?: number;
  now?: () => Date;
  session?: BlueskySession;
  /** Optional durable secret storage. Rotation is retained in this client even without a callback. */
  onSession?: (session: BlueskySession) => void | Promise<void>;
}
interface Identity { did: string; handle: string; pds: string }
interface StrongRef { uri: string; cid: string }
interface PostUri { did: string; key: string }
interface ParsedPost { post?: SourcePost; valid: boolean }

const collection = 'app.bsky.feed.post';
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
const didValid = (value: unknown): value is string => typeof value === 'string' &&
  (/^did:plc:[a-z2-7]{24}$/.test(value) || /^did:web:[^\s/?#]+$/.test(value));
/** Non-narrowing form for values already known to be strings. */
const looksLikeDid = (value: string): boolean => didValid(value);
const looksLikeHandle = (value: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && value.includes('.');
const cidValid = (value: unknown): value is string => nonempty(value) && value.length <= 256 && !/[\s/?#]/.test(value);

function parseUri(uri: unknown): PostUri | undefined {
  if (typeof uri !== 'string') return;
  const match = uri.match(/^at:\/\/(did:[^\s/?#]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]{1,512})$/);
  if (!match || !didValid(match[1]) || match[2] === '.' || match[2] === '..') return;
  return { did: match[1], key: match[2]! };
}

function strong(value: unknown): StrongRef | undefined {
  const ref = object(value);
  return parseUri(ref?.uri) && cidValid(ref?.cid) ? { uri: ref!.uri as string, cid: ref!.cid as string } : undefined;
}

function postUrl(uri: unknown): string | undefined {
  const parsed = parseUri(uri);
  return parsed ? `https://bsky.app/profile/${encodeURIComponent(parsed.did)}/post/${encodeURIComponent(parsed.key)}` : undefined;
}

/** Only links are inferred. Bare @names are never resolved to a possibly unrelated account. */
export function blueskyLinkFacets(text: string): Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }> }> {
  const facets: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }> }> = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\u3000]+/giu)) {
    let raw = match[0].replace(/[.,!?;:，。！？；：]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (raw.endsWith(close) && raw.split(close).length > raw.split(open).length) raw = raw.slice(0, -1);
    }
    const uri = webUrl(raw);
    if (!uri) continue;
    const byteStart = Buffer.byteLength(text.slice(0, match.index));
    facets.push({ index: { byteStart, byteEnd: byteStart + Buffer.byteLength(raw) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  }
  return facets;
}

/** Custom AT record keys need not be TIDs. Stable, legal, lowercase, and never contains a slash. */
export function blueskyRecordKey(idempotencyKey: string): string {
  if (!nonempty(idempotencyKey)) throw new PlatformError('A durable idempotency key is required', { code: 'MissingIdempotencyKey' });
  return `cp${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

function publicDidUrl(did: string): string {
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) return `https://plc.directory/${did}`;
  if (!did.startsWith('did:web:')) throw new PlatformError('Unsupported account DID method', { code: 'InvalidDID' });
  try {
    const parts = did.slice(8).split(':').map(part => decodeURIComponent(part));
    const authority = parts.shift();
    if (!authority || /[@/?#\\\s]/.test(authority)) throw new Error();
    const origin = new URL(`https://${authority}`);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    if (parts.some(part => !/^[A-Za-z0-9._~-]+$/.test(part) || part === '.' || part === '..')) throw new Error();
    return parts.length ? `${origin.origin}/${parts.map(encodeURIComponent).join('/')}/did.json` : `${origin.origin}/.well-known/did.json`;
  } catch { throw new PlatformError('Invalid did:web document location', { code: 'InvalidDID' }); }
}

function blob(value: unknown): JsonObject | undefined {
  const item = object(value);
  const ref = object(item?.ref);
  return item?.$type === 'blob' && cidValid(ref?.$link) && nonempty(item.mimeType) && positiveInteger(item.size)
    ? { $type: 'blob', ref: { $link: ref.$link }, mimeType: item.mimeType, size: item.size } : undefined;
}

function parsePost(entry: unknown, accountId: string, pds: string): ParsedPost {
  const item = object(entry), view = object(item?.post);
  const record = object(view?.record), author = object(view?.author);
  const parsedUri = parseUri(view?.uri);
  if (!item || !view || !record || !author || !parsedUri || !cidValid(view.cid)
    || record.$type !== collection || typeof record.text !== 'string' || !isoDate(record.createdAt)
    || !didValid(author.did) || author.did !== parsedUri.did) return { valid: false };
  let valid = true;
  let repost = false;
  if (own(item, 'reason')) {
    const reason = object(item.reason);
    if (reason?.$type === 'app.bsky.feed.defs#reasonRepost') {
      repost = true;
      if (object(reason.by)?.did !== accountId || !isoDate(reason.indexedAt)) valid = false;
    } else if (reason?.$type !== 'app.bsky.feed.defs#reasonPin' || author.did !== accountId) valid = false;
  }
  if (author.did !== accountId && !repost) return { valid: false };

  let rootId: string | undefined = view.uri as string;
  let replyToId: string | null | undefined = null;
  let replyToAuthorId: string | null | undefined = null;
  let relationKnown = true;
  if (own(record, 'reply')) {
    const reply = object(record.reply);
    const root = strong(reply?.root), parent = strong(reply?.parent);
    if (!root || !parent) {
      relationKnown = false; rootId = undefined; replyToId = undefined; replyToAuthorId = undefined; valid = false;
    } else {
      rootId = root.uri; replyToId = parent.uri; replyToAuthorId = parseUri(parent.uri)!.did;
    }
  }

  const labels: string[] = [];
  const addLabels = (values: unknown, self: boolean): void => {
    if (!Array.isArray(values)) { valid = false; return; }
    for (const value of values) {
      const label = object(value);
      if (!label || !nonempty(label.val) || (!self && label.neg !== undefined && typeof label.neg !== 'boolean')) { valid = false; continue; }
      if (label.neg !== true) labels.push(label.val);
    }
  };
  // Omitted labels are not evidence of a complete moderation view.
  addLabels(view.labels, false);
  if (own(author, 'labels')) addLabels(author.labels, false);
  if (own(record, 'labels')) {
    const self = object(record.labels);
    if (self?.$type !== 'com.atproto.label.defs#selfLabels') valid = false;
    addLabels(self?.values, true);
  }

  let text = record.text;
  let quoteUrl: string | undefined;
  const attachments: Attachment[] = [];
  const rawBlobUrl = (value: unknown): string | undefined => {
    const file = blob(value), cid = object(file?.ref)?.$link;
    return author.did === accountId && typeof cid === 'string'
      ? `${pds}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did: accountId, cid })}` : undefined;
  };
  const parseEmbed = (raw: unknown, rendered: unknown): void => {
    const embed = object(raw), display = object(rendered);
    if (!embed) { valid = false; attachments.push({ kind: 'unknown', alt: '' }); return; }
    switch (embed.$type) {
      case 'app.bsky.embed.images': {
        if (!Array.isArray(embed.images) || embed.images.length < 1 || embed.images.length > 4
          || display?.$type !== 'app.bsky.embed.images#view' || !Array.isArray(display.images) || display.images.length !== embed.images.length) valid = false;
        const images = Array.isArray(embed.images) ? embed.images : [], shown = Array.isArray(display?.images) ? display.images : [];
        for (let i = 0; i < images.length; i++) {
          const image = object(images[i]), visible = object(shown[i]), file = blob(image?.image);
          const alt = typeof image?.alt === 'string' ? image.alt : '';
          const url = webUrl(visible?.fullsize) ?? rawBlobUrl(image?.image);
          const mime = typeof file?.mimeType === 'string' ? file.mimeType : undefined;
          const size = typeof file?.size === 'number' ? file.size : undefined;
          const ratio = object(image?.aspectRatio);
          if (!image || typeof image.alt !== 'string' || !file || !url || !mime?.startsWith('image/')) valid = false;
          if (image && own(image, 'aspectRatio') && (!positiveInteger(ratio?.width) || !positiveInteger(ratio?.height))) valid = false;
          if (visible && (typeof visible.alt !== 'string' || visible.alt !== alt)) valid = false;
          attachments.push({ kind: 'image', url, alt, mimeType: mime, size,
            width: positiveInteger(ratio?.width) ? ratio.width : undefined,
            height: positiveInteger(ratio?.height) ? ratio.height : undefined,
            animated: mime === 'image/gif' ? true : undefined });
        }
        if (!images.length) attachments.push({ kind: 'unknown', alt: '' });
        return;
      }
      case 'app.bsky.embed.external': {
        const external = object(embed.external), uri = webUrl(external?.uri);
        if (!uri || typeof external?.title !== 'string' || typeof external.description !== 'string') { valid = false; return; }
        if (!text.includes(uri)) text = `${text}${text ? '\n\n' : ''}${uri}`;
        if (/\.gif(?:[?#]|$)/i.test(uri) || /(?:^|\.)(?:tenor\.com|giphy\.com)$/i.test(new URL(uri).hostname)) {
          attachments.push({ kind: 'image', alt: external.title, url: uri, animated: true });
        }
        return;
      }
      case 'app.bsky.embed.record': {
        const ref = strong(embed.record);
        if (!ref) valid = false;
        else quoteUrl = postUrl(ref.uri);
        return;
      }
      case 'app.bsky.embed.recordWithMedia':
        if (object(embed.record)?.$type !== 'app.bsky.embed.record') valid = false;
        parseEmbed(embed.record, display?.record);
        if (!['app.bsky.embed.images', 'app.bsky.embed.external', 'app.bsky.embed.video'].includes(String(object(embed.media)?.$type))) {
          valid = false; attachments.push({ kind: 'unknown', alt: '' });
        } else parseEmbed(embed.media, display?.media);
        return;
      case 'app.bsky.embed.video': {
        const file = blob(embed.video);
        if (!file || (embed.alt !== undefined && typeof embed.alt !== 'string')) valid = false;
        attachments.push({ kind: 'video', alt: typeof embed.alt === 'string' ? embed.alt : '', mimeType: 'video/mp4',
          url: rawBlobUrl(embed.video) ?? webUrl(display?.playlist), size: typeof file?.size === 'number' ? file.size : undefined });
        return;
      }
      default:
        valid = false; attachments.push({ kind: 'unknown', alt: '' });
    }
  };
  if (own(record, 'embed')) parseEmbed(record.embed, view.embed);
  else if (own(view, 'embed')) { valid = false; attachments.push({ kind: 'unknown', alt: '' }); }
  const restricted = labels.includes('!no-unauthenticated') || labels.includes('!hide');
  const contentLabels = [...new Set(labels.filter(label => label !== '!no-unauthenticated'))];
  return { valid, post: {
    platform: 'bluesky', id: view.uri as string, authorId: author.did, createdAt: record.createdAt,
    text, url: postUrl(view.uri), rootId, replyToId, replyToAuthorId, relationKnown,
    visibility: restricted ? 'restricted' : 'public', repost, quoteUrl,
    poll: own(record, 'poll') && record.poll != null,
    sensitive: contentLabels.length > 0, cw: contentLabels.length ? `Bluesky labels: ${contentLabels.join(', ')}` : undefined,
    attachments, metadataComplete: valid,
  } };
}

/** Combined Publisher/Collector. Construction does not perform login or any request. */
export class BlueskyClient implements Publisher, Collector {
  readonly destination = 'bluesky' as const;
  readonly platform = 'bluesky' as const;
  private readonly serviceUrl: string;
  private readonly publicUrl: string;
  private readonly maxPages: number;
  private readonly now: () => Date;
  private identity?: Identity;
  private session?: BlueskySession;
  private discovering?: Promise<Identity>;
  private loggingIn?: Promise<BlueskySession>;
  private refreshing?: Promise<BlueskySession>;

  constructor(private readonly config: BlueskyConfig, private readonly transport: Transport, private readonly options: BlueskyOptions = {}) {
    this.serviceUrl = httpsBase(config.serviceUrl, 'Bluesky bootstrap service');
    this.publicUrl = httpsBase(config.publicUrl, 'Bluesky public AppView');
    this.maxPages = options.maxPages ?? 3;
    if (!positiveInteger(this.maxPages) || this.maxPages > 3) throw new PlatformError('Bluesky maxPages must be between 1 and 3', { code: 'InvalidPagination' });
    this.now = options.now ?? (() => new Date());
    if (options.session) {
      const session = options.session;
      if (!didValid(session.did) || !nonempty(session.handle) || !nonempty(session.accessJwt) || !nonempty(session.refreshJwt)) throw schemaError('Stored Bluesky session');
      this.session = { ...session, pds: httpsBase(session.pds, 'Stored Bluesky PDS') };
    }
  }

  getSession(): BlueskySession | undefined { return this.session ? { ...this.session } : undefined; }

  private async resolvePds(did: string): Promise<string> {
    const doc = object(await requestJson(this.transport, publicDidUrl(did), { method: 'GET', maxBytes: 256_000 }, 'Bluesky DID discovery'));
    if (doc?.id !== did || !Array.isArray(doc.service)) throw schemaError('Bluesky DID discovery');
    const services = doc.service.map(object).filter(service => service?.type === 'AtprotoPersonalDataServer'
      && (service.id === '#atproto_pds' || service.id === `${did}#atproto_pds`));
    if (services.length !== 1 || !nonempty(services[0]?.serviceEndpoint)) throw schemaError('Bluesky PDS discovery');
    return httpsBase(services[0]!.serviceEndpoint as string, 'Discovered Bluesky PDS');
  }

  private decodeSession(value: unknown, pds: string, expectedDid?: string): BlueskySession {
    const session = object(value);
    if (!didValid(session?.did) || !nonempty(session?.handle) || !nonempty(session?.accessJwt) || !nonempty(session?.refreshJwt)
      || (expectedDid !== undefined && session.did !== expectedDid) || session.active === false) throw schemaError('Bluesky session');
    return { did: session.did, handle: session.handle, accessJwt: session.accessJwt, refreshJwt: session.refreshJwt, pds };
  }

  private async save(session: BlueskySession): Promise<BlueskySession> {
    this.session = session;
    try { await this.options.onSession?.({ ...session }); }
    catch { throw new PlatformError('Bluesky session persistence failed', { code: 'SessionPersistenceFailed' }); }
    return session;
  }

  private async discover(): Promise<Identity> {
    if (this.identity) return this.identity;
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      let did: string | undefined = this.session?.did;
      let handle: string = this.session?.handle ?? this.config.identifier;
      let bootstrap: BlueskySession | undefined;
      const identifier: string = this.config.identifier;
      if (!did) {
        if (looksLikeDid(identifier)) did = identifier;
        else if (identifier.includes('@')) {
          if (!this.config.appPassword) throw new PlatformError('An app password is required for email-based Bluesky discovery', { code: 'MissingCredentials' });
          bootstrap = this.decodeSession(await requestJson(this.transport, `${this.serviceUrl}/xrpc/com.atproto.server.createSession`,
            jsonBody({ identifier, password: this.config.appPassword }), 'Bluesky login'), this.serviceUrl);
          did = bootstrap.did; handle = bootstrap.handle;
        } else if (looksLikeHandle(identifier)) {
          const result = object(await requestJson(this.transport,
            `${this.publicUrl}/xrpc/com.atproto.identity.resolveHandle?${new URLSearchParams({ handle: identifier })}`,
            { method: 'GET', maxBytes: 64_000 }, 'Bluesky handle discovery'));
          if (!didValid(result?.did)) throw schemaError('Bluesky handle discovery');
          did = result.did;
        } else throw new PlatformError('Configure a Bluesky handle, DID or login email', { code: 'InvalidIdentifier' });
      }
      const pds = await this.resolvePds(did);
      const identity = { did, handle, pds };
      if (bootstrap) await this.save({ ...bootstrap, pds });
      else if (this.session && this.session.pds !== pds) await this.save({ ...this.session, pds });
      this.identity = identity;
      return identity;
    })();
    try { return await this.discovering; } finally { this.discovering = undefined; }
  }

  async login(): Promise<BlueskySession> {
    if (this.loggingIn) return { ...await this.loggingIn };
    this.loggingIn = (async () => {
      const identity = await this.discover();
      if (this.session) return this.session;
      if (!this.config.appPassword) throw new PlatformError('A Bluesky app password is required for publishing', { code: 'MissingCredentials' });
      const session = this.decodeSession(await requestJson(this.transport, `${identity.pds}/xrpc/com.atproto.server.createSession`,
        jsonBody({ identifier: this.config.identifier, password: this.config.appPassword }), 'Bluesky login'), identity.pds, identity.did);
      this.identity = { ...identity, handle: session.handle };
      return this.save(session);
    })();
    try { return { ...await this.loggingIn }; } finally { this.loggingIn = undefined; }
  }

  async refreshSession(): Promise<BlueskySession> {
    if (this.refreshing) return { ...await this.refreshing };
    this.refreshing = (async () => {
      const current = await this.login();
      const pds = await this.resolvePds(current.did);
      const refreshed = this.decodeSession(await requestJson(this.transport, `${pds}/xrpc/com.atproto.server.refreshSession`,
        { method: 'POST', headers: { authorization: `Bearer ${current.refreshJwt}` } }, 'Bluesky session refresh'), pds, current.did);
      this.identity = { did: refreshed.did, handle: refreshed.handle, pds };
      return this.save(refreshed);
    })();
    try { return { ...await this.refreshing }; } finally { this.refreshing = undefined; }
  }

  private async authenticated(method: string, options: HttpOptions, operation: string, mutation: boolean): Promise<unknown> {
    const session = await this.login();
    const request = (active: BlueskySession): Promise<unknown> => requestJson(this.transport, `${active.pds}/xrpc/${method}`,
      { ...options, headers: { ...options.headers, authorization: `Bearer ${active.accessJwt}` } }, operation, mutation);
    try { return await request(session); }
    catch (error) {
      const info = object(error);
      if (info?.uncertain !== false || info.status !== 401 || !['ExpiredToken', 'InvalidToken'].includes(String(info.code))) throw error;
      const refreshed = this.session?.accessJwt !== session.accessJwt ? this.session! : await this.refreshSession();
      return request(refreshed);
    }
  }

  async publish(part: PublishPart, context: PublishContext): Promise<RemoteRef> {
    const key = blueskyRecordKey(context.idempotencyKey);
    if (!Array.isArray(part.images) || part.images.length > 4) throw new PlatformError('Bluesky accepts at most four images per part', { code: 'TooManyImages' });
    for (const image of part.images) validateImage(image, 2_000_000);
    const text = part.cw ? `CW: ${part.cw}\n\n${part.text}` : part.text;
    if (typeof text !== 'string' || (!text.trim() && !part.images.length)) throw new PlatformError('Cannot publish an empty Bluesky post', { code: 'EmptyPost' });
    if (Buffer.byteLength(text) > 3000 || Array.from(segmenter.segment(text)).length > 300) throw new PlatformError('Split Bluesky parts before publishing (300 graphemes / 3000 UTF-8 bytes)', { code: 'TextTooLong' });
    let reply: { root: StrongRef; parent: StrongRef } | undefined;
    if (context.parent) {
      const parent = strong({ uri: context.parent.uri ?? context.parent.id, cid: context.parent.cid });
      const rootRef = context.root ?? context.parent;
      const root = strong({ uri: rootRef.uri ?? rootRef.id, cid: rootRef.cid });
      if (!parent || !root) throw new PlatformError('Bluesky replies require root and parent URI/CID strong references', { code: 'InvalidReply' });
      reply = { root, parent };
    } else if (context.root) throw new PlatformError('A thread root without a parent is not a valid reply', { code: 'InvalidReply' });

    const session = await this.login();
    const images: JsonObject[] = [];
    for (const image of part.images) {
      const result = object(await this.authenticated('com.atproto.repo.uploadBlob',
        { method: 'POST', headers: { 'content-type': image.mimeType }, body: image.bytes }, 'Bluesky image upload', true));
      const uploaded = blob(result?.blob);
      if (!uploaded || uploaded.mimeType !== image.mimeType || uploaded.size !== image.bytes.length) throw schemaError('Bluesky image upload', true);
      images.push({ alt: image.alt, image: uploaded, aspectRatio: { width: image.width, height: image.height } });
    }
    const facets = blueskyLinkFacets(text);
    const record: JsonObject = { $type: collection, text, createdAt: this.now().toISOString(),
      ...(facets.length ? { facets } : {}), ...(reply ? { reply } : {}),
      ...(images.length ? { embed: { $type: 'app.bsky.embed.images', images } } : {}) };
    const expectedUri = `at://${session.did}/${collection}/${key}`;
    try {
      const result = object(await this.authenticated('com.atproto.repo.createRecord',
        jsonBody({ repo: session.did, collection, rkey: key, record, validate: true }), 'Bluesky post creation', true));
      if (result?.uri !== expectedUri || !cidValid(result.cid) || result.validationStatus === 'invalid') throw schemaError('Bluesky post creation', true);
      return { id: result.uri, uri: result.uri, cid: result.cid, url: postUrl(result.uri) };
    } catch (error) {
      if (object(error)?.code !== 'RecordAlreadyExists') throw error;
      // Never assume an existing record belongs to us. Compare the entire intended record, excluding its original timestamp.
      try {
        const existing = object(await this.authenticated(`com.atproto.repo.getRecord?${new URLSearchParams({ repo: session.did, collection, rkey: key })}`,
          { method: 'GET' }, 'Bluesky idempotency lookup', false));
        const actual = object(existing?.value);
        if (!actual || existing?.uri !== expectedUri || !cidValid(existing.cid) || !isoDate(actual.createdAt)) throw schemaError('Bluesky idempotency lookup');
        const { createdAt: _actualTime, ...actualContent } = actual;
        const { createdAt: _expectedTime, ...expectedContent } = record;
        if (canonicalJson(actualContent) !== canonicalJson(expectedContent)) throw new PlatformError('The deterministic Bluesky record key already belongs to different content', { code: 'IdempotencyConflict', uncertain: true });
        return { id: existing.uri, uri: existing.uri, cid: existing.cid, url: postUrl(existing.uri) };
      } catch (lookupError) { throw uncertainError('Bluesky idempotency reconciliation', lookupError); }
    }
  }

  async collect(): Promise<SourceSnapshot> {
    const warnings: string[] = [];
    let complete = true;
    let accountId = this.session?.did ?? this.config.identifier;
    const seen = new Map<string, SourcePost>();
    try {
      const identity = await this.discover();
      accountId = identity.did;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < this.maxPages; page++) {
        const query = new URLSearchParams({ actor: identity.did, limit: '100', filter: 'posts_with_replies', includePins: 'false' });
        if (cursor) query.set('cursor', cursor);
        const result = object(await requestJson(this.transport, `${this.publicUrl}/xrpc/app.bsky.feed.getAuthorFeed?${query}`,
          { method: 'GET', maxBytes: 8_000_000 }, 'Bluesky author feed'));
        if (!result || !Array.isArray(result.feed) || result.feed.length > 100 || (own(result, 'cursor') && !nonempty(result.cursor))) {
          complete = false; warnings.push('Bluesky author feed schema is incomplete'); break;
        }
        for (const entry of result.feed) {
          const parsed = parsePost(entry, identity.did, identity.pds);
          if (!parsed.valid) complete = false;
          if (parsed.post) {
            const previous = seen.get(parsed.post.id);
            if (!previous || (previous.repost && !parsed.post.repost)) seen.set(parsed.post.id, parsed.post);
          }
        }
        if (!result.cursor) break;
        const next = result.cursor as string;
        if (result.feed.length === 0 || cursors.has(next)) { complete = false; warnings.push('Bluesky pagination did not make progress'); break; }
        cursors.add(next); cursor = next;
        if (page + 1 === this.maxPages) { complete = false; warnings.push('Bluesky feed exceeded the bounded pagination window'); }
      }
    } catch (error) { complete = false; warnings.push(warning(error)); }
    if (!complete && !warnings.length) warnings.push('Some Bluesky posts have incomplete relation, media or moderation metadata');
    return { platform: this.platform, accountId, posts: [...seen.values()], fetchedAt: this.now().toISOString(), complete, warnings };
  }

  async close(): Promise<void> { this.session = undefined; this.identity = undefined; }
}

export { BlueskyClient as BlueskyPublisher, BlueskyClient as BlueskyCollector };
export const createBlueskyPublisher = (config: BlueskyConfig, transport: Transport, options?: BlueskyOptions): BlueskyClient => new BlueskyClient(config, transport, options);
export const createBlueskyCollector = createBlueskyPublisher;
