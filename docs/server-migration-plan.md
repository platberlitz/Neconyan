# Server migration phase checklist

This is the durable progress record for moving Neconyan's application workflows
from the browser onto the server. The full contract lives in the planning
document; this file only records what is actually finished and what is not.

Status values: `done` (implemented and verified), `partial` (implemented but an
acceptance case is unproven), `pending` (not started).

## Phase 0: characterise existing behaviour

- `done` Baseline reproduced before any change: Jest 329/330 suites, 4253 passed,
  1 failed (the stale `recordAppliedTransformation` assertion in
  `tests/in-chat-agents-generation-ui-wiring.test.js`), 2 skipped. Node tests 84
  passed. Root lint clean. Frontend budgets passed.
- `done` Existing foundation traced: `src/resumable-generations.js`,
  `src/request-cancellation.js`, `src/chat-file-lock.js`, `src/mewmory/store.js`,
  `src/settings-version.js`, `src/endpoints/mewmory.js`.
- `done` Starting audit work preserved unchanged (sixteen modified files plus
  untracked `src/mewmory/worker.js` and `docs/server-architecture.md`).

## Phase 1: durable jobs, dispatcher, endpoints, observer

- `done` `src/jobs/store.js`: per-user job records at `<user root>/jobs/`, atomic
  writes protected by the existing chat file lock (a lock-guarded read, modify,
  write; this is deliberately not a revision compare-and-set), typed and bounded
  intent validation, submission-key acceptance with canonical intent hashing and
  duplicate semantics, server-only resume decisions, cancellation request,
  completion receipts (a before-receipt and an after-receipt for mutating tools),
  provider-uncertainty markers, newest-first terminal pruning, a write-time ledger
  cap, and start-up recovery. A damaged ledger fails closed for that one account:
  the file is kept untouched and an actionable recovery error is returned.
- `done` `src/jobs/runner.js`: in-process dispatcher with one active mutating
  operation per target, a global running limit, a per-user limit, a reserved
  slot for interactive work, rotating fair dispatch across accounts, slot and
  target release on every failure path, explicit cancellation, restart
  reconciliation, and per-account error isolation so one damaged ledger cannot
  stop the dispatcher.
- `done` `src/endpoints/jobs.js`: authenticated submit, list, get, cancel and
  dismiss endpoints. The account handle is validated before any path is built.
  `/capacity` reports global totals plus the caller's own count only, never every
  account handle.
- `done` `public/scripts/jobs.js`: browser observer that polls authoritative
  saved snapshots, with subscribe helpers and no generation logic. It sends the
  CSRF header through the shared `getRequestHeaders()` helper.
- `done` `tests/jobs.node.js`: runnable checks for durable recovery, duplicate
  submission, cancel, real concurrency caps, fair dispatch, damaged-ledger
  isolation, failed-write release, provider-uncertainty crash windows and
  isolation.
- `done` `tests/jobs-endpoints.node.js`: HTTP-level checks for oversize and
  ill-typed bodies, cross-account read, cancel and capacity isolation, and a
  damaged ledger for one account not affecting another.
- `done` `tests/jobs-client.test.js`: Jest checks that the observer sends the
  CSRF header and that an options spread cannot drop it.
- `done` Router mounted at `/api/jobs` in `src/server-startup.js` after the other
  private routers; a jobs-specific body limit is registered in
  `src/server-main.js` before the general 500 MiB parser; the runner starts from
  `postSetupTasks` in `src/server-main.js` and reconciles persisted work on boot.
- `done` Disposable local preview checks passed after the fixes: submit returned 202 and
  saved the record, an oversize intent returned 413 without disturbing the
  server, `/capacity` exposed only global totals, and the dispatcher failed the
  unhandled smoke type honestly with `JOB_NO_HANDLER`, proving the boot-started
  loop runs. The endpoint requires the CSRF header, exactly like the other
  private routers.
- `partial` Real Mewmory recall and search-index controls submit saved jobs. Other
  workflow callers still need migration.
- `pending` Streaming transport for progress; polling works today.
- `done` Mewmory imports the job client for observation, cancellation, retry and
  dismissal. Its index rebuild no longer loops through batches in the browser.

## Phase 2: shared server execution primitives

- `done` `src/generation/context.js`: explicit job execution context (owner,
  directories, target, revisions, resolved profile reference). The owner handle is
  validated before any directory path is built.
- `partial` `src/generation/service.js`: accepted Conversation replies execute
  saved chat profiles through the existing provider transport. Profile controls,
  preset conversion and provider-specific parameters share the browser code;
  named profiles without a preset retain their existing raw-request behaviour.
  Provider artifacts, cancellation and uncertainty markers use the job runtime.
  Text-completion profiles and instruct formatting remain pending.
- `done` `src/tools/registry.js`: typed, permission-checked tool definitions with
  a server-side invoke that records a before-receipt and an after-receipt around a
  mutating handler, so a missing after-receipt means the effect is unknown.
- `partial` `isMutating` is exported but not used: the job lock contract is
  enforced by the per-target key, not by the mutating flag.
- `partial` Saved-profile bindings validate the account's current profile before
  provider execution without persisting its credentials. Completed Conversation
  replies can finish native delivery after that profile is removed. Bundled tool
  handlers and main-chat generation still need migration.
- `done` Modern and legacy macro evaluation share browser/server code with
  per-operation variables and capabilities. Historical browser fixtures cover
  both paths; account isolation, read-only capture and per-string state reset
  have runnable checks.
- `partial` Conversation transcript, system-prompt composition, persona notes and
  reply splitting share pure functions. The accepted-reply API captures saved
  persona, group-memory and schedule context, then saves bubbles and reminder or
  status changes together with repeat-safe native receipts. The main browser
  queue, complete participant behaviour and image delivery are not migrated.
  Roleplay prompt assembly remains pending.

## Phase 3 onward

- `partial` Mewmory automatic extraction and backfill have a saved server worker;
  manual recall and complete index rebuild use saved jobs and provider artifacts.
  Indexing retains valid vectors when messages arrive during a batch. Explicit
  retries preserve completed provider results. Final Roleplay prompt integration
  and Agents execution remain pending.
- `pending` Roleplay, Story, Guided Generations, Deep Swipe callers.
- `pending` Quick Image Gen and media pipelines.
- `pending` Conversation send queue and scheduler.
- `pending` Meower.
- `pending` Prompting Lab, Distiller, LoreStitch, World Info Lab.
- `pending` remaining bundled model and file workflows.
- `pending` removal of duplicate browser execution and old-client protection.

## Known genuine blockers

- WebLLM and bundled browser Kokoro remain explicit browser-only exceptions, as requested by the owner. Their controls state that the page must stay open. Keep their existing provider choices; do not silently substitute a server provider.
- Custom user browser scripts that require arbitrary DOM JavaScript cannot run on
  the server; dependent work must be refused with an explicit capability report.

## Verification commands

- `npm run test:unit --prefix tests`
- `node --test tests/*.node.js`
- `npm run lint`
- `npm run check:frontend-budgets`

## Current checkpoint

This is a saved implementation checkpoint, not a release-ready full migration.
Production has not been changed. Conversation's accepted-reply API is exercised through saved provider
settings, native completion and recovery tests, but the main browser interface
does not use it yet. Text-completion profiles, instruct formatting, image
delivery, full participant behaviour and autonomous scheduling remain required
before switching that interface. The other pending workflows above remain part
of the requested scope.

- Full Jest run: 331 suites passed; 4,260 tests passed and two skipped.
- All Node tests after checkpoint review fixes: 122 passed; 13 affected frontend unit tests also passed.
- After the last full run, all 50 Conversation API tests passed again with the
  added case for recovering native delivery after its saved profile is removed.
- Root lint, frontend budgets and whitespace checks passed.
- Chromium Mewmory checks: three passed at desktop and touch-phone sizes. The
  real index-rebuild control was used, the page was unloaded after acceptance,
  and saved completion was checked before reopening it.
- Macro browser parity passed at desktop and touch-phone sizes against the
  historical fixtures. Safari behaviour remains unverified.
- Fable reviewed the job, macro and Mewmory checkpoints and concrete findings
  were addressed. The final complete-migration review has not happened; the last
  requested Mewmory follow-up was cancelled and is not counted as a review.

Continuation instructions and the next integration boundary are recorded in
`docs/server-migration-handover.md`.

## Verification results (pass 1)

- `node --test tests/*.node.js`: 90 passed, 0 failed (was 84; the six new job
  and tool checks pass).
- `npm run test:unit --prefix tests`: 329 suites passed, 1 failed (the known
  stale Agents assertion), 4253 tests passed, 1 failed, 2 skipped. Unchanged
  from the phase 0 baseline, so nothing regressed.
- `npm run lint`: clean.
- `npm run check:frontend-budgets`: passed; blocking stylesheets 17 at
  1021.2 KiB, startup scripts 24 at 2188.1 KiB, identical to the baseline.

## Verification results (pass 2, after the review fixes)

- `node --test tests/*.node.js`: 99 passed, 0 failed (the twelve job-store and
  dispatcher checks plus three HTTP endpoint checks).
- `npm run test:unit --prefix tests`: 331 suites passed, 0 failed; 4257 passed,
  2 skipped. The previously known Agents wiring failure is fixed by correcting
  its expectation to the real source call, so the phase 0 baseline failure is
  now resolved rather than suppressed.
- `tests/jobs-client.test.js`: 3 passed (observers send the CSRF header and an
  options spread cannot drop it).
- `npm run lint`: clean.
- `npm run check:frontend-budgets`: passed; blocking stylesheets 17 at
  1021.2 KiB, startup scripts 24 at 2188.1 KiB.
- Disposable local preview on port 8124: `/csrf-token` then submit returned 202 and saved the
  record, a 4 MiB intent returned 413 and the server stayed up, `/capacity`
  returned only global totals and the caller's own count, and the dispatcher
  failed the unhandled smoke type with `JOB_NO_HANDLER`; the process was stopped
  and the port confirmed free.
- Changed test files lint clean under the tests configuration. The existing
  history of unrelated test-folder lint errors was left alone.

### Review findings and their fixes

- Oversize and ill-typed intents could exceed the ledger read limit and crash
  the dispatcher; fixed with a jobs-specific body limit registered before the
  general parser, per-job intent and ledger caps, and per-account error
  isolation in the runner and recovery. Damaged ledgers now fail closed for that
  account and are never silently reset, so receipts cannot be lost and effects
  replayed.
- Pruning kept the oldest records and could discard a just-accepted job; fixed
  to keep all non-terminal work, retain the newest terminal records, and refuse
  capacity before an unpersistable acceptance.
- A failed initial running write leaked a slot and target lock; fixed with a
  try, finally so every failure path releases both, and secondary status writes
  no longer create unhandled rejections.
- Clients could choose resume or recoverability and auto-repeat a provider call
  after a crash; fixed by removing those fields from public acceptance, marking
  provider uncertainty before the outbound call, clearing it only after the
  result is saved, and reconciling uncertain calls as interrupted with an
  explicit retry.
- A provider error message containing the word aborted was falsely treated as a
  cancellation; fixed so only a real controller abort or a saved cancellation
  counts as cancelled, and provider failures stay visible.
- Dispatch order starved later accounts; fixed with rotating fair dispatch.
- `/capacity` leaked every account handle; fixed to return global totals plus the
  caller's own count.
- The observer sent no CSRF header and an options spread could drop the merged
  headers; fixed to use the shared `getRequestHeaders()` helper and merge
  options separately, with a Jest check.
- Endpoint inputs were untyped; fixed with bounded type, submission-key, target,
  config and intent validation, canonical key ordering for the intent hash, and
  owner validation before any path is built.
