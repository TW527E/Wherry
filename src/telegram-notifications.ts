import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import { Engine, Worker, safeError } from './engine.js';
import { Store } from './store.js';
import { TelegramClient, type TelegramCallbackQuery, type TelegramUpdateMessage } from './platforms/telegram.js';
import type { Reminder, ReviewNotice } from './types.js';

export interface ReminderContext { config: AppConfig; telegram: TelegramClient; store: Store; engine: Engine; worker: Worker }

/** The owner-facing body a settled review notice is edited down to; empty while still `offered`. */
function reviewNoticeStatusText(notice: ReviewNotice): string {
  switch (notice.state) {
    case 'awaiting_link': return '🪞 你選擇了「這是我手動鏡像的」。\n請「回覆這則通知」，貼上通知裡列出的鏡像代碼（可多個）與該平台的貼文連結。系統不會反向同步這則 X 內容。';
    case 'approved': return '✅ 已批准：正在把這則 X 內容同步到其他平台，狀態請看 /status。';
    case 'skipped': return '🚫 已略過：不會同步這則 X 內容。';
    case 'mirrored': return '🪞 已登記為手動鏡像：不會反向同步這則 X 內容。';
    default: return '';
  }
}
const noticeSig = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

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

export function reminderText(reminder: Reminder, store: Store): string {
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
  if (data.startsWith('rev:')) {
    const notice = store.getReviewNotice(query.message.message_id, String(query.message.chat.id));
    if (!notice || !['rev:a', 'rev:s', 'rev:m'].includes(data)) { await telegram.answerCallbackQuery(query.id, '這則通知無法使用'); return; }
    if (notice.state !== 'offered') { await telegram.answerCallbackQuery(query.id, '這則通知已處理，請依訊息操作'); return; }
    try {
      if (data === 'rev:a') {
        engine.action('approve', notice.batchId);
        store.setReviewNoticeState(notice.batchId, 'approved');
        void worker.run().catch(() => undefined);
        await telegram.answerCallbackQuery(query.id, '已批准，正在同步到其他平台');
      } else if (data === 'rev:s') {
        engine.action('skip', notice.batchId);
        store.setReviewNoticeState(notice.batchId, 'skipped');
        await telegram.answerCallbackQuery(query.id, '已略過，不會同步');
      } else if (engine.mirrorCandidates().length) {
        // Codes to confirm against: park the notice and wait for the owner's reply carrying them.
        store.setReviewNoticeState(notice.batchId, 'awaiting_link');
        await telegram.answerCallbackQuery(query.id, '請回覆這則通知，貼上鏡像代碼與連結');
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
        const seconds = Math.max(60, Number((error as { retryAfter?: number }).retryAfter) || 0);
        store.deferReminderEdit(reminder, new Date(Date.now() + seconds * 1000).toISOString());
        store.event('error', `Telegram reminder update failed; saved choice will be retried: ${safeError(error)}`, reminder.aggregateId);
        break;
      }
    }
    // Edit each settled review notice down to its outcome (approved / skipped / mirrored / awaiting a
    // reply). Same edit-when-changed, back-off-on-429 discipline as reminders: only touch Telegram when
    // the freshly rendered body differs from what was last written, and defer on a rate-limit.
    for (const notice of store.reviewNoticesNeedingEdit(now)) {
      if (notice.chatId !== config.telegram.privateChatId) continue;
      const text = reviewNoticeStatusText(notice);
      const sig = noticeSig(text);
      if (!text || sig === notice.syncedSig) continue;
      try {
        await telegram.editMessageText(notice.chatId, notice.messageId, text);
        store.reviewNoticeSynced(notice.batchId, sig);
      } catch (error) {
        const seconds = Math.max(60, Number((error as { retryAfter?: number }).retryAfter) || 0);
        store.deferReviewNoticeEdit(notice.batchId, new Date(Date.now() + seconds * 1000).toISOString());
        store.event('error', `Telegram review notice update failed; will retry: ${safeError(error)}`, notice.batchId);
        break;
      }
    }
    if (store.setting<string>('telegram:error_retry_at', '') > now) return;
    // Error/failure notices always go to the owner's private chat with the bot, never the ops group.
    const audience = 'private';
    if (!config.telegram.privateChatId) return;
    const errors = store.errorEventsAfter(store.setting<number>('telegram:error_offset', 0), 5);
    if (!errors.length) return;
    const secrets = [config.telegram.token, config.bluesky.appPassword, config.sharkey.token, config.webToken].filter(Boolean);
    const redact = (text: string): string => {
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return safeError(new Error(text));
    };
    try {
      await telegram.sendPlain(`⚠️ Wherry 錯誤（${errors.length}）\n\n${errors.map(error => `${error.at}\n${redact(error.message)}${error.entityId ? `\n任務：${redact(error.entityId)}` : ''}`).join('\n\n')}`, audience);
      store.setSetting('telegram:error_offset', errors.at(-1)!.id);
      store.setSetting('telegram:error_retry_at', '');
    } catch (error) {
      const seconds = Math.max(60, Number((error as { retryAfter?: number }).retryAfter) || 0);
      store.setSetting('telegram:error_retry_at', new Date(Date.now() + seconds * 1000).toISOString());
    }
  }
}
