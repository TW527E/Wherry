import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Attachment, PreparedImage, Transport } from './types.js';

interface MediaConfig { dataDir: string; maxDownloadBytes: number; maxImageBytes: number }
export class UnsupportedMediaError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedMediaError'; }
}
const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function sourceBytes(attachment: Attachment, config: MediaConfig, transport: Transport): Promise<Buffer> {
  if (attachment.kind !== 'image' || attachment.animated) throw new UnsupportedMediaError('Phase 1 supports static images only');
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

async function inspect(bytes: Buffer): Promise<Metadata> {
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
    const bytes = await sourceBytes(attachment, config, transport);
    const metadata = await inspect(bytes);
    let output: Buffer | undefined;
    let mimeType: 'image/png' | 'image/jpeg' = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
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
