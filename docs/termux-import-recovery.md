# Termux ZIP import recovery

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

1. Stop the Termux Neconyan process with Ctrl+C. Do not clear application data or
   delete the protected storage directories.
2. Put the matching `src/termux-file-stats.js` from this fix in
   `.local-runtime/termux-import/termux-file-stats.js` and copy the installation's
   `src/runtime.js` beside it. This ignored folder keeps the backport separate
   from future Git updates. No dependency install is needed.
3. From the Neconyan installation directory, create a separate data folder and
   start it on an unused port, for example 5534:

   ```sh
   NECO_IMPORT_DATA=$(mktemp -d "$HOME/neconyan-import-XXXXXX")
   printf 'Recovery data folder: %s\n' "$NECO_IMPORT_DATA"
   node --import ./.local-runtime/termux-import/termux-file-stats.js server.js \
     --dataRoot "$NECO_IMPORT_DATA" --port 5534
   ```

4. Open `http://127.0.0.1:5534` and import the ZIP. The separate port also gives
   this instance separate browser storage, so old pending browser requests are
   kept with the original instance.

To reopen the recovery instance, use the same command with the printed data
folder path. Do not run `mktemp` again unless another empty instance is wanted.
Stopping this process and using the usual launch command returns to the original
data. Always use the command-line `--import` option for this recovery instance.
Ordinary launches do not enable the preload, so updating does not change the
identity rules of existing data.

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
