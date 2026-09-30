import { resolve } from 'node:path';
import { z } from 'zod';
import { BROWSER_CHOICES } from './platforms/browser.js';
import { BLUESKY_SENSITIVE_LABELS, DEFAULT_BLUESKY_SENSITIVE_LABEL } from './content-warning.js';
import type { Destination, SensitiveLabel } from './types.js';

const bool = (value: string | undefined, fallback: boolean): boolean => value === undefined ? fallback : value === 'true';

// Attribution appended to the bottom of every Sharkey note synced from X. Sharkey renders MFM, so
// this is MFM/Markdown, not plain text. `{url}` is replaced with the note's own X source link; a
// second link points at the project repo. Override with SHARKEY_SIGNATURE — set it to an empty
// string to publish Sharkey notes with no attribution at all (like clearing an email signature).
export const DEFAULT_SHARKEY_SIGNATURE =
  '<center><small>$[sparkle $[blur 這是從 X 來的推文，[點擊此處]({url})前往原文，[點擊此處](https://github.com/TW527E/Wherry)前往項目倉庫]]</small></center>';
const integer = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = value === undefined ? fallback : Number(value);
  return z.number().int().min(min).max(max).parse(n);
};

export interface AppConfig {
  dataDir: string;
  databasePath: string;
  mode: 'preview' | 'live';
  host: string;
  port: number;
  webToken: string;
  pollSeconds: number;
  threadWindowSeconds: number;
  settleSeconds: number;
  sourceFreshnessSeconds: number;
  maxImageBytes: number;
  maxDownloadBytes: number;
  maxAttempts: number;
  destinations: Destination[];
  x: { enabled: boolean; handle: string; profileDir: string; browser: string; executablePath: string; headless: boolean; maxPages: number; sessionFile: string; sandbox: boolean };
  media: { video: boolean; ffmpegPath: string; ffprobePath: string };
  bluesky: { enabled: boolean; identifier: string; appPassword: string; serviceUrl: string; publicUrl: string; sensitiveLabel: SensitiveLabel };
  sharkey: { enabled: boolean; baseUrl: string; token: string; userId: string; username: string; signature: string; driveFolder: string; uploadName: string };
  telegram: { enabled: boolean; token: string; ownerId: string; privateChatId: string; opsChatId: string; publicChatId: string; pollCommands: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(env.DATA_DIR || 'data');
  const mode = z.enum(['preview', 'live']).parse(env.APP_MODE || 'preview');
  const destinations = z.array(z.enum(['bluesky', 'sharkey', 'telegram'])).parse(
    (env.DESTINATIONS || '').split(',').map(s => s.trim()).filter(Boolean),
  );
  const config: AppConfig = {
    dataDir,
    databasePath: resolve(dataDir, 'crosspost.sqlite'),
    mode,
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3000, 1, 65535),
    webToken: env.WEB_TOKEN || '',
    pollSeconds: integer(env.POLL_SECONDS, 120, 30, 86400),
    threadWindowSeconds: integer(env.THREAD_WINDOW_SECONDS, 600, 30, 3600),
    settleSeconds: integer(env.THREAD_SETTLE_SECONDS, 180, 30, 1800),
    sourceFreshnessSeconds: integer(env.SOURCE_FRESHNESS_SECONDS, 300, 30, 3600),
    maxImageBytes: 2_000_000,
    maxDownloadBytes: integer(env.MAX_DOWNLOAD_BYTES, 20_000_000, 1_000, 100_000_000),
    maxAttempts: integer(env.MAX_ATTEMPTS, 5, 1, 20),
    destinations: [...new Set(destinations)],
    x: {
      enabled: bool(env.X_ENABLED, false), handle: env.X_HANDLE || '',
      profileDir: resolve(env.X_PROFILE_DIR || `${dataDir}/x-profile`),
      browser: (env.X_BROWSER || 'auto').trim().toLowerCase(),
      executablePath: env.CHROMIUM_PATH || '', headless: bool(env.X_HEADLESS, true),
      maxPages: integer(env.X_MAX_PAGES, 4, 1, 10),
      sessionFile: resolve(env.X_SESSION_FILE || `${dataDir}/x-session.json`),
      // Chromium's sandbox cannot start as root on Linux and needs --no-sandbox there.
      // Default: off when running as root on Linux, on everywhere else. X_SANDBOX overrides.
      sandbox: bool(env.X_SANDBOX, !(process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0)),
    },
    media: {
      video: bool(env.VIDEO_ENABLED, false),
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    },
    bluesky: {
      enabled: bool(env.BLUESKY_ENABLED, false), identifier: env.BLUESKY_IDENTIFIER || '',
      appPassword: env.BLUESKY_APP_PASSWORD || '', serviceUrl: env.BLUESKY_SERVICE_URL || 'https://bsky.social',
      publicUrl: 'https://public.api.bsky.app',
      sensitiveLabel: z.enum(BLUESKY_SENSITIVE_LABELS).parse(env.BLUESKY_SENSITIVE_LABEL ?? DEFAULT_BLUESKY_SENSITIVE_LABEL),
    },
    sharkey: {
      enabled: bool(env.SHARKEY_ENABLED, false), baseUrl: env.SHARKEY_URL || 'https://dvd.chat',
      token: env.SHARKEY_TOKEN || '', userId: env.SHARKEY_USER_ID || '', username: env.SHARKEY_USERNAME || '',
      // `??` not `||`: an explicit empty string disables the signature, while leaving it unset keeps the default.
      signature: env.SHARKEY_SIGNATURE ?? DEFAULT_SHARKEY_SIGNATURE,
      // Drive folder that synced media is uploaded into. `??` with `.trim()`: an explicit empty string
      // (or all-whitespace) uploads to the drive root, while leaving it unset keeps the default folder.
      // The folder is looked up by name at the drive root and created on first use (needs read+write:drive).
      driveFolder: (env.SHARKEY_DRIVE_FOLDER ?? 'Wherry').trim(),
      // Filename template for uploaded Drive files. Placeholders: {timestamp} (compact UTC, e.g.
      // 20260921T153000Z), {index} (0-based position within the note) and {ext} (png/jpg/mp4).
      // Only letters, digits, `_`, `.` and `-` are allowed once the placeholders are filled.
      uploadName: (env.SHARKEY_UPLOAD_NAME ?? 'Wherry_{timestamp}-{index}.{ext}').trim(),
    },
    telegram: {
      enabled: bool(env.TELEGRAM_ENABLED, false), token: env.TELEGRAM_BOT_TOKEN || '',
      ownerId: env.TELEGRAM_OWNER_ID || '', privateChatId: env.TELEGRAM_PRIVATE_CHAT_ID || env.TELEGRAM_OWNER_ID || '',
      opsChatId: env.TELEGRAM_OPS_CHAT_ID || '', publicChatId: env.TELEGRAM_PUBLIC_CHAT_ID || '',
      pollCommands: bool(env.TELEGRAM_POLL_COMMANDS, false),
    },
  };
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.webToken.length < 32) {
    throw new Error('WEB_TOKEN must have at least 32 characters when binding outside loopback');
  }
  // A destination that is never observed cannot rule out a manual mirror of that post on X.
  // Requiring the matching source keeps the anti-loop check meaningful instead of silently guessing.
  for (const destination of config.destinations) {
    if (destination === 'bluesky' && !config.bluesky.enabled) throw new Error('DESTINATIONS includes bluesky, so BLUESKY_ENABLED must also be true (mirror detection requires observing that account)');
    if (destination === 'sharkey' && !config.sharkey.enabled) throw new Error('DESTINATIONS includes sharkey, so SHARKEY_ENABLED must also be true (mirror detection requires observing that account)');
  }
  // The template must yield a filesystem-safe name. Fill the placeholders with representative values
  // and check the result up front, so a bad SHARKEY_UPLOAD_NAME fails at startup, not mid-publish.
  if (config.sharkey.enabled) {
    const sample = config.sharkey.uploadName.replaceAll('{timestamp}', '20260921T153000Z').replaceAll('{index}', '0').replaceAll('{ext}', 'jpg');
    if (!sample || !/^[A-Za-z0-9_.-]+$/.test(sample)) {
      throw new Error('SHARKEY_UPLOAD_NAME must resolve to a name using only letters, digits, _, . and - (allowed placeholders: {timestamp}, {index}, {ext})');
    }
  }
  if (config.x.enabled && !/^[A-Za-z0-9_]{1,15}$/.test(config.x.handle)) throw new Error('Set a valid X_HANDLE before enabling X');
  if (!(BROWSER_CHOICES as readonly string[]).includes(config.x.browser)) {
    throw new Error(`X_BROWSER must be one of: ${BROWSER_CHOICES.join(', ')}`);
  }
  if (config.x.browser === 'path' && !config.x.executablePath) throw new Error('X_BROWSER=path requires CHROMIUM_PATH');
  for (const id of [config.telegram.ownerId, config.telegram.privateChatId, config.telegram.opsChatId, config.telegram.publicChatId]) {
    if (id && !/^-?\d+$/.test(id)) throw new Error('Telegram identities must be numeric IDs, not usernames');
  }
  return config;
}
