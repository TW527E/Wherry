import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import { contentWarning, isSensitiveContent } from '../content-warning.js';
import type { HttpOptions, PreparedMedia, PublishContext, PublishPart, Publisher, RemoteRef, Transport } from '../types.js';
import { htmlEscape } from '../text.js';
import { PlatformError, httpsBase, multipart, object, positiveInteger, requestJson, schemaError, webUrl } from './parse.js';

export type ArgonConfig = AppConfig['argon'];
interface UploadedMedia { id: number; url: string; item: PreparedMedia }

/** A bare URL in the body becomes a link; trailing punctuation stays text, as `cleanXLinks` reads it. */
const URL_PATTERN = /https?:\/\/[^\s<>"'「」『』（）【】]+/gu;
const TRAILING_PUNCTUATION = /[.,!?;:，。！？；：)\]}]+$/u;

function inline(text: string): string {
  let html = '', cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const trailing = match[0].match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = match[0].slice(0, match[0].length - trailing.length);
    html += htmlEscape(text.slice(cursor, match.index));
    html += webUrl(url) ? `<a href="${htmlEscape(url)}">${htmlEscape(url)}</a>` : htmlEscape(url);
    cursor = match.index + url.length;
  }
  return (html + htmlEscape(text.slice(cursor))).replaceAll('\n', '<br>');
}

/** Blank lines separate paragraphs, single line breaks stay breaks, as the post read on X. */
function paragraphs(text: string): string[] {
  return text.split(/\n[^\S\n]*\n\s*/u).map(block => block.trim()).filter(Boolean)
    .map(block => `<!-- wp:paragraph -->\n<p>${inline(block)}</p>\n<!-- /wp:paragraph -->`);
}

function mediaBlock({ id, url, item }: UploadedMedia): string {
  const src = htmlEscape(url);
  if (item.mimeType !== 'video/mp4') {
    return `<!-- wp:image {"id":${id},"sizeSlug":"full","linkDestination":"none"} -->\n<figure class="wp-block-image size-full"><img src="${src}" alt="${htmlEscape(item.alt)}" class="wp-image-${id}"/></figure>\n<!-- /wp:image -->`;
  }
  // An X GIF loops silently like the original rather than waiting behind a play button.
  return item.animated
    ? `<!-- wp:video {"id":${id},"autoplay":true,"controls":false,"loop":true,"muted":true,"playsInline":true} -->\n<figure class="wp-block-video"><video autoplay loop muted src="${src}" playsinline></video></figure>\n<!-- /wp:video -->`
    : `<!-- wp:video {"id":${id}} -->\n<figure class="wp-block-video"><video controls src="${src}"></video></figure>\n<!-- /wp:video -->`;
}

/** WordPress `date_gmt` is a bare UTC time; a future one would schedule the 說說 instead of publishing it. */
function gmtDate(value: string | undefined, now: Date): string | undefined {
  const time = value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(time) && time <= now.getTime() ? new Date(time).toISOString().slice(0, 19) : undefined;
}

/**
 * Publishes to the `shuoshuo` (說說) post type of the Argon WordPress theme through the core REST API,
 * signed in with an Application Password. Argon registers the post type without `show_in_rest`, so the
 * site must expose it first (see docs/configuration.md); until then every call answers 404.
 */
export class ArgonClient implements Publisher {
  readonly destination = 'argon' as const;
  private readonly api: string;
  private readonly authorization: string;
  constructor(private readonly config: ArgonConfig, private readonly transport: Transport, private readonly now: () => Date = () => new Date()) {
    this.api = `${httpsBase(config.baseUrl, 'ARGON_URL')}/wp-json/wp/v2`;
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.appPassword}`, 'utf8').toString('base64')}`;
  }

  /** A 404 on a route this client calls means the site never exposed 說說 to the REST API. */
  private async call(url: string, options: HttpOptions, operation: string, mutation: boolean): Promise<unknown> {
    try { return await requestJson(this.transport, url, options, operation, mutation); } catch (error) {
      if (error instanceof PlatformError && error.status === 404 && /rest_no_route|No route was found/i.test(error.message)) {
        throw new PlatformError(`${operation}: the site has no such REST route; enable show_in_rest for the shuoshuo post type (see docs/configuration.md)`, { status: 404, code: 'rest_no_route' });
      }
      throw error;
    }
  }

  private async upload(item: PreparedMedia, index: number): Promise<UploadedMedia> {
    const ext = item.mimeType === 'video/mp4' ? 'mp4' : item.mimeType === 'image/png' ? 'png' : 'jpg';
    const bytes = item.mimeType === 'video/mp4' ? await readFile(item.path) : item.bytes;
    const form = multipart({ alt_text: item.alt }, [{ field: 'file', filename: `wherry-${item.sha256.slice(0, 16)}-${index}.${ext}`, mimeType: item.mimeType, bytes }]);
    // Like a Telegram album, give the server time to take the bytes in (0.5 MB/s) beyond a flat 30 s. An
    // upload is not the 說說 itself: repeating one costs at most a spare library file, never a duplicate
    // post, so a lost answer here is an ordinary failure to retry, not an uncertain delivery to reconcile.
    const result = object(await this.call(`${this.api}/media`, { method: 'POST', body: form.body, maxBytes: 2_000_000,
      headers: { authorization: this.authorization, 'content-type': form.contentType, accept: 'application/json' },
      timeoutMs: 30_000 + Math.ceil(form.body.length / 500) }, 'Argon media upload', false));
    const url = webUrl(result?.source_url);
    if (!result || !positiveInteger(result.id) || !url) throw schemaError('Argon media upload');
    return { id: result.id, url, item };
  }

  async publish(part: PublishPart, _context: PublishContext): Promise<RemoteRef> {
    const sections = part.sections ?? [{ text: part.text, media: part.media }];
    const blocks: string[] = [];
    let index = 0;
    for (const section of sections) {
      blocks.push(...paragraphs(section.text));
      for (const item of section.media) blocks.push(mediaBlock(await this.upload(item, index++)));
    }
    if (!blocks.length) throw new PlatformError('An Argon 說說 needs text or media', { code: 'EmptyContent' });
    let body = blocks.join('\n\n');
    // WordPress has no content warning, so a sensitive 說說 folds everything, media included, behind one.
    if (isSensitiveContent(part)) {
      body = `<!-- wp:details -->\n<details class="wp-block-details"><summary>${htmlEscape(`CW: ${contentWarning(part)}`)}</summary>${body}</details>\n<!-- /wp:details -->`;
    }
    const sourceUrl = part.sourceUrl?.replace('https://fixupx.com/', 'https://x.com/');
    if (sourceUrl && this.config.signature) body += `\n\n${this.config.signature.replaceAll('{url}', htmlEscape(sourceUrl))}`;
    const date = gmtDate(part.backdate, this.now());
    const result = object(await this.call(`${this.api}/shuoshuo`, {
      method: 'POST', headers: { authorization: this.authorization, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ status: 'publish', title: '', content: body, ...(date ? { date_gmt: date } : {}) }),
    }, 'Argon create 說說', true));
    const url = webUrl(result?.link);
    if (!result || !positiveInteger(result.id) || !url || result.type !== 'shuoshuo') throw schemaError('Argon create 說說', true);
    return { id: String(result.id), url };
  }

  /** Moves the 說說 to the WordPress trash, where it can still be restored; its media stay in the library. */
  async retract(ref: RemoteRef): Promise<void> {
    if (!/^[1-9]\d*$/.test(ref.id)) throw new PlatformError('Not an Argon 說說 reference', { code: 'InvalidReference' });
    try {
      await this.call(`${this.api}/shuoshuo/${ref.id}`, { method: 'DELETE', headers: { authorization: this.authorization, accept: 'application/json' } }, 'Argon trash 說說', true);
    } catch (error) {
      // 404 rest_post_invalid_id: deleted by hand already. 410 rest_already_trashed: in the trash already.
      if (!(error instanceof PlatformError && (error.status === 410 || (error.status === 404 && error.code !== 'rest_no_route')))) throw error;
    }
  }
}
