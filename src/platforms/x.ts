import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { AppConfig } from '../config.js';
import type { Attachment, Collector, SourcePost, SourceSnapshot, Transport } from '../types.js';
import { resolveBrowserPlan, verifyBrowserPlan, type BrowserPlan } from './browser.js';
import { buildSessionFile, type SessionFile, type StorageState } from './session.js';

function launchOptionsFor(config: AppConfig['x'], headless: boolean): Parameters<typeof chromium.launchPersistentContext>[1] {
  const plan = resolveBrowserPlan({ choice: config.browser, executablePath: config.executablePath });
  verifyBrowserPlan(plan);
  const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless, serviceWorkers: 'block', viewport: { width: 1280, height: 900 },
    // X and Google refuse logins from browsers that advertise automation. Playwright adds
    // --enable-automation (which sets navigator.webdriver=true) by default; drop it and the
    // AutomationControlled blink feature so the interactive login is not flagged as a bot.
    // The sandbox is left enabled (we do not pass --no-sandbox).
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    chromiumSandbox: true,
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
    try { const url = new URL(value, 'https://x.com'); const match = url.pathname.match(statusPath); return match && match[1] !== input.id ? { url: url.href, id: match[1] } : undefined; } catch { return undefined; }
  }).find(Boolean);
  const replying = input.replyingTo?.match(/@([A-Za-z0-9_]{1,15})/);
  const relationKnown = Boolean(input.replyingTo !== undefined || (input.statusLinks && input.statusLinks.length > 0));
  const isReply = Boolean(replying || parentLink);
  return {
    id: input.id,
    url: ownUrl,
    authorId: input.authorId || ownerHandle,
    createdAt: input.createdAt,
    text: input.text || '',
    replyToId: isReply ? parentLink?.id ?? null : null,
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
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless,
      serviceWorkers: 'block',
      bypassCSP: false,
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 900 },
    };
    if (this.plan.executablePath) launchOptions.executablePath = this.plan.executablePath;
    else if (this.plan.channel) launchOptions.channel = this.plan.channel;
    this.context = await chromium.launchPersistentContext(this.config.profileDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase()) && !url.hostname.endsWith('.x.com')) { await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(request.method())) { await route.abort(); return; }
      await route.continue();
    });
    return this.page;
  }

  async collect(): Promise<SourceSnapshot> {
    const page = await this.browserPage();
    const url = `https://x.com/${encodeURIComponent(this.config.handle)}/with_replies`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title(); const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    if (/log in|sign in|challenge|unusual activity|suspended/i.test(`${title}\n${bodyText}`)) throw new Error('X session is not authenticated or is challenged; no checkpoint advanced');
    const seen = new Set<string>(); const facts: TweetFacts[] = [];
    let stableRounds = 0; let previousCount = 0;
    for (let round = 0; round < this.config.maxPages; round++) {
      const articles = await page.locator('article[data-testid="tweet"]').all();
      for (const article of articles) {
        const links = await article.locator('a[href*="/status/"]').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
        const own = links.map(value => { try { return new URL(value).pathname.match(statusPath)?.[1]; } catch { return; } }).find(Boolean);
        if (!own || seen.has(own)) continue;
        seen.add(own);
        const time = await article.locator('time').getAttribute('datetime').catch(() => null);
        const text = await article.locator('[data-testid="tweetText"]').innerText().catch(() => '');
        const articleText = await article.innerText().catch(() => '');
        const replyMatch = articleText.match(/Replying to\s+(@[A-Za-z0-9_]{1,15})/i);
        const images = await article.locator('[data-testid="tweetPhoto"] img').evaluateAll(nodes => nodes.map(node => ({ url: (node as HTMLImageElement).src, alt: (node as HTMLImageElement).alt || '' })));
        const hasVideo = await article.locator('[data-testid="videoPlayer"], video').count() > 0;
        const media: Attachment[] = images.map(image => ({ kind: 'image' as const, url: image.url, alt: image.alt }));
        if (hasVideo) media.push({ kind: 'video', alt: '' });
        const quote = links.find(value => { try { const path = new URL(value).pathname; return /\/status\/\d+/.test(path) && !path.endsWith(`/status/${own}`); } catch { return false; } });
        const parsed = parseTweetFacts({ id: own, url: `https://x.com/${this.config.handle}/status/${own}`, authorId: this.config.handle, createdAt: time || undefined, text, replyingTo: replyMatch?.[1], statusLinks: links, attachments: media, repost: /reposted by/i.test(articleText), quoteUrl: quote }, this.config.handle);
        facts.push(parsed);
      }
      if (seen.size === previousCount) stableRounds++; else stableRounds = 0;
      previousCount = seen.size;
      if (stableRounds >= 1) break;
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(800);
    }
    if (!facts.length) throw new Error('X profile yielded no parseable posts; no checkpoint advanced');
    const complete = stableRounds >= 1;
    const posts: SourcePost[] = facts.filter(f => f.createdAt).map(f => ({ platform: 'x', id: f.id, authorId: f.authorId, createdAt: f.createdAt!, text: f.text, url: f.url, replyToId: f.replyToId, replyToAuthorId: f.replyToAuthorId, relationKnown: f.relationKnown, visibility: 'public', repost: f.repost, quoteUrl: f.quoteUrl, sensitive: f.sensitive, attachments: f.attachments, metadataComplete: f.metadataComplete }));
    return { platform: 'x', accountId: this.config.handle, posts, fetchedAt: new Date().toISOString(), complete, warnings: complete ? [] : ['bounded X profile scan did not reach a stable page; retry without advancing checkpoint'] };
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
    const authenticated = !/log in|sign in|challenge|unusual activity|suspended/i.test(`${title}\n${body}`);
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
      if (!['http:', 'https:'].includes(url.protocol) || !(allowedHosts.has(url.hostname.toLowerCase()) || url.hostname.endsWith('.x.com'))) { await route.abort(); return; }
      if (!['GET', 'HEAD'].includes(route.request().method())) { await route.abort(); return; }
      await route.continue();
    });
    await page.goto(check, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const authenticated = !/log in|sign in|challenge|unusual activity|suspended/i.test(`${title}\n${body}`);
    return { authenticated };
  } finally {
    await context.close();
  }
}
