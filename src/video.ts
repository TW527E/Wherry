import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Attachment, PreparedVideo, Transport } from './types.js';
import { hash, sourceBytes, UnsupportedMediaError } from './media.js';

/**
 * Phase 2 video profile: MP4 / H.264 / AAC-LC / YUV 4:2:0 / 30 fps, preserving aspect,
 * ≤140 s (X non-Premium baseline). Bluesky uploads through its dedicated video service.
 */
export interface VideoConfig { dataDir: string; maxDownloadBytes: number; ffmpegPath: string; ffprobePath: string }

export const MAX_VIDEO_SECONDS = 140;

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

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], timeout = 300_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { shell: false, timeout, killSignal: 'SIGKILL', maxBuffer: 2_000_000, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UnsupportedMediaError(code === 'ENOENT' ? 'Video tool not available' : 'Video processing failed or exceeded its limits');
  }
}

// Playlists must not open network or sibling-file inputs outside the guarded media loader.
const inputOptions = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg'];

export async function probeVideo(path: string, config: VideoConfig): Promise<VideoProbe> {
  const stdout = await run(config.ffprobePath, [
    '-v', 'error', ...inputOptions, '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', path,
  ], 60_000);
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

/**
 * Download (or read) the source, transcode it to the safe MP4 profile, and return the prepared
 * video. Rejects sources longer than the ceiling rather than truncating them. The output stays on
 * disk (video can be large); publishers read it from `path`.
 */
export async function prepareVideo(attachment: Attachment, config: VideoConfig, transport: Transport): Promise<PreparedVideo> {
  if (attachment.kind !== 'video') throw new UnsupportedMediaError('prepareVideo requires a video attachment');
  if (!attachment.url && !attachment.path) throw new UnsupportedMediaError('Video source is unavailable (X serves HLS; a direct MP4 URL is required)');
  const directory = resolve(config.dataDir, 'media');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const workspace = await mkdtemp(resolve(directory, 'video-'));
  const sourcePath = resolve(workspace, 'source');
  try {
    const bytes = await sourceBytes(attachment, config, transport);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const probe = await probeVideo(sourcePath, config);
    if (!probe.hasVideo) throw new UnsupportedMediaError('File has no video stream');
    const plan = planTranscode(probe);
    if (plan.tooLong) throw new UnsupportedMediaError(`Video is ${Math.round(probe.durationSeconds)}s, over the ${MAX_VIDEO_SECONDS}s limit; trim it before syncing`);
    const outPath = resolve(workspace, 'output.mp4');
    await run(config.ffmpegPath, [
      '-v', 'error', ...inputOptions, '-y', '-i', sourcePath,
      '-vf', `scale=${plan.width}:${plan.height},fps=${plan.fps},format=yuv420p`,
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      outPath,
    ]);
    const outBytes = await readFile(outPath);
    const sha256 = hash(outBytes);
    const target = resolve(directory, `${sha256}.mp4`);
    await writeFile(target, outBytes, { mode: 0o600, flag: 'wx' }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const cached = await sourceBytes({ kind: 'video', path: target, alt: '' }, { ...config, maxDownloadBytes: outBytes.length }, transport);
      if (!cached.equals(outBytes)) throw new UnsupportedMediaError('Cached video content does not match its filename');
    });
    return {
      path: target, mimeType: 'video/mp4', alt: attachment.alt || '',
      width: plan.width, height: plan.height, durationSeconds: Math.round(probe.durationSeconds),
      size: outBytes.length, sha256,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
