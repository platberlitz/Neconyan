# Performance audit: 25 October 2026

I checked startup, navigation, chat rendering and scrolling, reply preparation, streaming, settings saves, background sync and large chat libraries. The comparison starts at `c54129ce`. I wanted to remove repeated work without compromising saved replies, cross-device settings or update detection.

## Changes

### Settings saves and reply preparation

The browser was serialising the complete settings payload, parsing it again, then taking a small snapshot of the controls used for generation. The snapshot now comes directly from the submitted payload. It still makes its own JSON-safe copy before the first asynchronous operation, so later edits cannot change the acknowledgement.

The server also repeatedly serialised and hashed the same settings object during protected reply preparation. A bounded cache now checks that object's values and structure before reusing its hash. Mutations force a fresh hash. Accessors, proxies and unsupported object shapes use the original path. Reading a replaced settings file produces a new object, so a cache entry cannot hide an external edit.

These changes retain the settings acknowledgement, chat saves and concurrency checks before generation. They reduce local preparation work; they do not reduce provider queueing or model response time.

### Dialogue colouring and background sync

A streamed token arrives before the host updates the message text. Dialogue colouring previously painted the old text at that event, then painted the new text when its observer saw the update. Repeated token events now check the target without repainting it; the observer colours the actual text update. Initial targets and replaced targets still receive a first paint.

Settings requests can now carry an opaque token for the requested extension blocks. If their content has not changed, the server returns a small acknowledgement instead of copying and sending the blocks again. Requests without this optional token retain the old response shape. Tokens are tied to the account and exact content, including whether a block is missing. Replacing the file, editing it outside the app or restarting the server causes the appropriate full read.

Dialogue colouring uses these conditional reads on its existing polling schedule. Local saves and deferred remote updates must complete their normal reconciliation before the client adopts a token.

### Phone navigation

Inspecting or closing an already-closed phone menu used to rebuild its quick actions and rewrite attributes. That caused unnecessary style and layout work, including document-wide invalidation from existing selectors. Inspection now reuses the actions, opening refreshes them, and closing writes only changed state. The closed workspace rail similarly repairs stale accessibility state without rewriting already-correct attributes.

This removes a measured source of redundant work. It does not establish that every panel opens faster: panel timings are dominated by other style recalculations and varied substantially on the shared test machine.

### Recent chats and version checks

Recent-chat sorting now resolves pinned membership once per file rather than searching pins inside every sort comparison. The order, group handling, duplicate-name handling and result limit are covered by regression checks. The filesystem inventory still checks every relevant file so edits made outside the app remain visible.

Repeated version checks now reuse Git results while the checkout metadata is unchanged. Changes to the branch, revision, upstream, package version or relevant Git storage invalidate the result. Concurrent cold requests share a load; failed or superseded loads cannot become a stale cached result. Configurations whose dependencies cannot be safely tracked use fresh Git reads.

## Measurement corrections

The frontend measurement script previously attempted to retrieve long tasks through `performance.getEntriesByType('longtask')`. That interface does not return long tasks, so its zero counts were misleading. The script now installs a `PerformanceObserver` before navigation, drains queued entries and reports unsupported measurements explicitly. A real Chromium page task that blocked for 120 ms was detected as one 120 ms long task.

Synthetic chat work also ran behind the Home screen, making the chat unscrollable. The script now reveals the chat, waits for its finite entry animations and settled geometry, and declines to measure a hidden chat. Navigation long tasks and subsequent synthetic-work long tasks are reported separately. Unsupported or unavailable measurements cannot satisfy a budget by appearing to be zero.

Initial comparisons were discarded after a preview helper left an old server bound to the measurement port. Final runs use a fresh copy of the same synthetic data, verify the serving process's checkout and stop the owned process group afterwards. Browser runs and large test suites run sequentially.

## Isolated measurements

These are component measurements on a shared ARM Linux server using Node 24, not promises about end-to-end response time on a particular device. Timing ranges vary with other work; operation counts and output equality provide the stronger evidence.

| Workload | Before | After | Scope |
| --- | --- | --- | --- |
| Submitted-settings snapshot, 3.95 MB synthetic payload | 3.27 ms | 0.005 ms | Median of 40 alternating calls; identical snapshot |
| Repeated settings hash, 6.73 MiB synthetic settings | 64-68 ms | 4.9-5.4 ms | Warm reuse; mutations still recompute |
| Pinned selection, 21,000 chat records and 9 pins | 68.7 ms | 6.5 ms | Sorting and selection only; identical results |
| Pinned selection, 21,000 chat records and 24 pins | 307.7 ms | 14.2 ms | Sorting and selection only; identical results |
| Repeated version lookup, linked checkout | 4 Git processes per call | 0 after the first load | Independently counted across 20 warm calls |
| Duplicate colouring work, 10 token events and 10 text writes | 20 attribution passes | 11 | Regression fixture, including initial paint |
| Unchanged colour settings, synthetic 858,373-byte response | 858,373 bytes | 223 bytes | Conditional endpoint response; polling cadence unchanged |
| Already-closed phone menu, 100 consecutive closes | 38.8-119.9 ms | 3.0-27.4 ms | Instrumented Chromium path-level samples |

The settings-hash cache adds work to the first call: the synthetic cold call took 72-78 ms including its mutation guard. Its benefit is repeated checks of a shared parsed settings object, not every settings read.

## Whole-page comparison

The final comparison used Chromium on Linux, three fresh browser contexts per profile, each with a cold navigation and warm reload. Both revisions used the corrected measurement script and identical disposable data, with copied crash reports and stale process markers removed from both fixtures. The phone viewport was 393x852 with touch; desktop was 1280x900. Sources were served without a frontend build and service workers were blocked. These are emulated browser results, not physical-phone measurements.

| App ready, median | Before | After |
| --- | --- | --- |
| Phone, cold | 11.18 s | 9.70 s |
| Phone, warm | 7.94 s | 8.51 s |
| Desktop, cold | 10.79 s | 10.29 s |
| Desktop, warm | 8.28 s | 8.59 s |

The results are mixed, so they do not support a general startup-speed claim. Rendering 24 of 96 synthetic messages took 542-636 ms before and 549-637 ms after on the phone, and 487-510 ms before and 519-532 ms after on desktop, using the cold/warm medians. Scrolling remained about 45-49 frames per second on the phone and 60 on desktop. The deterministic repeated-work reductions above are the established gains; overall rendering and scrolling did not materially improve in this fixture.

Across 15 panel open/close cycles, phone style-recalculation CPU time was 22.20 s before and 21.22 s after; desktop was 9.36 s before and 9.50 s after. This remains the dominant panel cost. The five-second idle samples made no API requests and neither revision reported a page error. Before/after screenshots preserve the same chat and composer layout.

## Remaining costs and rejected changes

- **Large-library inventory:** a 21,000-file recent-chat request still spent most of its time checking the filesystem, with about 21,000 metadata checks. Directory modification time alone would miss an edit to an existing chat. This audit does not introduce an index that could hide those edits.
- **Assistant catalogue:** batches of eight reads did not produce a reliable gain across five fresh-process runs over 500 synthetic cards. The underlying card reader performs synchronous reads, so wrapping calls in concurrent promises did not overlap the disk work. The experimental change was discarded.
- **Style recalculation:** repeated panel opens still spend most of their browser CPU time recalculating styles. The phone-menu change removes one proven trigger; broad selector rewrites need separate visual and layout evidence.
- **Startup:** the module graph, extension initialisation and style work remain substantial. A faster cached version check is not evidence of a faster complete startup.
- **Message observers:** some message content can contain extension-provided controls. Skipping accessibility or keyboard registration across all message subtrees would risk breaking those controls, so that proposed shortcut was rejected.
- **Polling cadence:** a proposed foreground backoff would have delayed cross-device updates. Conditional responses replace that approach.

## Verification

- Full unit run: 576 suites passed, with 7,963 passing tests and three existing skips. The final client token-timeout correction also passed its nine focused tests.
- Full server run: 3,131 tests passed, with no failures or skips, including the Mewmory checks.
- Browser checks: 25 passed with one worker. These cover desktop and phone performance controls, six phone-shell interactions, browser-stream and server-preview dialogue colouring, failed-read recovery, stopping Agents after a completed reply, and returning while a chat save is pending.
- Root and test lint passed. Test lint reported 910 warnings and no errors. Frontend budgets and the frontend build passed; Bun initialisation passed too.
- Independent reviews covered cache invalidation, concurrent loads, external settings edits, deferred saves, streaming event order and phone-menu accessibility. Findings were corrected and checked before publication.

Browser checks used Chromium at 393 × 852 with touch and 1280 × 900 on Linux. The iOS-specific checks use emulation; they are not physical-iPhone verification. The build retained its unminified fallback for the unchanged Dialogue Colours `st-api.js` file.

## Reproducing focused checks

Use Node 24. Run large unit, Node and browser suites separately.

```bash
npm run test:unit --prefix tests -- --runTestsByPath \
  measure-frontend-performance.test.js \
  openai-custom-endpoint-credentials.test.js \
  roleplay-settings-hash.test.js \
  chat-library-inventory-selection.test.js \
  version-cache.test.js version-cache-git-loads.test.js \
  neconyan-mobile-nav-idle-close.test.js \
  character-colors-streaming-paint.test.js \
  character-colors-auto-sync-poll.test.js --maxWorkers=2

node --test tests/settings-extension-cache.node.js tests/settings-lightweight.node.js

NECONYAN_PERF_URL=http://127.0.0.1:PORT npm run perf:frontend
```

The browser measurement target must be an owned disposable preview. Use separate identical data copies for before and after, verify which checkout serves each port, and keep tracing separate from timing runs. Tracing can substantially increase the time it observes.
