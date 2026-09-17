const shell = 'public/scripts/neconyan-tabs.js';
const home = 'public/scripts/welcome-screen.js';
const html = 'public/index.html';
const chat = 'public/script.js';

export default [
    {
        id: 'start.overview', title: 'What Neconyan supplies', keys: ['Neconyan', 'getting started', 'first chat', 'SillyTavern', 'offline app'],
        covers: ['core:onboarding'], sources: ['PRODUCT.md', home, shell], anchors: ['Roleplay', 'Conversation'],
        content: 'Neconyan is a self-hosted character-chat app with Roleplay, Conversation, Meower and Story Mode. You supply a connection to a text model; installing the app does not supply paid model access. Set up Connections, choose a model, then open or import a character and start a chat. Home offers Miso, Taro and Nori as assistants. SillyTavern-compatible files are supported, but upstream menu instructions may not match Neconyan. Self-hosting keeps application data on your server; configured model providers and optional online features still receive requests.',
    },
    {
        id: 'navigation.workspace', title: 'Finding workspaces on desktop and phone', keys: ['sidebar', 'workspace menu', 'phone menu', 'navigation', 'where are settings', 'mobile navigation'],
        covers: ['core:navigation'], sources: [home, shell], anchors: ['Included tools', 'Fine-tuning'],
        content: 'Use the workspace sidebar on desktop. On a phone, open the top-bar workspace menu to reach the same destinations. Home, Characters, Connections, Personas and the writing workspaces live there; Fine-tuning contains the prompt and generation controls. Included tools expands into named tools and their Open or Settings actions. Mode choices are Roleplay, Conversation, Meower and Story Mode. A tool may require an active character/chat or an enabled extension. There is no application-wide Advanced mode switch to reveal missing settings.',
    },
    {
        id: 'navigation.search', title: 'Finding a setting with Search', keys: ['settings search', 'search settings', 'missing control', 'find setting', 'advanced mode'],
        sources: [shell, 'public/scripts/neconyan-settings-tabs.js'], anchors: ['Appearance', 'Cache & Account'],
        content: 'Use the workspace Search to find a control by its visible label. Selecting a result opens its workspace and reveals the relevant section. Search results depend on loaded controls, enabled extensions and current context. General Settings has Appearance, Chat & Writing, System & Device and Cache & Account. Included tools have their own pages. If a documented control is absent, check its prerequisites and whether its extension is enabled; ask for the current mode and a screenshot rather than inventing an alternative menu.',
    },
    {
        id: 'start.tour', title: 'First paws tour', keys: ['First paws', 'tour', 'onboarding tour', 'replay tour'],
        sources: [home], anchors: ['First paws'],
        content: 'First paws is the introductory tour available from Home. It opens a side panel and takes you to the relevant workspaces. You can leave the panel and resume the tour. Use it to learn navigation and the first-connection workflow; it does not create provider credentials or make an unconfigured model available.',
    },
    {
        id: 'assistants.identity', title: 'Choosing and updating Miso, Taro and Nori', keys: ['Miso', 'Taro', 'Nori', 'assistant picker', 'assistant variant', 'update assistant'],
        covers: ['core:assistants'], sources: [home, 'src/endpoints/characters.js', 'default/content/assistants/manifest.json'], anchors: ['neconyan_assistant'],
        content: 'Choose an assistant on Home, then a male, female or neutral variant. Each personality has three variants. Reopening an installed variant reuses its card and chat. An offered updated copy is separate so your existing edits and chats survive. All marked bundled assistants share the application\'s current help reference, including older or renamed copies. Assigning an ordinary character to the Assistant shortcut does not turn it into a bundled assistant. Exported cards used outside Neconyan do not carry this runtime reference.',
    },
    {
        id: 'assistants.actions', title: 'What the assistants can actually change', keys: ['assistant tools', 'can you change settings', 'assistant permissions', 'edit for me', 'create a character for me'],
        sources: ['public/scripts/neconyan-assistant-tools.js', 'public/scripts/tool-calling.js'], anchors: ['userConfirmed', 'Neconyan_Assistant_'],
        content: 'In a supported individual Roleplay assistant chat, available function tools can list/read lorebooks, agents, model presets and characters; edit allowed fields; and create a character. Writes require a review popup. These are not general screen-control or arbitrary settings-editing tools. Group chats and Conversation do not supply this assistant tool set. Provider/model support and the function-calling setting determine availability. The help reference works without those tools. Give steps when you cannot perform an action; report success only after a successful tool result. Never ask for API keys in the chat.',
    },
    {
        id: 'characters.library', title: 'Opening and organising characters', keys: ['character library', 'find character', 'favourite character', 'character tags', 'bulk characters'],
        covers: ['core:characters'], sources: [html, chat, shell], anchors: ['character'],
        content: 'Open Characters to browse the library, search, filter by tags and use favourites. Select a character to open its chat or editor. Character cards define the AI\'s identity; Personas define yours. Bulk selection is a separate library action, so enter selection mode before acting on several cards. Importing a card and starting a new chat are different actions; opening an existing card normally resumes its selected chat.',
    },
    {
        id: 'characters.edit', title: 'Creating and editing a character card', keys: ['create character', 'edit character', 'character description', 'personality field', 'scenario field', 'character note'],
        sources: [html, shell, chat], anchors: ['creator_notes', 'personality'],
        content: 'Use the character editor to set the name, avatar, description, personality, scenario, first message and example dialogue. Character Notes are instructions for the model; creator notes are information for readers, with mode-specific handling. The editor also exposes metadata and prompt overrides. Follow its save-status indicator; a failed save is not success, and Retry preserves the draft. A new card needs to be created before it has saved chats. Changing a first message does not replace messages already stored in an existing chat.',
    },
    {
        id: 'characters.greetings', title: 'First messages and alternate greetings', keys: ['first message', 'alternate greetings', 'greeting', 'example dialogue', 'mes_example'],
        sources: [html, chat], anchors: ['alternate_greetings', 'mes_example'],
        content: 'A character\'s first message starts a new chat. Alternate greetings supply other starts; message swipes select alternatives where offered. Example dialogue demonstrates voice and formatting for the model and consumes prompt space when included. Editing a greeting in the card does not rewrite a saved conversation. Use a fresh chat to see the new opening, keeping the earlier chat if you want its history.',
    },
    {
        id: 'characters.import-export', title: 'Importing and exporting character cards', keys: ['import character', 'export character', 'character PNG', 'card JSON', 'download card', 'duplicate card'],
        sources: ['src/endpoints/characters.js', 'public/scripts/templates/importCharacters.html', html], anchors: ['importFromPng', 'importFromJson'],
        content: 'Use Characters\' import action for supported character PNG or JSON files. A character PNG contains card data as well as artwork; an ordinary image is not automatically a complete card. The URL-import dialogue accepts supported sources, not every website. Review replacement choices before overwriting an existing card. Export the card from its character actions to share its definition. Chats, account settings, connection secrets and every extension\'s account-local configuration are not all bundled into a card export. Use the relevant export for each.',
    },
    {
        id: 'personas.identity', title: 'Creating and selecting a persona', keys: ['persona', 'my name', 'user identity', 'change my avatar', 'who am I'],
        covers: ['core:personas'], sources: [html, 'public/scripts/personas.js'], anchors: ['persona_description'],
        content: 'Open Personas to create/select your chat identity, set its name and image, and write its description. This describes the user to the model, separately from the AI character card and account sign-in profile. Select the intended persona before starting a thread. In Conversation, persona identity also separates DM histories; switching personas can show a different history rather than deleting the previous one.',
    },
    {
        id: 'personas.scenario-notes', title: 'Persona Scenario Notes', keys: ['Scenario Notes', 'persona notes', 'final description', 'scenario note'],
        sources: [html, 'public/scripts/personas.js'], anchors: ['Scenario Notes'],
        content: 'In Personas, use Scenario Notes for additional situation-specific information. Multiple active notes can contribute to the composed persona description. Check the final description preview to see what the model will receive. These notes belong to your persona context and are separate from the character\'s Scenario field, the chat\'s Author\'s Note and Conversation\'s own instructions.',
    },
    {
        id: 'personas.locks', title: 'Persona locks and defaults', keys: ['persona lock', 'default persona', 'wrong persona', 'lock to chat', 'lock to character'],
        sources: ['public/scripts/personas.js', html], anchors: ['persona'],
        content: 'Persona locks choose the identity automatically: a chat-specific lock takes priority over a character/group lock, which takes priority over the default persona. If the wrong persona returns when you open a chat, inspect these locks before changing the default repeatedly. Persona backup/restore is separate from character-card export. A persona-linked lorebook contributes user-related lore; it is not the persona\'s description itself.',
    },
    {
        id: 'chat.histories', title: 'Starting and reopening Roleplay chats', keys: ['new chat', 'old chat', 'rename chat', 'chat history', 'recent chats', 'temporary chat'],
        covers: ['mode:roleplay'], sources: [chat, home, 'public/scripts/templates/assistantNote.html'], anchors: ['chat_metadata'],
        content: 'Open a character, then use its chat actions to start a new chat or choose an existing history. Home\'s recent chats provides another route back. New chats have separate histories; renaming a chat changes its label, not its character definition. Temporary chats are not a substitute for a saved character chat: transfer anything you want to keep using their provided controls. A character export is not a chat export.',
    },
    {
        id: 'chat.message-actions', title: 'Editing, deleting and hiding messages', keys: ['edit message', 'delete message', 'hide message', 'exclude from prompt', 'message actions'],
        sources: [chat, html], anchors: ['is_system'],
        content: 'Use the message\'s actions to edit its text and confirm the edit, or cancel to keep the original. Deletion removes stored chat content; review the confirmation, especially for a range of messages. Hiding/excluding a message from the outgoing prompt is different from deleting it. It can remain visible or stored while no longer supplying normal model context. Memory systems and backups have their own source reconciliation and retention rules, so hiding text is not a promise that every copy has been erased.',
    },
    {
        id: 'chat.generation-actions', title: 'Regenerate, swipe, continue and impersonate', keys: ['regenerate', 'swipe reply', 'continue reply', 'impersonate', 'retry reply', 'stop generating'],
        sources: [chat, html], anchors: ['impersonate', 'swipe'],
        content: 'Regenerate asks for another reply to the same context. Swipes store alternative versions of a message; the selected version is used as the current one. Continue asks the model to extend the current reply rather than creating a new user turn. Impersonate generates text as the user, so inspect it before sending. Stop interrupts an active request but cannot undo provider usage already incurred. These actions can make model requests; moving to an already saved swipe does not itself require a new completion.',
    },
    {
        id: 'chat.branches', title: 'Branches and checkpoints', keys: ['branch', 'checkpoint', 'alternate timeline', 'fork chat', 'bookmark'],
        sources: ['public/scripts/bookmarks.js', chat], anchors: ['main_chat'],
        content: 'Use the chat/message branch or checkpoint actions to keep an alternate continuation from a selected point. A branch is a separate saved history, not a second visible swipe. Later edits in one history are not automatically merged into another. Mewmory copies only an accepted matching prefix for native branches. Conversation has its own branch system and a separate option controlling copied DM summary memory.',
    },
    {
        id: 'chat.authors-note', title: 'Author’s Note and prompt depth', keys: ['authors note', 'author\'s note', 'author note', 'prompt depth', 'injection depth'],
        sources: ['public/scripts/authors-note.js', html], anchors: ['note_depth'],
        content: 'Author\'s Note supplies extra instructions or scene reminders in the chat prompt. Its depth sets where it appears relative to recent messages, and its frequency controls when it is inserted. It consumes context when active. Keep it separate from the character\'s permanent description and creator notes. Conversation has its own Author\'s Note setting, so changing the Roleplay note does not reliably change a DM\'s instructions.',
    },
    {
        id: 'groups.roleplay', title: 'Roleplay groups and who speaks', keys: ['roleplay group', 'group chat', 'group members', 'speaker order', 'joined character cards'],
        covers: ['core:groups'], sources: ['public/scripts/group-chats.js', html], anchors: ['disabled_members'],
        content: 'Create a Roleplay group and add character cards as members. Group controls determine speaker selection, order and whether a member is disabled. Individual-card prompting uses the selected speaker; joined-card prompting combines definitions and can use more context. A Roleplay group is separate from a Conversation group DM and a Meower cast. Disable a member to stop its normal turns without assuming its card or earlier messages have been deleted. Group-specific prompts and settings can override single-character behaviour.',
    },
    {
        id: 'chat.formatting', title: 'Formatting chat text', keys: ['markdown', 'bold', 'italic', 'quotation marks', 'code block', 'format text'],
        covers: ['core:formatting'], sources: ['public/scripts/templates/formatting.html', chat], anchors: ['messageFormatting'],
        content: 'Chat supports Markdown-style emphasis and code blocks, subject to the app\'s formatter and sanitisation. Straight and curly double-quoted dialogue can receive the theme\'s quote colour; code sections are excluded from normal quotation colouring. Explicit colour tags or extension display transforms can override that appearance. Conversation normally requests plain DM text, so its presentation and prompt instructions differ from Roleplay. A display-only transformation is not necessarily a change to the stored message.',
    },
    {
        id: 'chat.shortcuts', title: 'Keyboard shortcuts and input history', keys: ['keyboard shortcuts', 'hotkeys', 'shortcut keys', 'input history', 'previous input'],
        sources: ['public/scripts/templates/hotkeys.html', 'public/scripts/extensions/input-history/index.js'],
        covers: ['extension:input-history'], anchors: ['input'],
        content: 'Open the built-in Help hotkeys reference for current keyboard actions. Input History retains previous composer inputs and offers history navigation; its settings control the retained length and buttons. Recalling an input is not the same as restoring a deleted chat message or selecting an AI swipe. Review recalled text before sending, particularly if the active character or persona has changed.',
    },
    {
        id: 'commands.slash', title: 'Slash commands and scripts', keys: ['slash command', 'STscript', 'command help', 'automate commands'],
        covers: ['core:commands'], sources: ['public/scripts/slash-commands/SlashCommandParser.js', 'public/scripts/templates/help.html'], anchors: ['SlashCommandParser'],
        content: 'Slash commands are typed commands handled by the app and extensions. Use the built-in command help/autocomplete to check the installed command, arguments and aliases before running it. Commands may send messages, change settings or run model requests; they are not all harmless text insertion. Extension commands exist only when that extension registers them. If a command\'s syntax is not in the supplied reference, ask for its help text rather than inventing flags or claiming it ran.',
    },
    {
        id: 'extensions.management', title: 'Included tools and extension management', keys: ['included tools', 'built in extensions', 'custom extensions', 'install extension', 'extension disabled', 'update extensions'],
        covers: ['core:extensions'], sources: ['src/neconyan-native-extensions.js', 'public/scripts/extensions.js', 'public/scripts/neconyan-settings-tabs.js'], anchors: ['Neconyan-Hopper'],
        content: 'Included tools opens the release-owned tool workspaces. Other shipped extension controls are in Extensions, with built-in/custom organisation. Enabled and configured are separate states: a tool needing a provider can be enabled but unusable until connected. Release-owned tools are maintained with Neconyan; importing an upstream duplicate does not safely replace the bundled copy and can leave it inactive. Arbitrary newly installed extensions are outside the bundled help reference. Check their installed documentation and permissions rather than guessing their features.',
    },
];
