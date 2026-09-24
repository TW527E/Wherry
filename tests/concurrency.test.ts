import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialWork } from '../src/lifecycle.js';
import { loadConfig } from '../src/config.js';
import { TelegramClient } from '../src/platforms/telegram.js';
import type { HttpOptions, HttpResponse, Transport } from '../src/types.js';

// The point of two lanes: a slow task on one lane must not delay a quick task on the other. If both
// shared a single SerialWork, the quick task would only settle after the slow one — this asserts the
// opposite ordering, so a Telegram command no longer waits behind a running collection scan.
test('two serial lanes do not block each other', async () => {
  const heavy = new SerialWork();
  const control = new SerialWork();
  const order: string[] = [];
  let releaseHeavy!: () => void;
  const heavyGate = new Promise<void>(resolve => { releaseHeavy = resolve; });

  const heavyTask = heavy.run(async () => { await heavyGate; order.push('heavy'); });
  const controlTask = control.run(async () => { order.push('control'); });

  // The control task completes while the heavy task is still gated open.
  await controlTask;
  assert.deepEqual(order, ['control'], 'the control lane finished without waiting for the heavy lane');
  releaseHeavy();
  await heavyTask;
  assert.deepEqual(order, ['control', 'heavy']);
});

// Tasks queued on ONE lane still run strictly in order, one at a time (the property the worker and
// collection cycle rely on to avoid overlapping runs).
test('a single lane stays strictly serial', async () => {
  const lane = new SerialWork();
  const order: number[] = [];
  const tasks = [0, 1, 2].map(n => lane.run(async () => {
    await new Promise(resolve => setTimeout(resolve, (3 - n) * 5));
    order.push(n);
  }));
  await Promise.all(tasks);
  assert.deepEqual(order, [0, 1, 2], 'FIFO order holds even when earlier tasks are slower');
});

function telegramConfig() {
  return loadConfig({
    DATA_DIR: '/tmp', TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_OWNER_ID: '12345', TELEGRAM_POLL_COMMANDS: 'true',
  }).telegram;
}

// getUpdates must long-poll: send a non-zero Telegram `timeout` and give the HTTP layer more time
// than that window, or an idle poll would be aborted as a timeout before Telegram ever replies.
test('getUpdates long-polls with an HTTP timeout wider than the poll window', async () => {
  let seen: { url: string; options: HttpOptions } | undefined;
  const transport: Transport = {
    async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
      seen = { url, options };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ ok: true, result: [] })) };
    },
  };
  const client = new TelegramClient(telegramConfig(), transport);
  const updates = await client.getUpdates(42);
  assert.deepEqual(updates, [], 'an empty result set decodes to no updates');
  assert.ok(seen, 'the transport was called');
  const body = JSON.parse(String(seen!.options.body));
  assert.ok(body.timeout >= 1, 'a non-zero long-poll timeout is requested');
  assert.equal(body.offset, 42, 'the offset is forwarded');
  assert.ok(
    (seen!.options.timeoutMs ?? 0) > body.timeout * 1000,
    'the HTTP timeout exceeds the long-poll window so an idle poll is not aborted',
  );
});
