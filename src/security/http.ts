import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import type { HttpOptions, HttpResponse, Transport } from '../types.js';

export class HttpError extends Error {
  constructor(message: string, public status?: number, public retryAfter?: number, public uncertain = false) {
    super(message);
    this.name = 'HttpError';
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultResolver: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });

export function isPublicAddress(input: string): boolean {
  try {
    const parsed = ipaddr.process(input.replace(/^\[|\]$/g, ''));
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv4') {
      const parts = parsed.toByteArray();
      if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return false;
    }
    if (parsed.kind() === 'ipv6') {
      const first = parsed.toByteArray()[0]!;
      if (first < 0x20 || first > 0x3f) return false;
    }
    return true;
  } catch { return false; }
}

export async function validatePublicUrl(input: string, resolver: Resolver = defaultResolver): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError('Invalid external URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new HttpError('Only HTTP(S) URLs are allowed');
  if (url.username || url.password) throw new HttpError('Credentials in URLs are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new HttpError('Nonstandard external ports are blocked');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(hostname) || hostname.includes('%')) {
    throw new HttpError('Local network URLs are blocked');
  }
  let addresses: Array<{ address: string; family: number }>;
  if (ipaddr.isValid(hostname)) addresses = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
  else {
    try { addresses = await resolver(hostname); } catch { throw new HttpError('External hostname resolution failed'); }
  }
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new HttpError('Private, loopback, reserved and metadata addresses are blocked');
  return { url, addresses };
}

const unzip = promisify(gunzip), unflate = promisify(inflate), unbrotli = promisify(brotliDecompress);
const secretHeader = (headers: Record<string, string>): boolean => Object.keys(headers).some(key => /^(authorization|cookie|x-api-key)$/i.test(key));
const mutation = (method: string): boolean => !['GET', 'HEAD', 'OPTIONS'].includes(method);

export class SafeHttp implements Transport {
  constructor(private readonly resolver: Resolver = defaultResolver) {}

  async request(input: string, options: HttpOptions = {}): Promise<HttpResponse> {
    const method = (options.method || 'GET').toUpperCase();
    const maxBytes = options.maxBytes ?? 8_000_000;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxRedirects = options.maxRedirects ?? 3;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers || {})) {
      if (!/^(host|connection|transfer-encoding|content-length|accept-encoding|proxy-authorization)$/i.test(key)) headers[key.toLowerCase()] = value;
    }
    headers['accept-encoding'] = 'identity';
    headers['user-agent'] ??= 'CrosspostBridge/0.1';
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    if (body) headers['content-length'] = String(body.length);
    let current = input;
    for (let redirects = 0; ; redirects++) {
      const { url, addresses } = await validatePublicUrl(current, this.resolver);
      if (url.protocol !== 'https:' && (secretHeader(headers) || mutation(method))) throw new HttpError('Authenticated and mutating requests require HTTPS');
      const address = addresses[0]!;
      const response = await new Promise<HttpResponse>((resolve, reject) => {
        let settled = false;
        const fail = (message: string): void => {
          if (!settled) { settled = true; reject(new HttpError(message, undefined, undefined, mutation(method))); }
        };
        const requester = url.protocol === 'https:' ? https : http;
        const request = requester.request(url, {
          method, headers, agent: false,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        }, incoming => {
          const contentLength = Number(incoming.headers['content-length']);
          if (contentLength > maxBytes) { incoming.destroy(); request.destroy(); fail('External response exceeds byte limit'); return; }
          let length = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > maxBytes) { incoming.destroy(); request.destroy(); fail('External response exceeds byte limit'); }
            else chunks.push(chunk);
          });
          incoming.on('error', () => fail('External response interrupted'));
          incoming.on('end', () => {
            if (settled) return;
            settled = true;
            const resultHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (value !== undefined) resultHeaders[key] = Array.isArray(value) ? value.join('\n') : String(value);
            }
            resolve({ status: incoming.statusCode || 0, headers: resultHeaders, body: Buffer.concat(chunks) });
          });
        });
        const timer = setTimeout(() => { request.destroy(); fail('External request timed out'); }, timeoutMs);
        timer.unref();
        request.on('close', () => clearTimeout(timer));
        request.on('error', () => fail('External request failed'));
        request.end(body);
      });
      if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
        if (mutation(method)) throw new HttpError('Redirect of a mutating request requires review', response.status, undefined, true);
        if (redirects >= maxRedirects) throw new HttpError('Too many external redirects');
        const next = new URL(response.headers.location, url);
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new HttpError('HTTPS downgrade blocked');
        if (secretHeader(headers) && next.origin !== url.origin) throw new HttpError('Authenticated cross-origin redirect blocked');
        current = next.href;
        continue;
      }
      try {
        const encoding = response.headers['content-encoding'];
        if (encoding === 'gzip') response.body = await unzip(response.body, { maxOutputLength: maxBytes });
        else if (encoding === 'deflate') response.body = await unflate(response.body, { maxOutputLength: maxBytes });
        else if (encoding === 'br') response.body = await unbrotli(response.body, { maxOutputLength: maxBytes });
        else if (encoding && encoding !== 'identity') throw new Error('Unknown encoding');
      } catch { throw new HttpError('External response decompression failed or exceeded limit', undefined, undefined, mutation(method)); }
      return response;
    }
  }

  async json<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
    const response = await this.request(url, options);
    const retry = Number(response.headers['retry-after']);
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(`External API returned HTTP ${response.status}`, response.status, Number.isFinite(retry) ? retry : undefined,
        response.status >= 500 && mutation((options.method || 'GET').toUpperCase()));
    }
    try { return JSON.parse(Buffer.from(response.body).toString('utf8')) as T; }
    catch { throw new HttpError('External API returned invalid JSON', response.status, undefined, mutation((options.method || 'GET').toUpperCase())); }
  }
}
