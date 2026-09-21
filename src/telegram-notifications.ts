import type { AppConfig } from './config.js';
import { Engine, safeError } from './engine.js';
import { Store } from './store.js';
import { TelegramClient, type TelegramCallbackQuery, type TelegramUpdateMessage } from './platforms/telegram.js';
import type { Reminder } from './types.js';

export interface ReminderContext { config: AppConfig; telegram: TelegramClient; store: Store; engine: Engine }

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
  const { config, telegram, store } = context;
  if (!query.message || !ownerMessage({ ...query.message, from: query.from }, config)) {
    await telegram.answerCallbackQuery(query.id, '僅限擁有者操作'); return;
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
    if (store.setting<string>('telegram:error_retry_at', '') > now) return;
    const audience = config.telegram.opsChatId ? 'ops' : 'private';
    if (audience === 'private' && !config.telegram.privateChatId) return;
    const errors = store.errorEventsAfter(store.setting<number>('telegram:error_offset', 0), 5);
    if (!errors.length) return;
    const secrets = [config.telegram.token, config.bluesky.appPassword, config.sharkey.token, config.webToken].filter(Boolean);
    const redact = (text: string): string => {
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return safeError(new Error(text));
    };
    try {
      await telegram.sendPlain(`⚠️ Crosspost Bridge 錯誤（${errors.length}）\n\n${errors.map(error => `${error.at}\n${redact(error.message)}${error.entityId ? `\n任務：${redact(error.entityId)}` : ''}`).join('\n\n')}`, audience);
      store.setSetting('telegram:error_offset', errors.at(-1)!.id);
      store.setSetting('telegram:error_retry_at', '');
    } catch (error) {
      const seconds = Math.max(60, Number((error as { retryAfter?: number }).retryAfter) || 0);
      store.setSetting('telegram:error_retry_at', new Date(Date.now() + seconds * 1000).toISOString());
    }
  }
}
