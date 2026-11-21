# Neconyan for Android

For installation and usage questions, read the [Android guide in the official handbook](https://platberlitz.github.io/neconyan-docs/start/android/).

This app runs Neconyan's server on your phone or tablet. It includes Node.js and the web
interface; Termux and a separate server are not required. Model access is still
your own: connect to a supported API or model service in Model → Connections.
No model weights, API keys or credits are included.

## Install and use

Install the signed APK ending in `-android-arm64.apk` from the latest release on
an Android 11 or newer phone with a 64-bit ARM processor. Android asks you to allow
installation from the app opening the APK. The x86_64 download is for compatible
devices and emulators. There's no APK for 32-bit Android. Allow about 2 GiB of free
storage for installation and data.

Android System WebView, the system component that displays the interface, must be
version 124 or newer. I check this before starting the server: an older WebView
gets update instructions instead of an endless loading screen. Update it through
your phone's app store or system updater, then reopen Neconyan.

The first opening unpacks the server and can take a few minutes. Later openings
reuse the installed files. Chats, characters and settings stay in private app
storage. Use Neconyan's export and backup controls to save copies outside the app.
Uninstalling Android apps deletes their private data; export a backup first.

The ongoing notification opens Neconyan or stops its local server. On Android
13 or newer, allow notifications if you want that Stop button. If you don't,
press Back from the workspace to choose whether to keep running or stop. Reply
notifications are a separate opt-in in Settings. Leave the server running while
replies or imports are in progress. Android can still close the page or server
under memory pressure or battery restrictions. Reopening uses Neconyan's saved
workflow recovery; it doesn't automatically retry requests with unknown results.

Use 'Update APK' on the Server page or install a future official APK over the
existing app to retain data. Android may ask you to let Neconyan install updates.
An update replaces the
application files, while the separate data folder, server preferences and custom
extensions remain. If a newly bundled extension has the same name as a custom
global extension, its old copy is preserved under `Android extension backups` in
the account's Files folder and is included in account backups.
Use APK updates for the application itself. System shell commands, desktop server
plugins and BotSearcher's desktop Chromium launcher are not included. Providers
which call a separate local program need a reachable service instead. For large
backups, use 'Save a backup of my data' in Account or Server. It writes straight to
the destination you choose. Only exports generated in the page itself have a 1 GiB
limit. Paste an API key for OpenRouter rather than signing in from inside the app.

An early server crash gets one retry in safe mode, with background tasks paused.
If startup still fails, you can try again, save a backup or open the saved crash
reports. A requested server restart doesn't count as a crash. If the app says its
local port is already in use, 'Use a new port' keeps saved data, but can't move
unsaved drafts and preferences that live only on the old page.

## Build

Requirements: Node.js 24, npm, JDK 21 and an Android SDK containing platform 36,
build tools 36.0.0, NDK 28.2.13676358 and CMake 3.22.1. Set `JAVA_HOME` and
`ANDROID_HOME` for those installations.

From the repository root:

```sh
npm ci --ignore-scripts
npm run build:frontend
node scripts/build-android-payload.js
bash android/prepare-runtime.sh
cd android
./gradlew assembleDebug lintDebug
```

The payload builder copies tracked runtime files, the current built frontend and
locked production dependencies. It excludes user data, configuration and keys.
Regenerate it after changing application code or the package version. Generated
payloads, runtime binaries, SDKs and build output must stay untracked.

For an official build, supply a durable private signing key with alias `neconyan`:

```sh
export NECONYAN_KEYSTORE=/private/path/neconyan-release.jks
read -rs NECONYAN_STORE_PASSWORD
export NECONYAN_STORE_PASSWORD
./gradlew assembleRelease lintRelease
unset NECONYAN_STORE_PASSWORD
```

Keep the keystore and its password backed up outside the repository. Losing the
key prevents compatible updates to installed copies. Never publish or commit it.
The debug app uses a separate application ID and does not share release data.

### Release builds

I build the release from a clean commit. From the repository root, run
`node scripts/build-android-payload.js --release` before the signed Gradle build.
That rebuilds the frontend and records the commit, package version and frontend
manifest checksum inside the server payload. It refuses uncommitted changes.

The manual 'Android Release Validation' workflow uses the official key on staging,
main and hotfix branches. On other branches it uses a throwaway key for emulator
checks. Those APKs can't update an official installation. It checks both APKs'
signatures, manifest, bundled server and 16 KiB native alignment, and packages the
same commit as a source ZIP. Android 11, 13, 15 and 16 emulators check installation,
startup, background operation, deliberate stops and restarts, crash recovery and
data retention. The Android 16 run checks an actual 16 KiB page size. Android 11
and 13 also check the old-WebView screen before installing a newer WebView from
the Android 15 SDK image. Neconyan uses your device's WebView; it doesn't bundle one.

The first official release uses a fresh signing key. Earlier desktop-signed test
APKs need an exported backup and a reinstall; Android won't accept an update signed
with a different key. Future official APKs must keep this release key.

The server runtime is the full Android build of
[Node.js Mobile 24.21.0-0](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.21.0-0),
pinned by SHA-256 in `prepare-runtime.sh`. Its source and mobile patches are in
that release's linked recipe commit; the original Node.js licence and notices are
included in the APK as `assets/NODE-LICENSE.txt`. Neconyan remains AGPL-3.0.

Android 11 is the minimum because protected storage reads file identity through
`statx`. The embedded runtime targets older Android releases and otherwise
substitutes a changing timestamp for the file creation time. A small linked
binding supplies the real creation time for Neconyan's synchronous BigInt file
observations, including in worker threads. Most phones format their data
partition as f2fs without creation times; there the creation time is a constant
zero and file identity rests on the device and inode numbers, as it does on
desktop filesystems without creation times. Startup verifies a real file rename
before accepting any work.

## Verification

Run the repository's unit, server, lint and frontend budget checks before
building. Android lint checks the native app; install the produced APK on an
emulator or device and verify startup, private login, imports, exports, background
operation, stop/reopen and data preservation over an APK update. An emulator run
does not establish battery behaviour on every manufacturer's phone.
