# diskclean

A local web GUI for finding and safely reclaiming disk space eaten by
development work. Built for a Mac that keeps filling up with Gradle caches,
`node_modules`, Xcode build output, simulators, emulators and AI model weights.

Zero dependencies. One command to run. Every deletion needs your login password.

## Quick start

```sh
cd ~/bin/diskclean
./install.sh
```

Open a new terminal, then:

```sh
clean
```

That starts the server and opens the browser. `Ctrl+C` stops it.

### What install.sh does

Nothing outside your home directory, and no sudo:

1. Creates `~/bin/clean`, a symlink to the launcher.
2. Adds `export PATH="$HOME/bin:$PATH"` to `~/.zshrc` (or `~/.bash_profile`),
   only if `~/bin` is not already on your PATH.

It is safe to re-run: it reports what is already in place instead of duplicating
anything, and it refuses to overwrite an existing `clean` you created yourself.

If you would rather do it by hand:

```sh
ln -s ~/bin/diskclean/diskclean ~/bin/clean
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

### Options

```
clean                  Start and open the browser
clean --port 4200      Listen on a different port
clean --replace        Stop an existing diskclean and take over its port
clean --no-open        Start without opening a browser
clean --help           Show usage
```

`DISKCLEAN_PORT` works the same as `--port`.

### Already running?

Starting a second copy does not silently move to another port, because that
leaves orphaned servers you never notice. Instead it tells you what is there:

```
diskclean is already running on port 4173 (pid 84884).

  Open it:        http://127.0.0.1:4173
  Replace it:     diskclean --replace
  Use a new port: diskclean --port 4174
```

If the port belongs to a program that is **not** diskclean, it refuses and
leaves that process completely alone, even with `--replace`.

## What it finds

**Projects.** Scans your code directories for projects, then lists only
regenerable artifact directories inside each one: `node_modules`, `ios/Pods`,
`ios/build`, `android/build`, `android/app/build`, `android/.gradle`,
`android/app/.cxx`, `.dart_tool`, `.next`, `.expo`, `.turbo`, `venv`, and a
`build` directory when git confirms it is ignored.

Select a whole project in one click when you are done working on it, or select
every `node_modules` across all projects at once.

**Global caches.** Gradle version caches and wrapper distributions, Xcode
DerivedData and iOS DeviceSupport, Android NDK / system-images / build-tools,
CocoaPods, npm, Yarn, React Native and Metro.

**AI model caches.** Hugging Face hub (where diffusers and MFLUX keep model
weights), LM Studio models, PyTorch hub, uv, pip and Playwright browsers. LM
Studio models are listed individually as `publisher/model`, so you can drop one
model without touching the rest.

**iOS Simulators.** Grouped by runtime with per-group totals, so a whole iOS
version can be cleared at once, and flagging devices whose runtime is no longer
installed (they cannot boot, so they are pure waste). Deletion goes through
`simctl`, never by removing files.

**Android Emulators.** Every AVD with its size and how much is wipeable user
data. "Wipe" clears user data, snapshots and caches but keeps the AVD, so it
still exists and boots fresh.

## Where it looks for projects

It auto-detects, so copying the tool to another machine needs no edits. Any of
these that exist are scanned: `~/Documents/Github`, `~/Documents/GitHub`,
`~/Documents/git`, `~/Documents/Projects`, `~/Documents/code`, `~/Developer`,
`~/Development`, `~/Projects`, `~/projects`, `~/code`, `~/src`, `~/repos`,
`~/git`, `~/work`, `~/dev`, `~/workspace`, `~/AndroidStudioProjects`,
`~/StudioProjects`, `~/IdeaProjects`.

Duplicates are collapsed by inode, so on a case-insensitive filesystem
`Documents/Github` and `Documents/GitHub` are recognized as one directory rather
than scanned twice.

To override, either set an environment variable:

```sh
export DISKCLEAN_ROOTS="$HOME/work:$HOME/side-projects"
```

or create `~/.diskclean.json`:

```json
{ "roots": ["~/work", "~/side-projects"] }
```

Configured roots must be existing directories inside your home folder, so a
typo cannot aim the scanner at a system location.

## Running on another machine

Copy the directory and run `./install.sh`. Missing things are skipped rather
than treated as errors:

- Directories that do not exist are simply not listed.
- No Xcode (no `xcrun`) means the Simulators section is omitted.
- No `git` means `build` directories are never offered, since the "is it
  ignored" check cannot run. It fails closed, not open.
- No `pgrep` means rules that require an app to be closed are shown as blocked
  rather than offered unverified.
- Non-macOS: Trash is unavailable (permanent delete still works), and the disk
  reading falls back to your home volume.

## Safety

This tool deletes files, so the safety model is the point.

**Allowlist, not blocklist.** A path is deletable only if it matches an explicit
rule in `safety.js`. There is no code path that deletes an arbitrary path handed
to it. Anything not named in a rule is not deletable, no matter what the UI asks
for.

**Every deletion passes one gate.** `validateDeletion()` enforces all of:

- the path exists and is a real file or directory
- it is not a symlink, and contains no symlinked component (blocks alias escapes)
- it is not a protected system or home location
- it is not a container directory that a rule merely enumerates
- it is at least 3 levels deep
- no path segment is `.git`, `.ssh`, `.gnupg`, `.env`, `Keychains`, `CloudStorage`
- it resolves to a location strictly inside an allowlisted root for that rule

**Then a second, rule-specific check.** A project target must be the exact
artifact path of a genuinely detected project, and can never be the project
root. A cache target must sit at exactly the depth its rule declares, and match
that rule's name pattern.

**No shell string interpolation.** Deletion uses `fs.rm` with an explicit path.
Subprocesses use `execFile` with an argument array, so a path is never parsed by
a shell.

**Deletion method is an explicit choice.** The default is **permanent delete**,
because everything offered here is regenerable build output or a re-downloadable
cache, and Trash is counterproductive for it: Finder moves hundreds of thousands
of small files one by one, and no space is freed until you empty it. Trash stays
one click away in the confirmation dialog for anything you want to be able to
restore. Permanent delete always requires typing `delete` to confirm, and the
dialog states plainly which items are regenerable.

**Your login password is required.** Destructive endpoints refuse to run without
a live OS-verified authorization. Authentication uses the native macOS dialog
(Touch ID, falling back to your password). The password is never typed into the
web page, never sent over HTTP, and never seen by this code, we only learn a
true/false result. One authentication covers 5 minutes, and there is a Lock
button to end it early.

**Local only.** Binds to `127.0.0.1`, rejects non-local connections, rejects
cross-origin requests, and requires a per-run random session token that only the
served page knows. Another process or a random browser tab cannot drive it.

**Reported but never deletable.** Some large things are shown with an
explanation instead of a button, because deleting them by hand is unsafe:

- *Telegram's message database.* The multi-GB file is live SQLite holding your
  chat history, not a media cache. That is why Telegram's own cleaner reports
  only a few hundred MB. Shrink it inside Telegram by logging out an unused
  account.
- *Simulator device directories.* Managed by `simctl` and hardlinked against
  runtimes. Use the Simulators panel, which calls `simctl` properly.

## Performance

A scan shells out to `du`, whose cost tracks **file count, not bytes**. Measured
on a real machine: a 31 GB Hugging Face cache holds 66 files and sizes in 0.01s,
while `~/.cache/uv` holds 811,029 files and takes 15.5s on its own.

What that led to:

- **Project discovery** classifies each directory from the `readdir` result
  already in hand instead of issuing extra `access` calls, walks levels
  concurrently, and prunes asset directories. This removed ~390k syscalls.
- **Sizing** uses one `du -d 1` per parent rather than one `du -sk` per child
  (3.08s versus 5.00s on `~/.gradle/caches`), and project artifacts are batched
  into multi-path `du` calls made only after deduplication.
- **Child sizes are cached** per directory, keyed on the directory's mtime with a
  10 minute TTL, and invalidated on delete.

Result: about 14s on a rescan, 35s cold, on a machine with ~145 GB of
reclaimable material. Since mtime does not catch a file growing deeper inside a
tree, **Re-measure** forces a full walk when a number looks stale.

## Keyboard shortcuts

| Key | Action |
|---|---|
`R` | Rescan |
`E` / `C` | Expand / collapse all |
`D` | Deselect all |
`M` | Switch deletion method |
`Esc` | Close dialog |

They never fire while you are typing a confirmation phrase.

## Tests

```sh
node test.js
```

Asserts that the gate refuses system paths, home directories, project roots,
every rule container, traversal attempts, symlink escapes and malformed input,
while still allowing genuine artifact directories. Rule containers are derived
automatically, so adding a rule cannot silently create a hole. **Run this after
any change to `safety.js`.**

## Files

| File | Purpose |
|---|---|
| `install.sh` | Sets up the `clean` command |
| `diskclean` | Launcher script |
| `server.js` | HTTP server, scanning, deletion endpoints |
| `safety.js` | Allowlist rules and the validation gate |
| `auth.js` | Native OS authentication |
| `index.html` | The GUI |
| `test.js` | Safety tests |

## Adding a rule

Add to `PROJECT_RULES` (a named subpath inside projects) or `ABSOLUTE_RULES` (a
specific cache directory) in `safety.js`. Set `safe: false` and write a `note`
for anything a build might still need. Use `childDepth` when the useful unit is
nested (as with LM Studio's `publisher/model`). Then run `node test.js`, which
automatically asserts your new rule's base directory is itself protected.
