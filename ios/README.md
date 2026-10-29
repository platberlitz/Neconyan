# Standalone Neconyan for iOS

I wanted the server and the chats on the iPhone itself. This app bundles Node.js, Neconyan's server and its interface, with private on-device storage. You don't need another computer running Neconyan.

You still choose your own model provider. The app doesn't include a local language model or free API access.

## Installing it

If a release includes an iPhone build, its **unsigned device IPA** is the file ending in `-ios-unsigned.ipa` on the [releases page](https://github.com/platberlitz/Neconyan/releases/latest). Select that release's file in your sideloading tool, such as iloader. The tool signs it for your Apple account before installing it. `SHA256SUMS-ios` and `provenance-ios.json` let you check the file matches the release commit. If no IPA is listed, that release has no iPhone download; use the [browser setup](../README.md#opening-it-on-your-phone) or the test-build workflow below.

The 'iOS Release Build' GitHub Actions workflow makes it: it builds the IPA, runs a 13 GiB import and starts the app in Apple's iPhone simulator. Run it by hand on any branch for a test build; the files are under **Artifacts** as `ios-release-<commit>`, for signed-in GitHub accounts only.

You'll need iOS 17 or later. A free Apple account normally needs its signature refreshed every seven days and has a three-app limit. Keep the same signing identity and app identifier when updating so iOS can keep the app's data. Export an account backup before changing signing tools or removing the app; deleting the app deletes its private data too.

The build isn't an App Store release. Simulator checks don't replace testing on your own iPhone.

## What to expect

- Characters, chats, settings and imported files stay in the app's private storage. Updates replace the bundled server separately from your data.
- Imports carry on in the background. While the local server has work (an import, a server-side reply, memory upkeep), the app plays silent audio so iOS keeps it running with the screen locked, and stops once the server has been idle for 30 seconds. That's what the 'audio' background mode is for, which is also why this build isn't headed for the App Store.
- Backup ZIPs picked through the app's own picker are copied straight into its storage, so the page never uploads them. The server then starts the import itself, so it doesn't matter if the page is paused. Leave about twice the backup's size free while it's copied in.
- Replies written in the page keep going too. If you leave mid-reply, the page plays its own silent sound until the reply is written, saved and any Agents after it have run, then stops 15 seconds later. 'Neconyan is finishing a reply' can show on the lock screen meanwhile, and music from another app may pause until it's done.
- iOS can still end the app under memory pressure. If that happens mid-import, reopen it and start the import again.
- File inputs use the system picker. Downloads open the share sheet, where you can save to Files.
- External links open outside the app. The embedded browser connects only to Neconyan's password-protected loopback server, which isn't exposed to the local network.
- Server plugins and automatic extension updates are disabled. Extensions requiring a shell or a separate executable won't work inside the iOS sandbox.
- Local embedding, speech and image models haven't been validated on an iPhone. Use a provider-backed option if you need those features.

If startup fails, use 'Share startup log' on the startup screen. Logs can contain request details; check them before posting publicly.

## Building on a Mac

Use an Apple Silicon Mac with Xcode, Node.js 24 and XcodeGen. Start from a clean, committed checkout:

```sh
npm ci --ignore-scripts
node scripts/build-ios-payload.js
bash ios/prepare-runtime.sh
sips -z 1024 1024 ios/generated/Assets.xcassets/AppIcon.appiconset/icon.png
xcodegen generate --spec ios/project.yml
xcodebuild -project ios/Neconyan.xcodeproj -scheme Neconyan \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

The workflow contains the packaging and simulator commands. Generated payloads, downloaded frameworks and build output aren't committed.

## Runtime compatibility

The framework is fogtape's Node.js Mobile 24.22.1 build, pinned by its archive checksum. It uses an interpreter on iOS and doesn't need a special JIT entitlement. Node.js and polywasm licences are included in the payload.

JSON tokenisers use the existing JavaScript implementation on iOS. SentencePiece keeps its original implementation, with a build-time transformation of its pinned binary: atomic memory operations are replaced only after checking that its memory is private and non-shared. The transformation rejects unknown binaries and checks all seven bundled models against the original. Other platforms keep their existing dependencies.
