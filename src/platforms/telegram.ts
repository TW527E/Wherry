import type { AppConfig } from '../config.js';
import type { PublishContext, PublishPart, Publisher, RemoteRef, Transport } from '../types.js';
import { htmlEscape } from '../text.js';

export type TelegramAudience = 'private' | 'ops' | 'public';
interface TelegramResponse<T> { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
interface TelegramMessage { message_id: number; chat: { id: number | string }; media_group_id?: string }
const MAX_TEXT = 4096; const MAX_CAPTION = 1024;

function multipart(fields: Record<string, string>, file?: { name: string; type: string; bytes: Uint8Array; field: string }): { body: Uint8Array; contentType: string } {
  const boundary = `----crosspost-${crypto.randomUUID()}`; const encoder = new TextEncoder(); const chunks: Uint8Array[] = [];
  for (const [key, value] of Object.entries(fields)) chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  if (file) { chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`)); chunks.push(file.bytes); chunks.push(encoder.encode('\r\n')); }
  chunks.push(encoder.encode(`--${boundary}--\r\n`)); const length = chunks.reduce((n, c) => n + c.length, 0); const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export class TelegramClient implements Publisher {
  readonly destination = 'telegram' as const;
  constructor(private readonly config: AppConfig['telegram'], private readonly transport: Transport) {}
  private chat(audience: TelegramAudience): string {
    const value = audience === 'private' ? this.config.privateChatId : audience === 'ops' ? this.config.opsChatId : this.config.publicChatId;
    if (!value) throw new Error(`Telegram ${audience} chat is not configured`); return value;
  }
  private endpoint(method: string): string { return `https://api.telegram.org/bot${this.config.token}/${method}`; }
  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.transport.json<TelegramResponse<T>>(this.endpoint(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), maxBytes: 2_000_000 });
    if (!response.ok || !response.result) { const error = new Error(response.description || `Telegram ${method} failed`) as Error & { retryAfter?: number; status?: number }; error.retryAfter = response.parameters?.retry_after; throw error; }
    return response.result;
  }
  private footer(url: string): string { return `\n\n<a href="${htmlEscape(url)}">原文連結</a>`; }
  async publish(part: PublishPart, context: PublishContext): Promise<RemoteRef> {
    const audience = context.audience === 'private' ? 'private' : context.audience === 'ops' ? 'ops' : 'public'; const chatId = this.chat(audience);
    const reply = context.parent?.messageIds?.[0] ? { message_id: context.parent.messageIds[0], allow_sending_without_reply: false } : undefined;
    const link = audience === 'public' && part.sourceUrl ? this.footer(part.sourceUrl) : '';
    if (part.images.length > 1) throw new Error('Telegram publisher accepts one image per durable step');
    if (part.images.length === 1) {
      const image = part.images[0]!; const caption = `${htmlEscape(part.text)}${link}`; if (caption.length > MAX_CAPTION) throw new Error('Telegram caption requires core text splitter before publish');
      const form = multipart({ chat_id: chatId, caption, parse_mode: 'HTML', ...(reply ? { reply_parameters: JSON.stringify(reply) } : {}) }, { name: `crosspost.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`, type: image.mimeType, bytes: image.bytes, field: 'photo' });
      const response = await this.transport.json<TelegramResponse<TelegramMessage>>(this.endpoint('sendPhoto'), { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body, maxBytes: 2_000_000 });
      if (!response.ok || !response.result) throw new Error(response.description || 'Telegram sendPhoto failed');
      return { id: String(response.result.message_id), messageIds: [response.result.message_id], chatId };
    }
    const text = `${htmlEscape(part.text)}${link}`; if (text.length > MAX_TEXT) throw new Error('Telegram message requires core text splitter before publish');
    const result = await this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(reply ? { reply_parameters: reply } : {}) });
    return { id: String(result.message_id), messageIds: [result.message_id], chatId };
  }
  async sendPlain(text: string, audience: TelegramAudience = 'ops'): Promise<RemoteRef> {
    const chatId = this.chat(audience); const result = await this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text: htmlEscape(text), parse_mode: 'HTML' });
    return { id: String(result.message_id), messageIds: [result.message_id], chatId };
  }
  async getUpdates(offset?: number): Promise<Array<{ update_id: number; message?: TelegramUpdateMessage }>> {
    return this.call('getUpdates', { timeout: 0, limit: 100, ...(offset === undefined ? {} : { offset }) });
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
  document?: TelegramDocument;
}

