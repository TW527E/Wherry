import type { AppConfig } from './config.js';
import { Engine, Worker, safeError } from './engine.js';
import { Store } from './store.js';
import { PLATFORM_NAMES, readableEvent } from './labels.js';
import { similarity } from './text.js';
import { TelegramClient, type TelegramCallbackQuery, type TelegramUpdateMessage } from './platforms/telegram.js';
import type { InlineButton, Job, Reminder, ReviewNotice } from './types.js';

export interface ReminderContext { config: AppConfig; telegram: TelegramClient; store: Store; engine: Engine; worker: Worker }

export function deletionButtons(job: Job): InlineButton[] {
  return [{ text: '重試', data: `del:r:${job.id}` }, { text: '取消', data: `del:c:${job.id}` }, { text: '我已手動刪除', data: `del:d:${job.id}` }];
}

export function deletionNotice(job: Job, engine: Engine): string {
  const links = engine.telegramDeletionLinks(job);
  return `Telegram 副本刪除失敗\n${job.aggregateId}\n${job.error ?? ''}\n\n${links.length ? links.join('\n') : '此聊天不支援訊息連結，請到 Telegram 聊天中查看。'}\n\n請手動刪除以上所有訊息後，再按「我已手動刪除」。取消只會停止重試，會保留 Telegram 訊息。`;
}

/** When to retry a failed Telegram call: the server's retry_after, but never sooner than a minute. */
const retryAt = (error: unknown): string =>
  new Date(Date.now() + Math.max(60, Number((error as { retryAfter?: number }).retryAfter) || 0) * 1000).toISOString();

// A handful of buttons fits a phone screen; any further candidate stays reachable by replying with its code.
const MAX_CHOICE_BUTTONS = 5;
const excerpt = (text: string, length: number): string => {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > length ? `${chars.slice(0, length).join('')}…` : chars.join('') || '（無文字）';
};
const ago = (iso: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return !(minutes >= 1) ? '剛剛' : minutes < 60 ? `${minutes} 分鐘前` : minutes < 1440 ? `${Math.round(minutes / 60)} 小時前` : `${Math.round(minutes / 1440)} 天前`;
};

/**
 * The downstream posts a held X batch may mirror, closest in wording first (newest breaks ties), as
 * offered on its notice. Saved with the notice so a tapped button resolves to the candidate it showed,
 * even if the list changes afterwards.
 */
function reviewChoices(notice: ReviewNotice, engine: Engine, store: Store): ReturnType<Engine['mirrorCandidates']> {
  const text = store.batchPosts(notice.batchId).map(p => p.post.text).join('\n');
  const score = new Map(engine.mirrorCandidates().map(candidate => [candidate, similarity(candidate.text, text)]));
  const candidates = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || b.createdAt.localeCompare(a.createdAt));
  store.setSetting(`review_choices:${notice.batchId}`, candidates.slice(0, MAX_CHOICE_BUTTONS).map(candidate => candidate.id));
  return candidates;
}

const candidateLabel = (candidate: ReturnType<Engine['mirrorCandidates']>[number], length: number): string =>
  `${PLATFORM_NAMES[candidate.platform] ?? candidate.platform} · ${ago(candidate.createdAt)}「${excerpt(candidate.text, length)}」`;

function reviewChoiceButtons(candidates: ReturnType<Engine['mirrorCandidates']>): InlineButton[] {
  return [
    ...candidates.slice(0, MAX_CHOICE_BUTTONS).map((candidate, index) => ({ text: candidateLabel(candidate, 18), data: `rev:c:${index}` })),
    { text: '都不是，只標記為手動鏡像', data: 'rev:c:x' },
    { text: '↩ 返回', data: 'rev:c:back' },
  ];
}

/** The owner-facing body a settled review notice is edited down to; empty while still `offered`. */
function reviewNoticeStatusText(notice: ReviewNotice, engine: Engine, candidates = engine.mirrorCandidates()): string {
  switch (notice.state) {
    case 'awaiting_link': return ['🪞 是哪一則？點下方你手動搬到 X 的那則下游貼文，之後在 X 刪除時會一起處理。',
      '同時對應多則時，也可以「回覆這則通知」貼上多個鏡像代碼。系統不會反向同步這則 X 內容。', '',
      ...candidates.map(candidate => `• ${candidateLabel(candidate, 40)}\n   ${candidate.id}`)].join('\n');
    case 'approved': return '✅ 已批准：正在把這則 X 內容同步到其他平台，狀態請看 /status。';
    case 'skipped': return '🚫 已略過：不會同步這則 X 內容。';
    case 'mirrored': return '🪞 已登記為手動鏡像：不會反向同步這則 X 內容。';
    default: return '';
  }
}

export function extractXStatus(text: string, ownerHandle: string): { url: string; id: string } | undefined {
  const candidates = text.match(/https?:\/\/[^\s<>"'，。]+/giu) ?? [];
  const found: Array<{ url: string; id: string }> = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[).,!?;]+$/u, ''));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
        || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) continue;
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,24})(?:\/(?:photo|video)\/[1-4])?\/?$/);
      if (!match || !ownerHandle || match[1]!.toLowerCase() !== ownerHandle.toLowerCase()) continue;
      found.push({ url: `https://x.com/${ownerHandle}/status/${match[2]}`, id: match[2]! });
    } catch { /* A malformed URL is not a registration. */ }
  }
  return candidates.length === 1 && found.length === 1 ? found[0] : undefined;
}

function reminderText(reminder: Reminder, store: Store): string {
  const source = store.postByKey(reminder.aggregateId)?.post;
  const label = source ? `${source.platform}：${Array.from(source.text).slice(0, 100).join('')}` : reminder.aggregateId;
  const state = reminder.state === 'awaiting_link'
    ? '✅ 你選擇了「要發」。\n請手動發到 X，再「回覆這則訊息」貼上你自己的完整 X 推文連結。系統不會代你發文。'
    : reminder.state === 'declined'
      ? '🚫 你選擇了「不發」。已結束這則 X 提醒，不會代你發文，也不會再提醒。既有平台貼文不受影響。'
      : `🔗 已登記：${reminder.xUrl}\n將阻止後續反向同步；若登記前已開始發布，請依錯誤通知檢查遠端貼文。`;
  return `${state}\n\n${label}`;
}

function ownerMessage(message: { chat: { id: string | number; type: string }; from?: { id: number } }, config: AppConfig): boolean {
  return message.chat.type === 'private' && String(message.chat.id) === config.telegram.privateChatId
    && String(message.from?.id ?? '') === config.telegram.ownerId;
}

export async function handleCallback(query: TelegramCallbackQuery, context: ReminderContext): Promise<void> {
  const { config, telegram, store, engine, worker } = context;
  if (!query.message || !ownerMessage({ ...query.message, from: query.from }, config)) {
    await telegram.answerCallbackQuery(query.id, '僅限擁有者操作'); return;
  }
  const data = query.data ?? '';
  if (data.startsWith('del:')) {
    const match = data.match(/^del:([rcd]):([A-Za-z0-9_-]{1,48})$/);
    const job = match && store.getJob(match[2]!);
    if (!job || job.kind !== 'retract' || job.destination !== 'telegram' || !['failed', 'review', 'unknown'].includes(job.state)) {
      await telegram.answerCallbackQuery(query.id, '這個刪除工作已處理或無法使用'); return;
    }
    try {
      const action = match![1] === 'r' ? 'retry' : match![1] === 'c' ? 'cancel' : 'deleted';
      engine.action(action, job.id);
      if (action === 'retry') void worker.run().catch(() => undefined);
      const status = action === 'deleted' ? '已記錄手動刪除，工作已完成' : action === 'cancel' ? '已取消重試，Telegram 訊息仍會保留' : '已排入重試，結果請看 /pending 或 /status';
      await telegram.answerCallbackQuery(query.id, status);
      await telegram.editMessageText(String(query.message.chat.id), query.message.message_id, `${status}\n${job.aggregateId}`)
        .catch(error => store.event('warn', `Telegram deletion notice update failed: ${safeError(error)}`, job.id));
    } catch (error) { await telegram.answerCallbackQuery(query.id, `操作失敗：${safeError(error)}`.slice(0, 190)); }
    return;
  }
  const choice = data.match(/^rev:c:(\d+|x|back)$/);
  if (choice) {
    const notice = store.getReviewNotice(query.message.message_id, String(query.message.chat.id));
    if (!notice || notice.state !== 'awaiting_link') { await telegram.answerCallbackQuery(query.id, '這則通知已處理過了'); return; }
    try {
      if (choice[1] === 'back') {
        // Undo the mis-tap: the notice goes back to its three original choices.
        const batch = store.getBatch(notice.batchId);
        if (!batch) throw new Error('Review batch not found');
        store.setReviewNoticeState(notice.batchId, 'offered');
        await telegram.answerCallbackQuery(query.id, '已返回');
        await telegram.editMessageText(notice.chatId, notice.messageId, engine.reviewNoticeText(batch), engine.reviewNoticeButtons(batch.id))
          .catch(error => store.event('warn', `Telegram review notice update failed: ${safeError(error)}`, batch.id));
        return;
      }
      if (choice[1] === 'x') engine.action('mirror', notice.batchId);
      else {
        const code = store.setting<string[]>(`review_choices:${notice.batchId}`, [])[Number(choice[1])];
        if (!code || !engine.confirmReviewMirror(notice.batchId, code).matched) {
          await telegram.answerCallbackQuery(query.id, '這則候選已失效，請回覆鏡像代碼或選「都不是」'); return;
        }
      }
      store.setReviewNoticeState(notice.batchId, 'mirrored');
      await telegram.answerCallbackQuery(query.id, '已登記為手動鏡像，不會同步');
    } catch (error) { await telegram.answerCallbackQuery(query.id, `操作失敗：${safeError(error)}`.slice(0, 190)); }
    return;
  }
  if (data.startsWith('rev:')) {
    const notice = store.getReviewNotice(query.message.message_id, String(query.message.chat.id));
    // Old messages included the batch ID; the stored message mapping remains authoritative.
    const action = ['rev:a', 'rev:s', 'rev:m'].find(value => data === value || data === `${value}:${notice?.batchId}`);
    if (!notice || !action) { await telegram.answerCallbackQuery(query.id, '這則通知無法使用'); return; }
    if (notice.state !== 'offered') { await telegram.answerCallbackQuery(query.id, '這則通知已處理，請依訊息操作'); return; }
    try {
      if (action === 'rev:a') {
        engine.action('approve', notice.batchId);
        store.setReviewNoticeState(notice.batchId, 'approved');
        void worker.run().catch(() => undefined);
        await telegram.answerCallbackQuery(query.id, '已批准，正在同步到其他平台');
      } else if (action === 'rev:s') {
        engine.action('skip', notice.batchId);
        store.setReviewNoticeState(notice.batchId, 'skipped');
        await telegram.answerCallbackQuery(query.id, '已略過，不會同步');
      } else if (engine.mirrorCandidates().length) {
        // Codes to confirm against: park the notice and wait for the owner's reply carrying them.
        store.setReviewNoticeState(notice.batchId, 'awaiting_link');
        await telegram.answerCallbackQuery(query.id, '請點選是哪一則下游貼文');
      } else {
        // No downstream candidate to link, so there is no code to wait for: close it as a mirror now.
        engine.action('mirror', notice.batchId);
        store.setReviewNoticeState(notice.batchId, 'mirrored');
        await telegram.answerCallbackQuery(query.id, '已標記為手動鏡像，不會同步');
      }
    } catch (error) {
      await telegram.answerCallbackQuery(query.id, `操作失敗：${safeError(error)}`.slice(0, 190));
    }
    return;
  }
  const reminder = store.getReminder(query.message.message_id, String(query.message.chat.id));
  if (!reminder || !['rem:y', 'rem:n'].includes(query.data ?? '')) {
    await telegram.answerCallbackQuery(query.id, '這則提醒無法使用'); return;
  }
  if (reminder.state === 'offered') {
    store.setReminderState(reminder.messageId, reminder.chatId, query.data === 'rem:y' ? 'awaiting_link' : 'declined');
  }
  await telegram.answerCallbackQuery(query.id, reminder.state === 'offered'
    ? query.data === 'rem:y' ? '請回覆這則提醒，貼上 X 連結' : '已選擇不發'
    : '已記錄選擇，請依訊息上的說明操作');
}

export async function handleReminderReply(message: TelegramUpdateMessage, context: ReminderContext): Promise<boolean> {
  const { config, telegram, store, engine } = context;
  if (!ownerMessage(message, config) || !message.reply_to_message || message.document || message.text?.trim().startsWith('/')) return false;
  const reminder = store.getReminder(message.reply_to_message.message_id, String(message.chat.id));
  if (!reminder) return false;
  if (reminder.state !== 'awaiting_link') {
    await telegram.sendPlain(reminder.state === 'offered' ? '請先在原提醒按「要發」，再回覆 X 連結。' : '這則提醒已完成，沒有變更登記。', 'private');
    return true;
  }
  const found = extractXStatus(message.text ?? '', config.x.handle);
  if (!found) {
    await telegram.sendPlain(`請回覆「原提醒訊息」，附上一個你自己的完整連結：https://x.com/${config.x.handle || '你的帳號'}/status/數字\n不接受他人貼文、短網址或多個連結。`, 'private');
    return true;
  }
  const { alreadyDelivered } = engine.registerManualMirror(reminder.aggregateId, found.id);
  store.setReminderState(reminder.messageId, reminder.chatId, 'linked', found.url);
  if (alreadyDelivered) await telegram.sendPlain('⚠️ 連結已登記，但這則 X 貼文已有發布中、已發布或結果不明的工作。已取消尚未發出的工作；請檢查遠端貼文，系統不會自動刪除。', 'private');
  return true;
}

/**
 * The owner tapped 「這是我手動鏡像的」 on a held X batch and is replying with the mirror code(s) plus
 * the downstream link(s). Register the manual mirror so reverse sync is blocked. Returns true once it
 * owns the reply (a review notice matched), so the caller stops before treating it as a command.
 */
export async function handleReviewReply(message: TelegramUpdateMessage, context: ReminderContext): Promise<boolean> {
  const { config, telegram, store, engine } = context;
  if (!ownerMessage(message, config) || !message.reply_to_message || message.document || message.text?.trim().startsWith('/')) return false;
  const notice = store.getReviewNotice(message.reply_to_message.message_id, String(message.chat.id));
  if (!notice) return false;
  if (notice.state !== 'awaiting_link') {
    await telegram.sendPlain(notice.state === 'offered'
      ? '請先在原通知按「這是我手動鏡像的」，再回覆鏡像代碼與連結。'
      : '這則通知已處理，沒有變更登記。', 'private');
    return true;
  }
  let matched: number;
  try { ({ matched } = engine.confirmReviewMirror(notice.batchId, message.text ?? '')); }
  catch (error) { await telegram.sendPlain(`登記失敗：${safeError(error)}`, 'private'); return true; }
  if (!matched) {
    await telegram.sendPlain('沒有讀到有效的鏡像代碼。請「回覆這則通知」，貼上通知裡列出的「mirror:…」代碼（可多個）與該平台的貼文連結。', 'private');
    return true;
  }
  store.setReviewNoticeState(notice.batchId, 'mirrored');
  await telegram.sendPlain(`已登記為手動鏡像（${matched} 筆），將阻止反向同步這則 X 內容。`, 'private');
  return true;
}

export class TelegramNotifications {
  private active?: Promise<void>;
  constructor(private readonly context: ReminderContext) {
    if (context.config.mode === 'live' && context.store.setting<number>('telegram:error_offset', -1) < 0) {
      context.store.setSetting('telegram:error_offset', context.store.maxEventId());
    }
  }
  flush(): Promise<void> {
    if (this.context.config.mode !== 'live') return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.deliver().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async deliver(): Promise<void> {
    const { config, store, telegram } = this.context;
    const now = new Date().toISOString();
    for (const reminder of store.remindersNeedingEdit(now)) {
      if (reminder.chatId !== config.telegram.privateChatId) continue;
      try {
        await telegram.editMessageText(reminder.chatId, reminder.messageId, reminderText(reminder, store));
        store.reminderEdited(reminder);
      } catch (error) {
        store.deferReminderEdit(reminder, retryAt(error));
        store.event('error', `Telegram reminder update failed; saved choice will be retried: ${safeError(error)}`, reminder.aggregateId);
        break;
      }
    }
    for (const notice of store.reviewNoticesNeedingEdit(now)) {
      if (notice.chatId !== config.telegram.privateChatId) continue;
      const candidates = notice.state === 'awaiting_link' ? reviewChoices(notice, this.context.engine, store) : undefined;
      const text = reviewNoticeStatusText(notice, this.context.engine, candidates);
      if (!text) continue;
      try {
        await telegram.editMessageText(notice.chatId, notice.messageId, text, candidates ? reviewChoiceButtons(candidates) : []);
        store.reviewNoticeSynced(notice);
      } catch (error) {
        store.deferReviewNoticeEdit(notice, retryAt(error));
        store.event('error', `Telegram review notice update failed; will retry: ${safeError(error)}`, notice.batchId);
        break;
      }
    }
    if (store.setting<string>('telegram:error_retry_at', '') > now) return;
    if (!config.telegram.privateChatId) return;
    const errors = store.errorEventsAfter(store.setting<number>('telegram:error_offset', 0), 5);
    if (!errors.length) return;
    const secrets = [config.telegram.token, config.bluesky.appPassword, config.sharkey.token, config.argon.appPassword, config.webToken].filter(Boolean);
    const redact = (text: string): string => {
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return safeError(new Error(text));
    };
    try {
      const ordinary = [];
      for (const error of errors) {
        const job = error.entityId ? store.getJob(error.entityId) : undefined;
        if (job?.kind === 'retract' && job.destination === 'telegram' && ['failed', 'review', 'unknown'].includes(job.state)) {
          // Links come from saved message receipts, after error redaction has removed arbitrary URLs.
          await telegram.sendPlain(deletionNotice({ ...job, error: redact(job.error ?? '') }, this.context.engine), 'private', deletionButtons(job));
        } else ordinary.push(error);
      }
      if (ordinary.length) await telegram.sendPlain(`⚠️ Wherry 錯誤（${ordinary.length}）\n\n${ordinary.map(error => `${error.at}\n${redact(readableEvent(error.message) ?? error.message)}${error.entityId ? `\n任務：${redact(error.entityId)}` : ''}`).join('\n\n')}`, 'private');
      store.setSetting('telegram:error_offset', errors.at(-1)!.id);
      store.setSetting('telegram:error_retry_at', '');
    } catch (error) {
      store.setSetting('telegram:error_retry_at', retryAt(error));
    }
  }
}
