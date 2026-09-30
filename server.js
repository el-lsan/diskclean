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
const TG = require('./telegram');

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

/**
 * Size cache, keyed by directory path.
 *
 * `du` cost tracks FILE COUNT, not bytes. Measured here: the 31GB Hugging Face
 * cache holds 66 files and sizes in 0.01s, while ~/.cache/uv holds 811,029 files
 * and takes 15.5s. So a few package caches dominate every scan.
 *
 * A directory's mtime changes when entries are added or removed directly inside
 * it, which is enough to catch "a new model appeared" or "a version dir was
 * deleted". It does NOT catch a file growing deeper inside the tree, so entries
 * expire on a TTL as well, and a rescan can be forced.
 */
const sizeCache = new Map(); // path -> { mtimeMs, at, sizes: Map }
const SIZE_TTL_MS = 10 * 60 * 1000;

async function dirMtime(p) {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Cached wrapper around childSizes(). */
async function childSizesCached(base, { force = false } = {}) {
  const mtimeMs = await dirMtime(base);
  const hit = sizeCache.get(base);
  if (
    !force &&
    hit &&
    hit.mtimeMs === mtimeMs &&
    Date.now() - hit.at < SIZE_TTL_MS
  ) {
    return hit.sizes;
  }
  const sizes = await childSizes(base);
  sizeCache.set(base, { mtimeMs, at: Date.now(), sizes });
  return sizes;
}

/**
 * Sizes for every direct child of `base` in ONE `du` pass.
 *
 * Measured on this machine against ~/.gradle/caches: one `du -d 1` took 3.08s
 * where 14 parallel `du -sk` calls took 5.00s. du walks the tree once and emits
 * every subtotal, so the per-child calls were re-walking shared work and paying
 * process spawn cost each time.
 *
 * Returns a Map of absolute child path -> bytes. Parsing is tab/space tolerant
 * and keeps only direct children, since `du` also prints the base itself.
 */
async function childSizes(base) {
  const out = new Map();
  try {
    const { stdout } = await execFileAsync('du', ['-k', '-d', '1', base], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300000,
    });
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const kb = parseInt(tab > 0 ? line.slice(0, tab) : line, 10);
      const p = (tab > 0 ? line.slice(tab + 1) : '').trim();
      if (!Number.isFinite(kb) || !p) continue;
      if (p === base) continue; // du prints the total for base too
      if (path.dirname(p) !== base) continue; // only direct children
      out.set(p, kb * 1024);
    }
  } catch {
    /* fall back to per-path du at the call site */
  }
  return out;
}

/**
 * Sizes for an arbitrary list of paths, batched into as few `du` calls as
 * possible. `du -sk a b c` walks each argument once and prints one line each,
 * which avoids paying process startup per path.
 */
async function sizesForPaths(paths, batchSize = 24) {
  const result = new Map();
  const batches = [];
  for (let i = 0; i < paths.length; i += batchSize) {
    batches.push(paths.slice(i, i + batchSize));
  }

  await mapLimit(batches, 4, async (batch) => {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', ...batch], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 300000,
      });
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        const kb = parseInt(tab > 0 ? line.slice(0, tab) : line, 10);
        const p = (tab > 0 ? line.slice(tab + 1) : '').trim();
        if (Number.isFinite(kb) && p) result.set(p, kb * 1024);
      }
    } catch {
      // A batch can fail if one path vanished mid-scan. Fall back per path so
      // one missing directory does not zero out the whole batch.
      for (const p of batch) result.set(p, await dirSize(p));
    }
  });

  // Any path du did not report (removed during the scan) counts as zero.
  for (const p of paths) if (!result.has(p)) result.set(p, 0);
  return result;
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

/* --------------------------------------------------------- capabilities */

const IS_MAC = process.platform === 'darwin';

/**
 * Cache of "is this command available", so we probe once per run.
 * A machine without Xcode has no `xcrun`; a fresh machine may have no `git`.
 * Every optional feature checks here instead of failing at call time.
 */
const binCache = new Map();

async function hasCommand(name) {
  if (binCache.has(name)) return binCache.get(name);
  let ok = false;
  try {
    await execFileAsync('which', [name], { timeout: 5000 });
    ok = true;
  } catch {
    ok = false;
  }
  binCache.set(name, ok);
  return ok;
}

/** Open a URL in the default browser, per platform. Never fatal. */
function openInBrowser(url) {
  const cmd = IS_MAC ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  try {
    execFile(cmd, args, () => {});
  } catch {
    /* the URL is printed either way */
  }
}

/* ------------------------------------------------------------ app running */

/**
 * Check whether an app is currently running, by process name.
 * Returns false when pgrep is unavailable, which only means we cannot prove an
 * app is running. Rules that require an app to be closed stay conservative by
 * being skipped entirely on such a machine (see scanCaches).
 */
async function isAppRunning(name) {
  if (!(await hasCommand('pgrep'))) return false;
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

const PROJECT_MARKERS = new Set([
  'package.json',
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'Podfile',
  'Cargo.toml',
  'go.mod',
]);

/** Subdirectories that mark a mobile project even without a manifest file. */
const PROJECT_DIR_MARKERS = new Set(['android', 'ios']);

/**
 * Decide from an already-read directory listing whether this is a project.
 *
 * Takes the Dirent[] we already have rather than issuing fresh access() calls.
 * The previous version cost up to 6 extra syscalls per directory, which across
 * ~98k directories was ~390k syscalls and most of the scan's wall time.
 */
function looksLikeProjectFrom(entries) {
  for (const e of entries) {
    if (e.isFile() || e.isSymbolicLink()) {
      if (PROJECT_MARKERS.has(e.name)) return true;
    } else if (e.isDirectory() && PROJECT_DIR_MARKERS.has(e.name)) {
      return true;
    }
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
/**
 * Breadth-first, level-parallel project discovery.
 *
 * Two things make this fast:
 *  - each directory is classified from its own readdir result, no extra stat calls
 *  - each level's readdir calls run concurrently instead of one at a time
 *
 * Pruning matters as much as parallelism. A directory that shows no sign of
 * being code (no manifest, no recognized project subdirectory) and sits at a
 * level where projects have already been found is not descended into. Without
 * this, one asset folder of downloaded icons cost ~193k directory entries and
 * dominated the whole scan.
 */
async function findProjects() {
  const projects = [];
  const seen = new Set();

  /** Directory names that never contain code projects. */
  const ASSET_HINTS = new Set([
    'downloads', 'assets', 'images', 'img', 'icons', 'fonts', 'media',
    'screenshots', 'videos', 'photos', 'svg', 'png', 'exports', 'archive',
    'archives', 'backup', 'backups', 'data', 'datasets', 'samples',
  ]);

  // Level 1: the immediate children of each root.
  let frontier = [];
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
      frontier.push({ dir: path.join(root, e.name), root });
    }
  }

  for (let depth = 0; depth < S.PROJECT_SCAN_DEPTH && frontier.length; depth += 1) {
    // Read this whole level concurrently. readdir is I/O bound, so overlapping
    // it is where the win is; a modest cap keeps us from exhausting fds.
    const listings = await mapLimit(frontier, 32, async (node) => {
      try {
        return {
          ...node,
          entries: await fsp.readdir(node.dir, { withFileTypes: true }),
        };
      } catch {
        return null;
      }
    });

    const next = [];
    for (const node of listings) {
      if (!node) continue;

      const isProject = looksLikeProjectFrom(node.entries);
      if (isProject) {
        const real = path.resolve(node.dir);
        if (!seen.has(real)) {
          seen.add(real);
          const rel = path.relative(node.root, real);
          projects.push({
            name: rel || path.basename(real),
            path: real,
            root: node.root,
          });
        }
      }

      if (depth + 1 >= S.PROJECT_SCAN_DEPTH) continue;

      // Prune: don't descend into obvious asset dumps. A project directory is
      // still descended into, because a repo can hold sub-projects.
      const base = path.basename(node.dir).toLowerCase();
      if (!isProject && ASSET_HINTS.has(base)) continue;

      for (const e of node.entries) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (S.SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (ASSET_HINTS.has(e.name.toLowerCase())) continue;
        next.push({ dir: path.join(node.dir, e.name), root: node.root });
      }
    }
    frontier = next;
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

/**
 * Is relPath gitignored in this project?
 *
 * Returns false when git is unavailable or the directory is not a repo, which is
 * the safe direction: a rule that requires the path to be ignored is then simply
 * not offered, rather than being offered without the check having run.
 */
async function isGitignored(projectPath, relPath) {
  if (!(await hasCommand('git'))) return false;
  try {
    await execFileAsync('git', ['-C', projectPath, 'check-ignore', '-q', relPath], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find which artifact directories exist for one project, without sizing them.
 * Sizing happens once for every project at the end, so `du` runs in a few
 * batched calls instead of one call per artifact.
 */
async function findProjectArtifacts(project) {
  const candidates = await Promise.all(
    S.PROJECT_RULES.map(async (rule) => {
      const target = path.join(project.path, rule.rel);
      if (!(await isDir(target))) return null;
      if (rule.requireGitignored && !(await isGitignored(project.path, rule.rel))) {
        return null; // committed build dir, leave it alone
      }
      return {
        ruleId: rule.id,
        label: rule.label,
        path: target,
        regen: rule.regen,
        safe: rule.safe,
      };
    }),
  );
  return {
    name: project.name,
    path: project.path,
    items: candidates.filter(Boolean),
  };
}

async function scanProjects() {
  const projects = await findProjects();
  const found = await mapLimit(projects, 16, findProjectArtifacts);
  const withItems = found.filter((p) => p.items.length > 0);

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
  }

  // Size everything that survived, in a handful of batched du calls. Doing this
  // after dedup means we never pay to measure a path we then discard.
  const survivors = [];
  for (const p of withItems) for (const it of p.items) survivors.push(it.path);
  const sizes = await sizesForPaths(survivors);

  for (const p of withItems) {
    for (const it of p.items) {
      it.size = sizes.get(it.path) || 0;
      it.sizeHuman = humanBytes(it.size);
    }
    // Drop empty artifact dirs, they are noise.
    p.items = p.items.filter((it) => it.size > 0);
    p.total = p.items.reduce((a, b) => a + b.size, 0);
    p.totalHuman = humanBytes(p.total);
  }

  return withItems
    .filter((p) => p.items.length > 0)
    .sort((a, b) => b.total - a.total);
}

/** Scan the absolute cache rules. */
async function scanCaches({ force = false } = {}) {
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

      /*
       * Some caches nest one level deeper than the useful unit. LM Studio groups
       * models under a publisher directory, so listing publishers would force an
       * all-or-nothing choice across every model by that publisher. childDepth
       * lets a rule list grandchildren instead.
       */
      const depth = rule.childDepth || 1;
      let targets = eligible.map((c) => path.join(rule.base, c.name));

      if (depth > 1) {
        const deeper = [];
        for (const parent of targets) {
          let sub;
          try {
            sub = await fsp.readdir(parent, { withFileTypes: true });
          } catch {
            continue;
          }
          const kids = sub.filter((c) => c.isDirectory() && !c.isSymbolicLink());
          // A parent with no subdirectories is itself the unit.
          if (kids.length === 0) deeper.push(parent);
          else for (const k of kids) deeper.push(path.join(parent, k.name));
        }
        targets = deeper;
      }

      // One du pass per parent directory, then look each target up.
      const all = await childSizesCached(rule.base, { force });
      const sized = await Promise.all(
        targets.map(async (p) => {
          const size = all.has(p) ? all.get(p) : await dirSize(p);
          // Show the path relative to the base, so a nested model reads as
          // "publisher/model" rather than losing its context.
          const name = path.relative(rule.base, p);
          return { name, path: p, size, sizeHuman: humanBytes(size) };
        }),
      );
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
    if (rule.requireAppClosed) {
      if (!(await hasCommand('pgrep'))) {
        // We cannot prove the app is closed, so do not offer the deletion.
        blocked =
          `Cannot check whether ${rule.requireAppClosed} is running on this `
          + 'machine (pgrep not available), so this is left alone.';
      } else if (await isAppRunning(rule.requireAppClosed)) {
        blocked = `${rule.requireAppClosed} is running. Quit it before clearing.`;
      }
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
      // Offered only for rules that opt in and when a bot is configured.
      backup: rule.backup && TG.loadConfig() ? { tags: rule.backup.tags } : null,
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

async function listSimulators({ force = false } = {}) {
  const devicesRoot = path.join(
    S.HOME,
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
  );
  // No Xcode (or not macOS) means no simulators. Not an error.
  if (!IS_MAC || !(await hasCommand('xcrun'))) {
    return { available: false, devices: [], unavailableCount: 0, total: 0 };
  }

  let parsed;
  try {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'list', 'devices', '--json'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 30000 },
    );
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, devices: [], unavailableCount: 0, total: 0 };
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

  // One du pass covers every simulator directory. Measured at 6.57s for all 33
  // devices, versus ~2.9s per device individually.
  const all = await childSizesCached(devicesRoot, { force });
  const sized = flat.map((d) => {
    const p = path.join(devicesRoot, d.udid);
    const size = all.get(p) || 0;
    return { ...d, path: p, size, sizeHuman: humanBytes(size) };
  });

  sized.sort((a, b) => b.size - a.size);
  return {
    available: true,
    devicesRoot,
    devices: sized,
    unavailableCount: sized.filter((d) => !d.available).length,
    total: sized.reduce((a, b) => a + b.size, 0),
    totalHuman: humanBytes(sized.reduce((a, b) => a + b.size, 0)),
  };
}

/* --------------------------------------------------------------- emulators */

/**
 * AVD files that a wipe removes. Single source of truth, so the sizes reported
 * by the scan always describe exactly what the wipe will delete.
 * `userdata.img` is the pristine base image and is deliberately NOT wiped.
 */
const WIPEABLE_AVD_FILES = [
  'userdata-qemu.img',
  'userdata-qemu.img.qcow2',
  'sdcard.img.qcow2',
  'cache.img',
  'cache.img.qcow2',
  'snapshots',
];

async function listEmulators({ force = false } = {}) {
  const avdRoot = path.join(S.HOME, '.android', 'avd');
  if (!(await isDir(avdRoot))) return { available: false, avds: [] };

  let entries;
  try {
    entries = await fsp.readdir(avdRoot, { withFileTypes: true });
  } catch {
    return { available: false, avds: [] };
  }

  const avdDirs = entries.filter((e) => e.isDirectory() && e.name.endsWith('.avd'));
  // One du pass for all AVD directories.
  const avdSizes = await childSizesCached(avdRoot, { force });

  const sized = await mapLimit(avdDirs, 4, async (e) => {
    const p = path.join(avdRoot, e.name);
    const size = avdSizes.has(p) ? avdSizes.get(p) : await dirSize(p);
    const name = e.name.replace(/\.avd$/, '');

    // Size the wipeable user data. lstat covers the image files (a plain size
    // read, no tree walk); only `snapshots` is a directory needing du.
    const wipeable = (
      await Promise.all(
        WIPEABLE_AVD_FILES.map(async (f) => {
          const fp = path.join(p, f);
          try {
            const st = await fsp.lstat(fp);
            const sz = st.isDirectory() ? await dirSize(fp) : st.size;
            return sz > 0 ? { name: f, size: sz, sizeHuman: humanBytes(sz) } : null;
          } catch {
            return null; // not present
          }
        }),
      )
    ).filter(Boolean);
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
    // On modern macOS the user data lives on a separate volume from /.
    // Elsewhere (or on older macOS) fall back to the home directory's volume.
    const target = IS_MAC && (await exists('/System/Volumes/Data'))
      ? '/System/Volumes/Data'
      : S.HOME;
    const { stdout } = await execFileAsync('df', ['-k', target], {
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
  if (!IS_MAC) {
    throw new Error(
      'Moving to Trash is only supported on macOS. Use permanent delete instead.',
    );
  }
  if (/["\\]/.test(p)) {
    throw new Error('Refusing to trash a path containing quotes or backslashes.');
  }
  const script = `tell application "Finder" to delete POSIX file "${p}"`;
  await execFileAsync('osascript', ['-e', script], { timeout: 120000 });
}

/** Move many files to the Trash in one Finder call (one call per file is very slow). */
async function trashPaths(paths) {
  if (!IS_MAC) throw new Error('Moving to Trash is only supported on macOS.');
  if (paths.some((p) => /["\\]/.test(p))) {
    throw new Error('Refusing to trash a path containing quotes or backslashes.');
  }
  const list = paths.map((p) => `POSIX file "${p}"`).join(', ');
  await execFileAsync('osascript', ['-e', `tell application "Finder" to delete {${list}}`], {
    timeout: 600000,
  });
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

  /*
   * The target must sit exactly `childDepth` levels below the base. Checking the
   * exact depth (rather than mere containment) keeps a crafted request from
   * reaching an arbitrary file deep inside a cache.
   */
  const depth = rule.childDepth || 1;
  const rel = path.relative(rule.base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return 'Target is not inside the cache directory.';
  }
  const parts = rel.split(path.sep);
  if (parts.length > depth) {
    return `Target is nested too deeply under ${rule.label}.`;
  }
  // A shallower target is allowed only when that directory has no children of
  // its own, matching how the scan lists it as the deletable unit.
  if (parts.length < depth) {
    try {
      const sub = await fsp.readdir(abs, { withFileTypes: true });
      if (sub.some((c) => c.isDirectory() && !c.isSymbolicLink())) {
        return `Target is a container under ${rule.label}; select its entries instead.`;
      }
    } catch {
      return 'Cannot inspect target directory.';
    }
  }

  // The first path segment must always match the rule's pattern.
  if (rule.childPattern && !rule.childPattern.test(parts[0])) {
    return `Target name does not match the allowed pattern for ${rule.label}.`;
  }
  if (rule.requireAppClosed && (await isAppRunning(rule.requireAppClosed))) {
    return `${rule.requireAppClosed} is running. Quit it first.`;
  }
  return null;
}

/** Shape a removeListedFiles result like a performDelete result. */
function filesResult(dir, r) {
  sizeCache.delete(dir);
  sizeCache.delete(path.dirname(dir));
  sizeCache.delete(path.dirname(path.dirname(dir)));
  return {
    path: dir,
    ok: r.failed === 0,
    error: r.failed ? `${r.failed} file(s) could not be removed: ${r.error}` : null,
    freed: r.freed,
    freedHuman: humanBytes(r.freed),
    deleted: r.deleted,
    kept: r.kept,
  };
}

/** Every check a delete must pass. Returns {resolved} or {error}. */
async function validateTarget({ kind, ruleId, targetPath }) {
  const roots = allowedRootsForRule(ruleId, kind);
  if (!roots) return { error: 'Unknown rule id.' };

  const gate = S.validateDeletion(targetPath, roots);
  if (!gate.ok) return { error: gate.reason };

  const specific =
    kind === 'project'
      ? await verifyProjectTarget(ruleId, gate.resolved)
      : await verifyCacheTarget(ruleId, gate.resolved);
  if (specific) return { error: specific };
  return { resolved: gate.resolved };
}

/**
 * Perform one deletion request. Always validated, never shelled out with
 * an interpolated path.
 */
async function performDelete({ kind, ruleId, targetPath, useTrash }) {
  const gate = await validateTarget({ kind, ruleId, targetPath });
  if (gate.error) return { path: targetPath, ok: false, error: gate.error };

  // Rules like Codex images empty the folder but keep it in place.
  const rule = kind === 'cache' && S.ABSOLUTE_RULES.find((r) => r.id === ruleId);
  if (rule && rule.keepFolder) {
    const r = await S.removeListedFiles(
      gate.resolved, await S.listFiles(gate.resolved), useTrash ? trashPaths : null,
    );
    return filesResult(gate.resolved, r);
  }

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

  // Cached child sizes for the containing directories are now stale.
  sizeCache.delete(path.dirname(gate.resolved));
  sizeCache.delete(path.dirname(path.dirname(gate.resolved)));

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

  const targets = WIPEABLE_AVD_FILES;
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
  '/api/backup',
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
      // ?force=1 re-measures everything, ignoring the size cache.
      const force = url.searchParams.get('force') === '1';
      const [disk, projects, caches, reportOnly, sims, emus] = await Promise.all([
        diskStatus(),
        scanProjects(),
        scanCaches({ force }),
        scanReportOnly(),
        listSimulators({ force }),
        listEmulators({ force }),
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
      // Require an explicit boolean. A missing field must never be guessed in
      // either direction: assuming Trash silently changes behavior for a caller
      // that meant permanent, and assuming permanent is unrecoverable.
      if (typeof body.useTrash !== 'boolean') {
        sendJson(res, 400, {
          error: 'useTrash must be explicitly true (Trash) or false (permanent).',
        });
        return;
      }
      const { useTrash } = body;
      const stream = body.stream === true;
      if (targets.length === 0) {
        sendJson(res, 400, { error: 'No targets provided.' });
        return;
      }
      if (targets.length > 500) {
        sendJson(res, 400, { error: 'Too many targets in one request.' });
        return;
      }
      /*
       * Streaming mode emits NDJSON: one JSON object per line, flushed as each
       * target finishes. A big delete can take minutes, and a bare spinner tells
       * the user nothing about whether it is progressing or wedged.
       *
       * NDJSON rather than SSE because the client just reads the body
       * incrementally, so there is no reconnect/event-framing machinery and the
       * same handler shape serves both modes.
       */
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          // Disable proxy buffering, so lines are not held back.
          'X-Accel-Buffering': 'no',
        });

        const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);

        // Tell the client the plan up front so it can render a real progress bar.
        const plannedBytes = targets.reduce((a, t) => a + (Number(t.size) || 0), 0);
        send({
          type: 'start',
          total: targets.length,
          plannedBytes,
          useTrash,
        });

        const results = [];
        let freedSoFar = 0;
        let aborted = false;
        // req never emits 'close' once its body is read; res does, on disconnect.
        res.on('close', () => { if (!res.writableFinished) aborted = true; });

        for (let i = 0; i < targets.length; i += 1) {
          const t = targets[i];
          // The browser went away; stop rather than keep deleting unobserved.
          if (aborted) break;

          send({ type: 'progress', index: i, path: t.path, label: t.label || null });

          const r = await performDelete({
            kind: t.kind,
            ruleId: t.ruleId,
            targetPath: t.path,
            useTrash,
          });
          results.push(r);
          if (r.ok) freedSoFar += r.freed || 0;

          send({
            type: 'done',
            index: i,
            path: r.path,
            ok: r.ok,
            error: r.error || null,
            freed: r.freed || 0,
            freedHuman: humanBytes(r.freed || 0),
            freedTotal: freedSoFar,
            freedTotalHuman: humanBytes(freedSoFar),
            okCount: results.filter((x) => x.ok).length,
            failCount: results.filter((x) => !x.ok).length,
          });
        }

        send({
          type: 'complete',
          aborted,
          results,
          freed: freedSoFar,
          freedHuman: humanBytes(freedSoFar),
          okCount: results.filter((r) => r.ok).length,
          failCount: results.filter((r) => !r.ok).length,
          inTrash: useTrash,
        });
        res.end();
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

    /*
     * Upload a folder to Telegram, then delete it. Streams NDJSON progress like
     * /api/delete. The folder is deleted only if every file was uploaded.
     */
    if (req.method === 'POST' && route === '/api/backup') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rule = S.ABSOLUTE_RULES.find((r) => r.id === body.ruleId);
      const cfg = TG.loadConfig();
      const caption = String(body.caption || '').trim();
      let error = null;
      if (!rule || !rule.backup) error = 'This item cannot be backed up.';
      else if (!cfg) error = `Telegram backup is not set up (see README, ${TG.CONFIG_PATH}).`;
      else if (typeof body.useTrash !== 'boolean') error = 'useTrash must be true or false.';
      else if (caption.length > TG.MAX_CAPTION - 100) error = 'Caption is too long.';
      // Same gate as a delete, before a single byte leaves the machine.
      const gate = error ? null : await validateTarget({
        kind: 'cache', ruleId: rule.id, targetPath: body.path,
      });
      if (gate && gate.error) error = gate.error;
      if (error) {
        sendJson(res, 400, { error });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      const send = (obj) => res.write(`${JSON.stringify(obj)}\n`);
      let aborted = false;
      // req never emits 'close' once its body is read; res does, on disconnect.
      res.on('close', () => { if (!res.writableFinished) aborted = true; });

      let uploaded = null;
      try {
        const up = await TG.backupFolder(gate.resolved, caption, {
          onProgress: (p) => send({ type: 'upload', ...p, sentHuman: humanBytes(p.sentBytes) }),
          isAborted: () => aborted,
        });
        uploaded = up.files;
        send({ type: 'uploaded', files: uploaded.length, bytesHuman: humanBytes(up.bytes) });
      } catch (err) {
        send({ type: 'complete', ok: false, error: `${err.message} Nothing was deleted.` });
        res.end();
        return;
      }

      // Re-check the target, then delete only the files Telegram confirmed.
      // The folder, and anything added or changed during the upload, stay.
      const again = await validateTarget({ kind: 'cache', ruleId: rule.id, targetPath: gate.resolved });
      if (again.error) {
        send({ type: 'complete', ok: false, error: `${again.error} Backed up, but nothing was deleted.` });
        res.end();
        return;
      }
      const removed = await S.removeListedFiles(
        again.resolved, uploaded, body.useTrash ? trashPaths : null,
      );
      send({ type: 'complete', ...filesResult(again.resolved, removed), inTrash: body.useTrash });
      res.end();
      return;
    }

    if (req.method === 'POST' && route === '/api/reveal') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const p = path.resolve(String(body.path || ''));
      if (!(await exists(p))) {
        sendJson(res, 400, { error: 'Path not found.' });
        return;
      }
      // Open a plain folder to show its contents. Anything with an extension
      // (a file, or a bundle like .app that `open` would launch) is only revealed.
      const isDir = (await fsp.stat(p)).isDirectory() && path.extname(p) === '';
      await execFileAsync('open', isDir ? [p] : ['-R', p], { timeout: 10000 }).catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404).end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

/**
 * Identify whatever already holds our port.
 *
 * Silently hopping to the next free port (the previous behavior) is the worst
 * option: you end up with orphaned servers you never notice, each holding an
 * authorization grace window. So we stop and say what is there.
 */
async function whoHasPort(port) {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'],
      { timeout: 5000 },
    );
    // -F output is one field per line, prefixed by a tag character.
    const procs = [];
    let cur = null;
    for (const line of stdout.split('\n')) {
      const tag = line[0];
      const val = line.slice(1);
      if (tag === 'p') {
        cur = { pid: Number(val), command: '' };
        procs.push(cur);
      } else if (tag === 'c' && cur) {
        cur.command = val;
      }
    }
    return procs.filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

/** Is this PID one of our own server processes? */
async function isOurServer(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], {
      timeout: 5000,
    });
    return stdout.includes('diskclean') && stdout.includes('server.js');
  } catch {
    return false;
  }
}

function usage() {
  process.stdout.write(`
  diskclean - inspect and reclaim development disk space

  Usage: diskclean [options]

    --port <n>    Port to listen on (default ${PORT})
    --replace     Stop an existing diskclean on this port and take over
    --no-open     Do not open a browser
    --help        Show this message

  Environment:
    DISKCLEAN_PORT   Same as --port

`);
}

async function start() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const portIdx = argv.indexOf('--port');
  const port =
    portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`\n  Invalid port: ${argv[portIdx + 1]}\n\n`);
    process.exit(1);
  }
  const replace = argv.includes('--replace');
  const noOpen = argv.includes('--no-open');

  const holders = await whoHasPort(port);
  if (holders.length > 0) {
    const ours = [];
    for (const h of holders) {
      if (await isOurServer(h.pid)) ours.push(h);
    }

    // Something else owns the port. Never touch another program's process.
    if (ours.length === 0) {
      const list = holders.map((h) => `${h.command} (pid ${h.pid})`).join(', ');
      process.stderr.write(
        `\n  Port ${port} is in use by ${list}.\n` +
        `  That is not a diskclean process, so it will not be touched.\n` +
        `  Start on another port:  diskclean --port ${port + 1}\n\n`,
      );
      process.exit(1);
    }

    if (!replace) {
      const list = ours.map((h) => `pid ${h.pid}`).join(', ');
      process.stderr.write(
        `\n  diskclean is already running on port ${port} (${list}).\n\n` +
        `  Open it:        http://${HOST}:${port}\n` +
        `  Replace it:     diskclean --replace\n` +
        `  Use a new port: diskclean --port ${port + 1}\n\n`,
      );
      process.exit(1);
    }

    // --replace: shut our own old instance down politely, then confirm.
    for (const h of ours) {
      process.stdout.write(`  Stopping existing diskclean (pid ${h.pid})…\n`);
      try {
        process.kill(h.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const freed = await waitForPortFree(port, 5000);
    if (!freed) {
      process.stderr.write(
        `\n  Could not free port ${port}. Stop the process by hand, or use --port.\n\n`,
      );
      process.exit(1);
    }
  }

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\n  Port ${port} was taken while starting. Try again, or use --port.\n\n`,
      );
    } else if (err.code === 'EACCES') {
      process.stderr.write(
        `\n  Not allowed to listen on port ${port}. Pick a port above 1024.\n\n`,
      );
    } else {
      process.stderr.write(`\n  Could not start diskclean: ${err.message}\n\n`);
    }
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    ACTIVE_PORT = port;
    const url = `http://${HOST}:${port}`;
    process.stdout.write(`\n  diskclean running at ${url}\n`);
    process.stdout.write('  Deletions require your login password.\n');
    process.stdout.write('  Press Ctrl+C to stop.\n\n');
    if (!noOpen) openInBrowser(url);
  });
}

/** Poll until nothing is listening on the port, or we give up. */
async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holders = await whoHasPort(port);
    if (holders.length === 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

start().catch((err) => {
  process.stderr.write(`\n  Startup failed: ${err.message}\n\n`);
  process.exit(1);
});

function shutdown(signal) {
  process.stdout.write(`\n  Stopped (${signal}).\n`);
  server.close(() => process.exit(0));
  // Do not hang on keep-alive connections.
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
