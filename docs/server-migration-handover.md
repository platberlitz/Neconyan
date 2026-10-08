# Full server migration: continuation

### 8 October: recover replacement ZIP imports and stale security tokens

Investigated on `codex/fix-replacement-zip-import`, based on staging `910356095`.
The reported upload-key conflict was reproduced in desktop and touch Chromium.
Explicit ZIP selections now verify their bytes, even when picker metadata is
unchanged. A confirmed byte conflict starts a separate retained upload; earlier
uploads remain saved, uncertain attempts keep their key, and accepted imports
keep their original request. Incomplete earlier uploads remain resumable.

ZIP uploads and the shared native-operation transport now refresh a rejected
CSRF token once, preserving the request and checking the account again before
retrying. Production API CSRF rejections return a recognisable, non-cacheable
JSON error; ordinary permission failures are not retried.

Verified with Node 24: all 442 Jest suites (5,744 passed, two skipped), all 1,960
server tests, root lint, frontend budgets and changed-test lint. All 25 account
import Chromium cases passed across two serial runs, including replacement ZIPs,
reselection/reinstall, production CSRF recovery, process death and page closure.
The full test-folder lint command still reports 31 existing errors in ten files
unchanged from staging. Before/after screenshots are in the ignored
`screenshots/{phone,desktop}-replacement-zip-{before,after}.png` files. Their
test archive deliberately contains a damaged card to retain the visible report.

The physical Fold/APK and Fennec remain unverified. The supplied screenshots
were inspected, but the recording could not be played; the cause of the user's
first interrupted attempt is therefore not established. Next action: review
the PR against staging and validate the resulting APK on the reporting device.

## Release preparation: 1.0.0

### 8 October: Guided Regenerate prepared for review

Branch `feat/guided-regenerate` starts from staging `b4a21ee23` in the isolated
`guided-regenerate` worktree. Guided Generations
1.8.0 adds Guided Regenerate beside Guided Swipe, with its own prompt, depth,
reset and visibility setting. It replaces the latest AI reply using the composer
instruction; empty input uses ordinary regeneration. The server owns the named
`guided.regenerate` replacement. The browser fallback shares Correction's recovery
and group-speaker handling, with chat-switch guards before submission and draft
changes. Input History and the seven guided buttons share one compact row. The controls
use 32px at the usual phone width, scaling down to 26px on narrow phones, with
tighter gaps and no clipping. The cache version is `20261008-guided-row`.

Verification on this base: all 442 Jest suites passed (5,756 tests, two skipped),
all 1,961 server tests passed, and root lint, changed-test lint and frontend
budgets passed. The full tests-folder lint has 31 errors in ten unchanged files.
Both Chromium browser tests passed at touch 393x852 with iPhone emulation and
desktop 1280x900: durable replacement, no retained old swipe, ordinary regeneration
with empty input, composer preservation, keyboard focus, six theme/accent
combinations per viewport and saved visibility/prompt/depth settings. The helper
row also stays on one line without overlap at widths 320, 375, 393, 600 and 768. Before/after
and settings screenshots are in the worktree's ignored `screenshots/` folder.
Safari/WebKit and physical phones were not tested; model replies used a local
fixture. Next action: review the PR against staging before merging.

### 8 October: 1.2.1 released from main, staging moves to 1.2.2

The official handbook was refreshed against the release candidate and published
at https://platberlitz.github.io/neconyan-docs/. Its strict build, link checks and
phone/desktop browser checks passed. Optional GitHub statistics requests now use
fixed responses in the browser tests, with a separate check for a refused request.

The first release browser run found stale help-revision expectations, a search
test filling an input while the previous navigation dialog still owned focus,
and a real Scratchpad sharing failure during an active note autosave. The help
and search tests were corrected in `f467dbf`. The shared note-saving path now
waits for an active save in `bb586c4`; a held-save browser regression and two
unit regressions cover joining a save and keeping account changes isolated.

`main` was fast-forwarded to `f467dbf67760d336d91a39c0aa33eebeb3248ae6`.
All 440 unit suites passed (5,717 tests, two skipped), along with 1,959 server
tests, 89 Mewmory tests, root lint, frontend budgets and the production build.
All 11 focused search/Scratchpad browser checks and 12 notebook recovery checks
passed. Android run `37718819351` passed the signed build and Android 11/15
emulator checks. The nine downloaded assets passed checksum, signing-record,
16 KiB alignment-record and APK payload/provenance checks; all 3,843 source ZIP
entries and file modes match a local archive of the release commit.

Neconyan 1.2.1 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.2.1 with the annotated
tag `v1.2.1` and nine assets. At the owner's request, it was published while full
browser run `37718820673` was pending, as stated in the release notes at the time.
All 16 groups have now passed on the published commit. One desktop Windows XP
wallpaper check initially read the default wallpaper; its failure screenshot
already showed the XP wallpaper. The original desktop/phone checks passed six
local repeats, and the failed CI group passed on rerun without a release change.
Staging commit `9764f34` makes the wallpaper assertion wait for the expected
computed style at selection and reload; both updated browser checks passed.
The release notes now record the completed results and initial failure. No
physical phone testing is claimed. Staging advances to `1.2.2`.

### 7 October: 1.2.0 released from main, staging moves to 1.2.1

Release E2E had not run on staging since 1.1.0, so the first run on the 1.2.0
candidate (`37480481087`) failed eight groups. Most were browser tests that had
not caught up with staging (the knowledge revision, the slimmer chat bar, the
smaller phone avatars, the rebuilt Persona page, Debugger being on by default
and the new Portuguese translations), but four were real bugs that never
reached a release: text-completion replies without a model name were refused
by the roleplay save (`b351e04`); a new Conversation branch copied with another
chat link ID never merged with the server copy, so the next Send did nothing
(`e6918c6`); Home refused to open while the composer held a draft (`e6918c6`);
and Scratchpad wrapped Miso, Taro and Nori under the fold button in a narrow
panel. Those are fixed in `9b2e0ba`, `5a22103`, `4496af9` and `e76bd76`. Later
runs each failed one to three groups on timing in the tests (late chat-load
steps, startup notices covering buttons, settings left in flight at teardown,
a background update check taking a planned failure, a store edit racing a page
save); each test was hardened and rerun locally. Pull requests #38 to #42 were
reviewed and squash-merged before the release.

`main` was fast-forwarded to staging `2de24c5` without a merge commit. All 435
unit-test suites passed (5,637 tests, two skipped), all 1,905 server tests and
89 Mewmory tests passed, and root lint, frontend budgets, the production build
and Bun server initialisation passed. Release E2E run `37556681748` passed all
16 browser-test groups. Android run `37556684322` passed the signed build and
Android 11 and 15 emulator lifecycle checks. The downloaded checksums,
provenance for `2de24c50a7c05e7c00e18745261bcc78ac0bf9dd`, signing-certificate
records (the same certificate as 1.1.0) and 16 KiB alignment checks were
verified. All source ZIP contents and file modes match a local `git archive` of
the release commit. Neconyan 1.2.0 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.2.0 with the annotated
tag `v1.2.0` and all nine release assets. It has not been tested on a physical
phone. Staging now moves to `1.2.1`, including the version displayed in the app.

### 4 October: 1.1.0 released from main, staging moves to 1.1.1

`main` was fast-forwarded to staging `11e64e3` without a merge commit. All 419
unit-test suites passed (5,413 tests, two skipped), all 1,819 server tests and
89 Mewmory tests passed, and root lint, frontend budgets and the production
build passed. Release E2E run `37176070881` then failed five groups, all from
browser tests that had not caught up with this release rather than app faults:
the Obsidian sync test for Notes depended on a hand-built local preview under
`/tmp`; the assistant tools test still expected 14 tools instead of 25 (the
Notes tools); the sidebar order test did not know about Notes; the relative
data root test's 'Home' region lookup also matched the new 'Home layout' bar;
and the sidebar sections test left a settings request in flight at teardown.
The message action layout test also failed in CI with the More menu collapsed
after its click, on short messages only. That one did not reproduce locally on
a Bun-served copy of the CI setup, so the cause is not proven; the test now
retries opening the menu until the action is visible. Android run
`37176072650` failed only because the emulator image download for Android 15
broke.

`e3b143e` brings those six tests up to date (the Obsidian test now starts its
own disposable server and fake client) and was fast-forwarded to `main`.
Release E2E run `37180167768` passed all 16 browser-test groups on the first
attempt, including Bun server initialisation. Android run `37180171690` passed
the signed build and Android 11 and 15 emulator lifecycle checks. The
downloaded checksums, provenance for
`e3b143e56976f5fcd0966660303800cf22692523`, signing-certificate records and
16 KiB alignment checks were verified. All source ZIP contents and file modes
match the release commit. Neconyan 1.1.0 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.1.0 with the annotated
tag `v1.1.0` and all nine release assets. It has not been tested on a physical
phone. Staging now moves to `1.1.1`, including the version displayed in the app.

### 2 October: 1.0.6 released from main, staging moves to 1.0.7

The first Release E2E run on staging `d5fe7f5` failed six groups, so `main`
was held back while three fixes and one test update landed on staging:
`466c8e2` stops Prompt Manager token counts from running `{{setvar}}` macros and
saving the open chat in the background (this set off group chat integrity
popups); `cff3662` updates browser tests for the tools that moved to full pages,
the eighteenth native extension (CSS Snippets) and partial settings reads;
`d139055` makes Dialogue Colors read back the regex block its save check
compares, which stops the repeated settings saves introduced by `76c5723` (they
caused 'Settings changed on another device' popups, refused account backups and
a refused Conversation reply); `068091a` keeps a loader shown just after startup
from being emptied by startup cleanup (an empty, unclosable popup on phones;
present since before 1.0.5).

`main` was then fast-forwarded to `068091a` without a merge commit. All 395
unit-test suites passed (5,030 tests, two skipped), all 1,572 server tests and
89 Mewmory tests passed, and root lint, frontend budgets, the production build
and Bun server initialisation passed. Tests-folder lint still reports 25
existing errors and 380 warnings that were already on staging before this
release; they did not block it. Release E2E run `36946470037` passed all 16
browser-test groups after one rerun of group 16: the sidebar sections test
reloaded before the debounced settings save carrying the Quick Actions section
state had fired. Staging `40b97c8` makes that test wait for the save first; the
app itself still has no settings flush when a page is closed within a second of
a change, which predates this release.

Android run `36946473578` passed the signed build and Android 11 and 15 emulator
lifecycle checks. The downloaded checksums, embedded payloads, provenance for
`068091aefe4bddcbcde5754e94c1190af911557c`, signing-certificate records and
16 KiB alignment checks were verified. All source ZIP contents and file modes
match the release commit. Neconyan 1.0.6 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.6 with the annotated
tag `v1.0.6` and all nine release assets. It has not been tested on a physical
phone. Staging now moves to `1.0.7`, including the version displayed in the app.

### 30 September: 1.0.5 released from main, staging moves to 1.0.6

`main` was fast-forwarded to staging at `3d5c367` without a merge commit.
All 373 unit-test suites passed (4,825 tests, two skipped), all 1,542 server
tests passed, and root lint, tests-folder lint, frontend budgets, the production
build and Bun server initialisation passed. Release E2E run `36687808683`
passed all 16 browser-test groups without a workflow rerun.

Android run `36687808404` passed the signed build and Android 11 and 15 emulator
lifecycle checks. The downloaded checksums, embedded payloads, provenance for
`3d5c367989730d2915df436cd2de7badf4be1a27`, signing-certificate records and
16 KiB alignment checks were verified. All source ZIP contents and file modes
match the release commit. Neconyan 1.0.5 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.5 with the annotated
tag `v1.0.5` and all nine release assets. It has not been tested on a physical
phone. Staging now moves to `1.0.6`, including the version displayed in the app.

### 30 September: 1.0.3 released from main, staging moves to 1.0.4

`main` was fast-forwarded to staging at `100f6b0`, then both branches received
`268bc57` to fix two browser checks: scroll the Agents Edit button into view
before checking its click target, and wait for colour transitions before
sampling accents. All nine focused browser tests passed. Release E2E run
`36589113980` passed all 16 batches after rerunning a dropped connection and a
browser screenshot capture failure. Unit tests passed after one connection
retry; all 1,503 server tests, root lint, frontend budgets and the frontend
build passed. The optional tests-folder lint still reports existing errors;
lint on the two edited browser tests has no errors.

Android run `36589135776` passed the signed build and the Android 11 and 15
emulator checks. The downloaded artifacts' checksums, provenance commit
`268bc5717835070126f64879a051b3f8a0ab7f7a` and unchanged signing certificate
were verified before publication. Neconyan 1.0.3 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.3 with the annotated
tag `v1.0.3`, both signed APKs, source ZIP, provenance and checksums. It hasn't
been tested on a real phone. Staging now moves to `1.0.4`.

### 29 September: 1.0.2 released from main, staging moves to 1.0.3

`main` was fast-forwarded to staging at `a645ddd` (no merge commit). Android run
`36502755050` passed the signed build and both emulator checks; the artifact's
checksums, provenance commit and signing certificate were verified before
upload. Release E2E run `36502749981` failed three tests on its first attempt
(two connection resets in `neconyan-roleplay-workflow-browser.e2e.js`, one
closed browser in `neconyan-rail-order.e2e.js`) and passed all 16 shards when the
failed shards were rerun. Neconyan 1.0.2 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.2 with the annotated
tag `v1.0.2`. It has not been run on a real phone yet. Staging now moves to
`1.0.3`.

### 28 September: Android hotfix 1.0.1, staging moves to 1.0.2

The 1.0.0 APK refused to start on real phones: Android formats f2fs without
file creation times, and startup demanded them. The emulators use ext4, which
has them. `032aead` on branch `hotfix/android-1.0.1` (cut from `v1.0.0`) uses a
constant zero creation time on such storage, so file identity rests on device
and inode as it does on desktop filesystems without creation times. Android run
`36439112215` passed the signed build and both emulator checks, and Neconyan
1.0.1 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.1 with the annotated
tag `v1.0.1`. It has not been run on a real phone yet. The hotfix branch is
merged into staging, which now moves to `1.0.2`. The Android workflow also
builds `hotfix/*` branches, for the next Android-only fix.

### 28 September: 1.0.0 republished with the rename

Neconyan 1.0.0 is published at
https://github.com/platberlitz/Neconyan/releases/tag/v1.0.0. The annotated tag
`v1.0.0` points at `a3ea905442c94a7d990acb1b069b5bbe6c6ca114`, which holds
the rename in `843bc83` and the 16-batch browser workflow in `a3ea905`. The
repository is public again. Main was deleted briefly, then recreated at
`a3ea905` and set back as the default branch; creating it did not trigger a
README mirror commit.

Android run `36432817753` on `a3ea905` passed the WebView fixture, the signed
build and the Android 11 and Android 15 emulator checks. The release assets are
that run's artifact: both signed APKs, the source zip, `SHA256SUMS` and
`provenance.json`. `sha256sum -c SHA256SUMS` and
`scripts/verify-android-release.py --commit a3ea905... --version 1.0.0` passed,
both APKs carry signing certificate SHA-256
`49ed1e770b8a5269a008ed0d4763dd19a499377e35c85eec798c554178c4826c`, and the
files downloaded back from the release matched the checksums. The owner chose
to skip the browser run for this release; a local run of the 23 browser files
the rename touched passed apart from two timing failures that also happen on the
commit before the rename.

The live service now sets `NECONYAN_USE_BUN=1` and `NECONYAN_BUN_SMOL=0`
instead of the old `SILLYBUNNY_*` names; systemd was reloaded without a
restart. Staging moves to `1.0.1` for the next release.

### 28 September: 1.0.0 published, then pulled

Neconyan 1.0.0 was briefly published with the annotated tag `v1.0.0` on
`303b792b8736ccf55d57aabe2bf07b5b3707511d`. The owner wanted the whole
Neconyan rename inside 1.0.0, so the release and the GitHub tag were deleted
the same day. Staging keeps version `1.0.0`; the rename, with first-start
migrations for every saved old name, lands on staging, and 1.0.0 is rebuilt and
republished from there. Main is still `8f567b1`, the README mirror workflow's
commit on top of `303b792`, which only adds the Android section to
`.github/readme.md`. Staging merged it back in `07f243f` so the next promotion
can fast-forward.

Android run `36379247096` on `303b792` passed all four jobs. The published assets are
that run's artifact: both signed APKs, the source zip, `SHA256SUMS` and
`provenance.json`. Before upload, `sha256sum -c SHA256SUMS` and
`scripts/verify-android-release.py --commit 303b792... --version 1.0.0` passed,
and an independent APK Signature Scheme v2 check found signing certificate
SHA-256 `49ed1e770b8a5269a008ed0d4763dd19a499377e35c85eec798c554178c4826c`
in both APKs. The files downloaded back from the release matched the checksums.

Browser run `36379238931` on `303b792` passed batches 1-6. Batches 7 and 8 failed on
three test timing problems, not application faults. Staging `0459c5b` fixed them:
the Send button was measured before it appeared, the app's own favicon refresh
replaced a test badge, and a mid-run push to main made the update notice cover the
cat ears. The workflow now removes the checkout's upstream so the server never
shows that notice during a run. The repository returned to private, so GitHub
Actions could not rerun. The owner reran the failed batches on his desktop against
`303b792` with the fixed tests; they passed after one more test-only repair,
`4b88f52`, which returns a settings revision from the retired-content save mock.

Those artifacts no longer match the release: the republished 1.0.0 needs a new
signed Android build and browser run on the renamed staging commit. Staging's
Android validation needs GitHub Actions or the signing key. No Oracle
application deployment or restart was performed.

### 28 September: rename finished for the republished 1.0.0

`843bc83` renames every remaining SillyBunny name in code, tests, launchers and
docs to Neconyan. README.md and `.github/readme.md` keep their history note, and
real links to `SillyBunnyTeam/SillyBunny-*` and `platberlitz/SillyBunny-*`
repositories stay because no Neconyan-named copies exist. The old
`SILLYBUNNY_*` environment names, the `sillybunny:` supervisor messages, the
`/api/sillybunny-conversation` routes and the old asset redirects are gone.

`src/legacy-name-migration.js` runs on every start before roleplay storage
opens. It moves old `extension_settings` keys, the Time Machine card marker,
disabled add-on entries and `accountStorage` keys in `settings.json`, bumps
`_version` and `_settingsRevision` so stale tabs cannot write old names back,
carries the Conversation automation acknowledgement forward, moves old world
book keys, renames `.sillybunny-write-recovery` journals and deletes old
temporary and lock files. Imported settings and world books pass through the
same rules; character cards and old export formats are still read. Bundled
agents saved with the old credit are rewritten in one library write. On a copy
of the owner's data the first start moved eight settings blocks and the second
changed nothing; user content such as `SillyBunnyGuide` stayed untouched.

The browser workflow now runs 16 batches of about 69 tests each instead of 8.
Each batch still uses one worker because every test shares one server and one
data folder.

### 28 September continuation: validation in progress

This release work started from staging `16687a0285b65ca9dcdd3f76c5bb66a5472f5063`, including
the Pura and Ethereal tracker themes added during this release work. Preserve that
commit and the later Agent fixes. The earlier release notes below are historical
checkpoints, not instructions to reset staging. Main remains at `86b5475f5`.

The first candidate was committed and pushed to staging as
`e294394c9b62188b47bf0c6c3f5411921b7e36ec`. Android validation run `36334373139`
and the eight-part browser run `36334373000` test that exact commit.
Neither main promotion nor release publication has taken place.
The runner and settings-fixture follow-up is pushed as `b94a0e9`; Android run
`36337607593` passed the signed app's server lifecycle checks on Android 11 and 15.
The screen check added in `adc2988` then exposed a separate Android 11 startup
failure. Diagnostics from `d573c77`, run `36338862101`, identify its stock WebView
83.0.4103.120 rejecting top-level await and logical assignment syntax. Android 15
loads the interface with WebView 124.0.6367.219. The app now checks for
WebView 124 before starting the server and gives native update instructions.
Its Android 11 test checks that screen first, then updates the emulator with the
WebView from the Android 15 SDK image and repeats the full acceptance checks.
That updated-WebView acceptance passed in run `36341009250` at `e50a6af`.
The guard is pushed in `71d2f29`. Its first Android 11 run reached the native update
screen but the test compared mixed-case labels against Android's uppercase buttons.
The test correction is pushed in `0a36b87`. Its next run stopped while exporting
the SDK WebView. Bounded export retries and diagnostics in `e50a6af` completed
successfully. All four jobs passed: signed build, SDK fixture, Android 11 and Android
15. Android 11 verifies the old-WebView update screen before installing the fixture;
both versions then verify the visible workspace and the server lifecycle checks.
These are emulator results, not physical ARM64 device results.

The web follow-up includes these further fixes:

- Account opens without waiting for the backup and reset history requests. Both run
  independently; failures appear in their own status areas. The held-request browser
  test confirms the profile opens within one second and Close remains usable.
- An Agent's Edit menu now appears above the category selector instead of losing
  clicks to it. Desktop and phone hit-testing and the real editor workflow pass.
- Archive searches use a distinct saved-request scope for each query. Previously a
  new query could reuse an older request whose acceptance was still pending. All 15
  archive browser cases pass, including that race, cancellation, retained results,
  mention filters and desktop/phone controls.
- Character badges move to the visible Characters button. The browser check also
  verifies that a badge attached before the workspace rail exists moves across as
  the same node, with no duplicate.
- Mode selection closes navigation before waiting for the selected view to open.
  Finishing an earlier selection no longer closes navigation the user reopened.
  Held-activation tests and the phone mode/draft workflow pass.
- Screenshot capture preserves the natural height of nested content wrappers when
  Chromium reflows fonts in its export document. Fixed-height content still keeps
  its declared size. Modern-colour exports, text reflow, end markers, range/wand
  downloads, desktop and Android area limits, unfinished-image recovery and the
  stalled-render deadline pass; WebKit is unavailable on this machine.

The first candidate's complete browser run finished with 994 passes, 72 failures
and nine skips. Follow-up tests have corrected obsolete save receipts,
hidden-control assumptions and shared test
data. Protected solo/group edit retries and stale-write refusal now pass on both
layouts. The closed-page phone backup check and all three character-library layouts
also pass. NanoGPT routing persistence, Ripple expression history, Pawthfinder's
conditional saves and Stop handling, assistant-copy preservation, the extension
catalogue, Termeownal and the visible character badges pass their follow-up checks.
These focused results do not replace a complete run of the next candidate.

The second candidate, `f196549521fda8156d77afb2e1cd78c112635599`, passed all four
Android jobs in run `36345292384`, including both visible-workspace checks.
Its browser run `36345292688` finished with 870 passes and 15 failures across seven
completed batches, plus nine skips and five tests not reached. The remaining batch
hit its two-hour limit after 144 of 208 cases. The large Conversation file now lets
the runner distribute its independent cases; the new eight-batch plan has between
134 and 142 cases per batch. Two-worker Conversation and closed-page Agent/group
checks pass locally.

I also traced a real send-scroll regression: a delayed resize callback restored the
reading position from before Send, hiding the new message again. A new bottom scroll
now invalidates those older callbacks and updates the saved viewport state immediately.
The browser check verifies the message is visible within one second and stays there
after a delayed save. Loading older history, late image resizing, pruning old rows
and reading above a streaming reply also pass. The focused scroll unit checks pass
all 120 tests. The subsequent full run passed 355 suites and 4,668 tests, with two
skipped; root lint, changed-test lint, frontend limits and a fresh build also pass.
The next candidate still needs complete browser and signed Android validation.

The third candidate, `4eef59e0078ea0144de6233b7344b6c668bb511d`, passed all four
Android jobs in run `36358201151`. Browser run `36358200917` has nine failed checks
across three completed batches; four other batches have passed and one is still
running at this checkpoint.

I reproduced a real group-reply problem in that run. The page confirmed its settings
before saving the chat, and chat-save listeners could make that confirmation stale.
Group replies now confirm settings after the chat save. A definitive stale-settings
refusal refreshes the confirmation and repeats the same turn key once. Uncertain
responses, other refusals and stopped turns are not repeated. Desktop and phone
browser checks pass, including a real racing settings save that produces a refusal
followed by acceptance and exactly one model request, even after reopening the chat.

The other failed checks now use completed assistant activation, current connection
state and an already-running archive scan rather than racing those transitions.
Undo uses the built-in read-only prompts instead of inheriting a preset that writes
extra metadata during the test. Both strict save-count regressions pass. The help
reference check now uses a controlled HTTP provider for both chat and text completion;
it passes without function tools and keeps the hidden reference out of saved messages.
The subsequent full unit run passed 355 suites and 4,673 tests, with two skipped.
Root lint, changed-test lint, frontend limits and a fresh frontend build pass.
The next staging checkpoint still needs complete browser and Android validation.

The fourth candidate, `85fddc4f58dc9ece919be2b0bce06a151596ba7e`, passed all four
Android jobs in run `36364659562`. Browser run `36364659643` exposed three settings
readiness assertions in batch three and an expression timing assumption in batch
eight. The group replies themselves completed, including the deliberate settings
race with one model request. The checks now wait for a genuinely settled saved
confirmation after reopening; the pending-save and edited-controls checks still
require an immediate refusal. Repeated desktop and phone checks pass.

I also traced the late NanoGPT test failure to Chromium reporting 'Promise was
collected', which Playwright described as a lost execution context. There was no
application reload. The fixture now observes completion separately while retaining
the real settings loads, preset changes, save and reload assertions. The complete
scenario passes. Ripple now checks the existing offline inheritance from the previous
message before changing an alternate swipe, and still verifies that the original
swipe keeps its own expression across reloads. All four repeated desktop and phone
checks pass. Changed-test lint passes. These test-only changes still need a complete
browser run and signed Android validation from their committed checkpoint.

The fifth candidate, `5693a1b4ec225c129f7dde04d75f205cb1db809b`, is on staging.
GitHub refused to start both Android run `36370388501` and browser run `36370388632`.
Every job stopped before its first step. The check annotation reports failed account
payments or an Actions spending limit and directs the account owner to 'Billing &
plans'. This is an external validation blocker, not a failed build or test assertion.
No billing or spending settings were changed.

The final results available from the preceding browser run are four successful batches,
two failed batches and two batches cancelled when the next run superseded them. The
six completed batches recorded 817 passes, four failures and nine skips. One cancelled
batch also recorded the NanoGPT protocol failure described above; the other recorded
no failed test. All five known failures have passing focused follow-ups in the fifth
candidate, but this does not replace a complete green run.

The account owner must resolve the GitHub billing or spending restriction before the
complete checks and final signed build can run. Main remains at
`86b5475f5a3a668855634d95dc3e855400442ba7`; no `v1.0.0` tag or official release has been
published. Once validation passes, promote that exact staging commit, rebuild and
verify the final release assets from main, publish the release, then advance staging
to `1.0.1` with its relevant lockfile. The version bump has not been applied. No Oracle
application deployment or restart was performed.

- Automatic and manual captions now compare the same settings fingerprint, excluding
  save counters and account bookkeeping. All 42 caption tests pass. All six desktop
  and phone browser cases pass for captions, translation, Pawthfinder, speech, image
  generation and interrupted paid work across closed pages and server restarts.
- Individual Agent settings and shared on/off switches use one conditional record
  save rather than a complete setup transaction. Concurrent edits still refuse the
  save. Selection updates existing cards, retaining keyboard focus. Both full browser
  cases pass; the measured phone history switch fell from 2,813 ms to 536 ms in the
  development preview. Multi-record recovery remains covered by the setup tests.
- Accepted jobs and newly available worker slots trigger immediate dispatch. A shared
  account-scoped event connection prompts browsers to read saved state immediately,
  with polling retained if the connection fails. Events contain no job contents.
  Real browser checks measured cancellation readback below one second on desktop and
  phone; unit and HTTP tests cover account isolation, shared connections and recovery.
- Startup no longer scans new controls for an empty translation dictionary. Keyboard
  observers batch affected subtrees and avoid rescanning the page for unrelated class
  changes. Original tab order and live translations pass real browser checks. Phone
  sheets skip desktop-only resize measurements. Further startup and panel profiling
  remains open; development-preview timings are not physical-phone measurements.
- Prompt variables no longer schedule whole-chat or settings saves when their value
  has not changed. Explicit chat saves also clear the redundant metadata-save timer.
  Browser checks pass for exact Undo restoration, failed-save Retry and group Undo.
- Phone opening now batches drawer measurements before style writes and removes
  duplicate opening-frame measurements. Rapidly closing a sheet cannot reopen it on
  the following frame. Desktop and phone geometry and focus checks pass. The latest
  preview measured job readback at 121-173 ms and Settings first paint at 379-432 ms;
  first opening of the phone Agents sheet still took 2.29 seconds.
- Reading server update status preserves local and staged files. Remote checks are
  coalesced, and update notices dismiss after eight seconds unless hovered or focused.
- The new manual Android validation workflow builds from a clean commit, records the
  embedded source and frontend hashes, verifies both signed APKs and 16 KiB native
  alignment, and exercises the signed app on Android 11 and 15 emulators. Remote
  builds pass signature, source-content and alignment checks. Both Android versions
  pass private login, background operation, process-death recovery and reinstallation;
  both now pass the visible-interface check with WebView 124. The runner uses a
  4 GiB emulator disk after an 8 GiB request exhausted its available storage.
  The owner authorised a fresh signing key because the
  desktop key was unavailable. The new key and password are stored outside Git and
  in encrypted repository secrets. Older desktop-signed test installations require
  backup and reinstallation; future releases must retain the new key.

The earlier eight-way browser run had 120 failures and 927 passes. Several fixtures
predated protected chat-save receipts and current control labels; genuine caption and
update-notice failures were also found. Four repaired browser cases now pass for the
current page title, first group chat and closed-page scene comparisons on desktop and
phone. The isolated lorebook/persona workflow also passes saved edits, connections,
reload and layouts at 1280, 390 and 320 pixels. All 1,431 server tests pass on the current changes. The full unit run passes
355 suites, with 4,668 tests passing and two skipped; the serial run required a 4 GiB
Node heap after exhausting the default 2 GiB limit. Root lint, changed-test lint,
frontend budgets and a fresh frontend build pass. The dependency audit reports eight
moderate advisories and no high or critical advisories. Focused browser checks do not
replace a fresh complete browser run. The complete browser rerun, Android validation
and release publication are still in progress. A later native-tools fixture repair
now supplies the required settings revision and verifies that the real client accepts
the save. All seven focused font and draft-preservation cases pass at desktop and
both phone widths. It accompanies the Android runner correction in the next staging
checkpoint.

Commit and push each verified follow-up to staging first, promote the
exact verified commit to main, publish 1.0.0, then advance staging to 1.0.1. This task
does not deploy or restart the Oracle service.

### Earlier release checkpoints

The owner requested a main release, a self-contained Android APK and staging prepared
for 1.0.1. The release base is the latest verified GitHub staging commit
`76a90f18a7d2e620e0903c0297a1a0e12dc80158`. Main was created and its initial release
preparation pushed as `86b5475f5`. The owner subsequently requested the latest fixes
be committed and pushed to staging first; further release work now follows that order.
This task does not deploy the Oracle service; older deployment notes below are historical.

- Fixed the shared sprite archive/restore copy for Node 26, retaining exclusive
  destination creation and no-overwrite checks. The full unit run passed 352 suites,
  with 4,634 tests passing and two skipped. The server suite passed 1,409 tests;
  a further ONNX/Protobuf compatibility test passed separately.
- Updated compatible dependencies and synchronised npm and Bun 1.3.14 lockfiles.
  The audit has zero high or critical findings and eight moderate dependency findings
  remain. Do not describe this as a clean security audit.
- Root lint, changed-test lint with zero errors, frontend build, asset budgets and
  whitespace checks pass. Desktop 1280x900 and touch 393x852 migration checks passed
  all 24 cases. Six further glossary, Story and native-workspace cases passed after
  correcting stale test fixtures and the intentional phone header expectation.
- The release browser workflow now explicitly prepares disposable data and divides
  the full suite between eight isolated runners. Its complete remote result is still
  required; local focused checks are not a claim that every browser test passed.
- Android implementation and local acceptance are complete. The embedded Node 24 server
  passed startup, private authentication, background availability, process-death and
  APK-reinstallation data checks on Android 11 and 15 emulators. Native document-picker
  import and PNG export preserved the exact character data. An update to a different
  payload retained the imported card, generated reply, server preferences and custom
  global extension; a name collision was preserved in the account's Files backups.
  Final debug lifecycle checks passed on Android 11 and 15, and the actual signed
  release APK reached its fully loaded Home screen. Both release signatures and APK
  alignment verify; all packaged native LOAD segments use 16 KiB alignment. Android
  lint has zero errors and seven warnings. Signing material is backed up outside Git.
  No APK has been published. Physical ARM devices and iOS/WebKit remain unverified.
- The pre-release Agent review restores bundled CYOA and skill-check rows as real
  accessible buttons after sanitisation, both in replies and companion notes. Click,
  touch and keyboard insert once into the draft without sending. All four full-app
  choice cases and six companion DOM cases passed, with desktop and phone screenshots
  inspected and 44-pixel choice targets checked.
- Paw sounds now sit in the outer composer, above the nested control layers. All five
  browser cases passed paint order, position, busy sending and Stop-button checks,
  including simulated Safari keyboard coordinates. This is not direct iOS verification.
- Agent refreshes now visit displayed messages rather than searching the whole chat.
  In the same synthetic 10,000-message browser test with 24 displayed, seven-sample
  median refresh time fell from 1,154 ms to 9.6 ms; lookups fell from 10,000 to 24.
  Loading older messages still decorates their choices. The broader startup review
  removed an unnecessary extension prefetch pass, including the unused Kokoro engine;
  that pass accounted for 100 requests and 1.63 MiB of encoded response bodies.
- After these changes, all 352 unit suites pass (4,635 tests, two skipped), root lint,
  changed-test lint, budgets and production build pass. The unchanged server suite's
  earlier passing result remains applicable. Old browser fixtures now acknowledge
  settings revisions and use current character controls; all three touch-editor cases
  pass. The startup smoke checks actual static assets, excludes retained-job API polling
  from its stability wait, and no longer truncates timings at 1,000 entries. Its corrected
  case passes separately. All 19 Agent workspace and full companion-interface cases
  pass, including saved setups, failed saves, retry, and widths from 320 to 1280 pixels.

The reviewed web fixes were committed and pushed to staging as `4176c8d41` before
further main changes. The Android source follows on staging. Main still points to
the earlier preparation commit; there is no release tag or published APK yet.

Next: finish the remaining remote browser checks, publish the verified main release, then advance staging
to 1.0.1. Keep signing material and generated artefacts
out of Git. Reuse the passing common-code checks while those files stay unchanged.

## Status and authority

The full migration's thirteen stages are implemented and verified locally; deployment remains a separate owner decision. The Oracle VM runs `staging` up to `9e87a12`, which contains verified Stages 1-9 and was deployed on 26 September 2026; Stages 10-13 have not been deployed. Small, coherent local checkpoint commits are authorised within stages. They record implementation progress and are not reviewed stage completion. Do not push, deploy, or commit credentials, runtime data, generated builds or test artefacts without an explicit request. Stage 10 onwards is developed in a separate clone on the VM, `/srv/projects/Neconyan`, whose push URL is disabled; the live checkout in `/home/ubuntu/Neconyan` self-updates from GitHub and must never be edited, tested or committed in.

Current workflow: the owner-selected session model plans and implements the whole current stage itself, without separate planner or implementer agents or model switching. Once the complete stage is implemented and validated, the same model performs one stage-end self-review of the whole stage, including every checkpoint commit. Separate reviewer agents require an explicit user request for that task. Findings are batched into one correction pass; follow-up review covers only the corrections and affected callers. After two failed reviews, reassess the shared cause with failing reproductions. A stage is accepted only after its findings are resolved and final verification passes. Earlier provider lineups and per-checkpoint review wording below are historical.

The goal is server ownership of accepted workflows, authoritative state, scheduling, cancellation, recovery and completion writes. Server provider calls alone are insufficient. WebLLM and bundled browser Kokoro are the only approved browser-only exceptions so far. Their controls say to keep the page open. Do not silently replace those providers.

Read the repository instructions, product and design documents, the phase checklist and the ownership audit before changing code. Preserve this checkpoint; do not restart the audit or create another competing job system.

## Current checkpoint: Stage 13 remaining application and final audit (verified)

- Stage 13 is accepted locally on top of Stage 12 at `5eedc53`. Implementation, one whole-stage self-review, batched corrections and correction-only follow-up are complete. Nothing from Stages 10-13 is pushed or deployed.
- A shared permanent record store (`src/jobs/operation-records.js`) now backs both Labs and the new application workflows under `/api/operations`, on the existing job runner. Records, reservations and local publication evidence sit outside imported or reset user data and outlive job pruning. Unknown provider outcomes are never re-sent automatically; explicit recovery only finishes recorded local writes.
- Moved to the server as whole accepted workflows: manual and automatic chat translation, vector indexing, search, purge and the vector part of native Roleplay replies (with WebLLM as a page hand-off step), storage maintenance reports and reviewed deletions, chat archive inventory, search, export and organisation, account backup, confirmed account reset, folder/ZIP/extension imports, chat backup cleanup, custom CSS generation, background (quiet) and raw prompts for supported shapes, Time Machine 'Snapshot everything', and ordinary group turns through the existing native group family. Meower receipts are archived before any reset deletes user data. BotSearcher replacement and delete now repeat the revision check inside the host write lock. The old page-owned HTTP routes for these workflows answer 409 and point at the native job.
- Retired Stage 10 leftovers: the page raw Conversation helper and `binding/generate` route, page image and schedule helpers and their constants. Agents and Pawthfinder no longer re-send a request whose result is unknown, and the Connection Manager command only retries without streaming after a definite refusal before any text arrived.
- The review found two issues, both corrected: the reset confirmation reply returned the private operation record, and the page could send reply limits the server refuses. Settings reset and snapshot restore were confirmed to finish inside one synchronous server request, so they stay as they are.
- Checks passed: 351 Jest suites (4,608 passing tests, 2 skipped, 1 snapshot), 1,405 Node tests, root lint, frontend budgets (17 blocking stylesheets at 1023.8 KiB, 24 startup scripts at 2214.9 KiB) and whitespace. Tests-folder lint keeps its 183 existing errors and adds none. Serial disposable Chromium runs at 1280x900 and 393x852 with touch passed: translation 4/4, vectors 4/4, archive, maintenance, backup and reset 8/8, imports 6/6, group turns 2/2 and the retired Conversation route 1/1. Providers were local fixtures. iOS behaviour is inferred because WebKit cannot run on this machine.
- Remaining page-owned work, recorded deliberately: WebLLM and browser Kokoro; Quick Reply auto-run chains (arbitrary user scripts on page events; the native World Info Quick Reply subset stays server-side); quiet and raw prompts that use quiet-to-loud, prefill, schemas, a named API, temperature, instruct overrides, message arrays or group chats; group swipe, continue, impersonate and quiet turns; the Token Ledger, which records only page-assembled requests; Time Machine per-item captures and restores; and the BotSearcher bulk intake queue, where each card is its own conditional write. An identical quiet or raw prompt whose earlier result is unknown reports that saved error rather than being re-sent.

### Stage 13 continuation entry points

- Shared records and runner: `src/jobs/operation-records.js`, `src/operations/store.js`, `src/operations/jobs.js`, `src/endpoints/operations.js`, `public/scripts/operations-client.js`, `public/scripts/labs-client.js`.
- Workflows: `src/operations/*.js` (translation, vectors, maintenance, archive, account backup/reset/import, backup deletion, custom CSS, quiet and raw generation, Time Machine), `src/generation/roleplay-vectors.js`, `src/meower-retirement.js`, `src/account-reset-content.js`, group acceptance in `src/generation/roleplay-acceptance.js`.
- Tests: `tests/application-*.node.js`, `tests/application-*.e2e.js`, `tests/account-reset.node.js`, `tests/roleplay-vectors.node.js`, `tests/roleplay-group-acceptance.node.js`, `tests/roleplay-group-native.e2e.js`.

## Historical checkpoint: Stage 12 Labs (verified)

Stage 12 is accepted locally on top of Stage 11 at `220ba45`. Its single whole-stage self-review, batched corrections and correction-only follow-up are complete. Continue with the full Stage 13 application migration and final audit. Nothing has been pushed or deployed.

- The existing job runner now owns Distiller, LoreStitch, World Info Lab and Prompting Lab workflows. Permanent account-scoped Labs records live outside imported user data. They retain captured inputs, proposals, results and publication evidence after job pruning. Normal records reserve 16 MiB before acceptance; suite transfers reserve 64 MiB, within a shared 512 MiB limit. Exhaustion refuses new work without deleting evidence.
- Distiller captures saved chat text and produces retained proposals. LoreStitch transformations, World Info scans, health checks, batch previews and saved test replays run on the server. Lorebook and character-test proposals require a separate reviewed apply with source-version checks. Interrupted local publication retains physical write evidence and has an explicit recovery control; it cannot start another provider request.
- Prompting Lab captures saved cards, personas, templates, connection profiles, lorebooks and read-only Mewmory snapshots. Native suites compile and measure prompts, compare baselines and publish run records. Comparisons, analyses and multi-turn scenes retain each known provider result. Preset publication, suite transfers, embedded character tests and record maintenance have native completion writes. Old scene replies remain visible until replacements are saved. Unknown provider outcomes never repeat automatically.
- Browser controls submit, observe and read retained results. Closing a page detaches observation; Stop requests durable cancellation. Late cancellation still records a known completed write. Saved-result controls work independently of the submitting page, and recovery requires permanent local publication evidence. The original browser-only WebLLM and Kokoro exceptions remain part of the full migration contract.
- Non-browser verification passed: 349 Jest suites, 4,620 tests passing, 2 skipped and 1 snapshot; all 1,319 Node tests; root lint, frontend budgets and whitespace. Changed-file comparison found no added production lint errors. Tests-folder lint retains the same 183 existing errors. Budgets remain 17 blocking stylesheets at 1023.8 KiB and 24 startup scripts at 2210.5 KiB.
- All 18 serial disposable Chromium acceptance cases pass at 1280x900 and touch 393x852. The initial run passed 16; the two World Info review/replay/health cases passed after correcting settings refreshes that detached observation or blocked review of a retained result. Their regression forces a refresh both during observation and after completion. Coverage includes closed-page Distiller proposals and reviewed writes, LoreStitch, World Info scans/batches/saved tests/health, prompt suites, preset publication, suite transfers, reviewed character tests, multi-turn scenes, comparisons, retained readback and Stop after reopening. Providers were controlled local fixtures. WebKit is unavailable, so iOS behaviour is inferred from Chromium.

### Stage 12 continuation entry points

- Admission, permanent records and recovery: `src/endpoints/labs.js`, `src/labs/jobs.js`, `store.js`, `books.js`, `recovery.js` and `public/scripts/labs-client.js`.
- Native computation and captured sources: `src/labs/compute.js`, `compute-worker.js`, `sources.js`, `distill.js`, `world-info*.js` and `prompting-*.js`. Shared prompt assembly, lore macros and read-only Mewmory helpers remain in their existing generation and memory modules.
- Browser callers: Distiller, World Info Lab and Prompting Lab under `public/scripts/extensions/third-party/`, plus `public/scripts/neconyan-lorebook-tools.js` and the shared entry defaults in `public/scripts/world-info-entry.js`.
- Acceptance: `tests/labs-jobs.node.js`, `tests/labs-client.test.js`, `tests/labs-scene-replacement.test.js` and `tests/labs-native.e2e.js`. The disposable browser fixture permits a 60-second initial application boot for Labs; interaction timeouts remain 20 seconds. This accommodates the source-mode module load and is not a production performance claim.

## Historical checkpoint: Stage 11 Meower (verified)

I have completed Stage 11 locally, building on Stage 10 and the subsequent owner changes already present at `4af51fb`. Meower refreshes, character profiles and persona profile drafts now finish on the server after every page closes. Stages 12 and 13 remain authorised and unfinished. Continue with Labs, then the remaining application and final audit. Nothing from this stage has been pushed or deployed.

- Native `meower.refresh` and `meower.profile` jobs capture a saved session, character cards, persona and scenario notes, connection, feed epoch and once-selected participants. A selected connection that is unavailable refuses precisely instead of switching providers. Saved chat profiles keep Meower's reasoning overrides without applying unrelated preset controls; saved text profiles keep its no-preset/no-instruct request. Active connections require the saved settings acknowledgement and use the captured character/persona macro context. The page contributes only bounded scene text, local time and an optional topic.
- The worker owns profile generation, incremental or batch activity, native Quick Image Gen images, interaction reconciliation, follows, strangers, trends and refresh time. Persona generation returns a saved draft for review; character profile writes compare their original profile snapshots. A changed or deleted session/feed epoch stops the write, while unrelated manual feed edits survive. Definite image failures can save text-only activity; unknown provider outcomes and failed image publication retain recovery evidence rather than paying again.
- Native and browser writes share the existing Meower write queue and physical store lock. Private permanent submission and unit receipts are published atomically with their feed/profile writes, survive job/artifact pruning and post deletion, and cannot be removed by a browser store upload. Receipt capacity is reserved before acceptance and on subsequent store writes; exhaustion refuses new work without evicting evidence. Frozen provider inputs, saved results, deterministic row IDs and materialised activity prevent a restart from selecting a new cast, paying twice or restoring a deliberately deleted post. Paused acceptance can recover its plan before dispatch.
- The page submits and observes, merges saved snapshots without discarding unsaved edits, and reads the saved result for its summary. Closing or switching the workspace detaches observation. Only Stop cancels the server job, and a failed cancellation is reported as unconfirmed. Reopening running work exposes Stop again. Lost submission or result responses retain the same operation, including distinct character-profile targets, rather than starting another paid request. Meower's existing carryover remains a page prompt addition.
- I completed one whole-stage self-review, batched its findings into one correction pass and then checked only corrections and affected callers. Corrections included receipt reservation and account checks, saved text and macro parity, image-write failure handling, retained browser operation identity, Stop reporting, reattachment and the snapshot merge call. The final browser checks exercise reading a completed result again as well as server completion while every page is closed.
- Final checks: 347 Jest suites passed, with 4,608 tests passing, 2 skipped and 1 snapshot; all 1,285 Node tests passed. All seven serial disposable Chromium cases passed at desktop 1280x900 and touch 393x852: refresh plus image, profile generation, reopening without another provider call, Stop after reopening and an actual serving-process kill/restart with an unknown provider result. Root lint, changed/new-file lint and whitespace checks passed. The separate tests-folder lint reports 183 existing errors; comparison of modified legacy tests found no added errors. Frontend budgets passed at 17 blocking stylesheets totalling 1023.8 KiB and 24 startup scripts totalling 2210.5 KiB. Providers were controlled local fixtures. WebKit is unavailable, so iOS behaviour is inferred from Chromium.
- Stage 13 must include Meower's receipt preservation in the application-wide import/reset audit. The existing physical store lock is never stolen automatically after a process dies while holding it. These are explicit storage boundaries, not permission to replay an unknown outcome.

### Stage 11 continuation entry points

- Native admission and execution: `src/endpoints/meower.js`, `src/generation/meower-plan.js` and `src/generation/meower-jobs.js`. Parser, startup recovery and generic-job refusal: `src/server-main.js`, `src/server-startup.js` and `src/endpoints/jobs.js`.
- Shared store and permanent receipts: `public/scripts/extensions/third-party/Neconyan-Hopper/server/index.js` and `server/job-receipts.js`.
- Browser submission and observation: the extension's `src/native-jobs.js`, `src/api.js`, `src/storage-client.js` and `src/ui.js`. Shared saved-profile request options: `src/generation/profiles.js`, `service.js` and `text-request.js`.
- Verification: `tests/meower-jobs.node.js`, `tests/meower-native-client.test.js`, `tests/meower-native.e2e.js`, `tests/neconyan-native-storage.test.js` and `tests/generation-profiles.node.js`.

## Historical Stage 10 remaining manual Conversation work (verified)

I have completed Stage 10 locally, on top of verified Stage 9. Every manual Conversation helper that asks a model for text now runs as a native server job and saves its own result, so closing the page after pressing a button no longer loses or half-applies the work. Stage 10 is not deployed. Stages 11-13 remain authorised for continuation. Do not push.

- Regenerate and Rewrite (polish) are one job type, `conversation.rewrite`, accepted by `POST /api/neconyan-conversation/rewrite/submit`. The page still builds the prompt, but the server checks it, binds the captured connection, pays once, caches the paid text in a `reply` artifact before writing, and then replaces the message text in one receipt-protected write. For Regenerate the same write stores the command metadata and applies any reminder or status command from the new reply. The write depends only on the messages the rewrite used (the target message, and for Regenerate the history before it), so an unrelated new message or reaction no longer throws away a paid result, while an edit or deletion of those messages keeps the original reply and never pays again.
- Selfies are `conversation.selfie`, accepted by `POST /api/neconyan-conversation/selfie/submit` from the quick action, the `/selfie` command and a character's selfie request. The server writes the image prompt, renders the picture through the account's Quick Image Gen settings, writes a caption (with the old stock caption when the caption request is definitely refused), narrates it through saved speech and posts it as the character or group partner. The picture is saved as an artifact before posting, so a restart or a failed caption never pays for a second image. An unknown caption outcome keeps the picture and waits for an explicit retry. The pending image bubble's Stop button cancels the server job. Selfies no longer require automatic images to be switched on, and a second manual selfie is no longer refused while one is running.
- Generate schedule submits the existing `conversation.schedule` job and no longer writes anything in the page. A hand-edited schedule is normalised and saved by the server as a version-checked write through the same route with a `schedule` field. Group schedules were previously written onto the group thread, where neither the page nor the server ever read them; they are now saved on the character's own store and update the owned group's pacing. Legacy file-backed groups keep their pacing unchanged, which is a documented residual.
- The browser completion writers these helpers used (`postCharacterReply`, `generateSelfieFromContext` and the rest of the page reply path) are deleted. A page that stops watching a helper job reports that the server is still working instead of reporting a failure.
- Provider refusals are now classified. A definite refusal (HTTP 4xx except 408, 503 and 529) settles the provider step as a known outcome, so the job is `failed` and an explicit retry may send again; 500, 502, 504, network errors and missing statuses stay unknown and `interrupted`. The OpenAI-compatible chat path keeps the upstream status behind its safe client status for this purpose; other chat sources that report a bare 500 remain unknown, which is conservative. An explicit retry (`POST /api/jobs/:id/retry` and the Conversation family retry) now clears the unknown-outcome markers it is deliberately overriding; nothing retries automatically.
- Saved speech fails softly: a definite speech refusal or a response that is not audio saves the reply text with failed narration instead of failing the whole reply, and replays the failed result without asking again.
- The six durable browser failures that pre-dated Stage 9 are fixed: the reminder retry (the definite 503 is now `failed`), the two-tab narration and Stop cases (the test's audio URL filter predated saved speech at `/api/jobs/<id>/audio/<artifact>`), unknown speech after a crash (explicit retry now clears the recovery markers) and speech returning an error or HTML (text is delivered with failed narration).
- Stage 7 follow-ups: items a-h in 'Preserved Conversation integration checkpoints' were re-checked against their tests and the durable browser run. The one gap found, selfie captions not being narrated, is closed.
- Stage-end self-review findings, corrected in one pass: an unknown caption outcome fell back to the stock caption and would then have blocked narration; a schedule job the page stopped watching was reported as a failure; the new manual-helpers browser suite ran under the default 30-second test timeout.
- Final checks: the full Jest suite passed 343 suites with 4,568 tests passing, 2 skipped and 1 snapshot (run with an 8 GiB heap because the default heap ran out on this VM). The full Node suite passed 1,257 of 1,257. Frontend budgets are unchanged at 17 blocking stylesheets totalling 1022.9 KiB and 24 startup scripts totalling 2198.8 KiB. Disposable Chromium checks at 1280x900 and at 393x852 with touch passed all six new manual-helper tests (Regenerate and Rewrite, schedule generation and hand edit, selfie), every formerly failing durable test on both viewports, and all eleven regeneration-area durable tests; four of those eleven first failed at the fixture's 20-second first page load while the Node suite shared the four cores, and passed when rerun on a quiet machine. Lint of the changed files reports no errors and `git diff --check` is clean. All providers were local fakes. WebKit cannot run here, so iOS behaviour is inferred from Chromium. Root lint still needs the missing `eslint-plugin-jsdoc`.
- Not part of this stage: Meower, Labs and the remaining application (Stages 11-13). `POST /api/neconyan-conversation/binding/generate` and several browser image and schedule helpers now have no product caller and are left for the Stage 13 audit: `generateConversationRaw`, `generateConversationImage`, `buildCharacterImagePrompt` and `getCharacterImageDetails` in `media.js`, `stripSpeakerPrefix`, `markImageGenerated`, `getImageCooldownRemainingSeconds`, `saveStoredSchedule` and `SCHEDULE_GENERATION_RESPONSE_TOKENS`.

### Stage 10 continuation entry points

- Rewrite: `src/generation/conversation-rewrite.js`; browser caller `submitConversationRewrite` in `public/scripts/neconyan-conversation/generation.js`, used by `regenerateConversationMessage` in `timeline-render.js` and `handleCharacterMessagePolish` in `interface.js`.
- Selfie: `src/generation/conversation-selfie.js` with `renderConversationImage` in `src/generation/conversation-images.js`; browser caller `requestConversationSelfie` in `generation.js`.
- Schedule: `acceptConversationSchedule`, `applyConversationSchedule` and `saveEditedConversationSchedule` in `src/generation/conversation-maintenance.js`, `normalizeEditedSchedule` in `public/scripts/neconyan-conversation/schedule-utils.js`, browser callers in `schedule.js`, `chrome.js` and `settings-panel.js`.
- Anchor-scoped writes: the `verify` option of `commitConversationEffect`, `appendConversationJobMessage` and `assertConversationEffectSource`, and `applyConversationJobCommands`, in `src/generation/conversation-effects.js`.
- Provider refusal and retry: `isDefiniteProviderRefusal` and `providerRefused` in `src/jobs/artifacts.js`, `explicitRetryRecovery` in `src/jobs/store.js`, `failSoft` in `generateSavedSpeech` (`src/generation/speech-jobs.js`).
- Crash recovery for paused helper jobs: `src/generation/conversation-worker.js`; reserved job types: `src/endpoints/jobs.js`; page reattachment: `OBSERVED_ROOT_TYPES` in `public/scripts/neconyan-conversation/native-jobs.js`.
- Disposable verification: `tests/conversation-rewrite.node.js`, `tests/conversation-selfie.node.js`, `tests/conversation-maintenance.node.js`, `tests/speech-jobs.node.js`, `tests/jobs.node.js`, `tests/neconyan-conversation-manual-helpers.e2e.js` and `tests/neconyan-conversation-durable.e2e.js`.
- `tests/roleplay-transactions.node.js` no longer compares file access times, which this VM's filesystem refreshes on read; those three cases failed on the untouched Stage 9 commit here.

## Historical Stage 9 named Roleplay workflows and browser cutover (verified)

I have completed Stage 9 locally, on top of verified Stage 8. A migrated Roleplay control now names one server workflow, hands over only what the user typed or what a saved extension had already written down, observes the accepted job and adopts the durable result. Story, Guided and Deep Swipe own real server semantics, private asides are sampled by the server from a stated fact, and a reopened page reattaches to accepted work without submitting anything again. Neither Stage 8 nor Stage 9 is deployed: the Oracle VM still runs committed Stages 1-7. Provide a copyable handover prompt for Stage 10. Stages 10-13 remain authorised for later continuation. Do not push.

- The server owns the whole named vocabulary: `roleplay.reply`, `roleplay.continue`, `roleplay.swipe`, `roleplay.correct`, `story.passage`, `guided.response`, `guided.swipe`, `guided.correction`, `deep-swipe.reply` and `deep-swipe.user`. `src/generation/roleplay-workflow-named.js` maps each name to one effect, one anchor rule and one prompt slot, and refuses an unknown name, a missing or extra instruction, a guided or Story prompt that does not match the saved inject, a macro the server cannot substitute and a tampered record before any paid work. The four plain controls keep the saved automatic swipe and continuation policy, frozen at admission exactly as in Stage 8, so a plain send on the server path loses nothing the browser used to do after it. Story, Guided and Deep Swipe never capture that policy, so each is exactly one bounded model turn. A Deep Swipe instruction is published on every turn, ahead of any saved tool history.
- A new `alternative` effect joins the Stage 8 effect set for Deep Swipe: it appends one more swipe and one more `swipe_info` entry to the anchored message and leaves `swipe_id`, `mes` and the message's own metadata untouched, so an alternative never hides the text the user was reading. Its prompt window excludes the anchored message, which is what makes it a new answer to the history before that message.
- `POST /api/roleplay/workflow/submit` accepts a named workflow natively, because generic `POST /api/jobs/submit` refuses every `roleplay.*` and `media.*` type. The server reads the saved chat under the account lock, resolves the anchor itself and refuses a caller whose index or message revision disagrees, captures the acknowledged active connection, reserves capacity, records its permanent receipt and releases one paused job. A named workflow refuses a group turn, and a group turn refuses `alternative`, so neither pays for a workflow it cannot finish. `GET /api/roleplay/workflow/receipt?key=` reads the receipt back by account and operation key alone, which survives the job it describes being pruned.
- The browser takes one decision, in one place. `willRunNativeRoleplayWorkflow` in `public/script.js` is the only owner of the refusals, so the host's destructive browser steps and the native workflow cannot disagree: a migrated regenerate or swipe skips the host's delete-then-regenerate entirely and keeps the old text until the server's own journalled replacement is durable. `Generate` still runs `processCommands`, consumes the composer, saves the user message and emits its own start and end events, so slash commands, attachments, the active-connection acknowledgement and the busy markers behave exactly as before. `/ask` and the logprobs helper ask for the browser path explicitly, because they read the provider's own reply.
- A lost submission response keeps its whole payload and key, so an identical retry replays instead of paying twice; a refusal is final and never falls through to a second paid call; an accepted job whose outcome is unknown stays unknown and is read back from its receipt instead of being regenerated. A host stop cancels the accepted job, the host reloads the chat the server wrote rather than merging a local guess, and the finished event carries the server's own result facts, including the Story cut and the Deep Swipe index.
- Extensions adopt those semantics instead of keeping their own browser surgery. Story Mode records its cut and its undo state from the saved result after the server's write, with no local pre-cut and no second write. Guided Generations submits its filled template as one guided prompt at the saved depth, role and scan setting, so the browser never injects, truncates or edits a message. Deep Swipe submits its own prompt and the message the user chose as one unselected alternative. Guided Impersonate stays browser-owned and is documented as such, because it writes a user text-box message rather than a model chat write. Story Mode's rules and direction are read from the page's own extension prompts, which is where Story Mode writes them.
- Page-only prompt additions travel with the workflow. `capturePagePrompts` resolves every extension prompt the server cannot rebuild itself, for example Dialogue Colours (whose interceptor is run first so its prompt is current), a summary or an `/inject` value, into at most 32 sorted, macro-free entries with position, depth and role, capped at 120 KiB. The server re-validates and hashes them into the named record (at most 32 entries and 128 KiB) and publishes them on every turn as `page_<key>` contributions, which cannot replace a protected slot. Keys the server rebuilds itself, such as the author's note, persona description, depth prompts and World Info outlets, are not sent. An addition that cannot travel exactly keeps the whole generation on the browser path: a non-empty Agent, Pathfinder or vector prompt, a scan-enabled inject, a failing filter, an unresolved macro, enabled vector retrieval or any other generation interceptor. A committed regenerate or swipe refuses instead, because the host has already kept the old reply for a server replacement. The built-in helper assistant also stays on the browser path, because its help reference and tools are added in the page.
- Private asides are now native events. The browser states only the fact, `POST /api/neconyan-conversation/aside/event` rolls the sample, chooses the recipient from the saved group members and the solo thread, and reuses the existing acceptance for the cooldown, activity, busy check, occurrence key and permanent receipt. Roleplay reactions stay opt-in exactly as before: only a solo thread or group member whose saved settings enable the thread and Roleplay reactions can be chosen, and opted-out members are filtered out before any choice is made. A rendered message samples at the same 18 per cent for solo chats and groups, with the same 65 per cent speaker preference in a group. This narrows the earlier browser behaviour deliberately in one way: a mention answers the first eligible member the saved message names rather than every mentioned member.
- I reviewed the complete Stage 9 diff and batched the findings into one correction pass, then reviewed only the corrections and their callers: an anchor kind that captured no anchor at all, a replacement workflow that could never prove its own result, a continuation anchor that could not follow a user block, a misplaced generation funnel that would have broken slash commands and dropped the user's own text, a refused workflow that fell through to a second paid call, an aside event key that overflowed the server's key limit, and a missing throw in the new event's owner check. The disposable browser run then exposed four more, corrected the same way: every plain send was refused because the composer check ran before the host had saved the user's text, a settings save still queued in the page made the acknowledgement unreadable so nothing was submitted, Story Mode's prompt was read from a place Story Mode never writes, and plain controls had silently dropped the saved automatic policy. The prompt-order browser suite, now served by the server path, exposed three more: the World Info binding hashed the whole settings file, so a routine page save between acceptance and the model turn (save counters, mirrored browser storage, the Conversation store) failed the reply safely but left the user with nothing, which `roleplaySettingsHash` now fixes by ignoring only that bookkeeping while every setting a prompt reads still stops the turn before paying; the page now saves its settings before each submission and retries a save it cannot finish yet a bounded number of times; and the server aside port had lost the opt-in and the sampling roll for solo chats, which fired an unrequested private message after an ordinary reply. A final audit found that page-only prompt additions such as Dialogue Colours would have been dropped on the server path, which the page-prompt contract above now carries or refuses.
- Final checks: 342 Jest suites, 4,563 passed tests and two skipped tests, one snapshot; 1,237 Node tests; frontend budgets (17 blocking stylesheets at 1022.9 KiB, 24 startup scripts at 2198.8 KiB); whitespace; changed-test lint across the twelve Stage 9 test files with zero errors. The serial disposable Chromium run of `tests/neconyan-roleplay-workflow-browser.e2e.js` and `tests/neconyan-roleplay-prompt.e2e.js` passed 8 of 8 at desktop 1280x900 and touch 393x852: the named reply completes once, closes its page and reopens without another provider request, a failed workflow keeps the saved chat and never generates twice, and the native server prompt matches the exact text-instruct and custom-depth prompt orders the browser used to send. The combined `tests/neconyan-server-workflow.e2e.js` and `tests/neconyan-conversation-durable.e2e.js` run finished 143 passed and 6 failed; all four server-workflow cases passed, and the six durable failures (reminder retry at line 109, two-tab narration at line 152 on both viewports, unknown speech after a crash at line 310, speech returning HTML at line 328) failed the same way on the Stage 8 commit plus the uncommitted Oracle performance patch without any Stage 9 code, and the first also on the Stage 8 commit alone, so they pre-date this stage. Stage 10 fixed all six.
- Storage boundary: every official writer still takes the per-account lock. The publisher does not promise an atomic filesystem compare-and-swap against a writer that ignores the lock after the final check. Providers were controlled local fixtures. WebKit was unavailable, so iOS behaviour is inferred from Chromium. The repository lint script cannot run on this machine because the root ESLint configuration needs `eslint-plugin-jsdoc`, which is not installed here; the changed files were checked with the project's own ESLint and the tests configuration instead.
- Not part of this stage: Conversation regeneration, polishing, schedule controls and selfie coordination with native completion writes; Meower; Labs; and the final audit. Those belong to Stage 10 and later. Group turns still start from the browser's own group controls and generate in the page, and chats whose prompt additions cannot travel (see above) still generate in the page as before.

### Stage 9 continuation entry points

- Named semantics, acceptance and receipts: `src/generation/roleplay-workflow-named.js`, `src/generation/roleplay-acceptance.js`, `src/endpoints/roleplay.js` and `readNativeMediaJobResultForOwner` in `src/generation/media-jobs.js`. The effect layer is `src/roleplay-jobs.js`; the root workflow is `src/generation/roleplay-workflow.js`.
- Native aside events: `src/generation/conversation-aside-events.js` with `readConversationAsideEventSource` in `src/generation/conversation-roleplay-source.js` and the route in `src/endpoints/neconyan-conversation.js`. The browser states the fact in `public/scripts/neconyan-conversation/auto-engine.js` and `init.js`.
- Browser caller: `public/scripts/neconyan-conversation/roleplay-workflows.js`, the `willRunNativeRoleplayWorkflow` funnel in `public/script.js`, and `initNativeRoleplayWorkflows` for reattach on load, on tab focus and when the Roleplay account binds.
- Disposable verification: `tests/neconyan-roleplay-workflow-browser.e2e.js`, `tests/neconyan-roleplay-workflows.test.js`, `tests/roleplay-workflow-named.node.js` and `tests/conversation-aside-events.node.js`, with the existing `tests/neconyan-server-workflow.e2e.js` and `tests/neconyan-conversation-durable.e2e.js`. The browser fixture requires `NECONYAN_CONVERSATION_TEST_DISPOSABLE=1` and starts the real server with `NECONYAN_SUPERVISED=1`.
- Local evidence logs: `/tmp/opencode/stage9-final-jest2.log`, `/tmp/opencode/stage9-final-node.log`, `/tmp/opencode/stage9-prompt-browser4.log`, the combined durable run and `/tmp/opencode/stage9-baseline-failures.log`. These are disposable evidence, not deployment inputs.
- The World Info settings binding is `roleplaySettingsHash` in `src/roleplay-store.js`; every whole-file settings comparison in World Info, the automatic policy, Agent drafts and Quick Image Gen uses it.

## Historical Stage 8 whole-Roleplay execution (verified)

I have completed Stage 8 locally, on top of verified Stage 7. One saved progressive workflow now carries a whole accepted Roleplay turn: model turns, bound tool children, automatic swipes, continuations and group speakers, with native completion. Stage 8 is not deployed. The Oracle VM still runs committed Stages 1-7. Stages 9-13 remain authorised for later continuation. Do not push.

- A private root workflow admits itself once with a permanent media receipt, then progresses through indexed `roleplay.candidate` children that are attached to the parent in one ledger write before release. A candidate saves its result without writing chat, so the old reply, its selected swipe and unrelated history stay intact until one journalled protected write publishes the final text. That write is journalled as `writing` before it happens and closed only after the current chat is proved equal to the last owned write.
- A model tool call becomes a real child job attached to the root, and the root resumes the model with a complete, server-proven assistant function-call and tool-result pair. A child that changes a book, Agent, preset, character or the chat proves its own permanent physical effect, and only that proof lets the root recapture the protected source and bound World Info for the next turn. Several tool calls in one model reply progress in order, each with its own proof, and a read-only result changes nothing.
- Automatic swipes and continuations are frozen from saved settings at admission and decided before the next paid turn. A rejected reply is kept as an earlier swipe in the final write, with its own saved decision, instead of being discarded. Continuations assemble into one final message, and previous selected swipes are never rewritten. The saved decision is read and verified before anything is recomputed, so a restart cannot change an accepted answer.
- Group turns freeze their speakers, order, per-speaker model override, context instruction and generation id under the account lock. Each complete speaker is published in its own journalled write, and the next speaker starts from a source proved to be the previous speaker's own write. Cancelling a parent stops its queued children; a first speaker that already completed durably stays completed.
- I reviewed the complete Stage 8 diff and batched six correction findings into one pass: decisions recomputed before their saved value was read, no proof that the chat still matched the final owned write, missing 64 MiB chat and Companion capacity admission checks, a catastrophic-backtracking risk in the saved automatic-swipe blacklist, an unsafe cache copied from the performance patch, and a per-candidate tool history limit too small for a progressive workflow. The correction-only follow-up re-read each corrected path and its callers and found no further reproduced failure.
- Final checks: 341 Jest suites, 4,539 passed tests and two skipped tests, one snapshot; 1,219 Node tests; frontend budgets; whitespace; changed-test lint across the five Stage 8 test files with zero errors. The serial disposable Chromium run passed 16/16 at desktop 1280x900 and touch 393x852, with every page closed for native work, the actual serving process killed and restarted, and reopened without another provider request. Providers were controlled local fixtures. WebKit was unavailable, so iOS behaviour is inferred from Chromium. The repository lint script cannot run on this machine because the root has no ESLint install and the resolver reaches ESLint 10, which refuses the repo's legacy config; the changed files were checked with the project's own ESLint 8.57.0 instead.
- Not part of this stage: a production browser Roleplay caller, real submit and observe controls, reopen-without-replay in the UI, and the named Story, Guided and Deep Swipe workflows. Those belong to Stage 9. Private admission is the only path that starts a Stage 8 workflow today.

### Stage 8 continuation entry points

- Root workflow, candidates and protected publication: `src/generation/roleplay-workflow.js`, `src/generation/roleplay-workflow-{records,alternatives,capacity}.js`, `src/roleplay-jobs.js` and `src/roleplay-store.js`. Candidate workers live in `src/generation/roleplay-execution.js`; family attachment and waiting recovery are in `src/jobs/store.js` and `src/jobs/runner.js`.
- Progressive sources: `src/generation/roleplay-workflow-lineage.js` and `readNativeMediaJobProof` in `src/generation/media-jobs.js`. Group selection and automatic decisions: `roleplay-workflow-groups.js` and `roleplay-workflow-policy.js` with `roleplay-workflow-filter-worker.cjs`. Per-call tool admission: `src/generation/roleplay-tool-dispatch.js`.
- Disposable verification: `tests/neconyan-server-workflow.e2e.js` plus the native workflow, group, candidate and capacity cases in `tests/roleplay-workflow*.node.js`. The browser fixture requires `NECONYAN_CONVERSATION_TEST_DISPOSABLE=1` and starts the real server with `NECONYAN_SUPERVISED=1`.
- Local evidence logs: `/tmp/opencode/stage8-final2-jest.log`, `/tmp/opencode/stage8-final2-node.log`, `/tmp/opencode/stage8-test-lint.log` and `/tmp/opencode/stage8-final2-browser.log`. These are disposable evidence, not deployment inputs.

## Historical Stage 7 tools, Agents and generation hooks (verified)

I have completed Stage 7 at local implementation commit `fa5050578`, on top of verified Stage 6. Stages 1-7 are reviewed, verified and deployed to the Oracle VM at the committed documentation checkpoint `93dba912e`. Stage 8 is now verified locally and un-deployed; Stage 9 is next. Stages 9-13 remain part of the full migration, but they were not part of this deployment. Do not push.

- The private Roleplay worker now binds enabled Agent records, their model profiles, companion context and native function definitions to protected account files before paying a provider. Pre-generation prompts and complete-context interceptors, post-main interceptors, rewrites, shared-baseline append batches, raw and display regex, tracker state, hidden and retained Companion history, feedback and bounded dependency waves save their inputs and results. A saved owner decision gates a post-main review; unknown parallel provider outcomes cannot be cleared by another completed call.
- Linked Quick Reply actions with supported local variable commands save their exact scripts and changes before the main request, then commit variables only with the finished reply. Browser-only commands or composer actions explicitly refuse rather than pretending to run. Older accepted Stage 6 prompts keep their original source and tool definitions; newly admitted work uses account-bound native schemas instead of trusting browser-supplied ones.
- Manual Agent message edits, undo and redo, tracker repair, selected Companion notes and draft processing have protected source anchors and durable effects. The Neconyan Assistant's 14 native tool definitions retain their browser ask-first wording. Pathfinder book actions and Notebook, and reviewed Assistant edits of lorebooks, Agents, presets and characters, use physical file evidence, permanent receipts and real owner approval where needed. A model's `userConfirmed` flag alone never authorises a mutation. Ordinary authoring routes share the account lock and cannot overwrite a target with unfinished native work.
- Model tool calls can be normalised from saved bound provider output into exact native child jobs. Those children can obtain owner approval, finish with no pages open and retain results after job pruning or an owned chat mutation. Their parent Roleplay reply still refuses delivery on a tool-call result; Stage 8 must coordinate its saved tool/Agent turns and resume the model before completing that parent. This private boundary is not the Stage 9 browser cutover.
- I reviewed the complete Stage 7 diff and corrected prompt-result proof, exact tool guidance, Agent ordering, approved-work capacity and Companion output capacity in one batch. The correction-only follow-up found no additional reproduced failure in those paths. Capacity exhaustion refuses admission before paid work; it does not clip notes or silently change the selected tool.
- Final checks: 341 Jest suites, 4,539 passed tests and two skipped tests, one snapshot; 1,191 Node tests; root lint; changed-test lint across 24 files with zero errors and 84 existing-style warnings; frontend budgets and whitespace. The serial disposable Chromium Agent, prompt and World Info run passed 12/12 at desktop 1280x900 and touch 393x852. All pages were closed for native work; the actual serving process was killed and restarted, then reopened without another provider request. Providers and approval were controlled local fixtures, not live vendor checks. WebKit was unavailable, so iOS behaviour is inferred from Chromium.
- On 25 September 2026, the owner-authorised Oracle deployment used the committed Stage 7 checkpoint only. An exact-path private backup of all 187 previously present changed files and the previous Bun executable was verified before replacement. The deployed 353 committed files and two exact deletions were independently checked against their committed hashes; Bun was upgraded to the supported `1.3.14` while keeping the existing service runtime. The service restarted with a new process, and unauthenticated responses plus authenticated public page and new-asset checks passed. The existing private configuration and user data were not copied over, and the public service-worker override was left untouched. These checks do not establish live paid-provider behaviour or a Stage 8 browser caller.

### Stage 7 continuation entry points

- Account-bound Agent selection, processing and completion: `src/generation/roleplay-agents-source.js`, `roleplay-agent-processing.js`, `roleplay-companions.js`, `agent-completion-records.js` and `src/generation/world-info.js`. Private manual and draft workers: `agent-jobs.js` and `agent-draft-jobs.js`.
- Native tool ownership and approval: `src/generation/roleplay-tool-bindings.js`, `roleplay-tool-calls.js`, `roleplay-tool-dispatch.js`, `assistant-tool-jobs.js`, `pathfinder-tool-jobs.js`, `pathfinder-notebook-jobs.js`, `job-approvals.js`, `media-jobs.js` and `src/authoring-store.js`. Linked variable actions: `roleplay-quick-replies.js`. `src/jobs/store.js` and `src/jobs/artifacts.js` retain every parallel provider uncertainty.
- Disposable verification: `tests/neconyan-server-agents.e2e.js`, `tests/neconyan-roleplay-prompt.e2e.js`, `tests/neconyan-roleplay-world-info.e2e.js` and the native Agent, Companion, Quick Reply, tool, approval and authoring cases in `tests/*.node.js`. The browser fixture requires `NECONYAN_CONVERSATION_TEST_DISPOSABLE=1` and starts the real server with `NECONYAN_SUPERVISED=1`.
- Local evidence logs: `/tmp/opencode/stage7-final-jest.log`, `/tmp/opencode/stage7-final-node.log`, `/tmp/opencode/stage7-final-test-lint.log` and `/tmp/opencode/stage7-final-browser.log`. These are disposable evidence, not deployment inputs.

The two owner-authored workflow edits in this document and the plan remain uncommitted. Preserve them and exclude them from checkpoint commits. The Stage 7 implementation commit contains neither edit.

## Historical Stage 6 prompt contributors and media (verified)

I have completed Stage 6 at local implementation commit `9ebd74334`, on top of the owner's newer `5f1e1c120` layout and lorebook work. Stages 1-6 are verified. Continue with Stage 7 and then Stage 8 in order. The owner has requested a pause after Stage 8 is fully implemented, reviewed and verified, with a copyable handover prompt for Stage 9. The remaining Stage 9-13 scope is still authorised for continuation; nothing has been pushed or deployed.

- Enabled Pathfinder retrieval now captures its selected agent, readable books, exact file identities and saved model bindings. Legacy waypoint selection and configured multi-pass retrieval retain their inputs and results before contributing to the private Roleplay prompt. A failed or uncertain named request cannot select a different model.
- Incoming and outgoing automatic Roleplay translation saves each translated part, keeps Markdown image links and retains the original display text. Outgoing translation and completed caption metadata are committed with the reply, so an unfinished main request leaves the old chat intact. Captions run before prompt history and lore selection. Local, Horde and bundled multimodal paths include supported video inputs; reviewed manual captions use their own anchored, repeat-safe chat effect.
- Native Quick Image Gen owns configured providers, saved character settings and references, separate text-model and preset bindings, two-pass prompts, lore, styles, contextual filters, reference preparation, wildcard choices and complete batches. Advanced A1111 and ComfyUI controls remain bound to the accepted request. Queryable providers, including asynchronous Custom API jobs, save the submission ID before polling. Partial files and completed provider results survive restart. URL-only reference requests use a narrowly scoped link to the saved image bytes; they need a configured public reference address.
- Individual sprites, sheets, splitting and cleanup use saved character prompts, exact destination identities and native image processing. Ordinary sprite uploads, replacement and imports use the same account lock and refuse a target owned by unfinished native work. A replacement is durable before its previous format is removed.
- Speech captures the selected provider, voices, text preparation and playback rate. Native manual speech, Roleplay completion and newly accepted Conversation narration save ordered audio parts, including multi-voice output. The browser only plays saved parts and retains Stop and visibility checks. Bundled browser Kokoro keeps its explicit page-open exception; unavailable configured native voices or services are refused without substitution.
- Account-first locking, immutable binary inputs/results and permanent completion receipts cover the new media workflows. Open media receipts reserve their full bounded capacity before acceptance. Generic job submission cannot bypass private Roleplay or media admission. An unresolved provider step remains blocked after recovery changes the job's status. Local model replacement waits for active inference to finish.
- I reviewed the complete Stage 6 diff, batched twelve concrete correction findings, and checked only the corrections and affected callers afterwards. Regressions cover private-admission bypasses, maximum-size sprite receipts, immutable image evidence, cancellation of reference links, selected speech personas, malformed audio and output URLs, Conversation image source changes, image preflight and redirects, asynchronous Custom API recovery, and white sprite detail. The follow-up also tightened source checks for older accepted Conversation image requests without changing their saved prompt semantics.
- Final checks: 341 Jest suites, 4,538 passed tests and two skipped tests, one snapshot; 1,099 Node tests; root lint; changed-test lint across 24 files with zero errors and 213 existing-style warnings; frontend budgets; and whitespace. The serial disposable Chromium media, prompt and World Info run passed 14/14 at 1280x900 desktop and 393x852 touch-phone sizes. Two additional affected Conversation image cases passed after the last source-check correction. These checks include all pages closed, killing and restarting the actual serving process, saved-ID recovery, unknown-outcome interruption, retained files/messages and reopening without another paid request. Provider responses were controlled local fixtures, not live vendor availability checks. WebKit was unavailable, so iOS behaviour is inferred from Chromium.
- Stage 7 still owns actual tools, Agents, mutating before/after hooks and approvals. Stage 8 owns the saved progressive Roleplay workflow. Stage 9 owns production Roleplay controls and named-workflow browser cutover. The private native entry points above are verified; the current browser Roleplay generation path has not been switched over.

### Stage 6 continuation entry points

- Contributor preparation and final atomic chat effects: `src/generation/roleplay-execution.js`, `world-info.js`, `pathfinder-retrieval.js`, `roleplay-captions.js`, `roleplay-translation.js`, and `src/roleplay-jobs.js`.
- Native media admission and ownership: `src/generation/media-jobs.js`, `caption-jobs.js`, `sprite-jobs.js`, `sprite-storage.js`, `speech-jobs.js`, and `quick-image-gen-workflow.js`. Private jobs are registered during server startup; do not route their intents through generic submission.
- Saved provider inputs: `src/generation/quick-image-gen-{request,text,scoped,job,reference}.js`, provider-specific image modules, `speech-{config,voices,transports,local-requests,edge,system}.js`, and `caption-transports.js`. Binary evidence is in `src/jobs/{image,audio,binary}-artifacts.js`; common unknown-result protection is in `src/jobs/artifacts.js`.
- Disposable verification: `tests/neconyan-server-media.e2e.js`, `tests/neconyan-roleplay-prompt.e2e.js`, `tests/neconyan-roleplay-world-info.e2e.js`, and the native image cases in `tests/neconyan-conversation-durable.e2e.js`. The fixture requires `NECONYAN_CONVERSATION_TEST_DISPOSABLE=1` and starts the actual server with `NECONYAN_SUPERVISED=1`.
- Local evidence logs: `/tmp/opencode/stage6-final-jest.log`, `/tmp/opencode/stage6-final-node.log`, `/tmp/opencode/stage6-final-test-lint.log`, and `/tmp/opencode/stage6-correction-browser.log`. These are disposable evidence, not repository inputs.

The two owner-authored workflow edits in this document and the plan remain uncommitted. Preserve them and exclude them from checkpoint commits. The Stage 6 implementation commit contains neither edit.

## Historical Stage 5 authoritative prompts (verified; owner-requested pause)

- Stage 5 builds the private Roleplay prompt from protected saved history, character and persona fields, group member policy, account settings and the bound connection. It covers saved PromptManager order and depth roles, notes, examples, lore outlets, shared instruct/context formatting, reply bias and guidance prompts, reasoning, names, local file text and supported image inputs. Append, continuation, swipe and replacement use their correct saved history view. Prompt transformations and scanned notes are retained before scanning; fitting the context does not reroll their macros.
- Provider-specific chat and text counters cover the complete formatted input, image allowances and function schemas. Optional examples use spare context; required progressive results and Mewmory context cannot be discarded by ordinary history trimming. Mewmory uses the shared native preparation path with account-before-chat/memory access and checks its source fingerprint again before dispatch. Saved model capability metadata governs media, tools and signatures.
- Completed native contributors can publish immutable extension prompts, linked tool-call/results and function schemas before preparation. The worker builds the next prompt from those saved inputs, preserves literal model-produced text, and stores the prepared prompt and macro state. Chat, text and legacy provider preparation retains request controls before dispatch without saving transport credentials. Known completed results can be delivered after restart even if the connection is subsequently removed; unknown outcomes remain interrupted.
- This is the prompt-assembly boundary. Stage 6 still owns execution of retrieval, translation, captions, sprites, speech and the complete configured Quick Image Gen pipeline. Stage 7 owns actual tools, Agents and mutating hooks; Stage 8 owns the progressive workflow and speaker/swipe orchestration; Stage 9 owns the real browser cutover. Enabled Pathfinder, Quick Reply and unsupported scan contributors still refuse before paid work. Local Mewmory recall does not silently launch an unrecorded background retrieval. Saved responses containing tool calls, with or without ordinary reply text, remain pending native tool execution and cannot repeat the provider request. No production Roleplay browser caller submits the private job yet.
- The selected model reviewed the whole Stage 5 diff from `7d0b7f268`, including local checkpoints `78fcdb320` and `e941f17e6`; the final implementation is `62379dd1d`, then batched corrections and checked only those corrections and their callers. Regressions cover one-time scanned-note expansion, empty transformed history, guidance depth, legacy preparation replay, and late anchor-compatible delivery without a needless timing write. The correction-only follow-up also reproduced and corrected mixed text/tool results being treated as complete; their saved replay now stays pending. Strict range anchors and genuine timed-effect conflicts remain enforced.
- Final evidence: 338 Jest suites (4,521 passed, two skipped; one snapshot), 901 Node tests, root lint, changed-test lint (zero errors; existing test-style warnings), frontend budgets and whitespace passed. The serial disposable Chromium prompt/lore suite passed 8/8 at desktop 1280x900 and touch phone 393x852, including real chat/text Send, native completion with all pages closed, duplicate-key reuse, and restart/reopen without another provider call. The full Jest and frontend-budget results were reused after server-only corrections; affected server and browser checks were rerun. The last tool-result-only correction was covered by the complete 901-test Node rerun; the eight browser cases do not request tools. Safari/WebKit was unavailable, so iOS behaviour is inferred from Chromium.
- Repository: `/home/platinum/Neconyan`, branch `staging`; final implementation checkpoint `62379dd1d`. No push or deployment occurred. The two owner-authored workflow edits in this document and the plan remain uncommitted and must be preserved. The owner requested a pause after Stage 5; Stage 6 has not started. In the next session, resume Stage 6 and continue Stages 6-13 in order under the same authority and verification rules.

### Stage 5 continuation entry points

Use `src/generation/roleplay-execution.js` for the private compiler and delivery boundary; `roleplay-chat-prompt.js`, `roleplay-text-prompt.js`, `roleplay-prompt.js` and `roleplay-budget.js` for construction and fitting. `roleplay-contributions.js` publishes already completed native inputs; it does not execute a contributor. `roleplay-capabilities.js` saves selected-model input metadata. `service.js`, `text-request.js` and `legacy-request.js` retain bound request preparation. `src/mewmory/prepare.js` supplies shared recall preparation. Focused regressions are `tests/roleplay-prompt-assembly.node.js`, `tests/roleplay-text-prompt.node.js`, `tests/roleplay-budget.node.js`, `tests/roleplay-capabilities.node.js`, `tests/generation-profiles.node.js` and `tests/neconyan-roleplay-prompt.e2e.js`.

## Historical Stage 4 saved World Info activation (verified)

- Stage 4 builds the real World Info selection on the server from a protected chat and its saved character, persona, account settings and selected books. The browser and server share keyword, regex-key, inclusion-group, probability, entry-order and timed-window decisions. The server runs recursive passes with exact local token counts and a bound provider context limit, saves random draws and bounded per-pass hook decisions before any paid provider request, and applies selected timing metadata only with the recorded chat effect. Selected books, local files, the effective chat-locked or connected persona, and the account are rechecked before dispatch. The browser now installs a depth-position persona prompt before scanning rather than after it.
- The private reply worker keeps the saved scan and final activation through replay; it does not reroll a saved result or repeat an unknown paid-provider call. Per-job MacroEnhanced lore macros are the supported production read-only activation consumer. The saved hook policy records eligible Pathfinder agents, linked Quick Reply action identities and other scan contributors under the account lock, without storing their scripts or credentials in the job. Enabled Pathfinder retrieval, linked Quick Reply actions, and vector or Agent scan contributions that need later server ownership refuse before provider work. Their retrieval and action execution belong to Stages 6, 7 and 13, not to this Stage 4 acceptance. Browser-only observers such as Prompting Lab remain for Stage 12. No production Roleplay browser caller exists yet.
- The Stage 4 self-review covered the scanner, browser shared callers, source and book identity, account-specific hook policy, saved passes and private worker across all local Stage 4 commits (`349f0f7cf` through `2eb54b7ea`). Reproduced findings about timed windows, third-state book aliases, wrong-trigger and damaged artefact replay, unbudgeted hook changes, missed scan-eligible prompts, saved persona selection, hook ordering and omitted vector/Agent contributions were corrected with focused regressions. The correction-only follow-up found no further reproduced Stage 4 defect in the supported selection path.
- Verification at `2eb54b7ea`: 338 Jest suites (4,521 passed, two skipped), 854 Node tests, root lint, changed-test lint (zero errors), frontend budgets and whitespace passed. The disposable Chromium World Info suite passed 4/4 at desktop 1280x900 and touch phone 393x852, including a real Roleplay generation with a saved depth persona. These checks establish private server selection and the affected browser scan, not whole-workflow browser cutover or Safari/WebKit behaviour. Selected books are limited to 8 MiB each and 16 MiB combined; protected snapshot, hook-pass and job-artefact budgets refuse before paid work when exceeded.
- The owner requested a pause after Stage 4. Start the next session with Stage 5 full server prompt construction, then continue Stages 6-13 in order. No push or deployment was performed; preserve the local working tree and accepted checkpoints.

### Stage 3 accepted bound execution

- Stage 3 checkpoints: `5196f4345` private accepted Roleplay reply worker and unknown-provider interruption; `267c0ed8b` shared reasoning and signatures; `94f83e73d` bounded native stream completion; `9d9db297d` safe bound custom request controls; `20f4b7fe0` bound chat cleanup and unsupported stream-output refusal; `0e80ef58e`, `5a4f9d812` native Responses API and Ollama completion checks; `2f69847f0`, `92955c39d` Mistral reasoning, split UTF-8 and late stream errors; `29c0e7901` active Kobold, NovelAI and Horde bindings; `e489a8bfe`, `46be9d544`, `3c123683f` stage-end self-review corrections for legacy controls, NovelAI account tier, renamed job sources and post-completion stream output. The independent stage-end review was unavailable; the selected model reviewed the full Stage 3 path and affected callers itself, with focused failure reproductions.
- The private `roleplay.reply` worker checks accepted account and source identity before dispatch, resolves only the captured connection at execution, preserves a complete provider result before applying a recorded append, continuation, swipe or range replacement, and replays saved output without calling the provider again. Request credentials are resolved server-side and excluded from prepared artefacts; provider output is saved as received. An accepted job follows its chat through a recorded rename; unrelated later edits are allowed only when its captured message or range anchor still holds.
- Named chat/text profiles, acknowledged active chat/text connections and active Kobold, NovelAI and Horde selections use native server handlers. Chat/text streaming requires complete bounded output; malformed, incomplete and error events are refused. Kobold and NovelAI token-only streams have no reliable terminal marker, so bound work uses their non-streaming native result and explicitly refuses a streaming request. Horde saves its accepted task ID before polling and never repeats an uncertain submission; NovelAI checks the account tier before requesting a Kayra/Erato output length. Unknown paid-provider outcomes remain interrupted, not retried automatically.
- Verification: at `3c123683f`, 338 Jest suites (4,510 passed, two skipped), 744 Node tests, root lint, budgets, changed-test lint (zero errors) and whitespace passed. The Kobold settings acknowledgement passed 2/2 disposable Chromium cases at desktop and phone sizes. The full Stage 2 browser result remains 167/167 at `3093d0ec2`; these Stage 3 checks exercise private work with controlled local providers, not browser cutover or Safari.
- Stage 5 owns complete server prompt construction, Stage 8 whole Roleplay workflows and Stage 9 browser cutover. There is no browser caller for the private Roleplay admission yet. Do not push or deploy.

### Stage 2 accepted storage boundary

- Last accepted checkpoint commit: `9fddf069004d7a349dd95f255af40a819a9e3395` (`feat: record durable chat imports`), with protected storage/editor authority (`54d97f8f8`) and recorded existing-group updates (`5c4d2729b`). Its details are in the historical records below.
- Stage 2 checkpoints since then: `7702a14db` recorded protected chat deletes and renames; `8a7c05c43` recorded group creation and deletion; `08f424c43` recorded character create, import, edit, duplicate, rename and delete; `c05b5c673` recorded Data Maid deletion, bundled-content retirement and restore, seeding and folder/ZIP backup imports of protected files; `df71fc588` account reset and admin purge with a fresh data epoch, retired jobs and recreation with a new account identity; `fc872e2cd` private paused-job admission with typed append, continuation, swipe and range-replacement effects, late-callback rejection, and Conversation asides bound to the chat instance; `7cb542609` documentation; `275e02e58` the first stage-end correction pass; `2dc037f96` the correction-only follow-up's physical-publication and alias findings; `3093d0ec2` recorded BYAF scenarios and first-time folder/ZIP protected-file imports.
- Shared mechanism: one recorded lifecycle transaction (`kind: 'lifecycle'`) with delete, move, discard, create and update steps plus auxiliary tasks (memory, recovery sidecars, date-added records, chat folders and loose-card cleanup). Capacity is checked before the pending record is saved, and the pending record is saved before any file changes. New and updated cards and groups are published through a temporary sibling: its exact physical identity is persisted before the rename, so recovery adopts only that file and retains third-state changes. This replaces in-place card and group updates; a successful update has a new physical identity in the saved head. Interrupted loose-card removal is completed before the receipt closes. Memory renames resume from every interrupted state, and a closed receipt replays the original result. Untracked legacy files keep their old code paths behind the untracked-file guard, which checks aliases as well as resources of the current account and data epoch.
- Receipts: client-keyed operations keep permanent receipts. Server-generated one-shot keys (card writes, Data Maid, seeding, retirement, imports and unkeyed lifecycle calls from extensions) delete their closed receipt and staged copies once the result is saved, because no caller can replay them.
- Reset and deletion: the reset is saved as pending maintenance first, then jobs are moved to a retired folder, preparing and accepted job receipts are voided, user files are removed (reset and purge) or kept (retire), resources become deleted and the data epoch increases. Deleting a user retires or purges its protected account before the user record is removed; recreating the name settles any interrupted reset and starts a new account identity. Stamped requests from an earlier epoch are refused as `ROLEPLAY_ACCOUNT_CHANGED`; Data Maid reports and folder/ZIP imports carry the stamp captured when they started. Late job callbacks are refused.
- Startup: reconciliation runs per account before migrations, plugins, listeners and workers; job pruning only happens during job writes. An account whose recovery fails is logged and keeps refusing protected writes; other accounts still start.
- Jobs: an admitted job reserves room for its completion write at admission, is bound to the chat identity (it follows a rename), checks the job ledger's intent against its receipt, and may shrink the chat only for an explicit range replacement. The native save refuses destructive shrinks before the transaction is saved.
- Limits: interrupted lifecycle work is finished by startup reconciliation, so the affected account refuses further protected writes until restart. Browser card and group edits and bundled seeding carry no account stamp, so they bind to the epoch current when the request arrives. A lifecycle transaction is capped at 4096 steps and 2 MiB of pending record, so a character with roughly 3,500 or more chats cannot be renamed or deleted in one operation. Mewmory readers take the chat lock before the account lock through the write-recovery guard; this is harmless with one serving process. Paused-job admission has no browser caller yet; Stages 8 and 9 connect it.
- Verification: the full combined Stage 2 browser command passed all 167 cases at `3093d0ec2` (1.5 hours), including the two group account-switch saves that failed in the earlier 165/167 run. At this checkpoint, 338 Jest suites (4,510 passed, two skipped), 713 Node tests, root lint, changed-test lint (zero errors), budgets and whitespace passed. The folder and ZIP settings-restore browser cases passed separately; BYAF scenario recording, first-time chat/card/group imports, interrupted BYAF creation and embedded `.png` folder ownership passed focused Node checks. Safari/WebKit remains unverified.
- The Stage 2 browser admission and whole-workflow ownership boundaries are covered by later stages; the Stage 2 result above is historical verification, not completion of the whole migration.

Work efficiently: targeted checks while editing, full unit/Node checks, root lint, changed-test lint, budgets and whitespace before each local checkpoint commit, and no review after individual helpers, fixes or checkpoints. Do not restart the full migration analysis after each helper. The full combined serial browser suite and whole-stage audit were required and completed for Stage 2. Historical counts below are not current approval.

## Implemented and checked

- Saved per-account jobs, bounded acceptance and storage, fair dispatch, cancellation, private provider-result files, explicit retry and recovery of known results. Unknown provider outcomes require explicit retry. Damaged ledgers fail closed for that account, preserving completion records.
- Mewmory automatic extraction and backfill have a saved server worker. Manual recall and full index rebuild use saved jobs. Indexing retains valid vectors when a message arrives during a batch. Native deletion and source checks remain in place.
- Modern and legacy macros share browser/server code with per-operation state. A 22-case historical browser fixture set verifies variables, selection/random helpers, basic transforms, conditions and legacy substitutions. It does not cover every time, chat, character-card or persona macro. Node resolves the existing dependencies through a package import; the browser uses an import map. Runtime minimums were not raised.
- Chat-profile controls, preset conversion, provider parameters and Conversation prompt/reply composition share pure functions. Named chat profiles without a preset retain their existing raw-request behaviour. Saved bindings contain references and fingerprints, not resolved credentials.
- The accepted Conversation reply API captures an existing saved branch, named chat or text-completion profiles, persona notes, group-memory and schedule context. Eligible participants' connection references are recorded before input acceptance; later mentions still select speakers, while a changed connection selection starts a separate batch. Provider results are retained separately from native delivery. Bubbles, reminders and status effects are saved together with records preventing duplicate application. Completed replies can finish delivery after the saved profile is removed.
- Named text requests reuse the browser's provider parameters and scoped instruct formatting for all 15 text providers. Saved template substitutions, stopping strings, token bans/bias, service tiers and credential references stay request-scoped. Unavailable or substituted tokenisers are refused. Prepared random values and completed results are reused during recovery.
- Saved-active requests use the actual acknowledged controls, URL, model and credential references, independently of the selected named profile. Acknowledgement comes from the exact serialised successful settings save and refuses newer unsaved edits. Validation runs before composer uploads and acceptance, using the same raw formatting, macro order and stopping-string passes as execution. Unsupported browser capabilities and dynamic output transformations are refused rather than silently omitted.
- Manual regeneration and polishing run as native `conversation.rewrite` jobs, manual selfies as native `conversation.selfie` jobs and manual schedule generation as the native `conversation.schedule` job (Stage 10). A failed named profile cannot fall back to active settings. Captured source hashes, branch identity and speaker eligibility are checked before dispatch and again before the one receipt-protected completion write; the browser no longer writes any of these results. Memory refresh submits a native summary job; handwritten memory, clearing and hand-edited schedules use a native version-checked write. Native summary/schedule jobs accept acknowledged active bindings and retain exact retry identity.
- The older Conversation send API retains user messages on provider failure, preserves an old reply during failed regeneration and merges completed replies without overwriting unrelated threads. External callers must retry a failed generation using the returned version and `reuseLastUser: true`; repeating the original message ID is rejected as a duplicate.
- Reminder clock parsing now treats a value such as '21:30' as a local clock time rather than 21 minutes; timezone, daylight-saving and spelled-out duration units have checks.

## Committed Stage 1: Roleplay storage preparation

The first Roleplay preparation stage adds a trusted native read-modify-write operation through the existing chat lock, save, backup, exact recovery and branch-memory paths. It requires the captured raw-file hash even when legacy integrity checks are disabled, refuses unsafe or corrupt sources before mutation, validates synchronous JSON-only changes and returns authoritative records with their saved integrity value. No-op writes retain original bytes and file identity; native metadata changes are not discarded by legacy display-equivalence comparisons.

Errors distinguish a committed chat with failed follow-up cleanup or memory capture from an uncertain write. Callers must reconcile uncertain saved/recovered content before repeating a mutation or associated external work. Lock cleanup cannot replace an earlier error or erase its outcome. At that Stage 1 commit, this was storage preparation only: it added no Roleplay job handler, acceptance endpoint, protected receipt schema or browser generation cutover.

Stage 2 continues protected Roleplay instance identity, full-intent acceptance records and repeat-safe completion mutations across ordinary saves, forced saves, branches, imports, restores, renames and deletion. Its current state is recorded above. The ordered continuation stages are recorded in the phase checklist. Full prompt construction, progressive group turns, tools and extension processing must run without further browser-prepared requests; the earlier single-request-only proposal was rejected, not accepted as a reduced scope.

## Preserved Conversation integration checkpoints

The main Conversation composer, the forced-reply action and the branch-from-message reply now submit to the accepted-reply API. These entry points observe accepted jobs and read the server's saved messages. Their browser checks are recorded below; this does not establish complete Conversation migration.

Automatic ownership is implemented and verified. Continue with Roleplay generation and completion writes, then the remaining whole-application scope. This is not completion of the full migration.

The integrity checkpoint resolves findings a-e:

- a. The downloaded Conversation baseline and its exact version are captured before migration; unrelated general saves cannot advance that pair.
- b. Server-derived history fingerprints and edit counters distinguish legitimate 250-message retention from destructive changes. New work stamps legacy history before capture; unprovable older captures remain refused. Snapshot restoration, folder/ZIP settings imports and settings reset preserve increasing versions and invalidate changed history.
- c. Acceptance saves branch creation identity, and batch repair validates each member's own anchors and partial progress. Replacement branches cannot inherit old work.
- d. Member retry keys compare complete canonical intent. Historical members whose full intent was never recorded refuse ambiguous replay rather than guessing from the leader.
- e. Identifier-less messages merge by content and occurrence count. Ambiguous concurrent additions, deletions and replacements preserve local data and refuse saving. A lost successful new-branch save can recover without treating server metadata as a content conflict.

Latest integration checkpoints:

- f. Done. Native solo replies have send-triggered partner chimes through the durable jobs. Saved ownership prevents a periodic scan from accepting the same occurrence again, including after cancellation and job-history pruning. The earlier browser observation fence has been removed with the browser worker.
- g. Done for native delivery. Incoming messages save unread and pending presentation records with their completion receipts. Atomic claims select one presenting tab; observed read boundaries cannot clear newer unseen messages. Visible-page discovery retries claims and read acknowledgements independently of job completion or repainting. OpenAI, OpenAI Compatible, ElevenLabs and Pollinations narration uses saved audio; Kokoro remains page-open-only. Server-side narration refuses System, unsupported providers and multi-voice configurations explicitly; Kokoro retains its browser behaviour. Image captions, including manual selfie captions since Stage 10, use the same narration path. A definite speech refusal or a non-audio response now saves the reply text with a failed narration instead of stopping the reply.
- h. Done. Loading the app for an account with existing Conversation usage, or starting Conversation usage, persists server ownership, timezone and the revision of settings actually saved for background use. Visiting the Conversation panel is not required for existing users. Later successful general saves acknowledge the new revision atomically. The browser periodic sender, automatic timers, memory-summary timer and chime observation fence are removed. The 20-second browser poll only discovers saved work and presents it. Roleplay rendered-message sampling still submits native asides.
- Ownership and accepted occurrences survive stale saves and settings replacement. Server memory is protected on surviving threads and branches; removing those threads also removes their memory. Legacy message identities and unread boundaries migrate without dropping empty history or invalidating an exact identity-only repair. Exact copies of saved automatic messages can start branches or group histories; newly generated stale-browser automatic messages cannot be appended. Staging-era bound automatic and memory requests are refused before provider dispatch. Generic provider calls from pre-migration pages cannot be attributed to Conversation, but their automatic completion writes are rejected or restored to authoritative state.
- Reminder identity survives old retry-window keys, branch changes and job pruning. Startup preserves old ownership before plugins, listeners or runners can prune its evidence; a failed migration holds pruning for that account. Acceptance markers are never evicted to make room: the existing store-size limit fails closed. Failed/interrupted work needs explicit retry; cancellation does not create a replacement occurrence. An autonomous preparation failure can be retried through its original saved job.
- Automatic summaries recheck enabled state, include attachment-only messages and retain both scanned and frozen history identities before dispatch. Manual refresh, overwrite and clear are native; clear advances coverage so the same history is not immediately summarised again. A pending result cannot overwrite later memory changes. Unfinished legacy summaries without a memory fingerprint are interrupted before a provider request and require a new explicit refresh.

1. Done. Named text-completion/instruct requests and acknowledged saved-active bindings are implemented. Composer validation precedes uploads and acceptance; the manual helper has no error-driven fallback. An uncertain accepted submission retains its exact body and key through a rate-limited retry and later settings changes.
2. Participant selection, group concurrency, availability/autoresponder delays, assistant context and image delivery have native implementations. Images use the account's own Quick Image Gen provider only; unsupported providers are refused without substitution. Explicit reply targets override mention-weighted selection. Send-triggered solo partner chimes run through durable jobs and have saved occurrence ownership. Participant preparation retains the accepted binding through the batching window; legacy unfinished records without that evidence cannot reconstruct it from current settings.
3. Done. The composer submission and the already-appended-message reply event now submit to durable acceptance (`POST /reply/submit`). Attachment-only sends, blank forced replies, server-side coalescing, explicit reply targets and message-revision checks are preserved; the composer appends no messages and clears the draft only after acceptance and the required user-message writes are durable.
4. Done. The browser observes accepted native jobs (`public/scripts/neconyan-conversation/native-jobs.js`) and merges authoritative results by reading the saved store; observation never executes delivery. A separate version-checked Conversation save path (`public/scripts/neconyan-conversation/store-sync.js`, `store-sync-utils.js`) keeps browser edits honest, and the settings guard protects server-owned messages, records and bookkeeping from old whole-store writes while allowing intentional edits and deletions.
5. Reminders, weekly and legacy schedules, idle and proactive messages, chimes, character chat and memory summaries run on the server worker, with deterministic occurrence keys, one-time bookkeeping claims and a per-account saved timezone (`POST /automation/configure`). The manual schedule control now submits the native schedule-generation job and hand edits save through the same route as a version-checked write (Stage 10). The Roleplay/group-aside bridge is native: `POST /aside/submit` accepts a saved source locator and revisions, builds the directive server-side, delays 900 ms for a mention or 2000 ms otherwise through the durable job delay, records the group-aside cooldown by persona, source group and recipient, and re-asserts the saved source through generation, narration, receipt reuse, command writes and image delivery.

Use the shared reply-delivery function with a native host. Preserve first-bubble command timing, partial output, reply references, image requests and per-effect completion records. Never hold a filesystem lock while awaiting a provider.

## Remaining whole-application scope

- Roleplay group turns started from the browser's group controls, and Roleplay chats whose page-only prompt additions cannot travel, still generate in the page (Stage 9 boundary).
- Server-capable attachment, caption, sprite, audio and image workflows not already covered by Stages 5-10.
- Meower feed/profile/interaction waves using its existing revisioned native store.
- Prompting Lab, Distiller, LoreStitch and World Info Lab, retaining proposals and explicit review before applying changes.
- Remaining translation, vector, automation, archive, import, backup and maintenance workflows. Preserve existing data formats and per-file recovery where operations span multiple files.

Do not treat arbitrary DOM-dependent user scripts as portable server code. Identify incompatible dependencies before accepting their work. Do not add hidden browsers or fake DOMs to claim server ownership.

## Verification and release gates

Historical committed Stage 1 Roleplay storage preparation: all 335 Jest suites passed, with 4,413 tests passed and two skipped (4,415 total), plus one snapshot. All 294 Node tests passed, including 27 new native-mutation checks. Root lint, frontend budgets and whitespace checks passed. Lint of the four changed test files had zero errors and 14 warnings; no full tests-folder lint claim is made.

All 149 disposable Chromium cases passed in one complete serial run (1.3 hours): the existing 145 Conversation cases and four new solo/group storage cases at desktop 1280x900 and touch 393x852. The new cases use real edit and branch controls, close every page, invoke the trusted storage helper on the disposable branch, restart the actual serving process and reopen its authoritative content. They check retained swipes/reasoning, visible chat geometry and zero model-provider calls. They do not establish native Roleplay generation. The first full run passed 148/149; a phone Conversation message-edit setup received a settings-version conflict. That unchanged case passed in isolation, then the complete second run passed. No served runtime files changed during either full browser run. Safari remains unverified.

The fresh independent reviewer's actual assistant-message metadata was verified as pura-openai/gpt-6-astra, variant max before assignment and checked again after review. Three initial findings and one follow-up were fixed and re-reviewed: committed/uncertain writes retain their outcome through write and lock cleanup failures, unsafe paths cannot trigger recovery before rejection, and exact snapshots preserve an opening UTF-8 marker. Added failure-injection checks reproduced these failures before their fixes. The final source review found no remaining concrete stage-local problem. The final lint-safe cleanup structure was re-reviewed and the full checks rerun.

Historical automatic-ownership checkpoint: all 335 Jest suites passed, with 4,409 tests passed and two skipped (4,411 total), plus one snapshot. All 267 Node tests passed. Root lint, frontend budgets and whitespace checks passed. Changed-test lint had zero errors and 45 warnings; this is not a clean full tests-folder lint claim.

All 145 disposable Conversation cases passed in one complete serial Chromium run (1.3 hours), at desktop 1280x900 and touch 393x852. Eight added ownership cases cover saved-active acknowledgement followed by zero-page reminders, failed reminders remaining stopped for 65 seconds before explicit retry, stale automatic append refusal, actual memory controls completing with the page closed, a live memory panel updating and a later clear surviving an earlier pending result. Existing presentation, chime, retention, restore, account-isolation and real-process crash cases also passed. The first full run passed 144/145: one older test expected a duplicate chime job that the new pre-acceptance ownership correctly prevents. Its replacement asserts no duplicate job, retained ownership, unchanged provider calls across two scan intervals and a later reminder firing after restart. It passed in isolation and in the second full run. The earlier focused 21-case run is a separate result.

Independent review used actual assistant-message metadata verified as pura-openai/gpt-6-astra, variant max. An exhausted reviewer session was replaced only after explicit owner permission; the replacement was verified before assignment. All stage-local findings were corrected and re-reviewed. Node checks, rather than browser claims, establish upgrade-before-prune ordering, failed-migration pruning holds, old reminder/chime/summary ownership recovery, exact identity repair, copied automatic history, fresh eligibility, memory conflict rejection, insecure-context submission-key fallback and attachment-aware automatic summary selection across successive batches. Safari remains unverified.

Historical unread/presentation/narration checkpoint: all 335 Jest suites passed, with 4,395 tests passed and two skipped (4,397 total), plus one snapshot. All 257 Node tests passed. Root lint, frontend budgets and whitespace checks passed. Changed-test lint passed with zero errors and 43 warnings.

All 137 disposable Conversation cases passed in one complete serial Chromium run (1.2 hours), including all 21 new presentation cases. Desktop 1280x900 and touch 393x852 checks cover zero-page synthesis, one presenting tab across two pages, actual saved-audio retrieval and playback, read badges, Stop during claims and downloads, thread/message changes, controlled hidden-page state, automatic claim/read-only retry and two idle tabs without save churn. Speech-provider failure and rejected HTML retain the text; a real serving-process SIGKILL during synthesis stays interrupted until explicit retry. Hidden-page state is simulated in Chromium; Safari remains unverified. The first full run passed 136 of 137, failing the previously recorded legacy merge fixture's startup-save race. That test now waits for a bounded quiet settings version before its single exact-version append, without retrying the append or weakening merge assertions. It passed five focused repetitions and then the complete 137-case run. Earlier 19-case and two-case focused presentation runs are separate results, not substitutes for the final full run.

Independent review used a fresh reviewer whose actual assistant-message metadata was verified as pura-openai/gpt-6-astra, variant max. Earlier wrong-provider reviews do not satisfy this gate. All stage-local findings were fixed and re-reviewed: uncertain speech outcomes and damaged artifacts cannot trigger silent repeat billing; completed effects avoid repeat synthesis while revalidating their sources; content types and response cleanup are checked; read boundaries, stale claims, edited sources, persona/group changes, freshness, Stop and asynchronous playback waits are guarded; idle discovery causes no settings-save churn. Failed read-only acknowledgements retry, and late acknowledgements cannot hide newer unread messages. Known-mode browser-worker guards are verified code changes, not a claim of complete automatic ownership.

Historical active-binding checkpoint: 334 unit suites passed, 4,335 tests passed and two skipped; all 230 Node tests passed. The full tests-folder lint run reported historical errors in untouched files. These are earlier results, not proof that unfinished callers have migrated.

The chime checkpoint ran the full disposable Conversation suite: all 116 cases passed in one serial Chromium run (57.8 minutes). The 12 added chime cases cover desktop and touch Send/Enter with a zero-page completion and an offline partner, a two-profile duplicate race, five exclusion cases (offline or autoresponder primary, an explicit reply target, an already-answered mention and an unmentioned partner), an image-only chime with a real process restart and a 65-second server rescan, and a refused chime-only occurrence that skips the whole family and retries later. A first run of the same suite passed 115 of 116; the single failure was an unrelated pre-existing flake ('legacy repeated messages survive concurrent native additions and unrelated local edits'), which is untouched by this change, passes 5 of 5 in isolation, and passed in the second full run. The close-the-page chime cases cannot observe the browser-worker duplicate race, which is pinned by unit checks on the observation fence instead.

Earlier active-binding checkpoint: The complete browser run passed all 95 then-current durable Conversation cases and both scoped-formatting cases. Two acknowledgement tests exposed a fixture race: a queued later save genuinely acknowledged the edited controls. Holding that later save before forwarding fixed the test; both acknowledgement cases then passed. Nine added durable cases also passed in focused runs, bringing coverage to 104 durable cases plus four formatting/acknowledgement cases. This was not a single green 108-case run. Active Chat and Text controls were exercised at 1280x900 and touch 393x852, including zero-page completion. Additional checks cover rejection before uploads, exact retry after a lost response and 429, changed character scripts, manual source/speaker changes during preparation, stored inline images and hashing without native Web Crypto.

The following named-text and integrity results describe earlier checkpoints.

Eight new named-text Chromium cases passed for real Send, Enter, 'Ask for reply' and 'Branch from here' at both required sizes, including zero-page completion and reopening. Two group cases passed for later mention selection and changed-binding batch separation. The suite now contains 62 cases; this checkpoint reran those ten cases, not the entire expanded suite. Two separate browser parity cases previously verified the shared formatting and provider helpers.

The disposable Conversation Chromium suite has 52 cases: 51 passed in the complete run; the lost-new-branch-response test passed after correcting its interception to drop a successful save rather than an initial version conflict. Real Send, Enter, 'Ask for reply' and 'Branch from here' were exercised at 1280x900 and touch 393x852. Checks cover zero-page bubbles/reminders/status/images, reopening without repeat calls, retained drafts, lost acceptance retry, cancellation during preparation/generation/delivery, source and target conflicts, stale unrelated saves and two-account isolation. Three restart boundaries kill the actual serving process with SIGKILL, then restart with the same disposable data. Added cases cover multi-bubble retention at 249/250 messages, restart during capped delivery, startup migration racing native completion, same-key branch replacement, legacy merging and all four settings-replacement paths. Unknown text-provider outcomes remain interrupted.

Browser reproduction and independent review fixed a broken account-getter import, a decorative cat intercepting the message menu, cross-account submission/upload/preliminary-chat-write gaps, startup ownership binding, queued-save ownership and observer refresh coalescing. Review also corrected the test's original supervisor-only kill and added collection-time opt-in skipping. A deterministic thumbnail cache regression now covers different bytes with identical file size and modification time; cached responses identify their actual contents.

Limits: Safari is unverified; generation cancellation uses the real HTTP endpoint because no Conversation generation Stop control is wired. Narration Stop is exercised through the actual TTS control. Lost-send-response retry identity is page-memory-only. Completed-image reopening does not prove recovery during an unresolved image request. Manual Conversation regeneration, polishing, scheduling and selfie coordination still need native completion writes. An account with existing Conversation usage must load the updated app once to persist the new ownership; the most recently configured page supplies its timezone. Non-browser general settings saves leave a background active binding stale until a subsequent browser save or ownership acknowledgement. Browser-only connections are refused for server automation without provider substitution. Visible discovery polls every 20 seconds and the server scans automatic work every 30 seconds. Claim atomicity assumes one serving process. Active Text structured JSON/reasoning-budget requests and unavailable browser macros are refused; supported static output transformations retain their captured permissions and character-script hash.

Earlier Chromium checks passed for all three Mewmory scenarios and macro parity at desktop and touch-phone sizes. Their saved-state recovery checks should not be confused with the later real-process Conversation restart checks.

For every migrated workflow, verify its real interface entry point, zero-client completion, reopening without replay, cancellation and late results, duplicate keys, changed/deleted targets, two-account isolation and actual process restart on disposable data. Unknown unqueryable provider outcomes should remain interrupted, not trigger an automatic charged repeat. Use controlled fake providers rather than paid requests.

Earlier Fable reviews covered jobs, macros and Mewmory and prompted fixes. A later Mewmory follow-up was cancelled. A bounded whole-checkpoint Fable review was completed before this commit. Its reminder-unit, artifact-cleanup, idle recovery-write and damaged-ledger panel findings were fixed and checked. The final complete-migration review has not happened; this checkpoint is not release-ready.

Known continuation tradeoffs: the dispatcher still reads known account ledgers every 500 ms while idle, and completed provider artifacts remain until their job is pruned. Consider idle scheduling and storage retention once their recovery requirements are settled; do not delete intermediate results needed for explicit retry. Artifact cleanup after byte-cap pruning is covered by a regression check. Damaged job ledgers remain untouched and fail closed for job operations while readable Mewmory state remains inspectable.

Before deployment, read the stored deployment references and verify them against the live service. The live installation is a copied checkout rather than a Git working tree. Determine the actual deployed baseline, back up exactly the changed paths and deletions, preserve real configuration and data, copy only committed runtime files, compare hashes, restart, then verify authenticated assets and an accepted workflow. Keep hostnames, paths to keys and credentials out of repository documentation. The live tests tree is stale and should not be copied as application runtime.

Verify automatic Mewmory settings before starting the deployed server: startup can process pending sources in every enabled saved story for accounts with auto-update and an extractor enabled, even with no browser open. This is broader than the old open-chat behaviour and can make paid provider calls. Include the affected saved state in the backup and rollback assessment. Idle job recovery no longer creates or rewrites an empty ledger at every startup.

## Files and commands

```text
Instructions: AGENTS.md, PRODUCT.md, DESIGN.md
Progress: docs/server-migration-plan.md
Ownership: docs/server-architecture.md

Jobs: src/jobs/{store,runner,artifacts}.js
Job API and client: src/endpoints/jobs.js, public/scripts/jobs.js
Mewmory: src/mewmory/{worker,operations,retrieval}.js
Macros: public/scripts/macros/, src/macros/
Profile execution: src/generation/{profiles,service,context}.js
Conversation jobs: src/generation/conversation-jobs.js
Native effects: src/generation/conversation-effects.js
Captured context: src/generation/conversation-context.js
Conversation API: src/endpoints/neconyan-conversation.js
Native settings: src/endpoints/conversation-store.js, src/settings-version.js
Composer and acceptance: public/scripts/neconyan-conversation/attachments.js (browser), src/generation/conversation-jobs.js (server)
Native observation: public/scripts/neconyan-conversation/native-jobs.js
Conversation sync: public/scripts/neconyan-conversation/store-sync.js, store-sync-utils.js
Browser delivery: public/scripts/neconyan-conversation/generation.js
Shared delivery: public/scripts/neconyan-conversation/reply-delivery.js
Browser persistence: public/scripts/neconyan-conversation/context.js
Native chat mutation: src/endpoints/chats.js (mutateChat)
Storage regressions: tests/chat-mutation.node.js, tests/chat-save-interprocess-lock.test.js,
                     tests/chat-recovery-endpoints.test.js, tests/neconyan-roleplay-storage.e2e.js,
                     tests/neconyan-roleplay-import-retry.e2e.js, tests/roleplay-import.node.js

Focused checks: tests/neconyan-conversation-api.test.js
               tests/generation-profiles.node.js
               tests/conversation-*.node.js
               tests/jobs*.{test,node}.js
                tests/mewmory.e2e.js
                tests/neconyan-conversation-durable.e2e.js
               tests/macros.node.js, tests/macro-parity-browser.mjs
```

```bash
export PATH=/home/ubuntu/.nvm/versions/node/v24.13.0/bin:$PATH TMPDIR=/tmp/opencode
NODE_OPTIONS=--max-old-space-size=8192 npm run test:unit --prefix tests -- --runInBand --silent
node --test tests/*.node.js
npm run lint
npm run check:frontend-budgets
git diff --check
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 node tests/node_modules/@playwright/test/cli.js test --config tests/playwright.config.js neconyan-conversation-durable.e2e.js neconyan-conversation-manual-helpers.e2e.js --browser=chromium --workers=1 --reporter=line --trace=retain-on-failure
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 node tests/node_modules/@playwright/test/cli.js test --config tests/playwright.config.js neconyan-conversation-durable.e2e.js neconyan-roleplay-storage.e2e.js neconyan-roleplay-import-retry.e2e.js --browser=chromium --workers=1 --reporter=line --trace=retain-on-failure
```

On the Oracle VM the system `node` is too old, so put nvm Node 24 first on `PATH`, and give the single-process Jest run an 8 GiB heap, because the default heap runs out after about 300 suites. Allow at least 7,200,000 ms for the full combined browser run. Use disposable data and controlled local providers, preserve `NECONYAN_SUPERVISED=1` in the serving-process fixture, await actual process death before cleanup or test-lock ageing, and do not edit served code during a run.

Run browser checks at 1280x900 and touch 393x852 with the Chromium installed under the tests package. The existing Mewmory fixture server and disposable-data safeguards are documented in its test. Lint changed tests using their own configuration; historical unrelated test-folder lint errors are not permission to add new ones.
