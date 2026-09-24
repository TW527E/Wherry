import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const entrypoint = '\nmain "$@"\n';
assert.ok(installer.endsWith(entrypoint), 'load definitions only; never run the real installer from tests');
const definitions = installer.slice(0, -entrypoint.length);
// Run the definitions plus the probe from a real script file: the installer reads ${BASH_SOURCE[0]}
// under `set -u`, which is unbound with `bash -c`, and a piped /dev/stdin cannot be reopened on some
// hosts. A file path satisfies both without running the real entrypoint.
const invoke = (source: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'wherry-deploy-'));
  try {
    const script = join(dir, 'probe.sh');
    writeFileSync(script, `${definitions}\n${source}`);
    return spawnSync('bash', [script], { encoding: 'utf8',
      env: { ...process.env, WHERRY_TEST_ROOT: fileURLToPath(new URL('../', import.meta.url)) } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('deployment uses shell fail-fast semantics and stops before later steps after failure', () => {
  const syntax = spawnSync('bash', ['-n'], { input: installer, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = invoke(`main() { false; printf 'UNREACHABLE'; }; main`);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /UNREACHABLE/);
});

test('deployment accepts nonnumeric build users and reuses its template for a custom service name', () => {
  const result = invoke(`
SOURCE_DIR="$WHERRY_TEST_ROOT"
parse_args install --build-user builder --service wherry-test
check_source
[[ "$BUILD_USER" == builder && "$UNIT_TEMPLATE" == "$SOURCE_DIR/deploy/crosspost-bridge.service" ]]
`);
  assert.equal(result.status, 0, result.stderr);
});

test('deployment dry-run copies prebuilt output only with no-build and excludes secret files in either mode', () => {
  for (const build of [0, 1]) {
    const result = invoke(`DRY_RUN=1; DO_BUILD=${build}; sync_source`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('--exclude=dist'), build === 1);
    assert.ok(result.stdout.includes('--exclude=.env.*'));
    assert.ok(result.stdout.includes('--exclude=*.session.json'));
    assert.ok(result.stdout.includes('install -m 0644'));
  }
});
