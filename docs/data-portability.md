# Moving data between devices

I want a stopped copy of your data folder to open without asking you to repair unchanged chats. Neconyan checks the folder's placement at startup and reconnects tracked chats, character cards and groups whose bytes still match their saved records. Their identities and saved history stay intact. Jobs still running when you stopped the server may need rerunning, particularly those tied to other files.

## One copy, several screens

Run one Neconyan server and open it in each device's browser. Both screens use the same data, so there's nothing to synchronise. The server must stay awake and reachable. The [phone setup instructions](../README.md#opening-it-on-your-phone) cover your home network; away from home, use an authenticated HTTPS connection or a private network.

The Android APK's server only accepts connections from its own phone. It can't currently be the shared server for your desktop. A normal installation, including one in Termux, can accept network connections when configured for them.

## Taking a stopped folder elsewhere

1. Finish saves, imports and other running work, then stop Neconyan on both devices. Closing a browser tab doesn't stop the server.
2. Keep a backup. Copy the account data folder and its private tracking directories without merging it with a separately edited copy. Once the server has stopped, leave the device-local `.neconyan-root-owner` directory and transient runtime locks on the source. Don't transfer an active offline repair: finish or resume it first and keep its backup separately. Keep the server configuration too, adjusting machine-specific paths on the destination.
3. Start only the destination. Startup checks unchanged tracked files against their saved content before reconnecting them to their new filesystem identities. The first start after a move reads those files, so a large library can take longer.
4. Check your chats before retiring the old copy. To move back, stop again and transfer the latest complete account data. Don't resume editing the older copy. If you already copied an ownership record and startup reports a foreign or stale owner, stop every server using both folders and follow the status and owner-recovery instructions below; don't delete it by hand.

A dual-boot computer can use one external-drive folder in this way, with only one installation running at a time. Separate offline devices still need local copies. This change doesn't add a sync service or merge histories.

On Termux filesystems that report a changing creation timestamp, a verified clean handoff selects a stable file-identity policy before reconnecting the files. Every protected account must have recorded placement evidence proving a real filesystem move, unchanged tracked content and no unfinished writes or resets. The policy marker travels with the complete data folder, so restarts and later return trips retain it. Windows continues to use its native file identities.

If Termux cannot verify a clean handoff on an affected filesystem, keep both copies, stop any running server and follow the offline recovery instructions below before editing. The older identity mode can fail to save. In-place data, incomplete tracking records and already-failed saves are not automatically converted.

## When recovery is still needed

Changed or missing files, unsafe links, unfinished saves and damaged tracking records aren't automatically accepted. An interrupted write's journal, which records the write's progress, also keeps its file protected. Existing records from older versions only reconnect automatically when the tracked files consistently indicate that the whole folder moved; a partly replaced folder can still need repair.

If Neconyan started before the transfer finished, stop it and copy the complete folder again from the source, including its tracking records. Adding only the late files may not clear the error.

If the app opens but can't reconnect your files, preserve both copies. If Termux warns that its older identity policy can't safely save, stop and use the offline repair below first. Otherwise open **Settings → System & Device → Import & Restore → Repair transferred data**. Use **Check transferred data**, read its report, then **Back up and repair** if the files on disk are the versions you want. Repair replaces the old tracking state and invalidates earlier accepted work. It can't reconstruct missing or corrupt content. Use **Reload repaired account** afterwards.

If startup stops or warns that an older Termux data folder needs a stable file-identity policy, check and repair it offline before editing. The app may be unavailable until the repair completes. From the affected Termux Neconyan installation directory, with every Neconyan server using this folder stopped, run the commands below with Node 24. Replace `DATA_ROOT` with the complete data folder and `BACKUP_ROOT` with a folder outside it, on a filesystem with enough free space. The backup includes private data and credentials; keep it private.

```sh
node scripts/repair-data-identity.js check --dataRoot "DATA_ROOT" --backupRoot "BACKUP_ROOT"
```

Read the report, including skipped or invalid files and the consequences for saved work. Only if these are the files you want to keep, copy the check token from the report and run:

```sh
node scripts/repair-data-identity.js apply --dataRoot "DATA_ROOT" --backupRoot "BACKUP_ROOT" --token "TOKEN"
node scripts/repair-data-identity.js resume --dataRoot "DATA_ROOT"
```

The repair backs up the folder, rebuilds affected account tracking and changes the root's identity policy. It preserves the account identities but gives repaired resources new tracking identities and invalidates earlier accepted work. A fresh process verifies the result before normal startup is allowed. If a repair is interrupted, keep the original folder and backup and run `node scripts/repair-data-identity.js status --dataRoot "DATA_ROOT"`. If the report shows `prepared` or `publishing`, run `resume` as above; if it says to run `resume` again, run it in a new process to verify the repair. If the report says the operation needs inspection, preserve everything and seek help. Don't remove the repair records or edit the policy marker by hand.

If the status report shows a leftover ownership record after a server or repair was interrupted, first make sure **every** Neconyan installation using this folder has stopped, including older versions. Copy the ownership token from the status report and run the following only after checking that no server is using the folder:

```sh
node scripts/repair-data-identity.js recover-owner --dataRoot "DATA_ROOT" --token "OWNER_TOKEN" --allServersStopped yes
```

This rechecks the exact ownership record and refuses a live or changed owner. If it refuses, preserve the folder and seek help rather than removing the lock by hand. Once any interrupted repair has completed, start Neconyan, save a test edit, restart it and check the edit before transferring the folder again.

If a protected identity or ledger is unreadable or missing, the offline check may be unable to repair it. Preserve the complete failed folder and its backup and restore a known complete stopped snapshot; repair can't reconstruct missing authority or corrupted content.

Don't remove the tracking directories or chat markers to clear an error. They link your chats to their saved history and accepted work.

## Sync a data folder with GitHub

Git can carry one stopped data folder between a computer and Termux on Android. You need Git and a GitHub account on both devices, and a **private** repository for the data. Keep the Neconyan application and its data in separate repositories: this is a repository for the data folder, not the Neconyan source. GitHub's private repositories still contain readable data for anyone with access to them, so check the staged files before each push. Chats, attachments, settings, account information and extension data can all be sensitive. Keep an independent backup outside the repository.

GitHub [blocks ordinary Git files larger than 100 MiB](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) and limits a [single push to 2 GiB](https://docs.github.com/en/get-started/using-git/troubleshooting-the-2-gb-push-limit). Retained imports, uploads or backups in your data folder can be larger. This recipe and its byte check don't support Git LFS pointers; using LFS needs a separately configured and verified transfer on every device. If a push fails or a required file is too large, keep the local data and backup intact. Don't delete an operation journal or retained file to make the push pass. Use one reachable server or arrange another complete byte-preserving transfer before continuing on another device.

Use one active copy at a time. Finish replies, saves, imports and other jobs, then stop both Neconyan servers before committing, pulling or copying the data. Closing a browser tab doesn't stop the server. Don't use an old installation while another copy is active. Git doesn't merge independently edited protected tracking records safely; see [If both copies have changed](#if-both-copies-have-changed).

### Choose what travels

Keep the complete account folders and their settings, chats, characters, groups, lorebooks, personas, presets, attachments, extensions, jobs and other durable data. Include the root `_storage`, `_roleplay`, `_roleplay-recovery` and `_termux-file-identity.json` when present. The tracking records, repair history and policy marker belong with the account. Keep unknown extension files until you have checked what they contain; don't use the application repository's ignore rules, which can exclude chats.

Decide whether you want your saved API keys to travel before staging any files. The example below includes each account's `secrets.json` in the private repository so connection profiles keep referring to the same keys on each device. **That uploads your API keys to GitHub**, where they may be stored in plaintext unless you separately configure secrets encryption. Anyone with access to the repository can obtain them. If you don't want that, use the local-keys option below instead.

The following example `.gitignore`, at the **data root**, keeps known device-local files out of a new data repository:

```gitignore
/cookie-secret.txt
/_auth/sessions.json
/_auth/passkeys.json
/heartbeat.json
/crash-reports/
/neconyan-botsearcher/.cursor-key
/_webpack/
/*/backups/secrets_migration_*.json
**/.neconyan-chat-*.lock/
**/.neconyan-chat-*.lock.owner
/*/entity-date-added.json.lock/
/*/entity-date-added.json.lock.owner
/*/entity-last-chat.json.lock/
/*/entity-last-chat.json.lock.owner
/.neconyan-root-owner/
/_neconyan-policy-repair/
/_neconyan-policy-repair-preparing-*/
/_neconyan-policy-repair-complete-*/
```

To keep API keys out of Git, add this line to `.gitignore` before staging:

```gitignore
/*/secrets.json
```

Enter the keys on each device and check the selected key in each connection profile after a transfer: profiles can refer to a key by its device-local ID, so a newly entered key may need selecting again after each swap. To retain the same key IDs without putting keys in Git, you can securely copy each account's `secrets.json` separately to the matching account on the stopped destination. Back up any destination secrets first and repeat the secure copy when the keys change. An encrypted secrets file also needs its passphrase configured separately on the destination.

Remembered sessions and passkey registrations stay local, so sign in or enrol a passkey separately. Configuration such as `config.yaml`, server paths and basic-auth settings is configured on each installation. Use a secure method to provide any secrets-encryption passphrase to the destination. The local files in the example don't need to travel.

The list is a starting point, not a detector for all secrets. Connection headers, extensions, imports and backups can contain credentials too. Check what you intend to publish. An ignore rule doesn't remove a file already tracked or erase it from Git history. If a real repository already contains credentials or local state, preserve it and its history while you make a separate, reviewed clean copy; don't silently rewrite its history. Never transfer a folder while an offline identity repair is in progress, even though its local repair files are ignored. Finish or resume it first and keep its backup separately.

### Create the first copy

1. Stop Neconyan and make a separate backup of the complete data folder. Create an empty private GitHub repository with no initial README or other files. Set up Git authentication on both devices without putting a token in the data folder or remote URL.
2. In the existing data folder, create `.gitattributes` containing the line below. It tells Git to retain file bytes, including line endings:

   ```gitattributes
   * -text
   ```

   Add the reviewed `.gitignore` above. If either file already exists, inspect its rules rather than overwriting it. Nested `.gitattributes`, `.git/info/attributes`, filters and Git LFS can override the intended handling. Don't use filters, LFS pointers, submodules or nested repositories for account data unless you have separately arranged and checked all of their content.
3. Open a terminal in the data folder and initialise its own repository:

   ```sh
   git init -b main
   ```

   If Git says the filesystem doesn't record ownership or reports dubious ownership, trust only this exact data folder. For example, on a Windows external drive, replacing the example with the folder's full path:

   ```sh
   git config --global --add safe.directory 'E:/Neconyan-data'
   ```

   Don't use `*`. Then, from the data folder, turn off line-ending and file-mode conversion for this repository and connect your empty GitHub repository. Replace `REPOSITORY_URL` with its GitHub URL:

   ```sh
   git config core.autocrlf false
   git config core.filemode false
   git remote add origin REPOSITORY_URL
   ```

4. Review `git status --short --untracked-files=all` and `git ls-files --others --ignored --exclude-standard`. Check that all required account and tracking files are included and that ignored files are only the local items you chose. Global and nested ignore rules can hide files too. If the status doesn't account for your expected files, fix the rules before continuing. Stage and review your chosen data, then commit and push it:

   ```sh
   git add -A
   git diff --cached --name-only
   git commit -m 'Save Neconyan data'
   git push -u origin main
   ```

   Inspect staged content where needed before committing. Don't push if a key or another file you meant to keep local is staged. Git retains committed content in history even if you delete the file later.
5. On another computer, make a fresh checkout with conversion disabled **before checkout**:

   ```sh
   git -c core.autocrlf=false clone REPOSITORY_URL neconyan-data
   ```

   Set `core.autocrlf` to `false` and `core.filemode` to `false` in that new repository too. Configure that installation to use the new data folder. For Android shared storage, use the linked-worktree method below instead of placing Git's administration files there.

An existing folder that was checked out with line-ending conversion may already differ from the committed bytes even when `git status` looks clean. Keep both the existing folder and a backup. Create a fresh checkout with conversion disabled and verify its bytes as below; don't renormalise, reset or overwrite the only copy of an account to fix this. Keep both until you have checked which copy contains the work you want.

### Android shared-storage worktree

Keep the Neconyan installation and Git administration in Termux's internal home. A linked worktree lets the data itself live in Android shared storage. Install Git in Termux, grant Termux storage access, and choose a new, empty path in shared storage. These commands use `~/neconyan-data.git` for Git administration and `/storage/emulated/0/neconyan-data` for the data. Replace `REPOSITORY_URL` with your private repository URL; don't use an existing data folder as the worktree destination.

```sh
git -c core.autocrlf=false clone --bare REPOSITORY_URL ~/neconyan-data.git
git -C ~/neconyan-data.git config core.autocrlf false
git -C ~/neconyan-data.git config core.filemode false
git -C ~/neconyan-data.git worktree add -b phone /storage/emulated/0/neconyan-data main
```

If Git reports dubious ownership for the shared-storage worktree, trust only that exact path for your user, then retry the command:

```sh
git config --global --add safe.directory /storage/emulated/0/neconyan-data
```

Don't set `safe.directory` to `*`. In the Termux Neconyan installation's `config.yaml`, set `dataRoot: /storage/emulated/0/neconyan-data`, and keep its application files and config in Termux internal storage. If you prefer a launch argument instead, start it from the installation directory with `bash start.sh --dataRoot /storage/emulated/0/neconyan-data`. You may use another absolute path; use the same exact path in the trust command and data-root setting. The Android APK has its own private server storage and isn't the Termux worktree in this example.

### Check the checkout bytes

Before the first start on a receiving device, compare every tracked file's actual bytes with the committed blob. Run this from the data folder in Bash, including Git Bash on Windows. It reports missing files, links, submodules and different bytes. It can take a while for a large library:

```sh
(
    list=$(mktemp) || exit 1
    trap 'rm -f "$list"' EXIT
    git rev-parse --verify HEAD >/dev/null || exit 1
    git diff --cached --quiet --exit-code HEAD -- || {
        echo 'The index differs from HEAD; inspect the staged changes first'
        exit 1
    }
    git ls-tree -r -z --full-tree HEAD > "$list" || exit 1
    [ -s "$list" ] || { echo 'No tracked files to check'; exit 1; }
    failed=0
    while IFS= read -r -d '' record; do
        meta=${record%%$'\t'*}
        file=${record#*$'\t'}
        read -r mode type expected <<< "$meta"
        if [ "$type" != blob ] || { [ "$mode" != 100644 ] && [ "$mode" != 100755 ]; }; then
            printf 'Unsupported Git entry: %s\n' "$file"
            failed=1
            continue
        fi
        parent=$file
        while [[ "$parent" == */* ]]; do
            parent=${parent%/*}
            if [ -L "$parent" ]; then
                printf 'Linked parent: %s\n' "$parent"
                failed=1
                continue 2
            fi
        done
        if [ ! -f "$file" ] || [ -L "$file" ]; then
            printf 'Missing or unsafe: %s\n' "$file"
            failed=1
            continue
        fi
        actual=$(git hash-object --no-filters -- "$file") || { failed=1; continue; }
        if [ "$actual" != "$expected" ]; then
            printf 'Bytes differ: %s\n' "$file"
            failed=1
        fi
    done < "$list"
    if [ "$failed" -eq 0 ]; then
        echo 'Tracked files match HEAD'
    else
        echo 'Keep both copies and inspect the differences'
        exit 1
    fi
)
```

This checks tracked files against the current commit; it doesn't prove that every required file was tracked or that this commit is the newest copy. It also doesn't detect every pair of names that collide on a case-insensitive filesystem. Check for colliding names before transferring between filesystems, including names that differ only in letter case. Keep a backup and resolve collisions through Neconyan on the source, or choose a destination filesystem that can retain both names. Don't rename protected tracking files by hand. Review the tracked, ignored and untracked files as described above. If any bytes differ, don't start the receiving server or repair away the difference. Preserve both copies and find the cause first.

### Move to the other device

1. Finish work and stop the source server. Check the data repository status, review the changes and ignored files, then `git add -A`, review the staged files and commit. Push the commit with `git push`; for the Termux `phone` worktree above, use `git push origin HEAD:main`.
2. Stop the destination server. Confirm it has no uncommitted work you need, then run `git pull --ff-only origin main` in its data worktree. The command refuses a divergent history instead of merging it. Check the receiving bytes using the procedure above.
3. Start only the destination server and check your chats, settings and selected connection keys. When moving back, repeat the same stop, commit, push, pull and start sequence in the other direction. Make sure each push succeeded before pulling on the other device.

### If both copies have changed

Keep both folders and their Git histories. Don't force-push, reset a copy, or hand-merge `_roleplay` or other private tracking records. Decide which complete version is the base you want to continue using, back up both versions, and separately export or import the content you need from the other copy. A successful integrity check says that a folder is internally consistent; it doesn't establish that it contains the latest edits. If a transfer was interrupted, stop both servers and restore a complete, known snapshot rather than combining files from different snapshots.
