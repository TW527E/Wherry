import { existsSync } from 'node:fs';
import { PlatformError } from './parse.js';

/**
 * Browser selection for the read-only X collector.
 *
 * `executablePath` is the most predictable option, but owners often already have a
 * system Chrome/Edge installed and would rather not manage a separate binary. These
 * choices let the collector reuse it.
 */
export const BROWSER_CHOICES = [
  'auto',        // prefer a detected system browser, otherwise Playwright's own lookup
  'chrome',      // system Google Chrome (stable)
  'chrome-beta',
  'msedge',      // system Microsoft Edge
  'msedge-beta',
  'chromium',    // distribution-provided chromium package
  'path',        // require CHROMIUM_PATH
] as const;

export type BrowserChoice = (typeof BROWSER_CHOICES)[number];

export interface BrowserPlan {
  choice: BrowserChoice;
  /** Passed straight to Playwright as the `channel` launch option. */
  channel?: string;
  /** Passed straight to Playwright as the `executablePath` launch option. */
  executablePath?: string;
  /** Human readable summary for `doctor` and error messages. */
  description: string;
}

/** Known install locations, most specific first. Used for detection and reporting. */
export function browserCandidates(platform: NodeJS.Platform = process.platform): Record<'chrome' | 'msedge' | 'chromium', string[]> {
  if (platform === 'darwin') {
    return {
      chrome: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        `${process.env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ],
      msedge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/opt/homebrew/bin/chromium', '/usr/local/bin/chromium'],
    };
  }
  if (platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? '';
    return {
      chrome: [
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        ...(localAppData ? [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      ],
      msedge: [
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
      chromium: [],
    };
  }
  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/snap/bin/chrome'],
    msedge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  };
}

export interface ResolveBrowserInput {
  choice?: string;
  executablePath?: string;
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  exists?: (path: string) => boolean;
}

export function resolveBrowserPlan(input: ResolveBrowserInput = {}): BrowserPlan {
  const exists = input.exists ?? existsSync;
  const platform = input.platform ?? process.platform;
  const raw = (input.choice ?? 'auto').trim().toLowerCase();
  const explicitPath = input.executablePath?.trim();
  if (!(BROWSER_CHOICES as readonly string[]).includes(raw)) {
    throw new PlatformError(`Unknown browser choice "${raw}". Use one of: ${BROWSER_CHOICES.join(', ')}`, { code: 'InvalidBrowserChoice' });
  }
  const choice = raw as BrowserChoice;

  // An explicit path always wins so the owner can always override detection.
  if (explicitPath) {
    return { choice, executablePath: explicitPath, description: `explicit executable (${explicitPath})` };
  }
  if (choice === 'path') {
    throw new PlatformError('X_BROWSER=path requires CHROMIUM_PATH to point at a browser executable', { code: 'MissingBrowserPath' });
  }

  const candidates = browserCandidates(platform);
  const detect = (kind: 'chrome' | 'msedge' | 'chromium'): BrowserPlan | undefined => {
    const match = candidates[kind].find(candidate => exists(candidate));
    return match ? { choice, executablePath: match, description: `detected ${kind} (${match})` } : undefined;
  };

  if (choice === 'chrome' || choice === 'chrome-beta') return detect('chrome')
    ?? { choice, channel: choice === 'chrome-beta' ? 'chrome-beta' : 'chrome', description: `system ${choice} via Playwright channel` };
  if (choice === 'msedge' || choice === 'msedge-beta') return detect('msedge')
    ?? { choice, channel: choice === 'msedge-beta' ? 'msedge-beta' : 'msedge', description: `system ${choice} via Playwright channel` };
  if (choice === 'chromium') return detect('chromium')
    ?? { choice, channel: 'chromium', description: 'chromium via Playwright channel' };

  // auto: prefer something we can point at directly, then let Playwright look for Chrome.
  return detect('chrome') ?? detect('msedge') ?? detect('chromium')
    ?? { choice, channel: 'chrome', description: 'auto: system Chrome via Playwright channel' };
}

/** Verification step used by `doctor` and by the collector before it launches anything. */
export function verifyBrowserPlan(plan: BrowserPlan, exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): void {
  if (plan.executablePath && !exists(plan.executablePath)) {
    throw new PlatformError(`Browser executable not found: ${plan.executablePath}. Install a browser, set CHROMIUM_PATH, or choose another X_BROWSER value.`, { code: 'BrowserNotFound' });
  }
  if (!plan.executablePath && !plan.channel) {
    throw new PlatformError('No browser configured for the X collector', { code: 'BrowserNotFound' });
  }
  if (plan.channel && platform === 'linux' && !plan.executablePath) {
    const candidates = browserCandidates(platform);
    const anyKnown = [...candidates.chrome, ...candidates.msedge, ...candidates.chromium].some(candidate => exists(candidate));
    if (!anyKnown) {
      throw new PlatformError(`No system browser was detected for channel "${plan.channel}". Install google-chrome/chromium, or set X_BROWSER=path with CHROMIUM_PATH.`, { code: 'BrowserNotFound' });
    }
  }
}
