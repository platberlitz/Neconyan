# Server migration phase checklist

This is the durable progress record for moving Neconyan's application workflows
from the browser onto the server. The full contract lives in the planning
document; this file only records what is actually finished and what is not.

Status values: `done` (implemented and verified), `partial` (implemented but an
acceptance case is unproven), `pending` (not started).

## Current checkpoint: automatic Conversation ownership

- `done` The app persists server ownership, timezone and acknowledged saved settings
  for background use. Successful general saves acknowledge their new revision in
  the same write. Browser periodic execution, automatic timers, the memory-summary
  timer and native-observation chime fence are removed; Roleplay rendered-message
  sampling still submits native asides.
- `done` Ownership, accepted occurrences and all legacy unread state are protected
  across saves, imports and reset. Exact deterministic identity repair preserves
  accepted history revisions. Authoritative automatic history can be copied into
  branches/groups while stale new automatic appends are refused.
- `done` Stable reminder identity and durable chime/summary ownership survive
  cancellation and job pruning. Boot migration runs before plugins/listeners/jobs;
  failed migration holds pruning. Markers are not evicted to permit repeat work.
  Failed/interrupted occurrences require explicit retry through their saved job.
- `done` Memory refresh and manual memory writes are native. Current fingerprints
  prevent a pending summary from undoing a later clear or overwrite. Legacy jobs
  lacking this proof refuse before provider dispatch and need a new explicit
  Refresh memory request rather than retrying their old job. Summary scheduling and
  preparation share attachment-aware eligibility and persona-scoped identity.
- `done` All 145 disposable Chromium cases passed in one full serial run (1.3 hours),
  including eight new ownership cases at desktop 1280x900 and touch 393x852.
  The first run passed 144/145; one old assertion expected a duplicate chime job
  now prevented at acceptance. The corrected no-duplicate/two-scan/later-reminder
  case passed alone and in the complete rerun. The earlier focused 21-case run
  is recorded separately in the handover.
- `done` Independent reviews verified actual pura-openai/gpt-6-astra assistant
  metadata with variant max. Every stage-local finding was fixed and re-reviewed.
  Full checks: 335 Jest suites, 4,409 passed and two skipped (4,411 total), one
  snapshot; 267 Node tests passed; root lint, budgets and whitespace passed.
  Changed-test lint: zero errors, 45 warnings.
- `pending` Roleplay generation and completion writes, followed by the remaining
  whole-application scope below. Manual Conversation regeneration, polishing,
  schedule controls and selfie coordination still need native completion writes.

## Historical checkpoint: native unread, presentation and narration

- `done` Native messages save unread and pending presentations with completion
  receipts. One tab wins each claim; observed read boundaries preserve unseen
  arrivals. Discovery retries both presentation and read-only acknowledgement
  failures without idle settings-save churn.
- `done` OpenAI, OpenAI Compatible, ElevenLabs and Pollinations narration uses
  saved audio and provider uncertainty records. Unknown outcomes remain interrupted
  until explicit retry. Image captions are included; browser Kokoro remains an
  explicit page-open exception. Stop, visibility, persona, source identity,
  speaker eligibility and freshness survive asynchronous playback waits.
- `done` All 137 disposable Conversation Chromium cases passed in one full serial
  run (1.2 hours), including 21 new presentation cases at desktop 1280x900 and
  touch 393x852. The first full run was 136/137 due to the known legacy merge
  fixture's startup-save race. A bounded quiet-version setup preserved its single
  exact-version append; five focused repetitions and the second full run passed.
- `done` Fresh independent review used actual assistant-message metadata verified
  as pura-openai/gpt-6-astra, variant max. All stage-local findings were fixed and
  re-reviewed; the automatic-ownership boundary below remains outstanding.

- `done` Native solo partner chimes are implemented and verified: the full 116-case
  disposable Conversation suite passed in one serial Chromium run (57.8 minutes),
  including desktop and touch Send/Enter zero-page chimes, the five exclusion
  cases, a two-profile duplicate race, an image-only chime across a real process
  restart and a refused chime-only family. The browser-worker duplicate race is
  pinned by unit checks on the observation fence.
- `done` Earlier active-binding checkpoint: the named Step 7 controls pass Chromium checks at desktop 1280x900 and
  touch 393x852. The suite contains 52 cases: 51 passed in the full run and the
  corrected lost-save-response test passed in a focused rerun. It owns disposable accounts, fake providers
  and an actual serving process; four recovery cases cover three restart boundaries
  and kill that process directly.
- `done` Browser failures and independent review findings are fixed: the account
  import, overlapping message menu, captured-account guards through submissions,
  uploads and preliminary aside saves, initial settings ownership, queued saves,
  observer read coalescing and test opt-in/process handling. Thumbnail responses
  also have deterministic coverage for equal-size/equal-time cache collisions.
- Checks at that checkpoint: 335 unit suites, 4,395 tests passed and two skipped (4,397
  total), one snapshot; 257 Node tests passed. Root lint, frontend budgets and
  whitespace checks passed. Changed-test lint: zero errors, 43 warnings.
- `done` Resolve findings a-e: pre-migration baseline/version capture, bounded
  history retention, branch identity during batching/repair, complete member-key
  intent matching and identifier-less message merging. Settings imports, restore
  and reset preserve increasing checkpoints; ambiguous legacy changes refuse
  saving without discarding local edits. Legacy histories receive a verified
  checkpoint before new work is captured. Retention, real crash recovery,
  migration races and all settings-replacement paths have browser regressions.
- `done` Named text-completion/instruct requests share all 15 provider parameter
  mappings and retain saved templates, credential references and prepared values.
  Eight new desktop/phone control cases and two group-binding cases passed;
  the expanded 62-case suite was not rerun in full at this checkpoint.
- `done` Capture eligible participant bindings before input acceptance, retain
  later mention selection and separate batches when their bindings differ.
- `done` Explicit saved-active bindings use acknowledged serialised controls and
  retained credential references. Validation precedes uploads and acceptance;
  unsupported capabilities refuse without consuming the draft. Manual helpers
  retain captured sources and never switch to active settings after a profile error.
  Native summaries and schedules accept the same acknowledged bindings.
- `done` The complete browser run passed 95 durable cases and two scoped-formatting
  cases. Both acknowledgement cases passed after correcting an unrelated queued-save
  fixture race; nine added durable cases passed separately. That checkpoint covered
  104 durable and four formatting/acknowledgement cases, not one green 108-case run.
  Checks include active Chat/Text controls at both sizes, lost acceptance followed
  by 429, pre-upload refusal, manual source/speaker races, character-script changes
  and stored inline images without native cryptographic hashing.
- `done` Native solo partner chimes run through the durable jobs: a server-side
  occurrence claim gives exactly one root ownership, and the browser chime path
  stands down while a native job is in flight, awaiting or syncing.
- `done` Automatic-ownership handover followed this checkpoint; see the current
  checkpoint above. The browser worker and observation fence are now removed.
- Safari, unresolved image-provider crash recovery and reload-persistent send
  retry identity are unverified. Manual Conversation completion writes still
  depend on the browser. Deployment remains unauthorised.

The older results below describe earlier checkpoints, not the latest totals.

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
  Named text-completion profiles, instruct formatting and acknowledged saved-active
  requests are implemented; remaining workflow callers still need migration.
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
  status changes together with repeat-safe native receipts. A native root job now
  selects participants (group weighted/mention choice, solo single speaker), builds
  each participant's card, saved profile binding, activity, assistant knowledge and
  reply reference, and materialises one sibling child job per participant. Children
  can run concurrently, share the root's message-hash checkpoint, apply the browser
  availability/autoresponder/delay policy, and reconcile into one root result;
  retries, cancellation and dismissals are family-aware. Image delivery now runs
  natively through the account's own Quick Image Gen provider only
  (`src/generation/quick-image-gen.js`): together, gptimage, routeway, navy, zai,
  fal, arliai, stability, pollinations and local A1111 are implemented, gated by the
  saved image cooldown and receipt-protected so a retry does not re-bill a saved
  image. A provider with no server implementation, including ComfyUI, is refused
  with a recoverable error that names it; Horde, Google Imagen and OpenRouter image
  routes are never substituted. The main composer, forced reply and
  branch-from-message reply now submit to durable acceptance, the browser
  append/selection/coalescing queue is removed, and observation reads authoritative
  saved results. Roleplay prompt assembly remains pending.

## Phase 3 onward

- `partial` Mewmory automatic extraction and backfill have a saved server worker;
  manual recall and complete index rebuild use saved jobs and provider artifacts.
  Indexing retains valid vectors when messages arrive during a batch. Explicit
  retries preserve completed provider results. Final Roleplay prompt integration
  and Agents execution remain pending.
- `pending` Roleplay, Story, Guided Generations, Deep Swipe callers.
- `partial` Quick Image Gen provider calls run natively for the providers listed
  above (see Phase 2); the remaining QIG provider branches, the scoped prompt
  pipeline (styles, quality tags, ST-style and contextual filters) and the other
  media pipelines remain browser-side or unimplemented server-side.
- `partial` Conversation participant selection, availability, assistant context and
  the image boundary run natively (see Phase 2). The worker now schedules native
  reminders, weekly and legacy schedules, idle and proactive messages, chimes and
  character chat through the reply family, plus native memory summaries and manual
  schedule generation, using deterministic occurrence keys and one-time bookkeeping
  claims. The Roleplay group-aside and solo side-DM bridge runs natively through
  `POST /aside/submit` with a saved source guard. The composer and the
  branch-from-message reply event submit to durable acceptance with trigger
  revisions and explicit reply-target anchors, browser observation merges
  authoritative results, and a version-checked Conversation save path plus a
  strengthened settings guard protect server-owned messages and records from old
  whole-store writes. Send-triggered solo partner chimes run through the same family
  with durable occurrence ownership. Native unread/presentation claims, supported
  narration, automatic ownership and native memory controls are verified. The
  browser automatic worker and legacy unread fallback are removed. Remaining
  Conversation work includes manual regeneration, polishing, scheduling and image
  coordination completion writes. Text-completion and acknowledged active bindings
  are implemented.
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

## Historical checkpoint: participant and image delivery

This is a saved implementation checkpoint, not a release-ready full migration.
Production has not been changed. The main Conversation composer, forced reply and
branch-from-message reply now submit to the accepted-reply API and the browser
queue is removed; observation reads authoritative saved results, a version-checked
Conversation save path keeps browser edits honest, and the settings guard protects
server-owned messages and records. Participant selection, group concurrency,
assistant context and the image boundary run natively. Text-completion profiles,
instruct formatting and disabling the browser's own 30-second worker after
ownership handover remain required; autonomous scheduling already runs on the
server worker. The other pending workflows above remain part of the requested scope.

- Full Jest run: 331 suites passed; 4,266 tests passed and two skipped.
- All Node tests after the Step 5 image work: 144 passed. `tests/quick-image-gen.node.js`
  covers provider dispatch, refusal of unsupported providers and untrusted image
  URLs, the A1111 sampler/checkpoint body, the image cooldown and the prompt/keyword
  policy. The focused `tests/conversation-reply-policy.node.js` covers selection,
  availability/delay policy and family store behaviour; the Conversation API suite
  covers root+child completion and recovery.
- Reviewer findings on the Step 4 diff (child timezone, family retention/dismiss,
  root retry, child cancellation, cancellation during preparation, orphaned
  children, selection/notice divergence, legacy gating, permanent finalise loop,
  reconcile clock default) were fixed and re-verified.
- Reviewer findings on the Step 5 diff (keyword detection reading the directive
  instead of the user message, missing image cooldown, unmapped A1111 sampler and
  checkpoint, unbounded provider reads and no fetch deadline, untrusted image URL
  fetch, prototype-key provider lookup, abort wrapping, image message reply
  reference, retry re-billing) were fixed and re-verified. The scoped prompt
  pipeline (styles, quality tags, ST-style/contextual filters) and the remaining
  QIG provider branches are deliberately not implemented yet.
- Older checkpoint record: all Node tests at that time 122 passed; 13 affected frontend unit tests also passed.
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
