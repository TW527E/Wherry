import { FastifyInstance, fastify } from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { SafeHttp } from './security/http.js';
import { Store } from './store.js';
import { Engine, Worker, collectCycle, holdIsApprovable, safeError } from './engine.js';
import { LABELS, PLATFORM_NAMES, describe, readableEvent } from './labels.js';
import { BlueskyClient } from './platforms/bluesky.js';
import { SharkeyClient } from './platforms/sharkey.js';
import { TelegramClient, type TelegramUpdateMessage } from './platforms/telegram.js';
import { extractXStatus, handleCallback, handleReminderReply, handleReviewReply, TelegramNotifications } from './telegram-notifications.js';
import { SerialWork } from './lifecycle.js';
import { XCollector, installSession } from './platforms/x.js';
import { parseSessionFile, MAX_SESSION_BYTES } from './platforms/session.js';
import { normalizeXHandle, type MentionTargets } from './mentions.js';
import type { Collector, Destination, Publisher, RemoteRef } from './types.js';

class PreviewPublisher implements Publisher {
  constructor(readonly destination: Destination, private readonly store: Store) {}
  async publish(part: { key: string; text: string; isFooter?: boolean }, context: { idempotencyKey: string }): Promise<RemoteRef> {
    const id = `preview:${this.destination}:${context.idempotencyKey}`;
    this.store.event('info', `[preview] ${this.destination} ${part.isFooter ? 'footer' : 'part'}: ${part.text.slice(0, 120)}`);
    return { id, url: `preview://${this.destination}/${encodeURIComponent(id)}` };
  }
  async retract(ref: RemoteRef): Promise<void> {
    this.store.event('info', `[preview] ${this.destination} delete: ${ref.id}`);
  }
}

export type Runtime = ReturnType<typeof createRuntime>;

export function createRuntime(config = loadConfig()) {
  const store = new Store(config.databasePath);
  const transport = new SafeHttp();
  const collectors: Collector[] = [];
  const publishers = new Map<Destination, Publisher>();
  let telegram: TelegramClient | undefined;

  const live = config.mode === 'live';
  // Collection is read-only and safe; it runs in every mode so preview can show what WOULD be synced.
  // Only the publish step differs: live uses the real clients, preview swaps in stubs.
  if (config.x.enabled) collectors.push(new XCollector(config.x, transport, { video: config.media.video, maxDownloadBytes: config.maxDownloadBytes }));
  if (config.bluesky.enabled && config.bluesky.identifier && config.bluesky.appPassword) {
    const client = new BlueskyClient(config.bluesky, transport); collectors.push(client);
    if (live) publishers.set('bluesky', client);
  }
  if (config.sharkey.enabled && config.sharkey.token) {
    const client = new SharkeyClient(config.sharkey, transport); collectors.push(client);
    if (live) publishers.set('sharkey', client);
  }
  // Preview may construct the client, but only live mode polls commands or publishes messages.
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
  const timers = new Set<NodeJS.Timeout>();
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
      const started = new Date().toISOString();
      await collectCycle(engine, collectors, undefined, shutdown.signal);
      if (publish && !stopped) { engine.sealReady(undefined, started); await worker.run(); }
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
    })().catch(error => { store.event('warn', `Telegram command polling failed: ${safeError(error)}`); })
      .finally(async () => { try { await notifications?.flush(); } finally { commands = undefined; } });
    return commands;
  };
  const start = (): void => {
    if (started || stopped) return;
    started = true;
    const every = (ms: number, task: () => Promise<void>): void => {
      const timer = setInterval(() => { void task().catch(error => { store.event('error', `Background task failed: ${safeError(error)}`); }); }, ms);
      timer.unref(); timers.add(timer);
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
          .finally(() => {
            if (stopped) return;
            const timer = setTimeout(() => { timers.delete(timer); pollLoop(); }, 500);
            timer.unref(); timers.add(timer);
          });
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
      const workerStopped = worker.stop();
      stopping = (async () => {
        await Promise.allSettled([cycle, commands, menu, workerStopped]);
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
  { command: 'map', args: '<X_ID> [bluesky=ID sharkey=ID telegram=ID]', description: '查看或設定 ID 映射；平台=- 可清除單一平台' },
  { command: 'maps', description: '列出所有 X 到其他平台的 ID 映射' },
  { command: 'unmap', args: '<X_ID>', description: '刪除這個 X ID 的所有平台映射' },
  { command: 'approve', args: '<batchId>', description: '批准一個被保留的批次，發布到下游' },
  { command: 'skip', args: '<batchId>', description: '略過（不同步）某個批次' },
  { command: 'mirror', args: '<id> [X_URL]', description: '標記為你手動鏡像，之後不再同步' },
  { command: 'retry', args: '<jobId>', description: '重試一個明確失敗的工作' },
  { command: 'resync', args: '<jobId>', description: 'retry 別名：重試明確失敗的工作' },
  { command: 'reconcile', args: '<jobId>', description: '對帳後重試 unknown 工作（先自行確認遠端沒有重複貼文）' },
  { command: 'cancel', args: '<jobId>', description: '放棄發不出去的工作（不再發送或重試）' },
  { command: 'session', description: '更新 X 登入：接著上傳 x-session.json（或在檔案說明打 /session）' },
];

function helpText(): string {
  const lines = TELEGRAM_COMMANDS.map(c => `/${c.command}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  return ['📋 Wherry 指令', ...lines, '', '💡 更新 X 登入：打 /session 再上傳 x-session.json（或直接在檔案說明打 /session）。上傳的檔案會在安裝後自動刪除。', 'ℹ️ X 發文一律手動；本工具只讀 X、把新貼文同步到 Bluesky / Sharkey。'].join('\n');
}

const SESSION_LABELS: Record<string, string> = { authenticated: '已登入', error: '登入失效，請重新 /session', unknown: '尚未確認', disabled: '未啟用' };
const ATTENTION = new Set(['failed', 'unknown', 'review']);

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? '剛剛' : minutes < 60 ? `${minutes} 分鐘前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小時前` : `${Math.round(minutes / 1440)} 天前`;
}

/** Batches still waiting on the owner, with what the owner needs to decide: an excerpt and whether approve can publish. */
function heldBatches(engine: Engine) {
  return engine.store.batches(100).filter(b => b.state === 'review' || b.state === 'open').map(b => {
    const posts = engine.store.batchPosts(b.id).map(p => p.post);
    const hold = engine.holdReason(b.id);
    return { ...b, approvable: !hold || holdIsApprovable(hold), count: posts.length, text: posts[0]?.text ?? '', url: posts[0]?.url };
  });
}

function statusText({ engine, store }: CommandContext): string {
  const { config } = engine;
  const jobs = store.jobs(100);
  const tally = (['failed', 'unknown', 'review', 'pending', 'running'] as const)
    .map(state => [state, jobs.filter(j => j.state === state).length] as const).filter(([, n]) => n)
    .map(([state, n]) => `${LABELS[state]} ${n}`).join(' · ');
  const attention = jobs.filter(j => ATTENTION.has(j.state)).slice(0, 8).map(j =>
    `• ${j.destination} ${j.aggregateId}：${LABELS[j.state]}${j.error ? `（${j.error.slice(0, 80)}）` : ''}\n  ${j.state === 'unknown' ? '/reconcile' : '/retry'} ${j.id}\n  /cancel ${j.id}`);
  const events = store.events(8).map(e => `${e.level === 'error' ? '❌' : e.level === 'warn' ? '⚠️' : '•'} ${ago(e.at)}：${(readableEvent(e.message) ?? e.message).slice(0, 120)}`);
  return [
    '📊 Wherry 狀態',
    `模式：${config.mode === 'live' ? '正式（會發布）' : '預覽（不會發布）'}`,
    `X 登入：${SESSION_LABELS[store.setting<string>('x:session_state', config.x.enabled ? 'unknown' : 'disabled')] ?? '尚未確認'}`,
    `待你決定：${heldBatches(engine).length} 批（/pending 查看）`,
    `工作：${tally || '沒有進行中的工作'}`,
    ...(attention.length ? ['', '需要處理：', ...attention] : []),
    ...(events.length ? ['', '近期事件：', ...events] : []),
  ].join('\n');
}

async function handleCommand(raw: string, context: CommandContext): Promise<void> {
  // Accept "/cmd", "/cmd@BotName" and arguments; ignore anything that is not a slash command.
  const parts = raw.trim().split(/\s+/u);
  const command = (parts[0] || '').split('@')[0]!.toLowerCase();
  const id = parts[1]; const extra = parts.slice(2).join(' ');
  if (!command.startsWith('/')) return;
  try {
    if (command === '/help' || command === '/start') await context.telegram.sendPlain(helpText(), 'private');
    else if (command === '/status') await context.telegram.sendPlain(statusText(context).slice(0, 3900), 'private');
    else if (command === '/pending') {
      const held = heldBatches(context.engine);
      const reminders = context.store.pendingReminders(context.engine.config.telegram.privateChatId);
      const body = [
        ...held.map(b => `• ${b.id}｜${LABELS[b.state]}：${describe(b.reason)}${b.text ? `\n  ${Array.from(b.text).slice(0, 60).join('')}` : ''}\n  ${b.approvable ? `/approve ${b.id} · ` : ''}/skip ${b.id} · /mirror ${b.id}`),
        ...reminders.map(r => `• ${r.aggregateId}\n  X 提醒：${r.state}（請操作原提醒或 /mirror <id> <X_URL>）`),
      ].join('\n\n') || '目前沒有等待處理的批次或提醒。';
      await context.telegram.sendPlain(`待處理批次（${held.length}）\n\n${body}`, 'private');
    }
    else if (['/map', '/maps', '/unmap'].includes(command)) {
      let reply: string;
      try {
        const show = (handle: string, targets: MentionTargets): string => `X @${handle}\n${(['bluesky', 'sharkey', 'telegram'] as const)
          .map(platform => `  ${platform}：${targets[platform] ? `@${targets[platform]}` : '未設定（連回 X）'}`).join('\n')}`;
        if (command === '/maps') {
          if (parts.length !== 1) throw new Error('用法：/maps');
          reply = [...context.store.mentionMappings()].map(([handle, targets]) => show(handle, targets)).join('\n\n') || '目前沒有 ID 映射。用 /map <X_ID> bluesky=ID sharkey=ID telegram=ID 加入。';
        } else {
          if (!id || parts.length > (command === '/unmap' ? 2 : Infinity)) throw new Error(`用法：${command} <X_ID>${command === '/map' ? ' [bluesky=ID sharkey=ID telegram=ID]' : ''}`);
          const handle = normalizeXHandle(id);
          const patch: Partial<Record<Destination, string | null>> = {};
          for (const arg of parts.slice(2)) {
            const match = arg.match(/^(bluesky|sharkey|telegram)=(.+)$/i);
            if (!match) throw new Error('格式：/map X_ID bluesky=alice.bsky.social sharkey=@alice@dvd.chat telegram=@alice_tg；平台=- 可清除。');
            const platform = match[1]!.toLowerCase() as Destination;
            if (Object.hasOwn(patch, platform)) throw new Error(`平台 ${platform} 重複填寫。`);
            patch[platform] = match[2] === '-' ? null : match[2]!;
          }
          if (command === '/unmap') reply = context.store.deleteMentionMapping(handle) ? `已刪除 @${handle} 的 ID 映射。` : `@${handle} 沒有 ID 映射。`;
          else {
            const targets = parts.length > 2 ? context.store.setMentionMapping(handle, patch) : context.store.mentionMapping(handle);
            reply = `${parts.length > 2 ? '已儲存 ID 映射。\n' : ''}${show(handle, targets)}`;
          }
        }
      } catch (error) { reply = `ID 映射未變更：${error instanceof Error ? error.message : '輸入無效'}`; }
      await context.telegram.sendPlain(reply, 'private');
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
    else if (command === '/cancel' && id) { context.engine.action('cancel', id); await context.telegram.sendPlain(`已放棄 ${id}，不會再發送或重試。`, 'private'); }
    else if (['/skip', '/mirror', '/approve', '/retry', '/resync', '/reconcile', '/cancel'].includes(command)) await context.telegram.sendPlain(`${command} 需要一個 ID。例如：${command} <id>。用 /pending 查看待處理批次。`, 'private');
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
  app.get('/api/status', async () => ({
    mode: runtime.config.mode,
    xSession: runtime.store.setting<string>('x:session_state', runtime.config.x.enabled ? 'unknown' : 'disabled'),
    tokenRequired: Boolean(runtime.config.webToken), destinations: runtime.config.destinations,
    jobs: runtime.store.jobs(100), batches: runtime.store.batches(100), held: heldBatches(runtime.engine), events: runtime.store.events(50).map(e => ({ ...e, text: readableEvent(e.message) })),
  }));
  app.get('/api/posts', async () => runtime.store.posts(100));
  app.post('/api/scan', async () => { await runtime.once(); return { ok: true }; });
  app.post<{ Body: { action: Parameters<Engine['action']>[0]; id: string } }>('/api/action', async (request, reply) => {
    try {
      runtime.engine.action(request.body.action, request.body.id);
      // Deliver now instead of on the next poll, like the Telegram commands do.
      if (['approve', 'retry', 'reconcile'].includes(request.body.action)) void runtime.worker.run().catch(() => undefined);
      return { ok: true };
    }
    catch (error) { return reply.code(400).send({ error: safeError(error) }); }
  });
  app.post<{ Body: { text: string; attachments?: unknown[]; dueAt?: string } }>('/api/schedule', async (request, reply) => {
    // No dueAt = now, stamped here: a client-side "now" is already in the past when it arrives.
    const now = new Date().toISOString();
    try { return { id: runtime.engine.schedule({ text: request.body.text, attachments: request.body.attachments as never, dueAt: request.body.dueAt || now }, now) }; }
    catch (error) { return reply.code(400).send({ error: safeError(error) }); }
  });
  app.get('/', async (_request, reply) => { reply.type('text/html; charset=utf-8'); return html; });
  return app;
}

const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cdefs%3E%3ClinearGradient id='bg' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%232aa6f5'/%3E%3Cstop offset='1' stop-color='%230b6fc2'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='512' height='512' fill='url(%23bg)'/%3E%3Cpath d='M270 118 L356 146 Q338 224 366 300 L270 300 Z' fill='%23fff'/%3E%3Cpath d='M242 146 L242 300 L162 300 Q206 226 242 146 Z' fill='%23fff' opacity='.82'/%3E%3Crect x='250' y='104' width='14' height='212' rx='7' fill='%23fff'/%3E%3Cpath d='M132 318 H380 Q366 376 318 382 H194 Q146 376 132 318 Z' fill='%23fff'/%3E%3Cpath d='M116 420 q35 -22 70 0 t70 0 t70 0 t70 0' fill='none' stroke='%23fff' stroke-width='14' stroke-linecap='round' opacity='.55'/%3E%3C/svg%3E";

// Client code stays free of backticks, backslashes and "${" so it can live in this template literal as-is.
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Wherry</title><link rel="icon" href="${icon}"><style>
:root{--bg:#f4f6f8;--card:#fff;--text:#0f1419;--muted:#5b6b78;--line:#e3e8ec;--soft:#eef2f4;--accent:#1d9bf0;--ok:#00875a;--warn:#9a6700;--err:#d1242f;--ok-bg:#dcf5ea;--warn-bg:#fff4d4;--err-bg:#fde8ea;--info-bg:#e2f1fd}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8d9aa7;--line:#2a323c;--soft:#222931;--accent:#4aa8f5;--ok:#3fcf8e;--warn:#e8b339;--err:#ff7b85;--ok-bg:#12352a;--warn-bg:#382c0c;--err-bg:#3f1a1f;--info-bg:#0f2a42}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC",system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:.65rem 1rem}
.bar{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
h1{font-size:1.1rem;margin:0 .35rem 0 0;display:flex;align-items:center;gap:.45rem}h1 img{border-radius:6px}
.pill,.tag{font-size:.76rem;font-weight:600;padding:.15rem .55rem;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
.tag{border-radius:6px}
.ok{background:var(--ok-bg);color:var(--ok)}.warn{background:var(--warn-bg);color:var(--warn)}.err{background:var(--err-bg);color:var(--err)}.info{background:var(--info-bg);color:var(--accent)}
.spacer{flex:1}.updated{font-size:.78rem;color:var(--muted)}@media (max-width:520px){.updated{display:none}}
main{max-width:1180px;margin:1rem auto;padding:0 1rem;display:grid;gap:1rem}
@media (min-width:960px){main{grid-template-columns:minmax(0,1fr) 360px;align-items:start}.side{position:sticky;top:4.2rem}}
.col{display:grid;gap:1rem;min-width:0}
.banner{border:1px solid var(--line);border-radius:12px;padding:.7rem 1rem;font-size:.88rem;background:var(--warn-bg)}
.banner.err{background:var(--err-bg)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem}
h2{font-size:1rem;margin:0 0 .7rem;display:flex;align-items:center;gap:.45rem}
.count{font-size:.74rem;font-weight:700;background:var(--soft);color:var(--muted);border-radius:999px;padding:0 .5rem;min-width:1.4rem;text-align:center}
.count.hot{background:var(--err);color:#fff}
.hint{color:var(--muted);font-size:.83rem;margin:-.35rem 0 .6rem}
.item{border:1px solid var(--line);border-radius:10px;padding:.7rem .85rem;margin-top:.55rem}
.item.attn{border-left:3px solid var(--err)}.item.decide{border-left:3px solid var(--warn)}
.head{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
.head .spacer{min-width:.5rem}
.meta{color:var(--muted);font-size:.8rem}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.76rem;color:var(--muted);word-break:break-all}
.text{margin:.4rem 0 0;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.text.short{-webkit-line-clamp:2;font-size:.88rem}
.note{font-size:.83rem;margin-top:.4rem;color:var(--muted)}.note.bad{color:var(--err);word-break:break-word}
.actions{display:flex;gap:.45rem;flex-wrap:wrap;margin-top:.6rem;align-items:center}
button{font:inherit;font-size:.86rem;font-weight:600;border:1px solid transparent;border-radius:999px;padding:.38rem .9rem;cursor:pointer;background:var(--accent);color:#fff}
button.go{background:var(--ok)}button.ghost{background:transparent;border-color:var(--line);color:var(--text)}
button:hover:not(:disabled){filter:brightness(1.08)}button.ghost:hover:not(:disabled){background:var(--soft)}
button:disabled{opacity:.55;cursor:progress}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
input,textarea{font:inherit;width:100%;padding:.5rem .65rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
textarea{resize:vertical;min-height:6rem}
label{display:block;font-size:.83rem;color:var(--muted);margin:.55rem 0 .2rem}
code{font-size:.85em;background:var(--soft);padding:0 .3rem;border-radius:4px}
.empty{color:var(--muted);font-size:.88rem;padding:.3rem 0}
summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin-top:.6rem}
.evt{display:grid;grid-template-columns:auto 1fr;gap:.1rem .6rem;font-size:.82rem;padding:.4rem 0;border-top:1px solid var(--line)}
.evt:first-child{border-top:0}.evt time{color:var(--muted);white-space:nowrap}.evt span{word-break:break-word}
.evt.lv-error span{color:var(--err)}.evt.lv-warn span{color:var(--warn)}
.evt summary{margin:0;font-size:.82rem}.evt.lv-error summary{color:var(--err)}.evt.lv-warn summary{color:var(--warn)}.evt details span{display:block;margin-top:.2rem}
button.small{font-size:.76rem;padding:.15rem .65rem}
.toast{position:fixed;left:50%;bottom:1.2rem;transform:translate(-50%,.8rem);background:var(--text);color:var(--bg);padding:.6rem 1.1rem;border-radius:999px;font-size:.87rem;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:calc(100% - 2rem)}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.bad{background:var(--err);color:#fff}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
input[type=checkbox]{width:1.05rem;height:1.05rem;margin:0;accent-color:var(--accent);cursor:pointer;flex:none}
#held-bulk,#jobs-bulk{position:sticky;top:3.4rem;z-index:2}
.bulk{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;padding:.45rem .7rem;border-radius:10px;background:var(--soft);min-height:2.6rem}
.bulk label{display:inline-flex;align-items:center;gap:.35rem;margin:0 .3rem 0 0;color:var(--text);font-size:.85rem;cursor:pointer}
[hidden]{display:none!important}
</style></head><body>
<header><div class="bar"><h1><img src="${icon}" alt="" width="24" height="24">Wherry</h1><span id="mode" class="pill">載入中…</span><span id="xsess" class="pill" hidden></span><span class="spacer"></span><span id="updated" class="updated"></span><button id="scan" title="收集一次並發送到期的工作">立即檢查</button></div></header>
<main>
<div class="col">
<div id="offline" class="banner err" role="alert" hidden>連不上 Wherry 服務，會自動重試。</div>
<div id="preview" class="banner" hidden><b>預覽模式</b>：照常讀取與分類，但不會真的發布到任何平台。確認行為正確後把 <code>APP_MODE</code> 改成 <code>live</code>。</div>
<form id="token-box" class="banner" hidden><label for="token" style="margin-top:0">這個服務設定了 WEB_TOKEN，操作前請先輸入：</label><div class="row"><input id="token" type="password" autocomplete="off" style="flex:1;min-width:12rem"><button type="submit">儲存</button></div></form>
<section><h2>等你決定 <span id="held-count" class="count">0</span></h2><p class="hint">X 上無法自動判斷的新內容會停在這裡；串文收集中的批次也可以提早發布。</p><div id="held-bulk"></div><div id="held"><div class="empty">載入中…</div></div></section>
<section><h2>發送工作 <span id="jobs-count" class="count">0</span></h2><div id="jobs-bulk"></div><div id="jobs"><div class="empty">載入中…</div></div><details id="jobs-more" hidden><summary>已完成與已取消（<span id="jobs-done-count">0</span>）</summary><div id="jobs-done"></div></details></section>
<section><h2>最近讀到的貼文</h2><p class="hint">每則的分類與原因；沒同步的貼文為什麼沒同步，看這裡。</p><div id="posts"><div class="empty">載入中…</div></div></section>
</div>
<div class="col side">
<section><h2>排程貼文</h2><p class="hint">只發布到其他平台；X 仍需你自己發。</p><form id="schedule"><label for="s-text" style="margin-top:0">內容</label><textarea id="s-text" placeholder="要同步到其他平台的文字" required></textarea><div id="s-count" class="meta" style="text-align:right">0 字</div><label for="s-due">發布時間（留空＝立即）</label><input id="s-due" type="datetime-local"><div class="actions"><button type="submit" class="go">建立排程</button><span class="meta">⌘／Ctrl + Enter</span></div></form></section>
<section><h2>近期事件 <span id="evt-count" class="count" hidden></span><span class="spacer"></span><button type="button" id="evt-raw" class="ghost small" aria-pressed="false">顯示原文</button></h2><div id="events"><div class="empty">載入中…</div></div></section>
</div>
</main><div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
const L=${JSON.stringify(LABELS)};
const PLATFORM=${JSON.stringify(PLATFORM_NAMES)};
const KIND={publish:'發布',reminder:'X 提醒',ops:'待決通知',retract:'刪除副本'};
const SESSION={authenticated:['X 已登入','ok'],error:['X 登入失效','err'],unknown:['X 登入未確認',''],disabled:['X 讀取未啟用','']};
const TONE={succeeded:'ok',sealed:'ok',ready:'ok',manual_mirror:'ok',mirror:'ok',open:'info',collecting:'info',pending:'info',running:'info',review:'warn',mirror_review:'warn',failed:'err',unknown:'err',unsupported:'err'};
const DONE={approve:'已批准，背景發布中',skip:'已略過',mirror:'已標記為手動鏡像',retry:'已排入重試',reconcile:'已排入重新發送',cancel:'已放棄'};
const $=s=>document.querySelector(s);
const busy=new Set();const picked=new Set();const openEvt=new Set();let rawEvents=false;try{rawEvents=localStorage.getItem('evtRaw')==='1'}catch{}let scopes={};let status={};let loading=false;
const rtf=new Intl.RelativeTimeFormat('zh-Hant',{numeric:'auto'});
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function label(code){return esc(L[code]||code)}
function tag(code){return '<span class="tag '+(TONE[code]||'')+'" title="'+esc(code)+'">'+label(code)+'</span>'}
function ago(iso){const t=Date.parse(iso);if(!t)return '';const s=(t-Date.now())/1000;if(Math.abs(s)<45)return '剛剛';for(const [unit,size] of [['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return rtf.format(Math.round(s/size),unit);return rtf.format(Math.round(s),'second')}
function when(iso){return iso?'<time datetime="'+esc(iso)+'" title="'+esc(new Date(iso).toLocaleString('zh-TW'))+'">'+ago(iso)+'</time>':''}
function link(url,text){return /^https?:/.test(url||'')?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+text+' ↗</a>':''}
function btn(verb,id,text,cls){const off=busy.has(verb+':'+id)?' disabled':'';return '<button type="button" class="'+(cls||'ghost')+'" data-act="'+verb+'" data-id="'+esc(id)+'"'+off+'>'+text+'</button>'}
function put(id,html){const el=document.getElementById(id);if(el.dataset.h!==html){el.dataset.h=html;el.innerHTML=html}}
let toastTimer;function toast(message,bad){const t=$('#toast');t.textContent=message;t.className='toast show'+(bad?' bad':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className='toast'+(bad?' bad':'')},bad?4500:2400)}
function token(){try{return localStorage.getItem('webToken')||''}catch{return ''}}
function askToken(){$('#token-box').hidden=false;$('#token').focus()}
async function post(path,body){const headers={'content-type':'application/json'};if(token())headers.authorization='Bearer '+token();
const r=await fetch(path,{method:'POST',headers,body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));
if(r.status===401){askToken();throw new Error('需要正確的 Web token')}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function confirmText(verb,n){const these=n>1?'這 '+n+' 筆':'這則';
if(verb==='approve')return status.mode==='live'?'確定把'+these+'發布到 '+((status.destinations||[]).map(d=>PLATFORM[d]||d).join('、')||'其他平台')+'？發出後無法自動收回。':'';
if(verb==='skip')return these+'略過後不會同步，之後也無法再批准。確定？';
if(verb==='mirror')return these+'標記為手動鏡像後不會同步。確定？';
if(verb==='cancel')return (n>1?'這 '+n+' 個工作':'這個工作')+'放棄後不會再發送或重試。確定？';
if(verb==='reconcile')return '請先到該平台確認這則沒有成功發出（沒有重複貼文）。確定重新發送未確認的部分？';
return ''}
// One request per id: the same validated endpoint as a single click, so a bulk run can't bypass any per-item check.
async function act(verb,ids){const q=confirmText(verb,ids.length);if(q&&!confirm(q))return;for(const id of ids)busy.add(verb+':'+id);render();let failed=0,last='';
for(const id of ids){try{await post('/api/action',{action:verb,id});picked.delete(id)}catch(e){failed++;last=e.message}finally{busy.delete(verb+':'+id)}}
if(failed)toast((ids.length>1?(ids.length-failed)+' 筆完成、'+failed+' 筆失敗：':'失敗：')+last,true);else toast((ids.length>1?ids.length+' 筆':'')+DONE[verb]);await load()}
function pick(id){return '<input type="checkbox" data-pick="'+esc(id)+'" aria-label="選取"'+(picked.has(id)?' checked':'')+'>'}
function bulkBar(scope){const {items,verbs}=scopes[scope];if(items.length<2)return '';const sel=items.filter(i=>picked.has(i.id));
let h='<label><input type="checkbox" data-all="'+scope+'"'+(sel.length===items.length?' checked':'')+'>全選</label>';
if(sel.length){h+='<span class="meta">已選 '+sel.length+' 筆</span>';for(const [verb,text,ok,cls] of verbs){const n=sel.filter(ok).length;if(n)h+='<button type="button" class="'+(cls||'ghost')+'" data-bulk="'+verb+'" data-scope="'+scope+'">'+text+'（'+n+'）</button>'}
h+='<button type="button" class="ghost" data-clear="'+scope+'">取消選取</button>'}return '<div class="bulk">'+h+'</div>'}
function heldItem(b){const collecting=b.state==='open';const approve=!b.approvable?'':btn('approve',b.id,collecting?'立即發布':b.reason==='long_x_post_requires_manual_review'?'仍要發布（自動分段）':'發布到其他平台','go');
return '<div class="item '+(collecting?'':'decide')+'"><div class="head">'+pick(b.id)+tag(b.state)+'<span>'+label(b.reason)+'</span><span class="spacer"></span><span class="meta">'+when(b.rootCreatedAt)+'</span></div>'
+(b.text?'<div class="text">'+esc(b.text)+'</div>':'')
+'<div class="note">'+[b.count>1?'串文共 '+b.count+' 則':'',link(b.url,'在 X 開啟'),'<span class="id">'+esc(b.id)+'</span>'].filter(Boolean).join(' · ')+'</div>'
+(b.approvable?'':'<div class="note">這種內容無法自動同步；需要的話請自行貼到其他平台。</div>')
+'<div class="actions">'+approve+btn('skip',b.id,'略過')+btn('mirror',b.id,'我已手動鏡像')+'</div></div>'}
const stuck=j=>j.state==='failed'||j.state==='unknown'||j.state==='review';
function jobItem(j){const attn=stuck(j);
const action=!attn?'':(j.state==='unknown'?btn('reconcile',j.id,'確認沒發出，重新發送','go'):btn('retry',j.id,'重試','go'))+btn('cancel',j.id,'放棄');
return '<div class="item'+(attn?' attn':'')+'"><div class="head">'+(attn?pick(j.id):'')+tag(j.state)+'<b>'+esc(PLATFORM[j.destination]||j.destination)+'</b><span class="meta">'+esc(KIND[j.kind]||j.kind)+(j.attempts?' · 第 '+j.attempts+' 次':'')+'</span><span class="spacer"></span><span class="meta">'+when(j.dueAt)+'</span></div>'
+'<div class="note"><span class="id">'+esc(j.aggregateId)+'</span></div>'
+(j.error?'<div class="note'+(attn?' bad':'')+'">'+label(j.error)+'</div>':'')+(j.state==='unknown'?'<div class="note">送出結果不明，不會自動重試。請到該平台確認：沒發出就重新發送，已經發出就放棄。</div>':'')
+(action?'<div class="actions">'+action+'</div>':'')+'</div>'}
function postItem(p){return '<div class="item"><div class="head">'+tag(p.classification)+'<b>'+esc(PLATFORM[p.post.platform]||p.post.platform)+'</b><span class="meta">'+label(p.reason)+'</span><span class="spacer"></span><span class="meta">'+when(p.post.createdAt)+'</span></div>'
+(p.post.text?'<div class="text short">'+esc(p.post.text)+'</div>':'')
+'<div class="note">'+[link(p.post.url,'原文'),p.batchId?'<span class="id">'+esc(p.batchId)+'</span>':''].filter(Boolean).join(' · ')+'</div></div>'}
// Readable by default; the header button flips every event to its raw log line. A line with no
// translation stays behind a disclosure, kept open across the 5s refresh by its timestamp.
function evtItem(e){const body=rawEvents?'<span>'+esc(e.message)+'</span>':e.text?'<span title="'+esc(e.message)+'">'+esc(e.text)+'</span>'
:'<details data-k="'+esc(e.at)+'"'+(openEvt.has(e.at)?' open':'')+'><summary>無法解讀的事件，點開看原文</summary><span>'+esc(e.message)+'</span></details>';
return '<div class="evt lv-'+esc(e.level)+'">'+when(e.at)+body+'</div>'}
function rawBtn(){const b=$('#evt-raw');b.textContent=rawEvents?'顯示解讀':'顯示原文';b.setAttribute('aria-pressed',String(rawEvents))}
function count(id,n,hot){const el=document.getElementById(id);el.textContent=n;el.className='count'+(hot&&n?' hot':'')}
function render(){const s=status;if(!s.mode)return;
const mode=$('#mode');mode.textContent=s.mode==='live'?'正式模式':'預覽模式';mode.className='pill '+(s.mode==='live'?'ok':'warn');$('#preview').hidden=s.mode==='live';
const sess=SESSION[s.xSession]||SESSION.unknown;const xs=$('#xsess');xs.textContent=sess[0];xs.className='pill '+sess[1];xs.hidden=false;
if(s.tokenRequired&&!token())$('#token-box').hidden=false;
const held=s.held||[];count('held-count',held.length,true);document.title=(held.length?'('+held.length+') ':'')+'Wherry';
const jobs=s.jobs||[];const done=jobs.filter(j=>j.state==='succeeded'||j.state==='cancelled');const active=jobs.filter(j=>!done.includes(j));
const rank=j=>stuck(j)?0:1;active.sort((a,b)=>rank(a)-rank(b));
scopes={held:{items:held,verbs:[['approve','發布',b=>b.approvable,'go'],['skip','略過',()=>true],['mirror','我已手動鏡像',()=>true]]},
jobs:{items:active.filter(stuck),verbs:[['retry','重試',j=>j.state!=='unknown','go'],['cancel','放棄',()=>true]]}};
const live=new Set([...scopes.held.items,...scopes.jobs.items].map(i=>i.id));for(const id of picked)if(!live.has(id))picked.delete(id);
put('held-bulk',bulkBar('held'));put('jobs-bulk',bulkBar('jobs'));
put('held',held.length?held.map(heldItem).join(''):'<div class="empty">沒有等你決定的內容。</div>');
count('jobs-count',scopes.jobs.items.length,true);
put('jobs',active.length?active.map(jobItem).join(''):'<div class="empty">沒有進行中或失敗的工作。</div>');
$('#jobs-more').hidden=!done.length;$('#jobs-done-count').textContent=done.length;put('jobs-done',done.slice(0,40).map(jobItem).join(''));
const posts=s.posts||[];put('posts',posts.length?posts.slice(0,40).map(postItem).join(''):'<div class="empty">還沒讀到任何貼文。按「立即檢查」讀一次。</div>');
const events=(s.events||[]).slice(0,25);const errors=events.filter(e=>e.level==='error'&&Date.now()-Date.parse(e.at)<86400000).length;
const ec=$('#evt-count');ec.hidden=!errors;ec.textContent=errors+' 錯誤';ec.className='count hot';
put('events',events.length?events.map(evtItem).join(''):'<div class="empty">尚無事件。</div>')}
async function load(){if(loading)return;loading=true;
try{const [s,posts]=await Promise.all([fetch('/api/status').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}),fetch('/api/posts').then(r=>r.ok?r.json():[]).catch(()=>[])]);
status=Object.assign(s,{posts});$('#offline').hidden=true;$('#updated').textContent='更新於 '+new Date().toLocaleTimeString('zh-TW',{hour12:false});render()}
catch(e){$('#offline').hidden=false}finally{loading=false}}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
if(d.act)act(d.act,[d.id]);
else if(d.bulk){const {items,verbs}=scopes[d.scope];const ok=verbs.find(v=>v[0]===d.bulk)[2];act(d.bulk,items.filter(i=>picked.has(i.id)&&ok(i)).map(i=>i.id))}
else if(d.clear){for(const i of scopes[d.clear].items)picked.delete(i.id);render()}});
document.addEventListener('change',e=>{const d=e.target.dataset||{};
if(d.pick){if(e.target.checked)picked.add(d.pick);else picked.delete(d.pick);render()}
else if(d.all){for(const i of scopes[d.all].items){if(e.target.checked)picked.add(i.id);else picked.delete(i.id)}render()}});
document.addEventListener('toggle',e=>{const k=e.target.dataset&&e.target.dataset.k;if(k){if(e.target.open)openEvt.add(k);else openEvt.delete(k)}},true);
$('#evt-raw').addEventListener('click',()=>{rawEvents=!rawEvents;try{localStorage.setItem('evtRaw',rawEvents?'1':'')}catch{}rawBtn();render()});rawBtn();
$('#scan').addEventListener('click',async e=>{const b=e.currentTarget;b.disabled=true;b.textContent='檢查中…';
try{await post('/api/scan');toast('檢查完成')}catch(err){toast('檢查失敗：'+err.message,true)}finally{b.disabled=false;b.textContent='立即檢查';load()}});
$('#token-box').addEventListener('submit',e=>{e.preventDefault();try{localStorage.setItem('webToken',$('#token').value.trim())}catch{}$('#token-box').hidden=true;toast('已儲存 token')});
const text=$('#s-text');text.addEventListener('input',()=>{$('#s-count').textContent=Array.from(text.value.trim()).length+' 字'});
text.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')$('#schedule').requestSubmit()});
$('#schedule').addEventListener('submit',async e=>{e.preventDefault();const b=e.submitter||$('#schedule button');const due=$('#s-due').value;
b.disabled=true;try{await post('/api/schedule',{text:text.value.trim(),dueAt:due?new Date(due).toISOString():undefined});toast(due?'已排程：'+new Date(due).toLocaleString('zh-TW',{hour12:false}):'已排入發布');text.value='';$('#s-due').value='';$('#s-count').textContent='0 字';load()}
catch(err){toast('排程失敗：'+err.message,true)}finally{b.disabled=false}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
load();setInterval(()=>{if(!document.hidden)load()},5000);
</script></body></html>`;
