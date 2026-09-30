'use strict';

/**
 * Safety layer for diskclean.
 *
 * Design rule: deletion is allowed ONLY when a path matches an explicit
 * allowlist rule AND survives every deny check. There is no code path that
 * deletes an arbitrary caller-supplied path. If a rule is not listed here,
 * the path is not deletable, no matter what the UI asks for.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

/** Absolute paths that must never be deleted, even if a rule matches. */
const PROTECTED_EXACT = new Set(
  [
    '/',
    '/System',
    '/Library',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/opt',
    '/Applications',
    '/Users',
    '/Volumes',
    '/private',
    HOME,
    path.join(HOME, 'Library'),
    path.join(HOME, 'Documents'),
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Downloads'),
    path.join(HOME, 'Pictures'),
    path.join(HOME, 'Movies'),
    path.join(HOME, 'Music'),
    path.join(HOME, '.ssh'),
    path.join(HOME, '.gnupg'),
    path.join(HOME, '.gradle'),
    path.join(HOME, '.android'),
    path.join(HOME, 'Library', 'Developer'),
    path.join(HOME, 'Library', 'Android'),
    path.join(HOME, 'Library', 'Android', 'sdk'),
    path.join(HOME, 'Library', 'Caches'),
    path.join(HOME, 'Library', 'Application Support'),
    path.join(HOME, 'Library', 'Group Containers'),
    path.join(HOME, 'Library', 'Containers'),
    path.join(HOME, 'Library', 'CloudStorage'),
    path.join(HOME, 'Library', 'Keychains'),
    path.join(HOME, 'Library', 'Preferences'),
    path.join(HOME, '.android'),
    path.join(HOME, '.android', 'avd'),
    path.join(HOME, '.npm'),
    path.join(HOME, '.gradle', 'caches'),
    path.join(HOME, '.gradle', 'wrapper'),
    path.join(HOME, '.gradle', 'wrapper', 'dists'),
    path.join(HOME, '.gradle', 'daemon'),
    // Machine-wide build setup (see README, "Build caches this tool must keep").
    path.join(HOME, '.gradle', 'init.d'),
    path.join(HOME, '.gradle', 'gradle.properties'),
    path.join(HOME, 'Library', 'Caches', 'ccache'),
    path.join(HOME, 'Library', 'Developer', 'Xcode'),
    path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    path.join(HOME, 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
    path.join(HOME, 'Library', 'Developer', 'Xcode', 'Archives'),
    path.join(HOME, 'Library', 'Developer', 'CoreSimulator'),
    path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Devices'),
    path.join(HOME, 'Library', 'Android', 'sdk', 'ndk'),
    path.join(HOME, 'Library', 'Android', 'sdk', 'system-images'),
    path.join(HOME, 'Library', 'Android', 'sdk', 'build-tools'),
    path.join(HOME, 'Library', 'Caches', 'CocoaPods'),
    path.join(HOME, 'Library', 'Caches', 'ReactNative'),
    path.join(HOME, 'Library', 'Caches', 'Yarn'),
    path.join(HOME, '.codex'),
    path.join(HOME, '.codex', 'sessions'),
  ].map((p) => path.resolve(p)),
);

/**
 * A rule's own base directory is never itself deletable. Enforced separately
 * from PROTECTED_EXACT so adding a rule can't silently create a hole.
 */
function isRuleBase(resolved) {
  return RULE_BASES.has(resolved);
}

/**
 * Any path that starts with one of these is refused outright. Guards against a
 * rule being mis-specified later and reaching somewhere it must never touch.
 */
const PROTECTED_PREFIXES = [
  '/System/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/etc/',
  '/private/var/db/',
  '/Library/Apple/',
  '/Applications/',
  path.join(HOME, 'Library', 'Keychains') + path.sep,
  path.join(HOME, 'Library', 'Preferences') + path.sep,
  path.join(HOME, '.ssh') + path.sep,
  path.join(HOME, '.gnupg') + path.sep,
  path.join(HOME, 'Library', 'CloudStorage') + path.sep,
  // Codex chat history. Only ~/.codex/generated_images is ever offered.
  path.join(HOME, '.codex', 'sessions') + path.sep,
  // App data next to caches we clear: settings, chats, profiles, logins.
  path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User') + path.sep,
  path.join(HOME, 'Library', 'Application Support', 'Google') + path.sep,
];

/** Names that must never appear as a path segment of a delete target. */
const PROTECTED_SEGMENTS = new Set([
  '.git',
  '.ssh',
  '.gnupg',
  '.env',
  'Keychains',
  'CloudStorage',
]);

/** Minimum path depth. Blocks shallow, high-blast-radius targets. */
const MIN_DEPTH = 3;

/**
 * Deletable categories.
 *
 * kind:
 *   'project'  -> a named directory inside a detected RN/node project
 *   'absolute' -> a specific known cache dir outside projects
 *
 * Each project rule names an exact relative subpath. We never glob into a
 * project, so source directories can never be selected.
 */
const PROJECT_RULES = [
  {
    id: 'node_modules',
    rel: 'node_modules',
    label: 'node_modules',
    regen: 'yarn install',
    safe: true,
  },
  {
    id: 'ios_pods',
    rel: path.join('ios', 'Pods'),
    label: 'ios/Pods',
    regen: 'pod install',
    safe: true,
  },
  {
    id: 'ios_build',
    rel: path.join('ios', 'build'),
    label: 'ios/build',
    regen: 'Xcode build',
    safe: true,
  },
  {
    id: 'android_build',
    rel: path.join('android', 'build'),
    label: 'android/build',
    regen: 'gradle build',
    safe: true,
  },
  {
    id: 'android_app_build',
    rel: path.join('android', 'app', 'build'),
    label: 'android/app/build',
    regen: 'gradle build',
    safe: true,
  },
  {
    id: 'android_gradle',
    rel: path.join('android', '.gradle'),
    label: 'android/.gradle',
    regen: 'gradle build',
    safe: true,
  },
  {
    id: 'android_cxx',
    rel: path.join('android', 'app', '.cxx'),
    label: 'android/app/.cxx',
    regen: 'gradle build',
    safe: true,
  },
  {
    id: 'dart_tool',
    rel: '.dart_tool',
    label: '.dart_tool',
    regen: 'flutter pub get',
    safe: true,
  },
  {
    id: 'next_build',
    rel: '.next',
    label: '.next',
    regen: 'next build',
    safe: true,
  },
  {
    id: 'expo',
    rel: '.expo',
    label: '.expo',
    regen: 'expo start',
    safe: true,
  },
  {
    id: 'turbo',
    rel: '.turbo',
    label: '.turbo',
    regen: 'turbo build',
    safe: true,
  },
  {
    id: 'venv',
    rel: 'venv',
    label: 'venv',
    regen: 'python -m venv venv',
    safe: true,
  },
  {
    id: 'build_root',
    rel: 'build',
    label: 'build',
    regen: 'project build',
    safe: true,
    // A `build` directory is only offered when git confirms it is ignored, so a
    // project that commits files under build/ is never touched. Enforced in
    // scanProject() in server.js.
    requireGitignored: true,
  },
];

/**
 * Roots we are willing to scan for projects.
 *
 * Candidates cover the usual places people keep code; only the ones that
 * actually exist on this machine are used, so copying the tool to another
 * machine works without editing anything. Override with DISKCLEAN_ROOTS
 * (colon-separated absolute paths) or a "roots" array in ~/.diskclean.json.
 */
const CANDIDATE_PROJECT_ROOTS = [
  path.join(HOME, 'Documents', 'Github'),
  path.join(HOME, 'Documents', 'GitHub'),
  path.join(HOME, 'Documents', 'git'),
  path.join(HOME, 'Documents', 'Projects'),
  path.join(HOME, 'Documents', 'code'),
  path.join(HOME, 'Developer'),
  path.join(HOME, 'Development'),
  path.join(HOME, 'Projects'),
  path.join(HOME, 'projects'),
  path.join(HOME, 'code'),
  path.join(HOME, 'src'),
  path.join(HOME, 'repos'),
  path.join(HOME, 'git'),
  path.join(HOME, 'work'),
  path.join(HOME, 'dev'),
  path.join(HOME, 'workspace'),
  path.join(HOME, 'AndroidStudioProjects'),
  path.join(HOME, 'StudioProjects'),
  path.join(HOME, 'IdeaProjects'),
];

/**
 * A configured root must be an existing directory inside the home folder.
 * Keeping roots under HOME means a typo in config cannot point the scanner at
 * a system location.
 */
function isUsableRoot(p) {
  const abs = path.resolve(p);
  if (abs === HOME) return false;
  const rel = path.relative(HOME, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** Expand a leading ~ so hand-written config paths work as people expect. */
function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function readConfiguredRoots() {
  // 1. Environment variable wins.
  const env = process.env.DISKCLEAN_ROOTS;
  if (env) {
    return env.split(':').map((s) => expandHome(s.trim())).filter(Boolean);
  }
  // 2. Optional config file.
  try {
    const raw = fs.readFileSync(path.join(HOME, '.diskclean.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (Array.isArray(cfg.roots)) {
      return cfg.roots
        .filter((r) => typeof r === 'string')
        .map((r) => expandHome(r.trim()))
        .filter(Boolean);
    }
  } catch {
    /* no config, or unreadable/invalid: fall through to auto-detection */
  }
  return null;
}

function resolveProjectRoots() {
  const configured = readConfiguredRoots();
  const list = configured || CANDIDATE_PROJECT_ROOTS;
  const usable = list.map((p) => path.resolve(p)).filter(isUsableRoot);

  /*
   * Deduplicate by the real inode, not by string. macOS filesystems are
   * case-insensitive by default, so ~/Documents/Github and ~/Documents/GitHub
   * are the SAME directory and would otherwise be scanned twice. realpath also
   * collapses symlinked roots pointing at one place.
   */
  const byId = new Map();
  for (const p of usable) {
    let key;
    try {
      const real = fs.realpathSync(p);
      const st = fs.statSync(real);
      key = `${st.dev}:${st.ino}`;
    } catch {
      key = p;
    }
    // Keep the first spelling we saw, so ordering stays predictable.
    if (!byId.has(key)) byId.set(key, p);
  }
  const unique = [...byId.values()];

  // Drop any root nested inside another, so a project is not scanned twice.
  return unique.filter(
    (a) => !unique.some((b) => {
      if (b === a) return false;
      const rel = path.relative(b, a);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    }),
  );
}

const PROJECT_ROOTS = resolveProjectRoots();

/**
 * How many levels below a root we look for projects. Monorepo-ish containers
 * (e.g. a folder of websites, each at <container>/<site>/website) need more
 * than one level. Kept small so a scan stays fast and predictable.
 */
const PROJECT_SCAN_DEPTH = 3;

/**
 * Directory names the project scanner must never descend into. Prevents
 * treating an artifact directory as a project (`.next/package.json` exists,
 * and every package inside node_modules has one).
 */
const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.expo',
  '.turbo',
  '.dart_tool',
  '.gradle',
  '.cxx',
  'Pods',
  'build',
  'dist',
  'out',
  'venv',
  '.venv',
  '__pycache__',
  'DerivedData',
  'vendor',
  'Carthage',
  '.yarn',
  '.pnpm-store',
  '.cache',
]);

/**
 * Absolute cache rules. `path` must be an exact directory. Children are only
 * enumerated when `children: true`, and then each child is individually
 * validated against the same containment rules.
 */
const ABSOLUTE_RULES = [
  {
    id: 'gradle_caches_version',
    label: 'Gradle version caches',
    base: path.join(HOME, '.gradle', 'caches'),
    children: true,
    // Only version-numbered dirs and known transient caches. Deliberately NOT
    // modules-2 (every downloaded dependency, ~2.5 GB, minutes to re-fetch)
    // and NOT build-cache-1 (the shared Kotlin/Java/dex task cache that makes
    // rebuilds across projects fast). Both are listed under REPORT_ONLY.
    childPattern: /^(\d+\.\d+(\.\d+)?|jars-\d+|transforms-\d+|journal-\d+|kotlin-dsl)$/,
    regen: 'gradle re-extracts on next build',
    safe: true,
    note: 'Version dirs for Gradle releases you no longer use are pure waste. The current version dir is mostly `transforms` (unpacked AARs); deleting it costs a few minutes of re-extraction, no recompiling.',
  },
  {
    id: 'gradle_wrapper_dists',
    label: 'Gradle wrapper distributions',
    base: path.join(HOME, '.gradle', 'wrapper', 'dists'),
    children: true,
    childPattern: /^gradle-[\d.]+(-(bin|all))?$/,
    regen: 'wrapper re-downloads on next build',
    safe: true,
  },
  {
    id: 'gradle_daemon',
    label: 'Gradle daemon logs',
    base: path.join(HOME, '.gradle', 'daemon'),
    children: true,
    childPattern: /^\d+\.\d+(\.\d+)?$/,
    regen: 'recreated automatically',
    safe: true,
  },
  {
    id: 'xcode_derived',
    label: 'Xcode DerivedData',
    base: path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'Xcode rebuilds',
    safe: true,
  },
  {
    id: 'xcode_device_support',
    label: 'Xcode iOS DeviceSupport',
    base: path.join(HOME, 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
    children: true,
    childPattern: /^[A-Za-z0-9m .()_-]+$/,
    regen: 'regenerated when you attach a device',
    safe: true,
  },
  {
    id: 'xcode_archives',
    label: 'Xcode Archives',
    base: path.join(HOME, 'Library', 'Developer', 'Xcode', 'Archives'),
    children: true,
    childPattern: /^[0-9-]+$/,
    regen: 'NOT regenerable, these are your shipped builds',
    safe: false,
    note: 'Archives are release builds you may need for symbolication. Review carefully.',
  },
  {
    id: 'android_ndk',
    label: 'Android NDK versions',
    base: path.join(HOME, 'Library', 'Android', 'sdk', 'ndk'),
    children: true,
    childPattern: /^[\d.]+$/,
    regen: 'SDK manager re-downloads',
    safe: false,
    note: 'Keep the NDK version your projects pin. Deleting the wrong one breaks builds until re-downloaded.',
  },
  {
    id: 'android_system_images',
    label: 'Android system images',
    base: path.join(HOME, 'Library', 'Android', 'sdk', 'system-images'),
    children: true,
    childPattern: /^android-[\w.-]+$/,
    regen: 'SDK manager re-downloads',
    safe: false,
    note: 'Needed by emulators using that API level.',
  },
  {
    id: 'android_build_tools',
    label: 'Android build-tools',
    base: path.join(HOME, 'Library', 'Android', 'sdk', 'build-tools'),
    children: true,
    childPattern: /^[\d.]+(-rc\d+)?$/,
    regen: 'SDK manager re-downloads',
    safe: false,
    note: 'Keep the version your Gradle config requires.',
  },
  {
    id: 'cocoapods_cache',
    label: 'CocoaPods cache',
    base: path.join(HOME, 'Library', 'Caches', 'CocoaPods'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'pod install re-downloads',
    safe: true,
  },
  {
    id: 'rn_cache',
    label: 'React Native cache',
    base: path.join(HOME, 'Library', 'Caches', 'ReactNative'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'recreated on next bundle',
    safe: true,
  },
  {
    id: 'npm_cache',
    label: 'npm cache (_cacache)',
    base: path.join(HOME, '.npm', '_cacache'),
    children: false,
    regen: 'npm re-downloads',
    safe: true,
  },
  {
    id: 'yarn_cache',
    label: 'Yarn cache',
    base: path.join(HOME, 'Library', 'Caches', 'Yarn'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'yarn re-downloads',
    safe: true,
  },
  {
    id: 'metro_cache',
    label: 'Metro bundler temp',
    base: path.join(os.tmpdir()),
    children: true,
    childPattern: /^(metro-|haste-map-|react-native-packager-)[A-Za-z0-9._-]*$/,
    regen: 'recreated on next bundle',
    safe: true,
  },
  {
    id: 'lmstudio_models',
    label: 'LM Studio models',
    // Each publisher dir holds one or more models; list per model, not per
    // publisher, so a single model can be removed.
    base: path.join(HOME, '.lmstudio', 'models'),
    children: true,
    childDepth: 2,
    childPattern: /^[A-Za-z0-9._@-]+$/,
    regen: 're-downloadable from LM Studio',
    safe: true,
    note:
      'Models are re-downloadable from LM Studio, so deleting one only costs the '
      + 'download. Check for anything you fine-tuned or converted locally, since '
      + 'that would not be on the hub.',
    requireAppClosed: 'LM Studio',
  },
  {
    id: 'huggingface_hub',
    label: 'Hugging Face model cache',
    base: path.join(HOME, '.cache', 'huggingface', 'hub'),
    children: true,
    childPattern: /^(models|datasets|spaces)--[A-Za-z0-9._-]+$/,
    regen: 're-downloaded on next run',
    safe: true,
    note:
      'Downloaded model weights (this is where MFLUX/diffusers keep FLUX). '
      + 'Re-downloaded automatically on the next run, but these are large files, '
      + 'so only clear one if you are done with that generator for a while.',
  },
  {
    id: 'torch_hub',
    label: 'PyTorch hub cache',
    base: path.join(HOME, '.cache', 'torch', 'hub'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 're-downloaded on next run',
    safe: true,
  },
  {
    id: 'uv_cache',
    label: 'uv (Python) cache',
    base: path.join(HOME, '.cache', 'uv'),
    children: true,
    childPattern: /^(archive|git|sdists|builds|simple|wheels|interpreter)-v\d+$/,
    regen: 'uv re-downloads and rebuilds',
    safe: true,
    note:
      'Prefer `uv cache prune` for routine cleanup, which removes only '
      + 'unused entries. Deleting a whole directory here is also safe, it just '
      + 'forces more re-downloading later.',
  },
  {
    id: 'pip_cache',
    label: 'pip cache',
    base: path.join(HOME, 'Library', 'Caches', 'pip'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'pip re-downloads',
    safe: true,
  },
  {
    id: 'playwright_cache',
    label: 'Playwright browsers',
    base: path.join(HOME, 'Library', 'Caches', 'ms-playwright'),
    children: true,
    childPattern: /^[A-Za-z0-9._-]+$/,
    regen: 'npx playwright install',
    safe: true,
  },
  {
    id: 'puppeteer_cache',
    label: 'Puppeteer browsers',
    // browser/version, so old Chrome builds can go while the pinned one stays.
    base: path.join(HOME, '.cache', 'puppeteer'),
    children: true,
    childDepth: 2,
    childPattern: /^(chrome|chrome-headless-shell|chromium|firefox)$/,
    regen: 're-downloaded on npm install',
    safe: true,
    note: 'Each project pins one browser version. Old versions are safe to remove; a project that needs one re-downloads it on npm install.',
  },
  {
    id: 'yarn_berry_cache',
    label: 'Yarn (2+) global cache',
    base: path.join(HOME, '.yarn', 'berry', 'cache'),
    children: false,
    regen: 'yarn re-downloads',
    safe: true,
  },
  {
    id: 'bun_cache',
    label: 'bun install cache',
    base: path.join(HOME, '.bun', 'install', 'cache'),
    children: false,
    regen: 'bun re-downloads',
    safe: true,
  },
  {
    id: 'homebrew_cache',
    label: 'Homebrew downloads',
    base: path.join(HOME, 'Library', 'Caches', 'Homebrew'),
    children: false,
    regen: 'brew re-downloads when needed',
    safe: true,
    note: 'Downloaded bottles and casks. Installed packages are not affected. `brew cleanup --prune=all` does the same.',
  },
  {
    id: 'chrome_cache',
    label: 'Chrome cache',
    // One entry per Chrome profile. Only the web cache: bookmarks, passwords,
    // history and logins live in Application Support and are never touched.
    base: path.join(HOME, 'Library', 'Caches', 'Google', 'Chrome'),
    children: true,
    childPattern: /^(Default|Profile \d+|Guest Profile|System Profile)$/,
    regen: 'rebuilt while browsing',
    safe: true,
    note: 'Web cache only. Bookmarks, passwords, history and logins are not in here. Pages load a little slower until the cache refills.',
    requireAppClosed: 'Google Chrome',
  },
  {
    id: 'cursor_caches',
    label: 'Cursor caches and logs',
    base: path.join(HOME, 'Library', 'Application Support', 'Cursor'),
    children: true,
    // Only these names. Settings, extension state and chats (User/) never match.
    childPattern: /^(Cache|CachedData|CachedExtensionVSIXs|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|logs)$/,
    regen: 'rebuilt by Cursor',
    safe: true,
    note: 'Cursor settings, extensions, chats and logins are not touched.',
    requireAppClosed: 'Cursor',
  },
  {
    id: 'maestro_tests',
    label: 'Maestro test runs',
    base: path.join(HOME, '.maestro', 'tests'),
    children: true,
    childPattern: /^\d{4}-\d{2}-\d{2}_\d{6}$/,
    regen: 'old run logs and screenshots, not regenerated',
    safe: true,
    note: 'Screenshots and logs from past Maestro runs, one row per run. Nothing needs them to run tests again.',
  },
  {
    id: 'codex_generated_images',
    label: 'Codex generated images',
    // One folder per chat. The chat itself lives in ~/.codex/sessions and
    // thread_history_*.sqlite, which no rule reaches.
    base: path.join(HOME, '.codex', 'generated_images'),
    children: true,
    childPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    regen: 'NOT regenerable, re-running a prompt gives different images',
    safe: false,
    note:
      'Images Codex generated in one chat. Only the image files go: the chat, its '
      + 'context and the folder itself stay. Save any image you want to keep first, '
      + 'or use Backup & delete.',
    // Delete the files inside, never the chat's folder (Codex may reference it).
    keepFolder: true,
    // "Backup & delete" uploads the folder to Telegram first (see telegram.js).
    backup: { tags: '#codex #ai_images' },
  },
  {
    id: 'telegram_temp',
    label: 'Telegram temp files',
    base: path.join(
      HOME,
      'Library',
      'Group Containers',
      '6N38VWS5BX.ru.keepcoder.Telegram',
      'appstore',
      'temp',
    ),
    children: false,
    regen: 'recreated by Telegram',
    safe: true,
    requireAppClosed: 'Telegram',
  },
];

/** Reports only. Never deletable through this tool. */
const REPORT_ONLY = [
  {
    id: 'ccache',
    label: 'ccache (compiled C++ for every React Native Android build)',
    base: path.join(HOME, 'Library', 'Caches', 'ccache'),
    reason:
      'This is the machine-wide compiler cache wired into every Android build by ~/.gradle/init.d/ccache.gradle. It is what turns a 20-40 minute native rebuild of mmkv, reanimated, worklets, nitro and friends into seconds after a project build directory is deleted. It is capped (ccache --show-config) and evicts old objects itself. Delete project build dirs freely instead; never this. See README, "Build caches this tool must keep".',
  },
  {
    id: 'gradle_modules',
    label: 'Gradle dependency downloads (modules-2)',
    base: path.join(HOME, '.gradle', 'caches', 'modules-2'),
    reason:
      'Every downloaded dependency jar/aar (react-android, hermes, AndroidX, Firebase) for all projects. Deleting it saves little and forces a full re-download on the next build of each project. Gradle prunes unused entries after 30 days on its own.',
  },
  {
    id: 'gradle_build_cache',
    label: 'Gradle build cache (build-cache-1)',
    base: path.join(HOME, '.gradle', 'caches', 'build-cache-1'),
    reason:
      'Shared Kotlin/Java/dex task outputs, enabled for all projects by org.gradle.caching=true in ~/.gradle/gradle.properties. Small, and it is exactly what makes a rebuild after cleaning a project fast. Gradle prunes it after 7 days unused.',
  },
  {
    id: 'telegram_db',
    label: 'Telegram message database',
    base: path.join(
      HOME,
      'Library',
      'Group Containers',
      '6N38VWS5BX.ru.keepcoder.Telegram',
      'appstore',
    ),
    reason:
      'This is Telegram\'s live SQLite database (db_sqlite), not a media cache. That is why the in-app cleaner only reports a few hundred MB. Deleting it erases local chat history and can corrupt the running app. The only safe way to shrink it is inside Telegram: log the unused account out (Settings > right-click account > Log out), which drops that account\'s database. Do that in the app, not here.',
  },
  {
    id: 'simulator_devices',
    label: 'iOS Simulator devices',
    base: path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Devices'),
    reason:
      'Simulator data is managed by simctl and hardlinked against runtimes. Deleting these directories by hand corrupts the simulator index. Use the Simulators panel in this tool, which calls simctl instead.',
  },
];

/**
 * Every rule base and project root, derived automatically. A base directory is
 * a container we enumerate; it must never be a delete target itself.
 */
const RULE_BASES = new Set(
  [
    // Every candidate root, not just the ones present here, so the protection
    // does not depend on which directories happen to exist on this machine.
    ...CANDIDATE_PROJECT_ROOTS,
    ...PROJECT_ROOTS,
    ...ABSOLUTE_RULES.map((r) => r.base),
    ...REPORT_ONLY.map((r) => r.base),
  ].map((p) => path.resolve(p)),
);

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True if child is strictly inside parent (no equality, no sibling prefix). */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return (
    rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
  );
}

/**
 * The single gate every deletion must pass.
 * Returns { ok: true, resolved } or { ok: false, reason }.
 */
function validateDeletion(targetPath, allowedRoots) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, reason: 'Empty path.' };
  }
  if (targetPath.includes('\0')) {
    return { ok: false, reason: 'Null byte in path.' };
  }

  const abs = path.resolve(targetPath);

  // Resolve symlinks so a link cannot point outside an allowed root.
  const real = realpathSafe(abs);
  if (!real) {
    return { ok: false, reason: 'Path does not exist.' };
  }

  // Refuse if the path itself is a symlink (delete the real thing, not a link).
  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return { ok: false, reason: 'Cannot stat path.' };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, reason: 'Refusing to follow a symlink.' };
  }
  if (!lst.isDirectory() && !lst.isFile()) {
    return { ok: false, reason: 'Not a regular file or directory.' };
  }

  if (real !== abs) {
    return {
      ok: false,
      reason: 'Path contains a symlink; refusing to act on an aliased location.',
    };
  }

  if (PROTECTED_EXACT.has(real)) {
    return { ok: false, reason: `Protected location: ${real}` };
  }

  // A container we enumerate is never itself a target.
  if (isRuleBase(real)) {
    return {
      ok: false,
      reason: `Refusing to delete a container directory: ${real}`,
    };
  }

  for (const prefix of PROTECTED_PREFIXES) {
    if (real === prefix.slice(0, -1) || real.startsWith(prefix)) {
      return { ok: false, reason: `Protected area: ${prefix}` };
    }
  }

  const segments = real.split(path.sep).filter(Boolean);
  if (segments.length < MIN_DEPTH) {
    return {
      ok: false,
      reason: `Path too shallow (depth ${segments.length}, minimum ${MIN_DEPTH}).`,
    };
  }
  for (const seg of segments) {
    if (PROTECTED_SEGMENTS.has(seg)) {
      return { ok: false, reason: `Path contains protected segment "${seg}".` };
    }
  }

  // Must live under at least one allowed root for the requested rule.
  const roots = (allowedRoots || []).map((r) => path.resolve(r));
  const contained = roots.some((r) => isInside(r, real));
  if (!contained) {
    return {
      ok: false,
      reason: 'Path is not inside an allowlisted root for this operation.',
    };
  }

  // Never delete a volume root or a mount point.
  if (real.split(path.sep).length <= 2) {
    return { ok: false, reason: 'Refusing to act on a volume root.' };
  }

  return { ok: true, resolved: real };
}

/** Every regular file under dir (symlinks skipped, .DS_Store ignored), sorted. */
async function listFiles(dir) {
  const out = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink() || e.name === '.DS_Store') continue;
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) {
      const st = await fs.promises.stat(p);
      out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Delete exactly the listed files inside dir, keeping every folder. A file is
 * kept unless it is still a regular file under dir with the same size and
 * mtime it had when listed, so a file that changed or appeared since (and so
 * was not backed up) is never removed. `trash(paths)` moves a batch to the
 * Trash; without it files are unlinked.
 */
async function removeListedFiles(dir, files, trash) {
  const root = path.resolve(dir) + path.sep;
  const go = [];
  let kept = 0;
  for (const f of files) {
    const p = path.resolve(f.path);
    let st = null;
    try { st = await fs.promises.lstat(p); } catch { /* gone */ }
    const same = st && st.isFile() && st.size === f.size && st.mtimeMs === f.mtimeMs;
    if (!p.startsWith(root) || !same) kept += 1;
    else go.push({ path: p, size: f.size });
  }

  let deleted = 0;
  let freed = 0;
  const errors = [];
  const step = trash ? 200 : 1;
  for (let i = 0; i < go.length; i += step) {
    const batch = go.slice(i, i + step);
    try {
      if (trash) await trash(batch.map((f) => f.path));
      else await fs.promises.unlink(batch[0].path);
      deleted += batch.length;
      freed += batch.reduce((a, f) => a + f.size, 0);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  return { deleted, kept, failed: go.length - deleted, freed, error: errors[0] || null };
}

/**
 * Split a children:false base's entries into what may be deleted: `items` pass
 * the gate as direct children, `links` are symlinks (unlink the link only,
 * never follow), `errors` explain anything refused.
 */
async function contentsToDelete(base, names) {
  const items = [];
  const links = [];
  const errors = [];
  for (const n of names) {
    const p = path.join(base, n);
    let st = null;
    try { st = await fs.promises.lstat(p); } catch { /* gone */ }
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (path.dirname(p) === base) links.push(p);
      continue;
    }
    const gate = validateDeletion(p, [base]);
    if (gate.ok && path.dirname(gate.resolved) === base) items.push(gate.resolved);
    else errors.push(gate.reason || `Not a direct child: ${n}`);
  }
  return { items, links, errors };
}

module.exports = {
  HOME,
  listFiles,
  contentsToDelete,
  removeListedFiles,
  RULE_BASES,
  isRuleBase,
  PROJECT_RULES,
  PROJECT_ROOTS,
  PROJECT_SCAN_DEPTH,
  SCAN_SKIP_DIRS,
  ABSOLUTE_RULES,
  REPORT_ONLY,
  PROTECTED_EXACT,
  validateDeletion,
  isInside,
  realpathSafe,
};
