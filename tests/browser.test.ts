import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCandidates, resolveBrowserPlan, verifyBrowserPlan } from '../src/platforms/browser.js';
import { loadConfig } from '../src/config.js';

test('an explicit CHROMIUM_PATH overrides every other choice', () => {
  const plan = resolveBrowserPlan({ choice: 'chrome', executablePath: '/opt/br/chromium', exists: () => false });
  assert.equal(plan.executablePath, '/opt/br/chromium');
  assert.match(plan.description, /explicit executable/);
});

test('path choice without CHROMIUM_PATH is refused', () => {
  assert.throws(() => resolveBrowserPlan({ choice: 'path' }), /CHROMIUM_PATH/);
  assert.throws(() => loadConfig({ X_BROWSER: 'path', X_ENABLED: 'true', X_HANDLE: 'owner' }), /CHROMIUM_PATH/);
});

test('unknown choices are refused at both plan and config level', () => {
  assert.throws(() => resolveBrowserPlan({ choice: 'firefox' }), /Unknown browser choice/);
  assert.throws(() => loadConfig({ X_BROWSER: 'firefox', X_ENABLED: 'true', X_HANDLE: 'owner' }), /X_BROWSER must be one of/);
});

test('chrome preference detects system chrome before falling back to a channel', () => {
  // Detection uses platform-specific paths, so fake the install at a path that the
  // current platform's candidate list actually contains.
  const target = browserCandidates(process.platform).chrome[0]!;
  const detected = resolveBrowserPlan({ choice: 'chrome', exists: candidate => candidate === target });
  assert.equal(detected.executablePath, target);
  const absent = resolveBrowserPlan({ choice: 'chrome', exists: () => false });
  assert.equal(absent.channel, 'chrome');
  assert.equal(absent.executablePath, undefined);
});

test('edge preference detects edge, not chrome', () => {
  const target = browserCandidates(process.platform).msedge[0];
  if (!target) return; // platform without known Edge install paths
  const detected = resolveBrowserPlan({ choice: 'msedge', exists: candidate => candidate === target });
  assert.equal(detected.executablePath, target);
});

test('auto prefers chrome, then edge, then chromium', () => {
  const chrome = browserCandidates(process.platform).chrome[0]!;
  const edge = browserCandidates(process.platform).msedge[0];
  const chromium = browserCandidates(process.platform).chromium[0]!;
  assert.equal(resolveBrowserPlan({ choice: 'auto', exists: c => c === chrome }).executablePath, chrome);
  if (edge) {
    assert.equal(resolveBrowserPlan({ choice: 'auto', exists: c => c === edge }).executablePath, edge);
  }
  if (chromium) {
    assert.equal(resolveBrowserPlan({ choice: 'auto', exists: c => c === chromium }).executablePath, chromium);
  }
  const fallback = resolveBrowserPlan({ choice: 'auto', exists: () => false });
  assert.equal(fallback.channel, 'chrome');
  assert.equal(fallback.executablePath, undefined);
});

test('macOS detection uses the .app bundle paths', () => {
  const appPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const plan = resolveBrowserPlan({ choice: 'chrome', platform: 'darwin', exists: candidate => candidate === appPath });
  assert.equal(plan.executablePath, appPath);
  assert.deepEqual(browserCandidates('darwin').chrome[0], appPath);
});

test('verification catches missing executables and unusable channels', () => {
  const explicit = resolveBrowserPlan({ choice: 'chrome', executablePath: '/opt/br/chromium', exists: () => false });
  assert.doesNotThrow(() => verifyBrowserPlan(explicit, path => path === '/opt/br/chromium'));
  assert.throws(() => verifyBrowserPlan(explicit, () => false), /not found/);
  const channelOnly = resolveBrowserPlan({ choice: 'chrome', exists: () => false });
  assert.throws(() => verifyBrowserPlan(channelOnly, () => false, 'linux'), /No system browser was detected/);
  const chromePath = browserCandidates('linux').chrome[0]!;
  assert.doesNotThrow(() => verifyBrowserPlan(channelOnly, path => path === chromePath, 'linux'));
});
