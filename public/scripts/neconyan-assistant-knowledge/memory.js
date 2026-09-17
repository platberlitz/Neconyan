const world = 'public/scripts/world-info.js';
const agents = 'public/scripts/extensions/in-chat-agents/';
const mewmory = 'docs/mewmory.md';

export default [
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
        id: 'lorebooks.editing', title: 'Lorebook entry tools and history', keys: ['lorebook history', 'LoreStitch', 'Entry tools', 'merge entries', 'lorebook search replace', 'delimiters'],
        sources: ['public/scripts/neconyan-lorebook-tools.js', 'public/scripts/templates/neconyanLorebookTools.html'], anchors: ['History'],
        content: 'Lorebook History and Entry tools provide integrated editing functions, including search/replace, delimiter operations, merging and export. LoreStitch-related features are part of these controls, not necessarily a standalone workspace. Review the selected entries and changes before applying a bulk operation. Export first when you need an independent rollback copy; entry history, whole-book export and Time Machine snapshots are different recovery mechanisms.',
    },
    {
        id: 'memory.distinctions', title: 'Choosing the right memory system', keys: ['memory systems', 'remember things', 'forgetting', 'clear memory', 'memory difference'],
        covers: ['core:memory'], sources: [mewmory, 'docs/conversation-mode-glossary.md', agents + 'pathfinder-settings.html'], anchors: ['Mewmory'],
        content: 'Neconyan has several separate memory features. Mewmory preserves source-backed Roleplay facts and character viewpoints. Conversation maintains its own DM summaries. Pawthfinder retrieves lorebook entries and supports notebook-related tools. Agents can write their own outputs, and Vector Storage retrieves indexed text. Enabling, clearing or backing up one does not automatically operate on the others. First identify the active mode and memory feature before giving deletion or troubleshooting instructions.',
    },
    {
        id: 'mewmory.setup', title: 'Setting up Mewmory with saved connections', keys: ['Mewmory setup', 'enable Mewmory', 'memory connection profile', 'Facts and events', 'Pawspective setup'],
        covers: ['core:mewmory'], sources: [mewmory, 'public/scripts/mewmory/ui.js', 'src/mewmory/models.js'], anchors: ['Save configuration', 'Connection profile', 'localOnly: false', 'allowRemote: true', 'Backfill this chat'],
        content: 'Open a saved Roleplay character/group chat, then Mewmory → Settings. Configure Facts and events, Pawspective and recall-selector roles using a saved Connection profile or a manual OpenAI-compatible endpoint/model. A role Model override keeps the profile\'s connection credentials. Embeddings and fallback are optional. New configurations allow remote requests; Local-only model requests and each role\'s Allow story data to be sent to this remote endpoint control access. Existing saved configurations retain their choices. Choose Save configuration and wait for Configuration saved, then enable Use Mewmory in this chat. Backfill this chat processes earlier accepted messages and can make model requests.',
    },
    {
        id: 'mewmory.tokenizers', title: 'Mewmory models, token counting and context', keys: ['Mewmory tokenizer', 'Auto match this model', 'memory context limit', 'Mewmory model override'],
        sources: [mewmory, 'src/mewmory/tokens.js', 'src/mewmory/models.js'], anchors: ['tokenizer'],
        content: 'Each Mewmory role can use a model independent of the reply writer. Auto (match this model) chooses a local tokenizer from that role\'s model name; family matching is approximate and unknown models use a fallback. An explicit tokenizer can be selected when appropriate. The writer\'s Auto uses the application\'s selected tokenizer. New chat roles default to a 16,000-token output limit; existing saved limits remain unchanged. Check each role\'s context/output limits and saved configuration; selecting a profile does not guarantee its model supports embeddings or the required request format.',
    },
    {
        id: 'mewmory.inspect', title: 'Inspecting facts and Pawspective', keys: ['Pawspective', 'memory archive', 'Mewmory Now', 'memory sources', 'character beliefs'],
        sources: [mewmory, 'public/scripts/mewmory/ui.js'], anchors: ['Pawspective', 'Recall'],
        content: 'Mewmory\'s Now, Pawspective, Archive, Recall and Settings views separate current facts, character viewpoints, retained material and retrieval. Inspect source references before accepting a disputed fact. Pawspective uses imagined interviews for AI-owned characters, not the player; interview gestures are not objective story events. Reported information and character beliefs are not automatically true. Only eligible sources and what the character can know should support a viewpoint.',
    },
    {
        id: 'mewmory.corrections', title: 'Correcting, excluding and deleting Mewmory records', keys: ['correct memory', 'delete Mewmory', 'exclude memory', 'unsupported memory', 'unlearned', 'pin memory'],
        sources: [mewmory, 'public/scripts/mewmory/ui.js'], anchors: ['unsupported', 'knowledge a character never acquired'],
        content: 'Inspect a Mewmory record and its sources, owner and subjects before correcting it. Corrections can distinguish suspicion, unsupported, unlearned, resolved or background information, and pin/exclude records. Exclusion retains material for inspection but makes it ineligible for recall. Deleting a source triggers reconciliation of dependent records; undo cannot revive a rejected source. Separate branches, backups and exports may still contain copies. Do not equate hiding a chat message with erasing every stored memory.',
    },
    {
        id: 'mewmory.preservation', title: 'Mewmory preservation and generation failures', keys: ['Mewmory preservation', 'backfill', 'checkpoint', 'memory blocked reply', 'recent chat target'],
        sources: [mewmory, 'src/mewmory/models.js'], anchors: ['preservation'],
        content: 'Mewmory processes accepted chat revisions and applicable enabled lore sources while preserving originals. Replies use quick local search and completed AI selections; embeddings and fresh AI recall run alongside the writer, with new selections available for later replies. Extraction, interviews and preservation also run separately. The default recent-chat target is 30,000 tokens. Older messages leave the outgoing prompt only after their current revisions finish preservation. Failed preservation keeps those messages in the prompt; generation stops if the retained context cannot fit. Inspect the failing role, fix its connection or limits, save and retry. Background model requests can consume provider credits.',
    },
    {
        id: 'mewmory.branches', title: 'Mewmory branches, continuations and transfers', keys: ['Mewmory branch', 'Link this continuation', 'export memory', 'restore memory', 'memory continuation'],
        sources: [mewmory, 'public/scripts/mewmory/ui.js'], anchors: ['continuation'],
        content: 'Native Roleplay branches copy the accepted matching prefix, then keep independent memory histories. Link this continuation explicitly connects a continuation to a compatible archive; it is not an automatic merge of unrelated chats. Export/restore transfers memory material, not the chat itself or model credentials. Restore previews eligible sources and recomputes coverage. Mewmory does not provide Conversation DM memory; use the DM\'s separate summary controls there.',
    },
    {
        id: 'conversation.memory', title: 'Conversation summary memory', keys: ['DM memory', 'Conversation memory', 'summary memory', 'copy memory to branch', 'related memory'],
        sources: ['public/scripts/neconyan-conversation/prompt.js', 'public/scripts/neconyan-conversation/constants.js', 'docs/conversation-mode-glossary.md'], anchors: ['copy_memory_to_new_branch', 'include_related_memory'],
        content: 'Conversation uses summary memory scoped to its persona/thread/branch, separate from Mewmory and Roleplay history. Inspect/edit or clear the relevant DM summary when it contains a mistake. Copy memory to a new branch and Include related memory are separate settings; copying starts enabled and related memory starts disabled. Summary generation can make model requests. Clearing a summary does not delete the underlying messages, and retained messages may inform a later summary again.',
    },
    {
        id: 'pathfinder.setup', title: 'Enabling Pawthfinder and choosing books', keys: ['Pawthfinder', 'Pathfinder', 'retrieval lorebooks', 'Select Lorebooks'],
        sources: [agents + 'pathfinder-settings.html', agents + 'pathfinder/pathfinder-tool-bridge.js'], anchors: ['Enable Pawthfinder for this chat', 'Select Lorebooks'],
        content: 'Open Included tools → Pawthfinder → Settings. Enable Pawthfinder for this chat is a per-chat switch; saving other settings does not turn it on. Select Lorebooks chooses its sources, with options for attached/contextual books and exclusions. Refresh List reloads available books. Disabled or agent-inaccessible entries are not ordinary readable sources. Pawthfinder works through Agents and is separate from the assistants\' automatically supplied product-help reference.',
    },
    {
        id: 'pathfinder.retrieval', title: 'Pawthfinder Tool Mode and Predictive Pipeline', keys: ['Predictive Pipeline', 'Tool Mode', 'Two-Stage', 'Single-Pass', 'retrieval timeout', 'Max Candidates'],
        sources: [agents + 'pathfinder-settings.html', agents + 'pathfinder/sidecar-retrieval.js', agents + 'pathfinder/tools/search.js'], anchors: ['Predictive Pipeline', 'Max Candidates'],
        content: 'Tool Mode lets a supported function-calling model browse lorebook categories and entries. Predictive Pipeline retrieves before the reply using additional model requests: Two-Stage selects candidates then filters their contents, while Single-Pass uses one selection pass. Choose the pipeline Connection Profile or use the main model. Entry Content Mode, Truncate Length and Max Candidates affect supplied material. Retrieval Timeout is a slow-request warning, not guaranteed cancellation. Skip entries already activated by World Info avoids duplicate context.',
    },
    {
        id: 'agents.start', title: 'Creating, enabling and stopping Agents', keys: ['Agents', 'Create agent', 'Browse library', 'Before reply', 'After reply', 'agent not running'],
        covers: ['extension:in-chat-agents'], sources: [agents + 'settings.html', 'docs/in-chat-agents-glossary.md'], anchors: ['Create agent', 'Browse library'],
        content: 'Open Agents and use Create agent or Browse library. Manage agents has All, Pinned, Before reply, After reply and Companions views. The master Agents On switch and each agent\'s own switch are separate; switches apply across chats. Pausing the master prevents future runs; Stop agent interrupts an active run. Before-reply work affects preparation, after-reply work processes the response, and companions have their own presentation. Each enabled run may make extra model requests.',
    },
    {
        id: 'agents.setups', title: 'Saved agent setups, templates and tracker repair', keys: ['Saved setup', 'Save setup', 'Fix trackers', 'Update templates', 'Reset bundled agents', 'import agents'],
        sources: [agents + 'settings.html'], anchors: ['Save setup', 'Fix trackers'],
        content: 'Saved setup records an agent configuration you can Load later; loading does not delete unrelated agents. It is not a model preset or UI theme. More tools provides Update templates, Fix trackers, Activity & companions, import/export and Reset bundled agents. Fix trackers reruns enabled last-reply trackers and may call models. Reset bundled agents concerns bundled definitions, not every custom agent. Export valuable custom work before replacements or resets and inspect the review dialogue.',
    },
    {
        id: 'agents.connections', title: 'Agent connections and concurrency', keys: ['agent connection', 'Companion connection profile', 'Run together', 'Run one at a time', 'agent order', 'companions alongside'],
        sources: [agents + 'settings.html', agents + 'agent-runner.js'], anchors: ['Connections &amp; defaults', 'Run companions alongside post-generation passes'],
        content: 'Connections & defaults sets the shared agent connection; a per-agent override takes precedence. Companion connection profile can use its own profile or the shared default. Append agents and companions can Run together or Run one at a time using Order. Run companions alongside post-generation passes allows overlap with post-reply work. Dependencies and feedback can require ordering; parallel execution is not automatically cheaper and may hit provider request limits.',
    },
    {
        id: 'memory.vectors', title: 'Vector Storage and indexed retrieval', keys: ['Vector Storage', 'embeddings', 'vectorise', 'index attachments', 'semantic search'],
        covers: ['extension:vectors'], sources: ['public/scripts/extensions/vectors/settings.html', 'public/scripts/extensions/vectors/index.js'], anchors: ['embedding'],
        content: 'Vector Storage indexes supported chat/file text using an embedding provider, then retrieves related passages for a request. Configure its source/model and any required service first; indexing and queries may make provider requests. Changing embedding models can require rebuilding the index because their numerical representations differ. Retrieval count/threshold and placement affect context usage. An index is not a complete independent backup, and Vector Storage is separate from Mewmory\'s own optional embeddings.',
    },
];
