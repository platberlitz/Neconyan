# Termux ZIP import recovery

## Normal startup after updating

The standard Termux launcher (`./start.sh`) selects Node. New installations no
longer need a console snippet or special launch command. Normal Node startup
checks the data filesystem before opening protected
storage. If Node reports a changing timestamp as creation time, Neconyan records
and uses a stable identity policy. The server and its file-processing workers
use the same policy after restart and after later runtime updates.

For users of the recovery launcher, updating and running the usual launcher in
`~/Neconyan` continues the folder saved in `~/.neconyan-import-folder`, using port
5534. Their imported data stays in that folder; it is not moved or imported again.
An explicit `--dataRoot`, a custom configured data folder, global mode or another
installation keeps its own data choice. An explicit `--port` keeps that port.
Missing or invalid saved choices stop with an explanation instead of silently
opening an empty instance.

Ordinary native Termux startup also requests the wake lock. Android can still
terminate a process, so the saved folder and durable import records remain the
basis for restarting. Use `termux-wake-unlock` after stopping the server when the
lock is no longer needed.

Older protected data without a known identity policy is not silently rewritten.
If its runtime has the timestamp problem, startup keeps those records unchanged
and prints the recovery instructions below. A saved recovery folder is recognised
as the explicitly chosen compatibility instance. Its policy is recorded in
`_termux-file-identity.json` outside the account's imported files. Data marked for
Node compatibility must continue using Node rather than a forced Bun runtime.

## Backport for 1.2.1

Some native Termux Node builds report a file's last-change time as its creation
time. Writing or renaming a retained ZIP then changes what Neconyan sees as its
file identity. The import stops with:

> The retained upload was replaced or is incomplete. Its previous evidence was kept.

The optional Termux storage preload checks a temporary file before the server
starts. If its creation time follows its last-change time, the preload reports a
stable zero creation time for that filesystem. File size, contents, device,
inode, links and read-time change checks remain in force. A genuine creation
time is preserved. Bun, desktop runtimes and the APK's native adapter are left
alone. Node's `--import` option also loads it in child processes and workers.

The check covers the filesystem containing Termux's temporary directory. Keep
the installation and data in Termux's private storage. Other filesystems are
not normalised on the strength of this probe.

## Existing installations

Older saved identities may contain the changing timestamps. The preload does not
rewrite those records or reinterpret an accepted operation. A browser-console
reset cannot repair server file identity.

For a failed import on 1.2.1, use a separate recovery instance and import the
original SillyTavern/SillyBunny backup there. This keeps the current data,
pending work and retained uploads intact. The recovery instance begins with
fresh account settings; the backup importer brings across only the selected
libraries. Keep both data folders until the imported contents have been checked.

## Install the recovery tools

Place these files from the same version of this fix in
`.local-runtime/termux-import/` inside the Neconyan installation:

- `src/termux-file-stats.js`
- `src/termux-file-identity.js`
- `scripts/termux-import-folder.js`
- `scripts/start-termux-import.sh`
- A copy of the installation's `src/runtime.js`

The ignored tools folder avoids conflicts with future Git updates. No dependency
install is needed. Stop the current Neconyan process with Ctrl+C before starting
another copy on the recovery port.

## Resume an existing recovery instance

From the Neconyan installation directory, run:

```sh
bash .local-runtime/termux-import/start-termux-import.sh
```

The launcher finds the recovery folder containing saved account imports. It
remembers that choice in `~/.neconyan-import-folder`, outside the installation,
and reuses it on every subsequent run. If there is more than one possible
folder, it prints the available import keys and stops instead of guessing.
Unreadable records and a missing previously selected folder also stop the
launcher. Nothing is deleted or overwritten in the data folders.

The launcher acquires the Termux wake lock before starting Node on port 5534.
Open `http://127.0.0.1:5534`, reload the page, and use **Saved account imports** to
observe the saved import. An accepted import can resume on the server without
uploading the ZIP again. A wake lock reduces sleep interruptions; it does not
make the process immune to Android termination. After stopping the server, run
`termux-wake-unlock` when the wake lock is no longer needed.

If Neconyan stops, rerun the same launcher command. Reinstalling the application
may remove `.local-runtime`; reinstall the tools and run the launcher again.
The selected data folder and its saved choice remain outside the installation.

### If the setup command was run repeatedly

The earlier `mktemp` command created a new data folder on every run while
reusing port 5534. Fennec retained the previous import request for that address,
so the empty replacement instance replied **The saved application result was
not found**. Keep every recovery folder: an earlier one may contain the original
accepted operation and its uploaded ZIP.

The launcher can reconnect to the only folder containing saved imports. If it
lists several possibilities, read the pending key in **Debugger → Console**:

```js
console.log(JSON.stringify(Object.keys(localStorage)
    .filter(key => key.startsWith('neconyan-operations:') && key.includes(':account-import:'))
    .map(key => ({ scope: key, key: JSON.parse(localStorage.getItem(key)).key })), null, 2));
```

This reads browser records without changing them. Pass the relevant key to the
launcher with `--key IMPORT_KEY`. A key which does not match a folder is refused;
a conflicting existing saved folder choice is kept for inspection.

## First-time recovery only

When no recovery folder exists yet, explicitly create the first instance:

```sh
bash .local-runtime/termux-import/start-termux-import.sh --new
```

This creates `~/neconyan-import-recovery` and saves its path before launch.
Repeating the command reuses that folder. It never makes another random data
folder. The recovery account begins with fresh settings and imports only the
selected libraries. Use the ordinary launcher to return to the original data.

The APK starts its own server and uses a separate Android file-identity adapter.
An installation path under `/data/data/com.termux/files/home` identifies the
Termux server, even if the page is open in Fennec on the same phone.

## Verification

The normal Node suite includes the file-identity regression. To exercise the
recovery launch in real Chromium with simulated Termux timestamps, run from
`tests/`:

```sh
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 NECONYAN_TERMUX_IMPORT_RECOVERY_TEST=1 \
NODE_OPTIONS="--import $PWD/termux-ctime-fixture.js --import $PWD/../src/termux-file-stats.js" \
npx --no-install playwright test termux-import.e2e.js --workers=1 --reporter=line
```

These tests use disposable data and check upload, publication and readback after
a process restart. The desktop and touch Chromium checks simulate the affected
filesystem; they do not establish physical-device or Fennec compatibility.

Automatic startup and recovery-to-normal-start upgrade checks use
`termux-startup.e2e.js` with `NECONYAN_TERMUX_AUTO_START_TEST=1`, the same disposable
opt-in, and only `termux-ctime-fixture.js` in `NODE_OPTIONS`. Set
`NECONYAN_TERMUX_V121_ROOT` to an owned v1.2.1 checkout with its own dependencies
and the original 1.2.1 recovery preload to include the real version-upgrade cases.
No compatibility preload is supplied to the updated server in those cases.
