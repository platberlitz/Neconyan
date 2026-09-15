# Mewmory

Mewmory is Neconyan’s native long-form Roleplay memory system. Pawspective is its character-specific interview history. Open **Mewmory** in the workspace navigation on desktop or mobile.

## Set up

1. Open a saved character or group Roleplay chat.
2. In **Mewmory → Settings**, configure the facts/events, Pawspective and recall-selector roles. Each uses its own OpenAI-compatible endpoint and model. Embeddings and a separate fallback selector are optional.
3. Set the tokenizer and limits for each model. Local-only requests are the default. A remote role requires both disabling local-only mode and explicitly allowing that endpoint.
4. Save configuration and enable **Use Mewmory in this chat**.
5. For an existing story, use **Backfill this chat**. New accepted messages are processed automatically when automatic updates are enabled.

No model connection or credential is borrowed from the RP writer. Role keys use Neconyan’s protected server credential store. Exports do not contain those keys.

**Now** shows the current cast, protected NPC references, current subject views and memory prompt preview. **Pawspective** shows current interpretations before historical interviews. **Archive** contains objective records and searchable original passages. **Recall** shows selection and rejection explanations. **Settings** includes jobs, preservation coverage, token/latency usage, index rebuild, export and restore.

## What is preserved

- Accepted message revisions, with the selected swipe kept separate from rejected alternatives.
- Source-backed entities, stable appearance and speech notes, temporary state, events, directional relationship facts, knowledge acquisition and commitments.
- Imaginary interviews owned by AI-controlled characters, linked current overviews and earlier interpretations.
- Enabled lore from applicable global, character, chat and persona books, even when ordinary lore activation did not fire.
- Author corrections, exclusions, pins and earlier derived versions for undo.

An interview receives only that character’s source-backed knowledge and eligible prior views. It does not receive an omniscient transcript or the complete lorebook. A player character cannot own an interview. Generated interview gestures never enter the source archive or objective extraction inputs.

“Reported” means that someone said something; it does not establish that the claim is true. Significance requires accepted story evidence. Retrieval, retrying a job and copying summaries do not raise significance.

Use **Edit** to correct the text, owner, subjects or sources. The correction menu supports suspicion, unsupported interpretations, knowledge a character never acquired, resolution, background status, scene pins and exclusions. An undo checks the source again; it cannot make a rejected or deleted scene accepted.

## Preservation and prompt limits

The default recent-chat target is **30,000 tokens of chat**, separate from NPC references, memory, instructions, lore and output space.

The coordinator starts preservation review around the 80% buffer. A generation can complete up to four bounded checkpoint batches. Older messages leave the outgoing history only when their current revisions have completed the required checkpoint. A failed job does not advance coverage.

The original chat remains unchanged. Source passages remain searchable through the local lexical index even when embeddings are unavailable. Memory and active-NPC sections are assembled outside history trimming. If the retained prompt cannot fit, generation stops with an actionable error. Increase context, reduce pinned memory or complete backfill instead of silently losing protected material.

Token counts use a real local tokenizer, with an explicit model/tokenizer choice. Auto follows the application’s selected tokenizer; a backend-only estimate is insufficient for exclusion. Tokenizer choices still need to match the model. Final request accounting includes a conservative serialised-payload check as well as the host’s prompt budget.

## Storage and branches

Authority lives under each user’s data directory:

- mewmory/config.json: role settings and limits, without credentials.
- mewmory/stories/&lt;chat-locator-hash&gt;.json: typed sources, revisions, records, dependencies, jobs, coverage, audit entries and rebuildable vectors.

This version reuses Neconyan’s atomic writes and file locks. Model requests run outside the storage lock. A result commits only if its source snapshot, settings and author revisions still match. No SQLite, Qdrant or graph service is required. Individual archives and restores are capped at 256 MiB; a write beyond that limit keeps the previous file intact.

Lexical and vector candidates are searched independently and combined by rank. Vector representations are cached by content and model configuration. A changed embedding configuration builds separately; queries and documents never mix vector spaces. Search is currently linear within a story. Large libraries should be measured before replacing it with an approximate-nearest-neighbour service.

Stories and branches have independent identities. Native branches inherit a matching accepted prefix and only record revisions at or before that branch point. They own a copy of that history; later parent developments cannot enter. Knowledge gained later preserves earlier valid interpretations. Author corrections invalidate faulty versions. The source identity uses the saved message date plus its occurrence within that chat. Legacy messages without dates use position, so moving those messages can conservatively invalidate more records.

For a new chapter in another chat, **Link this continuation** explicitly copies the selected earlier story’s memory and history into an empty Mewmory archive. Chats remain unrelated until associated. Current overviews and corrections remain branch-specific.

## Deletion and recovery

Excluding a source makes it and its dependent records ineligible for processing and recall. It remains available for inspection.

Deleting a chat message purges its archived revisions, dependent memory, associated undo copies, previews and vectors when the source is reconciled. Deleting a complete chat removes its Mewmory file. A deleted character/lore source is purged when its absence is reconciled. Disabling or unbinding a surviving lore entry makes it ineligible without pretending the witnessed events never happened.

An opaque source ID and revision counter remain after individual deletion so an old export cannot revive a deleted revision. If imported messages share a timestamp or have no dates, deleting an ambiguous occurrence conservatively rebuilds that group’s memory from the remaining accepted messages.

Existing Neconyan chat backups, external copies and downloaded exports have their own retention. Mewmory does not erase those. A copied branch or explicitly linked continuation owns its own history.

Export saves the complete Mewmory archive. Restore first shows which records can be used with the current accepted sources. It does not replace chat, manufacture old source revisions or revive rejected alternatives. Restored records become protected author corrections; preservation coverage is recomputed.

## Integration map

| Lifecycle | Native path |
| --- | --- |
| Accepted source | public/script.js saves the active mes and swipe_id through /api/chats/save; groups use /api/chats/group/save. The source adapter reads those JSONL files. |
| Edits, swipe changes, deletion | Existing saves remain authoritative. Reconciliation runs before processing, inspection, recall and final prompt validation. Browser lifecycle events debounce automatic updates. |
| Imports | The first Mewmory read archives accepted imported messages. Backfill runs chronologically. |
| Branches/checkpoints | public/scripts/bookmarks.js saves a prefix with chat_metadata.main_chat. The adapter copies only matching visible history. |
| Chat rename/delete | src/endpoints/chats.js moves or removes the corresponding Mewmory store. |
| Character/lore changes | src/mewmory/sources.js loads current user-owned cards and applicable books. Changed sources acquire new revisions. |
| Outgoing Roleplay | Generate() calls the native preparation step after prompt transforms/interceptors. Text Completion appends a protected memory section outside the history/story injection. Chat Completion reserves a dedicated Mewmory collection before history allocation. |
| Final request | The generation path rechecks source/record/configuration identity and the final prompt’s capacity before sending. |
| Inspection | A native shell tab loads public/scripts/mewmory/ui.js; authenticated /api/mewmory/* routes resolve user ownership and chat scope. |

Conversation Mode’s independent DM store is not the Roleplay JSONL pipeline. Its existing summary feature is unchanged. Mewmory does not claim hard knowledge isolation for a multi-character RP writer that receives other secrets elsewhere in its normal prompt.

## Validation and evaluation

Run the source, record, provider, retrieval and checkpoint checks:

    npm run test:mewmory

The command uses Node’s built-in test runner directly. The host’s server-log capture interferes with the subprocess reporter used by node --test, so the direct command preserves individual test results.

The gift fixture covers stable NPC details, a mistaken interpretation, a later revelation, a secret the character has not learned, enabled/disabled lore and a rejected alternative. It also checks chronological reconstruction within the default 12-message batch, earlier branch views, edit recovery and selector ordering. A deterministic loopback provider exercises real HTTP requests without real model credentials. It tests boundaries and integration, not model quality.

For the browser check, start a disposable Neconyan server and the fixture provider:

    node tests/mewmory-provider.js
    NECONYAN_MEWMORY_TEST_DISPOSABLE=1 NECONYAN_TEST_BASE_URL=http://127.0.0.1:4490 npm --prefix tests run test:e2e -- mewmory.e2e.js --workers=1

Build frontend assets before testing a packaged server. The browser check covers role settings, backfill, original sources, correction persistence, selector diagnostics, desktop and 390/320px layouts, and the real writing prompt.

Real-model extraction recall, unsupported interpretations, character voice, associative relevance and fallback cost still require a labelled story set and configured model endpoints. No particular selector model is claimed to be best. A shared provider in the fixtures is a test arrangement, not automatic role sharing in the application.

To prepare comparable writing inputs, preview recall, export that story, and supply a baseline summary:

    npm run compare:mewmory -- export.json baseline-summary.txt output-directory 6000 cl100k_base

This writes baseline, objective-only and Pawspective text files with the same protected NPC references and memory allowance, plus measured token counts. It uses the saved selector decision for Pawspective and lexical retrieval for the objective-only comparison. Run those inputs with the same writer and compare continuity, unsupported claims, voice and repetition. The tool does not turn token counts into a quality score.

## Design lineage

Implemented from **Mewmory Design Plan v0.1**, dated 14 September 2026. The chosen storage and search deployment resolve proposals in that document; the source, subjective-memory, selector and compaction boundaries remain separate.

Relevant precedents: [VectFox](https://github.com/KritBlade/VectFox), [Smart Memory](https://github.com/senjinthedragon/Smart-Memory), [VectHare](https://github.com/Coneja-Chibi/VectHare), [OpenCode compaction](https://opencode.ai/docs/config/#compaction), and [retrieve and rerank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html). No implementation code was copied from those projects.
