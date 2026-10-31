import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Attachment, PreparedImage, Transport } from './types.js';

interface MediaConfig { dataDir: string; maxDownloadBytes: number; maxImageBytes: number }
export class UnsupportedMediaError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedMediaError'; }
}
export const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export async function sourceBytes(attachment: Attachment, config: Pick<MediaConfig, 'dataDir' | 'maxDownloadBytes'>, transport: Transport): Promise<Buffer> {
  if (attachment.path) {
    const mediaRoot = resolve(config.dataDir, 'media');
    const actual = await realpath(resolve(attachment.path));
    const root = await realpath(mediaRoot);
    const rel = relative(root, actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new UnsupportedMediaError('Local media must be inside DATA_DIR/media');
    if ((await stat(actual)).size > config.maxDownloadBytes) throw new UnsupportedMediaError('Local media exceeds download limit');
    return readFile(actual);
  }
  if (!attachment.url) throw new UnsupportedMediaError('Media content is unavailable');
  const response = await transport.request(attachment.url, { maxBytes: config.maxDownloadBytes });
  if (response.status !== 200) throw new UnsupportedMediaError(`Media download returned HTTP ${response.status}`);
  return Buffer.from(response.body);
}

/**
 * The raster container a file's leading bytes declare, if it is one we publish. Checked before sharp
 * sees the bytes, so an SVG (rendered by librsvg) or any other decoder never parses untrusted input.
 */
export function rasterFormat(bytes: Uint8Array): 'jpg' | 'png' | 'gif' | 'webp' | 'avif' | undefined {
  const ascii = (start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1|msf1)$/.test(ascii(8, 12))) return 'avif';
  return undefined;
}

async function inspect(bytes: Buffer): Promise<Metadata> {
  if (!rasterFormat(bytes)) throw new UnsupportedMediaError('Unsupported or invalid image encoding');
  const metadata = await sharp(bytes, { animated: true, limitInputPixels: 40_000_000, failOn: 'warning' }).metadata();
  if (!['jpeg', 'png', 'webp', 'avif', 'gif', 'heif'].includes(metadata.format || '') || !metadata.width || !metadata.height) {
    throw new UnsupportedMediaError('Unsupported or invalid image encoding');
  }
  if ((metadata.pages || 1) > 1) throw new UnsupportedMediaError('Animated images are deferred to phase 2');
  return metadata;
}

export async function prepareImages(attachments: Attachment[], config: MediaConfig, transport: Transport): Promise<PreparedImage[]> {
  if (attachments.length > 4) throw new UnsupportedMediaError('Phase 1 supports at most four images');
  const result: PreparedImage[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image' || attachment.animated) throw new UnsupportedMediaError('Phase 1 supports static images only');
    const bytes = await sourceBytes(attachment, config, transport);
    const metadata = await inspect(bytes);
    let output: Buffer | undefined;
    const mimeType: 'image/png' | 'image/jpeg' = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
    for (const size of [4000, 3000, 2048, 1600, 1200, 800, 500]) {
      const pipeline = sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true });
      output = metadata.hasAlpha ? await pipeline.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer() : await pipeline.jpeg({ quality: size >= 2048 ? 85 : 76, mozjpeg: true }).toBuffer();
      if (output.length <= config.maxImageBytes) break;
    }
    if (!output || output.length > config.maxImageBytes) throw new UnsupportedMediaError('Image could not fit destination limit without further manual reduction');
    const final = await sharp(output).metadata();
    result.push({ bytes: output, mimeType, alt: attachment.alt || '', width: final.width!, height: final.height!, sha256: hash(output) });
  }
  return result;
}

/**
 * Store an image the owner attached to a scheduled post under DATA_DIR/media/uploads, named by its hash,
 * after the same checks a publish runs (format sniff, decode, static only), and return its attachment.
 */
export async function saveUpload(bytes: Buffer, alt: string, config: Pick<MediaConfig, 'dataDir' | 'maxDownloadBytes'>): Promise<Attachment> {
  if (bytes.length > config.maxDownloadBytes) throw new UnsupportedMediaError('Image exceeds the download limit');
  const format = rasterFormat(bytes);
  await inspect(bytes);
  const directory = resolve(config.dataDir, 'media', 'uploads');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sha256 = hash(bytes);
  const path = join(directory, `${sha256}.${format}`);
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  return { kind: 'image', path, alt, sha256, size: bytes.length };
}

/**
 * Remove media nothing will read again: transcoded videos (rebuilt on demand by a retry) and uploads
 * no undelivered scheduled post references, once older than `olderThanMs`. Returns how many went.
 */
export async function pruneMedia(dataDir: string, inUse: Set<string>, now: number, olderThanMs = 3 * 86400_000): Promise<number> {
  let removed = 0;
  const root = resolve(dataDir, 'media');
  for (const directory of [root, join(root, 'uploads')]) {
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(directory, name);
      if (directory === root && !name.endsWith('.mp4')) continue;
      if (inUse.has(path)) continue;
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || now - info.mtimeMs < olderThanMs) continue;
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}
