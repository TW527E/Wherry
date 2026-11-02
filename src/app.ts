import { createHash, timingSafeEqual } from 'node:crypto';
import { FastifyInstance, fastify } from 'fastify';
import { loadConfig, type AppConfig } from './config.js';
import { SafeHttp } from './security/http.js';
import { Store } from './store.js';
import { Engine, Worker, collectCycle, holdIsApprovable, safeError } from './engine.js';
import { LABELS, PLATFORM_NAMES, describe, readableEvent } from './labels.js';
import { BlueskyClient } from './platforms/bluesky.js';
import { SharkeyClient } from './platforms/sharkey.js';
import { ArgonClient } from './platforms/argon.js';
import { TelegramClient, type TelegramUpdateMessage } from './platforms/telegram.js';
import { deletionButtons, deletionNotice, extractXStatus, handleCallback, handleReminderReply, handleReviewReply, TelegramNotifications } from './telegram-notifications.js';
import { SerialWork } from './lifecycle.js';
import { XCollector, installSession } from './platforms/x.js';
import { parseSessionFile, MAX_SESSION_BYTES } from './platforms/session.js';
import { normalizeXHandle, type MentionTargets } from './mentions.js';
import { pruneMedia, saveUpload } from './media.js';
import type { Attachment, Collector, Destination, Publisher, RemoteRef } from './types.js';

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
  // Publish-only: nothing posted to the 說說 page is read back, so there is no collector.
  if (live && config.argon.enabled && config.argon.username && config.argon.appPassword) publishers.set('argon', new ArgonClient(config.argon, transport));
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
  let deadlines: Promise<void> | undefined;

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
    // Telegram copies can only be deleted for 48 hours, so hour-47 checks cannot wait for a long poll
    // interval. They ask the embed endpoint only (no browser scan) and back off on failure; the heavy
    // lane keeps them from overlapping a cycle, and the single-flight guard keeps ticks from queueing.
    if (live && telegram && config.x.enabled) every(60_000, () => {
      if (deadlines || stopped || !store.telegramPostsToRecheck(new Date().toISOString()).length) return Promise.resolve();
      deadlines = heavy.run(async () => { if (!stopped && await engine.checkTelegramDeadlines()) await worker.run(); })
        .finally(() => { deadlines = undefined; });
      return deadlines;
    });
    const maintain = async (): Promise<void> => {
      const now = new Date().toISOString();
      const pruned = store.prune(now);
      const media = await pruneMedia(config.dataDir, store.mediaInUse(), Date.parse(now));
      if (stopped) return;
      if (pruned.events + pruned.settings + media) store.event('info', `Housekeeping removed ${pruned.events} old events, ${pruned.settings} finished bookkeeping entries and ${media} unused media files`);
    };
    void maintain().catch(error => { if (!stopped) store.event('warn', `Housekeeping failed: ${safeError(error)}`); });
    every(86_400_000, maintain);
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
    /** True while a collect/publish cycle is running, so the UI can show it instead of blocking on it. */
    scanning: () => Boolean(cycle),
    stop: () => {
      if (stopping) return stopping;
      stopped = true;
      shutdown.abort();
      for (const timer of timers) clearInterval(timer);
      const workerStopped = worker.stop();
      stopping = (async () => {
        await Promise.allSettled([cycle, commands, menu, deadlines, workerStopped]);
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
  { command: 'deleted', args: '<jobId>', description: '確認已手動刪除失敗工作的所有 Telegram 副本' },
  { command: 'session', description: '更新 X 登入：接著上傳 x-session.json（或在檔案說明打 /session）' },
];

function helpText(): string {
  const lines = TELEGRAM_COMMANDS.map(c => `/${c.command}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  return ['📋 Wherry 指令', ...lines, '', '💡 更新 X 登入：打 /session 再上傳 x-session.json（或直接在檔案說明打 /session）。上傳的檔案會在安裝後自動刪除。', 'ℹ️ X 發文一律手動；本工具只讀 X、把新貼文同步到 Bluesky / Sharkey。'].join('\n');
}

const SESSION_LABELS: Record<string, string> = { authenticated: '已登入', error: '登入失效，請重新 /session', unknown: '尚未確認', disabled: '未啟用' };
const ATTENTION = new Set(['failed', 'unknown', 'review']);

function until(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return minutes < 1 ? '即將發布' : minutes < 60 ? `${minutes} 分鐘後` : minutes < 1440 ? `${Math.round(minutes / 60)} 小時後` : `${Math.round(minutes / 1440)} 天後`;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? '剛剛' : minutes < 60 ? `${minutes} 分鐘前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小時前` : `${Math.round(minutes / 1440)} 天前`;
}

/** Batches still waiting on the owner, with what the owner needs to decide: an excerpt and whether approve can publish. */
function heldBatches(engine: Engine) {
  return engine.store.heldBatches().map(b => {
    const posts = engine.store.batchPosts(b.id).map(p => p.post);
    const hold = engine.holdReason(b.id);
    return { ...b, approvable: !hold || holdIsApprovable(hold), count: posts.length, text: posts[0]?.text ?? '', url: posts[0]?.url };
  });
}

function scheduledText(engine: Engine, batchId: string): string {
  const text = engine.store.batchPosts(batchId)[0]?.post.text ?? '';
  return text ? `\n  「${Array.from(text).slice(0, 60).join('')}」` : '';
}

function statusText({ engine, store }: CommandContext): string {
  const { config } = engine;
  const jobs = store.visibleJobs(100);
  const tally = (['failed', 'unknown', 'review', 'pending', 'running'] as const)
    .map(state => [state, jobs.filter(j => j.state === state).length] as const).filter(([, n]) => n)
    .map(([state, n]) => `${LABELS[state]} ${n}`).join(' · ');
  const attention = jobs.filter(j => ATTENTION.has(j.state)).slice(0, 8).map(j =>
    `• ${j.destination} ${j.aggregateId}：${LABELS[j.state]}${j.error ? `（${j.error.slice(0, 80)}）` : ''}\n  ${j.state === 'unknown' ? '/reconcile' : '/retry'} ${j.id}\n  /cancel ${j.id}${j.kind === 'retract' && j.destination === 'telegram' ? `\n  /deleted ${j.id}\n${engine.telegramDeletionLinks(j).join('\n')}` : ''}`);
  const events = store.events(8).map(e => `${e.level === 'error' ? '❌' : e.level === 'warn' ? '⚠️' : '•'} ${ago(e.at)}：${(readableEvent(e.message) ?? e.message).slice(0, 120)}`);
  return [
    '📊 Wherry 狀態',
    `模式：${config.mode === 'live' ? '正式（會發布）' : '預覽（不會發布）'}`,
    `X 登入：${SESSION_LABELS[store.setting<string>('x:session_state', config.x.enabled ? 'unknown' : 'disabled')] ?? '尚未確認'}`,
    `待你決定：${heldBatches(engine).length} 批、${store.telegramDeletionFailures().length} 筆 Telegram 刪除失敗（/pending 查看）`,
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
      const deletions = context.store.telegramDeletionFailures();
      const scheduled = context.store.scheduledBatches(20);
      const at = (iso: string) => new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      const decide = [
        ...held.map(b => `• ${LABELS[b.state]}：${describe(b.reason)}${b.text ? `\n  「${Array.from(b.text).slice(0, 60).join('')}」` : ''}\n  ${b.approvable ? `/approve ${b.id} · ` : ''}/skip ${b.id} · /mirror ${b.id}`),
        ...reminders.map(r => `• X 提醒：${r.aggregateId}\n  請操作原提醒，或 /mirror ${r.aggregateId} <X_URL>`),
      ];
      const body = [
        decide.length || deletions.length ? [`等你決定（${decide.length + deletions.length}）`, ...decide, ...(deletions.length ? [`• Telegram 副本刪不掉 ${deletions.length} 筆（下方各一則通知）`] : [])].join('\n') : '',
        scheduled.length ? [`排程中（${scheduled.length}）`, ...scheduled.map(b => `• ${at(b.dueAt)}（${until(b.dueAt)}）→ ${b.destinations.map(d => PLATFORM_NAMES[d] ?? d).join('、')}${scheduledText(context.engine, b.id)}\n  取消：/skip ${b.id}`)].join('\n') : '',
      ].filter(Boolean).join('\n\n') || '目前沒有等你決定的事，也沒有排程中的貼文。';
      await context.telegram.sendPlain(body, 'private');
      for (const job of deletions) await context.telegram.sendPlain(deletionNotice(job, context.engine), 'private', deletionButtons(job));
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
    else if (command === '/skip' && id) { context.engine.action('skip', id); await context.telegram.sendPlain(id.startsWith('local:') ? `已取消排程${scheduledText(context.engine, id).trim() ? `：${scheduledText(context.engine, id).trim()}` : ` ${id}`}，不會發布。` : `已跳過 ${id}`, 'private'); }
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
    else if (command === '/deleted' && id) { context.engine.action('deleted', id); await context.telegram.sendPlain(`已記錄 ${id} 的 Telegram 副本已手動刪除，工作已完成。`, 'private'); }
    else if (['/skip', '/mirror', '/approve', '/retry', '/resync', '/reconcile', '/cancel', '/deleted'].includes(command)) await context.telegram.sendPlain(`${command} 需要一個 ID。例如：${command} <id>。用 /pending 查看待處理批次。`, 'private');
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
// The page shell and the health probe carry no data, so they load before the owner has entered a token.
const publicPaths = new Set(['/', '/healthz']);
const loopbackNames = new Set(['127.0.0.1', 'localhost', '[::1]']);

class AuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Constant-time string comparison: hash both sides so the lengths match too. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Guards every endpoint. With a token, every data route needs it — reads included, since status,
 * events and posts are private too. Without one (loopback only), the Host header must name loopback:
 * a DNS-rebinding page has its own hostname there, and since its Origin then matches that Host, the
 * cross-origin check below alone would let it through. Writes additionally refuse form-style and
 * cross-origin requests, so a page the owner happens to visit cannot drive the service.
 */
function authorize(method: string, path: string, headers: Record<string, string | string[] | undefined>, config: AppConfig): void {
  const header = headers.authorization;
  if (config.webToken) {
    if (publicPaths.has(path)) return;
    if (typeof header === 'string' && sameSecret(header, `Bearer ${config.webToken}`)) return;
    throw new AuthError('Unauthorized', 401);
  }
  let hostname = '';
  try { hostname = new URL(`http://${String(headers.host ?? '')}`).hostname; } catch { /* rejected below */ }
  if (!loopbackNames.has(hostname)) throw new AuthError('Host header must be a loopback address', 403);
  if (!writeMethods.has(method)) return;
  if (config.host !== '127.0.0.1' && config.host !== '::1') throw new AuthError('Unauthorized', 401);
  // A JSON content type forces a CORS preflight for cross-origin callers, and HTML forms
  // cannot set it at all, which blocks localhost CSRF.
  const contentType = headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) throw new AuthError('Unsupported media type', 415);
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    const host = headers.host;
    try { if (typeof host !== 'string' || new URL(origin).host !== host) throw new Error('Cross-origin request rejected'); }
    catch { throw new AuthError('Cross-origin request rejected', 403); }
  }
}

// A scheduled post carries at most four images, each sent as base64 JSON so the write stays a JSON
// request (the CSRF guard relies on that); this bounds one image and the whole body.
const MAX_UPLOAD_IMAGE_BYTES = 10_000_000;
const SCHEDULE_BODY_LIMIT = Math.ceil(4 * MAX_UPLOAD_IMAGE_BYTES * 4 / 3) + 1_000_000;

export async function createWeb(runtime: Runtime): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    try { authorize(request.method, request.url.split('?')[0]!, request.headers, runtime.config); }
    catch (error) { await reply.code(error instanceof AuthError ? error.status : 401).send({ error: safeError(error) }); }
  });
  app.get('/healthz', async () => ({ ok: true, mode: runtime.config.mode }));
  app.get('/api/status', async () => ({
    mode: runtime.config.mode,
    xSession: runtime.store.setting<string>('x:session_state', runtime.config.x.enabled ? 'unknown' : 'disabled'),
    tokenRequired: Boolean(runtime.config.webToken), destinations: runtime.config.destinations, scanning: runtime.scanning(),
    jobs: runtime.store.visibleJobs(100).map(job => ({ ...job, summary: runtime.engine.jobSummary(job) })),
    batches: runtime.store.batches(100), held: heldBatches(runtime.engine), events: runtime.store.events(50).map(e => ({ ...e, text: readableEvent(e.message) })),
    deletions: runtime.store.telegramDeletionFailures().map(job => ({ ...job, links: runtime.engine.telegramDeletionLinks(job), summary: runtime.engine.jobSummary(job),
      deleteBy: runtime.store.telegramDeleteBy(job.aggregateId.slice('x:'.length)) })),
    scheduled: runtime.store.scheduledBatches().map(batch => ({ ...batch, text: runtime.store.batchPosts(batch.id)[0]?.post.text ?? '',
      images: runtime.store.batchPosts(batch.id)[0]?.post.attachments.length ?? 0 })),
  }));
  app.get('/api/posts', async () => runtime.store.posts(100));
  // A cycle can take minutes in a real browser, so the request only starts it; /api/status reports `scanning`.
  app.post('/api/scan', async () => { const started = !runtime.scanning(); void runtime.once(); return { ok: true, started }; });
  app.post<{ Body: { action: Parameters<Engine['action']>[0]; id: string } }>('/api/action', async (request, reply) => {
    try {
      runtime.engine.action(request.body.action, request.body.id);
      // Deliver now instead of on the next poll, like the Telegram commands do.
      if (['approve', 'retry', 'reconcile'].includes(request.body.action)) void runtime.worker.run().catch(() => undefined);
      return { ok: true };
    }
    catch (error) { return reply.code(400).send({ error: safeError(error) }); }
  });
  app.post<{ Body: { text: string; attachments?: unknown[]; images?: Array<{ data?: unknown; alt?: unknown }>; dueAt?: string; destinations?: Destination[] } }>('/api/schedule',
    { bodyLimit: SCHEDULE_BODY_LIMIT }, async (request, reply) => {
      // No dueAt = now, stamped here: a client-side "now" is already in the past when it arrives.
      const now = new Date().toISOString();
      try {
        const images = request.body.images ?? [];
        if (!Array.isArray(images) || images.length > 4) throw new Error('At most four images can be attached');
        const uploaded: Attachment[] = [];
        for (const image of images) {
          if (typeof image?.data !== 'string' || (image.alt !== undefined && typeof image.alt !== 'string')) throw new Error('Each image needs base64 data and optional alt text');
          const bytes = Buffer.from(image.data, 'base64');
          if (!bytes.length || bytes.length > MAX_UPLOAD_IMAGE_BYTES) throw new Error(`Each image must be 1 byte to ${MAX_UPLOAD_IMAGE_BYTES / 1_000_000} MB`);
          uploaded.push(await saveUpload(bytes, String(image.alt ?? '').slice(0, 2000), runtime.config));
        }
        const attachments = [...(Array.isArray(request.body.attachments) ? request.body.attachments : []), ...uploaded];
        const id = runtime.engine.schedule({ text: request.body.text, attachments: attachments as never, dueAt: request.body.dueAt || now, destinations: request.body.destinations }, now);
        // A post due now goes out now, not on the next poll.
        if (!request.body.dueAt || Date.parse(request.body.dueAt) <= Date.now()) void runtime.worker.run().catch(() => undefined);
        return { id };
      }
      catch (error) { return reply.code(400).send({ error: safeError(error) }); }
    });
  app.get('/', async (_request, reply) => { reply.type('text/html; charset=utf-8'); return html; });
  return app;
}

const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Cdefs%3E%3ClinearGradient id='bg' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%232aa6f5'/%3E%3Cstop offset='1' stop-color='%230b6fc2'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='512' height='512' fill='url(%23bg)'/%3E%3Cpath d='M270 118 L356 146 Q338 224 366 300 L270 300 Z' fill='%23fff'/%3E%3Cpath d='M242 146 L242 300 L162 300 Q206 226 242 146 Z' fill='%23fff' opacity='.82'/%3E%3Crect x='250' y='104' width='14' height='212' rx='7' fill='%23fff'/%3E%3Cpath d='M132 318 H380 Q366 376 318 382 H194 Q146 376 132 318 Z' fill='%23fff'/%3E%3Cpath d='M116 420 q35 -22 70 0 t70 0 t70 0 t70 0' fill='none' stroke='%23fff' stroke-width='14' stroke-linecap='round' opacity='.55'/%3E%3C/svg%3E";

// Client code stays free of backticks, backslashes and "${" so it can live in this template literal as-is.
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Wherry</title><link rel="icon" href="${icon}"><style>
:root{--bg:#f3f5f7;--card:#fff;--text:#0f1419;--muted:#56636f;--body2:#3d4a55;--line:#e1e6ea;--field:#d5dce2;--soft:#e9edf0;--thumb:#dce4ea;--accent:#0a6fb8;--accent-bg:#e3f0fb;--on:#fff;--ok:#0b7a4b;--ok-text:#0b6b42;--ok-bg:#ddf3e8;--warn:#7a4f00;--warn-bg:#fff2cf;--warn-soft:#fff8e6;--err:#c1272d;--err-text:#a3161c;--err-bg:#fde7e8;--on-err:#fff;--inv:#0f1419;--on-inv:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#8d9aa7;--body2:#b4bfca;--line:#2a323c;--field:#3a444f;--soft:#222931;--thumb:#222931;--accent:#4aa8f5;--accent-bg:#0f2a42;--on:#0d1117;--ok:#3fcf8e;--ok-text:#3fcf8e;--ok-bg:#12352a;--warn:#e8b339;--warn-bg:#382c0c;--warn-soft:#262010;--err:#ff7b85;--err-text:#ff7b85;--err-bg:#3f1a1f;--on-err:#0d1117;--inv:#e6edf3;--on-inv:#0d1117}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Noto Sans TC","PingFang TC","Microsoft JhengHei",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
[hidden]{display:none!important}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:1240px;margin:0 auto;padding:.7rem 1.25rem;display:flex;align-items:center;gap:.6rem}
h1{font-size:1.12rem;margin:0 .4rem 0 0;display:flex;align-items:center;gap:.6rem}h1 img{border-radius:7px}
.pill{font-size:.8rem;font-weight:500;padding:.1rem .65rem;border-radius:999px;background:var(--soft);color:var(--body2);white-space:nowrap}
.tag{font-size:.75rem;font-weight:700;padding:.1rem .5rem;border-radius:6px;background:var(--soft);color:var(--body2);white-space:nowrap}
.ok{background:var(--ok-bg);color:var(--ok-text)}.warn{background:var(--warn-bg);color:var(--warn)}.err{background:var(--err-bg);color:var(--err-text)}.info{background:var(--accent-bg);color:var(--accent)}
.spacer{flex:1}.updated{font-size:.82rem;color:var(--muted);white-space:nowrap}
#dot{display:none;width:9px;height:9px;border-radius:999px;background:var(--ok);flex:none}#dot.warn{background:var(--warn)}#dot.err{background:var(--err)}
.sub{display:none;padding:.5rem 1rem 0;font-size:.82rem;color:var(--muted)}
main{max-width:1240px;margin:0 auto;padding:1.25rem;display:flex;flex-wrap:wrap;gap:1.25rem;align-items:flex-start}
.col{display:flex;flex-direction:column;gap:1.25rem;min-width:0}.col-main{flex:999 1 560px}.col-side{flex:1 1 360px}
.banners{flex:1 1 100%;display:flex;flex-direction:column;gap:.75rem}.banners:not(:has(>:not([hidden]))){display:none}
.banner{border:1px solid var(--line);border-radius:12px;padding:.7rem 1rem;font-size:.9rem;background:var(--warn-bg);display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.banner.err{background:var(--err-bg);color:var(--err-text);border-color:transparent}
main.stale section{opacity:.55}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.25rem;min-width:0}
h2{font-size:1.06rem;margin:0;display:flex;align-items:center;gap:.6rem;font-weight:700;flex-wrap:wrap}
.count{font-size:.75rem;font-weight:700;min-width:1.4rem;text-align:center;padding:0 .45rem;border-radius:999px;background:var(--soft);color:var(--body2)}
.count.hot{background:var(--err);color:var(--on-err)}
.attn{font-size:.85rem;font-weight:500;color:var(--err-text)}
.hint{color:var(--muted);font-size:.88rem;margin:.25rem 0 0}
.item{border:1px solid var(--line);border-radius:10px;padding:1rem;margin-top:.75rem;display:flex;flex-direction:column;gap:.55rem}
.head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.title{font-weight:500;font-size:.92rem}
.meta{color:var(--muted);font-size:.82rem}.bad{color:var(--err-text)}
.id{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;color:var(--muted);word-break:break-all}
.text{margin:0;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.text.short{-webkit-line-clamp:2;font-size:.92rem}
.note{font-size:.88rem;color:var(--body2)}.note.bad{color:var(--err-text);word-break:break-word}
.box{border-radius:8px;padding:.6rem .75rem;font-size:.88rem;color:var(--body2);background:var(--warn-soft)}
.links{display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:.88rem;align-items:center}
.actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
button{font:inherit;font-size:.88rem;font-weight:500;min-height:40px;padding:0 1rem;border-radius:8px;border:1px solid var(--field);background:var(--card);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:.45rem}
button.primary{background:var(--accent);border-color:transparent;color:var(--on)}button.go{background:var(--ok);border-color:transparent;color:var(--on)}
button.small{min-height:32px;font-size:.82rem;padding:0 .65rem}
button:hover:not(:disabled){filter:brightness(1.06)}button:not(.primary):not(.go):hover:not(:disabled){background:var(--soft)}
button:disabled{opacity:.6;cursor:default}
.tabs{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.75rem}.tabs button,.seg button{min-height:34px;font-size:.82rem;padding:0 .75rem}
.tabs button[aria-pressed=true],.seg button[aria-pressed=true]{background:var(--inv);color:var(--on-inv);border-color:var(--inv)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
input,textarea{font:inherit;width:100%;padding:.55rem .75rem;border:1px solid var(--field);border-radius:8px;background:var(--card);color:var(--text)}
input[aria-invalid=true]{border:1.5px solid var(--err)}
textarea{resize:vertical;min-height:7.5rem}
.field{display:flex;flex-direction:column;gap:.35rem}.field>label,.lbl,legend{font-size:.88rem;font-weight:500}
.row2{display:flex;justify-content:space-between;gap:.5rem;font-size:.82rem;color:var(--muted)}.warn-text{color:var(--warn)}
#schedule{display:flex;flex-direction:column;gap:.9rem;margin-top:.9rem}
.imgs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem}
.thumb{position:relative;aspect-ratio:1;border-radius:8px;background:var(--thumb);overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb button{position:absolute;top:4px;right:4px;width:28px;height:28px;min-height:28px;padding:0;border-radius:999px;border:0;background:rgba(15,20,25,.82);color:#fff;font-size:1rem}
.add{position:relative;aspect-ratio:1;border-radius:8px;border:1.5px dashed var(--field);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.15rem;font-size:.82rem;color:var(--body2);cursor:pointer}
.add:focus-within{outline:2px solid var(--accent);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0 0 0 0)}
fieldset{border:0;padding:0;margin:0;min-width:0}legend{padding:0;margin-bottom:.4rem}
.chips{display:flex;gap:.5rem;flex-wrap:wrap}.chips label{display:inline-flex;align-items:center;gap:.4rem;min-height:40px;padding:0 .75rem;border:1px solid var(--field);border-radius:8px;font-size:.88rem;cursor:pointer}
.chips label:has(input:checked){border-color:var(--accent);background:var(--accent-bg)}
input[type=checkbox]{width:1.1rem;height:1.1rem;margin:0;padding:0;accent-color:var(--accent);flex:none;cursor:pointer}
.seg{display:flex;gap:.5rem}
.list>div{padding:.75rem 0;border-top:1px solid var(--line)}.list>div:first-child{border-top:0}.list{margin-top:.25rem}
.up{display:flex;flex-direction:column;gap:.35rem}
.prow{display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap}.prow .t{flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list>.empty,.empty{display:flex;flex-direction:column;align-items:center;gap:.25rem;text-align:center;padding:1rem 0 .5rem;color:var(--muted);font-size:.88rem;border:0}.empty b{color:var(--text);font-size:.95rem}
.evt{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:.5rem;font-size:.88rem;padding:.5rem 0;border-top:1px solid var(--line)}
.evt:first-child{border-top:0}.evt time{color:var(--muted);white-space:nowrap}.evt span{word-break:break-word}
.evt.lv-error span,.evt.lv-error summary{color:var(--err-text)}.evt.lv-warn span,.evt.lv-warn summary{color:var(--warn)}
.evt summary{cursor:pointer}.evt details span{display:block;margin-top:.2rem}
#events{margin-top:.5rem}
.toast{position:fixed;left:50%;bottom:1.2rem;transform:translate(-50%,.8rem);background:var(--inv);color:var(--on-inv);padding:.65rem 1rem;border-radius:10px;font-size:.88rem;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:calc(100% - 2rem);z-index:9}
.toast.show{opacity:1;transform:translate(-50%,0)}.toast.bad{background:var(--err);color:var(--on-err)}
#held-bulk,#jobs-bulk{position:sticky;top:3.9rem;z-index:2}
.bulk{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;padding:.45rem .7rem;margin-top:.75rem;border-radius:10px;background:var(--soft);min-height:2.6rem}
.bulk label{display:inline-flex;align-items:center;gap:.35rem;margin:0 .3rem 0 0;font-size:.85rem;cursor:pointer}
.token{flex:1 1 100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.25rem}
.token>div{max-width:440px;display:flex;flex-direction:column;gap:.7rem}.token b{font-size:1.06rem}
.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.toast{transition:none}}
.m-only{display:none!important}
@media (max-width:959px){main{flex-direction:column;flex-wrap:nowrap;align-items:stretch;padding:.75rem 1rem 1.5rem;gap:1rem}
.col{display:contents}.banners{order:0}#sec-held{order:1}#sec-jobs{order:2}#sec-upcoming{order:3}#sec-sched{order:4}#sec-posts{order:5}#sec-events{order:6}
.m-only{display:inline-flex!important}body:not(.composing) #sec-sched{display:none}body:not(.evt-open) #events{display:none}
section{padding:1rem}button{min-height:44px}.tabs button,.seg button,button.small{min-height:40px}.chips label{min-height:44px}
.item .actions>button{flex:1 1 calc(50% - .5rem)}#sec-sched{border-color:var(--accent)}#held-bulk,#jobs-bulk{top:3.4rem}}
@media (max-width:600px){.pill,#updated,.d-only{display:none}#dot{display:inline-block}.sub{display:block}.bar{padding:.6rem 1rem}#scan{padding:0 .8rem}}
</style></head><body>
<header><div class="bar"><h1><img src="${icon}" alt="" width="28" height="28">Wherry</h1><span id="dot" role="img" aria-label="載入中"></span><span id="mode" class="pill">載入中…</span><span id="xsess" class="pill" hidden></span><span class="spacer"></span><span id="updated" class="updated"></span><button id="scan" class="primary" title="收集一次並發送到期的工作"><span id="scan-ico"></span><span id="scan-label">立即檢查</span></button></div></header>
<div id="sub" class="sub"></div>
<main id="main">
<div class="banners">
<div id="offline" class="banner err" role="alert" hidden><span id="offline-text" style="flex:1">連不上 Wherry。</span><button type="button" id="retry-now" class="small">現在重試</button></div>
<div id="preview" class="banner" hidden><span><b>預覽模式</b>：照常讀取與分類，但不會真的發布到任何平台。確認行為正確後把 <code>APP_MODE</code> 改成 <code>live</code>。</span></div>
<form id="token-box" class="token" hidden><div><b>輸入存取權杖</b><p class="hint" style="margin:0">這台 Wherry 有設定 WEB_TOKEN。權杖只存在這個瀏覽器。</p><div class="field"><label for="token">權杖</label><input id="token" type="password" autocomplete="off" aria-describedby="token-err"></div><div id="token-err" class="note bad" role="alert" hidden></div><div class="actions"><button type="submit" class="primary">確認並連線</button></div></div></form>
</div>
<div class="col col-main">
<section id="sec-held"><h2>等你決定 <span id="held-count" class="count">0</span></h2><p class="hint">需要你按一下才會繼續的事情，最舊的在最上面。</p><div id="held-bulk"></div><div id="held"><div class="empty">載入中…</div></div></section>
<section id="sec-jobs"><h2>發送工作 <span id="jobs-count" class="count">0</span><span id="jobs-attn" class="attn"></span></h2><div id="jobs-tabs" class="tabs" role="group" aria-label="篩選發送工作"></div><div id="jobs-bulk"></div><div id="jobs"><div class="empty">載入中…</div></div></section>
<section id="sec-posts"><h2>最近讀到的貼文</h2><p class="hint">每則有沒有同步、為什麼。</p><div id="posts" class="list"><div class="empty">載入中…</div></div></section>
</div>
<div class="col col-side">
<section id="sec-sched"><h2>排程貼文<span class="spacer"></span><button type="button" id="compose-close" class="small m-only">收起</button></h2><p class="hint">只發布到其他平台；X 仍需你自己發。</p>
<form id="schedule">
<div class="field"><label for="s-text">內容</label><textarea id="s-text" placeholder="要發到其他平台的文字（可直接貼上圖片）"></textarea><div class="row2"><span id="s-hint"></span><span id="s-count">0 字</span></div></div>
<div class="field"><span class="lbl" id="s-img-lbl">圖片 <span class="meta">（選填，最多 4 張：JPEG／PNG／WebP／GIF）</span></span><div id="s-imgs" class="imgs" role="group" aria-labelledby="s-img-lbl"></div><div id="s-alts" class="field"></div></div>
<fieldset><legend>發布到</legend><div id="s-dest" class="chips"></div></fieldset>
<div class="field"><span class="lbl" id="s-when-lbl">什麼時候發</span><div class="seg" role="group" aria-labelledby="s-when-lbl"><button type="button" data-when="now" aria-pressed="true">現在</button><button type="button" data-when="later" aria-pressed="false">指定時間</button></div><input id="s-due" type="datetime-local" aria-label="發布時間" hidden></div>
<div class="actions"><button type="submit" id="s-submit" class="go">立即發布</button><span class="meta">⌘／Ctrl + Enter</span></div>
</form></section>
<section id="sec-upcoming"><h2>排程中 <span id="up-count" class="count">0</span><span class="spacer"></span><button type="button" id="compose" class="go small m-only">＋ 新排程</button></h2><div id="upcoming" class="list"><div class="empty">載入中…</div></div></section>
<section id="sec-events"><h2>近期事件 <span id="evt-count" class="count hot" hidden></span><span class="spacer"></span><button type="button" id="evt-raw" class="small" aria-pressed="false">顯示原文</button><button type="button" id="evt-toggle" class="small m-only" aria-expanded="false" aria-controls="events">展開</button></h2><div id="events"><div class="empty">載入中…</div></div></section>
</div>
</main><div id="toast" class="toast" role="status" aria-live="polite"></div>
<script>
const L=${JSON.stringify(LABELS)};
const PLATFORM=${JSON.stringify(PLATFORM_NAMES)};
const KIND={publish:'發布',reminder:'X 提醒',ops:'待決通知',retract:'刪除副本'};
const SESSION={authenticated:['X 已登入','ok'],error:['X 登入失效','err'],unknown:['X 登入未確認',''],disabled:['X 讀取未啟用','']};
const TONE={succeeded:'ok',retracted:'ok',sealed:'ok',ready:'ok',manual_mirror:'ok',mirror:'ok',open:'info',collecting:'info',pending:'info',running:'info',review:'warn',mirror_review:'warn',failed:'err',unknown:'err',unsupported:'err'};
const JOB={failed:['發送失敗','err'],unknown:['不確定有沒有發出','warn'],review:['需要你確認','warn'],pending:['等待發送','info'],running:['發送中','info'],succeeded:['已完成','ok'],cancelled:['已取消','']};
const MIRROR_REASONS=['possible_manual_mirror','multiple_possible_manual_mirrors'];
const TABS=[['attn','需要處理'],['active','進行中'],['done','已完成']];
const DONE={approve:'已批准，背景發布中',skip:'已略過',mirror:'已標記為手動鏡像',retry:'已排入重試',reconcile:'已排入重新發送',cancel:'已放棄',deleted:'已記錄手動刪除，工作已完成',unschedule:'已取消排程'};
// Client-only verbs that reuse a server action with their own wording.
const ACTION={unschedule:'skip'};
const TYPES=['image/jpeg','image/png','image/webp','image/gif'];
const ICON={refresh:'<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
spin:'<svg class="spin" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
ok:'<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="var(--ok-bg)"/><path d="M10 16.5l4 4 8-9" fill="none" stroke="var(--ok)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
clock:'<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="var(--soft)"/><circle cx="16" cy="16" r="7" fill="none" stroke="var(--muted)" stroke-width="1.8"/><path d="M16 12v4l3 2" fill="none" stroke="var(--muted)" stroke-width="1.8" stroke-linecap="round"/></svg>',
plus:'<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'};
const $=s=>document.querySelector(s);
const busy=new Set();const picked=new Set();const openEvt=new Set();let rawEvents=false;try{rawEvents=localStorage.getItem('evtRaw')==='1'}catch{}
let scopes={};let status={};let loading=false;let scanning=false;let offline=false;let lastOk=0;let jobTab='attn';let tabPinned=false;let destReady=false;let whenMode='now';let timer=0;let memToken='';
const files=[];const alts=[];const urls=[];
const rtf=new Intl.RelativeTimeFormat('zh-Hant',{numeric:'auto'});
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function label(code){return esc(L[code]||code)}
function chip(text,tone,title){return '<span class="tag '+(tone||'')+'"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(text)+'</span>'}
function tag(code){return chip(L[code]||code,TONE[code],code)}
function ago(iso){const t=Date.parse(iso);if(!t)return '';const s=(t-Date.now())/1000;if(Math.abs(s)<45)return '剛剛';for(const [unit,size] of [['day',86400],['hour',3600],['minute',60]])if(Math.abs(s)>=size)return rtf.format(Math.round(s/size),unit);return rtf.format(Math.round(s),'second')}
function when(iso){return iso?'<time datetime="'+esc(iso)+'" title="'+esc(new Date(iso).toLocaleString('zh-TW'))+'">'+ago(iso)+'</time>':''}
function clock(t){return new Date(t).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false})}
function fmtDue(iso){const d=new Date(iso);const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();const diff=Math.round((day(d)-day(new Date()))/86400000);const hm=clock(d.getTime());
if(diff===0)return (d.getHours()>=18?'今晚 ':'今天 ')+hm;if(diff===1)return '明天 '+hm;return (d.getMonth()+1)+'/'+d.getDate()+'（'+d.toLocaleDateString('zh-TW',{weekday:'narrow'})+'）'+hm}
function link(url,text){return /^https?:/.test(url||'')?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+text+' ↗</a>':''}
function btn(verb,id,text,cls){const off=busy.has(verb+':'+id)||offline?' disabled':'';return '<button type="button"'+(cls?' class="'+cls+'"':'')+' data-act="'+verb+'" data-id="'+esc(id)+'"'+off+'>'+text+'</button>'}
function put(id,html){const el=document.getElementById(id);if(el.dataset.h!==html){el.dataset.h=html;el.innerHTML=html}}
function empty(icon,title,text){return '<div class="empty">'+(icon||'')+'<b>'+title+'</b>'+(text?'<span>'+text+'</span>':'')+'</div>'}
let toastTimer;function toast(message,bad){const t=$('#toast');t.textContent=message;t.className='toast show'+(bad?' bad':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className='toast'+(bad?' bad':'')},bad?4500:2600)}
function token(){try{return localStorage.getItem('webToken')||memToken}catch{return memToken}}
// A background poll re-asks with no message; it must not wipe the reason the owner's last try failed.
function needToken(message){const box=$('#token-box');const was=box.hidden;box.hidden=false;if(!message&&!was)return;const err=$('#token-err');err.textContent=message||'';err.hidden=!message;$('#token').setAttribute('aria-invalid',message?'true':'false');if(was)$('#token').focus()}
function auth(){return token()?{authorization:'Bearer '+token()}:{}}
async function get(path){const r=await fetch(path,{headers:auth()});if(r.status===401){needToken(token()?'存的權杖已失效，請重新輸入。':'');throw new Error('unauthorized')}if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function post(path,body){const headers=Object.assign({'content-type':'application/json'},auth());
const r=await fetch(path,{method:'POST',headers,body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));
if(r.status===401){needToken('權杖不對，伺服器拒絕了（401）。');throw new Error('需要正確的存取權杖')}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function confirmText(verb,n){const these=n>1?'這 '+n+' 筆':'這則';
if(verb==='approve')return status.mode==='live'?'確定把'+these+'發布到 '+((status.destinations||[]).map(d=>PLATFORM[d]||d).join('、')||'其他平台')+'？發出後無法自動收回。':'';
if(verb==='skip')return these+'略過後不會同步，之後也無法再批准。確定？';
if(verb==='mirror')return these+'標記為手動鏡像後不會同步。確定？';
if(verb==='cancel')return '確定停止'+(n>1?'這 '+n+' 個工作':'這個工作')+'，不再重試？已存在的遠端訊息會保留。';
if(verb==='reconcile')return '請先到該平台確認這則沒有成功發出（沒有重複貼文）。確定重新發送未確認的部分？';
if(verb==='deleted')return '確認已在 Telegram 手動刪除這則貼文的所有訊息？記錄後將結束工作，不再重試刪除。';
if(verb==='unschedule')return '取消這則排程？取消後不會發布到任何平台。';
return ''}
// One request per id: the same validated endpoint as a single click, so a bulk run can't bypass any per-item check.
async function act(verb,ids){const q=confirmText(verb,ids.length);if(q&&!confirm(q))return;for(const id of ids)busy.add(verb+':'+id);render();let failed=0,last='';
for(const id of ids){try{await post('/api/action',{action:ACTION[verb]||verb,id});picked.delete(id)}catch(e){failed++;last=e.message}finally{busy.delete(verb+':'+id)}}
if(failed)toast((ids.length>1?(ids.length-failed)+' 筆完成、'+failed+' 筆失敗：':'失敗：')+last,true);else toast((ids.length>1?ids.length+' 筆':'')+DONE[verb]);await load()}
function pick(id){return '<input type="checkbox" data-pick="'+esc(id)+'" aria-label="選取"'+(picked.has(id)?' checked':'')+'>'}
function bulkBar(scope){const {items,verbs}=scopes[scope];if(items.length<2)return '';const sel=items.filter(i=>picked.has(i.id));
let h='<label><input type="checkbox" data-all="'+scope+'"'+(sel.length===items.length?' checked':'')+'>全選</label>';
if(sel.length){h+='<span class="meta">已選 '+sel.length+' 筆</span>';for(const [verb,text,ok,cls] of verbs){const n=sel.filter(ok).length;if(n)h+='<button type="button" class="small '+(cls||'')+'" data-bulk="'+verb+'" data-scope="'+scope+'"'+(offline?' disabled':'')+'>'+text+'（'+n+'）</button>'}
h+='<button type="button" class="small" data-clear="'+scope+'">取消選取</button>'}return '<div class="bulk">'+h+'</div>'}
const stuck=j=>j.state==='failed'||j.state==='unknown'||j.state==='review';
const deletionChoice=j=>j.kind==='retract'&&j.destination==='telegram'&&stuck(j);
function heldItem(b){const collecting=b.state==='open';
const kind=collecting?chip('收集中','info',b.state):MIRROR_REASONS.includes(b.reason)?chip('要不要同步','warn',b.state):chip('需要你確認','warn',b.state);
const approve=!b.approvable?'':btn('approve',b.id,collecting?'立即發布':b.reason==='long_x_post_requires_manual_review'?'仍要發布（自動分段）':'發布到其他平台','go');
return '<article class="item"><div class="head">'+pick(b.id)+kind+'<span class="title">'+label(b.reason)+'</span><span class="spacer"></span><span class="meta">'+when(b.rootCreatedAt)+'</span></div>'
+(b.text?'<p class="text">'+esc(b.text)+'</p>':'')
+'<div class="links meta">'+[b.count>1?'<span>串文共 '+b.count+' 則</span>':'',link(b.url,'在 X 開啟'),'<span class="id">'+esc(b.id)+'</span>'].filter(Boolean).join('')+'</div>'
+(b.approvable?'':'<div class="note">這種內容無法自動同步；需要的話請自行貼到其他平台。</div>')
+'<div class="actions">'+approve+btn('skip',b.id,'略過，不同步')+btn('mirror',b.id,'是我手動搬的')+'</div></article>'}
function deadline(iso){if(!iso)return ['',''];const h=(Date.parse(iso)-Date.now())/3600000;if(h<=0)return ['已超過 48 小時，只能到 Telegram 手動刪除','bad'];return [(h<1?'剩不到 1 小時':'剩約 '+Math.floor(h)+' 小時')+'可由機器人刪除',h<6?'bad':'']}
function deletionItem(j){const d=deadline(j.deleteBy);const s=j.summary||{};
return '<article class="item"><div class="head">'+chip('刪除失敗','err',j.state)+'<span class="title">X 原文已刪，Telegram 副本刪不掉</span><span class="spacer"></span>'+(d[0]?'<span class="meta '+d[1]+'">'+d[0]+'</span>':'')+'</div>'
+(s.text?'<p class="text">'+esc(s.text)+'</p>':'')
+'<div class="links">'+((j.links||[]).map((url,i)=>link(url,'開啟 Telegram 訊息 '+(i+1))).join('')||'<span class="note">這個聊天不支援訊息連結，請到 Telegram 聊天中找。</span>')+'</div>'
+(j.error?'<div class="note bad">原因：'+label(j.error)+'</div>':'')
+'<div class="note">先試「重試刪除」；不行的話到 Telegram 手動刪掉上面每一則，再按「我已手動刪除」。「不處理了」只停止重試，訊息會留著。</div>'
+'<div class="actions">'+btn('retry',j.id,'重試刪除','primary')+btn('deleted',j.id,'我已手動刪除')+btn('cancel',j.id,'不處理了')+'</div></article>'}
function jobItem(j){const attn=stuck(j);const st=j.kind==='retract'&&j.state==='succeeded'?['已刪除副本','ok']:(JOB[j.state]||[j.state,'']);const s=j.summary||{};const name=PLATFORM[j.destination]||j.destination;
let notes=j.error?'<div class="note'+(attn?' bad':'')+'">'+(attn?'原因：':'')+label(j.error)+'</div>':'';
if(j.state==='failed')notes+='<div class="note">沒有東西卡在半路。排除原因後按「重試」；不需要了就「放棄」。</div>';
if(j.state==='review')notes+='<div class="note">這個工作停下來等你決定：可以重試，或放棄。</div>';
if(j.state==='unknown')notes+='<div class="box">送出時中斷，不確定 '+esc(name)+' 有沒有收到。為了避免重複發文，這種情況不會自動重試；請先到 '+esc(name)+' 看一眼。</div>';
const acts=!attn?'':j.state==='unknown'?btn('reconcile',j.id,'沒看到，重新發送','primary')+btn('cancel',j.id,'已經有了，不用再發'):btn('retry',j.id,'重試','primary')+btn('cancel',j.id,'放棄');
return '<article class="item"><div class="head">'+(attn?pick(j.id):'')+chip(st[0],st[1],j.state)+'<b>'+esc(name)+'</b><span class="meta">'+esc(KIND[j.kind]||j.kind)+(j.attempts?' · 已試 '+j.attempts+' 次':'')+'</span><span class="spacer"></span><span class="meta">'+when(j.dueAt)+'</span></div>'
+(s.text?'<p class="text short">'+esc(s.text)+'</p>':'')+notes
+'<div class="actions">'+acts+'<span class="spacer"></span><span class="links meta">'+(s.url?link(s.url,'原文'):'')+'<span class="id">'+esc(j.aggregateId)+'</span></span></div></article>'}
function postItem(p){return '<div><div class="prow">'+tag(p.classification)+'<b>'+esc(PLATFORM[p.post.platform]||p.post.platform)+'</b><span class="t">'+esc(p.post.text||'（沒有文字）')+'</span><span class="meta">'+when(p.post.createdAt)+'</span></div>'
+'<div class="meta">'+[label(p.reason),link(p.post.url,'原文')].filter(Boolean).join(' · ')+'</div></div>'}
function upItem(b){const d=b.destinations||[];const all=d.length>1&&d.length===(status.destinations||[]).length;
return '<div class="up"><div class="head"><b>'+esc(fmtDue(b.dueAt))+'</b><span class="meta">'+[ago(b.dueAt),all?'全部平台':d.map(x=>PLATFORM[x]||x).join('、'),b.images?b.images+' 張圖':''].filter(Boolean).map(esc).join(' · ')+'</span></div>'
+(b.text?'<p class="text short">'+esc(b.text)+'</p>':'')+'<div>'+btn('unschedule',b.id,'取消排程','small')+'</div></div>'}
// Readable by default; the header button flips every event to its raw log line. A line with no
// translation stays behind a disclosure, kept open across the refresh by its timestamp.
function evtItem(e){const body=rawEvents?'<span>'+esc(e.message)+'</span>':e.text?'<span title="'+esc(e.message)+'">'+esc(e.text)+'</span>'
:'<details data-k="'+esc(e.at)+'"'+(openEvt.has(e.at)?' open':'')+'><summary>無法解讀的事件，點開看原文</summary><span>'+esc(e.message)+'</span></details>';
return '<div class="evt lv-'+esc(e.level)+'">'+when(e.at)+body+'</div>'}
function rawBtn(){const b=$('#evt-raw');b.textContent=rawEvents?'顯示解讀':'顯示原文';b.setAttribute('aria-pressed',String(rawEvents))}
function count(id,n,hot){const el=document.getElementById(id);el.textContent=n;el.className='count'+(hot&&n?' hot':'')}
function scanBtn(){const b=$('#scan');b.disabled=scanning||offline;b.setAttribute('aria-busy',String(scanning));put('scan-ico',scanning?ICON.spin:ICON.refresh);put('scan-label',scanning?'檢查中…':'<span class="d-only">立即</span>檢查')}
function render(){scanBtn();const s=status;if(!s.mode)return;
const live=s.mode==='live';const modeText=live?'正式模式':'預覽模式';const mode=$('#mode');mode.textContent=modeText;mode.className='pill '+(live?'ok':'warn');$('#preview').hidden=live;
const sess=SESSION[s.xSession]||SESSION.unknown;const xs=$('#xsess');xs.textContent=sess[0];xs.className='pill '+sess[1];xs.hidden=false;
const dot=$('#dot');dot.className=sess[1]==='err'?'err':live&&sess[1]==='ok'?'':'warn';dot.setAttribute('aria-label',modeText+'，'+sess[0]);
$('#sub').textContent=[modeText,sess[0],lastOk?'更新於 '+clock(lastOk):''].filter(Boolean).join(' · ');
if(!destReady&&s.destinations){destReady=true;$('#s-dest').innerHTML=s.destinations.map(d=>'<label><input type="checkbox" value="'+esc(d)+'" checked>'+esc(PLATFORM[d]||d)+'</label>').join('')||'<span class="meta">沒有設定任何下游平台（DESTINATIONS）。</span>';lengthHint()}
const held=s.held||[];const deletions=s.deletions||[];const decisions=held.length+deletions.length;count('held-count',decisions,true);document.title=(decisions?'('+decisions+') ':'')+'Wherry';
const later=new Set((s.scheduled||[]).map(b=>b.id));
const jobs=(s.jobs||[]).filter(j=>!deletionChoice(j)&&!(j.state==='pending'&&later.has(j.aggregateId)));
const groups={attn:jobs.filter(stuck),active:jobs.filter(j=>j.state==='pending'||j.state==='running'),done:jobs.filter(j=>j.state==='succeeded'||j.state==='cancelled')};
// Open on what needs the owner; with nothing stuck, fall through to what is moving, then to history.
if(!tabPinned)jobTab=groups.attn.length?'attn':groups.active.length?'active':'done';
scopes={held:{items:held,verbs:[['approve','發布',b=>b.approvable,'go'],['skip','略過',()=>true],['mirror','是我手動搬的',()=>true]]},
jobs:{items:jobTab==='attn'?groups.attn:[],verbs:[['retry','重試',j=>j.state!=='unknown','primary'],['cancel','放棄',()=>true]]}};
const keep=new Set([...scopes.held.items,...scopes.jobs.items].map(i=>i.id));for(const id of picked)if(!keep.has(id))picked.delete(id);
put('held-bulk',bulkBar('held'));put('jobs-bulk',bulkBar('jobs'));
const queue=[...deletions.map(j=>[j.dueAt,deletionItem(j)]),...held.map(b=>[b.rootCreatedAt,heldItem(b)])].sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
put('held',queue.length?queue.map(q=>q[1]).join(''):empty(ICON.ok,'沒有要你決定的事','新貼文會自動同步'));
count('jobs-count',groups.attn.length+groups.active.length,false);$('#jobs-attn').textContent=groups.attn.length?'其中 '+groups.attn.length+' 個需要處理':'';
put('jobs-tabs',TABS.map(t=>'<button type="button" data-tab="'+t[0]+'" aria-pressed="'+(jobTab===t[0])+'">'+t[1]+' '+groups[t[0]].length+'</button>').join(''));
const shown=groups[jobTab].slice(0,jobTab==='done'?40:100);
put('jobs',shown.length?shown.map(jobItem).join(''):empty('',jobTab==='attn'?'沒有需要處理的工作':jobTab==='active'?'沒有進行中的工作':'還沒有完成的工作',''));
const up=s.scheduled||[];count('up-count',up.length,false);put('upcoming',up.length?up.map(upItem).join(''):empty(ICON.clock,'沒有排程中的貼文','用排程表單新增'));
const posts=s.posts||[];put('posts',posts.length?posts.slice(0,40).map(postItem).join(''):empty('','還沒讀到任何貼文','按「立即檢查」讀一次'));
const events=(s.events||[]).slice(0,25);const errors=events.filter(e=>e.level==='error'&&Date.now()-Date.parse(e.at)<86400000).length;
const ec=$('#evt-count');ec.hidden=!errors;ec.textContent=errors+' 錯誤';
put('events',events.length?events.map(evtItem).join(''):empty('','尚無事件',''))}
function setOffline(value){offline=value;$('#offline').hidden=!value;$('#main').classList.toggle('stale',value);
if(value)$('#offline-text').textContent='連不上 Wherry'+(lastOk?'，畫面是 '+clock(lastOk)+' 的資料':'')+'。每 15 秒自動重試。'}
function poll(){clearTimeout(timer);timer=setTimeout(()=>{if(!document.hidden)load()},offline?15000:scanning?2000:5000)}
async function load(){if(loading)return;loading=true;
try{const [s,posts]=await Promise.all([get('/api/status'),get('/api/posts').catch(()=>[])]);
const finished=scanning&&!s.scanning;scanning=Boolean(s.scanning);if(finished)toast('檢查完成');
status=Object.assign(s,{posts});lastOk=Date.now();setOffline(false);$('#token-box').hidden=true;$('#updated').textContent='更新於 '+clock(lastOk);render()}
catch(e){if(e.message!=='unauthorized'){setOffline(true);render()}}finally{loading=false;poll()}}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
if(d.act)act(d.act,[d.id]);
else if(d.bulk){const {items,verbs}=scopes[d.scope];const ok=verbs.find(v=>v[0]===d.bulk)[2];act(d.bulk,items.filter(i=>picked.has(i.id)&&ok(i)).map(i=>i.id))}
else if(d.clear){for(const i of scopes[d.clear].items)picked.delete(i.id);render()}
else if(d.tab){jobTab=d.tab;tabPinned=true;render()}
else if(d.when)setWhen(d.when);
else if('rm' in d)removeImg(Number(d.rm))});
document.addEventListener('change',e=>{const t=e.target;const d=t.dataset||{};
if(d.pick){if(t.checked)picked.add(d.pick);else picked.delete(d.pick);render()}
else if(d.all){for(const i of scopes[d.all].items){if(t.checked)picked.add(i.id);else picked.delete(i.id)}render()}
else if(t.id==='s-img'){addImgs(t.files);t.value=''}
else if(t.closest('#s-dest'))lengthHint()});
document.addEventListener('input',e=>{const d=e.target.dataset||{};if('alt' in d)alts[Number(d.alt)]=e.target.value});
document.addEventListener('toggle',e=>{const k=e.target.dataset&&e.target.dataset.k;if(k){if(e.target.open)openEvt.add(k);else openEvt.delete(k)}},true);
$('#evt-raw').addEventListener('click',()=>{rawEvents=!rawEvents;try{localStorage.setItem('evtRaw',rawEvents?'1':'')}catch{}rawBtn();render()});rawBtn();
$('#evt-toggle').addEventListener('click',e=>{const open=document.body.classList.toggle('evt-open');e.currentTarget.setAttribute('aria-expanded',String(open));e.currentTarget.textContent=open?'收起':'展開'});
$('#compose').addEventListener('click',()=>{document.body.classList.add('composing');$('#sec-sched').scrollIntoView({block:'start',behavior:'smooth'});text.focus({preventScroll:true})});
$('#compose-close').addEventListener('click',()=>{document.body.classList.remove('composing');$('#compose').focus()});
$('#retry-now').addEventListener('click',()=>load());
$('#scan').addEventListener('click',async()=>{scanning=true;scanBtn();
try{const r=await post('/api/scan');toast(r.started?'已開始檢查，可以繼續操作，完成後會自動更新':'已有一次檢查正在進行，不用再按')}catch(err){scanning=false;scanBtn();toast('檢查失敗：'+err.message,true)}poll()});
$('#token-box').addEventListener('submit',async e=>{e.preventDefault();const value=$('#token').value.trim();if(!value){needToken('請輸入權杖。');return}const b=e.submitter;if(b)b.disabled=true;
try{const r=await fetch('/api/status',{headers:{authorization:'Bearer '+value}});
if(r.status===401){needToken('權杖不對，伺服器拒絕了（401）。請確認和 .env 裡的 WEB_TOKEN 一樣。');return}
if(!r.ok){needToken('伺服器回應 HTTP '+r.status+'，請稍後再試。');return}
memToken=value;try{localStorage.setItem('webToken',value)}catch{}$('#token-box').hidden=true;$('#token').value='';toast('權杖正確，已連線');load()}
catch{needToken('連不上 Wherry，無法驗證權杖。')}finally{if(b)b.disabled=false}});
const text=$('#s-text');
function graphemeCount(value){if(window.Intl&&Intl.Segmenter){let n=0;for(const _ of new Intl.Segmenter('zh-Hant',{granularity:'grapheme'}).segment(value))n++;return n}return Array.from(value).length}
function dests(){return Array.from(document.querySelectorAll('#s-dest input:checked')).map(i=>i.value)}
// An estimate of the publisher's split, so the owner knows a thread is coming before it is posted.
function lengthHint(){const n=graphemeCount(text.value.trim());const d=dests();const notes=[];
if(d.includes('bluesky')&&n>300)notes.push('Bluesky 會分成約 '+Math.ceil(n/290)+' 則串文');
if(d.includes('sharkey')&&n>3000)notes.push('Sharkey 會分成約 '+Math.ceil(n/2900)+' 則');
if(d.includes('telegram')&&n>4096)notes.push('Telegram 會分成約 '+Math.ceil(n/4000)+' 則');
const h=$('#s-hint');h.textContent=notes.length?notes.join('、'):n?'每個平台都是 1 則':'';h.className=notes.length?'warn-text':'';$('#s-count').textContent=n+' 字'}
function renderImgs(){$('#s-imgs').innerHTML=files.map((f,i)=>'<div class="thumb"><img src="'+urls[i]+'" alt=""><button type="button" data-rm="'+i+'" aria-label="移除第 '+(i+1)+' 張圖片">×</button></div>').join('')
+(files.length<4?'<label class="add">'+ICON.plus+'<span>加圖片</span><input id="s-img" class="sr" type="file" accept="'+TYPES.join(',')+'" multiple></label>':'');
$('#s-alts').innerHTML=files.map((f,i)=>'<label for="s-alt'+i+'" class="meta">第 '+(i+1)+' 張的替代文字（給看不到圖的人）</label><input id="s-alt'+i+'" data-alt="'+i+'" maxlength="2000" value="'+esc(alts[i])+'">').join('')}
function addImgs(list){let over=0;for(const f of Array.from(list||[])){if(!TYPES.includes(f.type)){toast(f.name+' 不是 JPEG／PNG／WebP／GIF',true);continue}if(files.length>=4){over++;continue}files.push(f);alts.push('');urls.push(URL.createObjectURL(f))}
if(over)toast('最多 4 張圖片，多的沒有加入',true);renderImgs()}
function removeImg(i){URL.revokeObjectURL(urls[i]);files.splice(i,1);alts.splice(i,1);urls.splice(i,1);renderImgs()}
function localInput(t){const d=new Date(Math.ceil(t/3600000)*3600000);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())}
function setWhen(mode){whenMode=mode;for(const b of document.querySelectorAll('[data-when]'))b.setAttribute('aria-pressed',String(b.dataset.when===mode));
const due=$('#s-due');due.hidden=mode!=='later';if(mode==='later'){if(!due.value)due.value=localInput(Date.now()+1800000);due.focus()}$('#s-submit').textContent=mode==='later'?'建立排程':'立即發布'}
function resetForm(){text.value='';for(const u of urls)URL.revokeObjectURL(u);files.length=0;alts.length=0;urls.length=0;renderImgs();$('#s-due').value='';setWhen('now');lengthHint()}
function base64(file){return new Promise((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]||'');r.onerror=()=>fail(new Error('讀不到 '+file.name));r.readAsDataURL(file)})}
text.addEventListener('input',lengthHint);
text.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter')$('#schedule').requestSubmit()});
text.addEventListener('paste',e=>{const list=e.clipboardData&&e.clipboardData.files;if(list&&list.length){e.preventDefault();addImgs(list)}});
$('#schedule').addEventListener('submit',async e=>{e.preventDefault();const b=$('#s-submit');const body=text.value.trim();const destinations=dests();let dueAt;
if(whenMode==='later'){const v=$('#s-due').value;if(!v){toast('請選發布時間',true);return}const t=new Date(v).getTime();if(!(t>Date.now())){toast('這個時間已經過了；要馬上發請選「現在」',true);return}dueAt=new Date(t).toISOString()}
if(!body&&!files.length){toast('請輸入內容或加圖片',true);text.focus();return}if(!destinations.length){toast('請至少選一個平台',true);return}
b.disabled=true;try{const images=[];for(const [i,f] of files.entries())images.push({data:await base64(f),alt:(alts[i]||'').trim()});
await post('/api/schedule',{text:body,dueAt,destinations,images});
toast(dueAt?'已排程：'+fmtDue(dueAt):'已開始發布');resetForm();document.body.classList.remove('composing');load()}
catch(err){toast('排程失敗：'+err.message,true)}finally{b.disabled=false}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});
renderImgs();scanBtn();load();
</script></body></html>`;
