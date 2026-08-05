# diskclean

A local web GUI for finding and safely reclaiming disk space eaten by mobile
development. Built for a Mac that keeps filling up with Gradle caches,
`node_modules`, Xcode build output, simulators and emulators.

Zero dependencies. One command to run. Every deletion needs your macOS password.

## Why

React Native work spreads regenerable junk across a lot of places, and the
built-in tools do not give you one view of it. This shows everything in one
page, tells you what each item costs, what regenerates it, and lets you clear a
finished project in a couple of clicks.

## Install

Nothing to install. It only needs Node.js, which you already have.

```sh
git clone <your-repo-url> ~/bin/diskclean
~/bin/diskclean/diskclean
```

The server starts on `127.0.0.1` and opens your browser automatically.

Optional, so you can run it from anywhere:

```sh
ln -s ~/bin/diskclean/diskclean /usr/local/bin/diskclean
```

Then just:

```sh
diskclean
```

## What it finds

**Projects.** Scans `~/Documents/Github` and `~/AndroidStudioProjects` for
projects, then lists only regenerable artifact directories inside each one:
`node_modules`, `ios/Pods`, `ios/build`, `android/build`,
`android/app/build`, `android/.gradle`, `android/app/.cxx`, `.dart_tool`,
`.next`, `.expo`, `.turbo`, `venv`, and a gitignored `build`.

Select a whole project with one click when you are done working on it, or
select every `node_modules` across all projects at once.

**Global caches.** Gradle version caches and wrapper distributions, Xcode
DerivedData and iOS DeviceSupport, Android NDK / system-images / build-tools,
CocoaPods, npm, Yarn, React Native and Metro caches.

**iOS Simulators.** Every simulator with its real size, flagging the ones whose
runtime is no longer installed (they cannot boot, so they are pure waste).
Deletion goes through `simctl`, never by removing files.

**Android Emulators.** Every AVD with its size and how much of it is wipeable
user data. "Wipe" clears user data, snapshots and caches but keeps the AVD, so
it still exists and boots fresh.

## Safety

This tool deletes files, so the safety model is the point.

**Allowlist, not blocklist.** A path is deletable only if it matches an
explicit rule in `safety.js`. There is no code path that deletes an arbitrary
path handed to it. Anything not named in a rule is not deletable, no matter
what the UI asks for.

**Every deletion passes one gate.** `validateDeletion()` enforces all of:

- the path exists and is a real file or directory
- it is not a symlink, and contains no symlinked component (blocks alias escapes)
- it is not a protected system or home location
- it is not a container directory that a rule merely enumerates
- it is at least 3 levels deep
- no path segment is `.git`, `.ssh`, `.gnupg`, `.env`, `Keychains`, `CloudStorage`
- it resolves to a location strictly inside an allowlisted root for that rule

**Then a second, rule-specific check.** A project target must be the exact
artifact path of a genuinely detected project. A cache target must be a direct
child of that rule's base directory and match that rule's name pattern.

**No shell string interpolation.** Deletion uses `fs.rm` with an explicit path.
Subprocesses use `execFile` with an argument array, so a path is never parsed
by a shell.

**Trash by default.** Deletions move to the macOS Trash and are recoverable.
Permanent deletion is opt-in and requires typing `delete` to confirm.

**Your macOS password is required.** Destructive endpoints refuse to run
without a live OS-verified authorization. Authentication uses the native macOS
dialog (Touch ID, falling back to your admin password). The password is never
typed into the web page, never sent over HTTP, and never seen by this code, we
only ever learn a true/false result. One authentication covers a 5 minute
window, and there is a Lock button to end it early.

**Local only.** Binds to `127.0.0.1`, rejects non-local connections, rejects
cross-origin requests, and requires a per-run random session token that only
the served page knows. Another process or a random browser tab cannot drive it.

**Reported but never deletable.** Some large things are shown with an
explanation instead of a button, because deleting them by hand is unsafe:

- *Telegram's message database.* The multi-GB file is live SQLite holding your
  chat history, not a media cache. That is why Telegram's own cleaner reports
  only a few hundred MB. Shrink it inside Telegram by logging out an unused
  account.
- *Simulator device directories.* Managed by `simctl` and hardlinked against
  runtimes. Use the Simulators panel, which calls `simctl` properly.

## Tests

```sh
node test.js
```

Asserts that the gate refuses system paths, home directories, project roots,
rule containers, traversal attempts, symlink escapes and malformed input, while
still allowing genuine artifact directories. **Run this after any change to
`safety.js`.**

## Files

| File | Purpose |
|---|---|
| `diskclean` | Launcher script |
| `server.js` | HTTP server, scanning, deletion endpoints |
| `safety.js` | Allowlist rules and the validation gate |
| `auth.js` | macOS native authentication |
| `index.html` | The GUI |
| `test.js` | Safety tests |

## Adding a rule

Add to `PROJECT_RULES` (a named subpath inside projects) or `ABSOLUTE_RULES`
(a specific cache directory) in `safety.js`. Set `safe: false` and write a
`note` for anything a build might still need. Then run `node test.js`, which
automatically asserts your new rule's base directory is itself protected.
