# Server migration phase checklist

This is the durable progress record for moving Neconyan's application workflows
from the browser onto the server. The full contract lives in the planning
document; this file only records what is actually finished and what is not.

Status values: `done` (implemented and verified), `partial` (implemented but an
acceptance case is unproven), `pending` (not started).

## Current checkpoint: Stage 9 named Roleplay workflows and browser cutover (verified)

- I have completed Stage 9 locally, on top of verified Stage 8. The browser's Roleplay controls now submit one named server workflow, observe it and adopt its durable write, and on that path the page no longer assembles the prompt, calls a provider or decides who speaks in an aside. Stages 8-9 are not deployed; the Oracle VM still runs committed Stages 1-7.
- The named vocabulary is server-owned. Ten names map to one effect, one anchor and one prompt shape: a reply, a continuation, a swipe, a correction, a Story passage, three Guided prompts and two Deep Swipe variants. The four plain controls keep the saved automatic swipe and continuation policy, frozen at admission as in Stage 8; Story, Guided and Deep Swipe never capture it, so each finishes after exactly one bounded turn. Deep Swipe is a new `alternative` effect that adds one more unselected swipe and leaves the selected text, its index and the message's own metadata untouched, with a prompt window that excludes the anchored message, which is what the page did.
- Acceptance is native: `POST /api/roleplay/workflow/submit` and `GET /api/roleplay/workflow/receipt`. The browser sends a key, a name, the saved chat, the message it is looking at, that message's revision, its account stamp and the settings acknowledgement. The server captures the anchor under the account lock, derives the anchored message itself, and refuses when its derivation disagrees with the browser's index or revision, so a chat that moved on cannot absorb a different intent. The generic job endpoint still refuses `media.*` and `roleplay.*`, so a plain intent cannot start one of these workflows.
- Receipts are the readback. `readNativeMediaJobResultForOwner` resolves the account's own permanent receipt by operation key, so a reopened page recovers a finished result after its job is pruned, and a replayed key returns the first acceptance instead of paying twice.
- The browser decides once, before the host touches the chat. `willRunNativeRoleplayWorkflow` in `public/script.js` is the single owner of the refusals, so slash commands still run, the user's own text is still saved by the host, and the destructive regenerate delete is skipped only when a durable server replacement is committed. The funnel then submits, observes, cancels on Stop, waits for the durable write and reloads the chat it does not own. An uncertain response replays the identical request, and a refusal never falls through to a second browser generation.
- Story Mode adopts the cut the saved result reports instead of pushing its own; Guided Generations response, swipe and correction contribute their saved in-chat prompt at their own depth and role; Deep Swipe's assistant and user variants submit their saved instruction. `/ask` and the logprobs recorder keep the browser path because they read the provider's own reply, and `/impersonate`, groups, the built-in helper assistant and Story Mode's transforms stay browser-owned and are listed as such.
- Page-only prompt additions travel instead of being dropped. The page resolves the extension prompts the server cannot rebuild itself, such as Dialogue Colours, summaries and `/inject` values, into at most 32 sorted, macro-free entries with their position, depth and role; the server validates and hashes them into the named record and publishes them on every turn under a `page_` prefix that cannot replace a protected slot. An addition that cannot travel exactly, such as an Agent, Pathfinder or vector prompt, a scan-enabled inject, an unresolved macro, enabled vector retrieval or an unknown generation interceptor, keeps the whole generation on the browser path, and a committed regenerate or swipe refuses instead of losing it.
- The World Info settings binding ignores only page bookkeeping (save counters, mirrored browser storage and the Conversation store), so a routine page save between acceptance and the model turn no longer fails the reply, while any setting a prompt reads still stops the turn before paying. The page saves its settings before each submission and retries a save it cannot finish yet a bounded number of times.
- Asides are native events. The page reports only that a message rendered or that a user message may name a member; the server keeps Roleplay reactions opt-in, samples solo chats and groups at the same 18 per cent, chooses at most one recipient from the saved members who opted in, and reuses the existing aside acceptance, cooldown, busy check and permanent occurrence key. One mention event now answers with one member instead of one call per mentioned member, so a single event can never become a burst of paid calls. WebLLM and bundled browser Kokoro remain the only approved page-open providers and are untouched.
- Not part of this stage: group turns from the browser, the remaining manual Conversation controls, Meower, Labs and the rest of the application. Deployment is not authorised; push only on request.

## Historical Stage 8 whole-Roleplay execution (verified)

- I have completed Stage 8 locally, on top of verified Stage 7. One saved progressive workflow now carries a whole accepted Roleplay turn: indexed model turns, bound tool children, automatic swipes, continuations and group speakers, ending in one journalled protected chat write. The old reply, its selected swipe and unrelated history stay intact until that write, and a candidate never writes chat at all. Stage 8 is not deployed; the Oracle VM still runs committed Stages 1-7.
- A model tool call becomes a real child job attached to the root, and the root resumes the model with a complete server-proven assistant function-call and tool-result pair. A child that mutates a book, Agent, preset, character or the chat must prove its own permanent physical effect before the root may recapture the protected source and bound World Info; several mutating calls in one model reply progress in order with one proof each. Automatic swipe and continuation decisions are saved before the next paid turn, a rejected reply is kept as an earlier swipe in the final write, and continuations assemble into one final message. Group speakers are frozen at admission and published one at a time, each starting from a source proved to be the previous speaker's own write.
- The whole-stage self-review, one batched correction pass and correction-only follow-up are complete. Six findings were corrected: a saved decision recomputed before its stored value was read, no proof that the chat still matched the final owned write, missing 64 MiB chat and Companion capacity admission checks, a catastrophic-backtracking risk in the saved automatic-swipe blacklist, an unsafe character-list cache copied from the performance patch, and a per-candidate tool history limit too small for a progressive workflow. Final gates: 341 Jest suites, 4,539 passed tests and two skipped, one snapshot; 1,219 Node tests; frontend budgets; whitespace; and changed-test lint across the five Stage 8 test files with zero errors.
- The serial disposable Chromium run passed 16/16 at desktop 1280x900 and touch 393x852, with every page closed for native work, the real serving process killed and restarted, and reopening without another provider request. Providers were controlled local fixtures, so live vendor behaviour is unverified, and WebKit was unavailable so iOS behaviour is inferred from Chromium. The repository lint script cannot run on this machine because the root has no ESLint install and the resolver reaches ESLint 10, which refuses the repo's legacy config; changed files were checked with the project's own ESLint 8.57.0 instead.
- Do not push or deploy Stage 8. Stage 9 is the Roleplay ownership checkpoint: named Story, Guided and Deep Swipe workflows, real submit and observe controls, reopen without replay and native aside events. Those belong to Stage 9, which is now verified locally. Stages 10-13 remain authorised for later continuation. Preserve and exclude both owner-authored uncommitted workflow edits. Stage 8 does not include a production browser caller, and it does not extend to the Meower, Labs or remaining application work.

## Historical Stage 7 tools, Agents and generation hooks (verified)

- I have completed Stage 7 at local implementation commit `fa5050578`. Native before/after Agent processing, Companion context and retained history, tracker edits, selected Quick Reply variable actions, manual Agent and draft jobs, and account-bound Pathfinder and Neconyan Assistant actions now retain their inputs and completion evidence. Mutations that need review wait for a saved owner decision. Provider calls running in parallel retain each uncertain outcome separately. Ordinary authoring routes use the same protected account lock and refuse busy targets.
- The whole-stage self-review, batched corrections and correction-only follow-up are complete. Final checks passed: 341 Jest suites, 4,539 passed and two skipped tests, one snapshot; 1,191 Node tests; root lint, budgets, whitespace and changed-test lint across 24 files with zero errors. Twelve disposable desktop/touch Chromium Agent, prompt and lore cases passed with all pages closed for native work, actual serving-process death/restart and reopening without replay. Live vendor services and Safari/WebKit were not verified.
- The owner-authorised Oracle deployment of committed Stages 1-7 passed its exact-file, supported-Bun, service-restart and public-asset checks. Do not push or deploy Stage 8. Implement and verify Stage 8 locally next, then pause with a copyable Stage 9 handover prompt. Stages 9-13 remain authorised for later continuation. Saved child tool actions complete now, while parent Roleplay tool-call turns and group/speaker progression belong to Stage 8; the real browser cutover belongs to Stage 9. Preserve and exclude both owner-authored uncommitted workflow edits. Deployment evidence and limits are in the canonical handover.

## Historical Stage 6 prompt contributors and media (verified)

- I have completed Stage 6 at local implementation commit `9ebd74334`. Native Pathfinder, automatic input/output translation, captions, sprites, saved speech and the complete configured Quick Image Gen workflow now retain their inputs, intermediate provider results and completion ownership. Queryable submissions save their IDs before polling; unknown paid outcomes never repeat automatically. Source-bound completion preserves old chat and media until replacements are durable.
- Whole-stage self-review, one batched correction pass and correction-only follow-up are complete. Final checks passed: 341 Jest suites, 4,538 tests and two skipped tests, one snapshot; 1,099 Node tests; root lint; budgets; whitespace; and changed-test lint across 24 files with zero errors. The disposable desktop/touch Chromium media, prompt and lore run passed 14/14, plus two affected Conversation image cases after the final source-check correction. All-page closure, actual serving-process restart and no-repeat recovery are covered. Live vendor availability and Safari/WebKit are not established by these fixtures.
- Continue Stage 7, then Stage 8. The owner has requested a pause only after Stage 8 is fully reviewed and verified, with a copyable Stage 9 handover prompt. Stage 9-13 remains the subsequent migration scope. No push or deployment is authorised; preserve and exclude both uncommitted owner workflow edits. Detailed boundaries and entry points are in the canonical handover.

## Historical Stage 5 authoritative prompts (verified; owner-requested pause)

- Private server prompt assembly now covers saved character/persona/group fields and protected target history, PromptManager order and depth roles, instruct/context, macros and transformations, notes/lore/examples, provider-specific budgets, supported file/image inputs, tool schemas and completed progressive results, and Mewmory context. Prepared prompts, scan inputs and request controls survive replay. Actual contributor/tool execution and the production browser caller remain assigned to Stages 6-9.
- Whole-stage same-model self-review and one batched correction pass are complete. Final gates: 338 Jest suites (4,521 passed, two skipped), 901 Node tests, lint, budgets, changed-test lint with zero errors, whitespace, and 8/8 disposable Chromium prompt/lore cases at desktop and touch-phone sizes. Zero-page native completion and process restart/reopen were verified; Safari/WebKit was not run. Full details and evidence boundaries are in `server-migration-handover.md`.
- The owner requested a pause after Stage 5. Stage 6 has not started. Resume Stage 6 in a new session and continue Stages 6-13 in order. No push or deployment is authorised; preserve both uncommitted owner workflow edits.

## Historical Stage 4 saved World Info activation (verified)

- Server selection now uses the accepted Roleplay chat, its saved books, character and effective persona, settings, account and physical file identities. The browser and server share matching, groups, entry order, probability and timed-window rules. Recursion, exact token budgets, random draws, per-pass hook decisions and final activation are saved before provider dispatch; timed metadata is part of the recorded chat effect. Read-only MacroEnhanced lore macros consume each job's saved result without a shared browser cache.
- The saved hook policy binds Pathfinder eligibility, linked Quick Reply action identities and scan contributors. When their paid retrieval, mutating scripts or vector/Agent scan prompts require later server ownership, the private job refuses before contacting a provider instead of silently omitting them. Stages 6, 7 and 13 own those effects; Stage 8 owns complete Roleplay workflows and Stage 9 their browser cutover. This Stage 4 completion does not certify those later actions.
- Same-model stage-end self-review of `349f0f7cf..2eb54b7ea` and affected browser callers corrected concrete source, replay, persona, timed and hook-authority findings; correction-only checks found no further reproduced supported-path defect. At `2eb54b7ea`, 338 Jest suites (4,521 passed, two skipped), 854 Node tests, root lint, frontend budgets, changed-test lint (zero errors) and whitespace passed. The disposable Chromium World Info suite passed 4/4 at desktop and touch phone sizes. Safari/WebKit and the real Roleplay browser cutover are unverified.
- The owner asked to pause here and continue Stages 5-13 in a new session. Do not push or deploy.

### Stage 3 accepted bound execution

- Private Roleplay replies now execute on the server with an accepted account, source and connection binding. A complete provider result is saved before a recorded chat effect, and an unknown paid-provider outcome remains interrupted. Native saved chat/text and acknowledged active chat/text, Kobold, NovelAI and Horde families are covered. Chat/text streams require proven completion; Kobold/NovelAI token-only streams are explicitly refused for bound requests and use complete non-streaming results instead. Stage-end self-review corrections cover legacy controls, tier limits, chat renames and stream errors.
- At `3c123683f`, 338 Jest suites (4,510 passed, two skipped), 744 Node tests, root lint, budgets, changed-test lint and whitespace passed. Desktop and phone Chromium checks of the saved Kobold acknowledgement passed 2/2. The independent review was unavailable; the selected model reviewed and corrected the full Stage 3 path itself. These checks do not establish Roleplay browser cutover or Safari behaviour.
- Complete server prompt construction, whole-workflow ownership and browser cutover belong to Stages 5, 8 and 9. Do not push or deploy.

### Historical Stage 2 checkpoint

- Last reviewed checkpoint commit: `9fddf069004d7a349dd95f255af40a819a9e3395`. This Stage 2 checkpoint is committed; Stage 2 remains incomplete.
- Completed: one-file composite import of every converted history, required memory and group linking; all existing parsers, frozen names/timestamps/vacancies, permanent intent and exact replay/recovery. Chooser and Backup Restore retain their retry identity across reopening and cannot redirect imports or history refreshes to another target.
- Review: all concrete findings were fixed and accepted in bounded independent re-review. Proven unaccepted refusals permit a fresh explicit retry; uncertain/pending keys survive. Older acknowledgements cannot clear newer attempts. No known checkpoint finding remains.
- Exact final gates: 338 Jest suites, 4,502 passed/two skipped/one snapshot; 664 Node tests; root lint, budgets and whitespace; six-file JavaScript test lint with zero errors/120 warnings; all 22 storage/import Chromium cases in one serial run at desktop/touch sizes, with zero generation calls. An unfinished accepted import reconciles after every page closes and the actual serving process is killed/restarted. Safari/WebKit is unverified.
- Stage 2 checkpoints since then: `7702a14db` chat delete/rename, `8a7c05c43` group create/delete, `08f424c43` character lifecycles, `c05b5c673` Data Maid, retirement/restore, seeding and folder/ZIP imports, `df71fc588` reset/purge with fresh data epochs, `fc872e2cd` paused-job admission with typed effects and instance-bound asides, `275e02e58` stage-end corrections, `2dc037f96` correction-only follow-up fixes and `3093d0ec2` BYAF/first-time imports. The complete combined Chromium run at `3093d0ec2` passed 167/167; 338 Jest suites (4,510 passed, two skipped) and 713 Node tests passed with lint and budgets. Focused BYAF and backup-import tests passed; Safari/WebKit is unverified.
- Unfinished at this historical checkpoint: browser callers for paused-job admission and accepted Roleplay workflows arrive with Stages 8 and 9. Details and limits are in `server-migration-handover.md`.
- Next action: implement Stage 3 bound Roleplay execution. Do not push or deploy.

Small, coherent local checkpoints are authorised within stages. They record implementation progress, not reviewed stage completion. No push or deployment is authorised. The session model plans, implements and reviews the whole stage itself; one stage-end self-review covers all checkpoints, with batched corrections and correction-only follow-up review. Separate reviewer agents require an explicit user request for that task. Full final verification standards remain unchanged. The detailed current record is in `server-migration-handover.md`; historical counts below are not current approval.

## Historical committed Stage 1: Roleplay storage preparation

- `done` Trusted native chat mutation shares the existing lock, writer, backups,
  exact recovery and Mewmory branch capture. A mandatory raw-byte source hash
  rejects stale writes even with legacy integrity checks disabled. Strict path,
  UTF-8 and synchronous JSON-record validation precede mutation; native no-ops
  preserve bytes and file identity, while real metadata changes remain writes.
- `done` Native failures retain committed or uncertain outcome information through
  write cleanup, memory capture and lock release. Uncertain outcomes require
  reconciliation before repeating work. This does not add workflow receipts.
- `done` Full checks: 335 Jest suites, 4,413 passed and two skipped (4,415 total),
  one snapshot; 294 Node tests passed, including 27 native-mutation checks; root
  lint, budgets and whitespace passed. Four changed test files: zero lint errors,
  14 warnings, not a full tests-folder lint result.
- `done` All 149 disposable Chromium cases passed in one full serial run (1.3 hours):
  145 Conversation cases plus four solo/group storage cases at desktop 1280x900
  and touch 393x852. New checks edit and branch through real controls, close all
  pages, apply a trusted native storage mutation, restart the serving process and
  reopen retained messages/swipes/reasoning. No model requests occur in these
  four cases. They verify storage compatibility, not Roleplay generation.
- The first full browser run passed 148/149: one Conversation message-edit setup
  hit a settings-version conflict. That unchanged case passed alone and the full
  second run passed. Runtime files stayed fixed throughout each full browser run.
- `done` Fresh Pura/max planner and reviewer execution was verified through actual
  assistant-message metadata. Review findings about uncertain writes, unsafe-path
  recovery, exact UTF-8 bytes and lock-release outcome loss were fixed, covered by
  failure-injection checks and re-reviewed without remaining concrete findings.
- `pending` Roleplay accepted workflows and completion writes. This stage adds no
  handler, native acceptance endpoint or browser generation cutover. Safari is
  unverified; the whole migration remains unfinished and deployment is forbidden.

### Ordered full-ownership continuation

These stages implement the accepted full migration, not a reduced single-provider
request design. The owner-selected session model plans and implements each stage,
then performs one stage-end self-review of the complete stage. Complete
coherent checkpoints with required checks, canonical status updates and authorised
local commits; earlier planner/implementer/reviewer lineups are historical. Once the
owner resumes this paused migration, continue automatically between verified checkpoints.

| Stage | Status | Required boundary |
| --- | --- | --- |
| 1. Strict native chat mutation | done | Preparatory storage operation described above. |
| 2. Protected Roleplay identity and effects | done | Server-assigned instance identity, exact message/swipe/range anchors, full-intent acceptance and completion records surviving job pruning, saves and all lifecycle operations. Protected storage, group updates, chat imports, chat/group/character lifecycles, Data Maid, retirement, seeding, backup imports including first-time files, BYAF chats, reset/purge, paused-job admission with typed effects and aside guards are committed. The combined browser run passed 167/167 at `3093d0ec2`; browser callers and accepted workflow execution belong to later stages. |
| 3. Bound execution and output processing | done | Private accepted Roleplay jobs bind account/source/connection and save provider results before typed chat effects. Saved and active chat/text plus active Kobold, NovelAI and Horde use native handlers; chat/text SSE completion, reasoning, cleanup, safe custom controls and credential-free artefacts are verified. Token-only Kobold/NovelAI streaming is refused for bound jobs; their complete non-streaming results work. The browser does not submit these jobs yet. |
| 4. Shared World Info activation | done | Protected saved chat, character, persona, settings and books drive recursive selection with exact token budgets, timed effects, saved random draws and per-pass/final hook records. Read-only lore macros consume the saved activation. Unsupported enabled Pathfinder retrieval, Quick Reply actions and vector/Agent scan contributions refuse before paid work; their execution remains in Stages 6, 7 and 13. Private server selection and affected browser scans are verified, not Roleplay browser cutover. |
| 5. Complete prompt assembly | done | Protected saved character/persona/group/target history, shared instruct/context and PromptManager order/depth, provider budgets, supported file/image inputs, tool schemas, immutable completed contributor/progressive inputs, Mewmory and extension ordering. Prepared prompts and request controls survive replay; unknown provider outcomes remain interrupted. Actual contributor/tool execution and browser cutover belong to Stages 6-9. |
| 6. Prompt contributors and media | done | Native Pathfinder retrieval, automatic input/output translation, image/video captions, sprites, saved multi-voice speech and complete configured Quick Image Gen prompt/provider/batch workflows. Exact saved sources, account-first writes, immutable binary inputs/results, queryable submission IDs and permanent completion receipts survive restart. Private admission and zero-page completion are verified; browser cutover remains Stage 9. |
| 7. Tools, Agents and generation hooks | done | Protected pre/post Agent work, complete-context interceptors, Companion context/batches/history/feedback, trackers, bounded output, manual Agent and draft effects, linked local-variable Quick Reply actions, account-bound native Pathfinder and Assistant tools, and explicit durable owner approvals. Exact source and result proofs, account-locked authoring and parallel unknown-outcome recovery are verified. Child tool actions complete privately; Stage 8 still owns their parent Roleplay progression. |
| 8. Whole-Roleplay execution | done | One saved progressive workflow for group speakers, tools, Agents, continuations, automatic swipes, cancellation, known-result recovery and native completion. Root workflow, no-chat candidates, bound tool children with own-source lineage, saved automatic decisions, group speakers and the journalled final write are implemented and verified. Zero-page completion, real serving-process restart and no-repeat recovery are covered by disposable fixtures. Private admission started the workflow; Stage 9 added the production browser caller. |
| 9. Named workflows and browser cutover | done | This is the Roleplay ownership checkpoint. Ten server-owned names carry the reply, continuation, swipe, correction, Story, Guided and Deep Swipe semantics, including a new unselected-swipe effect for Deep Swipe. The browser submits one accepted workflow per migrated control, observes it, cancels on Stop, and adopts the durable write by reloading the chat it does not own; a reopened page reads its permanent receipt back instead of submitting again. The page reports rendered and mention asides as native facts, and the server samples them and chooses at most one recipient through the existing admission, cooldown and occurrence key. Group turns from the browser, `/impersonate` and Story Mode's transforms remain browser-owned by decision and are not stage scope. |
| 10. Remaining manual Conversation | pending | Regeneration, polishing, schedule controls and selfie coordination with native completion writes. |
| 11. Meower | pending | Saved profile/feed/interaction waves using its revisioned native store. |
| 12. Labs | pending | Prompting Lab, Distiller, LoreStitch and World Info Lab compute saved proposals, with separate reviewed, version-checked apply. |
| 13. Remaining application and final audit | pending | Translation, vectors, automation, archive, import, backup, maintenance and every remaining bundled workflow; final ownership verification. |

Accepted work must finish with every page closed. Keep old replies, selected
swipes and unrelated history until replacements are durable. Unknown unqueryable
provider or mutating-tool outcomes remain interrupted, never automatically repeated.
Receipt retention must outlive replayable jobs/artifacts; capacity exhaustion refuses
new work instead of deleting evidence. Busy targets never absorb a different intent.
WebLLM and bundled browser Kokoro remain the only approved page-open providers.
No hidden browser, fake DOM or silent provider substitution establishes portability.

## Historical checkpoint: automatic Conversation ownership

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
  saved results. Roleplay prompt assembly was pending at this historical checkpoint; Stage 5 above records its later completion.

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
