# Frontend redraw audit

I traced repeated events, timers and page observers through the main chat modes,
shared controls, libraries and bundled extensions. Several already combined updates
or checked whether anything changed. The remaining fixes below stop rebuilding or
rewriting the same page elements, while keeping actual changes immediate.

## Changes

| Area | Repeated work | Fix |
| --- | --- | --- |
| Top bar | Several events queued the same label update and rewrote unchanged labels. | One queued update per frame, with comparisons before text and attribute writes. |
| Model picker | Search terms with identical results detached and reattached every matching row. | Retain rows when their option identities, order and group labels match. Native option changes still invalidate the rows. |
| Lorebooks | Selection and editor events rebuilt the hidden library and unchanged folder lists. | Defer library work while editing a book; compare names, folders, assignments, search and language before rebuilding. |
| Recent chats | Equal responses rebuilt all six sidebar buttons. | Compare the complete visible payload, including navigation fields and language, before replacing buttons. |
| Conversation | Streaming recreated live bubbles, animated dots and the image Stop button. History refreshes recreated the newer-message controls. | Update retained live bubbles and controls in place; remove them when their state ends or the reader opens older history. |
| Message counts | Equal counts rewrote text, titles and accessibility attributes. | Write only changed values. |
| Mewmory | Every notification rebuilt the panel, including hidden tabs and closed drawers. | Combine notification bursts into one frame, skip hidden panels and refresh on activation. Direct actions still render immediately. |
| Termeownal | Conversation events queued duplicate refreshes, reattached the same observer and rewrote status details. | Combine pending refreshes, retain the observer for its current timeline, clear queued work on teardown and compare displayed values. |
| Story Mode | Repeated message scans rewrote origin/join attributes and reasoning-editor labels. | Compare those values before writing. |
| Guided Generations | The periodic guide check rewrote unchanged button labels, counts and accessibility attributes. | Compare values before writing. |

## Existing guards checked

- Conversation already combines interface, timeline and Pals refreshes, retains saved
  messages by their fingerprints and skips identical timeline state.
- Meower compares refreshed feed and settings data, retaining the previous objects when
  equal because button handlers refer to them. Its polling is gated by visibility.
- Agents defers list rendering until the list is shown. Its direct action paths can
  depend on immediate rendering, so they keep that behaviour.
- Dialogue Colours collects affected messages and ignores its own decoration changes;
  its streaming observer checks its current target and saved settings are compared.
- Quick Image Gen combines touched-message updates. Deep Swipe limits its observer to
  added messages and edit-state changes.
- Preset Tools checks missing panels, changed prompt-list references and relevant
  background changes before scheduling work.
- Message sleepers already combine placement requests and filter streaming mutations.
- Core message-action observation checks actual label changes. Screenshot observation
  is temporary, and the options-menu observer acts only on the open menu.
- Welcome-screen startup observation disconnects after initialisation; recent-chat
  requests already share in-flight work.

## Regression checks

`tests/frontend-redraws.e2e.js` runs the real update functions in Chromium with small,
controlled inputs at 1280x900 and touch-enabled 393x852. It counts actual DOM mutations
(changes to page elements), checks retained node identity and focus, then changes the
inputs to check that updates still appear. Repeated unchanged calls must produce zero
mutations in the observed controls. Fifty live reply updates must retain the bubble
and focused Stop button. It also checks model-option invalidation, lorebook changes
made while the library is hidden, recent-chat navigation and history editing locks.

`tests/frontend-redraw-workspaces.e2e.js` checks the full application's Mewmory tab and
drawer lifecycle, plus Conversation's saved and live messages, at the same sizes.
The Mewmory check requires twenty notifications to produce one visible rebuild and
zero hidden rebuilds, followed by a fresh render when reopened.

### Verified results

- All 20 new Chromium checks passed across desktop and touch-enabled phone sizes.
  The live-bubble checks also verify asynchronous portrait decoding.
- The full Jest run passed 626 of 628 suites. Two source-extraction fixtures needed
  updating for the shared top-bar scheduler and live-bubble markup; both then passed
  all 47 tests in a focused rerun. Combined coverage is 9,234 passing tests with three
  existing skips.
- Root lint, frontend asset limits and the production frontend build passed. Changed
  test files pass lint. Full test-folder lint still reports five existing quote errors
  in the unchanged `tests/neconyan-bottom-bar-buttons.test.js`.

These checks measure unnecessary page changes, not an end-to-end speed percentage.
The audit does not establish that every possible third-party extension or interaction
is free of repeated rendering. No physical-phone performance claim is made.
