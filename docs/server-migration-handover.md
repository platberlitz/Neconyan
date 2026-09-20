# Full server migration: continuation

## Status and authority

This is an explicitly requested checkpoint of unfinished work. Production has not been changed. Continue the migration through planning, implementation, independent review, fixes and verification. Verified local commits are authorised. Deployment is not authorised during this migration.

The owner authorises the configured GPT implementer and planner, with the planner acting independently in review-only mode when the review agent uses an unavailable provider. Do not restart the session or switch providers to bypass that constraint. Complete this sequence for each coherent change.

The goal is server ownership of accepted workflows, authoritative state, scheduling, cancellation, recovery and completion writes. Server provider calls alone are insufficient. WebLLM and bundled browser Kokoro are the only approved browser-only exceptions so far. Their controls say to keep the page open. Do not silently replace those providers.

Read the repository instructions, product and design documents, the phase checklist and the ownership audit before changing code. Preserve this checkpoint; do not restart the audit or create another competing job system.

## Implemented and checked

- Saved per-account jobs, bounded acceptance and storage, fair dispatch, cancellation, private provider-result files, explicit retry and recovery of known results. Unknown provider outcomes require explicit retry. Damaged ledgers fail closed for that account, preserving completion records.
- Mewmory automatic extraction and backfill have a saved server worker. Manual recall and full index rebuild use saved jobs. Indexing retains valid vectors when a message arrives during a batch. Native deletion and source checks remain in place.
- Modern and legacy macros share browser/server code with per-operation state. A 22-case historical browser fixture set verifies variables, selection/random helpers, basic transforms, conditions and legacy substitutions. It does not cover every time, chat, character-card or persona macro. Node resolves the existing dependencies through a package import; the browser uses an import map. Runtime minimums were not raised.
- Chat-profile controls, preset conversion, provider parameters and Conversation prompt/reply composition share pure functions. Named chat profiles without a preset retain their existing raw-request behaviour. Saved bindings contain references and fingerprints, not resolved credentials.
- The accepted Conversation reply API captures an existing saved branch, named chat or text-completion profiles, persona notes, group-memory and schedule context. Eligible participants' connection references are recorded before input acceptance; later mentions still select speakers, while a changed connection selection starts a separate batch. Provider results are retained separately from native delivery. Bubbles, reminders and status effects are saved together with records preventing duplicate application. Completed replies can finish delivery after the saved profile is removed.
- Named text requests reuse the browser's provider parameters and scoped instruct formatting for all 15 text providers. Saved template substitutions, stopping strings, token bans/bias, service tiers and credential references stay request-scoped. Unavailable or substituted tokenisers are refused. Prepared random values and completed results are reused during recovery.
- Saved-active requests use the actual acknowledged controls, URL, model and credential references, independently of the selected named profile. Acknowledgement comes from the exact serialised successful settings save and refuses newer unsaved edits. Validation runs before composer uploads and acceptance, using the same raw formatting, macro order and stopping-string passes as execution. Unsupported browser capabilities and dynamic output transformations are refused rather than silently omitted.
- Manual regeneration, polishing, summaries, schedules and selfie text preparation use the shared bound-request route. A failed named profile cannot fall back to active settings. Captured source hashes, branch identity and speaker eligibility are checked before dispatch; existing browser completion guards remain. These manual completion writes and image coordination still belong to the browser. Native summary/schedule jobs also accept acknowledged active bindings and retain exact retry identity.
- The older Conversation send API retains user messages on provider failure, preserves an old reply during failed regeneration and merges completed replies without overwriting unrelated threads. External callers must retry a failed generation using the returned version and `reuseLastUser: true`; repeating the original message ID is rejected as a duplicate.
- Reminder clock parsing now treats a value such as '21:30' as a local clock time rather than 21 minutes; timezone, daylight-saving and spelled-out duration units have checks.

## Immediate continuation: connect the real Conversation workflow

The main Conversation composer, the forced-reply action and the branch-from-message reply now submit to the accepted-reply API. These entry points observe accepted jobs and read the server's saved messages. Their browser checks are recorded below; this does not establish complete Conversation migration.

Continue in order: resolve f/g while handing automatic ownership to the server, then migrate Roleplay generation and completion writes.

The integrity checkpoint resolves findings a-e:

- a. The downloaded Conversation baseline and its exact version are captured before migration; unrelated general saves cannot advance that pair.
- b. Server-derived history fingerprints and edit counters distinguish legitimate 250-message retention from destructive changes. New work stamps legacy history before capture; unprovable older captures remain refused. Snapshot restoration, folder/ZIP settings imports and settings reset preserve increasing versions and invalidate changed history.
- c. Acceptance saves branch creation identity, and batch repair validates each member's own anchors and partial progress. Replacement branches cannot inherit old work.
- d. Member retry keys compare complete canonical intent. Historical members whose full intent was never recorded refuse ambiguous replay rather than guessing from the leader.
- e. Identifier-less messages merge by content and occurrence count. Ambiguous concurrent additions, deletions and replacements preserve local data and refuse saving. A lost successful new-branch save can recover without treating server metadata as a content conflict.

Outstanding:

- f. Done. Native solo replies now have send-triggered partner chimes through the durable jobs. A server-side occurrence claim makes exactly one root own an occurrence, and the browser chime path stands down while a native job is in flight, awaiting or syncing, so a paid generation cannot be duplicated.
- g. Native observation still lacks unread alerts and automatic narration.

1. Done. Named text-completion/instruct requests and acknowledged saved-active bindings are implemented. Composer validation precedes uploads and acceptance; the manual helper has no error-driven fallback. An uncertain accepted submission retains its exact body and key through a rate-limited retry and later settings changes.
2. Participant selection, group concurrency, availability/autoresponder delays, assistant context and image delivery have native implementations. Images use the account's own Quick Image Gen provider only; unsupported providers are refused without substitution. Explicit reply targets override mention-weighted selection. Send-triggered solo partner chimes now run through the durable jobs, owned by one root and fenced while the browser observes a native reply. Participant preparation retains the accepted binding through the batching window; legacy unfinished records without that evidence cannot reconstruct it from current settings.
3. Done. The composer submission and the already-appended-message reply event now submit to durable acceptance (`POST /reply/submit`). Attachment-only sends, blank forced replies, server-side coalescing, explicit reply targets and message-revision checks are preserved; the composer appends no messages and clears the draft only after acceptance and the required user-message writes are durable.
4. Done. The browser observes accepted native jobs (`public/scripts/neconyan-conversation/native-jobs.js`) and merges authoritative results by reading the saved store; observation never executes delivery. A separate version-checked Conversation save path (`public/scripts/neconyan-conversation/store-sync.js`, `store-sync-utils.js`) keeps browser edits honest, and the settings guard protects server-owned messages, records and bookkeeping from old whole-store writes while allowing intentional edits and deletions.
5. Reminders, weekly and legacy schedules, idle and proactive messages, chimes, character chat, memory summaries and schedule generation now run on the server worker, with deterministic occurrence keys, one-time bookkeeping claims and a per-account saved timezone (`POST /automation/configure`). The Roleplay/group-aside bridge is now native: `POST /aside/submit` accepts a saved source locator and revisions, builds the directive server-side, delays 900 ms for a mention or 2000 ms otherwise through the durable job delay, records the group-aside cooldown by persona, source group and recipient, and re-asserts the saved source through generation and image delivery. The send-triggered solo partner chime now runs natively, and the browser's chime path stands down while a native job is observed. Remaining: stopping the browser's own 30-second worker once native ownership is enabled.

Use the shared reply-delivery function with a native host. Preserve first-bubble command timing, partial output, reply references, image requests and per-effect completion records. Never hold a filesystem lock while awaiting a provider.

## Remaining whole-application scope

- Roleplay generation and server chat completion writes, groups, tools, continuation, regeneration and swipes.
- Agents before/after processing, companions, trackers, history and related lorebook actions.
- Story Mode, Guided Generations and Deep Swipe progression and recovery.
- Quick Image Gen and server-capable attachment, caption, sprite, audio and image workflows.
- Meower feed/profile/interaction waves using its existing revisioned native store.
- Prompting Lab, Distiller, LoreStitch and World Info Lab, retaining proposals and explicit review before applying changes.
- Remaining translation, vector, automation, archive, import, backup and maintenance workflows. Preserve existing data formats and per-file recovery where operations span multiple files.

Do not treat arbitrary DOM-dependent user scripts as portable server code. Identify incompatible dependencies before accepting their work. Do not add hidden browsers or fake DOMs to claim server ownership.

## Verification and release gates

Latest active-binding checkpoint: 334 unit suites passed, 4,335 tests passed and two skipped; all 230 Node tests passed. Root lint, frontend budgets and whitespace checks passed. The full tests-folder lint run still reports historical errors in untouched files. These are checkpoint results, not proof that unfinished callers have migrated.

The chime checkpoint ran the full disposable Conversation suite: all 116 cases passed in one serial Chromium run (57.8 minutes). The 12 added chime cases cover desktop and touch Send/Enter with a zero-page completion and an offline partner, a two-profile duplicate race, five exclusion cases (offline or autoresponder primary, an explicit reply target, an already-answered mention and an unmentioned partner), an image-only chime with a real process restart and a 65-second server rescan, and a refused chime-only occurrence that skips the whole family and retries later. A first run of the same suite passed 115 of 116; the single failure was an unrelated pre-existing flake ('legacy repeated messages survive concurrent native additions and unrelated local edits'), which is untouched by this change, passes 5 of 5 in isolation, and passed in the second full run. The close-the-page chime cases cannot observe the browser-worker duplicate race, which is pinned by unit checks on the observation fence instead.

Earlier active-binding checkpoint: The complete browser run passed all 95 then-current durable Conversation cases and both scoped-formatting cases. Two acknowledgement tests exposed a fixture race: a queued later save genuinely acknowledged the edited controls. Holding that later save before forwarding fixed the test; both acknowledgement cases then passed. Nine added durable cases also passed in focused runs, bringing coverage to 104 durable cases plus four formatting/acknowledgement cases. This was not a single green 108-case run. Active Chat and Text controls were exercised at 1280x900 and touch 393x852, including zero-page completion. Additional checks cover rejection before uploads, exact retry after a lost response and 429, changed character scripts, manual source/speaker changes during preparation, stored inline images and hashing without native Web Crypto.

The following named-text and integrity results describe earlier checkpoints.

Eight new named-text Chromium cases passed for real Send, Enter, 'Ask for reply' and 'Branch from here' at both required sizes, including zero-page completion and reopening. Two group cases passed for later mention selection and changed-binding batch separation. The suite now contains 62 cases; this checkpoint reran those ten cases, not the entire expanded suite. Two separate browser parity cases previously verified the shared formatting and provider helpers.

The disposable Conversation Chromium suite has 52 cases: 51 passed in the complete run; the lost-new-branch-response test passed after correcting its interception to drop a successful save rather than an initial version conflict. Real Send, Enter, 'Ask for reply' and 'Branch from here' were exercised at 1280x900 and touch 393x852. Checks cover zero-page bubbles/reminders/status/images, reopening without repeat calls, retained drafts, lost acceptance retry, cancellation during preparation/generation/delivery, source and target conflicts, stale unrelated saves and two-account isolation. Three restart boundaries kill the actual serving process with SIGKILL, then restart with the same disposable data. Added cases cover multi-bubble retention at 249/250 messages, restart during capped delivery, startup migration racing native completion, same-key branch replacement, legacy merging and all four settings-replacement paths. Unknown text-provider outcomes remain interrupted.

Browser reproduction and independent review fixed a broken account-getter import, a decorative cat intercepting the message menu, cross-account submission/upload/preliminary-chat-write gaps, startup ownership binding, queued-save ownership and observer refresh coalescing. Review also corrected the test's original supervisor-only kill and added collection-time opt-in skipping. A deterministic thumbnail cache regression now covers different bytes with identical file size and modification time; cached responses identify their actual contents.

Limits: Safari is unverified; cancellation uses the real HTTP endpoint because no Conversation Stop control is wired. Lost-response retry identity is page-memory-only. Completed-image reopening does not prove recovery during an unresolved image request. Manual Conversation completion writes, unread alerts, narration and automatic ownership (including removal of the browser 30-second worker and its chime fence) remain unfinished. Active Text structured JSON/reasoning-budget requests and unavailable browser macros are refused; supported static output transformations retain their captured permissions and character-script hash.

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

Focused checks: tests/neconyan-conversation-api.test.js
               tests/generation-profiles.node.js
               tests/conversation-*.node.js
               tests/jobs*.{test,node}.js
                tests/mewmory.e2e.js
                tests/neconyan-conversation-durable.e2e.js
               tests/macros.node.js, tests/macro-parity-browser.mjs
```

```bash
npm run test:unit --prefix tests -- --runInBand --silent
node --test tests/*.node.js
npm run lint
npm run check:frontend-budgets
git diff --check
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 node tests/node_modules/@playwright/test/cli.js test --config tests/playwright.config.js neconyan-conversation-durable.e2e.js --browser=chromium --workers=1 --reporter=line --trace=retain-on-failure
```

Run browser checks at 1280x900 and touch 393x852 with the Chromium installed under the tests package. The existing Mewmory fixture server and disposable-data safeguards are documented in its test. Lint changed tests using their own configuration; historical unrelated test-folder lint errors are not permission to add new ones.
