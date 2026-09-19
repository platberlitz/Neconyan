# Server ownership audit

The application is not fully server-owned. Provider requests reaching a server endpoint do not make the surrounding browser workflow independent of an open page.

## Fixed in this audit

- Mewmory automatic extraction and full backfill now run as server jobs. Intent and progress are saved in the existing per-user story archive. Closing the page or changing chats does not cancel them. Startup scans resume interrupted work; explicit cancellation remains available.
- Internal model requests preserve their parent request's resumable behaviour and cancellation signal. Saved Mewmory connection profiles use that shared path rather than maintaining a second cancellation implementation.
- The Conversation send API saves the user's message before contacting the model. Failed requests retain that message. A completed reply merges into the latest store when its original branch is unchanged, preserving unrelated settings and other threads. Concurrent changes to the same branch still produce a conflict instead of overwriting messages. Failed regeneration keeps the previous reply.
- Manual Mewmory recall and complete index rebuilds now use saved jobs and private provider-result files. The real index control has been tested through acceptance, page unload and saved completion before reopening.
- A separate accepted Conversation reply API captures saved context and a named chat profile, then saves reply bubbles and command effects with native completion records. The main composer, the forced-reply action and the branch-from-message action now submit through it; the browser appends no messages of its own and only observes saved results.

## Ownership and remaining work

| Area | Current ownership | Remaining boundary |
| --- | --- | --- |
| Mewmory extraction, interviews and backfill | Server scheduling, model calls, credentials, accepted-source checks, saved progress and restart recovery | An interrupted provider request can run again. Four extraction jobs can run at once; scanning is periodic. |
| Mewmory recall, indexing and prompt preparation | Manual controls submit saved jobs; server retrieval, token counting, memory assembly and full index batching; fresh automatic recall runs independently of the page | Final Roleplay prompt construction remains in the browser. Legacy non-background endpoints remain available during migration. |
| Roleplay replies | Server provider calls and resumable response buffering | Buffers live in process memory. Browser recovery applies the reply to the chat; server restart can lose an unfinished reply. |
| Conversation send API | Server prompt assembly, provider call and thread persistence | The main composer instead submits accepted sends and replies, which save the user message durably before generation; this older resumable endpoint remains available. |
| Accepted Conversation reply API | Saved chat-profile binding, captured prompt context, trigger and reply-target checks, durable user-message acceptance, provider-result recovery and repeat-safe native bubbles, reminders and status effects | Text-completion profiles, image delivery, complete participant behaviour and autonomous scheduling remain unfinished. |
| Conversation interface | Saved state on the server; composer sends, forced replies and branch-from-message replies are accepted and generated server-side, and the browser only observes and reads | The browser's own 30-second auto worker (idle followups, scheduled and proactive messages, reminders) still runs; disabling it is part of the ownership handover, not done in this step. |
| Meower | Native server storage | Feed generation and its surrounding workflow remain browser-owned. |
| Story Mode | Shared backend model requests | Story progression and generation coordination remain browser-owned. |
| Agents | Native server collection storage and backend model requests | Agent execution, transformations and multi-step coordination remain browser-owned. |
| Quick Image Gen and other bundled tools | Mixed native endpoints, shared provider endpoints and browser coordination | These need individual workflow migrations; server model access alone does not establish restart recovery. |
| Imports and translation | Server endpoints perform the requested work | Import progress follows the active response; there is no general durable job history for reconnecting clients. Multi-request translation coordination can still depend on the browser. |

The remaining migrations need server-side workflow entry points and completion writes, with the interface submitting work and displaying saved results. Routing model traffic through the existing backend alone would leave these gaps intact.

WebLLM and bundled browser Kokoro are explicit owner-approved exceptions. Their controls state that the page must stay open; their providers must not be silently replaced.

## Verification

Regression checks cover persisted Mewmory job recovery, chronological backfill, cancellation, duplicate starts, isolated branch jobs, automatic processing with the browser page unloaded, Conversation provider failures, concurrent thread writes and a real HTTP disconnect during a resumable Conversation reply. The browser checks use Chromium at desktop and phone sizes; they do not establish Safari behaviour. Persisted-job recovery is tested by loading interrupted saved intent, not by killing a production server.

Review also found delayed queue draining, manual requests blocked by automatic work and stale restart status. These were corrected. Three suggested shortcuts were rejected: skipping user-ending histories could leave saved messages unprocessed indefinitely; ignoring provider or output-policy changes could reuse incompatible coverage; checking only chat timestamps would miss character, lorebook and settings changes. Periodic source reconciliation and policy-driven reprocessing therefore remain, with timeout-only changes excluded from coverage invalidation.

## Implementation references

```text
src/mewmory/worker.js
src/endpoints/mewmory.js
src/request-cancellation.js
src/endpoints/conversation-generation.js
src/endpoints/neconyan-conversation.js
public/scripts/neconyan-conversation/native-jobs.js
public/scripts/neconyan-conversation/store-sync.js
public/scripts/mewmory/index.js
tests/mewmory.node.js
tests/mewmory-selection.test.js
tests/mewmory.e2e.js
tests/request-cancellation.test.js
tests/neconyan-conversation-api.test.js
```
