#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig } from './config.js';
import { createRuntime, createWeb } from './app.js';
import { safeError } from './engine.js';
import { resolveBrowserPlan, verifyBrowserPlan } from './platforms/browser.js';
import { loginInteractive, exportSession, installSession } from './platforms/x.js';
import { parseSessionFile } from './platforms/session.js';
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, chmod } from 'node:fs/promises';

const usage = `crosspost-bridge — X-first cross-posting with manual X publishing

Usage:
  crosspost-bridge serve                 Run the scheduler, worker and Web UI
  crosspost-bridge once                  Run one collect + seal + publish cycle
  crosspost-bridge status                Print jobs, batches and recent events
  crosspost-bridge scan                  Collect sources only (never publishes)
  crosspost-bridge publish <batchId>     Enqueue downstream publication for a sealed batch
  crosspost-bridge schedule <iso> <text> Create a local scheduled post (no X write)
  crosspost-bridge action <verb> <id>    skip | approve | mirror | retry | reconcile
  crosspost-bridge doctor                Validate configuration and report capabilities
  crosspost-bridge login                 Open a visible browser to log into X once (saves the session)
  crosspost-bridge export-session        Export the X login to X_SESSION_FILE (default: data/x-session.json)
  crosspost-bridge import-session        Install the session file at X_SESSION_FILE into this machine's X profile

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
        runtime.start();
        // Kick one cycle at startup without blocking the serve loop. runCycle already swallows its own
        // errors into an event, but attach a catch here too so this fire-and-forget can never surface as
        // an unhandledRejection if that internal guard ever changes.
        void runtime.once().catch(error => runtime.store.event('error', `Startup cycle failed: ${safeError(error)}`));
        await new Promise<void>(resolve => {
          const shutdown = (): void => resolve();
          process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
        });
        await app.close();
        return 0;
      }
      case 'once': await runtime.once(); printStatus(runtime); return 0;
      case 'scan': await runtime.scan(); printStatus(runtime); return 0;
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
        const verb = argv[1] as 'skip' | 'mirror' | 'approve' | 'retry' | 'reconcile' | undefined;
        const id = argv[2];
        if (!verb || !id || !['skip', 'mirror', 'approve', 'retry', 'reconcile'].includes(verb)) throw new Error('action requires one of skip|mirror|approve|retry|reconcile and an id');
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
      case 'export-session': {
        if (!config.x.enabled) throw new Error('X_ENABLED is false; nothing to export');
        // Destination is the env-configured, resolved path (X_SESSION_FILE); never a raw argv path.
        const target = config.x.sessionFile;
        const file = await exportSession(config.x);
        await writeFile(target, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
        await chmod(target, 0o600).catch(() => {});
        console.log(`已匯出 X session 到 ${target}（權限 600）。這是帳號登入憑證，請妥善保管、勿加入版控。`);
        console.log('用法：把這個檔案傳給 Telegram 機器人的「私人聊天」，或用 import-session 在伺服器安裝。');
        console.log('要改輸出位置請設定 X_SESSION_FILE 環境變數。');
        return 0;
      }
      case 'import-session': {
        if (!config.x.enabled) throw new Error('X_ENABLED is false; enable X before importing');
        // Source is the env-configured, resolved path (X_SESSION_FILE); never a raw argv path.
        const bytes = await readFile(config.x.sessionFile);
        const file = parseSessionFile(bytes);
        const result = await installSession(config.x, file);
        if (result.authenticated) console.log(`session 已安裝到 ${config.x.profileDir} 並驗證成功。`);
        else console.log('session 已安裝，但驗證時仍看到登入/驗證畫面；可能已過期，請在本機重新 login 後再匯出。');
        return result.authenticated ? 0 : 1;
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
    await runtime.stop();
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
