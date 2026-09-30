import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { AppConfig } from '../config.js';
import { mapMentionText, type MentionText } from '../mentions.js';
import type { Attachment, Collector, PollSnapshot, SourcePost, SourceSnapshot, TextMention, Transport } from '../types.js';
import { parseXPoll, X_POLL_SELECTOR } from './x-poll.js';
import { object, positiveInteger } from './parse.js';
import { resolveBrowserPlan, verifyBrowserPlan } from './browser.js';
import { buildSessionFile, type SessionFile, type StorageState } from './session.js';

function launchOptionsFor(config: AppConfig['x'], headless: boolean): Parameters<typeof chromium.launchPersistentContext>[1] {
  const plan = resolveBrowserPlan({ choice: config.browser, executablePath: config.executablePath });
  verifyBrowserPlan(plan);
  // X and Google refuse logins from browsers that advertise automation. Playwright adds
  // --enable-automation (which sets navigator.webdriver=true) by default; drop it and the
  // AutomationControlled blink feature so the interactive login is not flagged as a bot.
  const args = ['--disable-blink-features=AutomationControlled'];
  // Chromium's sandbox cannot start as root on Linux; config decides (off for root, on otherwise).
  if (!config.sandbox) args.push('--no-sandbox');
  const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless, serviceWorkers: 'block', viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args,
    chromiumSandbox: config.sandbox,
  };
  if (plan.executablePath) options.executablePath = plan.executablePath;
  else if (plan.channel) options.channel = plan.channel;
  return options;
}

/** A parsed timeline tweet: a SourcePost whose timestamp may still be missing. */
export type TweetFacts = Omit<SourcePost, 'createdAt'> & { createdAt?: string };

const statusPath = /^\/(?:[^/]+)\/status\/(\d+)/;
// t.co is X's link shortener. In the DOM the anchor href is the short link and the visible text
// is a TRUNCATED (…) copy of the real URL, so a truncated link leaks a t.co short link downstream.
// These match the short-link forms so they can be expanded to the real destination via redirects.
const shortLinkPattern = /https?:\/\/t\.co\/[A-Za-z0-9]+/gi;
const isShortLinkHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return host === 't.co' || host.endsWith('.t.co');
};
/**
 * X renders a warning in place of media it considers sensitive. The flag itself lives in the GraphQL
 * payload (`possibly_sensitive` / `tweet_interstitial`), not in a queryable data-testid, and this
 * collector only reads the rendered page — so the user-visible wording is matched, covering the
 * English and Traditional Chinese interfaces (the same approach the other UI states here use).
 *
 * The caller passes the post's UI text with the tweet body REMOVED, so a post that merely writes about
 * sensitive content is not itself treated as flagged.
 */
export function hasSensitiveWarning(chromeText: string): boolean {
  return /(?:may contain|includes?|含有|可能包含|包含)[^。\n]{0,40}(?:sensitive|敏感)/i.test(chromeText)
    || /(?:sensitive content|sensitive material|敏感內容|敏感媒材)/i.test(chromeText);
}
const allowedHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'twimg.com', 'pbs.twimg.com', 'video.twimg.com']);

// X's own player streams HLS from a `blob:` URL, so nothing in the rendered page is downloadable and a
// video post used to be held forever as "no downloadable source". The public syndication endpoint that
// powers embedded tweets returns progressive MP4 renditions of the same tweet, so a video post asks it
// once for a direct source. Best effort by design: every failure path leaves the attachment with no
// url, which is the exact state it replaces, so a broken lookup can never publish the wrong thing.
// ponytail: undocumented embed endpoint, one request per video tweet. If X drops the MP4 renditions
// this degrades to held-again, and the replacement would be an HLS fetch plus remux — far larger.
const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';

/** The token the embed endpoint expects: base36 of the tweet id scaled by pi, with 0s and the dot cut. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

type XVideoSource = Pick<Attachment, 'url' | 'durationSeconds' | 'width' | 'height' | 'animated'>;

/**
 * Choose a downloadable MP4 rendition from a syndication `tweet-result` payload. Pure, so the variant
 * choice is tested without a network. Returns undefined when the tweet carries no video at all.
 *
 * An animated GIF reports `animated: true` with NO url on purpose: on X a GIF also renders as a
 * `<video>`, but this project publishes no animations, so it must stay held rather than be quietly
 * transcoded into one. The rendition picked is the highest bitrate whose estimated bytes still fit the
 * download budget — X offers up to 4K (hundreds of MB) while the pipeline re-encodes to a 1280 long
 * edge regardless, so taking the largest would spend the whole budget to produce the same output.
 */
export function pickVideoSource(payload: unknown, maxDownloadBytes: number): XVideoSource | undefined {
  const details = object(payload)?.mediaDetails;
  if (!Array.isArray(details)) return undefined;
  const media = details.map(object).find(entry => entry?.type === 'video' || entry?.type === 'animated_gif');
  if (!media) return undefined;
  const geometry = object(media.original_info);
  const info = object(media.video_info);
  const millis = info?.duration_millis;
  const source: XVideoSource = {
    animated: media.type === 'animated_gif',
    ...(positiveInteger(geometry?.width) ? { width: geometry.width } : {}),
    ...(positiveInteger(geometry?.height) ? { height: geometry.height } : {}),
    // Rounded up: a clip a fraction over the ceiling must not round down under it.
    ...(typeof millis === 'number' && Number.isFinite(millis) && millis > 0 ? { durationSeconds: Math.ceil(millis / 1000) } : {}),
  };
  if (source.animated || !Array.isArray(info?.variants)) return source;
  const renditions = info.variants.map(object).flatMap(variant => {
    const url = variant?.content_type === 'video/mp4' ? validMediaUrl(typeof variant.url === 'string' ? variant.url : undefined) : undefined;
    return url && positiveInteger(variant?.bitrate) ? [{ url, bitrate: variant.bitrate }] : [];
  }).sort((a, b) => a.bitrate - b.bitrate);
  if (!renditions.length) return source;
  // bitrate is bits per second, so bytes ≈ bitrate / 8 × seconds. With no duration there is no estimate,
  // so fall back to the smallest rendition instead of guessing something past the download cap.
  const affordable = renditions.findLast(r => source.durationSeconds !== undefined && (r.bitrate / 8) * source.durationSeconds <= maxDownloadBytes);
  return { ...source, url: (affordable ?? renditions[0]!).url };
}

/**
 * Hosts the X web app must reach to boot and render. Besides x.com itself, the SPA loads its
 * JS/CSS bundles from *.twimg.com (abs.twimg.com, abs-0.twimg.com) and images from pbs/video.
 * If these are blocked the timeline never renders and the page yields zero tweet elements.
 */
function isAllowedXHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.has(host) || host.endsWith('.x.com') || host.endsWith('.twimg.com') || host.endsWith('.twitter.com');
}

function validMediaUrl(value: string | undefined): string | undefined {
  if (!value) return;
  try { const url = new URL(value); if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) return; return url.href; } catch { return; }
}

/**
 * The <img> in a timeline card points at a downscaled render — pbs.twimg.com serves a size via
 * the `name` query param (name=small / 360x360 / medium), which is why synced photos looked
 * blurry. Rewrite a photo URL to request the original pixels (name=orig); the media pipeline
 * downsizes afterwards to fit each destination, so we start from the sharpest source available.
 * Only pbs.twimg.com photo URLs are rewritten; anything else is returned unchanged.
 */
export function fullSizeImageUrl(value: string | undefined): string | undefined {
  const valid = validMediaUrl(value);
  if (!valid) return valid;
  try {
    const url = new URL(valid);
    const host = url.hostname.toLowerCase();
    if (host !== 'pbs.twimg.com' && !host.endsWith('.pbs.twimg.com')) return valid;
    if (!/^\/media\//.test(url.pathname)) return valid;
    // Keep the encoded format (jpg/png/webp) if present; only force the size to the original.
    url.searchParams.set('name', 'orig');
    return url.href;
  } catch { return valid; }
}

export function parseTweetFacts(input: {
  id: string; url?: string; authorId: string; createdAt?: string; text?: string; labels?: string[]; mentions?: TextMention[];
  statusLinks?: string[]; replyingTo?: string; attachments?: Attachment[]; repost?: boolean; quoteUrl?: string;
  poll?: boolean;
  pollData?: PollSnapshot;
  // The author's own tweet shown directly above this one in a grouped self-thread, detected from the
  // timeline's visual reply connector (see hasReplyConnectorBelow). When set, this post is a known
  // self-reply to that tweet — the strongest signal available, because the Posts timeline omits the
  // "Replying to" header and never embeds the parent status link for in-context continuations.
  threadParentId?: string;
  threadParentAuthor?: string;
}, ownerHandle: string): TweetFacts {
  const ownUrl = input.url;
  const parentLink = (input.statusLinks || []).map(value => {
    try { const url = new URL(value, 'https://x.com'); const match = url.pathname.match(statusPath); return match && match[1] !== input.id && value !== input.quoteUrl ? { url: url.href, id: match[1] } : undefined; } catch { return undefined; }
  }).find(Boolean);
  const replying = input.replyingTo?.match(/@([A-Za-z0-9_]{1,15})/);
  const isReply = Boolean(input.threadParentId || replying || parentLink);
  // A reply is only trustworthy when the parent is actually known: the visual thread connector gives
  // us the parent id outright, and a parsed parent status link does too; a bare "Replying to" without
  // either does not. A post with no reply markers is a known root even without its own status link.
  const relationKnown = !isReply || Boolean(input.threadParentId) || Boolean(parentLink);
  return {
    platform: 'x',
    visibility: 'public',
    id: input.id,
    url: ownUrl,
    authorId: input.authorId || ownerHandle,
    createdAt: input.createdAt,
    text: input.text || '',
    ...(input.mentions ? { mentions: input.mentions } : {}),
    replyToId: input.threadParentId ?? (isReply ? parentLink?.id : null),
    replyToAuthorId: input.threadParentId ? (input.threadParentAuthor ?? input.authorId ?? ownerHandle) : (isReply ? replying?.[1] ?? null : null),
    relationKnown,
    repost: input.repost ?? false,
    quoteUrl: validMediaUrl(input.quoteUrl),
    poll: input.poll === true || input.pollData !== undefined,
    ...(input.pollData ? { pollData: input.pollData } : {}),
    attachments: (input.attachments || []).map(a => ({ ...a, url: validMediaUrl(a.url) })),
    sensitive: Boolean(input.labels?.length),
    metadataComplete: Boolean(input.id && input.authorId && input.createdAt && relationKnown),
  };
}

/** Only a matching profile anchor inside tweetText proves a mention; its text alone does not. */
export function parseTweetText(html: string): MentionText {
  const $ = load(html, {}, false);
  $('[hidden], [aria-hidden="true"], script, style, [data-testid="quoteTweet"], article').remove();
  let text = '';
  const mentions: TextMention[] = [];
  const walk = (nodes: AnyNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') { text += node.data; continue; }
      if (node.type !== 'tag') continue;
      if (node.name === 'br') { text += '\n'; continue; }
      if (node.name === 'img') { text += node.attribs.alt || ''; continue; }
      if (node.name === 'a') {
        const shown = $(node).text();
        let url: URL | undefined;
        try { url = new URL(node.attribs.href || '', 'https://x.com'); } catch { /* Keep malformed links as text. */ }
        const handle = shown.match(/^@([A-Za-z0-9_]{1,15})$/)?.[1];
        const profile = url?.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1];
        if (handle && profile?.toLowerCase() === handle.toLowerCase() && url
          && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && !url.search && !url.hash
          && ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) {
          const start = text.length;
          text += shown;
          mentions.push({ handle, start, end: text.length });
        } else {
          text += url && ['http:', 'https:'].includes(url.protocol) && shown.includes('…') ? url.href : shown;
        }
        continue;
      }
      walk(node.children);
    }
  };
  walk($.root().contents().toArray());
  return { text, mentions };
}

/** The tweet id and author handle from an article's own timestamp permalink. */
async function articleIdentity(article: Locator): Promise<{ id?: string; author: string }> {
  const permalink = await article.locator('a:has(time)').first().getAttribute('href').catch(() => null);
  const path = permalink ? new URL(permalink, 'https://x.com').pathname : '';
  return { id: path.match(statusPath)?.[1], author: path.split('/')[1] || '' };
}

/**
 * X renders progressively after domcontentloaded, so wait until the article count has plateaued (or
 * `ticks` × 500ms pass) before trusting the render. Returns the last count seen.
 */
async function settledArticleCount(page: Page, ticks: number, signal?: AbortSignal): Promise<number> {
  let settled = 0; let lastCount = -1;
  for (let i = 0; i < ticks && !signal?.aborted; i++) {
    const count = await page.locator('article[data-testid="tweet"]').count().catch(() => 0);
    if (count === lastCount) settled++; else { settled = 0; lastCount = count; }
    if (lastCount >= 1 && settled >= 3) break;
    await page.waitForTimeout(500);
  }
  return lastCount;
}

/** Keep the headless browser on X's own hosts and read-only methods. */
async function guardRoutes(page: Page): Promise<void> {
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && isAllowedXHost(url.hostname) && ['GET', 'HEAD'].includes(request.method())) await route.continue();
    else await route.abort();
  });
}

/**
 * Whether the session reads the configured profile. Decided solely by the logged-in account switcher:
 * behind a login/verification wall that control never appears.
 */
async function sessionAuthenticated(page: Page, handle: string): Promise<{ authenticated: boolean }> {
  await page.goto(`https://x.com/${encodeURIComponent(handle)}/with_replies`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  const authenticated = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
  return { authenticated };
}

export class XCollector implements Collector {
  readonly platform = 'x' as const;
  private context?: BrowserContext;
  private page?: Page;
  // Resolved t.co → real URL, kept for the collector's lifetime: the same short link appears across
  // many tweets (and re-appears every scan), so resolve each destination at most once.
  private readonly shortLinks = new Map<string, string | null>();
  // Resolved video source per tweet id (null = looked up, nothing usable). Cached for the collector's
  // lifetime so a tweet re-read on every scan costs at most one syndication request.
  private readonly videoSources = new Map<string, XVideoSource | null>();
  constructor(
    private readonly config: AppConfig['x'],
    private readonly transport?: Transport,
    // Video lookup only happens when video sync is actually on: with it off the post is held as
    // `video_sync_disabled` regardless, so the request would buy nothing.
    private readonly media?: { video: boolean; maxDownloadBytes: number },
  ) {}

  /**
   * Ask the syndication endpoint for a downloadable source for this tweet's video. Every failure —
   * network, non-200, unparseable body, deleted or protected tweet — returns undefined, which leaves
   * the attachment without a url and the post held exactly as it was before this existed.
   */
  private async resolveVideo(tweetId: string, signal?: AbortSignal): Promise<XVideoSource | undefined> {
    if (!this.transport || !this.media?.video) return undefined;
    const cached = this.videoSources.get(tweetId);
    if (cached !== undefined) return cached ?? undefined;
    let resolved: XVideoSource | undefined;
    try {
      const query = new URLSearchParams({ id: tweetId, token: syndicationToken(tweetId), lang: 'en' });
      const response = await this.transport.request(`${SYNDICATION_ENDPOINT}?${query}`, { method: 'GET', timeoutMs: 10_000, maxBytes: 512_000 });
      if (response.status === 200) resolved = pickVideoSource(JSON.parse(Buffer.from(response.body).toString('utf8')), this.media.maxDownloadBytes);
    } catch { /* Held without a source, which is what the caller already handles. */ }
    // A lookup cut short by shutdown is not a real "nothing here"; leave it uncached so the next run retries.
    if (!signal?.aborted) this.videoSources.set(tweetId, resolved ?? null);
    return resolved;
  }

  /**
   * Expand every t.co short link in `text` to its real destination. X only exposes the real URL as
   * truncated display text, so the DOM leaves a bare `https://t.co/xxxx` in the text; left alone it
   * reaches every downstream platform. Each short link is resolved by reading the redirect Location
   * (without fetching the destination body), following at most a few hops in case a link chains
   * through another shortener. A link that cannot be resolved is left as-is rather than dropped.
   */
  private async resolveShortLinks(body: MentionText, signal?: AbortSignal): Promise<MentionText> {
    if (!this.transport) return body;
    const unique = new Set(body.text.match(shortLinkPattern) ?? []);
    for (const short of unique) {
      if (this.shortLinks.has(short) || signal?.aborted) continue;
      this.shortLinks.set(short, await this.expandShortLink(short, signal));
    }
    return mapMentionText(body, text => text.replace(shortLinkPattern, match => this.shortLinks.get(match) || match));
  }

  /** Follow t.co redirects (Location only, never the body) up to a few hops; null if unresolvable. */
  private async expandShortLink(short: string, signal?: AbortSignal): Promise<string | null> {
    let current = short;
    for (let hop = 0; hop < 4; hop++) {
      if (signal?.aborted) return null;
      let response;
      try {
        response = await this.transport!.request(current, { method: 'HEAD', followRedirects: false, timeoutMs: 8_000, maxBytes: 65_536 });
      } catch { return null; }
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        // Reached a non-redirect: only accept it if we actually moved off the shortener.
        return current !== short ? current : null;
      }
      let next: URL;
      try { next = new URL(location, current); } catch { return null; }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') return null;
      // Landed on the real destination (no longer a shortener): that is the resolved URL.
      if (!isShortLinkHost(next.hostname)) return next.href;
      current = next.href;
    }
    return null;
  }

  /**
   * True when this timeline article draws the vertical thread connector below its avatar — X's visual
   * marker that a reply is shown directly beneath it. On a profile's Posts timeline only the author's
   * own self-threads are grouped this way, so a connector-below means the very next tweet is this
   * post's self-reply. That adjacency is how a self-thread continuation is linked to its parent: the
   * Posts timeline omits the "Replying to" header and never embeds the parent's status link for these
   * in-context continuations, so without this connector every self-reply looks like a fresh root and
   * syncs to the other platforms as a separate, unthreaded post.
   */
  private async hasReplyConnectorBelow(article: Locator): Promise<boolean> {
    return article.evaluate((node: Element) => {
      const avatar = node.querySelector('[data-testid="Tweet-User-Avatar"]');
      if (!avatar) return false;
      const scope = node.closest('[data-testid="cellInnerDiv"]') ?? node;
      const ar = avatar.getBoundingClientRect();
      // The connector is a thin, childless styled <div>. Measure only leaf divs (a full-DOM
      // getBoundingClientRect sweep on X's heavy tweet markup is what made the scan crawl), and only
      // those in the avatar's column that run on below it — the marker that a reply sits beneath.
      for (const div of Array.from(scope.querySelectorAll('div'))) {
        if (div.childElementCount) continue;
        const r = div.getBoundingClientRect();
        if (r.width > 0 && r.width <= 4 && r.height >= 20
          && r.left >= ar.left - 8 && r.right <= ar.right + 8
          && r.bottom >= ar.bottom + 8) return true;
      }
      return false;
    }).catch(() => false);
  }

  /**
   * Parse one rendered tweet <article> into TweetFacts. `ctx.own`/`ctx.authorId` come from the
   * caller's permalink parse; `threadParentId`/`threadParentAuthor`, when set, link a self-thread
   * continuation to the tweet above it. Returns the facts plus the article's plain text so the
   * caller can do its own pinned/oldest bookkeeping. Shared by the timeline scan and the thread
   * expansion below so both read a tweet identically.
   */
  private async parseArticle(article: Locator, ctx: { own: string; authorId: string; threadParentId?: string; threadParentAuthor?: string }, signal?: AbortSignal): Promise<{ parsed: TweetFacts; articleText: string }> {
    const { own, authorId } = ctx;
    const links = await article.locator('a[href*="/status/"]').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
    const time = await article.locator('time').getAttribute('datetime').catch(() => null);
    // X truncates a link's DISPLAY text ("youtube.com/watch…") while the real destination is the
    // anchor href. Reading innerText would sync the broken truncated string, so reconstruct the
    // text from the tweetText node: use each <a>'s href for external links, keep emoji alt text,
    // and keep visible text for everything else.
    const textHtml = await article.evaluate((node: Element) => {
      const body = Array.from(node.querySelectorAll('[data-testid="tweetText"]'))
        .find(element => element.closest('article') === node && !element.closest('[data-testid="quoteTweet"]'));
      return body?.innerHTML || '';
    }).catch(() => '');
    const body = parseTweetText(textHtml);
    const text = body.text;
    const articleText = await article.innerText().catch(() => '');
    const replyMatch = articleText.match(/Replying to\s+(@[A-Za-z0-9_]{1,15})/i);
    // A link-preview card puts its destination only in the card, not the tweet text. Capture it
    // so a card-only tweet still carries its link downstream.
    const cardHref = await article.locator('[data-testid="card.wrapper"] a[href^="http"], a[data-testid="card.layoutLarge.media"], a[data-testid="card.layoutSmall.media"]').first().getAttribute('href').catch(() => null);
    const images = await article.locator('[data-testid="tweetPhoto"] img').evaluateAll(nodes => nodes.map(node => ({ url: (node as HTMLImageElement).src, alt: (node as HTMLImageElement).alt || '' })));
    const hasVideo = await article.locator('[data-testid="videoPlayer"], video').count() > 0;
    // cardPoll is the current rendered widget; preserve its entire choice list in one read so
    // percentages cannot be paired with labels from a different render. No vote/reveal action.
    const pollRead = await article.evaluate((node: Element, selector: string) => {
      const clone = node.cloneNode(true) as Element;
      clone.querySelectorAll('[data-testid="quoteTweet"], article, [data-testid="tweetText"]').forEach(element => element.remove());
      const detected = clone.querySelector(selector) !== null;
      if (!detected) return { detected: false, html: '', capturedAt: new Date().toISOString() };
      clone.querySelectorAll('script, style, svg').forEach(element => element.remove());
      for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
          if (!['role', 'data-testid', 'dir', 'aria-label', 'aria-hidden', 'aria-checked', 'aria-disabled', 'aria-posinset', 'aria-setsize', 'alt', 'hidden', 'disabled'].includes(attribute.name)) element.removeAttribute(attribute.name);
        }
      }
      return { detected: true, html: clone.outerHTML, capturedAt: new Date().toISOString() };
    }, X_POLL_SELECTOR);
    const parsedPoll = pollRead.detected ? parseXPoll(pollRead.html, pollRead.capturedAt) : undefined;
    const hasPoll = pollRead.detected;
    const pollData = parsedPoll?.pollData;
    // Read the post's UI text with the tweet body removed: the sensitive-media warning lives in the
    // media chrome, and a post that merely writes about sensitive content must not be flagged.
    const chromeText = await article.evaluate((node: Element) => {
      const clone = node.cloneNode(true) as Element;
      clone.querySelectorAll('[data-testid="tweetText"]').forEach(element => element.remove());
      return (clone as HTMLElement).innerText || '';
    }).catch(() => '');
    const sensitive = hasSensitiveWarning(chromeText);
    // Request the original pixels (name=orig) rather than the blurry timeline thumbnail.
    const media: Attachment[] = images.map(image => ({ kind: 'image' as const, url: fullSizeImageUrl(image.url), alt: image.alt }));
    if (hasVideo) media.push({ kind: 'video', alt: '', ...await this.resolveVideo(own, signal) });
    // A quote links to a DIFFERENT tweet id. Compare the parsed status id, not the raw path:
    // a tweet's own sub-pages (/analytics, /likes, /retweets, /photo/1) share the same id and
    // must not be mistaken for a quoted tweet. Only a link whose status id differs is a quote.
    const quote = links.find(value => { try { const qid = new URL(value).pathname.match(statusPath)?.[1]; return Boolean(qid) && qid !== own; } catch { return false; } });
    // A card link that is not a quoted tweet and not already in the text is the tweet's only URL;
    // append it so it survives the sync. (Quote cards are handled via quoteUrl, not here.)
    let bodyText = text;
    if (cardHref && !text.includes(cardHref)) {
      try {
        // Skip the card only if it points at THIS tweet (a self sub-page); any other card is an
        // external link worth keeping. A quoted tweet is a different id and handled via quoteUrl.
        const cardId = new URL(cardHref).pathname.match(statusPath)?.[1];
        if (!cardId || cardId === own) bodyText = text ? `${text}\n${cardHref}` : cardHref;
      } catch { /* ignore malformed card href */ }
    }
    // Expand any t.co short link the DOM left in the text to its real destination before the
    // post is handed downstream, so other platforms show the real URL, not a t.co short link.
    const resolved = await this.resolveShortLinks({ text: bodyText, mentions: body.mentions }, signal);
    const parsed = parseTweetFacts({ id: own, url: `https://x.com/${this.config.handle}/status/${own}`, authorId, createdAt: time || undefined, text: resolved.text, mentions: resolved.mentions, replyingTo: replyMatch?.[1], statusLinks: links, attachments: media, repost: authorId.toLowerCase() !== this.config.handle.toLowerCase() || /reposted by/i.test(articleText), quoteUrl: quote, poll: hasPoll, pollData, labels: sensitive ? ['sensitive_media'] : undefined, threadParentId: ctx.threadParentId, threadParentAuthor: ctx.threadParentAuthor }, this.config.handle);
    return { parsed, articleText };
  }

  /**
   * Read the full self-thread from a root's status page. The Posts timeline only renders a
   * truncated preview of a self-thread (the root plus its first reply, then "Show this thread"),
   * so continuations past the first live only here. Starting at the root, take each consecutive
   * article authored by the same handle, linking it to the previous one, and stop at the first
   * tweet by anyone else (where the author's own thread ends and other people's replies begin).
   * Continuations already collected on the timeline are skipped via `seen`.
   */
  private async collectThreadTail(page: Page, rootId: string, seen: Set<string>, signal?: AbortSignal): Promise<TweetFacts[]> {
    const url = `https://x.com/${encodeURIComponent(this.config.handle)}/status/${rootId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settledArticleCount(page, 20, signal);
    const out: TweetFacts[] = [];
    let prevId: string | undefined; let started = false;
    for (const article of await page.locator('article[data-testid="tweet"]').all()) {
      if (signal?.aborted) break;
      const { id, author } = await articleIdentity(article);
      if (!id) continue;
      if (!started) { if (id === rootId) { started = true; prevId = rootId; } continue; }
      // The author's own thread runs as an unbroken same-author chain right after the root; the
      // first tweet by anyone else marks the reply section, where the self-thread ends.
      if (author.toLowerCase() !== this.config.handle.toLowerCase()) break;
      if (!seen.has(id)) {
        seen.add(id);
        const { parsed } = await this.parseArticle(article, { own: id, authorId: author, threadParentId: prevId, threadParentAuthor: this.config.handle }, signal);
        out.push(parsed);
      }
      prevId = id;
    }
    return out;
  }

  private async browserPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    // The previous context died (Chromium crash, OOM kill, external close). A stale cached
    // reference would fail every scan forever, so clear the remnants and relaunch below.
    if (this.context || this.page) await this.close().catch(() => undefined);
    const launchOptions = launchOptionsFor(this.config, this.config.headless);
    this.context = await chromium.launchPersistentContext(this.config.profileDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    await guardRoutes(this.page);
    return this.page;
  }

  async collect(since?: string, signal?: AbortSignal): Promise<SourceSnapshot> {
    try {
      return await this.attempt(since, signal);
    } catch (error) {
      const message = (error as { message?: string })?.message || '';
      // A deliberate shutdown abort is not a browser crash — do not relaunch, just surface it so
      // the cycle ends promptly and the checkpoint is left untouched.
      if (signal?.aborted && /aborted/i.test(message)) throw error;
      if (!/Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(message)) throw error;
      // The long-lived browser died mid-scan (crash or OOM kill). Reset and retry once with a
      // fresh context so one crash costs a relaunch, not a permanently failing collector.
      await this.close().catch(() => undefined);
      const snapshot = await this.attempt(since, signal);
      snapshot.warnings.push('X browser context was closed mid-scan and had to be relaunched (Chromium crash or OOM kill?)');
      return snapshot;
    }
  }

  private async attempt(since?: string, signal?: AbortSignal): Promise<SourceSnapshot> {
    if (signal?.aborted) throw new Error('X collection aborted before start');
    const fetchedAt = new Date().toISOString();
    const page = await this.browserPage();
    // Read the main profile timeline, NOT /with_replies. Verified against the live account: the
    // main timeline reliably renders the newest top-level tweets (today's posts appeared at once),
    // while /with_replies served a stale, days-old view that never surfaced recent posts — which
    // is exactly why collection kept reporting an old `newest`. The Posts timeline also groups the
    // author's own self-threads (root + continuations); hasReplyConnectorBelow links each
    // continuation to its parent so they sync as a thread, not as separate posts.
    const url = `https://x.com/${encodeURIComponent(this.config.handle)}`;
    // The collector reuses one long-lived page. X is an SPA that does not auto-refresh, and a goto
    // to the URL it is already on can serve a stale cached timeline, so force a reload when we are
    // already there to make X refetch the current timeline every cycle.
    // Only the exact profile URL may be reloaded; thread expansion leaves this page at /status/….
    const alreadyThere = page.url() === url;
    if (alreadyThere) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title(); const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (/log in|sign in|challenge|unusual activity|suspended/i.test(`${title}\n${bodyText}`)) throw new Error('X session is not authenticated or is challenged; no checkpoint advanced');
    // X is a client-side app and renders the timeline progressively after domcontentloaded.
    // Reading at the instant the FIRST article appears can catch a partial screenful — e.g. an
    // older tweet rendered before the newest one — and the watermark check below would then
    // declare the gap covered against an incomplete window, silently blind to the newest post.
    // So wait until the article count has plateaued (or ~15s cap) before trusting the render.
    const lastCount = await settledArticleCount(page, 30, signal);
    // An inline failure replaces the timeline with an error box. A healthy render shows several
    // articles, so only probe for X's error wording when almost nothing rendered — a tweet that
    // merely quotes the phrase must not fail the scan.
    if (lastCount <= 2) {
      const columnText = await page.locator('[data-testid="primaryColumn"]').innerText({ timeout: 2_000 }).catch(() => '');
      if (/something went wrong|try reloading|發生錯誤|請嘗試重新載入|無法載入/i.test(columnText)) {
        throw new Error('X timeline rendered an inline error state ("Something went wrong / Try reloading"); no checkpoint advanced');
      }
    }
    // A logged-out/stale session serves a short public preview (a few tweets, infinite scroll
    // blocked) with no login WORDS, so the regex above misses it. Require a positive signed-in
    // signal — the account switcher or compose button only render for an authenticated session —
    // otherwise we would silently treat a truncated preview as a complete, up-to-date timeline.
    const signedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="SideNav_NewTweet_Button"], [aria-label="Post"]').first().count().catch(() => 0);
    if (!signedIn) throw new Error('X session appears logged out (no account/compose controls rendered); re-run login or upload a fresh session. No checkpoint advanced');
    const seen = new Set<string>(); const facts: TweetFacts[] = [];
    let stableRounds = 0; let previousCount = 0;
    let oldest: string | undefined;
    let reachedWatermark = !since; // first scan (no watermark): the scroll budget is the natural bound
    // A tweet's connector state does not change within one scan, but every round re-reads the whole
    // timeline from the top, so cache the geometry probe per tweet-id and pay for it once instead of
    // once-per-round — the repeated layout sweeps were what stalled a live scan for minutes.
    const connector = new Map<string, boolean>();
    // Roots of a self-thread seen on the Posts timeline. The timeline only renders a truncated
    // preview of a self-thread (root + first reply, then "Show this thread"), so the continuations
    // past the first are collected afterwards from each root's own thread page.
    const threadRoots = new Set<string>();
    for (let round = 0; round < this.config.maxPages; round++) {
      const articles = await page.locator('article[data-testid="tweet"]').all();
      // The author's own tweet immediately above the current one in DOM order, carrying whether it
      // renders a reply connector below it. Reset each round because every round re-reads the whole
      // rendered timeline from the top, so this always reflects true visual adjacency — even when the
      // article above was parsed in an earlier round (and is skipped as `seen` this round).
      let prev: { id: string; author: string; replyBelow: boolean } | undefined;
      for (const article of articles) {
        const { id: own, author: authorId } = await articleIdentity(article);
        // A self-thread continuation is the tweet directly under a same-author tweet that draws the
        // reply connector below it. Compute this before the `seen` short-circuit so `prev` tracks true
        // DOM adjacency across rounds; only the same author threads (a reply to someone else never
        // reaches the Posts timeline).
        let replyBelow = false;
        if (own) {
          const cached = connector.get(own);
          replyBelow = cached ?? await this.hasReplyConnectorBelow(article);
          if (cached === undefined) connector.set(own, replyBelow);
        }
        const threadParent = own && prev?.replyBelow && prev.author.toLowerCase() === authorId.toLowerCase()
          ? { id: prev.id, author: prev.author } : undefined;
        if (own) prev = { id: own, author: authorId, replyBelow };
        if (!own || seen.has(own)) continue;
        seen.add(own);
        const { parsed, articleText } = await this.parseArticle(article, { own, authorId, threadParentId: threadParent?.id, threadParentAuthor: threadParent?.author }, signal);
        if (!/pinned|置頂/i.test(articleText) && parsed.createdAt && (!oldest || parsed.createdAt < oldest)) oldest = parsed.createdAt;
        facts.push(parsed);
        // A root drawing a reply connector below it has a self-thread whose continuations past the
        // first are truncated off the Posts timeline; remember it so the thread page can be opened
        // after the scan to collect the rest.
        if (!threadParent && parsed.replyToId === null && replyBelow) threadRoots.add(own);
      }
      // The gap since the last fetch is covered only once the oldest tweet seen is at/older than
      // the watermark AND the render has stopped growing. The no-growth condition matters:
      // breaking in the very first round against a partially rendered timeline is exactly how a
      // slow render used to masquerade as "nothing new since the watermark".
      if (seen.size === previousCount) stableRounds++; else stableRounds = 0;
      previousCount = seen.size;
      if (since && oldest && oldest <= since && stableRounds >= 1) { reachedWatermark = true; break; }
      if (stableRounds >= 2) break;
      // A shutdown can arrive mid-scroll; stop paging so the cycle ends and the process can exit.
      // What was already parsed is returned as a budget-limited snapshot (checkpoint advances to
      // the oldest post reached), so an abort costs nothing beyond a shorter scan.
      if (signal?.aborted) break;
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(800);
    }
    // The Posts timeline shows only a truncated preview of each self-thread (root + first reply),
    // so open every detected root's own thread page and collect the same-author continuations past
    // the first. Without this the engine never sees reply #2 onward and syncs a partial thread.
    for (const rootId of threadRoots) {
      if (signal?.aborted) break;
      const tail = await this.collectThreadTail(page, rootId, seen, signal);
      for (const parsed of tail) {
        facts.push(parsed);
        if (parsed.createdAt && (!oldest || parsed.createdAt < oldest)) oldest = parsed.createdAt;
      }
    }
    if (!facts.length) {
      // Distinguish a genuinely empty timeline from a page that never rendered any tweet element
      // (blocked assets, layout change, or a too-early read), so the log points at the real cause.
      const sawArticles = await page.locator('article[data-testid="tweet"]').count();
      throw new Error(sawArticles > 0
        ? 'X page rendered tweets but none were parseable (tweet layout may have changed); no checkpoint advanced'
        : 'X page rendered no tweet elements (assets blocked, empty timeline, or slow render); no checkpoint advanced');
    }
    const posts = facts.filter((f): f is SourcePost => Boolean(f.createdAt));
    if (reachedWatermark) return { platform: 'x', accountId: this.config.handle, posts, fetchedAt, complete: true, warnings: [] };
    // Budget exhausted before reaching the watermark. The posts parsed fine — we just did not
    // scroll back far enough. Report `oldest` as the watermark so the engine advances the
    // checkpoint to there (breaking the re-scroll loop) instead of pinning it and failing forever.
    // Posts older than `oldest` this round are skipped; raising X_MAX_PAGES or scanning more often
    // is the real remedy for a persistent backlog.
    return {
      platform: 'x', accountId: this.config.handle, posts, fetchedAt, complete: false,
      watermark: oldest,
      warnings: [oldest
        ? `X backlog exceeded the scroll budget; advanced the checkpoint to ${oldest} and skipped anything older this round (raise X_MAX_PAGES or scan more often)`
        : 'X timeline exposed no dated, non-pinned post (render incomplete or layout changed)'],
    };
  }
  async close(): Promise<void> { await this.context?.close(); this.context = undefined; this.page = undefined; }
}

/**
 * One-time interactive login. Opens a visible browser on the SAME persistent profile the
 * headless collector uses, navigates to X, and returns once the profile is authenticated
 * (or the caller signals done). Cookies are written to profileDir on context close, so all
 * later headless scans reuse the session. This never posts — it only establishes read access.
 */
export async function loginInteractive(
  config: AppConfig['x'],
  options: { waitForEnter: () => Promise<void>; log?: (message: string) => void } ,
): Promise<{ authenticated: boolean }> {
  const log = options.log ?? (() => {});
  const context = await chromium.launchPersistentContext(config.profileDir, launchOptionsFor(config, false));
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    log('瀏覽器已開啟。請在該視窗完成 X 登入（帳號、密碼、兩步驟驗證都做完，看到首頁時間軸為止）。');
    log('完成後回到這個終端機按 Enter，工具會儲存登入狀態並關閉瀏覽器。');
    await options.waitForEnter();
    // Verify the session actually reads the target profile without hitting a login wall.
    return await sessionAuthenticated(page, config.handle);
  } finally {
    await context.close();
  }
}

/**
 * Export the X login from an already-logged-in profile as a portable session file.
 * Runs headless (only reads cookies); throws if the profile holds no X auth cookie.
 */
export async function exportSession(config: AppConfig['x']): Promise<SessionFile> {
  const context = await chromium.launchPersistentContext(config.profileDir, launchOptionsFor(config, true));
  try {
    const state = await context.storageState() as StorageState;
    return buildSessionFile(state, config.handle);
  } finally {
    await context.close();
  }
}

/**
 * Install a validated session file into the headless profile on this machine by seeding its
 * cookies into the persistent context, then closing so they persist to disk. Used on a
 * GUI-less server that received the file over Telegram or scp. Returns whether the seeded
 * session actually reads the profile without hitting a login wall.
 */
export async function installSession(config: AppConfig['x'], file: SessionFile): Promise<{ authenticated: boolean }> {
  if (!config.enabled) throw new Error('X_ENABLED is false; enable X before importing');
  if (file.handle && file.handle.toLowerCase() !== config.handle.toLowerCase()) throw new Error('Session belongs to a different configured X handle');
  const context = await chromium.launchPersistentContext(config.profileDir, launchOptionsFor(config, true));
  try {
    await context.addCookies(file.state.cookies);
    const page = context.pages()[0] || await context.newPage();
    await guardRoutes(page);
    return await sessionAuthenticated(page, config.handle);
  } finally {
    await context.close();
  }
}
