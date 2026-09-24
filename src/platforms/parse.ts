import { randomBytes } from 'node:crypto';
import type { HttpOptions, PreparedImage, Transport } from '../types.js';

export type JsonObject = Record<string, unknown>;

export interface PlatformErrorOptions {
  status?: number;
  retryAfter?: number;
  uncertain?: boolean;
  code?: string;
}

/** Structural counterpart of HttpError. retryAfter is always seconds, never milliseconds. */
export class PlatformError extends Error {
  readonly status?: number;
  readonly retryAfter?: number;
  readonly uncertain: boolean;
  readonly code?: string;

  constructor(message: string, options: PlatformErrorOptions = {}) {
    super(message);
    this.name = 'PlatformError';
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.uncertain = options.uncertain ?? false;
    this.code = options.code;
  }
}

export const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const own = Object.hasOwn;
export const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const isoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

/** Credentials must never travel over HTTP or be redirected to a different authority. DNS/IP policy is Transport's job. */
export function httpsBase(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PlatformError(`${label} must be an HTTPS URL`, { code: 'InvalidEndpoint' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\u0000-\u0020\\]/u.test(value)) {
    throw new PlatformError(`${label} must be an HTTPS URL without credentials, query or fragment`, { code: 'InvalidEndpoint' });
  }
  return url.href.replace(/\/+$/, '');
}

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u0020\\]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

function seconds(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : undefined;
}

function retryDelay(headers: Record<string, string>, payload: unknown): number | undefined {
  const data = object(payload);
  const nested = object(data?.error);
  const api = seconds(object(data?.parameters)?.retry_after) ?? seconds(object(nested?.info)?.retryAfter);
  if (api !== undefined) return api;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (entry !== undefined) {
    const numeric = seconds(entry);
    if (numeric !== undefined) return numeric;
    const date = Date.parse(entry);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

function errorCode(payload: unknown): string | undefined {
  const data = object(payload);
  return safeCode(data?.error) ?? safeCode(object(data?.error)?.code)
    ?? (positiveInteger(data?.error_code) ? `TELEGRAM_${data.error_code}` : undefined);
}

/**
 * The server's human-readable rejection reason (XRPC/Misskey `message`), sanitized: URLs and long
 * opaque tokens are redacted and the length is capped, so it can go in logs without leaking
 * credentials or reflected request bodies. This is the "why" a bare code like InvalidRequest omits.
 */
function safeDetail(payload: unknown): string | undefined {
  const data = object(payload);
  const raw = typeof data?.message === 'string' ? data.message
    : typeof object(data?.error)?.message === 'string' ? (object(data?.error)!.message as string)
    : typeof data?.description === 'string' ? data.description : undefined;
  if (!raw) return;
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[A-Za-z0-9._-]{40,}/g, '<token>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned || undefined;
}

/** Do not include credential-bearing URLs or reflected request bodies in errors; server detail is sanitized. */
export function apiFailure(operation: string, status: number, headers: Record<string, string>, payload: unknown, mutation: boolean): PlatformError {
  const code = errorCode(payload);
  const detail = safeDetail(payload);
  const explicitRejection = code !== undefined && new Set([
    'RecordAlreadyExists', 'NO_FREE_SPACE', 'MAX_FILE_SIZE_EXCEEDED', 'FILE_TOO_BIG',
    'RATE_LIMIT_EXCEEDED', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'ExpiredToken', 'InvalidToken',
  ]).has(code);
  return new PlatformError(`${operation} rejected${code ? ` (${code})` : ''}; HTTP ${status}${detail ? `: ${detail}` : ''}`, {
    status,
    code: code ?? `HTTP_${status}`,
    retryAfter: retryDelay(headers, payload),
    uncertain: mutation && !explicitRejection && (status >= 500 || status === 408 || (status >= 300 && status < 400)),
  });
}

export function uncertainError(operation: string, error: unknown): PlatformError {
  const details = object(error);
  return new PlatformError(`${operation}: the remote outcome cannot be confirmed`, {
    status: typeof details?.status === 'number' ? details.status : undefined,
    retryAfter: seconds(details?.retryAfter),
    code: safeCode(details?.code) ?? 'UnknownOutcome',
    uncertain: true,
  });
}

export function schemaError(operation: string, mutation = false): PlatformError {
  return new PlatformError(`${operation} returned an invalid or incomplete response`, { code: 'InvalidResponse', uncertain: mutation });
}

/** All adapter I/O goes through this helper and the supplied guarded Transport, including uploads and sessions. */
export async function requestJson(transport: Transport, url: string, options: HttpOptions, operation: string, mutation = false): Promise<unknown> {
  let response;
  try {
    response = await transport.request(url, { maxBytes: 4_000_000, ...options, maxRedirects: 0 });
  } catch (error) {
    const details = object(error);
    const status = typeof details?.status === 'number' ? details.status : undefined;
    const explicit = details?.uncertain === false || (status !== undefined && status >= 400 && status < 500 && status !== 408);
    throw new PlatformError(`${operation}: transport did not return a confirmed response`, {
      status,
      code: safeCode(details?.code) ?? 'TransportError',
      retryAfter: seconds(details?.retryAfter),
      uncertain: mutation && !explicit,
    });
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
  catch {
    if (response.status < 200 || response.status >= 300) throw apiFailure(operation, response.status, response.headers, undefined, mutation);
    throw schemaError(operation, mutation);
  }
  if (response.status < 200 || response.status >= 300) throw apiFailure(operation, response.status, response.headers, payload, mutation);
  const data = object(payload);
  // Telegram can carry failures in HTTP 200; Sharkey and XRPC failures use an error envelope.
  if (data?.ok === false || nonempty(data?.error) || object(data?.error)) {
    const apiStatus = positiveInteger(data?.error_code) ? data.error_code : 400;
    throw apiFailure(operation, apiStatus, response.headers, payload, mutation);
  }
  return payload;
}

export function jsonBody(value: unknown): Pick<HttpOptions, 'method' | 'headers' | 'body'> {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(value) };
}

export function validateImage(image: PreparedImage, maxBytes?: number): void {
  if (!image || !(image.bytes instanceof Uint8Array) || image.bytes.length === 0 || !['image/png', 'image/jpeg'].includes(image.mimeType)) {
    throw new PlatformError('Phase 1 requires prepared, static JPEG or PNG image bytes', { code: 'UnsupportedMedia' });
  }
  if (typeof image.alt !== 'string') throw new PlatformError('Every image requires an alt field (an empty string is allowed)', { code: 'MissingAlt' });
  if (!positiveInteger(image.width) || !positiveInteger(image.height)) throw new PlatformError('Prepared images require positive dimensions', { code: 'InvalidImage' });
  if (maxBytes !== undefined && image.bytes.length > maxBytes) throw new PlatformError(`Image exceeds the ${maxBytes}-byte destination limit`, { code: 'ImageTooLarge' });
}

export interface MultipartFile { field: string; filename: string; mimeType: string; bytes: Uint8Array }

/** Builds multipart bytes locally. No FormData, URL uploads, SDK, or hidden fetch implementation. */
export function multipart(fields: Record<string, string>, files: MultipartFile[]): { body: Uint8Array; contentType: string } {
  const boundary = `crosspost-${randomBytes(24).toString('hex')}`;
  const chunks: Buffer[] = [];
  const safe = (value: string): string => {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new PlatformError('Invalid multipart field or filename', { code: 'InvalidMultipart' });
    return value;
  };
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const file of files) {
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.mimeType)) throw new PlatformError('Invalid multipart media type', { code: 'InvalidMultipart' });
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${safe(file.field)}"; filename="${safe(file.filename)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`, 'utf8'));
    chunks.push(Buffer.from(file.bytes));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const data = object(value);
  if (data) return `{${Object.keys(data).sort().filter(key => data[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(data[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function warning(error: unknown): string {
  const code = safeCode(object(error)?.code);
  return code ? `Collection failed (${code})` : 'Collection failed before completeness could be established';
}
