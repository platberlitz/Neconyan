# Mewmory

Mewmory is Neconyan’s native long-form Roleplay memory system. Pawspective is its character-specific interview history. Open **Mewmory** in the workspace navigation on desktop or mobile.

## Set up

1. Open a saved character or group Roleplay chat.
2. In **Mewmory → Settings**, configure Facts and events and Pawspective if you want extracted memories and character interviews. Choose a saved connection profile or a manual OpenAI-compatible endpoint and model. Original passages can be retrieved without either role. Embeddings, the AI recall selector and its separate fallback are optional. With the selector off, ranked search results go straight to the memory budget. Embeddings can use a Mewmory connection or the saved native Vectorization connection. If a profile has no saved model, enter your service's model name in Mewmory's **Model** field.
3. Set the limits for each model. **Auto (match this model)** chooses a local tokenizer from that role's model name; an explicit tokenizer remains available. Remote model requests are allowed by default; **Only use models on this computer** restricts every role to loopback and private-network endpoints or local Transformers. Each role also has its own remote-access permission. The default output allowance for text roles is **32,000 tokens**. Every role defaults to a **300-second timeout**. Saved settings using the old 60-second timeout and untouched 16,000-token output default are upgraded when their context limit permits it; deliberate custom limits stay as set.
4. Save configuration and wait for **Configuration saved.**, then enable **Use Mewmory in this chat**. Unsaved edits do not affect processing. If saving fails, the message names the affected role and stays visible in Settings until you save successfully or discard your edits. An incomplete disabled role does not prevent saving the enabled roles.
5. For an existing story, use **Backfill this chat**. New accepted messages are processed automatically when automatic updates are enabled.

Model roles follow their saved Mewmory choice, including an explicitly selected Vectorization connection. Role keys use Neconyan’s protected server credential store. Exports do not contain those keys.

## Search, passages and native Vectorization

RAG means retrieval-augmented generation: finding relevant saved text and supplying it to the writer. Mewmory combines original passages, structured memories, source citations, optional meaning search and optional AI selection. The writer still receives only eligible source-backed material that fits the memory allowance.

To share your existing embedding setup, open **Included tools → Vectorization**, save its provider and model, then choose **Mewmory → Settings → Embeddings → Embedding connection → Use native Vectorization** and save. Mewmory uses the same server provider adapters, saved credentials and query/document prefixes. Vectorization's chat retrieval switch can stay off. Local Transformers and supported hosted or self-hosted server providers work here; browser-only WebLLM cannot run in Mewmory's background jobs. Mewmory's own remote-access and source permissions still apply.

Both embedding connections offer exact query and document prefixes. Presets cover E5, Nomic and English BGE conventions, plus no prefix. Choose the recommendation for your exact model; a preset is not a model detector. Trailing spaces and line breaks are preserved. Prefixes are applied to embedding requests, never inserted into the writer's source text. In native mode, edit prefixes in Vectorization. Changing prefixes invalidates the old vector configuration: Mewmory builds the new space separately, and native Vectorization rebuilds on its next indexing or reply operation. A manual native search asks you to re-index first if its saved prefixes differ.

**Search and passages** controls:

- **Search method:** keyword, meaning or hybrid. Hybrid combines independently ranked keyword and vector results. **Meaning weight** ranges from 0 to 1; 0 favours keywords, 1 favours meaning. **Minimum meaning similarity** discards vector matches at or below that score. Similarity is not a confidence percentage. If embeddings are unavailable, search falls back to keywords and reports it.
- **Passage size and overlap:** exact original text is split near paragraph, sentence or word boundaries, with bounded overlap. Defaults are 1,800 characters and 200 characters of overlap. Original offsets stay attached to citations. Changing these settings causes changed passages to be embedded again.
- **Recent messages in search:** defaults to eight eligible messages. A manual recall query is added to this scene. Current reply preparation remains local; fresh embedding and AI work happens alongside the writer for later replies.
- **Candidates and results:** the existing candidate limit controls the pool sent to the optional AI selector. The selected-result limit defaults to 12. A per-source limit, three by default, prevents one long file from occupying every match. Identical passage text is deduplicated. Pinned records and triggered commitments remain mandatory within the memory budget.
- **Neighbouring passages:** optionally add up to two passages on either side of a chosen source passage. Overlapping source characters are included only once. Neighbours share the same eligibility checks and memory budget.
- **Embedding batches:** choose 1-10 passages per request. A provider's stricter batch limit takes precedence. A changed vector dimension stops indexing instead of mixing incompatible vectors; set a new model revision and rebuild.

File retrieval uses native Vectorization's attachment discovery and protected server-file reader. It includes enabled Data Bank files attached globally, to this character or group cast, or to this chat, plus message attachments. Other characters' files and disabled attachments stay out. Message-attached text is bounded by the message that supplied it, including exclusions and earlier-scene previews. Removing a source makes it ineligible; deleting a file or its parent message purges its archived text when reconciled. Files provide original references for the writer, not automatic character knowledge or extraction inputs. Existing saved model roles need file access enabled explicitly under **This role may read** before receiving file passages.

**Archive** can search by keywords, meaning or both and filter the source type. It shows source links, rank scores, meaning similarity and fallback errors. **Recall** reports the search method, searchable and indexed counts, actually included results, result-limit exclusions and passages omitted by the token budget. AI explanations remain inspection-only.

Sharing Vectorization does not import another chat's index or add a second Mewmory prompt contribution. Mewmory keeps its own branch-aware index and source checks. Native Vectorization's separate reply retrieval still follows its own switches and budgets, so enabling both can retrieve related text through both features.

A saved profile uses its own bound key and selected proxy. A keyless custom profile stays anonymous; a deleted key binding needs repair. Azure and Workers AI also need their connection fields in that profile or its named preset. Mewmory rejects redirects, including requests made through saved profiles. A failed configuration save leaves both settings and role keys unchanged, and removing a manual role key removes its older saved replacements too.

**Now** shows the current cast, protected NPC references, current subject views and memory prompt preview. **Pawspective** shows current interpretations before historical interviews. **Archive** contains objective records and searchable original passages. **Recall** shows selection and rejection explanations. **Settings** includes jobs, preservation coverage, token/latency usage, index rebuild, export and restore.

## What is preserved

- Accepted message revisions, with the selected swipe kept separate from rejected alternatives.
- Source-backed entities, stable appearance and speech notes, temporary state, events, directional relationship facts, knowledge acquisition and commitments.
- Imaginary interviews owned by AI-controlled characters, linked current overviews and earlier interpretations.
- Enabled lore from applicable global, character, chat and persona books, even when ordinary lore activation did not fire.
- Author corrections, exclusions, pins and earlier derived versions for undo.

An interview receives only that character’s source-backed knowledge and eligible prior views. It does not receive an omniscient transcript or the complete lorebook. A player character cannot own an interview. Generated interview gestures never enter the source archive or objective extraction inputs.

Each entity has one complete current temporary-state record. Updating its clothing or location must retain an ongoing injury or carried item. Automatic cast changes are saved at their story position, so reviewing an earlier scene cannot apply a later departure. Superseded overviews remain labelled as historical when recalled alongside the current interpretation.

I keep the interview guidance brief: aim for 1-3 short sentences per answer, with at most one action or subtext cue when it adds meaning. Character voice and supported uncertainty still matter; answers aren't cut off to enforce that target.

“Reported” means that someone said something; it does not establish that the claim is true. Significance requires accepted story evidence. Retrieval, retrying a job and copying summaries do not raise significance.

Use **Edit** to correct the text, owner, subjects or sources. The correction menu supports suspicion, unsupported interpretations, knowledge a character never acquired, resolution, background status, scene pins and exclusions. An undo checks the source again; it cannot make a rejected or deleted scene accepted.

## Preservation and prompt limits

The default recent-chat target is **30,000 tokens of chat**, separate from NPC references, memory, instructions, lore and output space.

Automatic background batches include preservation review when history exclusion is enabled. I no longer make the reply wait for Mewmory's model requests: it uses a quick local search and completed AI selections while embeddings and fresh AI recall run alongside the writer. Fresh selections become available for later replies, so the current reply can miss an association that only the AI would find. Extraction, interviews and backfill also carry on separately. Older messages leave the outgoing history only when their current revisions have completed the required checkpoint. A failed job does not advance coverage.

The server checks enabled saved chats every 15 seconds and starts waiting work as running jobs finish. Up to four extraction jobs run at once; automatic starts leave one slot available for manual work and use at most two slots per account. Full backfill and automatic processing carry on after closing the page or switching chats. Their saved job intent lets a restarted server resume unfinished work; a partly completed model request can be repeated. **Stop** cancels the server job. Failed or cancelled jobs stay stopped until the sources or configuration change, or you start them again. Opening the chat shows the server's current progress. Automatic extraction reads whatever has been saved, so a long reply can arrive after its user's message has already been processed in a separate batch.

Changing extraction models, providers or output-affecting settings invalidates existing coverage across enabled stories and can trigger full background reprocessing. Changing only a timeout keeps that coverage. Periodic scans reconcile chat, character and lorebook sources so changes outside the current page are detected; large enabled libraries still have a recurring scan cost.

The original chat remains unchanged. Source passages remain searchable through the local lexical index even when embeddings are unavailable. Memory and active-NPC sections are assembled outside history trimming. If the retained prompt cannot fit, generation stops with an actionable error. Increase context, reduce pinned memory or complete backfill instead of silently losing protected material.

Token counts use a real local tokenizer. Each memory role’s Auto option follows its own model, including the selected connection profile, independently of the RP writer. Settings shows the local match. Model-family matches are approximate, and unknown model names fall back to the GPT-3.5 tokenizer; choose an explicit tokenizer if your provider uses another. The writer’s separate Auto option follows the application’s selected tokenizer; a backend-only estimate is insufficient for exclusion. Final request accounting includes a conservative serialised-payload check as well as the host’s prompt budget.

If a chosen tokenizer cannot load and the host substitutes another, Mewmory reports that failure and keeps history instead of silently counting with the substitute. Changes to preservation rules require another review before old messages can be left out; existing sources and author corrections remain available.

## Storage and branches

Authority lives under each user’s data directory:

- mewmory/config.json: role settings and limits, without credentials.
- mewmory/stories/&lt;chat-locator-hash&gt;.json: typed sources, revisions, records, dependencies, jobs, coverage, audit entries and rebuildable vectors.
- mewmory/recovery/&lt;chat-locator-hash&gt;.json: story identity and accepted source revision checks, without message text, memory prose or credentials.

This version reuses Neconyan’s atomic writes and file locks. Model requests run outside the storage lock. A result commits only if its original sources, settings and author revisions still match. Appending new chat messages or saving recall progress doesn't discard an otherwise valid batch. Each reply uses a consistent completed-memory snapshot; finishing background work doesn't invalidate that reply. No SQLite, Qdrant or graph service is required. Individual archives and restores are capped at 256 MiB; a write beyond that limit keeps the previous file intact.

Lexical and vector candidates are searched independently and combined by rank. Vector representations are cached by content and model configuration. A changed embedding configuration builds separately; queries and documents never mix vector spaces. Search is currently linear within a story. Large libraries should be measured before replacing it with an approximate-nearest-neighbour service.

Stories and branches have independent identities. A native branch captures its matching accepted prefix and the memory available at that point when the branch is saved, including inherited continuation history. Opening the Mewmory panel later does not copy newer parent corrections. Knowledge gained later preserves earlier valid interpretations. Author corrections invalidate faulty versions. Native saves give each logical message a stable identity that survives swipe dates and selection changes. Existing accepted source references are migrated in place when that identity first appears.

For a new chapter in another chat, **Link this continuation** explicitly copies the selected earlier story’s memory and history into an empty Mewmory archive. Chats remain unrelated until associated. Current overviews and corrections remain branch-specific.

Switching chats refreshes Mewmory immediately, including while its panel is closed. A selected chat can show loading, disabled memory or a recoverable error; those states do not mean that no Roleplay chat is selected. Starting a separate chat with the same character does not automatically enable or share its other chats’ memory.

## Deletion and recovery

Excluding a source makes it and its dependent records ineligible for processing and recall. It remains available for inspection.

Deleting a chat message purges its archived revisions, dependent memory, associated undo copies, previews and vectors when the source is reconciled. Deleting a complete chat removes its Mewmory archive and recovery checks, and a finishing background job cannot recreate them. A deleted character, lorebook or lore entry is purged when its absence is reconciled. Renaming a card or book preserves its source identity; reusing the old filename for a different card or book does not merge them. Disabling or unbinding a surviving lore entry makes it ineligible without pretending the witnessed events never happened.

An opaque source ID and revision counter remain after individual deletion so an old export cannot revive a deleted revision. If imported messages share a timestamp or have no dates, deleting an ambiguous occurrence conservatively rebuilds that group’s memory from the remaining accepted messages.

Existing Neconyan chat backups, external copies and downloaded exports have their own retention. Mewmory does not erase those. A copied branch or explicitly linked continuation owns its own history.

Export saves the complete Mewmory archive. Restore first shows which records can be used with the current accepted sources. It does not replace chat, manufacture old source revisions or revive rejected alternatives. Restored records become protected author corrections; preservation coverage is recomputed.

If the archive is missing or damaged, the selected chat offers recovery from an export. Recovery requires the separate identity and source-revision checks, plus matching accepted chat and context. It skips unsupported records and rejects exports from another branch. Existing archives gain those recovery checks on their next successful inspection or update. An archive lost before those checks existed needs its original server backup; an export alone cannot prove which deleted or rejected revisions must stay excluded.

## Integration map

| Lifecycle | Native path |
| --- | --- |
| Accepted source | public/script.js saves the active mes and swipe_id through /api/chats/save; groups use /api/chats/group/save. The source adapter reads those JSONL files. |
| Edits, swipe changes, deletion | Existing saves remain authoritative. Reconciliation runs before processing, inspection, recall and final prompt validation. The server scans enabled saved stories for pending work; browser events refresh the display. |
| Processing lifecycle | src/mewmory/worker.js persists job intent, processes batches, handles explicit cancellation and resumes unfinished jobs on startup. Browser polling displays progress without owning the work. |
| Imports | The first Mewmory read archives accepted imported messages. Backfill runs chronologically. |
| Branches/checkpoints | public/scripts/bookmarks.js saves a prefix with chat_metadata.main_chat. The native save captures matching visible memory before reporting success. |
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

Build frontend assets before testing a packaged server. The browser checks cover new chats and branches, connection profiles, rejected saves, saved settings after a reload, role-specific Auto, backfill, original sources, correction persistence, selector diagnostics, desktop and 393/320px touch layouts, and the real writing prompt.

Real-model extraction recall, unsupported interpretations, character voice, associative relevance and fallback cost still require a labelled story set and configured model endpoints. No particular selector model is claimed to be best. A shared provider in the fixtures is a test arrangement, not automatic role sharing in the application.

To prepare comparable writing inputs, preview recall, export that story, and supply a baseline summary:

    npm run compare:mewmory -- export.json baseline-summary.txt output-directory 6000 cl100k_base

This writes baseline, objective-only and Pawspective text files with the same protected NPC references and memory allowance, plus measured token counts. It uses the saved selector decision for Pawspective and lexical retrieval for the objective-only comparison. Run those inputs with the same writer and compare continuity, unsupported claims, voice and repetition. The tool does not turn token counts into a quality score.

## Design lineage

Implemented from **Mewmory Design Plan v0.1**, dated 14 September 2026. The chosen storage and search deployment resolve proposals in that document; the source, subjective-memory, selector and compaction boundaries remain separate.

Relevant precedents: [VectFox](https://github.com/KritBlade/VectFox), [Smart Memory](https://github.com/senjinthedragon/Smart-Memory), [VectHare](https://github.com/Coneja-Chibi/VectHare), [OpenCode compaction](https://opencode.ai/docs/config/#compaction), and [retrieve and rerank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html). No implementation code was copied from those projects.
