const world = 'public/scripts/world-info.js';
const agents = 'public/scripts/extensions/in-chat-agents/';
const mewmory = 'docs/mewmory.md';
const mewmoryUi = 'public/scripts/mewmory/ui.js';

export default [
    {
        id: 'lorebooks.tour', title: 'Nori’s guided Lorebook tour', keys: ['lorebook tour', 'Nori tour', 'learn lorebooks', 'one fact one entry'],
        sources: ['public/scripts/neconyan-lorebook-tour.js'], anchors: ['One fact, one entry', 'Primary Keywords', 'Character Lore'],
        content: 'Open Lorebooks and use Tour for Nori\'s guided introduction. Back and Next move through the library, books and entries; using the highlighted controls also advances the relevant steps. The tour explains Primary Keywords, Content, Normal versus Constant entries, Health and the token footprint. Keep one fact per entry so keywords and retrieval stay precise. A book must be activated globally or linked through Character Lore before normal Roleplay can use it. The tour explains and opens controls; it does not write a lorebook for you or make model requests.',
    },
    {
        id: 'agents.glossary', title: 'Taro’s searchable Agents glossary', keys: ['ICA glossary', 'Agents glossary', 'Taro glossary', 'agent terminology', 'Search glossary'],
        sources: [agents + 'settings.html', 'src/docs-reader.js', 'docs/in-chat-agents-glossary.md'], anchors: ['ICA glossary', 'Search glossary', 'Taro'],
        content: 'Open Agents and choose ICA glossary. It opens the bundled Agents reference in a new tab, with Taro as its guide and a Search glossary field. Use it to look up agent terminology and settings while keeping your current workspace open. Reading or searching the glossary makes no model request and does not change agent configuration. Taro\'s chat is separate: the guide artwork itself is not a live assistant conversation.',
    },
    {
        id: 'lorebooks.start', title: 'Creating, importing and attaching lorebooks', keys: ['lorebook', 'World Info', 'world information', 'attach book', 'import lorebook'],
        covers: ['core:lorebooks'], sources: [world, 'public/scripts/neconyan-native-workspaces.js'], anchors: ['world_info'],
        content: 'Open Lorebooks to create/import a book and edit its entries. Books can be active globally or attached to a character, chat or persona; these are different scopes. A character can have additional linked books. Importing a book does not necessarily activate it everywhere. Embedded character lore has an import/link flow; merely seeing a book name is not proof its contents were inserted into a request. Use World Info Lab or prompt inspection to check activation.',
    },
    {
        id: 'lorebooks.activation', title: 'Lorebook keywords and activation conditions', keys: ['lorebook keywords', 'entry activation', 'constant entry', 'secondary keys', 'scan depth', 'entry not triggering'],
        sources: [world], anchors: ['keysecondary', 'selectiveLogic'],
        content: 'An entry\'s primary keys match the scanned context; secondary-key logic can further require or exclude matches. Constant entries bypass ordinary keyword triggering but still face applicable filtering/budget rules. Scan depth determines how far back activation checks look. Case sensitivity, whole-word matching and regular-expression keys affect matching. Disabled entries, character filters, probability and timing effects can suppress an otherwise matching entry. Check the actual scan result before changing the prose repeatedly.',
    },
    {
        id: 'lorebooks.budget', title: 'Lorebook budgets, ordering and placement', keys: ['lorebook budget', 'world info tokens', 'entry priority', 'recursive scan', 'sticky', 'cooldown', 'entry position'],
        sources: [world], anchors: ['excludeRecursion', 'preventRecursion'],
        content: 'Lorebook content consumes the model\'s context. Budget, ordering and priority decide which activated entries fit; activating a key does not guarantee insertion. Placement controls where accepted entries appear in the prompt. Recursive scans may let an inserted entry activate others, subject to recursion exclusions and limits. Sticky duration, cooldown and delay affect timing across turns. Inspect the outgoing prompt or World Info Lab trace to distinguish failed matching from budget rejection.',
    },
    {
        id: 'lorebooks.editing', title: 'Lorebook entry tools and history', keys: ['lorebook history', 'LoreStitch', 'Entry tools', 'merge entries', 'lorebook search replace', 'delimiters', 'health check', 'test keys', 'token footprint', 'broken entry ids'],
        sources: ['public/scripts/neconyan-lorebook-tools.js', 'public/scripts/templates/neconyanLorebookTools.html', 'public/scripts/neconyan-lorebook-keytest-panel.js'], anchors: ['History'],
        content: 'Lorebook History and Entry tools provide integrated editing functions, including search/replace, delimiter operations, merging and export. LoreStitch-related features are part of these controls, not necessarily a standalone workspace. Delimiters can wrap entries in <Name> tags, [Name= ] brackets, Markdown headings or --- lines, repair mismatched or unclosed wrappers, and apply to chosen entries. The Health button beside History lists duplicate keys, ignored secondary keys, entries that can never activate, recursion loops, invalid regex keys and malformed wrappers; findings can be muted or marked not an issue. The battery button shows the tokens always-active entries use against the World Info budget. Each entry has a Test keys section that checks keys against sample text and says whether the entry would be inserted. Imports and exports list and fix broken entry ids first. Review the selected entries and changes before applying a bulk operation. Export first when you need an independent rollback copy; entry history, whole-book export and Time Machine snapshots are different recovery mechanisms.',
    },
    {
        id: 'memory.distinctions', title: 'Choosing the right memory system', keys: ['memory systems', 'remember things', 'forgetting', 'clear memory', 'memory difference'],
        covers: ['core:memory'], sources: [mewmory, 'docs/conversation-mode-glossary.md', agents + 'pathfinder-settings.html', agents + 'templates/memory-shard-companion.json'], anchors: ['Mewmory', 'Memory Shard'],
        content: 'Neconyan has several separate memory features. Mewmory preserves source-backed Roleplay facts and character viewpoints. Conversation maintains its own DM summaries. Pawthfinder retrieves lorebook entries and supports notebook-related tools. Agents can write their own outputs, including the Memory Shard companion\'s summaries, and Vector Storage retrieves indexed text. Enabling, clearing or backing up one does not automatically operate on the others. First identify the active mode and memory feature before giving deletion or troubleshooting instructions.',
    },
    {
        id: 'mewmory.setup', title: 'Setting up Mewmory with saved connections', keys: ['Mewmory setup', 'enable Mewmory', 'memory connection profile', 'Facts and events', 'Pawspective setup', 'Recall selector'],
        covers: ['core:mewmory'], sources: [mewmory, mewmoryUi, 'src/mewmory/models.js'], anchors: ['Save configuration', 'Connection profile', 'localOnly: false', 'allowRemote: true', 'Catch up on this whole chat', 'Only use models on this computer', 'Allow sending story data to a service on another computer', 'Use Mewmory in this chat'],
        content: 'Open a saved Roleplay character/group chat, then Mewmory → Settings. Under Model roles, pick Facts and events, Pawspective interviews and Recall selector in turn, tick Enable this role, and choose a saved Connection profile or Manual endpoint (OpenAI-compatible endpoint, Model, API key). Model override keeps the profile\'s credentials. Embeddings and Recall fallback are optional. Roles are shared by all chats. Remote services are allowed by default: Only use models on this computer starts off, and each role\'s Allow sending story data to a service on another computer starts on. Choose Save configuration, wait for Configuration saved., then tick Use Mewmory in this chat. Catch up on this whole chat processes earlier messages and makes model requests.',
    },
    {
        id: 'mewmory.tokenizers', title: 'Mewmory models, token counting and limits', keys: ['Mewmory tokenizer', 'Auto match this model', 'memory context limit', 'Mewmory model override', 'Mewmory output limit'],
        sources: [mewmory, mewmoryUi, 'src/mewmory/tokens.js', 'src/mewmory/models.js'], anchors: ['tokenizer', 'Auto (match this model)', 'Writer tokenizer', 'maxOutputTokens: name === \'embedding\' ? 0 : 32000', 'role.maxOutputTokens === 16000'],
        content: 'Each Mewmory role uses its own model, separate from the reply writer. Tokenizer for this role set to Auto (match this model) picks a local tokenizer from that role\'s model name; matches are approximate and unknown models use a fallback, so choose one manually if needed. Writer tokenizer Auto follows the app\'s selected tokenizer. New configurations give every role except Embeddings an Output limit, tokens of 32,000 and a Context limit, tokens of 200,000. Saved roles still on the old 16,000 default move to 32,000 once, when their context limit is above 32,000; other saved values stay. Output must be lower than context. Raising a limit does not raise what the model service supports.',
    },
    {
        id: 'mewmory.inspect', title: 'Inspecting facts and Pawspective', keys: ['Pawspective', 'memory archive', 'Mewmory Now', 'memory sources', 'character beliefs', 'Preview next memory', 'Active NPCs'],
        sources: [mewmory, mewmoryUi], anchors: ['Pawspective', 'Recall', 'Preview next memory', 'Choose active characters automatically'],
        content: 'Mewmory has Now, Pawspective, Archive, Recall and Settings views. Now offers Preview next memory, Update now and Add NPC reference, lists Active NPCs (with Choose active characters automatically) and How characters see things now. Archive searches memories and original messages; Recall shows what was picked or left out and why. Open a record\'s sources before accepting a disputed fact. Pawspective interviews are imaginary and owned by AI-controlled characters, never the player; their actions are not story events. Reported claims and character beliefs are not automatically true.',
    },
    {
        id: 'mewmory.corrections', title: 'Correcting, excluding and deleting Mewmory records', keys: ['correct memory', 'delete Mewmory', 'exclude memory', 'unsupported memory', 'never learned', 'pin memory'],
        sources: [mewmory, mewmoryUi], anchors: ['unsupported', 'knowledge a character never acquired', 'Correct this memory…', 'Stop using in replies', 'This character never learned this'],
        content: 'Inspect a Mewmory record\'s sources, owner and subjects first. The Correction menu (Correct this memory…) offers Only a suspicion, Not supported by the story, This character never learned this (knowledge and viewpoints only), Resolved, Keep in the background, Active again, Pin for this scene and Stop using in replies. Edit changes text, owner, subjects or sources; Undo last change reverts, but cannot revive a rejected or deleted source. Stopped records stay visible but are not recalled. Deleting a message removes memories based on it; chat backups and downloaded exports keep their copies.',
    },
    {
        id: 'mewmory.preservation', title: 'Mewmory preservation and generation failures', keys: ['Mewmory preservation', 'backfill', 'catch up', 'missed details', 'memory blocked reply', 'recent chat target'],
        sources: [mewmory, mewmoryUi, 'src/mewmory/models.js'], anchors: ['preservation', 'Leave out older chat that Mewmory has already remembered', 'Check for missed details', 'Stop updating'],
        content: 'Mewmory reads accepted messages and enabled lore without changing the chat. Replies do not wait for Mewmory: they use completed memories while updates, interviews and fresh recall run in the background, so chat continues during updates. With Leave out older chat that Mewmory has already remembered on, older messages leave the prompt only once fully remembered; the default Recent chat target, tokens is 30,000. If memories plus recent chat cannot fit, the reply stops with an error rather than dropping them. Settings → Progress offers Check for missed details, Stop updating, and Retry or Dismiss for failed jobs. Background work uses provider credits.',
    },
    {
        id: 'mewmory.errors', title: 'Mewmory error messages and smaller models', keys: ['Mewmory error', 'Mewmory context limit error', 'Mewmory failed', 'details the model got wrong', 'Messages per update', 'small model Mewmory'],
        sources: ['src/mewmory/models.js', 'src/mewmory/processing.js', mewmoryUi], anchors: ['tokens for this request and reserves', 'could not be reached or took too long', 'cannot read the information it needs', 'details the model got wrong were', 'Smaller batches use less space in the Facts and events model.'],
        content: 'Mewmory errors name the role. \'needs N tokens for this request and reserves M for the reply\' means that role\'s Context limit, tokens is too low: set it to what your service supports or, for Facts and events, lower Messages per update. \'could not be reached or took too long\' points to its connection or Timeout, seconds. \'cannot read the information it needs\' means a box under This role may read is unticked. Common slips from smaller models are repaired, and a single bad memory is skipped instead of failing the batch; Recent updates reports how many details the model got wrong were left out.',
    },
    {
        id: 'mewmory.hide-overflow', title: 'Hiding old messages that no longer fit', keys: ['Hide old messages that no longer fit', 'hide old messages', 'context too full', 'hidden messages Mewmory'],
        sources: [mewmoryUi, 'public/scripts/mewmory/index.js', 'src/mewmory/core.js'], anchors: ['Hide old messages that no longer fit', 'mewmoryKeepHidden'],
        content: 'Mewmory → Settings → Progress → Hide old messages that no longer fit counts back from the latest reply using your main context size and, after a confirmation, hides every older message from the prompt. The latest reply and the messages that fit stay visible. Mewmory keeps reading messages hidden this way, so their memories stay; ordinary hidden messages, by contrast, are switched off for Mewmory. It makes no model requests. If the chat changes while the question is open, nothing is hidden. Unhide any time with the eye button on a message.',
    },
    {
        id: 'mewmory.trackers', title: 'Tracker agent outputs in Mewmory', keys: ['tracker outputs Mewmory', 'Mewmory trackers', 'tracker notes memory', 'Mewmory reads trackers'],
        sources: ['src/mewmory/core.js', 'src/mewmory/contracts.js'], anchors: ['trackerOutputs', 'supplementary state, not dialogue'],
        content: 'Mewmory also reads completed outputs from Tracker-category agents attached to the accepted reply, labelled as supplementary state rather than dialogue, alongside the original message text. Only finished, non-empty tracker results on the selected swipe are included; rejected alternatives are not. The Facts and events role treats them as state reports: story evidence wins when they conflict, repeated tracker summaries do not count as new events, and a tracker mentioning a secret does not prove a character learned it. Nothing needs switching on beyond the tracker agents themselves.',
    },
    {
        id: 'mewmory.branches', title: 'Mewmory branches, continuations and transfers', keys: ['Mewmory branch', 'Link this continuation', 'export memory', 'restore memory', 'memory continuation'],
        sources: [mewmory, mewmoryUi], anchors: ['continuation', 'Continue a story from another chat', 'Export Mewmory', 'Choose a Mewmory export'],
        content: 'Native Roleplay branches copy the accepted matching prefix, then keep independent memory histories. In a chat with no memories yet, Settings → Continue a story from another chat → Earlier chat → Link this continuation copies that chat\'s memory and history; it is not an automatic merge. Export and restore → Export Mewmory saves the archive without API keys; Choose a Mewmory export previews which memories can be restored before Restore applies them as your own corrections. Restores are capped at 256 MiB. Mewmory does not provide Conversation DM memory.',
    },
    {
        id: 'conversation.memory', title: 'Conversation summary memory', keys: ['DM memory', 'Conversation memory', 'summary memory', 'copy memory to branch', 'related memory'],
        sources: ['public/scripts/neconyan-conversation/prompt.js', 'public/scripts/neconyan-conversation/constants.js', 'public/scripts/neconyan-conversation/timeline-render.js', 'docs/conversation-mode-glossary.md'], anchors: ['copy_memory_to_new_branch', 'include_related_memory', 'Remember group DMs in this solo DM', 'Clear memory'],
        content: 'Conversation uses summary memory scoped to its persona/thread/branch, separate from Mewmory and Roleplay history. In the DM\'s settings, Create memory, Refresh memory and Clear memory manage it; memory survives new chats and deleted histories until cleared. Copying memory into a new branch is on by default and has no visible switch. Remember group DMs in this solo DM (or Remember solo DMs in this group DM) starts off. Summaries make model requests. Clearing a summary does not delete messages, and retained messages may inform a later summary.',
    },
    {
        id: 'pathfinder.setup', title: 'Opening Pawthfinder and choosing books', keys: ['Pawthfinder', 'Pathfinder', 'retrieval lorebooks', 'Select Lorebooks', 'open Pawthfinder'],
        sources: [agents + 'pathfinder-settings.html', agents + 'pathfinder-settings-ui.js', agents + 'settings.html', agents + 'index.js', 'public/scripts/welcome-screen.js'], anchors: ['Enable Pawthfinder for', 'Select Lorebooks', 'Fine-tuning', 'Enable Pawthfinder submodule', 'Open Pawthfinder', 'Refresh List'],
        content: 'Open Pawthfinder from the sidebar\'s Fine-tuning section, Included tools → Pawthfinder → Settings, or Agents → Connections & defaults → Open Pawthfinder. Enable Pawthfinder submodule (same Agents page) must be on. The enable switch reads Enable Pawthfinder for all chats, or names individual or group chats when Keep individual and group chat switches separate is on; saving other settings does not change it. Select Lorebooks chooses sources, with options for attached books; Refresh List reloads them. Pawthfinder runs through Agents and is separate from the assistants\' built-in product help.',
    },
    {
        id: 'pathfinder.retrieval', title: 'Pawthfinder Tool Mode and Predictive Pipeline', keys: ['Predictive Pipeline', 'Tool Mode', 'Two-Stage', 'Single-Pass', 'retrieval timeout', 'Max Candidates'],
        sources: [agents + 'pathfinder-settings.html', agents + 'pathfinder/sidecar-retrieval.js', agents + 'pathfinder/tools/search.js'], anchors: ['Predictive Pipeline', 'Max Candidates', 'Connection Profile for Pipeline', 'Use main model'],
        content: 'Tool Mode lets a model with tool/function calling browse, search and edit lorebook entries. Predictive Pipeline retrieves lore before each reply using extra model requests: Pipeline Type Two-Stage selects candidates then filters them, Single-Pass selects only. Connection Profile for Pipeline can use a cheaper profile or Use main model. Entry Content Mode, Truncate Length and Max Candidates shape supplied material. Retrieval Timeout only shows a slow-retrieval warning; generation still waits. Skip entries already activated by World Info avoids duplicates. Enabling both modes uses more tokens.',
    },
    {
        id: 'agents.start', title: 'Creating, enabling and stopping Agents', keys: ['Agents', 'Create agent', 'Browse library', 'Before reply', 'After reply', 'agent not running'],
        covers: ['extension:in-chat-agents'], sources: [agents + 'settings.html', 'docs/in-chat-agents-glossary.md'], anchors: ['Create agent', 'Browse library', 'Manage agents', 'Connections &amp; defaults'],
        content: 'Open Agents; the Manage agents and Connections & defaults buttons switch views on desktop and phone. Use Create agent or Browse library. The list has All, Pinned, Before reply, After reply and Companions views, plus search and a category filter. The master Agents On switch and each agent\'s own switch are separate and apply across chats. Pausing the master prevents future runs; Stop agent interrupts an active run. Before-reply work affects preparation, after-reply work processes the response, and companions save separate notes. Each enabled run may make extra model requests.',
    },
    {
        id: 'agents.setups', title: 'Saved agent setups, templates and tracker repair', keys: ['Saved setup', 'Save setup', 'Fix trackers', 'Update templates', 'Reset bundled agents', 'import agents'],
        sources: [agents + 'settings.html'], anchors: ['Save setup', 'Fix trackers', 'Move trackers to companions', 'Export agents'],
        content: 'Saved setup records your agents and switches; Load applies one without deleting other agents. It is not a model preset or UI theme. More tools holds Update templates (shown only when a bundled template is newer), Fix trackers, Activity & companions, Move trackers to companions, Import agents, Export agents and Reset bundled agents. Fix trackers reruns enabled trackers on the last reply and may call models. Reset bundled agents restores bundled agents only, not custom ones. Export valuable custom work before updates or resets.',
    },
    {
        id: 'agents.connections', title: 'Agent connections and concurrency', keys: ['agent connection', 'Companion connection profile', 'Run together', 'Run one at a time', 'agent order', 'companions alongside'],
        sources: [agents + 'settings.html', agents + 'agent-runner.js'], anchors: ['Connections &amp; defaults', 'Run companions alongside post-generation passes', 'Default connection profile'],
        content: 'Connections & defaults → Default connection profile sets the shared agent connection (Current connection follows the active profile); a per-agent override takes precedence. Companion connection profile can use its own profile or Default connection. Under Execution rhythm, Append agents and Companion agents can Run together or Run one at a time, which follows each agent\'s Order. Run companions alongside post-generation passes lets companions start before rewrites finish. Running together is not cheaper and may hit provider rate limits.',
    },
    {
        id: 'agents.interruptions', title: 'Interrupted agent runs, retries and Stop', keys: ['agent interrupted', 'agent retry', 'agents did not apply', 'Agent work was interrupted', 'Stop agent', 'cancel agents'],
        sources: [agents + 'agent-runner.js', agents + 'companion/companion-runner.js'], anchors: ['POST_PROCESSING_MAX_RETRIES = 2', 'Agent work was interrupted before it finished'],
        content: 'If after-reply agent work fails or is interrupted, Agents retries the whole run automatically up to two more times, only while that reply is unchanged; it waits up to 30 seconds for a reply that is still generating. Stop never triggers a retry. Each retry makes model requests again. If it still fails, a warning says Agent work was interrupted before it finished; the reply is left unchanged and the run is not marked done, so you can run the agents again. Stop agent cancels the whole operation: remaining passes, utility steps and companions do not start, and queued runs send nothing.',
    },
    {
        id: 'agents.history', title: 'Viewing agent changes to a reply', keys: ['View agent changes', 'agent history', 'agent rewrite history', 'agent changes disappeared', 'Dialogue Colors agent history'],
        sources: [agents + 'agent-runner.js', 'public/script.js', 'public/index.html'], anchors: ['View agent changes', 'agentName: \'Edited\''],
        content: 'When agents rewrite a reply, the message shows a View agent changes button listing each agent\'s step. That history now survives Dialogue Colors recolouring, including its colour tags and trailing colour list, so recolouring alone no longer hides it. Editing the reply yourself after the agents adds an Edited step instead of discarding earlier agent steps; editing back to an earlier version counts as an undo rather than a new step. History belongs to the active swipe.',
    },
    {
        id: 'agents.companion-panel', title: 'Companion Panel button and hiding it', keys: ['Companion Panel', 'hide floating button', 'companion handle', 'companion button', 'Top bar button'],
        sources: [agents + 'companion/companion-panel.js', agents + 'settings.html'], anchors: ['Hide the floating button', 'Companion panel button', 'Floating side button', 'Top bar button', 'Companion Panel'],
        content: 'The Companion Panel shows companions set to Tracker panel only. Agents → Connections & defaults → Companion panel button chooses Floating side button or Top bar button; only one shows at a time. The panel header and button use a cat icon. With the floating button, the panel header\'s Hide the floating button removes it; bring it back by choosing Companion Panel from the Extensions menu, which reopens the panel and restores the button. The floating button is also hidden while Agents are off or in Conversation mode.',
    },
    {
        id: 'agents.memory-shard', title: 'Memory Shard and hiding summarised messages', keys: ['Memory Shard', 'Hide summarised messages', 'hide summarized messages', 'compress chat history'],
        sources: [agents + 'companion/companion-panel.js', agents + 'templates/memory-shard-companion.json', 'src/mewmory/core.js'], anchors: ['Hide summarised messages', '"minContextTokens": 30000'],
        content: 'Memory Shard is a library companion that writes a compact summary in the Companion Panel once the chat reaches about 30,000 tokens and feeds the latest shard back into context; each run is a model request. Its Hide summarised messages button hides only the unchanged, visible messages that shard actually summarised; older messages outside the summary stay. It asks first, and nothing is hidden if the chat changed meanwhile. Unhide later with each message\'s eye button. This is an ordinary hide, so Mewmory stops reading those messages.',
    },
    {
        id: 'memory.vectors', title: 'Vectorization and indexed retrieval', keys: ['Vectorization', 'Vector Storage', 'embeddings', 'vectorise', 'index attachments', 'semantic search', 'Miso vector tutorial'],
        covers: ['extension:vectors'], sources: ['public/scripts/extensions/vectors/settings.html', 'public/scripts/extensions/vectors/workspace.js', 'src/operations/vector-prompt.js', 'src/operations/vectors.js'], anchors: ['embedding', 'Rebuild chat', 'Search index'],
        content: 'Open Included tools / Built-in extension settings, then Vectorization (formerly Vector Storage). Its sections are Connection, Chats, Files, Lorebooks, Try a search and Saved work. Learn with Miso starts a replayable tutorial with saved progress. Choose an embedding provider and model independently of the chat model. Local (Transformers) runs on the server; WebLLM requires an open browser; hosted providers use saved Connections credentials. Enable chat, file or lorebook retrieval separately. Index sources manually even when retrieval is off. Rebuild applies changed chunking or summary settings while retaining the previous index until successful replacement. Try a search queries existing indexes and shows chunks, source positions and similarity scores without generating a reply or rebuilding. Its count and threshold are test-only; scores are not confidence percentages. Chat protection excludes recent messages before selecting distinct older messages. Lorebook insertion rules still apply. Saved work exposes persistent jobs and cancellation. Clearing an index keeps source text, but enabled retrieval may rebuild it. Vectorization is separate from Mewmory, Pawthfinder and Conversation summaries; indexes are not backups.',
    },
];
