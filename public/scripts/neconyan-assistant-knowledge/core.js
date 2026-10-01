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
        id: 'navigation.workspace', title: 'Finding workspaces on desktop and phone', keys: ['sidebar', 'workspace menu', 'phone menu', 'navigation', 'where are settings', 'mobile navigation', 'Troubleshooting', 'Finer-tuning', 'report a bug', 'report an issue', 'GitHub issues'],
        covers: ['core:navigation'], sources: [home, shell], anchors: ['Included tools', 'Fine-tuning', 'Troubleshooting'],
        content: 'Use the workspace sidebar on desktop; on a phone, the top-bar Open menu button shows the same destinations. Workspace holds Home, Characters, Connections (plug icon), Agents, Mewmory, Lorebooks and Extensions. Fine-tuning holds Presets, Sampling, Formatting, Regexes, Character Expressions, Persona, Pawthfinder, Dialogue Colors, Quick Image Gen and Background. Troubleshooting holds Server, Console Logs and Report an Issue, which opens the Neconyan GitHub issues page (github.com/platberlitz/Neconyan/issues) in a new tab so bugs can be reported there. Modes lists Roleplay, Conversation, Meower and Story Mode. Included tools expands into named tools with Open or Settings actions, and Recent lists recent chats. A tool may require an active character/chat or an enabled extension. There is no application-wide Advanced mode switch to reveal missing settings.',
    },
    {
        id: 'navigation.search', title: 'Finding a setting with Search', keys: ['settings search', 'search settings', 'missing control', 'find setting', 'advanced mode'],
        sources: [shell, home, 'public/scripts/neconyan-settings-tabs.js'], anchors: ['Appearance', 'Cache & Account'],
        content: 'Use Search at the bottom of the workspace sidebar (shortcut /), or Find a setting on Home, to find a page or a control by its visible label. Page names such as Sampling, Mewmory or Dialogue Colors appear first under Pages; settings show the section they sit in. Words match the start of a word, so temp finds Temperature. Selecting a result opens its workspace and reveals the relevant section. Results depend on loaded controls, enabled extensions and current context. Settings has Appearance, Chat & Writing, System & Device and Cache & Account. Included tools have their own pages. If a documented control is absent, check its prerequisites and whether its extension is enabled; ask for the current mode and a screenshot rather than inventing an alternative menu.',
    },
    {
        id: 'navigation.update-toast', title: 'The Update available corner notice', keys: ['Update available', 'update toast', 'update notification', 'new changes notice'],
        sources: [shell], anchors: ['Update available', 'Open Server to update.'],
        content: 'When a git-installed Neconyan server is behind its upstream repository, an Update available notice appears in the corner saying how many new changes exist and Open Server to update. Selecting it opens Troubleshooting → Server; the Dismiss (×) button closes it. The app checks when it loads and then every 30 minutes, and each browser remembers which update it already announced, so the same version is not announced twice. Accounts that are refused server status stop checking and never see it. The notice installs nothing by itself. The Server page offers updating for supported installations; launcher, source ZIP and Android APK updates have their own workflows.',
    },
    {
        id: 'start.desktop-install', title: 'Installing on Windows, macOS or Linux', keys: ['install Neconyan', 'Windows installation', 'macOS installation', 'Linux installation', 'Start.bat', 'Start.command', 'start.sh', 'source ZIP'],
        sources: ['README.md', 'Start.bat', 'Start.command', 'start.sh'], anchors: ['Extract All', '127.0.0.1:4433'],
        content: 'For a computer, download the source ZIP from github.com/platberlitz/Neconyan/releases/latest and extract it first (Windows: Extract All). Alternatively clone github.com/platberlitz/Neconyan.git with Git. Inside the extracted or cloned folder, run Start.bat on Windows, Start.command on macOS, or ./start.sh on Linux/WSL. The launchers install Bun if needed and start the server. Keep the terminal open; closing it stops Neconyan. Open http://127.0.0.1:4433/ in a browser on that computer. The app still needs your own model connection in Connections; the download includes no model credits. A source ZIP is application code, not a user-data backup ZIP for Import & Restore.',
    },
    {
        id: 'start.updates', title: 'Updating a Git installation or source ZIP', keys: ['launcher update', 'automatic updates', 'git update', 'ZIP update', 'update source ZIP', 'source ZIP installation', 'NECONYAN_AUTO_UPDATE', 'local changes update'],
        sources: ['README.md', 'start.sh', 'Start.bat'], anchors: ['NECONYAN_AUTO_UPDATE', 'config.yaml'],
        content: 'Git installations check for updates when started through Start.bat, Start.command or start.sh. Local edits to tracked application files make the launcher skip updating; ordinary data and config.yaml changes do not. Set the environment variable NECONYAN_AUTO_UPDATE=0 to disable launcher auto-updates. Source ZIP installations do not update through Git: stop the old server, extract the newer ZIP into a new folder, copy your data folder and any changed config.yaml into it, then start the new copy. Check that your chats and characters appear before removing the old folder. Keep a backup before updating. Android installations use APK updates over the existing app instead.',
    },
    {
        id: 'start.android', title: 'Installing and updating the Android APK', keys: ['Android APK', 'Android install', 'Android update', 'WebView', 'phone app', 'APK storage', 'uninstall Android'],
        sources: ['README.md', 'android/README.md'], anchors: ['Android 11', '124', '2 GiB'],
        content: 'Download the signed Neconyan APK from github.com/platberlitz/Neconyan/releases/latest. Most supported phones need Android 11 or newer and the ARM64 APK; x86_64 is for compatible devices/emulators. Allow about 2 GiB free storage. Android System WebView must be version 124 or newer; update it through the phone\'s app store or system updater if prompted. The app runs its own server, without Termux or a computer, but still needs your model connection. First opening unpacks files and can take a few minutes. The ongoing notification opens the app or stops its server. Battery restrictions can still stop work. Install newer APKs over the existing app to retain data. Uninstalling deletes private app data, so export backups first. Desktop shell commands, server plugins and BotSearcher\'s desktop Chromium launcher are not included.',
    },
    {
        id: 'start.termux', title: 'Running Neconyan through Termux on Android', keys: ['Termux', 'wakelock', 'sdcard', 'Android terminal'],
        sources: ['README.md', 'start.sh'], anchors: ['Acquire wakelock', 'pkg install -y git'],
        content: 'Termux is an alternative to the Android APK. Install Termux from F-Droid or its GitHub releases. Run pkg update && pkg upgrade -y, then pkg install -y git, then git clone --depth 1 https://github.com/platberlitz/Neconyan.git ~/Neconyan. In ~/Neconyan run bash start.sh. The launcher installs Node.js if needed and uses it by default on Termux. Keep the folder in Termux\'s internal home, not /sdcard or shared storage. Open http://127.0.0.1:4433/ in the phone browser. Keep Termux running; Acquire wakelock in its notification helps prevent sleep from interrupting the server. Chrome\'s Add to home screen creates a browser shortcut, not a separate server or model connection.',
    },
    {
        id: 'start.iphone', title: 'Opening Neconyan on an iPhone or another Wi-Fi device', keys: ['iPhone install', 'iPad install', 'same Wi-Fi', 'phone localhost', '10.0.0.0', 'remote access', 'Safari install'],
        sources: ['README.md', 'default/config.yaml'], anchors: ['listen: true', 'basicAuthMode: true', '10.0.0.0/8'],
        content: 'An iPhone or iPad uses Neconyan in its browser with the server running on a computer or another host. For the README\'s same-Wi-Fi setup, stop the computer server, set listen: true and basicAuthMode: true in config.yaml, and set a username and password under basicAuthUser. Restart, allow the server through the computer\'s private-network firewall, then open the computer\'s local IP address with port 4433 on the phone. The phone\'s 127.0.0.1 points to the phone, not the computer. For a 10.x.x.x network rejected as Forbidden, the documented whitelist entry is 10.0.0.0/8. Keep the host running. This local-network recipe does not by itself provide access from outside your Wi-Fi; an existing hosted installation has its own address and administrator.',
    },
    {
        id: 'start.tour', title: 'First paws tour', keys: ['First paws', 'tour', 'onboarding tour', 'replay tour'],
        sources: [home, 'public/scripts/templates/welcomePanelOnboarding.html'], anchors: ['First paws', 'Replay First paws tour'],
        content: 'First paws is the introductory tour. It runs in a Neconyan tour side panel with Home, Back, Skip and Next buttons; Miso, Taro and Nori present the steps, and step buttons such as Open connections take you to the relevant workspace. An unfinished tour resumes later; Skip or finishing ends it. Replay it any time from Home → Home layout → Replay First paws tour. It teaches navigation and the first-connection workflow; it does not create provider credentials or make an unconfigured model available.',
    },
    {
        id: 'navigation.page-tours', title: 'Page intros and Tour buttons on settings pages', keys: ['page tour', 'Tour button', 'settings tour', 'walkthrough', 'explain this page', 'who leads the tour', 'Connections tour', 'Sampling tour', 'Formatting tour', 'Mewmory tour', 'Persona tour', 'Dialogue Colors tour', 'Background tour', 'Server tour', 'Console Logs tour'],
        sources: ['public/scripts/neconyan-tool-tour.js', shell], anchors: ['NN_NATIVE_SHELL_PAGES', 'Your model', 'How replies are written', 'Prompt layout', 'Long-term memory', 'Who you are', 'Who said what', 'Behind your chats', 'Behind the scenes', 'Troubleshooting'],
        content: 'Connections, Sampling, Formatting, Mewmory, Persona, Dialogue Colors, Background, Server and Console Logs open as Neconyan pages: a short card at the top says what the page is for, and its Tour button starts a step-by-step walkthrough that highlights each part of the page. Nori leads Connections and Sampling; Taro leads Formatting, Mewmory, Server and Console Logs; Miso leads Persona, Dialogue Colors and Background. Pawthfinder, Regexes (Taro), Quick Image Gen (Nori) and Character Expressions (Miso) work the same way. The first visit shows an invitation to take the tour; after that, press Tour any time. On phones the Persona tour switches between the Browse and Edit tabs by itself. A tour only explains and opens sections; it changes no settings and makes no model request.',
    },
    {
        id: 'assistants.identity', title: 'Choosing and updating Miso, Taro and Nori', keys: ['Miso', 'Taro', 'Nori', 'assistant picker', 'assistant variant', 'update assistant'],
        covers: ['core:assistants'], sources: [home, 'src/endpoints/characters.js', 'default/content/assistants/manifest.json', 'public/scripts/templates/welcomePanelOnboarding.html'], anchors: ['neconyan_assistant', 'Install updated copy'],
        content: 'On Home, Choose an assistant introduces Miso the tiger and Taro and Nori the cats, and warns that they can hallucinate, so double-check their answers. Pick a personality, choose Male, Female or Neutral, then use its open button. Reopening an installed variant reuses its card and chat. Install updated copy adds a newer bundled copy separately so your existing edits and chats survive. All marked bundled assistants share the application\'s current help reference, including older or renamed copies. Assigning an ordinary character to the Assistant shortcut does not turn it into a bundled assistant. Exported cards used outside Neconyan do not carry this runtime reference.',
    },
    {
        id: 'assistants.actions', title: 'What the assistants can actually change', keys: ['assistant tools', 'can you change settings', 'assistant permissions', 'edit for me', 'create a character for me'],
        sources: ['public/scripts/neconyan-assistant-tools.js', 'public/scripts/neconyan-assistant-tool-guidance.js', 'public/scripts/tool-calling.js', 'src/generation/conversation-assistant-tools.js'], anchors: ['userConfirmed', 'Neconyan_Assistant_'],
        content: 'Miso, Taro and Nori have function tools in supported individual Roleplay chats and Conversation replies. They can list/read lorebooks, agents, model presets and characters; edit one allowed field at a time; and create a new character, optionally with a Quick Image Gen avatar. Every write is first described in chat and waits for your confirming reply, then an Allow resource edit? popup shows Before and After; nothing changes unless you accept. Existing cards are never replaced by creation. These are not screen-control or arbitrary settings tools. Roleplay groups do not supply this tool set. Tools need a compatible Chat Completion provider/model; product-help reference text does not. Report success only after a successful tool result. Never ask for API keys in the chat.',
    },
    {
        id: 'characters.library', title: 'Opening and organising characters', keys: ['character library', 'find character', 'favourite character', 'character tags', 'bulk characters'],
        covers: ['core:characters'], sources: [html, chat, shell], anchors: ['character'],
        content: 'Open Characters to browse the library, search, filter by tags and use favourites. Select a character to open its chat or editor. Character cards define the AI\'s identity; Personas define yours. Bulk edit characters is a separate library mode: turn it on, then select cards (Shift + Click selects a range) before acting on several. Importing a card and starting a new chat are different actions; opening an existing card normally resumes its selected chat.',
    },
    {
        id: 'characters.edit', title: 'Creating and editing a character card', keys: ['create character', 'edit character', 'character description', 'personality field', 'scenario field', 'character note', 'character save failed'],
        sources: [html, shell, chat], anchors: ['creator_notes', 'personality', 'Draft, not saved', 'Save now', 'Basics', 'Definition', 'Greetings', 'Advanced'],
        content: 'The character editor has Basics, Definition, Greetings and Advanced tabs. Set the name, avatar, description, personality, scenario, first message and example dialogue in the relevant tab. Character\'s Note holds instructions for the model; Creator\'s Notes are information for readers, with mode-specific handling. Advanced exposes metadata and prompt overrides. Its save status reads Draft, not saved; Unsaved changes; Saving...; Saved; or Couldn\'t save. Couldn\'t save is not success: use Save now to try again before switching chats. A new card must be created before it has saved chats. Changing a first message does not replace messages already stored in an existing chat.',
    },
    {
        id: 'characters.greetings', title: 'First messages and alternate greetings', keys: ['first message', 'alternate greetings', 'greeting', 'example dialogue', 'mes_example'],
        sources: [html, chat], anchors: ['alternate_greetings', 'mes_example'],
        content: 'A character\'s first message starts a new chat. Alternate greetings supply other starts; message swipes select alternatives where offered. Example dialogue demonstrates voice and formatting for the model and consumes prompt space when included. Editing a greeting in the card does not rewrite a saved conversation. Use a fresh chat to see the new opening, keeping the earlier chat if you want its history.',
    },
    {
        id: 'characters.import-export', title: 'Importing and exporting character cards', keys: ['import character', 'export character', 'character PNG', 'card JSON', 'download card', 'duplicate card'],
        sources: ['src/endpoints/characters.js', 'public/scripts/templates/importCharacters.html', html], anchors: ['importFromPng', 'importFromJson'],
        content: 'Use Characters\' Import action for character PNG, JSON, YAML, CharX or BYAF files; several can be chosen at once. A character PNG contains card data as well as artwork; an ordinary image is not automatically a complete card. A BYAF file can also bring its scenarios in as chats, plus backgrounds and extra images. Import content from external URL accepts supported sources, not every website. Review replacement choices before overwriting an existing card. Export and Download offers PNG or JSON; Duplicate Character makes a copy. Chats, account settings, connection secrets and extension configuration are not bundled into a card export. Use the relevant export for each.',
    },
    {
        id: 'personas.identity', title: 'Creating and selecting a persona', keys: ['persona', 'my name', 'user identity', 'change my avatar', 'who am I'],
        covers: ['core:personas'], sources: [html, 'public/scripts/personas.js', home], anchors: ['persona_description', 'Current Persona'],
        content: 'Open Fine-tuning → Persona. Browse lists personas with Create, search and sorting; Edit shows the Current Persona, where you set its name, image and Persona Description. This describes the user to the model, separately from the AI character card and account sign-in profile. Select the intended persona before starting a thread. In Conversation, persona identity also separates DM histories; switching personas can show a different history rather than deleting the previous one.',
    },
    {
        id: 'personas.cards', title: 'Importing and exporting persona cards', keys: ['persona card', 'import persona', 'export persona', 'share persona', 'persona PNG'],
        sources: [html, 'public/scripts/personas.js', 'src/persona-card.js'], anchors: ['Import persona', 'Export persona card'],
        content: 'In Persona, Edit → Export saves the current persona as a PNG card or JSON card. Both include the image, name, description, title, prompt position and Scenario Notes. Linked lorebooks must be shared separately, and locks and chat connections stay with your account. To add one, use Browse → Import persona and choose a PNG or JSON persona card under 20 MiB; then select it in Browse to use it. Import persona also accepts SillyTavern and SillyBunny persona backup JSON files. If a linked lorebook is missing, import that lorebook and link it again. Ordinary character cards are not persona cards. Backup and Restore of all personas are separate actions.',
    },
    {
        id: 'personas.backup-import', title: 'Importing a SillyTavern or SillyBunny persona backup', keys: ['SillyBunny persona backup', 'SillyTavern persona backup', 'persona backup JSON', 'persona pictures missing', 'persona default picture'],
        sources: ['public/scripts/personas.js', 'src/persona-card.js', 'src/endpoints/avatars.js'], anchors: ['This persona backup contains no pictures.', 'SillyTavern or SillyBunny persona backup JSON'],
        content: 'Open Fine-tuning → Persona → Browse → Import persona and select the SillyTavern or SillyBunny persona backup JSON, under 20 MiB. This imports its persona library, rather than treating it as a single character card. These backups contain names and descriptions but no picture bytes: imported personas use the default picture, which you can replace in Edit. Missing linked lorebooks must be imported separately and linked again. Select a persona in Browse to use it. If Neconyan says its details could not be saved, edit the persona to retry saving before reloading. This small persona JSON is different from an account backup ZIP, which belongs in Settings → System & Device → Import & Restore.',
    },
    {
        id: 'personas.scenario-notes', title: 'Persona Scenario Notes', keys: ['Scenario Notes', 'persona notes', 'final description', 'scenario note'],
        sources: [html, 'public/scripts/personas.js'], anchors: ['Scenario Notes', 'Preview final prompt for this chat'],
        content: 'In Persona, use Scenario Notes to add chat-specific details to your persona. Multiple notes can be active at once in a chat, and the token counter covers the base persona plus active notes. Use Preview final prompt for this chat to see what the model will receive. These notes belong to your persona context and are separate from the character\'s Scenario field, the chat\'s Author\'s Note and Conversation\'s own instructions.',
    },
    {
        id: 'personas.locks', title: 'Persona locks and defaults', keys: ['persona lock', 'default persona', 'wrong persona', 'lock to chat', 'lock to character'],
        sources: ['public/scripts/personas.js', html], anchors: ['persona', 'Lock order: chat, character or group, then default.'],
        content: 'Persona locks choose the identity automatically. The Persona editor states the lock order: chat, character or group, then default. Its Chat, Character or group and Default buttons set each lock. If the wrong persona returns when you open a chat, inspect these locks before changing the default repeatedly. Persona Backup and Restore (all personas as one file) are separate from character-card export. A persona-linked lorebook contributes user-related lore; it is not the persona\'s description itself.',
    },
    {
        id: 'chat.histories', title: 'Starting and reopening Roleplay chats', keys: ['new chat', 'old chat', 'rename chat', 'chat history', 'recent chats', 'temporary chat'],
        covers: ['mode:roleplay'], sources: [chat, home, 'public/scripts/templates/assistantNote.html'], anchors: ['chat_metadata'],
        content: 'Open a character, then use its chat actions to start a new chat or choose an existing history. Home\'s Recent chats (with Pin, Rename and Delete) and the sidebar\'s Recent list are other routes back. New chats have separate histories; renaming a chat changes its label, not its character definition. Reopening a chat, returning from Home or switching mode scrolls to the newest message; switching browser tabs keeps your place. Start a temporary chat does not save messages, so it is not a substitute for a saved character chat. A character export is not a chat export.',
    },
    {
        id: 'chat.message-actions', title: 'Editing, deleting and hiding messages', keys: ['edit message', 'delete message', 'hide message', 'exclude from prompt', 'message actions', 'move message'],
        sources: [chat, html], anchors: ['is_system', 'More message actions', 'Exclude message from prompts'],
        content: 'Use the message\'s buttons, some behind More message actions, to edit, copy or delete it. While editing, the labelled buttons are Confirm, Copy, Reasoning (add a reasoning block), Delete, Up and Down (move the message) and Cancel, which keeps the original. Deletion removes stored chat content; review the confirmation, especially for a range of messages. Exclude message from prompts is different from deleting: the message stays stored and visible but stops supplying normal model context, and Include message in prompts reverses it. Memory systems and backups have their own retention rules, so hiding text is not a promise that every copy has been erased.',
    },
    {
        id: 'chat.generation-actions', title: 'Regenerate, swipe, continue and impersonate', keys: ['regenerate', 'swipe reply', 'continue reply', 'impersonate', 'retry reply', 'stop generating'],
        sources: [chat, html], anchors: ['impersonate', 'swipe'],
        content: 'Regenerate asks for another reply to the same context. Swipes store alternative versions of a message; the selected version is used as the current one. Continue asks the model to extend the current reply rather than creating a new user turn. Impersonate generates text as the user, so inspect it before sending. Stop interrupts an active request but cannot undo provider usage already incurred. These actions can make model requests; moving to an already saved swipe does not itself require a new completion.',
    },
    {
        id: 'chat.server-replies', title: 'Replies that keep going after the page closes', keys: ['closed the page', 'closed the tab', 'reply still generating', 'server job', 'reload during reply'],
        sources: ['public/scripts/neconyan-conversation/roleplay-workflows.js', chat, 'public/scripts/group-chats.js'], anchors: ['Open a saved Roleplay chat before generating.', 'closing the page does not stop the turn'],
        content: 'In a saved Roleplay chat, sending, Swipe, Regenerate and Continue, plus Story Mode passages, Guided Generations and Deep Swipe, are handed to the server as jobs; ordinary group turns are too. Closing or reloading the page does not stop them: reopen the chat and the saved reply appears once the server has written it. Stop cancels the job. A dropped connection reattaches to the same job instead of sending a second paid request. Unsaved connection settings are saved first. Roleplay chats with Miso, Taro or Nori, Impersonate, automatic or quiet requests, group swipes and continues, and prompt additions the server cannot reproduce use an older short hold instead: the request keeps running if the page drops, but the reply is only written into the chat when the page reopens to collect it, and a server restart loses it. Each job still costs model requests.',
    },
    {
        id: 'chat.paw-send', title: 'The paw Send button and its nya pop', keys: ['paw button', 'send paw', 'nya', 'cat sound', 'send button animation'],
        sources: ['public/scripts/neconyan-send-nya.js', html], anchors: ['Send a message', '\'nya!\''],
        content: 'The Send button (Send a message) is a paw. Pressing it in Roleplay or Conversation pops a random cat sound, one of nya!, mrrp?, mrrah, mew or purr, which floats up from the paw and fades within about a second. It is text only and plays no audio. With reduced motion the sound shows and fades without floating. While a Roleplay reply is generating, Stop takes the paw\'s place and the pop stays visible beside it. The pop is decoration: it does not change what is sent, and there is no separate setting for it.',
    },
    {
        id: 'chat.sleepers', title: 'Sleeping cats on chat messages', keys: ['sleeping cat', 'sleeping tiger', 'cat on message', 'pet the cat', 'ear twitch'],
        sources: ['public/scripts/neconyan-message-sleepers.js', 'public/scripts/extensions/third-party/Neconyan-Story-Mode/style.css', chat, html], anchors: ['Pet sleeping cat', 'neconyan-message-sleeper'],
        content: 'In Neconyan\'s chat styles a small sleeping calico perches on character messages and a sleeping tiger on your own, in Roleplay, Conversation and Meower. System notices have none. Story Mode keeps sleepers only on the first and newest message blocks so the manuscript has no cat-sized gaps in between; returning to Roleplay restores them. Tap or click one (Pet sleeping cat), or focus it and press Enter or Space, and it twitches an ear briefly; with reduced motion it stays still. Petting does nothing else: it does not open, edit or send the message. They are decoration. To hide them along with the other cat decorations, choose Settings → Appearance → UI Theme → Shell Style → Kittyless, or turn on Hide cats (Kittyless) there to keep your current style. Turning the switch off, or switching from Kittyless to another style, restores them.',
    },
    {
        id: 'chat.branches', title: 'Branches and checkpoints', keys: ['branch', 'checkpoint', 'alternate timeline', 'fork chat', 'bookmark'],
        sources: ['public/scripts/bookmarks.js', chat, html], anchors: ['main_chat', 'Create checkpoint', 'Create branch'],
        content: 'Use a message\'s Create branch or Create checkpoint action to keep an alternate continuation from that point. A branch is a separate saved history, not a second visible swipe. Later edits in one history are not automatically merged into another. Mewmory copies only an accepted matching prefix for native branches. Conversation has its own branch system and a separate option controlling copied DM summary memory.',
    },
    {
        id: 'chat.authors-note', title: 'Author’s Note and prompt depth', keys: ['authors note', 'author\'s note', 'author note', 'prompt depth', 'injection depth', 'author\'s note profile', 'persona author\'s note'],
        sources: ['public/scripts/authors-note.js', html], anchors: ['note_depth', 'extension_floating_chara_per_persona', 'extension_floating_persona'],
        content: 'Author\'s Note supplies extra instructions or scene reminders in the chat prompt. Its depth sets where it appears relative to recent messages, and its frequency controls when it is inserted. It consumes context when active. The private Character Author\'s Note can hold several named profiles, with one in use at a time; ticking Remember a profile for each persona makes each persona keep its own choice, so switching persona switches the profile. The Persona Author\'s Note follows the selected persona into every chat and has its own profiles. Both can be on together, each set to replace the chat note or sit at its top or bottom, so any character profile can be combined with any persona profile. Keep it separate from the character\'s permanent description and creator notes. Conversation has its own Author\'s Note setting, so changing the Roleplay note does not reliably change a DM\'s instructions.',
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
        covers: ['core:extensions'], sources: ['src/neconyan-native-extensions.js', 'public/scripts/extensions.js', 'public/scripts/neconyan-settings-tabs.js', shell], anchors: ['Neconyan-Hopper', 'Manage extensions'],
        content: 'Included tools opens the release-owned tool workspaces; each tool offers Open and/or Settings, and Manage extensions installs, enables or inspects it. Other extension settings are in Extensions, switchable between Third-party and Built-in. Enabled and configured are separate states: a tool needing a provider can be enabled but unusable until connected. Release-owned tools are maintained with Neconyan; importing an upstream duplicate does not safely replace the bundled copy and can leave it inactive. Arbitrary newly installed extensions are outside the bundled help reference. Check their installed documentation and permissions rather than guessing their features.',
    },
];
