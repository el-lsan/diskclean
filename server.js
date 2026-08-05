'use strict';

/**
 * diskclean - local disk usage inspector and safe cache cleaner.
 *
 * Zero dependencies. Run: node server.js
 * Binds to 127.0.0.1 only.
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const S = require('./safety');
const AUTH = require('./auth');

const PORT = Number(process.env.DISKCLEAN_PORT || 4173);
const HOST = '127.0.0.1';
const ROOT_DIR = __dirname;

/* ------------------------------------------------------------------ utils */

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Directory size via `du -sk`. Much faster than walking in JS for large trees.
 * Uses execFile with an argument array, so the path is never shell-parsed.
 */
async function dirSize(p) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', p], {
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    });
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    const st = await fsp.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Limited-concurrency map, keeps `du` from spawning hundreds of processes. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length || 1))
    .fill(0)
    .map(async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------ app running */

/** Check whether a macOS app is currently running, by process name. */
async function isAppRunning(name) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', name], {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- scanning */

const PROJECT_MARKERS = ['package.json', 'pubspec.yaml', 'build.gradle', 'Podfile'];

async function looksLikeProject(dir) {
  for (const m of PROJECT_MARKERS) {
    if (await exists(path.join(dir, m))) return true;
  }
  // A dir containing android/ or ios/ is a mobile project.
  if ((await isDir(path.join(dir, 'android'))) || (await isDir(path.join(dir, 'ios')))) {
    return true;
  }
  return false;
}

/**
 * Detect projects under each root, recursing up to PROJECT_SCAN_DEPTH levels so
 * containers of projects (e.g. a folder of sites at <container>/<site>/website)
 * are covered. Never descends into artifact directories, so `.next/package.json`
 * or a package inside node_modules can never be mistaken for a project.
 *
 * Once a directory is identified as a project we still recurse into it, because
 * a repo can hold sub-projects (a website plus a backend). We just never treat
 * an artifact directory as one.
 */
async function findProjects() {
  const projects = [];
  const seen = new Set();

  async function walk(dir, root, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (await looksLikeProject(dir)) {
      const real = path.resolve(dir);
      if (!seen.has(real)) {
        seen.add(real);
        const rel = path.relative(root, real);
        projects.push({
          name: rel || path.basename(real),
          path: real,
          root,
        });
      }
    }

    if (depth <= 0) return;

    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (S.SCAN_SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      await walk(path.join(dir, e.name), root, depth - 1);
    }
  }

  for (const root of S.PROJECT_ROOTS) {
    if (!(await isDir(root))) continue;
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (S.SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(path.join(root, e.name), root, S.PROJECT_SCAN_DEPTH - 1);
    }
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

async function isGitignored(projectPath, relPath) {
  try {
    await execFileAsync('git', ['-C', projectPath, 'check-ignore', '-q', relPath], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Build the deletable-artifact list for one project. */
async function scanProject(project) {
  const items = [];
  for (const rule of S.PROJECT_RULES) {
    const target = path.join(project.path, rule.rel);
    if (!(await isDir(target))) continue;

    if (rule.requireGitignored) {
      const ignored = await isGitignored(project.path, rule.rel);
      if (!ignored) continue; // committed build dir, leave it alone
    }

    const size = await dirSize(target);
    if (size <= 0) continue;
    items.push({
      ruleId: rule.id,
      label: rule.label,
      path: target,
      size,
      sizeHuman: humanBytes(size),
      regen: rule.regen,
      safe: rule.safe,
    });
  }
  const total = items.reduce((a, b) => a + b.size, 0);
  return {
    name: project.name,
    path: project.path,
    items,
    total,
    totalHuman: humanBytes(total),
  };
}

async function scanProjects() {
  const projects = await findProjects();
  const scanned = await mapLimit(projects, 4, scanProject);
  const withItems = scanned.filter((p) => p.items.length > 0);

  /*
   * Drop artifact paths already covered by an ancestor project's artifact.
   * Example: `Shelfify/android/app` matches the `build` rule, but that same
   * directory is inside `Shelfify`'s `android/app/build` artifact. Counting
   * both would double the reported size and list one directory twice.
   */
  /*
   * Claim each artifact path for exactly one project: the shallowest one, which
   * is the repo a person thinks of as "the project". `Shelfify/android/app` also
   * matches the `build` rule at the very same path as `Shelfify`'s
   * `android/app/build`, so equality has to be resolved, not just containment.
   */
  const owner = new Map(); // artifact path -> owning project path
  for (const p of withItems) {
    for (const it of p.items) {
      const cur = owner.get(it.path);
      if (cur === undefined || p.path.length < cur.length) {
        owner.set(it.path, p.path);
      }
    }
  }

  const allPaths = [...owner.keys()];

  for (const p of withItems) {
    p.items = p.items.filter((it) => {
      // Someone else owns this exact path.
      if (owner.get(it.path) !== p.path) return false;
      // Already covered by a broader artifact elsewhere.
      return !allPaths.some(
        (other) => other !== it.path && S.isInside(other, it.path),
      );
    });
    p.total = p.items.reduce((a, b) => a + b.size, 0);
    p.totalHuman = humanBytes(p.total);
  }

  return withItems
    .filter((p) => p.items.length > 0)
    .sort((a, b) => b.total - a.total);
}

/** Scan the absolute cache rules. */
async function scanCaches() {
  const groups = await mapLimit(S.ABSOLUTE_RULES, 4, async (rule) => {
    if (!(await isDir(rule.base))) return null;

    const entries = [];
    if (rule.children) {
      let children;
      try {
        children = await fsp.readdir(rule.base, { withFileTypes: true });
      } catch {
        return null;
      }
      const eligible = children.filter(
        (c) =>
          c.isDirectory() &&
          !c.isSymbolicLink() &&
          (!rule.childPattern || rule.childPattern.test(c.name)),
      );
      const sized = await mapLimit(eligible, 6, async (c) => {
        const p = path.join(rule.base, c.name);
        const size = await dirSize(p);
        return { name: c.name, path: p, size, sizeHuman: humanBytes(size) };
      });
      entries.push(...sized.filter((s) => s.size > 0).sort((a, b) => b.size - a.size));
    } else {
      const size = await dirSize(rule.base);
      if (size > 0) {
        entries.push({
          name: path.basename(rule.base),
          path: rule.base,
          size,
          sizeHuman: humanBytes(size),
        });
      }
    }

    if (entries.length === 0) return null;

    let blocked = null;
    if (rule.requireAppClosed && (await isAppRunning(rule.requireAppClosed))) {
      blocked = `${rule.requireAppClosed} is running. Quit it before clearing.`;
    }

    const total = entries.reduce((a, b) => a + b.size, 0);
    return {
      ruleId: rule.id,
      label: rule.label,
      base: rule.base,
      // A rule with children:false deletes the base dir's *contents*.
      deletesContents: !rule.children,
      regen: rule.regen,
      safe: rule.safe,
      note: rule.note || null,
      blocked,
      entries,
      total,
      totalHuman: humanBytes(total),
    };
  });
  return groups.filter(Boolean).sort((a, b) => b.total - a.total);
}

/** Report-only sections. */
async function scanReportOnly() {
  const out = [];
  for (const r of S.REPORT_ONLY) {
    if (!(await isDir(r.base))) continue;
    const size = await dirSize(r.base);
    out.push({
      id: r.id,
      label: r.label,
      base: r.base,
      size,
      sizeHuman: humanBytes(size),
      reason: r.reason,
    });
  }
  return out.sort((a, b) => b.size - a.size);
}

/* ------------------------------------------------------------- simulators */

async function listSimulators() {
  const devicesRoot = path.join(
    S.HOME,
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
  );
  let parsed;
  try {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'list', 'devices', '--json'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
    );
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, devices: [], unavailableCount: 0 };
  }

  const flat = [];
  for (const [runtime, list] of Object.entries(parsed.devices || {})) {
    for (const d of list) {
      flat.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        available: d.isAvailable !== false,
        runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', ''),
      });
    }
  }

  const sized = await mapLimit(flat, 6, async (d) => {
    const p = path.join(devicesRoot, d.udid);
    const size = (await isDir(p)) ? await dirSize(p) : 0;
    return { ...d, path: p, size, sizeHuman: humanBytes(size) };
  });

  sized.sort((a, b) => b.size - a.size);
  return {
    available: true,
    devices: sized,
    unavailableCount: sized.filter((d) => !d.available).length,
    total: sized.reduce((a, b) => a + b.size, 0),
    totalHuman: humanBytes(sized.reduce((a, b) => a + b.size, 0)),
  };
}

/* --------------------------------------------------------------- emulators */

async function listEmulators() {
  const avdRoot = path.join(S.HOME, '.android', 'avd');
  if (!(await isDir(avdRoot))) return { available: false, avds: [] };

  let entries;
  try {
    entries = await fsp.readdir(avdRoot, { withFileTypes: true });
  } catch {
    return { available: false, avds: [] };
  }

  const avdDirs = entries.filter((e) => e.isDirectory() && e.name.endsWith('.avd'));
  const sized = await mapLimit(avdDirs, 4, async (e) => {
    const p = path.join(avdRoot, e.name);
    const size = await dirSize(p);
    const name = e.name.replace(/\.avd$/, '');

    // Size of the wipeable user data within the AVD.
    const wipeable = [];
    for (const f of [
      'userdata-qemu.img',
      'userdata-qemu.img.qcow2',
      'userdata.img',
      'sdcard.img.qcow2',
      'cache.img',
      'cache.img.qcow2',
      'snapshots',
    ]) {
      const fp = path.join(p, f);
      try {
        const st = await fsp.lstat(fp);
        const sz = st.isDirectory() ? await dirSize(fp) : st.size;
        if (sz > 0) wipeable.push({ name: f, size: sz, sizeHuman: humanBytes(sz) });
      } catch {
        /* not present */
      }
    }
    const wipeableTotal = wipeable.reduce((a, b) => a + b.size, 0);

    return {
      name,
      path: p,
      size,
      sizeHuman: humanBytes(size),
      wipeable,
      wipeableTotal,
      wipeableHuman: humanBytes(wipeableTotal),
    };
  });

  sized.sort((a, b) => b.size - a.size);
  const running = await isAppRunning('qemu-system-aarch64').catch(() => false);
  return {
    available: true,
    avds: sized,
    running,
    total: sized.reduce((a, b) => a + b.size, 0),
    totalHuman: humanBytes(sized.reduce((a, b) => a + b.size, 0)),
  };
}

/* ------------------------------------------------------------ disk status */

async function diskStatus() {
  try {
    const { stdout } = await execFileAsync('df', ['-k', '/System/Volumes/Data'], {
      timeout: 10000,
    });
    const line = stdout.trim().split('\n')[1] || '';
    const parts = line.split(/\s+/);
    const totalK = parseInt(parts[1], 10);
    const usedK = parseInt(parts[2], 10);
    const availK = parseInt(parts[3], 10);
    return {
      total: totalK * 1024,
      used: usedK * 1024,
      avail: availK * 1024,
      totalHuman: humanBytes(totalK * 1024),
      usedHuman: humanBytes(usedK * 1024),
      availHuman: humanBytes(availK * 1024),
      percent: Math.round((usedK / totalK) * 100),
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- deletion */

/**
 * Move a path to the macOS Trash via Finder. Recoverable.
 * Uses osascript with the POSIX path passed as a quoted AppleScript string;
 * we validate the path first and reject quotes/backslashes defensively.
 */
async function trashPath(p) {
  if (/["\\]/.test(p)) {
    throw new Error('Refusing to trash a path containing quotes or backslashes.');
  }
  const script = `tell application "Finder" to delete POSIX file "${p}"`;
  await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
}

/** Resolve the allowed roots for a given rule id. */
function allowedRootsForRule(ruleId, kind) {
  if (kind === 'project') {
    const rule = S.PROJECT_RULES.find((r) => r.id === ruleId);
    if (!rule) return null;
    return S.PROJECT_ROOTS;
  }
  if (kind === 'cache') {
    const rule = S.ABSOLUTE_RULES.find((r) => r.id === ruleId);
    if (!rule) return null;
    return [rule.base];
  }
  return null;
}

/**
 * Verify that a project target really is the exact path the rule describes,
 * inside a real detected project. Prevents a crafted path from matching only
 * the coarse containment test.
 */
async function verifyProjectTarget(ruleId, targetPath) {
  const rule = S.PROJECT_RULES.find((r) => r.id === ruleId);
  if (!rule) return 'Unknown rule.';
  const abs = path.resolve(targetPath);
  const projects = await findProjects();

  // Defense in depth: a project root is never a delete target, even if some
  // rule were mis-specified as '.' or ''.
  if (projects.some((p) => p.path === abs)) {
    return 'Refusing to delete a project root directory.';
  }

  // The target must be exactly <project>/<rule.rel> for a detected project.
  const match = projects.find((p) => path.join(p.path, rule.rel) === abs);
  if (!match) {
    return 'Target is not a known artifact directory of a detected project.';
  }

  // The relative path must be non-trivial and must not escape the project.
  const rel = path.relative(match.path, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return 'Target does not resolve to a path inside the project.';
  }

  // Re-check gitignore at delete time, not only at scan time, so a crafted
  // request cannot delete a `build` directory whose contents are committed.
  if (rule.requireGitignored && !(await isGitignored(match.path, rule.rel))) {
    return `${rule.rel} is not gitignored in this project; refusing to delete it.`;
  }
  return null;
}

async function verifyCacheTarget(ruleId, targetPath) {
  const rule = S.ABSOLUTE_RULES.find((r) => r.id === ruleId);
  if (!rule) return 'Unknown rule.';
  const abs = path.resolve(targetPath);

  if (!rule.children) {
    // Deleting contents of the base: the target must be a direct child.
    if (path.dirname(abs) !== rule.base) {
      return 'Target is not a direct child of the cache directory.';
    }
    return null;
  }

  if (path.dirname(abs) !== rule.base) {
    return 'Target is not a direct child of the cache directory.';
  }
  if (rule.childPattern && !rule.childPattern.test(path.basename(abs))) {
    return `Target name does not match the allowed pattern for ${rule.label}.`;
  }
  if (rule.requireAppClosed && (await isAppRunning(rule.requireAppClosed))) {
    return `${rule.requireAppClosed} is running. Quit it first.`;
  }
  return null;
}

/**
 * Perform one deletion request. Always validated, never shelled out with
 * an interpolated path.
 */
async function performDelete({ kind, ruleId, targetPath, useTrash }) {
  const roots = allowedRootsForRule(ruleId, kind);
  if (!roots) return { path: targetPath, ok: false, error: 'Unknown rule id.' };

  const gate = S.validateDeletion(targetPath, roots);
  if (!gate.ok) return { path: targetPath, ok: false, error: gate.reason };

  const specific =
    kind === 'project'
      ? await verifyProjectTarget(ruleId, gate.resolved)
      : await verifyCacheTarget(ruleId, gate.resolved);
  if (specific) return { path: targetPath, ok: false, error: specific };

  const size = await dirSize(gate.resolved);

  try {
    if (useTrash) {
      await trashPath(gate.resolved);
    } else {
      await fsp.rm(gate.resolved, { recursive: true, force: false, maxRetries: 2 });
    }
  } catch (err) {
    return { path: gate.resolved, ok: false, error: String(err.message || err) };
  }

  return { path: gate.resolved, ok: true, freed: size, freedHuman: humanBytes(size) };
}

/** Delete a simulator through simctl (never by removing files directly). */
async function deleteSimulator(udid) {
  if (!/^[0-9A-Fa-f-]{36}$/.test(udid)) {
    return { udid, ok: false, error: 'Invalid UDID format.' };
  }
  const p = path.join(
    S.HOME,
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    udid,
  );
  const size = (await isDir(p)) ? await dirSize(p) : 0;
  try {
    await execFileAsync('xcrun', ['simctl', 'delete', udid], { timeout: 120000 });
  } catch (err) {
    return { udid, ok: false, error: String(err.stderr || err.message || err) };
  }
  return { udid, ok: true, freed: size, freedHuman: humanBytes(size) };
}

async function deleteUnavailableSimulators() {
  const before = await listSimulators();
  const unavailable = before.devices.filter((d) => !d.available);
  const freed = unavailable.reduce((a, b) => a + b.size, 0);
  try {
    await execFileAsync('xcrun', ['simctl', 'delete', 'unavailable'], {
      timeout: 300000,
    });
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message || err) };
  }
  return {
    ok: true,
    count: unavailable.length,
    freed,
    freedHuman: humanBytes(freed),
  };
}

/** Wipe an AVD's user data files (keeps the AVD definition). */
async function wipeEmulator(avdName) {
  if (!/^[A-Za-z0-9._-]+$/.test(avdName)) {
    return { name: avdName, ok: false, error: 'Invalid AVD name.' };
  }
  if (await isAppRunning('qemu-system-aarch64')) {
    return { name: avdName, ok: false, error: 'An emulator is running. Close it first.' };
  }
  const dir = path.join(S.HOME, '.android', 'avd', `${avdName}.avd`);
  if (!(await isDir(dir))) {
    return { name: avdName, ok: false, error: 'AVD directory not found.' };
  }

  const gate = S.validateDeletion(dir, [path.join(S.HOME, '.android', 'avd')]);
  if (!gate.ok) return { name: avdName, ok: false, error: gate.reason };

  const targets = [
    'userdata-qemu.img',
    'userdata-qemu.img.qcow2',
    'sdcard.img.qcow2',
    'cache.img',
    'cache.img.qcow2',
    'snapshots',
  ];
  let freed = 0;
  const errors = [];
  for (const t of targets) {
    const fp = path.join(gate.resolved, t);
    try {
      const st = await fsp.lstat(fp);
      if (st.isSymbolicLink()) continue;
      const sz = st.isDirectory() ? await dirSize(fp) : st.size;
      await fsp.rm(fp, { recursive: true, force: false });
      freed += sz;
    } catch (err) {
      if (err && err.code !== 'ENOENT') errors.push(`${t}: ${err.code || err.message}`);
    }
  }
  return {
    name: avdName,
    ok: errors.length === 0,
    freed,
    freedHuman: humanBytes(freed),
    errors,
  };
}

/* ------------------------------------------------------------------ server */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Per-run secret. The page is served with it embedded; API calls must echo it.
 * Stops any other local process or a random web page in your browser from
 * driving this API (they can reach 127.0.0.1 but cannot read this token).
 */
const SESSION_TOKEN = require('crypto').randomBytes(32).toString('hex');

/** Set once the listener binds; may differ from PORT if that was taken. */
let ACTIVE_PORT = PORT;

/** Mutating routes: require the session token AND a live admin authorization. */
const MUTATING = new Set([
  '/api/delete',
  '/api/simulator/delete',
  '/api/emulator/wipe',
]);

const server = http.createServer(async (req, res) => {
  // Only accept local requests.
  const remote = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    res.writeHead(403).end('Local requests only');
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${ACTIVE_PORT}`);
  const route = url.pathname;

  // Block cross-origin drive-by requests from other pages in the browser.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${ACTIVE_PORT}`) {
    res.writeHead(403).end('Bad origin');
    return;
  }

  // Every API route except the page itself requires the session token.
  if (route.startsWith('/api/')) {
    const tok = req.headers['x-diskclean-token'];
    if (tok !== SESSION_TOKEN) {
      sendJson(res, 403, { error: 'Invalid or missing session token.' });
      return;
    }
  }

  // Destructive routes require a live OS-verified authorization.
  if (MUTATING.has(route) && !AUTH.isAuthorized()) {
    sendJson(res, 401, {
      error: 'Not authorized. Authenticate first.',
      needsAuth: true,
    });
    return;
  }

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      let html = await fsp.readFile(path.join(ROOT_DIR, 'index.html'), 'utf8');
      html = html.replace('__DISKCLEAN_TOKEN__', SESSION_TOKEN);
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return;
    }

    if (req.method === 'GET' && route === '/api/auth/status') {
      sendJson(res, 200, {
        authorized: AUTH.isAuthorized(),
        remainingMs: AUTH.remainingMs(),
        graceMs: AUTH.GRACE_MS,
      });
      return;
    }

    if (req.method === 'POST' && route === '/api/auth') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const reason = String(body.reason || 'delete cache files');
      const result = await AUTH.authenticate(reason);
      sendJson(res, result.ok ? 200 : 401, {
        ...result,
        remainingMs: AUTH.remainingMs(),
      });
      return;
    }

    if (req.method === 'POST' && route === '/api/auth/revoke') {
      AUTH.revoke();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && route === '/api/scan') {
      const [disk, projects, caches, reportOnly, sims, emus] = await Promise.all([
        diskStatus(),
        scanProjects(),
        scanCaches(),
        scanReportOnly(),
        listSimulators(),
        listEmulators(),
      ]);
      sendJson(res, 200, {
        disk,
        projects,
        caches,
        reportOnly,
        simulators: sims,
        emulators: emus,
        scannedAt: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'POST' && route === '/api/delete') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const targets = Array.isArray(body.targets) ? body.targets : [];
      const useTrash = body.useTrash !== false; // default: Trash
      if (targets.length === 0) {
        sendJson(res, 400, { error: 'No targets provided.' });
        return;
      }
      if (targets.length > 500) {
        sendJson(res, 400, { error: 'Too many targets in one request.' });
        return;
      }
      const results = [];
      for (const t of targets) {
        results.push(
          await performDelete({
            kind: t.kind,
            ruleId: t.ruleId,
            targetPath: t.path,
            useTrash,
          }),
        );
      }
      const freed = results.filter((r) => r.ok).reduce((a, b) => a + (b.freed || 0), 0);
      sendJson(res, 200, {
        results,
        freed,
        freedHuman: humanBytes(freed),
        okCount: results.filter((r) => r.ok).length,
        failCount: results.filter((r) => !r.ok).length,
        // Trashed data still occupies the disk until the Trash is emptied.
        inTrash: useTrash,
      });
      return;
    }

    if (req.method === 'POST' && route === '/api/simulator/delete') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.unavailableOnly) {
        sendJson(res, 200, await deleteUnavailableSimulators());
        return;
      }
      const udids = Array.isArray(body.udids) ? body.udids : [];
      const results = [];
      for (const u of udids) results.push(await deleteSimulator(u));
      const freed = results.filter((r) => r.ok).reduce((a, b) => a + (b.freed || 0), 0);
      sendJson(res, 200, { results, freed, freedHuman: humanBytes(freed) });
      return;
    }

    if (req.method === 'POST' && route === '/api/emulator/wipe') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const names = Array.isArray(body.names) ? body.names : [];
      const results = [];
      for (const n of names) results.push(await wipeEmulator(n));
      const freed = results.filter((r) => r.ok).reduce((a, b) => a + (b.freed || 0), 0);
      sendJson(res, 200, { results, freed, freedHuman: humanBytes(freed) });
      return;
    }

    if (req.method === 'POST' && route === '/api/reveal') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const p = path.resolve(String(body.path || ''));
      if (!(await exists(p))) {
        sendJson(res, 400, { error: 'Path not found.' });
        return;
      }
      await execFileAsync('open', ['-R', p], { timeout: 10000 }).catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

function start(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      start(port + 1, attemptsLeft - 1);
      return;
    }
    process.stderr.write(`\n  Could not start diskclean: ${err.message}\n\n`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    ACTIVE_PORT = port;
    const url = `http://${HOST}:${port}`;
    process.stdout.write(`\n  diskclean running at ${url}\n`);
    process.stdout.write('  Deletions require your macOS password.\n');
    process.stdout.write('  Press Ctrl+C to stop.\n\n');
    execFile('open', [url], () => {});
  });
}

start(PORT, 20);

process.on('SIGINT', () => {
  process.stdout.write('\n  Stopped.\n');
  process.exit(0);
});
