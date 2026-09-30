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

/** Telegram backup against a fake worker: anything short of full acceptance must throw. */
async function telegramTests() {
  console.log('\n== Telegram backup uploads everything or throws ==');
  const TG = require('./telegram');
  const dir = path.join(SANDBOX, 'tg');
  fs.mkdirSync(dir);
  for (let i = 0; i < 23; i += 1) fs.writeFileSync(path.join(dir, `img${i}.png`), 'x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  const ok = (desc, cond) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${desc}`);
    cond ? (passes += 1) : (failures += 1);
  };
  const fake = (reply) => ({ calls: 0, async send(paths) { this.calls += 1; return reply(paths); } });
  const throws = async (worker) => {
    try { await TG.backupFolder(dir, '#t', { worker }); return false; } catch { return true; }
  };

  const sizesOf = (paths) => paths.map((p) => fs.statSync(p).size);
  const all = fake(sizesOf);
  const r = await TG.backupFolder(dir, '#t', { worker: all });
  ok('uploads all 23 files in 3 albums, skips .DS_Store', r.files.length === 23 && all.calls === 3);
  ok('a rejected album throws, so the folder is not deleted',
    await throws(fake(() => { throw new Error('bad'); })));
  ok('a partly accepted album throws', await throws(fake((p) => sizesOf(p).slice(1))));
  ok('a file stored with the wrong size throws',
    await throws(fake((p) => sizesOf(p).map((n, k) => (k === 0 ? n + 1 : n)))));
  ok('a worker reply without sizes throws', await throws(fake(() => undefined)));
  ok('albums never leave a lone file at the end',
    JSON.stringify(TG.chunk(Array(21).fill(0)).map((a) => a.length)) === '[10,9,2]');

  console.log('\n== After a backup, only the confirmed files are deleted ==');
  const late = path.join(dir, 'late.png');
  const up = await TG.backupFolder(dir, '#t', {
    worker: fake((p) => {
      if (!fs.existsSync(late)) fs.writeFileSync(late, 'new');
      return sizesOf(p);
    }),
  });
  ok('a file added during the upload is not in the delete list',
    !up.files.some((f) => f.path === late));

  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'deep.png'), 'x');
  const changed = up.files[0].path;
  fs.writeFileSync(changed, 'changed after upload');
  const outside = { path: path.join(SANDBOX, 'outside.png'), size: 1, mtimeMs: 0 };
  fs.writeFileSync(outside.path, 'x');
  outside.mtimeMs = fs.statSync(outside.path).mtimeMs;

  const r2 = await S.removeListedFiles(dir, [...up.files, outside], null);
  ok('uploaded, unchanged files are deleted', r2.deleted === up.files.length - 1 && r2.failed === 0);
  ok('a file changed after upload is kept', fs.existsSync(changed));
  ok('a file added during the upload is kept', fs.existsSync(late));
  ok('a listed file outside the folder is kept', fs.existsSync(outside.path) && r2.kept === 2);
  ok('the folder and its subfolders stay', fs.existsSync(path.join(dir, 'sub', 'deep.png')));

  const trashed = [];
  const r3 = await S.removeListedFiles(dir, await S.listFiles(dir), async (p) => { trashed.push(...p); });
  ok('trash mode hands files to the trash function and never unlinks',
    r3.deleted === trashed.length && fs.existsSync(late));
  const r4 = await S.removeListedFiles(dir, await S.listFiles(dir), async () => { throw new Error('no'); });
  ok('a failed trash call counts as failed, not deleted', r4.deleted === 0 && r4.failed > 0);
}

/** New cache rules: exact names only, app data stays out of reach. */
async function cacheRuleTests() {
  const ok = (desc, cond) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${desc}`);
    cond ? (passes += 1) : (failures += 1);
  };
  const rule = (id) => S.ABSOLUTE_RULES.find((r) => r.id === id);

  console.log('\n== New cache rules offer only cache folders ==');
  const cursor = rule('cursor_caches').childPattern;
  ok('cursor offers CachedData, Cache, logs',
    ['CachedData', 'Cache', 'logs', 'Code Cache'].every((n) => cursor.test(n)));
  ok('cursor never offers User, WebStorage, Partitions, CachedProfilesData',
    ['User', 'WebStorage', 'Partitions', 'CachedProfilesData', 'extensions'].every((n) => !cursor.test(n)));
  const chrome = rule('chrome_cache').childPattern;
  ok('chrome offers profile caches',
    ['Default', 'Profile 1', 'Profile 10'].every((n) => chrome.test(n)));
  ok('chrome never offers other names', ['Profile', 'Crashpad', '..'].every((n) => !chrome.test(n)));
  ok('maestro offers only run folders',
    rule('maestro_tests').childPattern.test('2026-09-16_200336')
    && !rule('maestro_tests').childPattern.test('config'));
  for (const p of [
    path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User'),
    path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
  ]) {
    const g = S.validateDeletion(p, [path.dirname(p)]);
    ok(`refuse app data ${p.replace(HOME, '~')}`, !g.ok);
  }
  ok('chrome and cursor rules require the app closed',
    rule('chrome_cache').requireAppClosed === 'Google Chrome'
    && rule('cursor_caches').requireAppClosed === 'Cursor');

  console.log('\n== Emptying a folder keeps the folder and never follows links ==');
  const base = path.join(SANDBOX, 'contents');
  fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(base, 'a.zip'), 'x');
  const target = path.join(SANDBOX, 'precious-target');
  fs.writeFileSync(target, 'keep me');
  fs.symlinkSync(target, path.join(base, 'link'));
  const c = await S.contentsToDelete(base, fs.readdirSync(base));
  ok('files and folders inside are listed',
    c.items.includes(path.join(base, 'a.zip')) && c.items.includes(path.join(base, 'sub')));
  ok('the base itself is never an item', !c.items.includes(base));
  ok('a symlink is listed as a link to unlink, not as an item to trash or rm',
    c.links.length === 1 && !c.items.some((p) => p.endsWith('link')));
  fs.unlinkSync(c.links[0]);
  ok('unlinking the link leaves its target intact', fs.readFileSync(target, 'utf8') === 'keep me');
  ok('a crafted ../ name is refused',
    (await S.contentsToDelete(base, ['../precious-target'])).items.length === 0);

  console.log('\n== Simulator test recordings: only the testmanagerd container ==');
  const dev = path.join(SANDBOX, 'sim-device');
  const daemons = path.join(dev, 'data', 'Containers', 'Data', 'InternalDaemon');
  const mkDaemon = (id, owner) => {
    fs.mkdirSync(path.join(daemons, id, 'tmp', 'Attachments'), { recursive: true });
    fs.writeFileSync(path.join(daemons, id, '.com.apple.mobile_container_manager.metadata.plist'),
      `bplist00MCMMetadataIdentifier_${owner}`);
  };
  ok('no InternalDaemon folder means no recordings', (await S.simRecordingsDir(dev)) === null);
  mkDaemon('AAA', 'com.apple.otherd');
  ok('another daemon\'s Attachments is never offered', (await S.simRecordingsDir(dev)) === null);
  mkDaemon('BBB', 'com.apple.testmanagerd');
  ok('the testmanagerd Attachments folder is found',
    (await S.simRecordingsDir(dev)) === path.join(daemons, 'BBB', 'tmp', 'Attachments'));
}

telegramTests().then(cacheRuleTests).then(() => {
  teardown();
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
});
