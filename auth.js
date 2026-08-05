'use strict';

/**
 * Admin authorization gate.
 *
 * Design rule: this tool NEVER receives, transports, or stores a password.
 * The browser has no password field. Instead we ask macOS itself to
 * authenticate the user via a native system dialog, and we only ever learn a
 * boolean result. That means:
 *   - no password in HTTP traffic, logs, or memory
 *   - no password in the browser
 *   - the prompt is the real OS dialog, which cannot be spoofed by a web page
 *
 * A successful authentication opens a short grace window so a single cleanup
 * session does not prompt for every item.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/** How long an authentication stays valid. */
const GRACE_MS = 5 * 60 * 1000;

let authorizedUntil = 0;

function isAuthorized() {
  return Date.now() < authorizedUntil;
}

function remainingMs() {
  return Math.max(0, authorizedUntil - Date.now());
}

function revoke() {
  authorizedUntil = 0;
}

/**
 * Ask macOS to authenticate the current user with Touch ID or the login
 * password, using the same mechanism system dialogs use.
 *
 * `security execute-with-privileges` is unreliable/deprecated for this, and
 * AppleScript's "administrator privileges" shows the standard, non-spoofable
 * admin dialog and returns a nonzero exit code when the user cancels or fails.
 * We run a harmless command (`/usr/bin/true`) purely to force the auth prompt.
 */
async function authenticate(reason) {
  const prompt = String(reason || 'authorize deletion of cache files')
    .replace(/[^A-Za-z0-9 ,.()/-]/g, '')
    .slice(0, 120);

  // Prefer Touch ID / password via LocalAuthentication when available.
  const swiftAvailable = await hasBinary('swift');
  if (swiftAvailable) {
    const ok = await tryLocalAuth(prompt);
    if (ok === true) {
      authorizedUntil = Date.now() + GRACE_MS;
      return { ok: true, method: 'localauth' };
    }
    if (ok === false) return { ok: false, error: 'Authentication cancelled or failed.' };
    // ok === null -> unavailable, fall through to admin dialog
  }

  try {
    // Native admin dialog. Nonzero exit on cancel/failure.
    await execFileAsync(
      'osascript',
      [
        '-e',
        `do shell script "/usr/bin/true" with prompt "diskclean needs to ${prompt}." with administrator privileges`,
      ],
      { timeout: 120000 },
    );
    authorizedUntil = Date.now() + GRACE_MS;
    return { ok: true, method: 'admin' };
  } catch (err) {
    const msg = String(err.stderr || err.message || err);
    if (/-128|User cancelled|canceled/i.test(msg)) {
      return { ok: false, error: 'Authentication cancelled.' };
    }
    return { ok: false, error: 'Authentication failed.' };
  }
}

async function hasBinary(name) {
  try {
    await execFileAsync('which', [name], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Touch ID / password via LocalAuthentication.
 * Returns true (ok), false (explicitly denied), or null (unavailable).
 */
async function tryLocalAuth(prompt) {
  const swift = `
import LocalAuthentication
import Foundation
let ctx = LAContext()
ctx.localizedFallbackTitle = "Use Password"
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
    exit(2)
}
let sem = DispatchSemaphore(value: 0)
var result = false
ctx.evaluatePolicy(.deviceOwnerAuthentication,
                   localizedReason: "${prompt}") { ok, _ in
    result = ok
    sem.signal()
}
sem.wait()
exit(result ? 0 : 1)
`;
  return new Promise((resolve) => {
    const child = execFile('swift', ['-'], { timeout: 120000 }, () => {});
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code === 0) done(true);
      else if (code === 2) done(null); // policy unavailable, use fallback
      else done(false);
    });
    child.stdin.on('error', () => done(null));
    child.stdin.end(swift);
  });
}

module.exports = { authenticate, isAuthorized, remainingMs, revoke, GRACE_MS };
