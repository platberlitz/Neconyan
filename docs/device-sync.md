# Device sync

I added Device sync for separate Neconyan installations. If my phone and desktop already open the same server and account, their saved data is already shared. There's nothing to enable for that.

Open **Settings → Device sync** on either screen size. All four methods start off and stay independent. Turning one on permits a manual transfer; it doesn't start one. Nothing runs on a timer. Back up both installations before the first transfer.

## What I can share

- Character cards and their solo chats. The original character PNG stays intact, including embedded card data. Chat messages, swipes and custom metadata stay intact; local storage identity and generated integrity records are recreated on the receiving installation.
- Lorebooks.
- Prompt templates from Instruct, Context, System Prompt and Reasoning. These aren't API connection or generation presets.
- Persona names, descriptions, position, depth and role, together with their avatar images.
- PNG, JPEG, WebP and GIF backgrounds.
- Text size, chat width and blur. I deliberately kept this small rather than copying every setting onto another device.

Choose the categories and press **Save categories** before sharing. The selection also controls what that installation accepts. Chats must include their character card; personas must include their avatar.

A chat with a locked persona or a message using a local persona avatar also needs that persona and avatar. Select **Personas and avatars** on the sending installation; I don't add an unchecked category behind your back. The receiver must select it too unless its required persona and avatar already match exactly. Persona transfers leave local titles, lorebook links, connections, appendices and active selections alone.

Conversation mode, group chats, local attachments, provider/connection presets and arbitrary extension data aren't supported here. A solo chat referring to a local file or image attachment stops the transfer rather than arriving with missing attachments. Use the existing account backup/import tools when those are what you need.

API keys, passwords, remembered sign-ins, sync connections, device identity, native paths, running tasks, locks and caches aren't portable data. They aren't copied from ordinary settings into a package.

## Shared passphrase

Save the same passphrase on both installations, at least 12 characters. I recommend a long, unique one. Keep it somewhere safe: there isn't a recovery key or a way to reset an old package's encryption.

Every method uses the same versioned encrypted package: AES-256-GCM authenticated encryption with a scrypt-derived key and a fresh random salt and nonce. A wrong passphrase or modified package is rejected before any imported file is written. Providers receive the encrypted package, not readable chats. The installations themselves can decrypt it, and the saved passphrase is held privately on their servers; someone with access to the server's files can access that data.

Changing the saved passphrase doesn't re-encrypt files already held by a provider. Keep the old passphrase until you've finished with those files, or start a new remote file/Gist with the new passphrase.

## Pick a method

### Encrypted file

Enable **Encrypted file**. Download the encrypted file, move it privately to the other installation and use **Import encrypted file** there. Enable file mode and save the same passphrase on the receiving installation too. Import merges the selected data; it isn't a wholesale account restore. To bring changes back, export from that installation and import on the first one.

Before an import, **Sync now**, recovery or a conflict choice, I save the current chat and wait for pending settings saves. When data changes, **Reload imported data** refreshes the page before I can edit again. That prevents an older page from saving over the imported settings or libraries. An uncertain transfer result also needs a reload; any unfinished transfer can then be recovered from Device sync.

### WebDAV

Enable **WebDAV** on both installations. Save the same complete HTTPS **file URL**, username and password or app password on each, then press **Sync now**. Create the parent collection on the WebDAV server first.

The server must return strong ETags, which identify a file version, and honour conditional PUT requests, which refuse to replace a version another device has changed. Missing version evidence or a refused conditional write stops sync. Neconyan doesn't retry with an unconditional overwrite. Redirects aren't followed; enter the final file URL directly.

### Secret GitHub Gist

Enable **Secret GitHub Gist**, save a GitHub token with Gist permission and leave the ID empty to use **Create secret Gist**. Creating one is a separate explicit action. Copy its ID to the second installation and save that installation's token and the same passphrase, then use **Sync now**.

Secret Gists are unlisted, not private. I only send encrypted content. Each transfer adds a uniquely named snapshot file; existing files and unrelated files aren't overwritten or deleted. GitHub keeps history too. Delete the whole Gist on GitHub if you want to remove the provider's retained copies.

Gist mode accepts up to **900 KiB encrypted per snapshot**, **32 retained sync files** and fewer than **90 total files**. Start a new secret Gist when it's full. Truncated replies, oversized files and rate limits stop sync; Neconyan never follows GitHub's raw-file URLs to work around them. Large collections need file mode, WebDAV or pairing instead.

### Direct pairing

Enable **Direct pairing** and save the same passphrase on both installations. On the receiving installation, enter its externally reachable URL and choose **Create pairing code**. Share the code privately, paste it into **Pairing code from the other installation** on the sending installation, save the connection and press **Sync now**.

Both installations must be running, and the receiver must be reachable from the sending server. Native phone installations can be outbound-only; a pairing code doesn't make them remotely reachable. HTTPS is preferred. Plain HTTP is accepted only for an explicitly configured local-network or loopback destination, and the exchanged content remains encrypted.

A code grants encrypted sync access to that account for 30 days, not account sign-in. There can be four live codes. Revoke a code in Device sync when you're finished; switching pairing off revokes all codes. Switching either method off or revoking a code stops subsequent phases of an active transfer too. A transfer that has already published a file isn't rolled back.

Neconyan's own basic authentication doesn't require putting my account password in the code. A reverse proxy with its own authentication may need an operator rule admitting only the exact pairing POST route. Don't exempt the whole API or the whole Device sync area. Host and IP admission still apply. The code itself is sensitive: anyone with it and the shared passphrase can exchange the selected data until it's revoked.

## Conflicts and interrupted transfers

I choose incoming character cards, avatars and personas before choosing a dependent chat. If a dependency changes during an interrupted transfer, recovery preserves the dependent copy as a conflict instead of attaching it to different data. Recovery and conflict choices still respect the selected categories.

Each package includes bounded content hashes for shared history, not modification times. An installation recognises a returning edit only against content it actually exported or previously accepted. Unknown differing content still needs my choice. Older or replayed snapshot sequences cannot replace later local work.

I don't pick a winner by date. A different existing file on the first transfer, or changes made on both sides since an accepted version, creates a conflict. Both copies stay saved, and **Conflicts and preserved copies** offers encrypted downloads, **Keep mine** and **Use incoming copy**. Download anything you want to keep before choosing. Resolved preserved copies remain available locally until I explicitly remove them. Removing them never removes the chosen current version. A newer conflict replaces an older review, but its older preserved copies remain available too.

Those preserved downloads are recovery packages. I can import one through **Encrypted file** on the same installation even after resolving and removing its local preserved copies. If it differs from the current version, it creates a new review rather than silently replacing it. Required original cards, personas and avatars travel with the preserved copy; I must select their categories before downloading it. Ordinary exports from this installation still count as self-replays; recovery packages don't disable that protection.

A replayed or older snapshot from an already seen device/target doesn't undo newer work. Deletions never travel: removing a card or chat on one installation doesn't delete it elsewhere. A missing local file that conflicts with a newer remote version needs a deliberate choice.

If a transfer stops part-way through, its recovery record is saved before publication. Enable its original method and use **Recover** before importing another package. Recovery doesn't overwrite a file edited locally since the transfer was planned; that becomes a conflict instead. An active reply, account reset or incompatible pending operation can stop publication safely. Finish or recover that work, then retry manually.

## Limits and connection failures

Each snapshot is limited to **1000 files**, **8 MiB per file**, **32 MiB expanded content** and **60 MiB encrypted request**. Images must be at most 64 million pixels. Unsupported names, links, damaged formats and oversized selections are rejected instead of silently publishing a partial export. Network requests time out after 20 seconds. Select fewer categories if a limit is reached.

Local recovery and preserved-copy storage is capped at 160 MiB. Download and remove resolved copies when it fills up.

Saved connection secrets aren't displayed again. The page shows connection status, the last result and imported/conflict counts. Authentication failures, conditional-write conflicts and rate limits need a manual retry after you've corrected the cause. Opening Device sync or saving a connection never contacts the provider.
