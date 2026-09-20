import 'dotenv/config';
import { FastifyInstance, fastify } from 'fastify';
import { loadConfig, publicConfig, type AppConfig } from './config.js';
import { SafeHttp } from './security/http.js';
import { Store } from './store.js';
import { Engine, Worker, collectCycle, safeError } from './engine.js';
import { BlueskyClient } from './platforms/bluesky.js';
import { SharkeyClient } from './platforms/sharkey.js';
import { TelegramClient, type TelegramAudience, type TelegramUpdateMessage } from './platforms/telegram.js';
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
  stop(): Promise<void>;
  once(): Promise<void>;
}

export function createRuntime(config = loadConfig()): Runtime {
  const store = new Store(config.databasePath);
  store.recoverInterrupted();
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
  let timer: NodeJS.Timeout | undefined;
  let commandTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let updateOffset = store.setting<number>('telegram:update_offset', 0);

  const once = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await collectCycle(engine, collectors);
      engine.sealReady();
      await worker.run();
    } finally { running = false; }
  };
  const commandCycle = async (): Promise<void> => {
    if (!telegram || !config.telegram.pollCommands || stopped) return;
    try {
      const updates = await telegram.getUpdates(updateOffset || undefined);
      for (const update of updates) {
        updateOffset = Math.max(updateOffset, update.update_id + 1); store.setSetting('telegram:update_offset', updateOffset);
        if (!store.commandOnce(update.update_id, new Date().toISOString())) continue;
        const message = update.message; if (!message || String(message.chat.id) !== config.telegram.privateChatId || String(message.from?.id || '') !== config.telegram.ownerId) continue;
        const text = (message.text || '').trim();
        const caption = (message.caption || '').trim();
        const isSessionCmd = (s: string): boolean => s.split(/\s+/u)[0]?.split('@')[0]?.toLowerCase() === '/session';
        if (message.document) {
          // Never auto-install an uploaded file. Only process it when explicitly gated by /session:
          // the file's caption is /session, or /session was armed by a prior message.
          const armed = store.setting<boolean>('telegram:session_armed', false);
          if (isSessionCmd(caption) || armed) { store.setSetting('telegram:session_armed', false); await handleSessionUpload(message, { config, telegram, store }); }
          else await telegram.sendPlain('收到檔案，但基於安全我不會自動安裝。請改用 /session：可直接在檔案說明（caption）打 /session，或先傳 /session 再上傳。', 'private').catch(() => undefined);
          continue;
        }
        if (isSessionCmd(text)) {
          store.setSetting('telegram:session_armed', true);
          await telegram.sendPlain('好的，請把 x-session.json 檔案傳過來（下一則訊息）。安裝成功後我會刪除該檔案訊息並回報結果。取消請打 /help。', 'private').catch(() => undefined);
          continue;
        }
        await handleCommand(text, { engine, telegram, store });
      }
    } catch (error) { store.event('error', `Telegram command polling failed: ${safeError(error)}`); }
  };
  timer = setInterval(() => void once(), config.pollSeconds * 1000); timer.unref();
  if (live && telegram && config.telegram.pollCommands) {
    // Register the "/" menu so Telegram shows command autocomplete. Best-effort: a failure here
    // must not stop command polling from starting.
    void telegram.setMyCommands(TELEGRAM_COMMANDS.map(c => ({ command: c.command, description: c.description })))
      .catch(error => store.event('error', `Telegram setMyCommands failed: ${safeError(error)}`));
    commandTimer = setInterval(() => void commandCycle(), 5000); commandTimer.unref();
  }
  return {
    config, store, engine, worker, collectors, publishers, telegram,
    stop: async () => { stopped = true; if (timer) clearInterval(timer); if (commandTimer) clearInterval(commandTimer); for (const collector of collectors) await collector.close?.(); store.close(); },
    once,
  };
}

interface CommandContext { engine: Engine; telegram: TelegramClient; store: Store }

/** Single source of truth for the bot's commands: drives the Telegram "/" menu and /help. */
export const TELEGRAM_COMMANDS: Array<{ command: string; args?: string; description: string }> = [
  { command: 'help', description: '顯示所有指令說明' },
  { command: 'status', description: '查看目前的任務、批次與近期事件' },
  { command: 'sync', description: '立即檢查一次（X 發文仍需手動）' },
  { command: 'pending', description: '列出等待你處理的批次與其 ID' },
  { command: 'approve', args: '<batchId>', description: '批准一個被保留的批次，發布到下游' },
  { command: 'skip', args: '<batchId>', description: '略過（不同步）某個批次' },
  { command: 'mirror', args: '<batchId>', description: '標記為你手動鏡像，之後不再同步' },
  { command: 'retry', args: '<jobId>', description: '重試一個明確失敗的工作' },
  { command: 'session', description: '更新 X 登入：接著上傳 x-session.json（或在檔案說明打 /session）' },
];

function helpText(): string {
  const lines = TELEGRAM_COMMANDS.map(c => `/${c.command}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  return ['📋 Crosspost Bridge 指令', ...lines, '', '💡 更新 X 登入：打 /session 再上傳 x-session.json（或直接在檔案說明打 /session）。上傳的檔案會在安裝後自動刪除。', 'ℹ️ X 發文一律手動；本工具只讀 X、把新貼文同步到 Bluesky / Sharkey。'].join('\n');
}

async function handleCommand(raw: string, context: CommandContext): Promise<void> {
  // Accept "/cmd", "/cmd@BotName" and arguments; ignore anything that is not a slash command.
  const parts = raw.trim().split(/\s+/u);
  const command = (parts[0] || '').split('@')[0]!.toLowerCase();
  const id = parts[1]; const extra = parts.slice(2).join(' ');
  if (!command.startsWith('/')) return;
  try {
    if (command === '/help' || command === '/start') await context.telegram.sendPlain(helpText(), 'private');
    else if (command === '/status') await context.telegram.sendPlain(JSON.stringify({ jobs: context.store.jobs(20), events: context.store.events(10) }, null, 2).slice(0, 3900), 'private');
    else if (command === '/sync') { await context.engine.sealReady(); await context.telegram.sendPlain('已要求立即檢查；X 發文仍需手動。', 'private'); }
    else if (command === '/pending') {
      const held = context.store.batches(50).filter(b => ['review', 'open'].includes(b.state));
      const body = held.length ? held.map(b => `• ${b.id}\n  狀態：${b.state}（${b.reason}）`).join('\n') : '目前沒有等待處理的批次。';
      await context.telegram.sendPlain(`待處理批次（${held.length}）\n${body}`, 'private');
    }
    else if (command === '/skip' && id) { context.engine.action('skip', id); await context.telegram.sendPlain(`已跳過 ${id}`, 'private'); }
    else if (command === '/mirror' && id) { context.engine.action('mirror', id); await context.telegram.sendPlain(`已標記鏡像 ${id}，不會同步。${extra || ''}`, 'private'); }
    else if (command === '/approve' && id) { context.engine.action('approve', id); await context.telegram.sendPlain(`已批准 ${id} 發布到下游。`, 'private'); }
    else if (command === '/retry' && id) { context.engine.action('retry', id); await context.telegram.sendPlain(`已排入重試 ${id}`, 'private'); }
    else if (['/skip', '/mirror', '/approve', '/retry'].includes(command)) await context.telegram.sendPlain(`${command} 需要一個 ID。例如：${command} <id>。用 /pending 查看待處理批次。`, 'private');
    else await context.telegram.sendPlain('未知指令。\n\n' + helpText(), 'private');
  } catch (error) { await context.telegram.sendPlain(`操作失敗：${safeError(error)}`, 'private').catch(() => undefined); }
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
    const result = await installSession(context.config.x, file);
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
  app.get('/api/status', async () => ({ jobs: runtime.store.jobs(100), batches: runtime.store.batches(100), events: runtime.store.events(50) }));
  app.get('/api/posts', async () => runtime.store.posts(100));
  app.post('/api/scan', async () => { await runtime.once(); return { ok: true }; });
  app.post<{ Body: { action: 'skip' | 'mirror' | 'approve'; id: string } }>('/api/action', async request => { runtime.engine.action(request.body.action, request.body.id); return { ok: true }; });
  app.post<{ Body: { text: string; attachments?: unknown[]; dueAt: string } }>('/api/schedule', async request => ({ id: runtime.engine.schedule({ text: request.body.text, attachments: request.body.attachments as never, dueAt: request.body.dueAt }) }));
  app.get('/', async (_request, reply) => { reply.type('text/html; charset=utf-8'); return html; });
  return app;
}

const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crosspost Bridge</title><style>body{font:15px system-ui;margin:2rem;max-width:1100px;color:#202124}button{padding:.5rem .8rem;margin:.25rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}section{margin:1rem 0}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.45rem;text-align:left}input{width:100%;padding:.4rem}</style>
<h1>Crosspost Bridge</h1><p id="mode"></p>
<section><label>Web token（僅在 .env 設定 WEB_TOKEN 時需要）<input id="token" type="password" placeholder="Bearer token"></label></section>
<section><button onclick="scan()">立即檢查</button><button onclick="load()">重新整理</button></section>
<section><h2>Jobs</h2><pre id="jobs">loading</pre></section>
<section><h2>Events</h2><pre id="events">loading</pre></section>
<script>
const tokenInput = document.querySelector('#token');
tokenInput.value = localStorage.getItem('webToken') || '';
tokenInput.addEventListener('change', () => localStorage.setItem('webToken', tokenInput.value));
function headers(){const h={'content-type':'application/json'};const t=localStorage.getItem('webToken');if(t)h.authorization='Bearer '+t;return h}
async function load(){const s=await fetch('/api/status').then(r=>r.json());document.querySelector('#jobs').textContent=JSON.stringify(s.jobs,null,2);document.querySelector('#events').textContent=JSON.stringify(s.events,null,2);document.querySelector('#mode').textContent='模式：'+(await fetch('/api/config').then(r=>r.json())).mode}
async function scan(){const r=await fetch('/api/scan',{method:'POST',headers:headers(),body:'{}'});if(!r.ok)alert('失敗：'+r.status);await load()}
load();setInterval(load,5000)
</script></html>`;
