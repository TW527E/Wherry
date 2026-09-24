import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTranscode, prepareVideo, MAX_VIDEO_SECONDS } from '../src/video.js';
import type { Transport } from '../src/types.js';

test('planTranscode keeps aspect and forces even dimensions within the edge cap', () => {
  const p = planTranscode({ durationSeconds: 30, width: 1920, height: 1080, hasVideo: true }, 1280);
  assert.equal(p.width % 2, 0);
  assert.equal(p.height % 2, 0);
  assert.ok(Math.max(p.width, p.height) <= 1280);
  // 1920x1080 → 1280x720 at the 1280 edge cap.
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 30);
  assert.equal(p.tooLong, false);
});

test('planTranscode does not upscale a small source', () => {
  const p = planTranscode({ durationSeconds: 10, width: 480, height: 480, hasVideo: true }, 1280);
  assert.equal(p.width, 480);
  assert.equal(p.height, 480);
});

test('planTranscode flags an over-length video instead of trimming it', () => {
  const p = planTranscode({ durationSeconds: MAX_VIDEO_SECONDS + 1, width: 1280, height: 720, hasVideo: true });
  assert.equal(p.tooLong, true);
});

test('planTranscode tolerates a missing probe geometry', () => {
  const p = planTranscode({ durationSeconds: 5, width: 0, height: 0, hasVideo: true });
  assert.ok(p.width >= 2 && p.width % 2 === 0);
  assert.ok(p.height >= 2 && p.height % 2 === 0);
});

test('video inputs reuse image path and byte limits before invoking any media tool', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const media = join(directory, 'media');
  mkdirSync(media);
  const outside = join(directory, 'outside.mp4');
  const oversized = join(media, 'oversized.mp4');
  const link = join(media, 'link.mp4');
  writeFileSync(outside, 'original');
  writeFileSync(oversized, Buffer.alloc(11));
  symlinkSync(outside, link);
  const config = { dataDir: directory, maxDownloadBytes: 10, ffmpegPath: '/missing/ffmpeg', ffprobePath: '/missing/ffprobe' };
  const transport: Transport = { async request() { throw new Error('Network is unavailable in tests'); } };
  for (const path of [outside, link]) {
    await assert.rejects(prepareVideo({ kind: 'video', path, alt: '' }, config, transport), /inside DATA_DIR\/media/);
  }
  await assert.rejects(prepareVideo({ kind: 'video', path: oversized, alt: '' }, config, transport), /download limit/);
  assert.equal(readFileSync(outside, 'utf8'), 'original');
  assert.deepEqual(readdirSync(media).sort(), ['link.mp4', 'oversized.mp4']);
});

test('video processing uses bounded argument-list tools and removes temporary work on success or failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wherry-video-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const media = join(directory, 'media');
  mkdirSync(media);
  const source = join(media, 'source.mp4');
  writeFileSync(source, 'original');
  const tool = join(directory, 'media-tool');
  writeFileSync(tool, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[args.indexOf('-protocol_whitelist') + 1] !== 'file' || !args.includes('-format_whitelist')) process.exit(2);
if (args.includes('-show_entries')) process.stdout.write(JSON.stringify({ streams: [{ width: 4, height: 4 }], format: { duration: '1' } }));
else fs.writeFileSync(args.at(-1), 'prepared');
`, { mode: 0o700 });
  const config = { dataDir: directory, maxDownloadBytes: 1000, ffmpegPath: tool, ffprobePath: tool };
  const transport: Transport = { async request() { throw new Error('Network is unavailable in tests'); } };
  const prepared = await prepareVideo({ kind: 'video', path: source, alt: 'clip' }, config, transport);
  assert.equal(readFileSync(prepared.path, 'utf8'), 'prepared');
  assert.equal(prepared.size, 8);
  assert.equal(prepared.alt, 'clip');
  assert.equal(readFileSync(source, 'utf8'), 'original');
  const retry = await prepareVideo({ kind: 'video', path: source, alt: 'clip' }, config, transport);
  assert.equal(retry.path, prepared.path);
  writeFileSync(prepared.path, 'tampered');
  await assert.rejects(prepareVideo({ kind: 'video', path: source, alt: '' }, config, transport), /does not match/);
  assert.equal(readFileSync(prepared.path, 'utf8'), 'tampered', 'a mismatched existing file is never overwritten');
  assert.ok(readdirSync(media).every(name => !name.startsWith('video-')));
  await assert.rejects(prepareVideo({ kind: 'video', path: source, alt: '' }, { ...config, ffmpegPath: '/missing/ffmpeg' }, transport), /tool not available/);
  assert.ok(readdirSync(media).every(name => !name.startsWith('video-')));
});
