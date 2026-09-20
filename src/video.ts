import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Attachment, PreparedVideo, Transport } from './types.js';
import { UnsupportedMediaError } from './media.js';

/**
 * Phase 2 video spec (§8.4): MP4 / H.264 / AAC-LC / YUV 4:2:0 / 30 fps, aspect 16:9 | 9:16 | 1:1,
 * ≤140 s (X non-Premium baseline). Bluesky only accepts MP4 and routes >50 MB through its video
 * service. We transcode every source to that safe profile with ffmpeg so all three platforms accept it.
 */
export interface VideoConfig { dataDir: string; maxDownloadBytes: number; ffmpegPath: string; ffprobePath: string }

export const MAX_VIDEO_SECONDS = 140;
export const BLUESKY_VIDEO_MAX_BYTES = 50_000_000; // above this, Bluesky requires its video service

export interface VideoProbe { durationSeconds: number; width: number; height: number; hasVideo: boolean }

export interface TranscodePlan {
  /** Even output dimensions preserving the source aspect, capped to a sane max edge. */
  width: number;
  height: number;
  fps: number;
  /** true when the source is longer than the allowed ceiling and must be rejected, not silently cut. */
  tooLong: boolean;
}

/**
 * Decide the output geometry from a probe. Pure and unit-tested: no ffmpeg, no I/O.
 * H.264 needs even dimensions; we scale the long edge down to `maxEdge` and round to even.
 */
export function planTranscode(probe: VideoProbe, maxEdge = 1280): TranscodePlan {
  const srcW = probe.width > 0 ? probe.width : 1280;
  const srcH = probe.height > 0 ? probe.height : 720;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const even = (n: number): number => { const v = Math.max(2, Math.round(n * scale)); return v % 2 === 0 ? v : v - 1; };
  return { width: even(srcW), height: even(srcH), fps: 30, tooLong: probe.durationSeconds > MAX_VIDEO_SECONDS };
}

function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new UnsupportedMediaError('Video processing timed out')); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000); });
    child.on('error', err => { clearTimeout(timer); reject(new UnsupportedMediaError(`Video tool not available: ${err.message}`)); });
    child.on('close', code => { clearTimeout(timer); resolvePromise({ code: code ?? -1, stdout, stderr }); });
  });
}

export async function probeVideo(path: string, config: VideoConfig): Promise<VideoProbe> {
  const { code, stdout } = await run(config.ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', path,
  ], 60_000);
  if (code !== 0) throw new UnsupportedMediaError('Could not probe video (is it a valid media file?)');
  let parsed: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  try { parsed = JSON.parse(stdout); } catch { throw new UnsupportedMediaError('ffprobe returned invalid output'); }
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    hasVideo: Boolean(stream),
  };
}

const hash = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/**
 * Download (or read) the source, transcode it to the safe MP4 profile, and return the prepared
 * video. Rejects sources longer than the ceiling rather than truncating them. The output stays on
 * disk (video can be large); callers stream it from `path`.
 */
export async function prepareVideo(attachment: Attachment, config: VideoConfig, transport: Transport): Promise<PreparedVideo> {
  if (attachment.kind !== 'video') throw new UnsupportedMediaError('prepareVideo requires a video attachment');
  if (!attachment.url && !attachment.path) throw new UnsupportedMediaError('Video source is unavailable (X serves HLS; a direct MP4 URL is required)');
  const directory = resolve(config.dataDir, 'media');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // Materialize the source to disk so ffmpeg/ffprobe can seek it.
  let sourcePath: string;
  let temp = false;
  if (attachment.path) {
    sourcePath = attachment.path;
  } else {
    const response = await transport.request(attachment.url!, { maxBytes: config.maxDownloadBytes });
    if (response.status !== 200) throw new UnsupportedMediaError(`Video download returned HTTP ${response.status}`);
    sourcePath = resolve(directory, `${hash(response.body)}.src`);
    await (await import('node:fs/promises')).writeFile(sourcePath, response.body, { mode: 0o600 });
    temp = true;
  }

  try {
    const probe = await probeVideo(sourcePath, config);
    if (!probe.hasVideo) throw new UnsupportedMediaError('File has no video stream');
    const plan = planTranscode(probe);
    if (plan.tooLong) throw new UnsupportedMediaError(`Video is ${Math.round(probe.durationSeconds)}s, over the ${MAX_VIDEO_SECONDS}s limit; trim it before syncing`);
    const outPath = resolve(directory, `${hash(Buffer.from(sourcePath + probe.durationSeconds))}.mp4`);
    const { code } = await run(config.ffmpegPath, [
      '-y', '-i', sourcePath,
      '-vf', `scale=${plan.width}:${plan.height},fps=${plan.fps},format=yuv420p`,
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      outPath,
    ]);
    if (code !== 0) throw new UnsupportedMediaError('Video transcode failed');
    const size = (await stat(outPath)).size;
    const outBytes = await readFile(outPath);
    return {
      path: outPath, mimeType: 'video/mp4', alt: attachment.alt || '',
      width: plan.width, height: plan.height, durationSeconds: Math.round(probe.durationSeconds),
      size, sha256: hash(outBytes),
    };
  } finally {
    if (temp) await rm(sourcePath, { force: true }).catch(() => undefined);
  }
}
