'use strict';

/**
 * Safety tests for diskclean. Run: node test.js
 *
 * These assert that the validation gate refuses dangerous paths. Run this
 * after ANY change to safety.js. A failure here means the tool could delete
 * something it must never touch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./safety');

const HOME = os.homedir();
// realpath the tmp dir: on macOS os.tmpdir() sits under /var, which is a
// symlink to /private/var. The gate correctly refuses aliased paths, so the
// sandbox must use the already-resolved location.
const SANDBOX = path.join(
  fs.realpathSync(os.tmpdir()),
  `diskclean-test-${process.pid}`,
);

let failures = 0;
let passes = 0;

function check(desc, target, roots, shouldAllow) {
  const r = S.validateDeletion(target, roots);
  const got = r.ok ? 'ALLOW' : 'REJECT';
  const want = shouldAllow ? 'ALLOW' : 'REJECT';
  if (got !== want) {
    console.log(`FAIL  ${desc}\n      got ${got}, want ${want}` +
      (r.reason ? ` :: ${r.reason}` : ''));
    failures += 1;
  } else {
    console.log(`ok    ${desc}` + (r.reason ? ` (${r.reason})` : ''));
    passes += 1;
  }
}

function setup() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'proj', 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, 'precious'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, 'precious', 'data.txt'), 'important');
  try {
    fs.symlinkSync(
      path.join(SANDBOX, 'precious'),
      path.join(SANDBOX, 'proj', 'node_modules', 'link'),
    );
  } catch { /* symlink may fail on odd filesystems */ }
}

function teardown() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

setup();

console.log('\n== System and home locations must be refused ==');
for (const p of [
  '/', '/System', '/usr', '/bin', '/etc', '/var', '/Applications',
  '/Users', '/Volumes', '/private',
  HOME,
  path.join(HOME, 'Library'),
  path.join(HOME, 'Documents'),
  path.join(HOME, 'Desktop'),
  path.join(HOME, 'Downloads'),
  path.join(HOME, '.ssh'),
  path.join(HOME, '.gnupg'),
  path.join(HOME, '.gradle'),
  path.join(HOME, '.android'),
  path.join(HOME, 'Library', 'Keychains'),
  path.join(HOME, 'Library', 'Android', 'sdk'),
  path.join(HOME, 'Library', 'Developer'),
]) {
  check(`refuse ${p}`, p, ['/'], false);
}

console.log('\n== Project roots and rule containers must be refused ==');
for (const base of S.RULE_BASES) {
  check(`refuse container ${base}`, base, [base], false);
}

console.log('\n== Build caches every RN project depends on must be refused ==');
// These sit inside directories that rules DO enumerate (~/.gradle/caches,
// ~/Library/Caches), so a loosened childPattern could expose them. Pin them.
for (const [label, p, root] of [
  ['ccache store', path.join(HOME, 'Library', 'Caches', 'ccache'),
    path.join(HOME, 'Library', 'Caches')],
  ['gradle modules-2', path.join(HOME, '.gradle', 'caches', 'modules-2'),
    path.join(HOME, '.gradle', 'caches')],
  ['gradle build-cache-1', path.join(HOME, '.gradle', 'caches', 'build-cache-1'),
    path.join(HOME, '.gradle', 'caches')],
  ['gradle init scripts', path.join(HOME, '.gradle', 'init.d'),
    path.join(HOME, '.gradle')],
  ['ccache config', path.join(HOME, 'Library', 'Preferences', 'ccache'),
    path.join(HOME, 'Library', 'Preferences')],
]) {
  check(`refuse ${label}`, p, [root], false);
}
{
  const gradleRule = S.ABSOLUTE_RULES.find((r) => r.id === 'gradle_caches_version');
  for (const name of ['modules-2', 'build-cache-1']) {
    const offered = gradleRule.childPattern.test(name);
    if (offered) {
      console.log(`FAIL  gradle_caches_version offers ${name}`);
      failures += 1;
    } else {
      console.log(`ok    gradle_caches_version does not offer ${name}`);
      passes += 1;
    }
  }
}

{
  const codex = S.ABSOLUTE_RULES.find((r) => r.id === 'codex_generated_images');
  for (const [name, want] of [
    ['01a08085-2f30-7991-a774-a4112b13f071', true],
    ['sessions', false], ['..', false], ['thread_history_1.sqlite', false],
  ]) {
    const ok = codex.childPattern.test(name) === want;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  codex_generated_images ${want ? 'offers' : 'does not offer'} ${name}`);
    ok ? (passes += 1) : (failures += 1);
  }
}
check('refuse codex chat history', path.join(HOME, '.codex', 'sessions'),
  [path.join(HOME, '.codex')], false);

console.log('\n== Traversal, symlinks, and malformed input must be refused ==');
check('null byte', `${SANDBOX}/proj\0/node_modules`, [SANDBOX], false);
check('relative escape to home',
  path.join(HOME, 'Documents', 'Github', 'Shelfify', '..', '..', '..'), ['/'], false);
check('relative escape out of sandbox',
  path.join(SANDBOX, 'proj', 'node_modules', '..', '..', '..'), [SANDBOX], false);
check('symlink target', path.join(SANDBOX, 'proj', 'node_modules', 'link'),
  [SANDBOX], false);
check('outside the allowed root', path.join(SANDBOX, 'precious'),
  [path.join(SANDBOX, 'proj')], false);
check('nonexistent path', path.join(SANDBOX, 'nope-does-not-exist'),
  [SANDBOX], false);
check('.git segment',
  path.join(HOME, 'Documents', 'Github', 'Shelfify', '.git'),
  [path.join(HOME, 'Documents', 'Github')], false);
check('empty path', '', ['/'], false);

console.log('\n== Nested-cache rules must declare a depth the gate can enforce ==');
{
  // A rule listing grandchildren (e.g. LM Studio publisher/model) must not let
  // the base or an intermediate container become a delete target.
  const nested = S.ABSOLUTE_RULES.filter((r) => (r.childDepth || 1) > 1);
  for (const r of nested) {
    check(`refuse base of nested rule ${r.id}`, r.base, [r.base], false);
  }
  if (nested.length === 0) {
    console.log('ok    (no nested-depth rules defined)');
    passes += 1;
  }
}

console.log('\n== Legitimate targets must be allowed ==');
check('sandbox node_modules', path.join(SANDBOX, 'proj', 'node_modules'),
  [SANDBOX], true);

const gradleVersioned = path.join(HOME, '.gradle', 'caches', '9.3.1');
if (fs.existsSync(gradleVersioned)) {
  check('gradle version cache dir', gradleVersioned,
    [path.join(HOME, '.gradle', 'caches')], true);
}

const shelfifyNm = path.join(HOME, 'Documents', 'Github', 'Shelfify', 'node_modules');
if (fs.existsSync(shelfifyNm)) {
  check('real project node_modules', shelfifyNm,
    [path.join(HOME, 'Documents', 'Github')], true);
}

teardown();

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
