# Notes: technical reference

This is the engineering companion to `docs/notebooks.md`. It describes how Notes stores data, decides permissions, recovers from failures and connects to World Info, the assistant and roleplay prompts.

## Modules

| Area | Server | Browser |
| --- | --- | --- |
| Paths, ids, errors | `src/notebooks/paths.js` | |
| Markdown parsing (frontmatter, headings, sections, links, chunks) | `src/notebooks/markdown.js` | `public/scripts/notebooks/render.js` (display only) |
| Index, link resolution, backlinks, search | `src/notebooks/note-index.js` | |
| Storage, revisions, history, trash, operations | `src/notebooks/store.js` | `drafts.js` (device drafts) |
| Permissions | `src/notebooks/permissions.js` | |
| Lore bindings and entry pages | `src/notebooks/lore.js` | `notes-panels.js` (Lore tab) |
| Attachments | `src/notebooks/attachments.js` | `notes-dialogs.js` |
| Import and export | `src/notebooks/transfer.js` | `notes-dialogs.js` |
| Assistant tools, grants, proposals | `src/notebooks/assistant.js` | `assistant-note-tools.js` (shared contract), `neconyan-assistant-tools.js` |
| Roleplay context | `src/notebooks/context.js`, hook in `src/generation/roleplay-execution.js` | AI access tab preview |
| Change events | `src/notebooks/events.js` | `api.js` (`subscribeNotes`) |
| HTTP API | `src/endpoints/notebooks.js`, mounted at `/api/notebooks` | `api.js` |
| Workspace UI | | `notes-app.js`, `notes-panels.js`, `notes-dialogs.js`, `dom.js`, `templates.js`, `line-diff.js`, `public/css/neconyan-notes.css` |

All Notes browser code and its stylesheet are loaded on demand when Notes opens, so they do not count towards the blocking frontend budgets.

## Data layout

Everything lives inside the account's own data folder (`directories.root`):

```text
<account>/
  notebooks/<notebookId>/              portable content: .md notes, folders, attachments/
  notebook-control/<notebookId>/
    manifest.json                      schema, name, origin, structureRevision, notes{id: path, hash, dates, favourite},
                                       associations, attachments (display names)
    policies.json                      assistant level, publish switch, requested edits, admitted, per-note overrides
    lore-bindings.json                 bindings {id: binding}, detached list, revision
    provenance.json                    last 50 source records per note (chat captures and similar)
    trash.json                         trashed notes with their last content hash
    attachment-trash.json + attachment-trash/
    history/<noteId>.json              revision list (newest last)
    history/<noteId>/<sha256>.md       content-addressed copies
  notebook-control/_operations.json    operation journal (account-wide)
  notebook-control/_grants.json        one-off assistant grants
  notebook-control/_proposals.json     assistant proposals made from the browser
  notebook-control/_context-log.json   which note revisions roleplay prompts used (no text)
```

The content folder holds only what a person wrote. Permissions, bindings, history and journals live outside it, so exporting, syncing or editing the content folder can never grant access or publish lore. Nothing under `notebooks/` or `notebook-control/` is served as static files; attachments are only reachable through the authenticated `GET /api/notebooks/attachments/file` route.

Ids are `nb_` and `n_` followed by 16 hex characters. A note's id is stored in the manifest, not in the file, so renaming or moving a note keeps its identity. A `neconyan_id` frontmatter field is treated only as a hint: it is honoured when adopting an unknown file only if that id is not live, not in the trash and not already used, otherwise the file gets a fresh id.

## Writes, revisions and concurrency

- Every write goes through the protected account store: `withRoleplayAccount` takes the account lock (synchronous only), and `writeAuthoringFileLocked` stages a temporary file, checks the expected evidence, renames it into place and syncs the folder.
- A note's revision is the SHA-256 of its exact bytes. Callers send `expectedRevision`; a mismatch returns `409 NOTE_CONFLICT` with `currentRevision`, never a silent overwrite. Policies, bindings and the notebook structure have their own revisions.
- Notes are saved byte for byte. Saving without changes is `no_change`. Section edits, appends and property changes touch only their region; the frontmatter editor uses the YAML document API so comments, unknown keys and nested values survive. Windows line endings are kept when a file uses them consistently.
- Operation ids (`[A-Za-z0-9:_.-]{8,160}`) make every mutation idempotent. The journal records the argument hash: a repeat with the same arguments returns the first result with `replayed: true`; a repeat with different arguments returns `409 OPERATION_REUSED`. Ids that create things (new notes, imported notebooks) are derived from the operation id, so a retried create cannot make a second note. The journal keeps 2000 entries or 30 days; pending entries are never pruned.
- Multi-step changes write a pending journal entry first. When a notebook is next loaded, pending writes are finished if the file already holds the new bytes, or dropped if it still holds the old ones. Lore publishing records a pending marker on the binding before touching the lorebook and finishes it on the next read, so a crash between the lorebook write and the binding update is recovered rather than reported as in sync.

## History and trash

- Before any in-app change the previous bytes are kept as a history copy. Ordinary autosaves by the same person within 10 minutes are merged into one entry. Each note keeps up to 100 entries (the first is always kept). A copy is only removed when no history entry, trash record or lore binding still refers to it.
- Restoring an old version is a new change against the current revision. If the note changed meanwhile the server refuses and suggests restoring as a copy.
- Trash keeps the last content. Restore reuses the original id when it is free. Permanent deletion needs the explicit confirmation value `delete-permanently` and removes history only if nothing else refers to the note.

## External writers

Neconyan rescans the content folder (at most every 1.5 seconds while in use, keyed by file size, time and inode) and reconciles what it finds:

- a changed file gets a history entry with origin `external`;
- an unknown file is adopted (keeping its id hint if safe) with a history copy;
- a file that moved keeps its id when its content hash matches a missing note;
- a missing file goes to the trash with origin `external`, using the last known copy.

Limitation: Neconyan's lock does not bind other programs. If Obsidian or a sync tool writes the same file in the instant between Neconyan's final check and its rename, one of the two writes can win without a conflict being raised. The next rescan records whatever ended up on disk, and history keeps the earlier version, but lost-update prevention is only guaranteed between writers that go through Neconyan. Sync tools are not set up by Neconyan; there is no shared-folder or Obsidian Headless adapter in this release.

## Permissions

Evaluated on the server in `permissions.js` for every request:

- Assistant access per notebook: `none` (default), `read`, `edit`, with per-note overrides (`inherit`, `none`, `read`, `edit`). An imported notebook starts with `admitted: false`, which forces everything to none until the owner allows it.
- Lore publishing by the assistant needs a separate `assistantPublish` switch and still always goes through review.
- Requested-edit mode (`requestedEdits`) lets proposals for create, append and edit skip review until it expires (default 8 hours, at most 24). Publishing is never direct.
- One-off grants (`_grants.json`, 30 minutes by default, at most 2 hours) cover one selection, one note or one destination folder. A selection grant exposes only that text and allows only replacing that exact text.
- Notes the assistant cannot read are filtered before listing, searching, backlinks and link resolution, and a hidden note looks the same as a missing one (404).
- Policy changes are owner-only HTTP routes; there is no assistant tool for them. Model arguments such as `userConfirmed` and any text inside notes are ignored for permission decisions.
- Revoking access stops future reads and makes waiting proposals stale (the proposal stores the policy revision). It cannot recall text already sent to a model provider. Files are plain text at rest; 'not shared with AI' is not encryption.

## Assistant tools

The shared contract is `public/scripts/notebooks/assistant-note-tools.js`. Both the browser tool registry and the native tool definitions are built from it, and a Jest test checks they are identical.

| Tool | Kind | Effect |
| --- | --- | --- |
| ListNotebooks, SearchNotes, ReadNote, ListNoteLinks | read | Permission-filtered results; reads are capped at 24 000 characters with `partial`, `offset` and `nextOffset`, or a single section with its `textHash`. |
| PreviewLorePublication | read | Needs the publish switch. |
| CreateNote, AppendToNote, EditNoteSection, EditNoteSelection, UpdateNoteProperties | mutation | Produce a proposal tied to the note revision and policy revision. |
| PublishNoteToLore | mutation | Always reviewed. |

Mutating tools are listed explicitly (`assistantToolMutates` in `src/generation/assistant-tool-data.js`) instead of relying on name prefixes.

Paths:

- Browser chats: the tool posts `{callId, tool, args}` to `/api/notebooks/assistant/tool`. The server stores the proposal in `_proposals.json` (id derived from the call id and arguments, so retries map to the same proposal) and answers `needs_approval` with 'Not saved yet'. The page shows a review popup; the decision goes to `/assistant/decide` with the proposal hash. Proposals can also be reviewed later under Notes > Assistant changes.
- Native (server-run) jobs: `captureAssistantToolSourceLocked` calls `captureNoteToolLocked`; the job stores a slimmed proposal plus a capped diff, asks for approval through `requireJobApproval` (kind `neconyan-note-proposal`), and applies it inside the job receipt with operation id `native:<hash of job and call>`. A closed tab leaves the job waiting; a restart finishes the same operation or reports a conflict.
- Applying a proposal rechecks the policy revision, the access level or grant, and the note revision. Any mismatch returns a structured `conflict`, `denied` or `not_found` result with 'Nothing was saved'.

## Lore bindings

A binding links one note region to one lorebook entry: `{id, noteId, selector, book, uid, policy, liveOrigins, published{sourceHash, targetHash, sourceText, targetText, noteRevision, at}, pending, lastError, history}`.

- Selectors are `{kind: 'note'}`, `{kind: 'heading', path: [...]}` or `{kind: 'block', id}`. A missing or duplicated heading marks the binding as needing repair; there is no fallback to the whole note or a neighbouring section. A section that gains new child headings is reported as broadened.
- Status is derived, not stored: `unpublished`, `in_sync`, `draft_changed`, `lore_changed`, `conflict`, `source_missing`, `selector_unresolved`, `target_missing`, `failed`.
- Publishing changes only the entry `content` (and `comment` for new entries); every other World Info field is kept. New entries start from the standard entry template. `syncLorebookOriginalEntry` keeps the original-data mirror in step, the World Info history file gets a commit, and the write uses the lorebook's evidence so concurrent edits are refused.
- Only one binding may target a given entry. Renamed or deleted lorebooks show as target missing; bindings are never re-pointed automatically.
- Live updates are per binding, run only for `draft_changed`, and only for origins listed in `liveOrigins` (the UI offers `user` only). Assistant, import, external and lore-pull edits always wait for review.
- Entry pages read and write the live entry directly (`/lore/page/read`, `/lore/page/save`) with an entry hash check. 'Make a note copy' creates an ordinary, unbound note.
- After a publish or page save the browser clears its World Info cache for that book and reloads the editor. A World Info editor already open in another tab keeps its old copy until it reloads. World Info saves that send a known revision are refused if the book changed; saves that do not send one can overwrite a publish made meanwhile (existing World Info behaviour, not changed here). The binding then shows 'lore changed'.

## Roleplay context

- Per-note context policy: `off` (default), `reference` or `pinned`, each with scopes (`chat` `<avatar>:<chat>` or `group:<chat>`, `character` avatar, `lorebook` name, `global`).
- `prepareRoleplayNoteContext` runs inside the native roleplay job before the prompt identity is computed. It collects matching notes, removes regions that are bound to lore (those reach the model only through World Info), withholds a note whose binding cannot be resolved, adds pinned notes whole in their chosen order (never truncated; anything that does not fit is reported as overflow), then adds up to 8 keyword-matched reference chunks within the budget. The budget is 15% of the free context, capped at 2000 tokens, with tokens estimated as characters / 4.
- The result is saved as the job artifact `roleplay-note-context` and reused on resume, so a retried job sees the same note revisions. The prompt slot is `neconyan_notes`, a system prompt with a header saying the notes are drafts and data, not established events or character knowledge.
- `_context-log.json` records which note revisions and token counts each job used, without text. The AI access tab shows a preview and these records.
- Mewmory is not fed from notes. Published lore reaches Mewmory through its existing lorebook source, unchanged.

## Attachments

Allowed types are images (PNG, JPEG, GIF, WebP, AVIF, BMP, checked by magic bytes), PDF, text, CSV, JSON, Canvas, audio and video, up to 20 MiB. SVG and every non-image type are served only as downloads. Responses carry `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store` and same-origin resource policy. Removing an attachment that a note still links is refused; removed files go to an attachment trash.

## Import and export

- Export is a ZIP of the content folder only (notes and known attachment types). No policies, history, bindings, provenance or chat locators are included. It opens as an Obsidian vault.
- Import parses the ZIP directory itself and rejects the whole archive for traversal, absolute or drive paths, backslashes, NUL bytes, symlinks, encryption, ZIP64, duplicate names, more than 5000 entries, more than 256 MiB declared, suspicious compression ratios or entries that inflate beyond their declared size. Hidden folders such as `.obsidian`, nested archives, unknown types and non-UTF-8 notes are excluded and listed. Name collisions are renamed and listed.
- Staged imports are held in memory for 30 minutes. Committing creates a new notebook with origin `import` and inactive permissions. 'Compare with this notebook' updates chosen notes with revision checks.
- Portable export is not a backup. A full recovery backup must include both `notebooks/` and `notebook-control/` (the account data folder as a whole).

## Change events

`GET /api/notebooks/events` is a server-sent event stream filtered to the signed-in account. Events carry only ids, revision, kind and operation id, never note text.

## Migrations and upgrades

- `manifest.json`, `policies.json`, `lore-bindings.json` and the account-level journals carry `schema: 1`. A newer schema is refused with `NOTEBOOK_SCHEMA_UNSUPPORTED` instead of being rewritten.
- Notes need no migration of existing data: the folders are created on first use and nothing outside them is touched, except lorebook files when the owner publishes.
- The default notebook is created lazily the first time Notes is opened.

## Diagnostics

`/api/notebooks/diagnostics` reports note and attachment counts, skipped files, unresolved bindings and failed or waiting proposals. `/api/notebooks/reindex` drops the in-memory index and rescans; the index holds no data that cannot be rebuilt.

## Measured behaviour

Measured on this Oracle ARM VM with a disposable account:

- A notebook of 3001 notes (one of them 248 KB with 4000 sections): an unchanged rescan took 592 ms, a search took 12 ms, and appending to the long note took 785 ms.
- The first scan after dropping 3000 unknown files into the folder took 57.9 s, about 19 ms per file, because each adopted file gets a durable history copy while the account lock is held. Imports write the same history copies, so a very large import (thousands of notes) holds the account lock for a comparable time and chat saves wait meanwhile. Normal notebooks of tens or hundreds of notes take a few seconds at most.

## Known limitations

- The editor is a Markdown source editor with a toolbar and a separate reading view. There is no live formatted editing and no heading folding.
- Embeds (`![[Note]]`) are kept and shown as chips; transcluded content is not rendered.
- Device drafts live in the browser's local storage and can be lost if the browser clears it before they reach the server.
- Import stages are kept in memory; a server restart discards them and the file has to be chosen again. A crash during an import commit leaves a partly filled notebook, which the next scan adopts.
- Lost-update protection does not cover programs that write the content folder directly (see External writers).
- Deferred: graph view, canvas, property tables, daily-note automation, real-time collaboration, offline sync, Obsidian plugins or themes, and shared-folder or Obsidian Headless sync.

## Requirement checklist

| Spec section | Where | Tests |
| --- | --- | --- |
| 4-6 Notes workspace, editor, statuses, templates | `notes-app.js`, `notes-dialogs.js`, `templates.js`, `render.js`, `drafts.js` | browser checks at 1280x900 and 393x852 |
| 7 Links, backlinks, search, rename | `markdown.js`, `note-index.js`, `store.js` | `notebooks-store.node.js` |
| 8-9 Storage, identity, revisions, history, trash, external changes | `store.js`, `paths.js` | `notebooks-store.node.js` |
| 10 API, statuses, operation ids, events | `src/endpoints/notebooks.js`, `events.js` | `notebooks-endpoint.node.js` |
| 11 Permissions | `permissions.js`, `assistant.js` | `notebooks-assistant.node.js`, `notebooks-native.node.js` |
| 12 Assistant tools, review, requested edits, durable jobs | `assistant.js`, `assistant-tool-*.js`, `native-tool-definitions.js`, `neconyan-assistant-tools.js` | `notebooks-assistant.node.js`, `notebooks-native.node.js`, `neconyan-assistant-tools.test.js`, `neconyan-assistant-job-review.test.js` |
| 13-14 Lore association, publication, entry pages, state machine | `lore.js`, `notes-panels.js` | `notebooks-lore.node.js`, browser publish check |
| 15 Context and Mewmory | `context.js`, `roleplay-execution.js` | `notebooks-context.node.js`, existing roleplay suites |
| 16 Chat capture | `welcome-screen.js`, `/notes/capture` | `notebooks-endpoint.node.js` (API) |
| 17 Attachments | `attachments.js` | `notebooks-transfer.node.js`, `notebooks-endpoint.node.js` |
| 18-19 Import, export, Obsidian | `transfer.js` | `notebooks-transfer.node.js`, `notebooks-endpoint.node.js` |
| 21 Performance, budgets | lazy loading, incremental scan cache | budgets script, measurement above |
