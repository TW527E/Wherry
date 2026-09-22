import 'dotenv/config';
import { FastifyInstance, fastify } from 'fastify';
import { loadConfig, publicConfig, type AppConfig } from './config.js';
import { SafeHttp } from './security/http.js';
import { Store } from './store.js';
import { Engine, Worker, collectCycle, safeError } from './engine.js';
import { BlueskyClient } from './platforms/bluesky.js';
import { SharkeyClient } from './platforms/sharkey.js';
import { TelegramClient, type TelegramUpdateMessage } from './platforms/telegram.js';
import { extractXStatus, handleCallback, handleReminderReply, handleReviewReply, TelegramNotifications } from './telegram-notifications.js';
import { SerialWork } from './lifecycle.js';
import { XCollector, installSession } from './platforms/x.js';
import { parseSessionFile, MAX_SESSION_BYTES } from './platforms/session.js';
import type { Collector, Destination, Publisher, RemoteRef } from './types.js';

class PreviewPublisher implements Publisher {
  constructor(readonly destination: Destination, private readonly store: Store) {}
  async publish(part: { key: string; text: string; isFooter?: boolean }, context: { idempotencyKey: string }): Promise<RemoteRef> {
    const id = `preview:${this.destination}:${context.idempotencyKey}`;
    this.store.event('info', `[preview] ${this.destination} ${part.isFooter ? 'footer' : 'part'}: ${part.text.slice(0, 120)}`);
    return { id, url: `preview://${this.destination}/${encodeURIComponent(id)}` };
  }
}

export interface Runtime {
  config: AppConfig;
  store: Store;
  engine: Engine;
  worker: Worker;
  collectors: Collector[];
  publishers: Map<Destination, Publisher>;
  telegram?: TelegramClient;
  start(): void;
  stop(): Promise<void>;
  once(): Promise<void>;
  scan(): Promise<void>;
}

export function createRuntime(config = loadConfig()): Runtime {
  const store = new Store(config.databasePath);
  const transport = new SafeHttp();
  const collectors: Collector[] = [];
  const publishers = new Map<Destination, Publisher>();
  let telegram: TelegramClient | undefined;

  const live = config.mode === 'live';
  // Collection is read-only and safe; it runs in every mode so preview can show what WOULD be synced.
  // Only the publish step differs: live uses the real clients, preview swaps in stubs.
  if (config.x.enabled) collectors.push(new XCollector(config.x, transport));
  if (config.bluesky.enabled && config.bluesky.identifier && config.bluesky.appPassword) {
    const client = new BlueskyClient(config.bluesky, transport); collectors.push(client);
    if (live) publishers.set('bluesky', client);
  }
  if (config.sharkey.enabled && config.sharkey.token) {
    const client = new SharkeyClient(config.sharkey, transport); collectors.push(client);
    if (live) publishers.set('sharkey', client);
  }
  // The Telegram client is built whenever configured: command polling and session uploads are
  // owner-only reads/admin and safe in any mode. It only becomes a publisher in live.
  if (config.telegram.enabled && config.telegram.token) {
    telegram = new TelegramClient(config.telegram, transport);
    if (live) publishers.set('telegram', telegram);
  }
  if (!live) {
    for (const destination of config.destinations) publishers.set(destination, new PreviewPublisher(destination, store));
  }
  const engine = new Engine(store, config, transport);
  const worker = new Worker(engine, publishers);
  let releaseLock: () => void;
  try { releaseLock = store.acquireRuntimeLock(); } catch (error) { store.close(); throw error; }
  store.recoverInterrupted();
  // Two independent serial lanes so a quick owner command never queues behind a running scan.
  // heavy: the collect → seal → publish cycle (tens of seconds). control: Telegram commands,
  // button taps, reminder replies and session uploads (millisecond DB reads/writes). Cross-lane
  // safety rests on SQLite transactions + atomic claimJob + batch-state checks, not on ordering.
  const heavy = new SerialWork();
  const control = new SerialWork();
  const notifications = telegram ? new TelegramNotifications({ config, engine, telegram, store, worker }) : undefined;
  const timers: NodeJS.Timeout[] = [];
  // Aborted on stop() so an in-flight collection scroll ends promptly instead of running out its
  // whole page budget (× reload + sleeps) while shutdown waits on it.
  const shutdown = new AbortController();
  let stopped = false;
  let started = false;
  let cycle: Promise<void> | undefined;
  let commands: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let menu: Promise<void> | undefined;

  const runCycle = (publish: boolean): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (cycle) return cycle;
    cycle = heavy.run(async () => {
      if (stopped) return;
      await collectCycle(engine, collectors, undefined, shutdown.signal);
      if (publish && !stopped) { engine.sealReady(); await worker.run(); }
    }).catch(error => { store.event('error', `Service cycle failed: ${safeError(error)}`); })
      .finally(async () => { try { await notifications?.flush(); } finally { cycle = undefined; } });
    return cycle;
  };
  const once = (): Promise<void> => runCycle(true);
  const commandCycle = (): Promise<void> => {
    if (!live || !telegram || !config.telegram.pollCommands || stopped) return Promise.resolve();
    if (commands) return commands;
    commands = (async () => {
      const updates = await telegram.getUpdates(store.setting<number>('telegram:update_offset', 0) || undefined);
      for (const update of updates) {
        if (stopped) break;
        try {
          if (update.callback_query) {
            await control.run(() => handleCallback(update.callback_query!, { config, engine, telegram, store, worker }));
          } else {
            const message = update.message;
            if (!message || message.chat.type !== 'private' || String(message.chat.id) !== config.telegram.privateChatId || String(message.from?.id ?? '') !== config.telegram.ownerId) continue;
            const text = (message.text || '').trim();
            const caption = (message.caption || '').trim();
            const command = text.split(/\s+/u)[0]?.split('@')[0]?.toLowerCase();
            const sessionCaption = caption.split(/\s+/u)[0]?.split('@')[0]?.toLowerCase() === '/session';
            if (message.document) {
              const armed = store.setting<number>('telegram:session_until', 0) > Date.now();
              store.setSetting('telegram:session_until', 0);
              if (sessionCaption || armed) {
                await control.run(async () => {
                  for (const collector of collectors) if (collector.platform === 'x') await collector.close?.();
                  await handleSessionUpload(message, { config, telegram, store });
                });
              } else await telegram.sendPlain('檔案未安裝。請先 /session 或在檔案說明填 /session；若是登入憑證，請自行刪除未處理的檔案訊息。', 'private');
              continue;
            }
            store.setSetting('telegram:session_until', 0);
            if (command === '/session') {
              store.setSetting('telegram:session_until', Date.now() + 5 * 60_000);
              await telegram.sendPlain('請於五分鐘內在下一則訊息上傳 x-session.json。安裝後會嘗試刪除檔案訊息；傳送 /help 可取消。', 'private');
              continue;
            }
            if (command === '/sync') {
              // Kick the collect/publish cycle on the heavy lane WITHOUT awaiting it, so the reply
              // is instant and the control lane stays free for other commands. runCycle's own
              // single-flight guard means a repeat /sync during a run just joins the in-flight one.
              void once();
              await telegram.sendPlain('已開始一次收集與佇列檢查（背景執行）；完成後結果請看 /status。X 發文仍需手動。', 'private');
              continue;
            }
            await control.run(async () => {
              if (await handleReviewReply(message, { config, engine, telegram, store, worker })) return;
              if (await handleReminderReply(message, { config, engine, telegram, store, worker })) return;
              await handleCommand(text, { engine, telegram, store, worker });
            });
          }
        } catch (error) {
          store.event('error', `Telegram update handling failed: ${safeError(error)}`);
          await telegram.sendPlain(`操作未完成：${safeError(error)}。請重試指令或查看 /status。`, 'private').catch(() => undefined);
        } finally {
          store.setSetting('telegram:update_offset', update.update_id + 1);
        }
        await notifications?.flush();
      }
    })().catch(error => { store.event('error', `Telegram command polling failed: ${safeError(error)}`); })
      .finally(async () => { try { await notifications?.flush(); } finally { commands = undefined; } });
    return commands;
  };
  const start = (): void => {
    if (started || stopped) return;
    started = true;
    const every = (ms: number, task: () => Promise<void>): void => {
      const timer = setInterval(() => { void task().catch(error => { store.event('error', `Background task failed: ${safeError(error)}`); }); }, ms);
      timer.unref(); timers.push(timer);
    };
    every(config.pollSeconds * 1000, once);
    if (live && telegram) every(15_000, () => notifications!.flush());
    if (live && telegram && config.telegram.pollCommands) {
      menu = telegram.setMyCommands(TELEGRAM_COMMANDS.map(c => ({ command: c.command, description: c.description })))
        .catch(error => { store.event('error', `Telegram setMyCommands failed: ${safeError(error)}`); });
      // getUpdates long-polls (holds up to ~25s), so instead of a fixed tick that would either
      // stack calls or add latency after each return, re-arm the next poll as soon as the previous
      // one settles. A small floor avoids a hot loop if a poll returns immediately or errors fast.
      const pollLoop = (): void => {
        if (stopped) return;
        void commandCycle().catch(error => { store.event('error', `Background task failed: ${safeError(error)}`); })
          .finally(() => { if (!stopped) { const t = setTimeout(pollLoop, 500); t.unref(); timers.push(t); } });
      };
      pollLoop();
    }
  };
  return {
    config, store, engine, worker, collectors, publishers, telegram, start, once,
    scan: () => runCycle(false),
    stop: () => {
      if (stopping) return stopping;
      stopped = true;
      shutdown.abort();
      for (const timer of timers) clearInterval(timer);
      worker.stop();
      stopping = (async () => {
        await Promise.allSettled([cycle, commands, menu]);
        await heavy.drain();
        await control.drain();
        await notifications?.flush();
        try { for (const collector of collectors) await collector.close?.(); }
        finally { releaseLock(); store.close(); }
      })();
      return stopping;
    },
  };
}

interface CommandContext { engine: Engine; telegram: TelegramClient; store: Store; worker: Worker }

/** Single source of truth for the bot's commands: drives the Telegram "/" menu and /help. */
export const TELEGRAM_COMMANDS: Array<{ command: string; args?: string; description: string }> = [
  { command: 'help', description: '顯示所有指令說明' },
  { command: 'status', description: '查看目前的任務、批次與近期事件' },
  { command: 'sync', description: '立即檢查一次（X 發文仍需手動）' },
  { command: 'pending', description: '列出等待你處理的批次與其 ID' },
  { command: 'approve', args: '<batchId>', description: '批准一個被保留的批次，發布到下游' },
  { command: 'skip', args: '<batchId>', description: '略過（不同步）某個批次' },
  { command: 'mirror', args: '<id> [X_URL]', description: '標記為你手動鏡像，之後不再同步' },
  { command: 'retry', args: '<jobId>', description: '重試一個明確失敗的工作' },
  { command: 'resync', args: '<jobId>', description: 'retry 別名：重試明確失敗的工作' },
  { command: 'reconcile', args: '<jobId>', description: '對帳後重試 unknown 工作（先自行確認遠端沒有重複貼文）' },
  { command: 'session', description: '更新 X 登入：接著上傳 x-session.json（或在檔案說明打 /session）' },
];

function helpText(): string {
  const lines = TELEGRAM_COMMANDS.map(c => `/${c.command}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  return ['📋 Wherry 指令', ...lines, '', '💡 更新 X 登入：打 /session 再上傳 x-session.json（或直接在檔案說明打 /session）。上傳的檔案會在安裝後自動刪除。', 'ℹ️ X 發文一律手動；本工具只讀 X、把新貼文同步到 Bluesky / Sharkey。'].join('\n');
}

async function handleCommand(raw: string, context: CommandContext): Promise<void> {
  // Accept "/cmd", "/cmd@BotName" and arguments; ignore anything that is not a slash command.
  const parts = raw.trim().split(/\s+/u);
  const command = (parts[0] || '').split('@')[0]!.toLowerCase();
  const id = parts[1]; const extra = parts.slice(2).join(' ');
  if (!command.startsWith('/')) return;
  try {
    if (command === '/help' || command === '/start') await context.telegram.sendPlain(helpText(), 'private');
    else if (command === '/status') await context.telegram.sendPlain(JSON.stringify({ mode: context.engine.config.mode, xSession: context.store.setting('x:session_state', context.engine.config.x.enabled ? 'unknown' : 'disabled'), jobs: context.store.jobs(20), events: context.store.events(10) }, null, 2).slice(0, 3900), 'private');
    else if (command === '/pending') {
      const held = context.store.batches(50).filter(b => ['review', 'open'].includes(b.state));
      const reminders = context.store.pendingReminders(context.engine.config.telegram.privateChatId);
      const body = [...held.map(b => `• ${b.id}\n  狀態：${b.state}（${b.reason}）`), ...reminders.map(r => `• ${r.aggregateId}\n  X 提醒：${r.state}（請操作原提醒或 /mirror <id> <X_URL>）`)].join('\n') || '目前沒有等待處理的批次或提醒。';
      await context.telegram.sendPlain(`待處理批次（${held.length}）\n${body}`, 'private');
    }
    else if (command === '/skip' && id) { context.engine.action('skip', id); await context.telegram.sendPlain(`已跳過 ${id}`, 'private'); }
    else if (command === '/mirror' && id) {
      if (extra) {
        const link = extractXStatus(extra, context.engine.config.x.handle);
        if (!link) throw new Error('請提供一個完整、屬於自己的 X 推文網址');
        const result = context.engine.registerManualMirror(id, link.id);
        for (const reminder of context.store.pendingReminders(context.engine.config.telegram.privateChatId)) {
          if (reminder.aggregateId === id) context.store.setReminderState(reminder.messageId, reminder.chatId, 'linked', link.url);
        }
        await context.telegram.sendPlain(`已登記 ${link.url}。${result.alreadyDelivered ? '⚠️ 已有發布紀錄，請檢查遠端貼文。' : '已阻止後續反向同步。'}`, 'private');
      } else { context.engine.action('mirror', id); await context.telegram.sendPlain(`已標記鏡像 ${id}，不會同步。`, 'private'); }
    }
    else if (command === '/approve' && id) { context.engine.action('approve', id); void context.worker.run().catch(() => undefined); await context.telegram.sendPlain(`已批准 ${id}，正在背景發布到下游；狀態請看 /status。`, 'private'); }
    else if (['/retry', '/resync'].includes(command) && id) { context.engine.action('retry', id); void context.worker.run().catch(() => undefined); await context.telegram.sendPlain(`已排入重試 ${id}（背景執行）`, 'private'); }
    else if (command === '/reconcile' && id) { context.engine.action('reconcile', id); void context.worker.run().catch(() => undefined); await context.telegram.sendPlain(`已對帳並排入重新發送 ${id}（背景執行）。若剛才你在該平台看到已發出的貼文，請改用 /mirror 或 /skip，避免重複。`, 'private'); }
    else if (['/skip', '/mirror', '/approve', '/retry', '/resync', '/reconcile'].includes(command)) await context.telegram.sendPlain(`${command} 需要一個 ID。例如：${command} <id>。用 /pending 查看待處理批次。`, 'private');
    else await context.telegram.sendPlain('未知指令。\n\n' + helpText(), 'private');
  } catch (error) { context.store.event('error', `Telegram command failed: ${safeError(error)}`); await context.telegram.sendPlain(`操作失敗：${safeError(error)}`, 'private').catch(() => undefined); }
}

/**
 * Owner uploaded a document to the private chat: treat it as an X session file. Only the owner's
 * private chat reaches here (checked by the caller). We download with a hard byte cap, validate the
 * envelope + auth cookie before touching the profile, then seed the headless profile. The cookies
 * are the account session, so we never echo their values back — only pass/fail and the handle.
 */
async function handleSessionUpload(
  message: TelegramUpdateMessage,
  context: { config: AppConfig; telegram: TelegramClient; store: Store },
): Promise<void> {
  const document = message.document!;
  const name = document.file_name || '';
  if (!/\.json$/i.test(name)) { await context.telegram.sendPlain('收到檔案，但不是 .json；請上傳 export-session 產生的 x-session.json。', 'private').catch(() => undefined); return; }
  const chatId = context.config.telegram.privateChatId;
  try {
    const bytes = await context.telegram.downloadFile(document.file_id, MAX_SESSION_BYTES);
    // The file is a live account secret. Remove the upload message from chat as soon as we hold the
    // bytes, then install. Deletion is best-effort (Telegram only allows it within 48h); report
    // whether it succeeded so the owner can delete it manually if not.
    let deleted = false;
    try { await context.telegram.deleteMessage(chatId, message.message_id); deleted = true; }
    catch (error) { context.store.event('error', `Could not delete uploaded session message: ${safeError(error)}`); }
    const note = deleted ? '已刪除你上傳的檔案訊息。' : '⚠️ 無法自動刪除該檔案訊息，請你手動刪除，以免憑證留在對話中。';
    const file = parseSessionFile(bytes);
    if (file.handle && file.handle.toLowerCase() !== context.config.x.handle.toLowerCase()) throw new Error('Session belongs to a different configured X handle');
    const result = await installSession(context.config.x, file);
    context.store.setSetting('x:session_state', result.authenticated ? 'authenticated' : 'error');
    context.store.event('info', `X session uploaded via Telegram for @${file.handle || context.config.x.handle}; authenticated=${result.authenticated}; messageDeleted=${deleted}`);
    if (result.authenticated) await context.telegram.sendPlain(`✅ X session 已安裝並驗證成功，之後的檢查就能讀到你的推文了。${note}`, 'private');
    else await context.telegram.sendPlain(`⚠️ session 已安裝，但驗證時仍看到登入/驗證畫面（cookie 可能過期或被要求重新驗證，請在本機重新 login 後再匯出）。${note}`, 'private');
  } catch (error) {
    context.store.event('error', `X session upload failed: ${safeError(error)}`);
    // Even on failure, still try to remove the uploaded secret from chat history.
    await context.telegram.deleteMessage(chatId, message.message_id).catch(() => undefined);
    await context.telegram.sendPlain(`session 安裝失敗：${safeError(error)}（已嘗試刪除上傳的檔案訊息）`, 'private').catch(() => undefined);
  }
}

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Guards the write endpoints. On loopback without a token we still refuse form-style
 * and cross-origin requests, so a page the owner happens to visit cannot drive the service.
 */
function authorize(method: string, headers: Record<string, string | string[] | undefined>, config: AppConfig): void {
  if (!writeMethods.has(method)) return;
  const header = headers.authorization;
  const bearer = typeof header === 'string' && config.webToken && header === `Bearer ${config.webToken}`;
  if (bearer) return;
  if (config.webToken) throw new Error('Unauthorized');
  if (config.host !== '127.0.0.1' && config.host !== '::1') throw new Error('Unauthorized');
  // A JSON content type forces a CORS preflight for cross-origin callers, and HTML forms
  // cannot set it at all, which blocks localhost CSRF.
  const contentType = headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) throw new Error('Unsupported media type');
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    const host = headers.host;
    try { if (typeof host !== 'string' || new URL(origin).host !== host) throw new Error('Cross-origin request rejected'); }
    catch { throw new Error('Cross-origin request rejected'); }
  }
}

export async function createWeb(runtime: Runtime): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    try { authorize(request.method, request.headers, runtime.config); }
    catch (error) { await reply.code(401).send({ error: safeError(error) }); }
  });
  app.get('/healthz', async () => ({ ok: true, mode: runtime.config.mode }));
  app.get('/api/config', async () => publicConfig(runtime.config));
  app.get('/api/status', async () => ({
    mode: runtime.config.mode,
    xSession: runtime.store.setting<string>('x:session_state', runtime.config.x.enabled ? 'unknown' : 'disabled'),
    jobs: runtime.store.jobs(100), batches: runtime.store.batches(100), events: runtime.store.events(50),
  }));
  app.get('/api/posts', async () => runtime.store.posts(100));
  app.post('/api/scan', async () => { await runtime.once(); return { ok: true }; });
  app.post<{ Body: { action: 'skip' | 'mirror' | 'approve' | 'retry' | 'reconcile'; id: string } }>('/api/action', async (request, reply) => {
    try { runtime.engine.action(request.body.action, request.body.id); return { ok: true }; }
    catch (error) { return reply.code(400).send({ error: safeError(error) }); }
  });
  app.post<{ Body: { text: string; attachments?: unknown[]; dueAt: string } }>('/api/schedule', async (request, reply) => {
    try { return { id: runtime.engine.schedule({ text: request.body.text, attachments: request.body.attachments as never, dueAt: request.body.dueAt }) }; }
    catch (error) { return reply.code(400).send({ error: safeError(error) }); }
  });
  app.get('/', async (_request, reply) => { reply.type('text/html; charset=utf-8'); return html; });
  return app;
}

const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wherry</title><style>
:root{--bg:#0f1419;--card:#fff;--line:#e1e8ed;--muted:#536471;--accent:#1d9bf0;--ok:#00ba7c;--warn:#f4b400;--err:#f4212e}
*{box-sizing:border-box}body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;margin:0;background:#f7f9f9;color:#0f1419}
header{background:var(--bg);color:#fff;padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
header h1{font-size:1.15rem;margin:0;font-weight:700}
.pill{font-size:.8rem;padding:.2rem .6rem;border-radius:999px;font-weight:600}
.pill.live{background:var(--ok);color:#fff}.pill.preview{background:var(--warn);color:#000}
main{max-width:1080px;margin:1.25rem auto;padding:0 1rem;display:grid;gap:1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.25rem}
.card h2{font-size:1rem;margin:.1rem 0 .8rem}
button{font:inherit;border:0;border-radius:999px;padding:.45rem .9rem;cursor:pointer;background:var(--accent);color:#fff;font-weight:600}
button.ghost{background:#eff3f4;color:#0f1419}button.ok{background:var(--ok)}button.warn{background:var(--warn);color:#000}button.err{background:var(--err)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.batch,.job{border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;margin:.5rem 0}
.batch .meta,.job .meta{color:var(--muted);font-size:.82rem;word-break:break-all}
.state{font-size:.75rem;font-weight:700;padding:.15rem .5rem;border-radius:6px;background:#eff3f4;color:#0f1419}
.state.review,.state.failed{background:#fde8e8;color:var(--err)}.state.open{background:#fff4d6;color:#7a5b00}
.state.succeeded,.state.sealed{background:#d7f5ea;color:#00734d}
input,textarea{font:inherit;width:100%;padding:.5rem;border:1px solid var(--line);border-radius:8px}
label{display:block;font-size:.85rem;color:var(--muted);margin:.4rem 0 .15rem}
pre{background:#f7f9f9;border:1px solid var(--line);padding:.75rem;border-radius:8px;overflow:auto;font-size:.8rem;max-height:280px}
.empty{color:var(--muted);font-size:.9rem;padding:.5rem 0}
.evt{font-size:.82rem;padding:.25rem 0;border-bottom:1px solid var(--line)}.evt.error{color:var(--err)}
.toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:#0f1419;color:#fff;padding:.6rem 1rem;border-radius:999px;font-size:.85rem;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
</style></head><body>
<header><h1>🔗 Wherry</h1><span id="mode" class="pill">…</span><span id="xsess" class="pill ghost" style="background:#eff3f4;color:#0f1419"></span><span style="flex:1"></span>
<button onclick="scan(this)">立即檢查</button><button class="ghost" onclick="load()">重新整理</button></header>
<main>
<div class="card"><label>Web token（僅在 .env 設定 WEB_TOKEN 時需要）</label><input id="token" type="password" placeholder="Bearer token"></div>
<div class="card"><h2>待處理批次</h2><div id="batches"><div class="empty">載入中…</div></div></div>
<div class="card"><h2>排程一則本地貼文（不會自動發到 X）</h2>
<label>發布時間（留空＝立即）</label><input id="s-due" type="datetime-local">
<label>內容</label><textarea id="s-text" rows="3" placeholder="要排程同步到下游的文字"></textarea>
<div class="row" style="margin-top:.6rem"><button class="ok" onclick="schedule(this)">建立排程</button></div></div>
<div class="card"><h2>工作佇列</h2><div id="jobs"><div class="empty">載入中…</div></div></div>
<div class="card"><h2>近期事件</h2><div id="events"></div></div>
</main><div id="toast" class="toast"></div>
<script>
const $=s=>document.querySelector(s);const tok=$('#token');tok.value=localStorage.getItem('webToken')||'';
tok.addEventListener('change',()=>localStorage.setItem('webToken',tok.value));
function headers(){const h={'content-type':'application/json'};const t=localStorage.getItem('webToken');if(t)h.authorization='Bearer '+t;return h}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
async function act(verb,id,btn){if(btn)btn.disabled=true;try{const r=await fetch('/api/action',{method:'POST',headers:headers(),body:JSON.stringify({action:verb,id})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);toast('已'+({skip:'略過',mirror:'標記鏡像',approve:'批准',retry:'重試',reconcile:'重新發送'}[verb]||verb));await load()}catch(e){toast('失敗：'+e.message);if(btn)btn.disabled=false}}
async function scan(btn){if(btn)btn.disabled=true;try{const r=await fetch('/api/scan',{method:'POST',headers:headers(),body:'{}'});if(!r.ok)throw new Error(r.status);toast('已檢查');await load()}catch(e){toast('失敗：'+e.message)}finally{if(btn)btn.disabled=false}}
async function schedule(btn){const text=$('#s-text').value.trim();if(!text){toast('請輸入內容');return}const due=$('#s-due').value;const dueAt=due?new Date(due).toISOString():new Date().toISOString();btn.disabled=true;try{const r=await fetch('/api/schedule',{method:'POST',headers:headers(),body:JSON.stringify({text,dueAt})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);toast('已排程 '+(j.id||''));$('#s-text').value='';await load()}catch(e){toast('失敗：'+e.message)}finally{btn.disabled=false}}
function batchCard(b){const acts=(b.state==='review'||b.state==='open')?'<button class="ok" onclick="act(\\'approve\\',\\''+b.id+'\\',this)">批准發布</button> <button class="ghost" onclick="act(\\'skip\\',\\''+b.id+'\\',this)">略過</button> <button class="warn" onclick="act(\\'mirror\\',\\''+b.id+'\\',this)">標記為我手動鏡像</button>':'<span class="meta">此批次已處理，無可用操作</span>';
return '<div class="batch"><div class="row"><span class="state '+esc(b.state)+'">'+esc(b.state)+'</span><b>'+esc(b.id)+'</b></div><div class="meta">原因：'+esc(b.reason)+' · root '+esc(b.rootId)+' · '+esc(b.rootCreatedAt)+'</div><div class="row" style="margin-top:.5rem">'+acts+'</div></div>'}
function jobCard(j){const canRetry=(j.state==='failed'||j.state==='review');const canReconcile=(j.state==='unknown');return '<div class="job"><div class="row"><span class="state '+esc(j.state)+'">'+esc(j.state)+'</span><b>'+esc(j.destination)+'</b><span class="meta">'+esc(j.aggregateId)+'</span></div>'+(j.error?'<div class="meta">錯誤：'+esc(j.error)+'</div>':'')+(canRetry?'<div class="row" style="margin-top:.5rem"><button class="ghost" onclick="act(\\'retry\\',\\''+j.id+'\\',this)">重試</button></div>':'')+(canReconcile?'<div class="row" style="margin-top:.5rem"><button class="warn" onclick="if(confirm(\\'請先到該平台確認這則沒有成功發出（沒有重複貼文），再繼續。確定重新發送未確認的部分？\\'))act(\\'reconcile\\',\\''+j.id+'\\',this)">已確認遠端、重新發送</button></div>':'')+'</div>'}
async function load(){try{const s=await fetch('/api/status').then(r=>r.json());
const mode=$('#mode');mode.textContent='模式：'+s.mode;mode.className='pill '+(s.mode==='live'?'live':'preview');
$('#xsess').textContent='X session：'+(s.xSession||'unknown');
const held=(s.batches||[]).filter(b=>b.state==='review'||b.state==='open');
$('#batches').innerHTML=held.length?held.map(batchCard).join(''):'<div class="empty">目前沒有待處理批次。新內容會出現在這裡供你批准／略過。</div>';
const jobs=(s.jobs||[]);$('#jobs').innerHTML=jobs.length?jobs.slice(0,40).map(jobCard).join(''):'<div class="empty">佇列是空的。</div>';
$('#events').innerHTML=(s.events||[]).slice(0,20).map(e=>'<div class="evt '+esc(e.level)+'">['+esc(e.level)+'] '+esc(e.at)+' — '+esc(e.message)+'</div>').join('')||'<div class="empty">尚無事件。</div>';
}catch(e){toast('讀取失敗：'+e.message)}}
load();setInterval(load,5000)
</script></body></html>`;
