import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import { isSensitiveContent, warningPrefix } from '../content-warning.js';
import { nativePollPayload } from '../poll.js';
import type { PreparedMedia, PublishContext, PublishPart, Publisher, RemoteRef, Transport } from '../types.js';
import { fixupUrl, htmlEscape, splitText } from '../text.js';
import { PlatformError, multipart, nonempty, object, positiveInteger, requestJson, schemaError, type MultipartFile } from './parse.js';

export type TelegramAudience = 'private' | 'ops' | 'public';
interface TelegramResponse<T> { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
interface TelegramMessage { message_id: number; chat: { id: number | string }; media_group_id?: string }
const MAX_TEXT = 4096; const MAX_CAPTION = 1024;
/** A slash command followed by ID-like arguments, e.g. "/retry 9549-…" or "/approve batch-1". */
const COPYABLE_COMMAND = /(?<=^|[\s（(])\/[a-z]+(?: [\w:.-]+)+/gm;

export class TelegramClient implements Publisher {
  readonly destination = 'telegram' as const;
  constructor(private readonly config: AppConfig['telegram'], private readonly transport: Transport, private readonly now: () => Date = () => new Date()) {}
  private chat(audience: TelegramAudience): string {
    const value = audience === 'private' ? this.config.privateChatId : audience === 'ops' ? this.config.opsChatId : this.config.publicChatId;
    if (!value) throw new Error(`Telegram ${audience} chat is not configured`); return value;
  }
  private endpoint(method: string): string { return `https://api.telegram.org/bot${this.config.token}/${method}`; }
  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const response = await requestJson(this.transport, this.endpoint(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), maxBytes: 2_000_000, timeoutMs }, `Telegram ${method}`, true) as TelegramResponse<T>;
    if (response.ok !== true || response.result === undefined) throw schemaError(`Telegram ${method}`, true);
    return response.result;
  }
  /** sendVideo / sendPhoto / sendMediaGroup: one multipart request, one or more sent messages back. */
  private async upload(method: string, fields: Record<string, string>, files: MultipartFile[]): Promise<TelegramMessage[]> {
    const form = multipart(fields, files);
    // An album carries every file in this one request, so give it 30 s for Telegram to answer plus
    // transfer time at 0.5 MB/s, rather than a flat 30 s a few videos could outrun mid-upload — a timeout
    // here is an uncertain delivery the owner has to reconcile by hand.
    const response = await requestJson(this.transport, this.endpoint(method), { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body, maxBytes: 2_000_000,
      timeoutMs: 30_000 + Math.ceil(form.body.length / 500) }, `Telegram ${method}`, true) as TelegramResponse<TelegramMessage | TelegramMessage[]>;
    const messages = [response.result ?? []].flat();
    if (!response.ok || !messages.length) throw schemaError(`Telegram ${method}`, true);
    return messages;
  }
  private footer(url: string): string { return `\n\n<a href="${htmlEscape(url)}">原文連結</a>`; }
  async publish(part: PublishPart, context: PublishContext): Promise<RemoteRef> {
    const audience = context.audience ?? 'public'; const chatId = this.chat(audience);
    // Telegram has no quote, so a quoted post replies to its earlier copy; a deleted copy just drops the reply.
    const reply = context.parent?.messageIds?.[0] ? { message_id: context.parent.messageIds[0], allow_sending_without_reply: false }
      : part.quote?.messageIds?.[0] && part.quote.chatId === chatId ? { message_id: part.quote.messageIds[0], allow_sending_without_reply: true } : undefined;
    if (part.cw !== undefined && typeof part.cw !== 'string') throw new PlatformError('Telegram CW must be text', { code: 'InvalidCW' });
    const sensitive = isSensitiveContent(part);
    if (part.poll) {
      if (sensitive) throw new PlatformError('Telegram native polls cannot hide their questions/options with a spoiler', { code: 'SensitivePollUnsupported' });
      if (part.media.length || part.buttons?.length) throw new PlatformError('A native poll must be a separate durable Telegram step', { code: 'InvalidPollPart' });
      const poll = nativePollPayload(part.poll, 'telegram', this.now().getTime());
      if (typeof part.text !== 'string' || !part.text.trim() || Array.from(part.text).length > 300) throw new PlatformError('Telegram poll questions must be 1–300 characters', { code: 'InvalidPollQuestion' });
      const sourceUrl = part.sourceUrl && fixupUrl(part.sourceUrl)?.replace('https://fixupx.com/', 'https://x.com/');
      if (!sourceUrl) throw new PlatformError('A native X poll requires a valid source link', { code: 'InvalidPollSource' });
      const result = await this.call<TelegramMessage>('sendPoll', {
        chat_id: chatId, question: part.text, options: poll.choices.map(text => ({ text })),
        is_anonymous: true, type: 'regular', allows_multiple_answers: false,
        close_date: Math.floor(poll.expiresAt / 1000), ...(reply ? { reply_parameters: reply } : {}),
        reply_markup: { inline_keyboard: [[{ text: 'X 原投票（票數獨立）', url: sourceUrl }]] },
      });
      const returned = object(result);
      const createdPoll = object(returned?.poll);
      if (!positiveInteger(returned?.message_id) || !createdPoll || !nonempty(createdPoll.id)
        || createdPoll.question !== part.text || createdPoll.type !== 'regular'
        || createdPoll.is_anonymous !== true || createdPoll.allows_multiple_answers !== false
        || createdPoll.close_date !== Math.floor(poll.expiresAt / 1000)
        || !Array.isArray(createdPoll.options) || createdPoll.options.length !== poll.choices.length
        || createdPoll.options.some((choice, index) => object(choice)?.text !== poll.choices[index])) throw schemaError('Telegram sendPoll', true);
      return { id: String(result.message_id), messageIds: [result.message_id], chatId };
    }
    const link = audience === 'public' && part.sourceUrl ? this.footer(part.sourceUrl) : '';
    const body = htmlEscape(part.text);
    const rendered = `${htmlEscape(warningPrefix(part))}${sensitive && body ? `<tg-spoiler>${body}</tg-spoiler>` : body}${link}`;
    if (part.media.length > 4) throw new Error('Telegram publisher accepts at most four images or videos per durable step');
    const withMedia = part.media.length > 0;
    if (rendered.length > (withMedia ? MAX_CAPTION : MAX_TEXT)) throw new Error(`Telegram ${withMedia ? 'caption' : 'message'} requires core text splitter before publish`);
    const replyField: Record<string, string> = reply ? { reply_parameters: JSON.stringify(reply) } : {};
    const spoiler: Record<string, string> = sensitive ? { has_spoiler: 'true' } : {};
    const kind = (item: PreparedMedia): 'video' | 'photo' => item.mimeType === 'video/mp4' ? 'video' : 'photo';
    const file = async (item: PreparedMedia, field: string, filename: string): Promise<MultipartFile> => item.mimeType === 'video/mp4'
      ? { field, filename: `${filename}.mp4`, mimeType: item.mimeType, bytes: await readFile(item.path) }
      : { field, filename: `${filename}.${item.mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType: item.mimeType, bytes: item.bytes };
    let sent: TelegramMessage[];
    if (part.media.length === 1) {
      const item = part.media[0]!;
      // A lone X GIF goes out as an animation, which Telegram loops silently like the original.
      const [method, field] = item.mimeType !== 'video/mp4' ? ['sendPhoto', 'photo'] : item.animated ? ['sendAnimation', 'animation'] : ['sendVideo', 'video'];
      sent = await this.upload(method, { chat_id: chatId, caption: rendered, parse_mode: 'HTML',
        ...(method === 'sendVideo' ? { supports_streaming: 'true' } : {}), ...spoiler, ...replyField }, [await file(item, field, 'crosspost')]);
    } else if (part.media.length > 1) {
      // Several photos and videos from one tweet post as a single album (Telegram mixes the two in one
      // media group, but takes no animations there, so a GIF rides along as a video), caption (with the
      // link) on the first item — the whole group is one durable step so a retry replays the same album.
      const media = part.media.map((item, index) => ({
        type: kind(item), media: `attach://${kind(item)}${index}`,
        ...(kind(item) === 'video' ? { supports_streaming: true } : {}),
        ...(sensitive ? { has_spoiler: true } : {}),
        ...(index === 0 ? { caption: rendered, parse_mode: 'HTML' } : {}),
      }));
      const files: MultipartFile[] = [];
      for (const [index, item] of part.media.entries()) files.push(await file(item, `${kind(item)}${index}`, `crosspost-${index}`));
      sent = await this.upload('sendMediaGroup', { chat_id: chatId, media: JSON.stringify(media), ...replyField }, files);
    } else {
      const markup = part.buttons?.length ? { reply_markup: { inline_keyboard: [part.buttons.map(b => ({ text: b.text, callback_data: b.data }))] } } : {};
      sent = [await this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text: rendered, parse_mode: 'HTML',
        ...(sensitive ? { link_preview_options: { is_disabled: true } } : {}), ...(reply ? { reply_parameters: reply } : {}), ...markup })];
    }
    const ids = sent.map(message => message.message_id);
    return { id: String(ids[0]), messageIds: ids, chatId };
  }
  async sendPlain(text: string, audience: TelegramAudience = 'ops'): Promise<RemoteRef> {
    const chatId = this.chat(audience); const messageIds: number[] = [];
    for (const chunk of splitText(text, { utf16: MAX_TEXT })) {
      // "/retry <id>" as a bot-command link would send only "/retry"; a code entity makes one tap copy the whole command.
      const entities = Array.from(chunk.matchAll(COPYABLE_COMMAND), match => ({ type: 'code', offset: match.index, length: match[0].length }));
      const result = await this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true }, ...(entities.length ? { entities } : {}) });
      messageIds.push(result.message_id);
    }
    return { id: String(messageIds[0]), messageIds, chatId };
  }
  async editMessageText(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      if (!(error instanceof PlatformError && error.status === 400 && /message is not modified/i.test(error.message))) throw error;
    }
  }
  /** Acknowledge a button tap so Telegram stops the client-side spinner; text is an optional toast. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(() => undefined);
  }
  async getUpdates(offset?: number): Promise<Array<{ update_id: number; message?: TelegramUpdateMessage; callback_query?: TelegramCallbackQuery }>> {
    // Long-poll: Telegram holds the connection open up to `timeout` seconds until an update
    // arrives, so a command is delivered near-instantly instead of waiting for the next poll tick.
    // The HTTP timeout MUST exceed the long-poll window, or the transport would abort a healthy
    // idle poll as a timeout; +10s leaves headroom for Telegram's slack and the round-trip.
    const LONG_POLL = 25;
    const updates: unknown = await this.call('getUpdates', { timeout: LONG_POLL, limit: 100, allowed_updates: ['message', 'callback_query'],
      ...(offset === undefined ? {} : { offset }) }, (LONG_POLL + 10) * 1000);
    if (!Array.isArray(updates)) throw schemaError('Telegram getUpdates', true);
    return updates;
  }
  /** Register the command list so Telegram shows the "/" menu and autocomplete in the chat. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }
  /** Delete a message (e.g. an uploaded session file) so the account secret does not linger in chat. */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }
  /**
   * Download a document a user sent to the bot. Two calls: getFile resolves the storage path,
   * then a plain GET fetches the bytes from the file endpoint. Capped so a stray large upload
   * cannot exhaust memory. The bot token is in the URL, so this stays on the SafeHttp transport.
   */
  async downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
    const meta = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!meta.file_path) throw new Error('Telegram getFile returned no file_path');
    if (typeof meta.file_size === 'number' && meta.file_size > maxBytes) throw new Error(`File is ${meta.file_size} bytes, over the ${maxBytes} limit`);
    const url = `https://api.telegram.org/file/bot${this.config.token}/${meta.file_path}`;
    const response = await this.transport.request(url, { method: 'GET', maxBytes });
    if (response.status < 200 || response.status >= 300) throw new Error(`Telegram file download returned HTTP ${response.status}`);
    return response.body;
  }
}

export interface TelegramDocument { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
export interface TelegramUpdateMessage {
  message_id: number;
  chat: { id: number | string; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  reply_to_message?: { message_id: number };
}
export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number | string; type: string } };
}

