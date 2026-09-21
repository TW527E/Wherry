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
  constructor(private readonly config: AppConfig['x'], private readonly transport?: Transport) {}

  /** Resolved browser plan; available after the first collect or an explicit `browserPlan()` call. */
  browserPlan(): BrowserPlan | undefined { return this.plan; }

  private async browserPage(): Promise<Page> {
    if (this.page) return this.page;
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

  async collect(since?: string): Promise<SourceSnapshot> {
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
    // X is a client-side app: the timeline renders after domcontentloaded. Wait for the first
    // tweet to appear before parsing, so an early read does not look like an empty profile.
    await page.locator('article[data-testid="tweet"]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
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
        const media: Attachment[] = images.map(image => ({ kind: 'image' as const, url: image.url, alt: image.alt }));
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
        const parsed = parseTweetFacts({ id: own, url: `https://x.com/${this.config.handle}/status/${own}`, authorId, createdAt: time || undefined, text: bodyText, replyingTo: replyMatch?.[1], statusLinks: links, attachments: media, repost: authorId.toLowerCase() !== this.config.handle.toLowerCase() || /reposted by/i.test(articleText), quoteUrl: quote }, this.config.handle);
        if (!/pinned|置頂/i.test(articleText) && parsed.createdAt && (!oldest || parsed.createdAt < oldest)) oldest = parsed.createdAt;
        facts.push(parsed);
      }
      // Once the oldest tweet seen is at/older than the last fetch, the gap since then is covered.
      if (since && oldest && oldest <= since) { reachedWatermark = true; break; }
      if (seen.size === previousCount) stableRounds++; else stableRounds = 0;
      previousCount = seen.size;
      if (stableRounds >= 2) break;
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
    // Budget exhausted before reaching the watermark = a real backlog gap: hold and tell the operator.
    const warnings = reachedWatermark ? [] : ['X backlog since the last scan exceeds the scroll budget; raise X_MAX_PAGES or scan more often'];
    const posts: SourcePost[] = facts.filter(f => f.createdAt).map(f => ({ platform: 'x', id: f.id, authorId: f.authorId, createdAt: f.createdAt!, text: f.text, url: f.url, replyToId: f.replyToId, replyToAuthorId: f.replyToAuthorId, relationKnown: f.relationKnown, visibility: 'public', repost: f.repost, quoteUrl: f.quoteUrl, sensitive: f.sensitive, attachments: f.attachments, metadataComplete: f.metadataComplete }));
    return { platform: 'x', accountId: this.config.handle, posts, fetchedAt, complete: reachedWatermark, warnings };
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
