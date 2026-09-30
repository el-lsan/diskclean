'use strict';

/**
 * Telegram backup for diskclean: upload a folder's files to a channel through
 * a bot before the folder is deleted.
 *
 * The upload itself runs in tg_upload.py (Telethon, MTProto), because the HTTP
 * Bot API caps files at 50 MB and MTProto allows 2 GB. This module keeps the
 * parts that decide safety: which files, album split, verification, abort.
 *
 * Config: ~/.config/diskclean/telegram.json
 *   {"api_id": 123, "api_hash": "<32 hex>", "token": "123:abc", "chat": "-100123"}
 * Python: <this dir>/.venv with telethon installed (see README).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { listFiles } = require('./safety');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'diskclean');
const CONFIG_PATH = path.join(CONFIG_DIR, 'telegram.json');
// Holds the bot's login key, so it lives next to the private config.
const SESSION_PATH = path.join(CONFIG_DIR, 'telegram');
const PYTHON = path.join(__dirname, '.venv', 'bin', 'python3');
const WORKER = path.join(__dirname, 'tg_upload.py');

/** MTProto limit for bots, per file. */
const MAX_FILE_BYTES = 2000 * 1024 * 1024;
/** Telegram albums hold up to 10 items. */
const ALBUM_SIZE = 10;
const MAX_CAPTION = 1024;
/** Kill the worker if it reports nothing for this long (and is not rate limited). */
const STALL_MS = 10 * 60 * 1000;
const LOGIN_MS = 2 * 60 * 1000;

/** Returns the validated config, or null when Telegram backup is not set up. */
function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
  const ok = /^\d+$/.test(String(cfg.api_id))
    && /^[0-9a-f]{32}$/.test(String(cfg.api_hash))
    && /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(cfg.token))
    && /^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(String(cfg.chat));
  return ok && fs.existsSync(PYTHON) ? cfg : null;
}

/** Split into albums of up to 10, avoiding a lone 1-file album at the end. */
function chunk(files) {
  const albums = [];
  for (let i = 0; i < files.length; i += ALBUM_SIZE) albums.push(files.slice(i, i + ALBUM_SIZE));
  const last = albums[albums.length - 1];
  if (albums.length > 1 && last.length === 1) last.unshift(albums[albums.length - 2].pop());
  return albums;
}

/**
 * Start tg_upload.py and wait until it has logged in. Returns
 * {send(paths, caption, onEvent) -> Promise<sizes>, close()}.
 */
function startWorker() {
  // The session file holds the bot's login key; keep the folder private.
  fs.chmodSync(CONFIG_DIR, 0o700);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [WORKER, CONFIG_PATH, SESSION_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });

    let pending = null; // { resolve, reject, onEvent, timer }
    let ready = false;
    let dead = null; // set once the worker is gone; later sends fail with it
    const fail = (err) => {
      dead = dead || err;
      clearTimeout(loginTimer);
      if (!ready) reject(err);
      else if (pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      pending = null;
    };
    const loginTimer = setTimeout(() => {
      child.kill();
      fail(new Error('Telegram login timed out.'));
    }, LOGIN_MS);
    // Writing to a worker that already died must fail the send, not crash the server.
    child.stdin.on('error', (err) => fail(err));
    const arm = (ms) => {
      clearTimeout(pending && pending.timer);
      if (pending) {
        pending.timer = setTimeout(() => {
          child.kill();
          fail(new Error('Telegram upload stalled with no progress.'));
        }, ms);
      }
    };

    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(
      `Telegram worker exited (${code}). ${stderr.trim().split('\n').pop() || ''}`,
    )));

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!ready) {
        if (msg.ready) {
          ready = true;
          clearTimeout(loginTimer);
          resolve({
            send(paths, caption, onEvent) {
              if (dead) return Promise.reject(dead);
              return new Promise((res, rej) => {
                pending = { resolve: res, reject: rej, onEvent, timer: null };
                arm(STALL_MS);
                child.stdin.write(`${JSON.stringify({ files: paths, caption })}\n`);
              });
            },
            close() { child.stdin.end(); child.kill(); },
          });
        } else fail(new Error(`Telegram login failed: ${msg.error || line}`));
        return;
      }
      if (!pending) return;
      if (msg.frac !== undefined || msg.wait !== undefined) {
        arm(STALL_MS + (Number(msg.wait) || 0) * 1000);
        pending.onEvent(msg);
        return;
      }
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      if (msg.ok && Array.isArray(msg.sizes)) p.resolve(msg.sizes);
      else p.reject(new Error(`Telegram: ${msg.error}`));
    });
  });
}

let busy = false;

/**
 * Upload every file in dir as documents (originals, no recompression).
 * The caption goes on the first file of every album, so each album is findable
 * by its hashtags. Throws unless Telegram accepted every file. Returns the
 * uploaded files (path, size, mtime) so the caller deletes exactly those.
 *
 * ponytail: no resume, a failed run re-uploads from the start (duplicates in
 * the channel). Persist the last sent album index if that becomes a problem.
 */
async function backupFolder(dir, caption, { onProgress, isAborted, worker } = {}) {
  if (busy) throw new Error('Another backup is already running.');
  busy = true;
  let w = worker;
  try {
    const files = await listFiles(dir);
    if (files.length === 0) throw new Error('Nothing to back up: the folder has no files.');
    const tooBig = files.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) {
      throw new Error(
        `${tooBig.length} file(s) exceed Telegram's 2 GB limit, e.g. ${path.basename(tooBig[0].path)}. Nothing was uploaded.`,
      );
    }

    const albums = chunk(files);
    const total = files.length;
    const totalBytes = files.reduce((a, f) => a + f.size, 0);
    let sent = 0;
    let sentBytes = 0;
    const report = (extra) => onProgress && onProgress({ sent, total, sentBytes, totalBytes, ...extra });
    report({ phase: 'login' });
    if (!w) w = await startWorker();

    for (let i = 0; i < albums.length; i += 1) {
      if (isAborted && isAborted()) throw new Error('Stopped before the backup finished.');
      const album = albums[i];
      const albumBytes = album.reduce((a, f) => a + f.size, 0);
      const text = `${caption}\n\n${path.basename(dir)} · part ${i + 1}/${albums.length}`.slice(0, MAX_CAPTION);
      const sizes = await w.send(album.map((f) => f.path), text, (ev) => {
        if (ev.wait !== undefined) report({ wait: ev.wait });
        else report({ sentBytes: sentBytes + Math.round(albumBytes * Math.min(ev.frac, 1)) });
      });
      // Every file must be stored with its exact size, or nothing gets deleted.
      const want = album.map((f) => f.size).sort((a, b) => a - b);
      const got = (Array.isArray(sizes) ? sizes : []).map(Number).sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        throw new Error(
          `Telegram confirmed ${got.length} of ${album.length} files in part ${i + 1}, or with the wrong size.`,
        );
      }
      sent += album.length;
      sentBytes += albumBytes;
      report();
    }
    // The caller deletes exactly these (see S.removeListedFiles), so a file
    // that appears or changes during the upload is never removed.
    return { files, bytes: totalBytes };
  } finally {
    busy = false;
    if (w && !worker) w.close();
  }
}

module.exports = {
  CONFIG_PATH, MAX_CAPTION, MAX_FILE_BYTES, loadConfig, chunk, backupFolder,
};
