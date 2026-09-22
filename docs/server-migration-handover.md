# Full server migration: continuation

## Status and authority

This is an explicitly requested checkpoint of unfinished work. Production has not been changed. Continue the migration through planning, implementation, independent review, fixes and verification. Verified local commits are authorised. Deployment is not authorised during this migration.

Use the configured planner, implement in the main agent, then obtain an independent review using exactly pura-openai/gpt-6-astra with variant max. The owner authorised that same Pura/max selection for planning after the previous provider failed; fresh planner and reviewer execution were verified after the owner restarted OpenCode. Verify actual assistant-message provider, model and variant metadata; an agent name or saved configuration is insufficient. If that selection cannot be verified, stop and report the blocker. No further provider substitution or autonomous process/session restart is authorised. Fix real findings, verify and make one local commit for each coherent stage.

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
- Manual regeneration, polishing, schedules and selfie text preparation use the shared bound-request route. A failed named profile cannot fall back to active settings. Captured source hashes, branch identity and speaker eligibility are checked before dispatch; those completion writes and image coordination still belong to the browser. Memory refresh now submits a native summary job; handwritten memory and clearing use a native version-checked write. Native summary/schedule jobs accept acknowledged active bindings and retain exact retry identity.
- The older Conversation send API retains user messages on provider failure, preserves an old reply during failed regeneration and merges completed replies without overwriting unrelated threads. External callers must retry a failed generation using the returned version and `reuseLastUser: true`; repeating the original message ID is rejected as a duplicate.
- Reminder clock parsing now treats a value such as '21:30' as a local clock time rather than 21 minutes; timezone, daylight-saving and spelled-out duration units have checks.

## Current continuation: Roleplay storage preparation

The first Roleplay preparation stage adds a trusted native read-modify-write operation through the existing chat lock, save, backup, exact recovery and branch-memory paths. It requires the captured raw-file hash even when legacy integrity checks are disabled, refuses unsafe or corrupt sources before mutation, validates synchronous JSON-only changes and returns authoritative records with their saved integrity value. No-op writes retain original bytes and file identity; native metadata changes are not discarded by legacy display-equivalence comparisons.

Errors distinguish a committed chat with failed follow-up cleanup or memory capture from an uncertain write. Callers must reconcile uncertain saved/recovered content before repeating a mutation or associated external work. Lock cleanup cannot replace an earlier error or erase its outcome. This is storage preparation only: there is no Roleplay job handler, acceptance endpoint, protected receipt schema or browser generation cutover yet.

Next is protected Roleplay instance identity, full-intent acceptance records and repeat-safe completion mutations across ordinary saves, forced saves, branches, imports, restores, renames and deletion. The ordered continuation stages are recorded in the phase checklist. Full prompt construction, progressive group turns, tools and extension processing must run without further browser-prepared requests; the earlier single-request-only proposal was rejected, not accepted as a reduced scope.

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
- g. Done for native delivery. Incoming messages save unread and pending presentation records with their completion receipts. Atomic claims select one presenting tab; observed read boundaries cannot clear newer unseen messages. Visible-page discovery retries claims and read acknowledgements independently of job completion or repainting. OpenAI, OpenAI Compatible, ElevenLabs and Pollinations narration uses saved audio; Kokoro remains page-open-only. Server-side narration refuses System, unsupported providers and multi-voice configurations explicitly; Kokoro retains its browser behaviour. Image captions use the same narration path.
- h. Done. Loading the app for an account with existing Conversation usage, or starting Conversation usage, persists server ownership, timezone and the revision of settings actually saved for background use. Visiting the Conversation panel is not required for existing users. Later successful general saves acknowledge the new revision atomically. The browser periodic sender, automatic timers, memory-summary timer and chime observation fence are removed. The 20-second browser poll only discovers saved work and presents it. Roleplay rendered-message sampling still submits native asides.
- Ownership and accepted occurrences survive stale saves and settings replacement. Server memory is protected on surviving threads and branches; removing those threads also removes their memory. Legacy message identities and unread boundaries migrate without dropping empty history or invalidating an exact identity-only repair. Exact copies of saved automatic messages can start branches or group histories; newly generated stale-browser automatic messages cannot be appended. Staging-era bound automatic and memory requests are refused before provider dispatch. Generic provider calls from pre-migration pages cannot be attributed to Conversation, but their automatic completion writes are rejected or restored to authoritative state.
- Reminder identity survives old retry-window keys, branch changes and job pruning. Startup preserves old ownership before plugins, listeners or runners can prune its evidence; a failed migration holds pruning for that account. Acceptance markers are never evicted to make room: the existing store-size limit fails closed. Failed/interrupted work needs explicit retry; cancellation does not create a replacement occurrence. An autonomous preparation failure can be retried through its original saved job.
- Automatic summaries recheck enabled state, include attachment-only messages and retain both scanned and frozen history identities before dispatch. Manual refresh, overwrite and clear are native; clear advances coverage so the same history is not immediately summarised again. A pending result cannot overwrite later memory changes. Unfinished legacy summaries without a memory fingerprint are interrupted before a provider request and require a new explicit refresh.

1. Done. Named text-completion/instruct requests and acknowledged saved-active bindings are implemented. Composer validation precedes uploads and acceptance; the manual helper has no error-driven fallback. An uncertain accepted submission retains its exact body and key through a rate-limited retry and later settings changes.
2. Participant selection, group concurrency, availability/autoresponder delays, assistant context and image delivery have native implementations. Images use the account's own Quick Image Gen provider only; unsupported providers are refused without substitution. Explicit reply targets override mention-weighted selection. Send-triggered solo partner chimes run through durable jobs and have saved occurrence ownership. Participant preparation retains the accepted binding through the batching window; legacy unfinished records without that evidence cannot reconstruct it from current settings.
3. Done. The composer submission and the already-appended-message reply event now submit to durable acceptance (`POST /reply/submit`). Attachment-only sends, blank forced replies, server-side coalescing, explicit reply targets and message-revision checks are preserved; the composer appends no messages and clears the draft only after acceptance and the required user-message writes are durable.
4. Done. The browser observes accepted native jobs (`public/scripts/neconyan-conversation/native-jobs.js`) and merges authoritative results by reading the saved store; observation never executes delivery. A separate version-checked Conversation save path (`public/scripts/neconyan-conversation/store-sync.js`, `store-sync-utils.js`) keeps browser edits honest, and the settings guard protects server-owned messages, records and bookkeeping from old whole-store writes while allowing intentional edits and deletions.
5. Reminders, weekly and legacy schedules, idle and proactive messages, chimes, character chat and memory summaries run on the server worker, with deterministic occurrence keys, one-time bookkeeping claims and a per-account saved timezone (`POST /automation/configure`). Native schedule-generation jobs also exist; the manual schedule control still needs completion-write migration. The Roleplay/group-aside bridge is native: `POST /aside/submit` accepts a saved source locator and revisions, builds the directive server-side, delays 900 ms for a mention or 2000 ms otherwise through the durable job delay, records the group-aside cooldown by persona, source group and recipient, and re-asserts the saved source through generation, narration, receipt reuse, command writes and image delivery.

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

Latest Roleplay storage preparation: all 335 Jest suites passed, with 4,413 tests passed and two skipped (4,415 total), plus one snapshot. All 294 Node tests passed, including 27 new native-mutation checks. Root lint, frontend budgets and whitespace checks passed. Lint of the four changed test files had zero errors and 14 warnings; no full tests-folder lint claim is made.

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
                     tests/chat-recovery-endpoints.test.js, tests/neconyan-roleplay-storage.e2e.js

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
NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 node tests/node_modules/@playwright/test/cli.js test --config tests/playwright.config.js neconyan-conversation-durable.e2e.js neconyan-roleplay-storage.e2e.js --browser=chromium --workers=1 --reporter=line --trace=retain-on-failure
```

Run browser checks at 1280x900 and touch 393x852 with the Chromium installed under the tests package. The existing Mewmory fixture server and disposable-data safeguards are documented in its test. Lint changed tests using their own configuration; historical unrelated test-folder lint errors are not permission to add new ones.
