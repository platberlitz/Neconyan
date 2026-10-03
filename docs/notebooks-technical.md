# Notes: technical reference

This is the engineering companion to `docs/notebooks.md`. It describes how Notes stores data, decides permissions, recovers from failures and connects to World Info, the assistant and roleplay prompts.

## Modules

| Area | Server | Browser |
| --- | --- | --- |
| Paths, ids, errors | `src/notebooks/paths.js` | |
| Markdown parsing (frontmatter, headings, sections, links, chunks) | `src/notebooks/markdown.js` | `render.js`, shared presentation boundaries in `folding.js` |
| Source editor and heading folds | | self-hosted `public/notes-editor.js`, `folding.js`, Read section wrappers in `render.js` |
| Index, link resolution, backlinks, search | `src/notebooks/note-index.js` | |
| Read-only embedded-note previews | `src/notebooks/embeds.js`, permission-filtered resolver in `note-index.js` | `render.js`, guarded Read requests in `notes-app.js` |
| Notebook graph | `src/notebooks/graph.js`, permission-filtered resolver in `note-index.js` | separately loaded `graph.js`, notebook workspace in `notes-app.js` |
| Property table | `src/notebooks/property-table.js`, ordinary property writes in `markdown.js` and `store.js` | separately loaded `property-table.js`, typed values in `property-values.js`, cell review in `notes-dialogs.js` |
| Planning canvas | `canvas-store.js`, permission-filtered `canvas-projection.js`, shared JSON Canvas codec in `public/scripts/notebooks/canvas-format.js` | separately loaded `canvas.js`, native `canvas-dialogs.js`, account-scoped `canvas-drafts.js` |
| Storage, revisions, history, trash, operations | `src/notebooks/store.js` | `drafts.js` (device drafts) |
| Permissions | `src/notebooks/permissions.js` | |
| Lore bindings and entry pages | `src/notebooks/lore.js` | `notes-panels.js` (Lore tab) |
| Attachments | `src/notebooks/attachments.js` | `notes-dialogs.js` |
| Import and export | `src/notebooks/transfer.js` | `notes-dialogs.js` |
| Optional Obsidian Headless adapter | `obsidian.js`, owned `obsidian-client-runner.js`, `obsidian-history.js`, read-only snapshot worker | separately loaded `obsidian-dialogs.js`, guarded opening in `notes-dialogs.js` |
| Assistant tools, grants, proposals | `src/notebooks/assistant.js` | `assistant-note-tools.js` (shared contract), `neconyan-assistant-tools.js` |
| Roleplay context | `src/notebooks/context.js`, hook in `src/generation/roleplay-execution.js` | AI access tab preview |
| Change events | `src/notebooks/events.js` | `api.js` (`subscribeNotes`) |
| HTTP API | `src/endpoints/notebooks.js`, mounted at `/api/notebooks` | `api.js` |
| Workspace UI | | `notes-app.js`, `notes-panels.js`, `notes-dialogs.js`, `dom.js`, `templates.js`, `line-diff.js`, `public/css/neconyan-notes.css` |

All Notes browser code and its stylesheet are loaded on demand when Notes opens, so they do not count towards the blocking frontend budgets.

The source editor uses a separately compiled CodeMirror 6 bundle, not the startup `lib.js` bundle or a CDN. The server compiles and caches the trusted editor entry on its first request; the production frontend build also writes a compiled stable alias and a byte-identical hashed asset. Both ship the accompanying MIT notices. The two compilation caches are isolated, and pruning recognises only generated version directories.

Source folds use state effects with no document or selection changes and are excluded from undo history. Source and Read use the same UTF-16 heading boundaries, including nested ATX and Setext headings; properties and fenced code are excluded. The parser keeps exact source offsets for BOM and CRLF files. Read groups already-sanitised content into section wrappers and changes only their visibility. If raw HTML headings cannot be matched reliably to the parsed Markdown, Read does not assign potentially incorrect folds.

Fold choices are UI preferences keyed by account, notebook and note, bounded to 50 notes and 5000 heading keys per note; malformed choices are ignored. They are not Markdown, note revisions, history or sharing policies. Switching Write/Read/Outline with the same document does not rebuild the source editor or discard its undo history. Focusing or beginning input reveals any fold containing the existing selection before browser input maps its position; neither the caret nor the text is moved. Composition keys bypass autocomplete and save shortcuts, folding and note navigation wait for composition to finish, and autosave never commits partial composed text. Browser verification uses Chromium's composition path, not a native iOS keyboard.

Notebook choices carry a monotonic selection version. Notebook-list notifications refresh the current choice, not the choice captured when the request started; older explicit loads cannot undo a later click. Only the newest completed notebook-list snapshot is applied. Tree and note-list replies are checked against both their notebook and request version, and search replies against their notebook and query, before updating the page.

Note opens also carry a monotonic request version. Saves, server-version reads and recovery copies capture the note object, account, notebook and selection/request versions before waiting, so a later click takes precedence even while its read is pending. Reloads and copy actions additionally check the text and revision; late replies cannot replace later typing or clear another note's device draft. An explicit server-version choice clears the original device draft only after a successful, still-current read. A copied draft is cleared only if it still matches the saved copy, and opening that copy must succeed first when requested.

An unresolved server conflict has a separate `saveConflict` flag, not just a display status. Its notice cannot be dismissed and replaces the earlier remote-change notice. Further typing, including returning to the old opened text, stays a device draft and cannot restart autosave. Only an explicit resolution or loading another note releases that block. Device-draft notices remain dismissible because the copy is retained and offered again on reopening. None of these browser actions changes assistant or roleplay permissions.

## Notebook graph

The graph is a read-only projection of saved note links. Its builder requires an explicit visibility predicate and applies it before exposing titles, counts, paths, tags, ambiguity or edges. Folder and hierarchical-tag display filters are applied afterwards; link resolution still uses the full visible notebook, so narrowing the display cannot turn an ambiguous target into a guessed match. Only resolved, displayed endpoints are connected. Repeated links share an undirected edge with a reference count and an embedded-link flag; self-links, external URLs, attachments, missing targets and ambiguous targets are excluded.

The owner-only `/api/notebooks/graph` route uses the authenticated account and the normal notebook preparation path. It exposes at most 300 notes, 1200 edges and 12,000 inspected links, with a 512 KiB response bound. A smaller requested node limit is honoured, and truncation is reported. No body text or note revision is returned. Opening or filtering a graph changes neither note bytes, history nor permissions, and the graph is not an assistant tool or roleplay-context source.

The browser imports the graph module only when Graph is opened. It uses native SVG and Notes controls, with no additional graph dependency. Diagram framing follows the displayed notes rather than shrinking a small notebook into a large empty canvas. The diagram is not a small touch target: an always-available, labelled note list provides keyboard and touch navigation, and phones default to that list. All graph buttons and inputs are at least 44 px high.

Stable filter controls are kept separate from arriving results, so a response cannot remove unsubmitted input or its focus. Requests, list callbacks and lazy-module completion are checked against account, notebook, workspace version and both note/notebook selection intents. Old results or controls cannot open an old note id in a newly chosen notebook. Returning to the note preserves the existing source-editor document and undo history; graph refresh is explicit.

## Property table

The owner-only `/api/notebooks/properties/table` route reads the saved index through the normal account-stamped preparation path. Its builder requires a visibility predicate and filters entries before exposing property names, values, counts, filters, ordering or pages. Rows contain note identity, path, title, exact loaded revision and requested cells; they never contain body text or the contents of nested values. The column catalogue is capped at 128 names, each response at twelve columns and 100 rows, and each simple cell at 4096 serialised UTF-8 bytes. The complete response stays within 512 KiB. Byte-limited pages report the actual next offset rather than skipping rows.

Folder and hierarchical-tag filters include descendants. Property comparisons preserve types: equality is type-exact, numeric comparisons require a finite number, and numeric-looking strings are not converted. Property ordering is deterministic, with a path/id tie-break and missing or null values last in either direction. Offset pages read the current saved index rather than a frozen multi-request snapshot. Nested, invalid, unsupported, null, large and identity values are source-only. Magic property names such as `__proto__` remain ordinary own data fields and cannot change the property-map prototype.

The browser loads the table module only when requested. Stable filter fields and the expanded column chooser survive arriving results; an invalid new filter also invalidates older requests. Workspace, account, notebook, both selection intents and request versions protect results, row callbacks, cell dialogs and lazy loading. Native buttons and form controls are at least 44 px high. The horizontal table uses `touch-action: pan-x` and the mobile allowlist; its scrollable pane is a pan-guard root only while Table is active, so Source, Read and Graph retain their existing touch behaviour. A local touch handler scrolls that pane vertically when the finger moves predominantly up or down, without intercepting native sideways gestures or taps. Scrolling stays within the pane's bounds; cancelled, multi-touch, detached-table and no-longer-Table gestures cannot scroll another view. Opening, filtering and closing without writes preserves the existing source-editor document and undo history.

Cell writes use only ordinary `/notes/update` operations with `changes: [{ type: 'properties', set: ... }]`, an operation id and the displayed row's `expectedRevision`. The dialog explicitly selects text, finite number, boolean, primitive list or removal; values are bounded and never silently coerced. Identical failed retries keep their operation id. Invalid input or a stale revision leaves the typed value in the dialog; no reload assigns a newer revision to that old value. A busy operation cannot be submitted or cancelled twice, and a later selected note cannot be reloaded by an older successful cell operation. Current-note drafts, conflicts, in-flight saves and composition block competing cell writes.

The shared YAML update path retains field comments, retained list-item comments and unknown nesting while preserving the exact body bytes. Explicit primitive type changes remove an incompatible old YAML tag rather than saving the wrong type. Normal history, replay, live-lore checks and policy separation still apply; the table introduces no writer bypass or assistant tool. Source and Details outline actions both use the same composition-safe source selection/scroll path.

## Planning canvas

The current official [JSON Canvas 1.0 specification](https://jsoncanvas.org/spec/1.0/) was checked during implementation. The shared codec supports text, file, link and group nodes; integer geometry, ascending node-array stacking order, six preset or six-digit colours, optional group metadata, connection sides and independent arrow ends. Unknown root, node and edge fields, including unknown node types, stay as JSON data. Only recognised editable fields are changed. Dangling connections stay in the file but are not drawn. Validation limits a document to 2 MiB of UTF-8 JSON, 500 nodes, 2000 edges, 64 levels and 100,000 values, rejecting non-JSON objects, non-finite numbers and unsafe integer values rather than silently changing them. Saved and downloaded serialisation uses one bounded path; original formatting is kept when it fits, otherwise compact JSON is used. A semantic no-change save preserves the original exact bytes, including BOM and CRLF.

The owner-only `/canvas/*` routes use the normal fixed account stamp and notebook preparation. Canvas identities are private `cv_` ids, not additions to the portable document. Source files live inside the notebook, while `canvases.json` records paths, hashes and dates outside it. Secure, unambiguous content-hash matches retain identity and history after an external move. The owner list manages at most 200 files without marking other existing files deleted. Original imported or malformed files are never rewritten by a preview. ZIP transfer already treats `.canvas` as portable file data and excludes private controls.

Each create, update, observation and recovery decision uses `runOperationLocked`. Updates require the exact loaded file hash. A private per-operation journal is written before a thin global pending plan; it records the desired bytes, argument identity and full physical/hash witnesses. Staging is durable and its descriptor is journalled before `publishAuthoringFileLocked` publishes it. History and metadata then complete, and the private journal is compacted only after the global operation is done. Recovery validates the canvas identity, notebook, normalised target, bytes, hash, staged target and temporary-file witness before doing anything. Actual process kills cover planned, staged, renamed-but-not-marked, published, history and metadata phases for both create and update. A newer external writer is never overwritten: published work and the external bytes are both kept in history, or blocked unpublished work remains available through the owner's explicit save-copy/discard recovery decision.

The shared private history mechanism stores exact Canvas JSON bytes under the controlled canvas id; its internal blob suffix remains `.md`, but only the owner Canvas history routes read these records. Choosing an earlier version in the browser creates a local working copy, not an unchecked write. Saving that copy still uses the currently loaded revision, normal operation replay and evidence checks.

The read-only projector requires visibility filtering before resolving file cards or returning note titles, ids, paths and excerpts. Missing, hidden, invalid and unresolved targets have the same generic placeholder. A card can select a saved whole note, heading or block; its text is never recursively expanded or added to assistant or roleplay context. The complete projection, including all node and connection metadata, is capped at 256 KiB. Text, HTML, plugin commands and group backgrounds remain inactive data. Only a generated, explicit HTTP(S) link can navigate; no background or embedded resource is fetched. Canvas operations do not change note policies, associations or live lore.

The browser module is separately lazy and uses native controls and an SVG board, with no additional layout dependency. The card list is always available and is the phone default. Board captions stay at least 12 physical pixels and separate hit areas at least 44 px without changing saved geometry. Preset colours derive their lightness and chroma from theme tokens; custom validated colours remain data. Explicit Move mode sets `touch-action: none` on the actual SVG layout box, not just a non-layout group. A single complete pointer gesture applies one integer-position change; cancellation, secondary pointers and stale scopes cannot apply a move. Turning Move off restores ordinary panning.

Account, notebook, workspace, both selection intents and query/document versions guard lazy loads, galleries, previews, dialogs, history choices, saves and copies. Older replies cannot release a newer save's busy state. Local undo is bounded to thirty snapshots or 8 MiB. Edits are retained under an account/notebook/canvas device-draft key and never auto-saved. Older device drafts need an explicit choice; failed saves keep their operation id for an identical retry, and stale saves keep non-dismissible resolution actions. Unsafe device storage blocks leaving until a server save or an explicitly owner-confirmed download of that exact working version; another edit invalidates the confirmation. Source-editor bytes, selection and undo state stay unchanged by browsing a canvas. These native touch and composition checks run in Chromium; actual iOS Safari remains unverified.

## Data layout

Everything lives inside the account's own data folder (`directories.root`):

```text
<account>/
  notebooks/<notebookId>/              portable content: .md notes, .canvas files, folders, attachments/
  notebook-control/<notebookId>/
    manifest.json                      schema, name, origin, structureRevision, notes{id: path, hash, dates, favourite},
                                       associations, attachments (display names)
    policies.json                      assistant level, publish switch, requested edits, admitted, per-note overrides
    lore-bindings.json                 bindings {id: binding}, detached list, revision
    provenance.json                    last 50 source records per note (chat captures and similar)
    trash.json                         trashed notes with their last content hash
    attachment-trash.json + attachment-trash/
    canvases.json                      canvas ids, paths, hashes and dates
    canvas-operations/<operation>.json staged recovery journal, compacted after completion
    obsidian-sync.json                  approved folder identity, client mechanism and settings revision
    obsidian-history/index.json         file identities, bounded observed events and snapshot sizes
    obsidian-history/blobs/<sha>.bin    exact private snapshots of supported content files
    history/<noteId>.json              revision list (newest last)
    history/<noteId>/<sha256>.md       content-addressed copies
  notebook-control/_operations.json    operation journal (account-wide)
  notebook-control/_grants.json        one-off assistant grants
  notebook-control/_proposals.json     assistant proposals made from the browser
  notebook-control/_context-log.json   which note revisions roleplay prompts used (no text)
```

The content folder holds only what a person wrote. Permissions, bindings, history and journals live outside it, so exporting, syncing or editing the content folder can never grant access or publish lore. Nothing under `notebooks/` or `notebook-control/` is served as static files; attachments are only reachable through the authenticated `GET /api/notebooks/attachments/file` route.

Ids are `nb_`, `n_` and `cv_` followed by 16 hex characters. A note's id is stored in the manifest, not in the file, so renaming or moving a note keeps its identity. A `neconyan_id` frontmatter field is treated only as a hint: it is honoured when adopting an unknown file only if that id is not live, not in the trash and not already used, otherwise the file gets a fresh id.

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

Limitation: Neconyan's lock does not bind other programs. If Obsidian or a sync tool writes the same file in the instant between Neconyan's final check and its rename, one of the two writes can win without a conflict being raised. The next rescan records whatever ended up on disk, and history keeps the earlier version, but lost-update prevention is only guaranteed between writers that go through Neconyan. Intermediate versions overwritten before observation cannot be recovered. The optional adapter below records observed stable versions; it does not remove either race.

## Optional Obsidian Headless adapter

The current official [Obsidian Headless documentation](https://github.com/obsidianmd/obsidian-headless) was checked during implementation. The adapter is disabled by default and accepts an administrator-controlled absolute executable path, approved directory roots and a bounded polling interval. It never installs a package, authenticates an account, runs `sync-setup`, selects a remote vault or invokes Publish. The already installed client must be prepared outside Neconyan. Both the client and managed server process require Node 22 or newer for this feature.

An administrator can configure an already prepared client with the following template; the executable is a placeholder, not an installation command:

```yaml
notebooks:
  obsidianHeadless:
    enabled: true
    executable: '/absolute/path/to/already-installed/ob'
    allowedRoots:
      - '$ACCOUNT_ROOT/notebooks'
    pollIntervalMs: 5000
```

`$ACCOUNT_ROOT` expands only to the authenticated account's trusted root. Owner folder approval is restricted to the existing content root of that owned notebook, beneath a real, non-symlink administrator root. Arbitrary directories, copied notebooks, traversal and symlinked parents are refused. The private binding retains the physical directory identity, mechanism and loaded settings revision. Configuration uses a normal operation id and revision check; approval is separate from starting a process. No process auto-starts on boot.

Before reconciliation exposes an incoming identity, the managed notebook's private `externalImportsDeny` flag causes a durable per-note assistant-none/context-off policy write in both small and batched adoption paths. Approval also narrows already adopted notes that only inherited assistant access, while preserving explicit owner access/context choices and native notes. Imported frontmatter never supplies policy. External updates produce ordinary note/Canvas history and safe id/revision notifications, not live-lore publication. The existing clean-note reload and dirty-draft conflict guards handle those notifications.

Start validates the current approval even on an operation replay, takes one physical-folder claim, records a baseline before launching, and rechecks cancellation and account/folder identity after every wait. An owned Node wrapper takes an exclusive folder lock and runs only the configured executable with fixed arguments: `sync-status --path <folder> --json`, then `sync --path <folder> --continuous` if prepared. There is no shell, interactive input or client-output exposure. Prepared checks are byte/time bounded and force-stop an unresponsive owned child. Parent death, IPC disconnect, physical folder replacement and explicit stop terminate the one owned client; force timers are cancelled after exit and only the owned process group can be targeted. An administrator disabling the adapter does not block stopping a running client. Another unmanaged sync program remains the administrator's responsibility; the confirmation forbids combining mechanisms on the folder.

Read-only workers inspect supported Markdown and attachment files, including Canvas, with 5000-file, 20 MiB-per-file and 256 MiB aggregate snapshot limits. Hidden settings/plugins and unsupported types are excluded; visible unsafe links or aliases pause the client. Cache reuse checks size, modification time, inode and change time, after verifying a regular singly linked file. Changed bytes carry physical/hash witnesses which are rechecked in a short fixed-account lease before recording. Targeted index invalidation prevents a same-size, restored-modification-time change from remaining cached. Watch notifications and polling are coalesced; an observed snapshot is recorded, then normal note/Canvas reconciliation runs outside long account locks. Only safe note ids and saved revisions are notified after the lease.

Each observed creation, byte change or deletion is a normal operation with a durable staged private blob witness, deduplicated event/index update and crash recovery. A same-byte physical-stat update changes only private cache metadata, not history. The history keeps up to 2000 events and 512 MiB of blobs, retaining current and pending references; pruning deletes only known unreferenced private hashes. The owner can download exact historical bytes through an authenticated, sandboxed, no-store, attachment-only response. The history does not execute content, restore files unchecked, grant AI access or publish lore. Actual process-kill tests cover the private-history planned and recorded phases.

Owner `/obsidian/*` routes derive the account from authentication and use fixed account stamps. Status reads do not prepare files or start clients. Folder approval is committed before the first adoption check; start, stop and explicit reconciliation remain separate actions. The browser loads the native dialog only on request. It uses a solid theme surface and 44 px controls, retains unsubmitted folder input and loaded settings revisions, reuses the operation id for identical failed retries, and guards lazy completion, query results, downloads and callbacks against account, notebook and both selection intents. A busy current dialog cannot submit twice; a stale dialog can close rather than trapping the user.

Verification uses an owned, network-free CLI stand-in that accepts only the two documented commands. Real Obsidian Cloud authentication, encryption keys, remote-vault configuration and network sync have not been exercised. Native browser checks use Chromium desktop and touch viewports, not actual iOS Safari.

## Permissions

Evaluated on the server in `permissions.js` for every request:

- Assistant access per notebook: `none` (default), `read`, `edit`, with per-note overrides (`inherit`, `none`, `read`, `edit`). An imported notebook starts with `admitted: false`, which forces everything to none until the owner allows it.
- Lore publishing by the assistant needs a separate `assistantPublish` switch and still always goes through review.
- Requested-edit mode (`requestedEdits`) lets proposals for create, append and edit skip review until it expires (default 8 hours, at most 24). Publishing is never direct.
- One-off grants (`_grants.json`, 30 minutes by default, at most 2 hours) cover one selection, one note or one destination folder. A selection grant exposes only that text and allows only replacing that exact text. Its private record keeps the selected text so an insertion elsewhere can be followed without repeatedly hashing the whole note. Public grant metadata omits this text; a moved selection must still have exactly one match. Older hash-only grants use the original private history revision, or require sharing again if that revision is unavailable.
- Notes the assistant cannot read are filtered before listing, searching, backlinks and link resolution, and a hidden note looks the same as a missing one (404).
- Policy changes are owner-only HTTP routes; there is no assistant tool for them. Model arguments such as `userConfirmed` and any text inside notes are ignored for permission decisions.
- Revoking access stops future reads and makes waiting proposals stale (the proposal stores the policy revision). It cannot recall text already sent to a model provider. Files are plain text at rest; 'not shared with AI' is not encryption.

## Assistant tools

### Embedded-note previews and visibility

The owner-only `/api/notebooks/embeds` route builds a read-only projection for the current account. An optional root text override previews the owner's current editor text; every target uses its saved bytes and revision. The shared resolver requires a visibility callback and filters entries before resolving names, aliases, paths or ambiguity. Hidden and missing targets have identical generic placeholders, with no target title, path, id, excerpt or candidate count. Assistant link tools use the same pre-filtered projection; a grant to the source note never grants its targets.

Whole-note previews exclude properties. Heading, nested-heading and block selectors return only the selected region; duplicate or missing selectors never fall back to a whole note. Paragraph, list and heading block markers are supported. Selection preserves exact source boundaries, including BOM and CRLF, and never rewrites authoring bytes. Preview-only block markers are removed from the displayed region.

The server caps nesting at five levels, all embedded references at 32, each selected note at 64 KiB of UTF-8 and the complete JSON response at 256 KiB. An ancestry set keyed by note and selected region prevents cycles. The browser independently checks depth, count and text sizes. Missing, hidden, ambiguous, cyclic and oversized targets expose only a generic notice.

Source ranges become unpredictable temporary text tokens before Markdown conversion. Every root and nested body is sanitised separately; authored scripts, forms, frames, styles and data attributes cannot create controls. Native Open note and Fold embed controls are added afterwards. Block previews are lifted out of paragraphs while retaining surrounding inline formatting, and literal code or link text is restored without tokens. Each child supplies its own path and note id for relative links, images and heading navigation. Root heading folds are assigned before child previews are inserted.

Resource URLs are checked while the sanitised content remains in a separate, inactive document. Remote images become Load external image buttons and tracking attributes are removed before the completed content is inserted into the page. Native browser tests check that neither root nor child remote images make a request before the owner clicks, and that only the explicitly chosen image loads afterwards.

Read responses capture the account, notebook, note object, full editor text and selection/request versions. A late response, or its fold callback, cannot replace a later chosen note or newer text. Rendering does not write Markdown, history, policies or lore. Assistant reads and roleplay context continue to use raw Markdown; neither expands embedded content or broadens sharing scopes.

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
- After a publish or page save the browser clears its World Info cache for that book and reloads the editor. A World Info editor already open in another tab keeps its old copy until it reloads. Every browser World Info save carries the revision belonging to that loaded copy; a stale save returns 409 and keeps the typed draft on screen without overwriting a publication. Loading a newer copy never gives an older draft a newer guard, including when the display of an open editor refreshes. Only earlier successful writes from the same tab can advance a queued draft's guard, with the existing field-by-field merge and entry identity checks retained.
- Loaded World Info revisions live in private weak maps, not portable lorebook JSON. Independently cloned full-book writers pass their original revision explicitly. World Info Lab retains the header from its first fresh read through its later checks; Time Machine retains the revision of the current live copy used for restore. File imports, full replacements and renames also guard their loaded target. Creation uses an absent-only null revision. Older non-browser API consumers may still omit a revision for compatibility; the bundled browser callers do not.

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
- Staged imports live in account-private `notebook-control/_imports/<stageId>/`: `stage.json` records the preview and comparison, and bounded `chunk-N.bin` files keep the validated bytes. These paths are never statically served. Unused previews expire after 30 minutes; started commits do not expire. `/import/list` and `/import/read` let the owner continue after a browser reload or server restart. At most three stages are retained, with completed or unused stages removed first.
- `commit.json` keeps the immutable choices and note identities before any notebook content is written. `commit-progress.json` advances only after the corresponding content, history and manifest files and their folders have been flushed. One account operation id covers the import; batches contain at most eight files and release the account lock between batches. On recovery, existing imported history is not repeated, folder durability is rechecked, and a later owner edit is not overwritten. Pending identities are reserved so an intervening scan cannot give partially imported files different ids.
- ZIP validation, inflation and parsing run in a read-only worker. External adoption likewise prepares file evidence, parsed entries and deterministic history metadata outside the account lock, then checks the evidence again inside each eight-file batch. An immutable `reconciliation/<operationHash>.json` plan and a separate progress file preserve identities through a crash. A later identical content snapshot starts a fresh operation instead of reusing a completed plan. Forced rescans bypass a still-fresh cached result, including when a write discovers newly added external files. Account identity is checked again with the original stamp on every batch. Matching roleplay-context notebooks are prepared before context is captured; private or out-of-scope notebooks are not prepared through that path. Assistant access is checked before preparing a cold notebook.
- Committing creates a new notebook with origin `import` and inactive permissions. 'Compare with this notebook' updates chosen notes with the revision recorded during comparison and a separate replay-safe operation for each changed note. Imports never trigger live lore updates.
- New notes added to an existing notebook receive a durable per-note assistant deny policy before their content is written, so they cannot inherit notebook-wide sharing after a crash. Their context remains off. Existing-note permissions and later explicit owner choices are preserved.
- Each compared update of an existing note uses its own batch, rather than holding the account lock across several full revision-checked saves. New notes and attachments still use batches of at most eight.
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
- The original first-adoption measurement was 57.9 s for 3000 files. A fresh, like-for-like fixture with 3000 Markdown files containing properties, headings and links took 73.1 s through the original single-lock path and 45.3 s through the batched path. The latter used 375 batches; the longest account lock was 201 ms. Of the original 73.1 s, 50.1 s was spent flushing files and folders; batching coalesces folder flushes without dropping the physical-file or content checks.
- A fresh ZIP import of the same 3000-note fixture took 70.7 s including a 1.37 s durable preview, again in 375 commit batches. The longest measured commit lock was 310 ms. This includes writing the original content files as well as history, unlike external adoption. These are VM measurements, not promised completion times.
- A separate full-server run adopted 3000 files while 218 real protected-chat reads and ten revision-checked chat saves completed over HTTP. Adoption took 91.4 s with that extra work: median chat-read time was 489 ms, the 95th percentile was 845 ms, the slowest read was 1.08 s, and the slowest save was 445 ms. This verifies continued chat reading and saving, not a live model generation.
- The separately loaded production source-editor bundle is 275,480 bytes (about 269 KiB), or 88,557 bytes with gzip (86.5 KiB). Its test cap is 512 KiB. Ordinary chat startup does not request it, and the startup library contains no source-editor code. An isolated full frontend build verified the compiled alias, hashed asset and licence notices without changing the worktree's existing build.
- Building a bounded graph from an already-built 3000-note index took 42.2 ms, returning 300 notes and 299 edges. This measures the graph projection, not initial indexing or a browser layout.

## Known limitations

- The editor is a Markdown source editor with a toolbar and a separate reading view. Both support heading folding; there is no live formatted editing.
- Embedded content is a saved, read-only preview in Read, not a live editor or a source of implicit AI access. Its depth and size limits are listed above.
- Device drafts live in the browser's local storage and can be lost if the browser clears it before they reach the server.
- Lost-update protection does not cover programs that write the content folder directly (see External writers).
- Deferred: daily-note automation, real-time collaboration, offline sync, Obsidian plugins or themes, and arbitrary external-folder mounting. The optional Headless adapter is off by default; real Obsidian Cloud is unverified.

## Requirement checklist

| Spec section | Where | Tests |
| --- | --- | --- |
| 4-6 Notes workspace, editor, statuses, templates | `notes-app.js`, `notes-dialogs.js`, `templates.js`, `render.js`, `folding.js`, `public/notes-editor.js`, `drafts.js`, shared rail selection in `neconyan-tabs.js` | `neconyan-rail.test.js`, `notebooks-workspace-state.test.js`, `notebooks-recovery.test.js`, `notebooks-folding.node.js`, `notebooks-folding.test.js`; native E2E at 1280x900 and 393x852: workspace routes, delayed replies, every recovery choice, Source/Read folds, nested keyboard controls, exact CRLF bytes, unchanged selection, editing a folded caret, undo, preference isolation and reload, Chromium composition |
| 7 Links, backlinks, search, rename, rendered embeds | `markdown.js`, `note-index.js`, `store.js`, `embeds.js`, `render.js` | `notebooks-store.node.js`, `notebooks-embeds.node.js`, `notebooks-embeds.test.js`; `notebooks-embeds.e2e.js` at both viewports: whole/heading/block previews, nested folder origins, native Open/Fold, exact saved bytes, sanitisation before insertion, root and child external-image requests only after an explicit click, generic limits and ignored late replies |
| 7 Notebook graph | `src/notebooks/graph.js`, permission-aware resolver, lazy browser `graph.js`, workspace guards in `notes-app.js` | `notebooks-graph.node.js`, `notebooks-graph.test.js`, `notebooks-endpoint.node.js`; `notebooks-graph.e2e.js` at both viewports: lazy load, folder/tag filters, limits, readable small diagrams, keyboard/touch list, unchanged bytes/history/policies/editor document, stable filters and ignored late results |
| Property table | `src/notebooks/property-table.js`, normal property operations, lazy browser `property-table.js`, `property-values.js`, `notes-dialogs.js`, mobile pan policy | `notebooks-properties.node.js`, `notebooks-property-table.test.js`, `notebooks-endpoint.node.js`, `mobile-shell-lifecycle-wiring.test.js`; `notebooks-property-table.e2e.js` at both viewports: saved filters, numeric sorting, bounded server pages, stable column picker, typed edits, invalid/stale value retention, loaded revision, preserved comments/nesting/CRLF body, source-only cells, real horizontal and vertical touch scrolling, cancelled/detached gesture protection, 44 px controls, ignored late replies and Details outline selection |
| Planning canvas | `canvas-format.js`, `canvas-store.js`, permission-aware `canvas-projection.js`, lazy `canvas.js`, `canvas-dialogs.js`, `canvas-drafts.js` | `notebooks-canvas.node.js`, `notebooks-canvas-store.node.js`, `notebooks-canvas.test.js`, owner HTTP tests: current spec, unknown fields, complete byte bounds, exact import/export/history, loaded revisions, replay, real process crashes and blocked recovery choices; `notebooks-canvas.e2e.js` at both viewports: native creation, all card types, declared connections, mouse/touch moves, readable captions/44 px targets, local undo/history, explicit save and download, source/policy isolation, every stale-save choice, device drafts, unsafe-storage download confirmation and late replies |
| Optional Obsidian Headless adapter | `obsidian.js`, `obsidian-client-runner.js`, `obsidian-history.js`, snapshot worker, adoption privacy hooks, lazy `obsidian-dialogs.js` | `notebooks-obsidian.node.js`, `notebooks-obsidian-runtime.node.js`, `notebooks-obsidian-control.test.js`, `notebooks-obsidian-dialog.test.js`, owner HTTP tests: safe roots, one prepared client, withheld output, exact snapshots, real process crashes, parent/root cleanup, timeout/cancel/stale-start guards, durable incoming privacy and no external live-lore update; `notebooks-obsidian.e2e.js` at both viewports: explicit approval/start/stop, local stand-in only, exact download, solid surface/44 px controls, refused unsafe/unprepared folders, current-note updates, retained drafts and ignored late replies |
| 8-9 Storage, identity, revisions, history, trash, external changes | `store.js`, `paths.js`, read-only `preparation-worker.js`, batched `authoring-store.js` | `notebooks-store.node.js`, `authoring-store.node.js`, `notebooks-import-recovery.node.js`: actual process crashes in initial, later and final adoption batches, failed folder flush and protected chat reads |
| 10 API, statuses, operation ids, events | `src/endpoints/notebooks.js`, `events.js` | `notebooks-endpoint.node.js` |
| 11 Permissions | `permissions.js`, `assistant.js`, permission-aware resolver in `note-index.js` | `notebooks-assistant.node.js`, `notebooks-native.node.js`, `notebooks-embeds.node.js`, `notebooks-endpoint.node.js`: hidden/missing equivalence before ambiguity, source grants do not expose targets, account-scoped owner previews and unchanged policies |
| 12 Assistant tools, review, requested edits, durable jobs | `assistant.js`, `assistant-tool-*.js`, `native-tool-definitions.js`, `neconyan-assistant-tools.js` | `notebooks-assistant.node.js`, `notebooks-native.node.js`, `neconyan-assistant-tools.test.js`, `neconyan-assistant-job-review.test.js`; `notebooks-recovery.e2e.js`: native Save change, Not now and Decline with actual proposals and saved text checks at both viewports |
| 13-14 Lore association, publication, entry pages, state machine | `lore.js`, `notes-panels.js`, loaded-copy guards in `world-info.js` and bundled extension writers | `notebooks-lore.node.js`, `world-info-save.test.js`, `world-info-endpoint-utils.test.js`, `world-info-extension-revisions.test.js`; `notebooks-world-info.e2e.js` at both viewports: real publication in another tab, refused native stale saves before and after an editor display refresh, retained typed text, exact loaded guard and save after reload |
| 15 Context and Mewmory | `context.js`, `roleplay-execution.js` | `notebooks-context.node.js`: cold large notebooks prepared only for admitted matching scopes, pinned/reference context never expands embedded targets; existing roleplay suites |
| 16 Chat capture | `welcome-screen.js`, `/notes/capture` | `notebooks-endpoint.node.js` (API); `notebooks-recovery.e2e.js`: real chat message Save to note action, new note and existing-note append, exact quoted passages, provenance and unchanged sharing defaults at both viewports |
| 17 Attachments | `attachments.js` | `notebooks-transfer.node.js`, `notebooks-endpoint.node.js` |
| 18-19 Import, export, Obsidian | `transfer.js`, private disk staging, immutable commit plan and progress, `notes-dialogs.js` recovery UI | `notebooks-transfer.node.js`, `notebooks-endpoint.node.js`, `notebooks-import-recovery.node.js`: actual process crashes, exact bytes, stable ids, one history per import, later owner edit, altered chunk and account isolation; `notebooks-transfer.e2e.js` at both viewports: preview, reload recovery, private defaults, real export, selective comparison and cancellation |
| 21 Performance, budgets | lazy loading, separate self-hosted editor compilation/cache, bounded graph projection and property pages, incremental parsed-entry cache, read-only workers and eight-file authoring batches | budgets script, real 3000-note measurements above; `notebooks-editor-bundle.node.js`: isolated caches, safe pruning, byte cap and actual production aliases; `notebooks-folding.e2e.js`: no editor request during chat startup; graph and 3000-note property-query limits, response byte caps and lazy loading tests |
