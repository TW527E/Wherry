import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readableEvent } from '../src/labels.js';

test('event log lines read as zh-Hant, and a line nobody translated stays raw', () => {
  const cases: Array<[string, string]> = [
    ['x: 3 new records from 12 collected; newest=2026-10-01T00:00:00.000Z baseline=2026-09-30T00:00:00.000Z', 'X：讀到 12 則，新增 3 則'],
    ['bluesky: 0 new records from 5 collected (baseline only); newest=(none) baseline=2026-09-30T00:00:00.000Z', 'Bluesky：讀到 5 則，首次掃描，只建立基準'],
    ['sharkey: 0 new records from 5 collected; newest=(none) baseline=2026-09-30T00:00:00.000Z — note incomplete: x', 'Sharkey：讀到 5 則，沒有新貼文；警告：note incomplete: x'],
    ['bluesky: delivered 2 parts', 'Bluesky：已送出 2 則'],
    ['sharkey: HTTP 522', 'Sharkey 發送失敗：HTTP 522'],
    ['sharkey collection failed: HTTP 522', '讀取 Sharkey 失敗：HTTP 522'],
    ['Sealing x:1 with stale downstream mirror data (bluesky, sharkey unreachable); manual-mirror detection may be incomplete', '批次 x:1 已封存，但 Bluesky、Sharkey 連不上，手動鏡像判斷可能不完整'],
    ['X batch held: possible_manual_mirror', 'X 批次暫停：疑似手動鏡像'],
    ['Owner action: skip', '你的操作：略過'],
  ];
  for (const [raw, readable] of cases) assert.equal(readableEvent(raw), readable, raw);
  assert.equal(readableEvent('something new nobody translated'), undefined);
});
