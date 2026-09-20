#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createRuntime, createWeb } from './app.js';
import { safeError } from './engine.js';
import { resolveBrowserPlan, verifyBrowserPlan } from './platforms/browser.js';
import { loginInteractive } from './platforms/x.js';
import { createInterface } from 'node:readline/promises';

const usage = `crosspost-bridge — X-first cross-posting with manual X publishing

Usage:
  crosspost-bridge serve                 Run the scheduler, worker and Web UI
  crosspost-bridge once                  Run one collect + seal + publish cycle
  crosspost-bridge status                Print jobs, batches and recent events
  crosspost-bridge scan                  Collect sources only (no publishing unless live)
  crosspost-bridge publish <batchId>     Enqueue downstream publication for a sealed batch
  crosspost-bridge schedule <iso> <text> Create a local scheduled post (no X write)
  crosspost-bridge action <verb> <id>    skip | approve | mirror | retry
  crosspost-bridge doctor                Validate configuration and report capabilities
  crosspost-bridge login                 Open a visible browser to log into X once (saves the session)

X publishing is always manual. This tool only reads X and can never post to it.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(usage); return 0; }
  const config = loadConfig();
  const runtime = createRuntime(config);
  try {
    switch (command) {
      case 'serve': {
        const app = await createWeb(runtime);
        await app.listen({ host: config.host, port: config.port });
        runtime.store.event('info', `Service started in ${config.mode} mode on ${config.host}:${config.port}`);
        console.log(`crosspost-bridge listening on http://${config.host}:${config.port} (mode=${config.mode})`);
        if (config.mode !== 'live') console.log('preview mode: no remote publication is performed');
        await new Promise<void>(resolve => {
          const shutdown = (): void => resolve();
          process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
        });
        await app.close();
        return 0;
      }
      case 'once': await runtime.once(); printStatus(runtime); return 0;
      case 'scan': await runtime.once(); printStatus(runtime); return 0;
      case 'status': printStatus(runtime); return 0;
      case 'publish': {
        const batchId = argv[1];
        if (!batchId) throw new Error('publish requires a batch id');
        const batch = runtime.store.getBatch(batchId);
        if (!batch) throw new Error(`Unknown batch ${batchId}`);
        if (batch.state !== 'sealed') throw new Error(`Batch ${batchId} is ${batch.state}; only sealed batches can be published`);
        const now = new Date().toISOString();
        for (const destination of config.destinations) runtime.store.enqueue('publish', batchId, destination, now);
        await runtime.worker.run();
        printStatus(runtime);
        return 0;
      }
      case 'schedule': {
        const dueAt = argv[1]; const text = argv.slice(2).join(' ');
        if (!dueAt || !text) throw new Error('schedule requires an ISO timestamp and text');
        const id = runtime.engine.schedule({ text, dueAt });
        console.log(`scheduled batch ${id} for ${dueAt} (no X write is scheduled)`);
        return 0;
      }
      case 'action': {
        const verb = argv[1] as 'skip' | 'mirror' | 'approve' | 'retry' | undefined;
        const id = argv[2];
        if (!verb || !id || !['skip', 'mirror', 'approve', 'retry'].includes(verb)) throw new Error('action requires one of skip|mirror|approve|retry and an id');
        runtime.engine.action(verb, id);
        console.log(`applied ${verb} to ${id}`);
        return 0;
      }
      case 'login': {
        if (!config.x.enabled) throw new Error('X_ENABLED is false; enable X before logging in');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const result = await loginInteractive(config.x, {
            waitForEnter: async () => { await rl.question('登入完成後按 Enter 繼續…'); },
            log: message => console.log(message),
          });
          if (result.authenticated) console.log(`登入成功，session 已存到 ${config.x.profileDir}。之後 scan/serve 就能讀到你的推文了。`);
          else console.log('看起來仍未通過登入（偵測到登入或驗證畫面）。請重跑 login 並確認完成登入後再按 Enter。');
          return result.authenticated ? 0 : 1;
        } finally { rl.close(); }
      }
      case 'doctor': {
        const browser = resolveBrowserPlan({ choice: config.x.browser, executablePath: config.x.executablePath });
        let browserStatus: string;
        try { verifyBrowserPlan(browser); browserStatus = `ok — ${browser.description}`; }
        catch (error) { browserStatus = `problem — ${safeError(error)}`; }
        console.log(JSON.stringify({
          mode: config.mode,
          database: config.databasePath,
          destinations: config.destinations,
          sources: { x: config.x.enabled, bluesky: config.bluesky.enabled, sharkey: config.sharkey.enabled },
          xBrowser: { ...browser, status: browserStatus },
          telegram: { enabled: config.telegram.enabled, private: Boolean(config.telegram.privateChatId), ops: Boolean(config.telegram.opsChatId), public: Boolean(config.telegram.publicChatId) },
          xWrites: 'disabled by design (manual only)',
        }, null, 2));
        return 0;
      }
      default: console.log(usage); return 1;
    }
  } finally {
    if (command !== 'serve') await runtime.stop();
  }
}

function printStatus(runtime: ReturnType<typeof createRuntime>): void {
  const jobs = runtime.store.jobs(20);
  const batches = runtime.store.batches(10);
  console.log(`mode=${runtime.config.mode} destinations=${runtime.config.destinations.join(',') || '(none)'}`);
  console.log(`jobs: ${jobs.length}`);
  for (const job of jobs) console.log(`  ${job.state.padEnd(10)} ${job.destination.padEnd(9)} attempts=${job.attempts} ${job.aggregateId}${job.error ? ` :: ${job.error}` : ''}`);
  console.log(`batches: ${batches.length}`);
  for (const batch of batches) console.log(`  ${batch.state.padEnd(8)} ${batch.id} (${batch.reason})`);
  for (const event of runtime.store.events(10)) console.log(`  [${event.level}] ${event.at} ${event.message}`);
}

main().then(code => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`error: ${safeError(error)}`);
  process.exitCode = 1;
});
