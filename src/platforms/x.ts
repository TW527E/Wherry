import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { AppConfig } from '../config.js';
import type { Attachment, Collector, SourcePost, SourceSnapshot, Transport } from '../types.js';
import { resolveBrowserPlan, verifyBrowserPlan, type BrowserPlan } from './browser.js';
import { buildSessionFile, type SessionFile, type StorageState } from './session.js';

export function launchOptionsFor(config: AppConfig['x'], headless: boolean): Parameters<typeof chromium.launchPersistentContext>[1] {
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

export interface TweetFacts {
  id: string;
  url?: string;
  authorId: string;
  createdAt?: string;
  text: string;
  replyToId?: string | null;
  replyToAuthorId?: string | null;
  relationKnown: boolean;
  repost: boolean;
  quoteUrl?: string;
  attachments: Attachment[];
  sensitive: boolean;
  metadataComplete: boolean;
}

const statusPath = /^\/(?:[^/]+)\/status\/(\d+)/;
// t.co is X's link shortener. In the DOM the anchor href is the short link and the visible text
// is a TRUNCATED (…) copy of the real URL, so a truncated link leaks a t.co short link downstream.
// These match the short-link forms so they can be expanded to the real destination via redirects.
const shortLinkPattern = /https?:\/\/t\.co\/[A-Za-z0-9]+/gi;
const isShortLinkHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return host === 't.co' || host.endsWith('.t.co');
};
const allowedHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'twimg.com', 'pbs.twimg.com', 'video.twimg.com']);

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
  id: string; url?: string; authorId: string; createdAt?: string; text?: string; labels?: string[];
  statusLinks?: string[]; replyingTo?: string; attachments?: Attachment[]; repost?: boolean; quoteUrl?: string;
}, ownerHandle: string): TweetFacts {
  const ownUrl = input.url;
  const parentLink = (input.statusLinks || []).map(value => {
    try { const url = new URL(value, 'https://x.com'); const match = url.pathname.match(statusPath); return match && match[1] !== input.id && value !== input.quoteUrl ? { url: url.href, id: match[1] } : undefined; } catch { return undefined; }
  }).find(Boolean);
  const replying = input.replyingTo?.match(/@([A-Za-z0-9_]{1,15})/);
  const isReply = Boolean(replying || parentLink);
  // A post with no reply markers is a known root even when the DOM did not expose its own status link.
  // A reply is only trustworthy when the parent status link was actually parsed.
  const relationKnown = !isReply || Boolean(parentLink);
  return {
    id: input.id,
    url: ownUrl,
    authorId: input.authorId || ownerHandle,
    createdAt: input.createdAt,
    text: input.text || '',
    replyToId: isReply ? parentLink?.id : null,
    replyToAuthorId: isReply ? replying?.[1] ?? null : null,
    relationKnown,
    repost: input.repost ?? false,
    quoteUrl: validMediaUrl(input.quoteUrl),
    attachments: (input.attachments || []).map(a => ({ ...a, url: validMediaUrl(a.url) })),
    sensitive: Boolean(input.labels?.length),
    metadataComplete: Boolean(input.id && input.authorId && input.createdAt && relationKnown),
  };
}

export class XCollector implements Collector {
  readonly platform = 'x' as const;
  private context?: BrowserContext;
  private page?: Page;
  private plan?: BrowserPlan;
  // Resolved t.co → real URL, kept for the collector's lifetime: the same short link appears across
  // many tweets (and re-appears every scan), so resolve each destination at most once.
  private readonly shortLinks = new Map<string, string | null>();
  constructor(private readonly config: AppConfig['x'], private readonly transport?: Transport) {}

  /**
   * Expand every t.co short link in `text` to its real destination. X only exposes the real URL as
   * truncated display text, so the DOM leaves a bare `https://t.co/xxxx` in the text; left alone it
   * reaches every downstream platform. Each short link is resolved by reading the redirect Location
   * (without fetching the destination body), following at most a few hops in case a link chains
   * through another shortener. A link that cannot be resolved is left as-is rather than dropped.
   */
  private async resolveShortLinks(text: string, signal?: AbortSignal): Promise<string> {
    if (!this.transport || !shortLinkPattern.test(text)) return text;
    const unique = new Set(text.match(shortLinkPattern) ?? []);
    for (const short of unique) {
      if (this.shortLinks.has(short) || signal?.aborted) continue;
      this.shortLinks.set(short, await this.expandShortLink(short, signal));
    }
    return text.replace(shortLinkPattern, match => this.shortLinks.get(match) || match);
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

  /** Resolved browser plan; available after the first collect or an explicit `browserPlan()` call. */
  browserPlan(): BrowserPlan | undefined { return this.plan; }

  private async browserPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    // The previous context died (Chromium crash, OOM kill, external close). A stale cached
    // reference would fail every scan forever, so clear the remnants and relaunch below.
    if (this.context || this.page) await this.close().catch(() => undefined);
    // Resolve once per collector lifetime so `doctor` and the collector agree on the browser.
    this.plan = resolveBrowserPlan({ choice: this.config.browser, executablePath: this.config.executablePath });
    verifyBrowserPlan(this.plan);
    const launchOptions = launchOptionsFor(this.config, this.config.headless);
    this.context = await chromium.launchPersistentContext(this.config.profileDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol) || !isAllowedXHost(url.hostname)) { await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) { await route.abort(); return; }
      await route.continue();
    });
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
    // is exactly why collection kept reporting an old `newest`. The main timeline covers thread
    // roots (what we sync); self-reply continuations are not read from here.
    const url = `https://x.com/${encodeURIComponent(this.config.handle)}`;
    // The collector reuses one long-lived page. X is an SPA that does not auto-refresh, and a goto
    // to the URL it is already on can serve a stale cached timeline, so force a reload when we are
    // already there to make X refetch the current timeline every cycle.
    const alreadyThere = page.url().startsWith(url);
    if (alreadyThere) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title(); const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (/log in|sign in|challenge|unusual activity|suspended/i.test(`${title}\n${bodyText}`)) throw new Error('X session is not authenticated or is challenged; no checkpoint advanced');
    // X is a client-side app and renders the timeline progressively after domcontentloaded.
    // Reading at the instant the FIRST article appears can catch a partial screenful — e.g. an
    // older tweet rendered before the newest one — and the watermark check below would then
    // declare the gap covered against an incomplete window, silently blind to the newest post.
    // So wait until the article count has plateaued (or ~15s cap) before trusting the render.
    let settled = 0; let lastCount = -1;
    for (let i = 0; i < 30; i++) {
      if (signal?.aborted) break;
      const count = await page.locator('article[data-testid="tweet"]').count().catch(() => 0);
      if (count === lastCount) settled++; else { settled = 0; lastCount = count; }
      if (lastCount >= 1 && settled >= 3) break;
      await page.waitForTimeout(500);
    }
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
    for (let round = 0; round < this.config.maxPages; round++) {
      const articles = await page.locator('article[data-testid="tweet"]').all();
      for (const article of articles) {
        const links = await article.locator('a[href*="/status/"]').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
        const permalink = await article.locator('a:has(time)').first().getAttribute('href').catch(() => null);
        const ownPath = permalink ? new URL(permalink, 'https://x.com').pathname : '';
        const own = ownPath.match(statusPath)?.[1];
        const authorId = ownPath.split('/')[1] || '';
        if (!own || seen.has(own)) continue;
        seen.add(own);
        const time = await article.locator('time').getAttribute('datetime').catch(() => null);
        // X truncates a link's DISPLAY text ("youtube.com/watch…") while the real destination is the
        // anchor href. Reading innerText would sync the broken truncated string, so reconstruct the
        // text from the tweetText node: use each <a>'s href for external links, keep emoji alt text,
        // and keep visible text for everything else.
        const text = await article.locator('[data-testid="tweetText"]').first().evaluate((node: Element) => {
          const walk = (el: Element): string => {
            let out = '';
            for (const child of Array.from(el.childNodes)) {
              if (child.nodeType === 3) { out += child.textContent || ''; continue; } // text node
              if (!(child instanceof Element)) continue;
              if (child.tagName === 'IMG') { out += (child as HTMLImageElement).alt || ''; continue; } // emoji
              if (child.tagName === 'A') {
                const href = (child as HTMLAnchorElement).href;
                const shown = child.textContent || '';
                // Mentions/hashtags/cashtags and t.co-expanded display links: keep the real href for
                // external URLs (display text is truncated with an ellipsis), else keep visible text.
                out += /^https?:\/\//.test(href) && /[…]|\/\S*…/.test(shown) ? href
                  : /^https?:\/\//.test(href) && !shown.startsWith('@') && !shown.startsWith('#') && !shown.startsWith('$') ? (shown.includes('…') ? href : shown)
                  : shown;
                continue;
              }
              out += walk(child);
            }
            return out;
          };
          return walk(node);
        }).catch(() => '');
        const articleText = await article.innerText().catch(() => '');
        const replyMatch = articleText.match(/Replying to\s+(@[A-Za-z0-9_]{1,15})/i);
        // A link-preview card puts its destination only in the card, not the tweet text. Capture it
        // so a card-only tweet still carries its link downstream.
        const cardHref = await article.locator('[data-testid="card.wrapper"] a[href^="http"], a[data-testid="card.layoutLarge.media"], a[data-testid="card.layoutSmall.media"]').first().getAttribute('href').catch(() => null);
        const images = await article.locator('[data-testid="tweetPhoto"] img').evaluateAll(nodes => nodes.map(node => ({ url: (node as HTMLImageElement).src, alt: (node as HTMLImageElement).alt || '' })));
        const hasVideo = await article.locator('[data-testid="videoPlayer"], video').count() > 0;
        // Request the original pixels (name=orig) rather than the blurry timeline thumbnail.
        const media: Attachment[] = images.map(image => ({ kind: 'image' as const, url: fullSizeImageUrl(image.url), alt: image.alt }));
        if (hasVideo) media.push({ kind: 'video', alt: '' });
        // A quote links to a DIFFERENT tweet id. Compare the parsed status id, not the raw path:
        // a tweet's own sub-pages (/analytics, /likes, /retweets, /photo/1) share the same id and
        // must not be mistaken for a quoted tweet. Only a link whose status id differs is a quote.
        const quote = links.find(value => { try { const qid = new URL(value).pathname.match(statusPath)?.[1]; return Boolean(qid) && qid !== own; } catch { return false; } });
        // A card link that is not a quoted tweet and not already in the text is the tweet's only URL;
        // append it so it survives the sync. (Quote cards are handled via quoteUrl, not here.)
        let bodyText = text;
        if (cardHref && !/^https?:\/\//.test(cardHref.match(statusPath)?.[0] || '') && !text.includes(cardHref)) {
          try {
            const cardId = new URL(cardHref).pathname.match(statusPath)?.[1];
            if (!cardId || cardId === own) { const stripped = cardHref; if (stripped && !text.includes(stripped)) bodyText = text ? `${text}\n${stripped}` : stripped; }
          } catch { /* ignore malformed card href */ }
        }
        // Expand any t.co short link the DOM left in the text to its real destination before the
        // post is handed downstream, so other platforms show the real URL, not a t.co short link.
        bodyText = await this.resolveShortLinks(bodyText, signal);
        const parsed = parseTweetFacts({ id: own, url: `https://x.com/${this.config.handle}/status/${own}`, authorId, createdAt: time || undefined, text: bodyText, replyingTo: replyMatch?.[1], statusLinks: links, attachments: media, repost: authorId.toLowerCase() !== this.config.handle.toLowerCase() || /reposted by/i.test(articleText), quoteUrl: quote }, this.config.handle);
        if (!/pinned|置頂/i.test(articleText) && parsed.createdAt && (!oldest || parsed.createdAt < oldest)) oldest = parsed.createdAt;
        facts.push(parsed);
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
    if (!facts.length) {
      // Distinguish a genuinely empty timeline from a page that never rendered any tweet element
      // (blocked assets, layout change, or a too-early read), so the log points at the real cause.
      const sawArticles = await page.locator('article[data-testid="tweet"]').count();
      throw new Error(sawArticles > 0
        ? 'X page rendered tweets but none were parseable (tweet layout may have changed); no checkpoint advanced'
        : 'X page rendered no tweet elements (assets blocked, empty timeline, or slow render); no checkpoint advanced');
    }
    const posts: SourcePost[] = facts.filter(f => f.createdAt).map(f => ({ platform: 'x', id: f.id, authorId: f.authorId, createdAt: f.createdAt!, text: f.text, url: f.url, replyToId: f.replyToId, replyToAuthorId: f.replyToAuthorId, relationKnown: f.relationKnown, visibility: 'public', repost: f.repost, quoteUrl: f.quoteUrl, sensitive: f.sensitive, attachments: f.attachments, metadataComplete: f.metadataComplete }));
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
    const check = `https://x.com/${encodeURIComponent(config.handle)}/with_replies`;
    await page.goto(check, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const authenticated = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    return { authenticated };
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
  const context = await chromium.launchPersistentContext(config.profileDir, launchOptionsFor(config, true));
  try {
    await context.addCookies(file.state.cookies.map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/',
      expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
      httpOnly: Boolean(cookie.httpOnly), secure: cookie.secure !== false,
      sameSite: (['Strict', 'Lax', 'None'] as const).includes(cookie.sameSite) ? cookie.sameSite : 'Lax',
    })));
    const page = context.pages()[0] || await context.newPage();
    const check = `https://x.com/${encodeURIComponent(config.handle)}/with_replies`;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['http:', 'https:'].includes(url.protocol) || !isAllowedXHost(url.hostname)) { await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(route.request().method())) { await route.abort(); return; }
      await route.continue();
    });
    await page.goto(check, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const authenticated = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    return { authenticated };
  } finally {
    await context.close();
  }
}
