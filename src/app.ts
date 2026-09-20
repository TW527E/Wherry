import 'dotenv/config';
import { FastifyInstance, fastify } from 'fastify';
import { loadConfig, publicConfig, type AppConfig } from './config.js';
import { SafeHttp } from './security/http.js';
import { Store } from './store.js';
import { Engine, Worker, collectCycle, safeError } from './engine.js';
import { BlueskyClient } from './platforms/bluesky.js';
import { SharkeyClient } from './platforms/sharkey.js';
import { TelegramClient, type TelegramAudience } from './platforms/telegram.js';
import { XCollector } from './platforms/x.js';
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
  if (live && config.telegram.enabled && config.telegram.token) {
    telegram = new TelegramClient(config.telegram, transport); publishers.set('telegram', telegram);
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
        await handleCommand(message.text || '', { engine, telegram, store });
      }
    } catch (error) { store.event('error', `Telegram command polling failed: ${safeError(error)}`); }
  };
  timer = setInterval(() => void once(), config.pollSeconds * 1000); timer.unref();
  if (live && telegram && config.telegram.pollCommands) {
    commandTimer = setInterval(() => void commandCycle(), 5000); commandTimer.unref();
  }
  return {
    config, store, engine, worker, collectors, publishers, telegram,
    stop: async () => { stopped = true; if (timer) clearInterval(timer); if (commandTimer) clearInterval(commandTimer); for (const collector of collectors) await collector.close?.(); store.close(); },
    once,
  };
}

interface CommandContext { engine: Engine; telegram: TelegramClient; store: Store }
async function handleCommand(raw: string, context: CommandContext): Promise<void> {
  const [command, id, extra] = raw.trim().split(/\s+/u);
  if (!command) return;
  try {
    if (command === '/help') await context.telegram.sendPlain('/status /sync /skip <batch> /mirror <batch> /approve <batch> /retry <job>', 'private');
    else if (command === '/status') await context.telegram.sendPlain(JSON.stringify({ jobs: context.store.jobs(20), events: context.store.events(10) }, null, 2).slice(0, 3900), 'private');
    else if (command === '/sync') { await context.engine.sealReady(); await context.telegram.sendPlain('已要求立即檢查；X 發文仍需手動。', 'private'); }
    else if (command === '/skip' && id) { context.engine.action('skip', id); await context.telegram.sendPlain(`已跳過 ${id}`, 'private'); }
    else if (command === '/mirror' && id) { context.engine.action('mirror', id); await context.telegram.sendPlain(`已標記鏡像 ${id}，不會同步。${extra || ''}`, 'private'); }
    else if (command === '/approve' && id) { context.engine.action('approve', id); await context.telegram.sendPlain(`已批准 ${id} 發布到下游。`, 'private'); }
    else if (command === '/retry' && id) { context.engine.action('retry', id); await context.telegram.sendPlain(`已排入重試 ${id}`, 'private'); }
    else await context.telegram.sendPlain('未知指令，使用 /help。', 'private');
  } catch (error) { await context.telegram.sendPlain(`操作失敗：${safeError(error)}`, 'private').catch(() => undefined); }
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
