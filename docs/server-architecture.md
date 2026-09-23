# Server ownership audit

The application is not fully server-owned. Provider requests reaching a server endpoint do not make the surrounding browser workflow independent of an open page.

## Current migration checkpoint

- Last reviewed checkpoint commit: `9fddf069004d7a349dd95f255af40a819a9e3395`. Single-file protected chat imports join the committed storage and group-update foundations. Stage 2 remains incomplete.
- Completed: one recorded operation owns every converted history, required memory and final group links. Frozen inputs/output plans, exact recovery and closed-only cleanup preserve accepted work and later edits/deletion. Chooser/Restore retries survive reopening; proven refusal and uncertainty stay distinct; stale acknowledgements and history views retain the correct owner.
- Review: bounded independent re-review accepted all corrections; no known checkpoint-local finding remains.
- Exact final gates: 338 Jest suites (4,502 passed/two skipped/one snapshot), 664 Node tests, root lint/budgets/whitespace, six-file JavaScript test lint (zero errors/120 warnings), and 22 serial desktop/touch storage/import Chromium cases. The unfinished accepted-import case closes every page before actual process death and reconciles before reopening. Provider calls were zero. Safari/WebKit is unverified.
- Unfinished: folder/ZIP and other import/entity/account lifecycles, every recovering reader and auxiliary writer, private typed-effect admission and stable aside guards. Complete combined Conversation/storage/import verification and a whole-stage audit remain required before Stage 2 completion.
- Next action: paused for the owner's requested handover after the local checkpoint. Resume the remaining scope in a new session. Do not push or deploy or begin another checkpoint here.

First-edit read authority does not make group creation a recorded lifecycle. Legacy refusal does not implement reset or account reincarnation. The complete current record and the stage-end review policy (session model implements; one independent review per completed stage) are in `server-migration-handover.md`.

## Fixed in this audit

- Mewmory automatic extraction and full backfill now run as server jobs. Intent and progress are saved in the existing per-user story archive. Closing the page or changing chats does not cancel them. Startup scans resume interrupted work; explicit cancellation remains available.
- Internal model requests preserve their parent request's resumable behaviour and cancellation signal. Saved Mewmory connection profiles use that shared path rather than maintaining a second cancellation implementation.
- The Conversation send API saves the user's message before contacting the model. Failed requests retain that message. A completed reply merges into the latest store when its original branch is unchanged, preserving unrelated settings and other threads. Concurrent changes to the same branch still produce a conflict instead of overwriting messages. Failed regeneration keeps the previous reply.
- Manual Mewmory recall and complete index rebuilds now use saved jobs and private provider-result files. The real index control has been tested through acceptance, page unload and saved completion before reopening.
- A separate accepted Conversation reply API captures saved context and named chat or text-completion profiles, then saves reply bubbles and command effects with native completion records. Participant bindings are saved before acceptance and reused after batching. The main composer, the forced-reply action and the branch-from-message action now submit through it; the browser appends no messages of its own and only observes saved results.

## Ownership and remaining work

| Area | Current ownership | Remaining boundary |
| --- | --- | --- |
| Mewmory extraction, interviews and backfill | Server scheduling, model calls, credentials, accepted-source checks, saved progress and restart recovery | An interrupted provider request can run again. Four extraction jobs can run at once; scanning is periodic. |
| Mewmory recall, indexing and prompt preparation | Manual controls submit saved jobs; server retrieval, token counting, memory assembly and full index batching; fresh automatic recall runs independently of the page | Final Roleplay prompt construction remains in the browser. Legacy non-background endpoints remain available during migration. |
| Roleplay replies | Server provider calls and resumable response buffering | Buffers live in process memory. Browser recovery applies the reply to the chat; server restart can lose an unfinished reply. |
| Protected Roleplay storage | Account/file identities, bounded keyed receipts, exact chat/existing-group publication and composite single-file import recovery, branch memory, protected browser authority and bounded legacy-maintenance handling | Folder/ZIP and other imports, group creation/deletion, character/account and other lifecycles, complete recovering-reader/auxiliary-writer coverage, private typed effects, accepted Roleplay workflows and browser generation cutover remain unfinished. |
| Conversation send API | Server prompt assembly, provider call and thread persistence | The main composer instead submits accepted sends and replies, which save the user message durably before generation; this older resumable endpoint remains available. |
| Accepted Conversation reply API | Named chat/text profiles and acknowledged saved-active bindings, validation before uploads/acceptance, captured prompt context, source checks, durable user messages, provider-result recovery and repeat-safe native bubbles, reminders, status effects and supported image delivery | Send-triggered chimes, presentation/narration and automatic ownership are implemented. Other manual completion writes remain unfinished. |
| Native Conversation presentation and narration | Incoming unread/pending records saved with completion receipts; atomic owner-scoped claims and observed read boundaries; migrated legacy unread state; server speech synthesis and saved audio for OpenAI, OpenAI Compatible, ElevenLabs and Pollinations | The browser presents claimed results and plays audio only while eligible. Kokoro needs the page open. |
| Manual Conversation text helpers | Server-bound requests retain account, connection and source identity; failed profiles cannot select another connection. Memory refresh, overwrite and clear have native completion writes and conflict checks. | Regeneration, polishing, manual schedule controls and selfie coordination still apply completion writes in the browser. Native schedule jobs exist but the control remains to migrate. |
| Conversation interface and automatic work | Saved server ownership/timezone and acknowledged background settings; server-only automatic sender; no browser automatic timers; visible discovery every 20 seconds presents saved results | Loading the updated app configures ownership for existing Conversation users without requiring a panel visit. Roleplay rendered-message sampling still originates in the page. Old generic provider calls cannot be attributed, but stale automatic completion writes are refused. |
| Meower | Native server storage | Feed generation and its surrounding workflow remain browser-owned. |
| Story Mode | Shared backend model requests | Story progression and generation coordination remain browser-owned. |
| Agents | Native server collection storage and backend model requests | Agent execution, transformations and multi-step coordination remain browser-owned. |
| Quick Image Gen and other bundled tools | Mixed native endpoints, shared provider endpoints and browser coordination | These need individual workflow migrations; server model access alone does not establish restart recovery. |
| Imports and translation | Single-file chat imports have recorded server publication, memory/group completion and durable replay; other existing endpoints perform their requested work | Folder/ZIP and other import lifecycles remain to migrate. There is no general durable import job history for reconnecting clients. Multi-request translation coordination can still depend on the browser. |

The remaining migrations need server-side workflow entry points and completion writes, with the interface submitting work and displaying saved results. Routing model traffic through the existing backend alone would leave these gaps intact.

WebLLM and bundled browser Kokoro are explicit owner-approved exceptions. Their controls state that the page must stay open; their providers must not be silently replaced.

## Verification

The historical committed Stage 1 storage preparation checkpoint passed all 335 Jest suites (4,413 passed,
two skipped; 4,415 total), one snapshot, all 294 Node tests, root lint, budgets and
whitespace checks. Changed-test lint covered four files: zero errors, 14 warnings.
All 149 disposable Chromium cases passed in a complete serial run (1.3 hours):
the 145 Conversation cases and four new solo/group storage cases at 1280x900 and
touch 393x852. The new cases use edit/branch controls, native storage mutation with
zero pages, a real serving-process restart and reopening, with zero model calls.
They do not verify native Roleplay generation. The first run passed 148/149 due to
a Conversation edit setup's settings-version conflict; the unchanged case passed
alone, then the entire second run passed. Safari remains unverified.

Fresh planner and reviewer execution was verified as pura-openai/gpt-6-astra,
variant max through actual assistant-message metadata. Review findings were fixed
and re-reviewed: write/lock cleanup cannot lose committed or uncertain outcomes,
unsafe paths are refused before recovery side effects, and exact backup bytes retain
the opening UTF-8 marker. Native no-ops retain file identity, metadata-only changes
are not silently dropped, and raw source checks remain mandatory independently of
legacy integrity settings. Later workflow callers must reconcile uncertain writes
before repeating any mutation or external effect; this helper supplies no receipt
or provider-retry policy by itself.

The automatic-ownership checkpoint passed all 335 Jest suites (4,409 passed, two skipped; 4,411 total), one snapshot, all 267 Node tests, root lint, budgets and whitespace checks. Changed-test lint had zero errors and 45 warnings. All 145 disposable Conversation Chromium cases passed in one complete serial run (1.3 hours), including eight new ownership cases at desktop 1280x900 and touch 393x852. The first run passed 144/145 because an old test expected creation of a duplicate chime job; durable ownership now refuses before acceptance. The replacement checks no duplicate over two scan intervals and a later reminder firing after restart, then passed alone and in the full rerun. The earlier focused 21-case run is separate.

Actual browser checks establish saved-active capture followed by zero-page reminders, explicit-only failed-reminder retry, native memory refresh with the page closed, live panel updates, clear-versus-pending-result protection and old automatic append refusal. Node checks establish boot migration before job pruning, failed-migration pruning holds, old identity backfill, attachment-only automatic summary batches, disabled-work refusal and exact memory/source checks. Independent reviewers' actual assistant metadata was verified as pura-openai/gpt-6-astra, variant max; all stage-local findings were fixed and re-reviewed. The full migration remains unfinished and Safari is unverified.

Accepted automatic occurrences live in protected account settings independently of the bounded jobs history. Startup preserves old reminder/chime/summary ownership before any plugin or listener can prune its evidence; an unsuccessful migration holds that account's pruning. Markers are not evicted: storage exhaustion refuses new acceptance. Summary ownership includes persona and both scan-time and frozen history identities. Completed memory writes compare the captured four-field fingerprint; unprovable legacy summary jobs remain interrupted. Saved ownership and read boundaries survive imports/reset, and exact copied automatic history remains branchable.

Historical results follow.

The unread/presentation/narration checkpoint passed all 335 Jest suites (4,395 tests passed, two skipped; 4,397 total), one snapshot, all 257 Node tests, root lint, frontend budgets and whitespace checks. Changed-test lint had zero errors and 43 warnings. All 137 disposable Conversation cases passed in one full serial Chromium run (1.2 hours), including 21 new presentation cases at desktop 1280x900 and touch 393x852. The first run passed 136/137; the known legacy merge fixture was stabilised with a bounded quiet-version setup, passed five focused repetitions, then passed in the complete run. Hidden-page state is controlled in Chromium; Safari is unverified.

Those checks exercise two-tab claim ownership, actual saved-audio playback, zero-page completion, unread/read-only retry, Stop across claims/downloads, thread and message changes, idle no-save behaviour, refused provider HTML and a real crash during uncertain speech synthesis. Independent review verified actual reviewer assistant-message metadata as pura-openai/gpt-6-astra, variant max, and found no remaining stage-local problems after fixes. Automatic ownership was still pending at that checkpoint.

Presentation claims synchronously read and write the settings file with a version comparison in one serving process. They include branch creation identity and a monotonic observed message boundary rather than a blind unread reset. Server-owned presentation metadata survives stale saves; edits and deletions invalidate pending speech, and playback rereads the live source after claiming. Unknown speech outcomes remain interrupted, completed artifacts are reused, and damaged artifacts fail closed. Audio retrieval checks account ownership and audio content type. Discovery is browser observation, not an automatic-generation worker.

Historical results: the chime checkpoint passed 334 unit suites (4,341 tests, two skipped; 4,343 total), 233 Node tests, root lint, frontend budgets and whitespace checks. The full 116-case disposable Conversation Chromium suite passed in one serial run (57.8 minutes), including the 12 added chime cases at desktop and touch sizes. At the active-binding checkpoint the full browser run passed all 95 then-current durable cases and two scoped-formatting cases. Two acknowledgement tests passed after their queued-save fixture race was corrected; nine added durable cases passed separately. That checkpoint covered 104 durable plus four formatting/acknowledgement cases, not a single green 108-case run. Those checks exercise saved-active controls at both sizes, refusal before upload/acceptance, exact retry through rate limiting, manual source/speaker races, character-script identity and inline-image source hashes without native Web Crypto.

The following verification record describes the earlier integrity checkpoint.

Regression checks cover persisted Mewmory recovery, chronological backfill, cancellation, duplicate starts and isolated branches. The disposable Conversation suite additionally verifies real composer/forced/branch controls, zero-page completion, saved effects, reopening, cancellation at three boundaries, source conflicts and account isolation. Its restart cases kill the actual disposable serving process, including an unresolved text request that must not repeat automatically. The 52-case run passed 51 cases; the remaining lost-save-response case passed after its test interception was corrected. Added coverage includes retention, migration races, legacy merging and settings replacement. Chromium desktop and touch-phone checks do not establish Safari behaviour; unresolved image-request recovery remains unverified.

Conversation store ownership binds to the authenticated owner returned with the initial settings response. Captured account assertions travel through native submissions, uploads, preliminary aside chat saves and job observation. Server routes reject an assertion that differs from the current authenticated account before writing. Existing clients may omit the assertion for compatibility, so these checks do not retroactively protect already-open older pages. General settings saves omit Conversation data. Its separate comparison baseline captures downloaded content and its exact version before migration; unrelated saves cannot advance that pair.

Conversation branches carry server-derived message fingerprints and edit counters. Trusted append retention preserves the counter, while edits, deletion, replacement and guarded settings restoration invalidate captured work. New work establishes this checkpoint for legacy history before capture; older unprovable captures retain conservative hash checks. Imports and reset preserve increasing settings versions. Batch members retain their own creation identity, anchors and complete intent fingerprint. Ambiguous identifier-less merges refuse saving and preserve local content.

Review also found delayed queue draining, manual requests blocked by automatic work and stale restart status. These were corrected. Three suggested shortcuts were rejected: skipping user-ending histories could leave saved messages unprocessed indefinitely; ignoring provider or output-policy changes could reuse incompatible coverage; checking only chat timestamps would miss character, lorebook and settings changes. Periodic source reconciliation and policy-driven reprocessing therefore remain, with timeout-only changes excluded from coverage invalidation.

## Implementation references

```text
src/mewmory/worker.js
src/endpoints/mewmory.js
src/request-cancellation.js
src/endpoints/conversation-generation.js
src/endpoints/neconyan-conversation.js
src/endpoints/chats.js (mutateChat)
tests/chat-mutation.node.js
tests/chat-save-interprocess-lock.test.js
tests/chat-recovery-endpoints.test.js
tests/neconyan-roleplay-storage.e2e.js
tests/neconyan-roleplay-import-retry.e2e.js
tests/roleplay-import.node.js
public/scripts/neconyan-conversation/native-jobs.js
public/scripts/neconyan-conversation/store-sync.js
public/scripts/jobs.js
public/scripts/neconyan-conversation/partners-utils.js
src/generation/conversation-participants.js
src/generation/conversation-worker.js
public/scripts/mewmory/index.js
tests/mewmory.node.js
tests/mewmory-selection.test.js
tests/mewmory.e2e.js
tests/request-cancellation.test.js
tests/neconyan-conversation-api.test.js
```
