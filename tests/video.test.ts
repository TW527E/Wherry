import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTranscode, MAX_VIDEO_SECONDS } from '../src/video.js';

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
