# Performance audit: 30 September 2026

This audit targets the default installation, including Bun, without requiring a separate frontend build. The priorities are opening the app quickly, avoiding unused work and reducing the wait between sending a message and seeing the first reply text.

## The biggest problem: the page was restyling itself constantly

With a long chat open, almost every small change to the page, such as the top-bar clock ticking over, the recent-chats rail refreshing or a token counter updating, made Chromium recalculate the styles of roughly 8,000 elements. Each recalculation took about 340 milliseconds on desktop and 410 milliseconds on a phone-sized screen, and they queued back to back. The browser's main thread, which runs every script and click handler, was busy most of the time even when nobody was typing, and sending a message had to wait behind that work.

Three things combined to cause it:

- Several stylesheet rules used `:has()` on `body` to style something elsewhere on the page, for example 'hide `#sheld` while any drawer is open'. Once Chromium has to evaluate a rule like that, any element added or removed anywhere marks the whole document for restyling. Removing only those rules brought each small change down from about 335 to about 20 milliseconds in testing, while every other `:has()` rule stayed in place. One upstream rule anchored on `#chat`, which hides empty reasoning boxes, did the same to every message added to the chat.
- Preset Tools runs a check every second. That check removed a `body` class that was not there, rebuilt its animated-background list and rewrote panel attributes, even when nothing had changed. Each of those writes counts as a change to the page.
- The shell watches `body` for class changes to keep the mode buttons and the edit-card button in sync. It treated those no-op writes as real changes and re-measured the page each time.

## Changes

### Keeping the page responsive

- Replace the `body`-level `:has()` rules with rules anchored on the drawer holder (`#top-settings-holder`) and sibling selectors. The drawer, pinned-panel and Meower rules keep their previous specificity and visual result.
- Show the chrome after the boot skeleton leaves the chat with a `neconyan-home-booting` class on `body`, which the Home screen removes once the skeleton is gone. This replaces a `body:has(#neconyan-home-skeleton)` rule.
- Delete a Calico rule that duplicated the drawer rule, and a phone rule for `data-slide-toggle`, an attribute nothing in the app sets.
- Scope the empty-reasoning rule to each message instead of the whole chat. Empty reasoning boxes still hide normally, still show when hidden reasoning is turned on, and the box being edited stays visible. The one difference: editing one message's reasoning no longer makes every other empty reasoning box in the chat appear.
- Guard against the pattern returning: `tests/css-root-has-selectors.test.js` fails when a shipped stylesheet adds a `:has()` rule anchored on `html`, `body`, `:root`, `#chat` or `#sheld` that styles a different element. Three existing rules are allow-listed because they only apply in narrow cases: Terminal UI mode, the upstream maximised-drawer layout, and screens 360 pixels wide or narrower in Conversation mode.
- Make Preset Tools write only when a value actually changes, and skip rebuilding its source list when the list is the same.
- Make the shell's `body` watchers ignore attribute writes that leave the value unchanged, and check Home visibility without forcing a layout pass.

### Opening the app

- Load the background library when its drawer is first visible or an automatic-background command needs it. Applying the saved background still happens at startup. Concurrent requests share one load, and reopening the drawer reuses the loaded library.
- Include extension manifests in discovery. Older servers and extensions with missing manifests retain the separate-file fallback.
- Restore the saved token-count cache before settings and extensions initialise. Previously, startup counted prompts before loading the saved cache, then replaced those newly calculated entries.
- Minify the shared library on Bun as well as Node. Check the result with a JavaScript parser and fall back to the original valid file if minification produces invalid syntax. The compiled-file cache signature changes so existing installations rebuild it automatically.

### Background work

- Skip unchanged automatic preset snapshots before entering the snapshot store. Batch repeated preset-change notifications into one capture after three quiet seconds. Explicit captures still check stored snapshots and can repair missing files.
- Let settings-confirmation requests retrieve only the current settings file. These requests still read the latest file from disk, but no longer enumerate and return every preset, theme and other catalogue. Normal startup retains the full settings response.

### Time to first token

- Reuse exact counts for unchanged OpenAI message fields within one prompt-building operation. Each operation owns a bounded cache of at most 2,048 entries and 1,048,576 source characters. Modified fields are counted again, failures still fail, and the cache is discarded with the operation.
- Keep token framing, image allowances and tool data unchanged. Provider counters that count a complete serialised prompt retain their existing behaviour because splitting their input could change the result.
- Retain the settings acknowledgement and protected chat save before submitting a reply. The acknowledgement snapshot does not cover every extension setting, so bypassing that save would risk using stale generation settings.

The streaming path already delivers incremental events without response compression or an intentional first-token delay. Streaming text into a message costs about 4 milliseconds of style work per update before and after these changes.

## Measurements

All numbers come from this development machine, which has four CPU cores shared with other work. They show the size of each change, not what a particular phone or computer will see.

### Style work per small page change

A 120-message chat was open. Each figure is the median of seven forced recalculations after one change.

| Change | Before, desktop | After, desktop | Before, phone | After, phone |
| --- | --- | --- | --- | --- |
| Top-bar clock text changes | 339 ms | 16 ms | 411 ms | 23 ms |
| A button is added to the top bar | 336 ms | 16 ms | 410 ms | 25 ms |
| A message is added to the chat | 346 ms | 34 ms | 411 ms | 47 ms |
| Any element is added to the chat | 344 ms | 30 ms | 406 ms | 39 ms |
| Text is appended to the last message | 4 ms | 4 ms | 5 ms | 5 ms |

Desktop is 1280 × 900. Phone is 393 × 852 with touch enabled, in Chromium.

### Send to first visible reply text

A 120-message chat was opened in a fresh browser and one message was sent to a local mock provider that answers immediately, so every second below is Neconyan's own work. 'Before' is the staging commit this branch started from (807a1b1), run side by side with the new code on the same machine, with the same data shape. Each figure is the median of three rounds, alternating which version went first.

| Measure | Before, desktop | After, desktop | Before, phone | After, phone |
| --- | --- | --- | --- | --- |
| Enter to first reply words on screen | 28.3 s | 7.1 s | 32.5 s | 6.2 s |
| Enter to the request reaching the provider | 23.5 s | 6.3 s | 27.5 s | 5.6 s |
| Provider's first words to the screen | 4.9 s | 0.7 s | 5.1 s | 0.5 s |
| Opening the app until it signals ready | 15.0 s | 13.1 s | 17.2 s | 12.5 s |

Ranges for the first row: before desktop 27.7 to 31.8 s, after desktop 6.7 to 7.5 s, before phone 32.2 to 33.6 s, after phone 5.5 to 7.3 s. The absolute times are long because this is a shared four-core server; the before and after runs shared the same conditions.

### Other measurements

The initial fresh-data Bun observation took 20.54 seconds to signal full app readiness on desktop. Its first background-library request alone took 8.17 seconds. More than 1,000 browser requests were recorded. These discovery measurements are not a controlled before/after comparison.

An isolated prompt-budget workload counted 120 growing prefixes of the same long history. Before caching, three runs took 10.13 to 12.70 seconds. With caching, they took 0.19 to 0.37 seconds. Every run produced the identical final count of 84,843 tokens. This measures prompt preparation, not provider response speed.

On Bun, the shared library served to the browser shrank from 4,988,765 to 1,951,066 bytes, and from 1,147,917 to 602,596 bytes after gzip compression.

## Reproducing the checks

The browser regression suite uses an owned disposable server and a local mock provider. It checks desktop at 1280 × 900 and touch-enabled phone layout at 393 × 852. The provider sends the first words and deliberately withholds completion, proving that the browser shows an unfinished reply rather than waiting for the whole response. Its long-history case records send-to-visible-text time, request-preparation time and first-token delivery time separately.

```bash
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 npx playwright test performance-defaults.e2e.js --workers=1 --reporter=line
```

Run that command from the tests directory with Node. Under Bun, the disposable server (which starts with `NECONYAN_SUPERVISED=1`) exits quietly during plugin start-up on both the old and the new code; normal Bun start-up is unaffected. Timing comparisons should run serially, without builds or other CPU-heavy tests alongside them. Provider queueing, internet latency and model prefill are outside the local mock measurement.

The frontend measurement script now waits for the full app-ready event. Its earlier preloader-only check could report readiness while startup work was still running.

## Remaining costs

In the 120-message test, five to six seconds still pass between pressing Enter and the request reaching the provider. The measured contributors are:

- Removing the oldest rendered message when a new one arrives costs 0.35 to 0.5 seconds of style work. Dropping `:has()`, sibling-combinator, position (`:nth-child` and similar), attribute, `.mes`, `#chat` and `:not()` rules in turn did not remove it, so no single stylesheet rule is responsible. The chat's scroll-position capture and restore make the browser do that work twice per send.
- Before submitting, the browser waits for message statistics, saves the chat twice (about 130 KB each for this chat) and saves settings (about 170 KB). The saves protect replies that finish after the tab closes, so they were kept.
- The Prompting Lab reloads its saved cases several times during a send.
- Agents' tracker button, the stop button and character colour detection each read computed styles in response to message events, which forces a style pass each time.
- After a reply, the server re-reads and parses its job list on every check. Each job keeps its full request for crash recovery (about 92 KB each here), so this parsing grows with job history.

The three allow-listed `:has()` rules still trigger whole-page restyling while they apply: in Terminal UI mode, while an upstream drawer is maximised, and in Conversation mode on screens 360 pixels wide or narrower.

The default frontend still loads a large graph of small JavaScript modules, and Quick Image Gen contributes a substantial script and settings interface. Bundling or deferring that graph needs a separate compatibility pass: extensions import shared live modules and register automatic behaviour during startup. Deferring them indiscriminately would change what happens on the first message.

The first background-library opening still generates missing image metadata. It no longer delays opening the app, but a large uncached collection can make its first opening slow.

Phone verification uses Chromium. It does not establish native Safari performance.
