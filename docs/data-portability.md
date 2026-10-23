# Moving data between devices

I want a stopped copy of your data folder to open without asking you to repair unchanged chats. Neconyan checks the folder's placement at startup and reconnects tracked chats, character cards and groups whose bytes still match their saved records. Their identities and saved history stay intact. Jobs still running when you stopped the server may need rerunning, particularly those tied to other files.

## One copy, several screens

Run one Neconyan server and open it in each device's browser. Both screens use the same data, so there's nothing to synchronise. The server must stay awake and reachable. The [phone setup instructions](../README.md#opening-it-on-your-phone) cover your home network; away from home, use an authenticated HTTPS connection or a private network.

The Android APK's server only accepts connections from its own phone. It can't currently be the shared server for your desktop. A normal installation, including one in Termux, can accept network connections when configured for them.

## Taking a stopped folder elsewhere

1. Finish saves, imports and other running work, then stop Neconyan on both devices. Closing a browser tab doesn't stop the server.
2. Keep a backup. Copy the complete data folder, including its private tracking directories, without merging it with a separately edited copy. Keep the server configuration too, adjusting machine-specific paths on the destination.
3. Start only the destination. Startup checks unchanged tracked files against their saved content before reconnecting them to their new filesystem identities. The first start after a move reads those files, so a large library can take longer.
4. Check your chats before retiring the old copy. To move back, stop again and transfer the latest complete folder. Don't resume editing the older copy.

A dual-boot computer can use one external-drive folder in this way, with only one installation running at a time. Separate offline devices still need local copies. This change doesn't add a sync service or merge histories.

On Termux filesystems that report a changing creation timestamp, a verified clean handoff selects a stable file-identity policy before reconnecting the files. Every protected account must have recorded placement evidence proving a real filesystem move, unchanged tracked content and no unfinished writes or resets. The policy marker travels with the complete data folder, so restarts and later return trips retain it. Windows continues to use its native file identities.

If a clean handoff cannot be verified, Termux keeps the older identity mode and reports a warning. Keep both copies and follow the recovery instructions below before editing; on affected filesystems, saving under the older mode can fail. In-place data, incomplete tracking records and already-failed saves are not automatically converted.

## When recovery is still needed

Changed or missing files, unsafe links, unfinished saves and damaged tracking records aren't automatically accepted. An interrupted write's journal, which records the write's progress, also keeps its file protected. Existing records from older versions only reconnect automatically when the tracked files consistently indicate that the whole folder moved; a partly replaced folder can still need repair.

If Neconyan started before the transfer finished, stop it and copy the complete folder again from the source, including its tracking records. Adding only the late files may not clear the error.

If startup can't reconnect your files, preserve both copies and open **Settings → System & Device → Import & Restore → Repair transferred data**. Use **Check transferred data**, read its report, then **Back up and repair** if the files on disk are the versions you want. Repair replaces the old tracking state and invalidates earlier accepted work. It can't reconstruct missing or corrupt content. Use **Reload repaired account** afterwards.

Don't remove the tracking directories or chat markers to clear an error. They link your chats to their saved history and accepted work.

## Git and folder-sync tools

Stop both servers before copying, pulling or syncing. Transfer one complete, consistent version of the folder and choose one active copy. A Git checkout that replaces individual files in the existing folder can still require repair even if their text looks unchanged. Two independently edited copies have no automatic conflict resolution, and a consistent older copy can still be older: passing integrity checks doesn't prove it contains the latest edits.

Don't merge the private tracking records by hand. Keep runtime lock directories out of transfers, and retain recovery backups separately. A whole-folder repository includes credentials such as saved API keys, so keep it private. Never point two running servers at the same writable folder, including through different mount paths.
