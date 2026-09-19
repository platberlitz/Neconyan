# Full server migration: continuation

## Status and authority

This commit is an explicitly requested checkpoint of unfinished work. Production has not been changed. Continue the migration, then complete independent Fable review, fix real findings, run the release checks, commit the completed work locally and deploy it with a rollback backup. Do not deploy this checkpoint as a completed migration.

The owner originally requested DeepSeek V4.1 Flash for implementation and Fable for review. After repeated unfinished runs, the owner explicitly authorised the current GPT implementer to finish implementation and review fixes. Retain Fable for independent review. The owner also asked to stop repeatedly reviewing unfinished fragments and to proceed normally; reserve the next review for a coherent completed change.

The goal is server ownership of accepted workflows, authoritative state, scheduling, cancellation, recovery and completion writes. Server provider calls alone are insufficient. WebLLM and bundled browser Kokoro are the only approved browser-only exceptions so far. Their controls say to keep the page open. Do not silently replace those providers.

Read the repository instructions, product and design documents, the phase checklist and the ownership audit before changing code. Preserve this checkpoint; do not restart the audit or create another competing job system.

## Implemented and checked

- Saved per-account jobs, bounded acceptance and storage, fair dispatch, cancellation, private provider-result files, explicit retry and recovery of known results. Unknown provider outcomes require explicit retry. Damaged ledgers fail closed for that account, preserving completion records.
- Mewmory automatic extraction and backfill have a saved server worker. Manual recall and full index rebuild use saved jobs. Indexing retains valid vectors when a message arrives during a batch. Native deletion and source checks remain in place.
- Modern and legacy macros share browser/server code with per-operation state. A 22-case historical browser fixture set verifies variables, selection/random helpers, basic transforms, conditions and legacy substitutions. It does not cover every time, chat, character-card or persona macro. Node resolves the existing dependencies through a package import; the browser uses an import map. Runtime minimums were not raised.
- Chat-profile controls, preset conversion, provider parameters and Conversation prompt/reply composition share pure functions. Named chat profiles without a preset retain their existing raw-request behaviour. Saved bindings contain references and fingerprints, not resolved credentials.
- The accepted Conversation reply API captures an existing saved branch, a named chat profile, persona notes, group-memory and schedule context. Provider results are retained separately from native delivery. Bubbles, reminders and status effects are saved together with records preventing duplicate application. Completed replies can finish delivery after the saved profile is removed.
- The older Conversation send API retains user messages on provider failure, preserves an old reply during failed regeneration and merges completed replies without overwriting unrelated threads. External callers must retry a failed generation using the returned version and `reuseLastUser: true`; repeating the original message ID is rejected as a duplicate.
- Reminder clock parsing now treats a value such as '21:30' as a local clock time rather than 21 minutes; timezone, daylight-saving and spelled-out duration units have checks.

## Immediate continuation: connect the real Conversation workflow

The main Conversation interface still executes its browser queue. The new accepted-reply API is tested, but calling it is not yet a drop-in replacement for every existing feature.

1. Complete saved request support for text-completion profiles and instruct formatting, and define explicit captured behaviour for existing active-connection callers. Do not silently fall back to whichever profile is currently selected in the browser.
2. Participant selection, group concurrency, availability/autoresponder delays, assistant context and image delivery are migrated: the accepted API creates a root job that freezes participants and materialises sibling child jobs, which share the root's message checkpoint and reconcile into one result. Images use the account's own Quick Image Gen provider only; a provider without a server branch is refused with a recoverable error that names it, and no Horde, Imagen or OpenRouter route is substituted. Send-triggered partner chimes and explicit reply targets still need moving.
3. Move the actual composer submission and already-appended-message reply event to durable acceptance. Preserve attachment-only sends, blank forced replies, coalescing, explicit reply targets and message-revision checks. Clear drafts only after accepted work and required user-message writes are durable.
4. Make browser observation reload or merge authoritative native results without executing delivery again. Protect server-owned messages from old browser whole-store writes: the current settings guard protects completion records, not all message content. Preserve legitimate branch edits and deletion.
5. Move reminders, schedules, summaries, idle/proactive work and Roleplay-triggered asides to server scheduling, with saved occurrence IDs and timezone handling. The native status override field exists, but browser availability still has an in-memory map.

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

Last full unit run: 331 suites passed, 4,260 tests passed and two skipped. After the final checkpoint review fixes, all 122 Node tests and 13 focused job-client, Mewmory selection and reminder-target unit tests passed. After the reply-artifact recovery change, all 50 Conversation API tests passed again. Root lint, frontend budgets and whitespace checks passed. These are checkpoint results, not proof that unfinished callers have migrated.

Chromium checks passed for all three Mewmory scenarios, including clicking the real index control, leaving the page after acceptance and checking saved completion before reopening. Macro parity passed at desktop and touch-phone sizes against historical fixtures. Safari was not tested. Simulated saved-state recovery is not a real process-kill test.

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
Main queue: public/scripts/neconyan-conversation/attachments.js
Browser delivery: public/scripts/neconyan-conversation/generation.js
Shared delivery: public/scripts/neconyan-conversation/reply-delivery.js
Browser persistence: public/scripts/neconyan-conversation/context.js

Focused checks: tests/neconyan-conversation-api.test.js
               tests/generation-profiles.node.js
               tests/conversation-*.node.js
               tests/jobs*.{test,node}.js
               tests/mewmory.e2e.js
               tests/macros.node.js, tests/macro-parity-browser.mjs
```

```bash
npm run test:unit --prefix tests -- --runInBand --silent --verbose=false
node --test tests/*.node.js
npm run lint
npm run check:frontend-budgets
git diff --check
```

Run browser checks at 1280x900 and touch 393x852 with the Chromium installed under the tests package. The existing Mewmory fixture server and disposable-data safeguards are documented in its test. Lint changed tests using their own configuration; historical unrelated test-folder lint errors are not permission to add new ones.
