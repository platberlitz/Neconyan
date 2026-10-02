import { t } from './i18n.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';
import { createPageIntro } from './neconyan-page-intro.js';

import { TOOL_TOUR_INVITE_PREFIX, addTourInvitationDismiss, dismissTourInvitation } from './neconyan-tour-invitations.js';
export { TOOL_TOUR_INVITE_PREFIX } from './neconyan-tour-invitations.js';

const ASSISTANT_NAMES = Object.freeze({ miso: 'Miso', taro: 'Taro', nori: 'Nori' });

const TOOL_PAGES = Object.freeze({
    pathfinder: {
        assistant: 'taro',
        name: 'Pawthfinder',
        kicker: 'Lore helper',
        description: 'Let the model choose which lorebook entries matter for each reply, instead of waiting for keywords.',
        invite: 'Taro will show you what each part of this page does, one step at a time.',
        emptyWhen: '#pf--lorebook-list .pf--empty-state',
        steps: [
            {
                id: 'welcome',
                targets: ['#pf--quickstart', '.neconyan-tool-page-intro'],
                title: 'What Pawthfinder does',
                body: 'A normal lorebook wakes an entry only when one of its **keywords** appears in the chat. Pawthfinder lets the model pick the entries that matter instead, so lore turns up even when nobody says the exact word.\nIt only ever reads the lorebooks you choose on this page. Press **Next** and I will take you through it in order.',
                hint: 'I read all my notes before I act. I expect the same from the model.',
            },
            {
                id: 'status',
                targets: ['#pf--status-banner'],
                title: 'The status line',
                body: 'This line says whether Pawthfinder is ready. **Not configured** means no lorebook is chosen yet. **Disabled** means the main switch is off.\nLook here first whenever lore stops turning up.',
                hint: 'Read the sign before you knock. It saves us both time.',
            },
            {
                id: 'switch',
                targets: ['.pf--master-section'],
                title: 'The main switch',
                body: '**Enable Pawthfinder for all chats** turns the whole feature on or off. Changing other settings never flips it, so it stays where you left it.',
                hint: 'One switch. On or off. I like things that know what they are.',
            },
            {
                id: 'lorebooks',
                targets: ['#pf--lorebook-section'],
                open: '#pf--lorebook-section > .pf--collapsible-header',
                title: 'Step 1: choose the lorebooks',
                body: 'Tick each lorebook Pawthfinder may read. This step is required: with nothing ticked, it has nothing to search.\n**Automatically use attached character/chat lorebooks** adds the books already linked to the current character or chat, so you do not have to tick them again for every story.',
                emptyBody: 'Tick each lorebook Pawthfinder may read. This step is required: with nothing ticked, it has nothing to search.\nYou have no lorebooks yet. Make one on the **Lorebooks** page first, then come back and tick it here.',
                hint: 'No books, no lore. I cannot find what was never written down.',
            },
            {
                id: 'mode',
                targets: ['#pf--mode-section'],
                open: '#pf--mode-section > .pf--collapsible-header',
                title: 'Step 2: choose how it works',
                body: '**Tool Mode** lets the model search and edit your lorebook by itself while it writes a reply. Your connection must support tool calls.\n**Predictive Pipeline** runs a quick, separate check before each reply and adds the entries it expects you need. It works with any connection.\nYou can turn on both, but that uses more tokens.',
                hint: 'Tools if your model can hold a pen. Pipeline if it cannot. Do not make it complicated.',
            },
            {
                id: 'pipeline',
                optional: true,
                targets: ['#pf--pipeline-settings'],
                open: '#pf--pipeline-settings > .pf--collapsible-header',
                title: 'Pipeline settings',
                body: 'These appear once the Predictive Pipeline is on. **Max Candidates** limits how many entries it may add to one reply.\n**Connection Profile for Pipeline** lets that check use a cheaper, faster model than your main chat.',
                hint: 'A cheap model for the errands. Keep the good one for the conversation.',
            },
            {
                id: 'summaries',
                targets: ['#pf--memory-summary-settings'],
                open: '#pf--memory-summary-settings > .pf--collapsible-header',
                title: 'Memory summaries',
                body: 'Pawthfinder can write short summaries of what happened and keep them with your lore.\n**Auto-track summary interval** reminds it every **Summary Interval** messages. The **Latest memory summary** box shows the newest one, and you can edit it before you press **Save Summary**.',
                hint: 'Short notes, kept current. That is how nothing important gets lost.',
            },
            {
                id: 'tools',
                targets: ['#pf--tool-settings'],
                open: '#pf--tool-settings > .pf--collapsible-header',
                title: 'Tool settings',
                body: 'These matter in Tool Mode. Choose which tools the model may use, and whether it may **write** or **delete** lorebook entries.\nTools ticked under **Ask Before Executing** show you a confirmation first, so nothing changes without your say.',
                hint: 'Nobody gets delete rights on their first day. Not even me.',
            },
            {
                id: 'diagnostics',
                targets: ['.pf--section:has(#pf--diagnostics-body)'],
                open: '.pf--section:has(#pf--diagnostics-body) > .pf--collapsible-header',
                title: 'When something seems wrong',
                body: '**Run Diagnostics** checks your setup and lists anything missing. **Copy Diagnostics** copies that report, so you can paste it when you ask for help.\nThe **Retrieval Log** just below shows what Pawthfinder actually picked for recent replies.',
                hint: 'Evidence first, opinions after. It is why I am right so often.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Choose a lorebook, choose a mode, then send a message. Everything here saves as you change it.\nPress **Tour** at the top of the page whenever you want this walk again.',
                hint: 'I will be outside having a smoke. Call me if it misbehaves.',
            },
        ],
    },
    expressions: {
        assistant: 'miso',
        name: 'Character Expressions',
        kicker: 'Faces and moods',
        description: 'Show a picture of the character that changes with the mood of each reply: happy, sad, surprised and more.',
        invite: 'Miso will show you what each part of this page does, one step at a time.',
        emptyWhen: '.expression_section_sprites:has(#open_chat_expressions[style*="display: none"])',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What expressions are',
                body: 'An **expression** is one picture of the character showing one feeling, such as **joy**, **anger** or **surprise**. These pictures are called **sprites**.\nAfter each reply, Neconyan works out the feeling in the text and shows the matching sprite beside the chat. Press **Next** and I will show you how.',
                hint: 'I have a sprite for every mood. Most of them are me asking for a snack.',
            },
            {
                id: 'classifier',
                targets: ['.expression_api_block'],
                title: 'Who reads the mood',
                body: '**Classifier API** chooses what reads each reply and picks the feeling.\n**[ None ]** never changes the picture by itself; you set it by hand. **Local** runs a small mood reader on your Neconyan server for free, and it understands English only. **Main API** asks your chat model. **WebLLM** runs a model inside this browser tab, so keep the page open. **In-Chat Agent** uses the bundled Expressions Agent, which can also draw missing sprites for you.',
                hint: 'Local is free and quick. Like me finding the treat cupboard.',
            },
            {
                id: 'agent',
                optional: true,
                targets: ['.expression_agent_block'],
                title: 'The Expressions Agent',
                body: 'These settings appear when the Classifier API is **In-Chat Agent**. The status line says whether the agent is ready.\n**Auto-generate missing sprites during chat** asks **Quick Image Gen** to draw a sprite the first time a feeling has no picture. **Sprite framing** keeps every picture at the same crop, so the faces line up.',
                hint: 'If the status says it is not ready, switch on the Expressions Agent on the Agents page. I believe in you!',
            },
            {
                id: 'prompt',
                optional: true,
                targets: ['.expression_llm_prompt_block'],
                title: 'The mood question',
                body: 'These settings appear for **Main API** and **WebLLM**. **LLM Prompt** is the instruction the model gets when it picks a feeling; the **{{labels}}** macro becomes the list of feelings it may choose from.\n**Filter expressions for available sprites** only offers feelings that have a picture, so the model never picks one you cannot show.',
                hint: 'Fewer choices means quicker answers. That is how I order dinner.',
            },
            {
                id: 'translate',
                targets: ['label[for="expression_translate"]'],
                title: 'Chats in other languages',
                body: '**Translate text to English before classification** sends each reply through the Chat Translation extension first. Turn it on with **Local** if your chats are not in English, because that mood reader only understands English.',
                hint: 'I understand every language as long as the word is "dinner".',
            },
            {
                id: 'choices',
                targets: ['.expression_section_behaviour'],
                title: 'Sprite choices',
                body: '**Allow multiple sprites per expression** lets one feeling have several pictures, and one is picked at random each time. **Re-roll if same sprite is used again** avoids showing the same one twice in a row.\n**Default / Fallback Expression** is shown when no feeling matches. **Custom Expressions** adds your own feelings beyond the built-in list; you can also switch to one with the **/emote** command.',
                hint: 'My custom expression is "belly rub, please". It gets used a lot.',
            },
            {
                id: 'sprites',
                targets: ['.expression_section_sprites'],
                title: 'This character\'s sprites',
                body: 'Every feeling has a tile here. Click a tile to show it now. The small buttons on each tile **upload** a picture, **generate** one with Quick Image Gen, or **delete** it.\nThe buttons above the tiles work on the whole set: **Generate missing sprites**, **Upload character sheet** to cut one big picture into sprites, or **Upload sprite pack (ZIP)**. **Sprite Folder Override** points this chat at a different folder of pictures.',
                emptyBody: 'Every feeling gets a tile here once a chat is open. Open a chat with a character, then come back to upload, generate or delete their sprites.',
                hint: 'Generate missing sprites is my favourite button. Pictures appear and I did not even have to get up.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is everything',
                body: 'Choose who reads the mood, add a few sprites, then chat as normal. Everything here saves as you change it.\nPress **Tour** at the top of the page whenever you want this walk again.',
                hint: 'You did so well! That deserves a treat. For both of us, ideally.',
            },
        ],
    },
    'quick-image-gen': {
        assistant: 'nori',
        name: 'Quick Image Gen',
        kicker: 'Picture maker',
        description: 'Make pictures of your characters and scenes with an image service, then drop them straight into the chat.',
        invite: 'Nori will show you what each part of this page does, one step at a time.',
        steps: [
            {
                id: 'actions',
                targets: ['#qig-settings .qig-action-bar'],
                title: 'The buttons you will use most',
                body: '**Generate** makes a picture with the settings below. The keyboard shortcut is shown on the button.\n**Quick Setup** walks you through choosing an image service and pasting its key. **Logs** shows what happened on recent tries, **Gallery** keeps the pictures you made, and **Prompts** lists the prompts you used before.',
                hint: 'Gallery is my portfolio. Every picture in it is priceless. Mostly because none of them cost anything.',
            },
            {
                id: 'status',
                targets: ['#qig-settings .qig-menu-hero'],
                title: 'Is it ready?',
                body: 'This strip says whether Quick Image Gen can make a picture right now, then lists the image service, model, size and prompt source it will use.\nIf something is missing, such as an API key, a warning appears here saying exactly where to fix it.',
                hint: 'Read it before you press Generate. I am not explaining a blank picture to anyone.',
            },
            {
                id: 'configuration',
                targets: ['#qig-settings .qig-field:has(#qig-config-select)'],
                title: 'Configurations',
                body: 'A **configuration** is one complete setup saved under a name: image service, key, model and generation settings.\nUse the floppy disk to save the current setup as a new one, the arrows to overwrite the selected one, and the bin to delete it. Switching between them is quicker than retyping everything.',
                hint: 'I keep one called Fancy and one called Fancy But Free. Guess which one I use.',
            },
            {
                id: 'prompt',
                targets: ['#qig-settings .qig-field:has(#qig-prompt)'],
                title: 'The prompt',
                body: 'Describe the picture you want. You can use **{{char}}** and **{{user}}** for the character and your persona names.\nWhen the prompt source below is **Chat scene**, this box is skipped and the selected chat messages are used instead.',
                hint: 'Be specific. "Cute cat" gets you any cat. "Tuxedo cat on velvet, smug" gets you me.',
            },
            {
                id: 'source',
                targets: ['#qig-settings .qig-field:has(.qig-prompt-source)'],
                title: 'Where the prompt comes from',
                body: '**Manual** sends the prompt box as it is. **Chat scene** turns the selected chat messages into the scene, and can let your text model rewrite them into an image prompt.\n**AI-tagged** asks your text model to add image tags to its replies. Turn on **Auto-generate** under **Automation & Delivery** so those tags make pictures.',
                hint: 'Chat scene is for when you are lazy. I respect that.',
            },
            {
                id: 'style',
                targets: ['#qig-settings .qig-field:has(#qig-style)'],
                title: 'Style',
                body: 'A style adds a look to every prompt, such as anime or photo. Choose **None** to send your prompt without additions.',
                hint: 'Taste cannot be taught. Luckily, it can be picked from a list.',
            },
            {
                id: 'more',
                targets: ['#qig-settings .qig-settings-search-shell', '#qig-setup-toggle'],
                open: '#qig-setup-toggle',
                title: 'More settings',
                body: '**More settings** holds everything else, in four sections. Lost? Type a word such as **resolution**, **key** or **negative** into the search box and only the matching settings stay visible.',
                hint: 'Search first. Scrolling through all of that is beneath both of us.',
            },
            {
                id: 'provider',
                targets: ['#qig-settings .qig-flow-provider'],
                open: ['#qig-setup-toggle', '#qig-section-provider-toggle'],
                title: 'Image service and output',
                body: 'Choose the **image service** that draws your pictures, paste its key if it needs one, then pick the model, picture size and how many pictures to make at once.\nSome **Pollinations** models work without a key, so it is a good first try. The status strip warns you if the model you picked needs one.',
                hint: 'Free is my favourite price. It is also my only price.',
            },
            {
                id: 'prompting',
                targets: ['#qig-settings .qig-menu-section--prompt'],
                open: ['#qig-setup-toggle', '#qig-section-create-toggle'],
                title: 'Prompting tools',
                body: 'These turn a plain description into a proper image prompt, or let your text model rewrite a prompt before it is sent. Use them when your pictures keep missing the point.',
                hint: 'A good prompt is like a good outfit. Most people need help with both.',
            },
            {
                id: 'context',
                targets: ['#qig-settings .qig-flow-context'],
                open: ['#qig-setup-toggle', '#qig-section-context-toggle'],
                title: 'Context rules and media',
                body: 'Give a character their own prompt, style, picture size and reference pictures, so every picture of them matches.\nThis section also manages saved pictures and videos that can be shown in chats.',
                hint: 'Consistency matters. I have looked this good in every single picture.',
            },
            {
                id: 'automation',
                targets: ['#qig-settings .qig-flow-automation'],
                open: ['#qig-setup-toggle', '#qig-section-automation-toggle'],
                title: 'Automation and delivery',
                body: 'Choose whether pictures are made automatically, for example every few replies or when the text model adds image tags, and set the keyboard shortcuts.\nLeave automatic pictures off until you know what each one costs on your image service.',
                hint: 'Automatic pictures on a paid service is how I ended up broke. Learn from me.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is everything',
                body: 'Choose an image service, write a prompt or pick a scene, then press **Generate**. Settings save as you change them.\nPress **Tour** at the top of the page whenever you want me again.',
                hint: 'You will want me again. Everybody does. Hehe.',
            },
        ],
    },
    regex: {
        assistant: 'taro',
        name: 'Regexes',
        kicker: 'Find and replace',
        description: 'Change text automatically: tidy replies, hide notes, or reword what you send, using find-and-replace rules called scripts.',
        invite: 'Taro will show you what each part of this page does, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What a regex script is',
                body: 'A **regex script** is a find-and-replace rule. It looks for a pattern in the text, such as **anything between square brackets**, and replaces it with something else, or with nothing.\nScripts can change what you see in the chat, what is sent to the model, or both. Nothing here edits a message until a script matches it.',
                hint: 'Precise rules, applied every time. My favourite kind of colleague.',
            },
            {
                id: 'new',
                targets: ['.regex_toolbar'],
                title: 'Making a script',
                body: '**+ Global**, **+ Preset** and **+ Scoped** each open the script editor. The difference is where the script is kept, which the next steps explain.\n**Import** loads scripts from a file. **Debugger** runs a sample text through every active script, one at a time, so you can see which one changed what.',
                hint: 'When something rewrites your text and you do not know why, use the Debugger. Guessing is for amateurs.',
            },
            {
                id: 'editor',
                targets: ['#open_regex_editor'],
                title: 'The editor helps you write patterns',
                body: 'You do not need to know regex syntax. In the editor:\n**Start from a recipe** fills in a ready-made script, such as removing thinking blocks or bolding dialogue.\n**Options** switch common settings on and off, such as **Ignore case**. **Insert a piece** adds building blocks like **A number** or **Text in [brackets]** where your cursor is.\n**What this pattern does** explains the pattern in plain words, piece by piece. **Test Mode** with **Use the last reply** shows the result on real text and counts the matches.',
                hint: 'Read the explanation before you save. I always do. Twice.',
            },
            {
                id: 'filter',
                targets: ['.regex_script_filter_row'],
                title: 'Finding a script',
                body: 'Type part of a script name here to show only the scripts that match, across all three lists. Clear the box to see everything again.',
                hint: 'Name your scripts properly and this box does the rest.',
            },
            {
                id: 'bulk',
                targets: ['label[for="regex_bulk_edit"]'],
                title: 'Changing many at once',
                body: '**Bulk Edit** adds a tick box to every script. Tick the ones you want, then **Enable**, **Disable**, **Export**, **Delete** or move them to another list in one go.',
                hint: 'Delete in bulk only after you have exported. I am not saying it twice.',
            },
            {
                id: 'presets',
                targets: ['#regex_presets_block'],
                title: 'Regex Presets',
                body: 'A **regex preset** remembers which scripts are switched on. Save one set for roleplay and another for plain chat, then swap between them from this list.\nThe buttons create a preset, save changes to it, apply it again, or delete it.',
                hint: 'One preset per mood. Very orderly.',
            },
            {
                id: 'global',
                targets: ['#global_scripts_block'],
                title: 'Global Scripts',
                body: '**Global** scripts work in every chat with every character. They are saved in your settings on this Neconyan server.\nEach row has a switch to turn the script on or off, a pencil to edit it, and a bin to delete it. Drag the handle on the left to change the order; scripts run from top to bottom.',
                hint: 'Order matters. A sloppy order gives sloppy text.',
            },
            {
                id: 'preset',
                targets: ['#preset_scripts_block'],
                title: 'Preset Scripts',
                body: '**Preset** scripts belong to the preset you are using on the **Presets** page, and travel with it when you export that preset.\nThe switch beside the title decides whether preset scripts may run at all. When it is off, the list is greyed out.',
                hint: 'Someone else wrote those. Read them before you allow them.',
            },
            {
                id: 'scoped',
                targets: ['#scoped_scripts_block'],
                title: 'Scoped Scripts',
                body: '**Scoped** scripts belong to the current character and are saved inside the character card, so they go wherever the card goes.\nThe switch beside the title allows or blocks them for this character. Cards you import may ask you to allow their scripts.',
                hint: 'A card that brings its own rules. Respectable, if it is tidy.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. Start with a recipe in the editor and test it on your last reply before you save.',
                hint: 'Now, if you will excuse me, I have a cigarette with my name on it.',
            },
        ],
    },
    connections: {
        assistant: 'nori',
        name: 'Connections',
        kicker: 'Your model',
        description: 'Choose the service that writes the replies, add its key, and pick the model to use. Save the setup as a connection to switch back to it in one click.',
        invite: 'Nori will show you how to connect a model, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What this page is for',
                body: 'Neconyan does not write replies itself. It sends your chat to a **model**, an AI service that writes the reply, and this page decides which one.\nYou need three things: a **provider** (the company or program that runs the model), usually an **API key** (a password the provider gives you), and a **model** name.',
                hint: 'Think of it as choosing a restaurant. Some of them are very expensive. I know them all.',
            },
            {
                id: 'saved',
                targets: ['.neconyan-model-saved'],
                optional: true,
                title: 'Saved connections',
                body: 'A **saved connection** remembers the provider, model and settings you are using now. Pick one from the list to switch everything back in one go.\n**New profile** saves the current setup under a new name. **Save** updates the one you picked. **Random model rotation** can swap between several saved connections for you.',
                hint: 'Save the good setups. Rebuilding them from memory is a waste of my precious time.',
            },
            {
                id: 'format',
                targets: ['#main-API-selector-block'],
                title: 'Reply format',
                body: '**Chat Completion** sends the chat as a list of messages. Most online services, such as OpenAI, Claude, Gemini and OpenRouter, use this.\n**Text Completion** sends one long block of text. Programs you run yourself, such as KoboldCpp, usually use this. The other choices are for NovelAI, AI Horde and older Kobold setups.',
                hint: 'If you are not sure, Chat Completion is the safe and stylish choice.',
            },
            {
                id: 'provider',
                targets: ['#openai_api', '#textgenerationwebui_api', '#kobold_api', '#novel_api', '#kobold_horde'],
                title: 'Provider and Connect',
                body: 'Choose your provider from the list, then press **Connect**. The light beside it turns green when Neconyan can reach the provider.\n**Connection tools** has a test button that sends a tiny message, which is the quickest way to check the key and model really work.',
                hint: 'A green light is the only compliment a connection ever gives you.',
            },
            {
                id: 'key',
                targets: ['.neconyan-provider-connection', '#api_key_textgenerationwebui', '#api_key_novel'],
                optional: true,
                title: 'Address and key',
                body: 'Paste the **API key** from your provider here. It is stored on your Neconyan server and is never shown again in full.\nFor a program on your own computer, enter its address instead, such as **http://127.0.0.1:5001**.',
                hint: 'Keys are like credit cards. Never show them to anyone. Especially not me.',
            },
            {
                id: 'model',
                targets: ['.neconyan-provider-model', '#model_openai_select', '#model_textgenerationwebui_select'],
                optional: true,
                title: 'Choosing the model',
                body: 'Pick a model from **Available models**, or type its exact name. The list button opens a searchable list, and the star keeps favourites at the top.\nDifferent models write differently and cost different amounts, so it is worth trying a few.',
                hint: 'The priciest model is not always the best one. It hurts me to say it.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. Once replies work, save the setup as a connection so you never have to enter it twice.',
                hint: 'Now go chat. I will be here, pretending I can afford the good model.',
            },
        ],
    },
    presets: {
        assistant: 'nori',
        name: 'Presets',
        kicker: 'Saved writing setup',
        description: 'Choose a saved writing setup, edit its instructions and reply settings, or save your own version to use again.',
        invite: 'Nori will show you how to choose, edit and save a preset, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What a preset saves',
                body: 'A **preset** saves settings for how your model writes replies. **Chat Completion** presets also hold the prompts, the instructions sent with your chat.\nThe choices here match the **Reply format** on **Connections**. This tour won\'t change, save or delete a preset for you.',
                hint: 'I\'m Nori. Let\'s keep the setup you actually like, for once.',
            },
            {
                id: 'choose',
                targets: ['#settings_preset_openai', '#settings_preset_textgenerationwebui', '#settings_preset_novel', '#settings_preset'],
                title: 'Choosing a preset',
                body: 'Pick a name from this list to load that preset. Loading another preset can replace your current reply settings, so save any edits you want to keep first.\nA **Text Completion** preset doesn\'t contain the instruction templates on **Formatting**. Those are managed separately.',
                hint: 'Read what you\'re choosing. An impressive name isn\'t a recommendation.',
            },
            {
                id: 'save',
                targets: ['#update_oai_preset', '#respective-presets-block [data-preset-manager-update]'],
                optional: true,
                title: 'Saving your changes',
                body: '**Update current preset**, the save button beside the list, replaces the selected preset with your current settings. Use it when you want to keep edits under the same name.\nChanging a setting and saving a preset are separate actions.',
                hint: 'Check the selected name first. I don\'t enjoy losing a good setup.',
            },
            {
                id: 'copy',
                targets: ['#new_oai_preset', '#respective-presets-block [data-preset-manager-new]'],
                optional: true,
                title: 'Keeping the original',
                body: '**Save preset as** saves the current setup under a name you choose. Use a new name to keep the original preset unchanged.\n**Rename current preset** changes the name of the selected preset; it isn\'t the same as making a second copy.',
                hint: 'A personal version and an untouched original. Sensible. Almost suspiciously so.',
            },
            {
                id: 'files',
                targets: ['#import_oai_preset', '#respective-presets-block [data-preset-manager-import]'],
                optional: true,
                title: 'Importing and exporting',
                body: '**Import preset** loads a preset file into your library. Use a file made for the reply format you\'re using.\n**Export preset** downloads the selected preset as a file, so you can back it up or share it. Read imported prompts before using them.',
                hint: 'Keep a backup before experimenting. Backups are free, unlike my taste in models.',
            },
            {
                id: 'linking',
                targets: ['#openai_api-presets .inline-drawer:has(#bind_preset_to_connection)'],
                optional: true,
                title: 'What changes when you switch',
                body: '**Preset API/Sampler Linking** decides what loading a Chat Completion preset changes.\n**Keep API/model linked to preset** lets it change your provider and model too. Leave it off to reuse the preset with your current connection. **Keep sampling settings linked to preset** lets it load the saved sampling values, the settings that control how words are picked.',
                hint: 'The preset doesn\'t have to choose the expensive model for you. I admit this reluctantly.',
            },
            {
                id: 'parameters',
                targets: ['#sb-openai-budget'],
                tab: '#openai-tab-btn-parameters',
                optional: true,
                title: 'Reply settings',
                body: '**Parameters** groups the Chat Completion reply settings. **Token Budget** sets how much text the model can read and write; **Output** controls things such as streaming, showing the reply as it arrives.\nThe sliders that control word choice live on **Sampling**. Save the preset after making changes you want to keep.',
                hint: 'Change one thing, try a reply, then decide. Even I can exercise restraint sometimes.',
            },
            {
                id: 'prompts',
                targets: ['#sb-openai-prompt-manager', '#completion_prompt_manager'],
                tab: '#openai-tab-btn-prompts',
                optional: true,
                title: 'Instructions sent with your chat',
                body: '**Prompts** holds the Chat Completion instructions and their order. Open an entry to read or edit it; enabled entries are included when appropriate.\nThese instructions can change the model\'s writing much more than a small slider adjustment. Save your own copy before editing someone else\'s preset, and save again when you\'re happy with it.',
                hint: 'I read the instructions before blaming the model. Usually. Don\'t look at me like that.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'Your setup, saved',
                body: '**Tour** brings me back whenever you need a reminder. Choose a preset, make a copy before experimenting, and save the changes you want to keep.\nLoading a preset changes settings, not the messages already in your chat.',
                hint: 'There. Good taste, properly saved. I\'d charge for this if I knew how.',
            },
        ],
    },
    sampling: {
        assistant: 'nori',
        name: 'Sampling',
        kicker: 'How replies are written',
        description: 'Fine-tune how the model picks its words: more surprising or more predictable, longer or shorter, more or less repetitive.',
        invite: 'Nori will explain what each slider does, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What sampling means',
                body: 'A model writes one small piece of a word at a time. For each piece it has a list of likely options, and **sampling** settings decide how it picks from that list.\nYou do not have to change anything here. The defaults work, and the active preset on the **Presets** page saves whatever you set.',
                hint: 'Small adjustments, big difference. Like tailoring.',
            },
            {
                id: 'backend',
                targets: ['.sb-sampling-section-header'],
                title: 'Only what your model understands',
                body: 'This page only shows the settings your current **Reply format** can use. Change the provider or format on the **Connections** page and the list here changes to match.',
                hint: 'No point paying for buttons that do nothing.',
            },
            {
                id: 'priority',
                targets: ['.sb-sampling-priority-row-top', '.sb-sampling-priority-row-bottom'],
                optional: true,
                title: 'The everyday settings',
                body: 'The settings at the top are the ones people change most, such as how long a reply may be and how much of the chat the model can read.\nA **Seed** makes the same message give the same reply each time, which helps when testing. Leave it at **-1** for a fresh reply every time.',
                hint: 'Start here. Everything else is for show-offs.',
            },
            {
                id: 'sliders',
                targets: ['.sb-sampling-grid'],
                optional: true,
                title: 'The sliders',
                body: '**Temperature** controls surprise: higher gives more varied replies, lower gives safer and more repetitive ones.\n**Top P** and **Top K** cut unlikely words from the list before picking. **Frequency** and **Presence penalty** discourage the model from repeating itself.\nDrag a slider or type a number in the box beside it.',
                hint: 'Change one thing at a time, then send a message. Otherwise you will never know what helped.',
            },
            {
                id: 'more',
                targets: ['.sb-sampling-multi-grid', '.sb-sampling-after-row'],
                optional: true,
                title: 'Lists and extras',
                body: 'Some settings take a list instead of a number, such as words that must stop a reply or the order samplers run in. They sit below the sliders.',
                hint: 'Advanced, yes. Expensive, no. My favourite kind of setting.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. If replies go strange, lower **Temperature** first.',
                hint: 'And if they are perfect, save the preset before you touch anything else.',
            },
        ],
    },
    formatting: {
        assistant: 'taro',
        name: 'Formatting',
        kicker: 'Prompt layout',
        description: 'Decide how your chat is laid out before it is sent to the model: the story template, the system prompt, and the wrapping some models expect.',
        invite: 'Taro will show you what each section controls, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What formatting controls',
                body: 'Before each reply, Neconyan builds one **prompt**: the character card, your persona, lorebook entries and the chat so far, joined together. This page decides the order and the wrapping.\nMost of it matters for **Text Completion**. With **Chat Completion**, the **Presets** page does this job instead.',
                hint: 'Layout is everything. Nobody reads a messy report.',
            },
            {
                id: 'notice',
                targets: ['#advanced-formatting-cc-notice'],
                optional: true,
                title: 'Why some sections are missing',
                body: 'You are using **Chat Completion**, so the sections that only work with **Text Completion** are hidden. Switch the **Reply format** on the **Connections** page to see them.',
                hint: 'Hidden on purpose. I do not show people buttons that do nothing.',
            },
            {
                id: 'context',
                targets: ['#sb-af-context'],
                optional: true,
                title: 'Context Template',
                body: 'The **Context Template** is the order the pieces go in, written as a **story string** with placeholders such as **{{description}}** and **{{persona}}**.\nPick a ready-made template from the list. Edit it only if your model needs something special.',
                hint: 'Templates exist so you do not have to think. Use them.',
            },
            {
                id: 'instruct',
                targets: ['#sb-af-instruct'],
                optional: true,
                title: 'Instruct Template',
                body: 'Many local models were trained to expect special markers around each message. The **Instruct Template** adds them. Choose the one named after your model family, or let Neconyan pick it automatically.',
                hint: 'Wrong markers, confused model. Simple as that.',
            },
            {
                id: 'system',
                targets: ['#sb-af-sysprompt'],
                optional: true,
                title: 'System Prompt',
                body: 'The **System Prompt** is the standing instruction at the top, such as **Write the next reply in this roleplay**. You can also set what gets added after the chat, words that end a reply early, and how tokens are counted.',
                hint: 'Short and clear. Long system prompts are a confession of indecision.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. If a local model rambles or speaks for you, check the Instruct Template first.',
                hint: 'Now, I will be outside. Briefly.',
            },
        ],
    },
    mewmory: {
        assistant: 'taro',
        name: 'Mewmory',
        kicker: 'Long-term memory',
        description: 'Mewmory remembers events and NPC details from your Roleplay chats, and tracks how each character’s view changes, so long stories stay consistent.',
        invite: 'Taro will show you how Mewmory remembers, one step at a time.',
        emptyWhen: '#mewmory-workspace [data-mewmory-no-chat]',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What Mewmory does',
                body: 'Models forget anything that falls out of the chat they can read. **Mewmory** reads your Roleplay chat as it goes, writes down facts and events, and adds the ones that matter back into the prompt.\nIt works per chat, so each story keeps its own memories.',
                hint: 'I never forget a face. Mewmory never forgets a fact. We get along.',
            },
            {
                id: 'scope',
                targets: ['.mewmory-heading'],
                title: 'Which chat this is',
                body: 'The top line shows which chat Mewmory is looking at. **Refresh** reloads its memories after you edit messages elsewhere.',
                emptyBody: 'Open a saved Roleplay chat to inspect its memories. You can still set up the models in **Settings** without a chat. We will walk through those controls too.',
                hint: 'No chat, no memories. Even I need material.',
            },
            {
                id: 'tabs',
                targets: ['.mewmory-tabs'],
                optional: true,
                title: 'The five tabs',
                body: '**Now** shows current facts and events. **Pawspective** tracks what each character thinks and knows. **Archive** lets you search older memories. **Recall** explains which memories were selected for a reply. **Settings** controls the models, privacy and space used for memory.\nYou can click these tabs yourself, or use **Next** to follow along. The tour does not change or save your configuration.',
                hint: 'Check Recall when a character forgets something. It tells you exactly why.',
            },
            {
                id: 'pane',
                tab: '#mewmory-tab-now',
                targets: ['#mewmory-pane-now'],
                title: 'Reading and fixing memories',
                body: 'With a saved chat open, **Now** shows the memories for that story. Turn on **Use Mewmory in this chat** when you want it to remember this chat. That switch does not turn it on for other chats.\nEdit a wrong memory instead of keeping an incorrect fact. If this page is empty, open a saved Roleplay chat first; you can still follow the Settings steps now.',
                hint: 'Wrong notes are worse than no notes. Correct them.',
            },
            {
                id: 'pawspective', tab: '#mewmory-tab-pawspective', targets: ['#mewmory-pane-pawspective'],
                title: 'Whose point of view is this?',
                body: '**Pawspective** separates what each character knows and believes from the story’s objective facts. Choose the character and subject to inspect their view. The source messages let you check why that view was recorded.\nAn empty tab can mean there is no saved chat or no interview yet; configure the Pawspective role before expecting it to create interviews.',
                hint: 'Knowing a fact and believing it are different things.',
            },
            {
                id: 'archive', tab: '#mewmory-tab-archive', targets: ['#mewmory-pane-archive'],
                title: 'Find an older memory',
                body: '**Archive** searches the chat’s stored memories. Use its filters to narrow the type or search text. Older messages are not deleted when Mewmory leaves them out of the reply prompt.\nCheck the source before editing or deleting a memory. Those actions change the saved story; the tour only shows where they are.',
                hint: 'Check what actually happened before correcting the record.',
            },
            {
                id: 'recall', tab: '#mewmory-tab-recall', targets: ['#mewmory-pane-recall'],
                title: 'Check what went into the reply',
                body: '**Recall** shows the memory selection for a reply, including its status and limits. A stored detail is not guaranteed to be selected every time.\nWhen a reply misses something, check that the memory exists, then check Recall. Connection failures or insufficient space are different from a memory that was never recorded.',
                hint: 'Start with the evidence. It saves a lot of guessing.',
            },
            {
                id: 'settings', tab: '#mewmory-tab-settings', targets: ['#mewmory-pane-settings [data-mewmory-tour="automatic"] > .mewmory-caption'],
                title: 'Settings are shared; switching on is per chat',
                body: 'These settings are shared by your chats, but **Use Mewmory in this chat** is a separate switch for each story. Mewmory also has its own model connections; changing the model that writes your chat replies does not configure these roles.\nChanges here are a draft until you press **Save configuration**. We will look at the controls without changing them.',
                hint: 'Read first. Save when you actually mean it.',
            },
            {
                id: 'roles', tab: '#mewmory-tab-settings', targets: ['.mewmory-role-picker'],
                title: 'Choose a job, then configure its model',
                body: '**Facts and events** reads the chat and writes memories. **Pawspective interviews** records a character’s point of view. **Recall selector** chooses from existing memories; **Recall fallback** is the alternative selection role. Neither recall role invents new memories.\nClick a role to see its settings. The roles can use the same model or different models. **Enable this role** determines whether that job is available.',
                hint: 'Different jobs. They need not be different models.',
            },
            {
                id: 'connection', tab: '#mewmory-tab-settings', open: '#mewmory-role-extractor',
                targets: ['#mewmory-field-profile-extractor'],
                title: 'Reuse a saved connection, or enter one manually',
                body: 'A **Connection profile** uses the model and protected credentials saved in Connections. A blank **Model override, optional** keeps that profile’s model; enter an override only to use another model on the same service.\n**Manual endpoint** instead shows the service’s OpenAI-compatible address, model name and API key. A blank key keeps a saved key. The separate removal checkbox deletes it when you save.',
                hint: 'Use the connection you already trust. No need to type the key twice.',
            },
            {
                id: 'privacy', tab: '#mewmory-tab-settings',
                targets: ['#mewmory-pane-settings [data-mewmory-tour="permissions"]'],
                title: 'Decide what each role may read',
                body: '**This role may read** controls whether the selected role receives chat messages, character cards, enabled lore or saved memories. Review those permissions for each role.\n**Only use models on this computer** applies to every role. Sending data to a service on another computer also needs that role’s **Allow sending story data** permission. A hosted provider is another computer, even when Neconyan itself runs locally.',
                hint: 'Your story, your permissions. Check them before you save.',
            },
            {
                id: 'limits', tab: '#mewmory-tab-settings', open: '#mewmory-role-extractor',
                targets: ['#mewmory-field-context-extractor', '#mewmory-field-output-extractor'],
                title: 'Give the memory model accurate limits',
                body: '**Context limit, tokens** is how much text this role’s model can take. Tokens are the pieces of text models count. Use the service’s real limit; raising this number does not make the model larger.\n**Output limit, tokens** reserves room for its answer, leaving less room for the request. **Timeout, seconds** is how long to wait. **Tokenizer for this role** controls the text-counting method; Auto tries to match the model. **Model revision, optional** records a version identifier.',
                hint: 'A bigger number on the form does not change the model. Unfortunately.',
            },
            {
                id: 'embeddings', tab: '#mewmory-tab-settings', open: '#mewmory-role-embedding',
                targets: ['#mewmory-role-embedding'],
                title: 'Meaning search is optional',
                body: '**Embeddings** turns text into numbers used to find memories with a similar meaning. Keyword search still works with this role off. Use a model that supports embeddings, not an ordinary chat model; saved profiles must be OpenAI-compatible.\nThe output limit does not apply here. Set query or document prefixes only when your embedding model’s instructions require them. This role has its own data and remote-service permissions too.',
                hint: 'Optional means optional. Get the basic setup working first.',
            },
            {
                id: 'updates', tab: '#mewmory-tab-settings',
                targets: ['[id="mewmory-field-Messages per update"]'],
                title: 'Choose how often new memories are written',
                body: '**Update automatically during play** makes Mewmory process new chat while you play. **Messages per update** sets the batch size: smaller batches ask it to update more often and put less text into each request.\nFor an existing chat, **Catch up on this whole chat** processes earlier messages. **Check for missed details** checks the chat again. Those are real model requests, not steps the tour runs for you.',
                hint: 'More frequent work can mean more requests. Choose deliberately.',
            },
            {
                id: 'budgets', tab: '#mewmory-tab-settings',
                targets: ['[id="mewmory-field-Recent chat target, tokens"]'],
                title: 'Share the reply model’s available space',
                body: '**Recent chat target, tokens** is the target for recent chat only. **Selected memory budget, tokens** limits the selected memories added to the reply prompt. Character details, NPC references and other instructions also need space.\n**Recall candidates** limits the memories considered for selection. **Writer tokenizer** counts text for the model writing your replies, separately from each memory role’s tokenizer. **Leave out older chat that Mewmory has already remembered** can shorten the prompt; the older messages stay saved.',
                hint: 'Recent chat and memories both need room. Neither gets the whole limit.',
            },
            {
                id: 'save', tab: '#mewmory-tab-settings',
                targets: ['#mewmory-pane-settings > .mewmory-actions', '#mewmory-settings-status'],
                title: 'Save deliberately, and read the result',
                body: '**Save configuration** applies your draft. **Discard unsaved settings** returns to the saved version. The status below tells you whether there are unsaved changes, a successful save or an error.\nIf settings were saved elsewhere, discard your stale draft to load them before editing again. The tour does not press Save, turn on roles or spend a model request.',
                hint: 'A saved configuration is what runs. A draft is only a draft.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Choose connections for the roles you need, check their data permissions and limits, then **Save configuration**. Open a saved Roleplay chat and turn on **Use Mewmory in this chat** when ready.\nPress **Tour** whenever you want to review these settings. If a detail is missing from a reply, check **Recall** to see what was selected.',
                hint: 'Now, I remember there was a cigarette somewhere.',
            },
        ],
    },
    agents: {
        assistant: 'taro',
        name: 'Agents',
        kicker: 'Helpers beside the chat',
        description: 'Agents are saved helper prompts that run around each reply. They can steer the reply before it is written, rewrite it afterwards, or keep notes of their own.',
        invite: 'Taro will show you how agents work, including the advanced settings, one step at a time.',
        emptyWhen: '#ica--agentList .ica--empty-state',
        dialogs: {
            editor: {
                root: '#ica--editor',
                openers: ['#ica--agentList .ica--agent-card .ica--btn-edit', '#ica--addAgent'],
                close: '.popup-button-cancel',
                sectionSelect: '#ica--editor-section-select',
            },
        },
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What agents do',
                body: 'An **agent** is a saved prompt with rules for when it runs, which model it uses and where its result goes.\nAn **inline** agent works on the reply itself: it adds instructions before the reply is written, or changes the reply afterwards. A **companion** makes its own request after a reply and saves a separate note. It never replaces the reply.',
                hint: 'Think of them as staff. Good staff, when you tell them exactly what to do.',
            },
            {
                id: 'overview', tab: '.ica--workspace-tab[data-workspace-view="manage"]',
                targets: ['.ica--overview'],
                title: 'The status line',
                body: 'This line shows whether agents are running, how many you have, how many are switched on, and how many **Prompt tokens** the switched-on agents add to each request. Tokens are the pieces of text models count.\n**Agents On** pauses every agent at once and keeps each agent’s own switch as it was. **Stop agent** appears only while an agent is running.',
                hint: 'One switch to silence the lot. Use it before you start blaming the model.',
            },
            {
                id: 'create', tab: '.ica--workspace-tab[data-workspace-view="manage"]',
                targets: ['.ica--toolbar'],
                title: 'Make an agent, or borrow one',
                body: '**Create agent** starts a blank agent. **Browse library** lists ready-made agents and **Starter kits**, which add a few agents that work together.\n**Select** lets you tick several agents and change them at once: their settings, their connection, or whether their notes stay in the chat history.',
                hint: 'Start from the library. Writing everything yourself is how people end up writing it twice.',
            },
            {
                id: 'setups', tab: '.ica--workspace-tab[data-workspace-view="manage"]',
                targets: ['.ica--setup-controls'],
                title: 'Saved setups',
                body: 'A **saved setup** remembers your agents and which ones are switched on. **Save setup** stores the current state under a name, and **Load** brings it back later without deleting agents that are not in it.\nUse setups to swap between, say, a quiet setup for short chats and a full setup for long stories.',
                hint: 'Name them properly. ‘Setup 3 final’ helps nobody.',
            },
            {
                id: 'more-tools', tab: '.ica--workspace-tab[data-workspace-view="manage"]', open: '#ica--moreTools > summary',
                targets: ['#ica--moreTools'],
                title: 'More tools',
                body: '**Fix trackers** runs your tracker agents again on the last reply. Trackers are agents that keep a running record, such as clothes, location or health. **Activity & companions** opens the companion dashboard, where you can run companions and read their history.\n**Move trackers to companions** turns inline trackers into companions so they stop changing the reply. **Import agents** and **Export agents** use files. **Reset bundled agents** restores the agents that came with Neconyan and leaves your own agents alone.',
                hint: 'Reset only touches the bundled ones. Your own work is safe. Mostly from you.',
            },
            {
                id: 'filters', tab: '.ica--workspace-tab[data-workspace-view="manage"]', optional: true,
                targets: ['#ica--agentTabs', '#ica--search'],
                title: 'Find an agent',
                body: '**All**, **Pinned**, **Before reply**, **After reply** and **Companions** sort the list by when an agent runs. The search box and category filter narrow it further.\nFilters only change what you see. They never switch an agent off.',
                hint: 'Hidden is not off. People mix those up constantly.',
            },
            {
                id: 'card', tab: '.ica--workspace-tab[data-workspace-view="manage"]',
                targets: ['#ica--agentList .ica--agent-card .ica--card-header', '#ica--agentList'],
                title: 'Reading an agent card',
                body: 'The switch on the left turns this agent on or off. Beside the name, the card shows whether it works **Inline** or as a **Companion**, and whether it runs before or after the reply.\nThe small labels underneath summarise its settings, such as its chance to run, its depth, whether it rewrites the reply, its connection and its **Order**. The star pins it, and the handle lets you drag it into a new position.',
                emptyBody: 'Your agent list is empty, so there is no card to show yet. Use **Browse library** or **Create agent** first.\nEach card has a switch, shows whether the agent works inline or as a companion and when it runs, and lists its main settings underneath.',
                hint: 'Read the labels. They tell you most of the story without opening anything.',
            },
            {
                id: 'card-actions', tab: '.ica--workspace-tab[data-workspace-view="manage"]',
                targets: ['#ica--agentList .ica--agent-card .ica--card-actions', '#ica--agentList'],
                title: 'Card buttons',
                body: '**Run** or **Apply to reply** runs the agent now on the latest reply. **Settings** opens a short form with the most common options. **Edit** opens the full editor, which we look at next.\n**More actions** holds Preview, Apply to target, a switch between inline and companion, Export and Delete. Companions also get **Batch & connect** and their own history.',
                hint: 'Run it once by hand before you trust it on autopilot.',
            },
            {
                id: 'editor-basics', dialog: 'editor', tab: '#ica--editor-tab-basics',
                targets: ['#ica--editor-panel-basics'],
                title: 'The editor: basics',
                body: 'The tour opened the editor for you. It closes again without saving when we move on.\n**Run timing** decides when the agent works: before the reply is written, after it, or both. **Where results go** decides the kind of agent: **Prompt or reply** makes it inline, **Companion note** makes it a companion with its own **Companion output** tab.',
                hint: 'Timing and destination. Get those two right and the rest is detail.',
            },
            {
                id: 'editor-instructions', dialog: 'editor', tab: '#ica--editor-tab-instructions',
                targets: ['#ica--editor-panel-instructions'],
                title: 'Instructions and model',
                body: 'The large box holds the agent’s instructions. **Macros** such as {{char}} and {{user}} are filled in when it runs, and the preview button shows the finished text.\nEach agent can use its own **Connection profile** and **Model override**, so a cheap, fast model can do the small jobs. The refine button asks a model to improve the instructions and shows the original and new versions side by side before anything changes.',
                hint: 'Small jobs, small model. Your wallet will thank you.',
            },
            {
                id: 'editor-before', dialog: 'editor', tab: '#ica--editor-tab-when', open: '#ica--before-mode-controls > summary',
                targets: ['#ica--injection-section', '#ica--editor-panel-when'],
                title: 'Before the reply: inject or intercept',
                body: 'These controls appear when the agent runs before the reply. **Inject** adds the agent’s prompt to the main request, which costs nothing extra. **Intercept** makes a separate request first and can **Replace**, **Wrap** or **Patch** part of the context, so it costs more.\n**Position**, **Depth** and **Role** choose where injected text goes: in the prompt, or a number of messages back in the chat, sent as system, user or assistant text. The scan option lets words in this prompt trigger lorebook entries.',
                hint: 'Inject is free. Intercept is a second request. Choose like you pay for it, because you do.',
            },
            {
                id: 'editor-conditions', dialog: 'editor', tab: '#ica--editor-tab-when',
                targets: ['#ica--editor-panel-when'],
                title: 'When it runs',
                body: '**Order** decides which agent goes first; lower numbers run earlier. It is a sequence, not a ranking of importance. **Probability** is the chance it runs when everything else matches.\n**Trigger keywords** limit it to chats that mention certain words; leave them empty to run every time. **Generation types** choose whether it runs for normal replies, Continue, Impersonate or background requests.',
                hint: 'Keywords keep a specialist agent quiet until it is actually needed.',
            },
            {
                id: 'editor-reply', dialog: 'editor', tab: '#ica--editor-tab-reply', optional: true,
                targets: ['#ica--editor-panel-reply'],
                title: 'After the reply: reply changes',
                body: 'A **post-generation pass** sends the finished reply to the agent for a second look. **Rewrite current message** replaces the reply with the agent’s version; **Append generated content** adds its text to the end instead.\nYou can also run these passes on text written for you with Impersonate, or on companion notes before they are saved. Every change is kept in the message’s history, where you can compare the old and new text and undo it.',
                hint: 'A proofreader that never sleeps. Check its work anyway.',
            },
            {
                id: 'editor-companion', dialog: 'editor', tab: '#ica--editor-tab-basics',
                targets: ['#ica--editor-execution', '#ica--editor-panel-basics'],
                title: 'Companions in depth',
                body: 'Set **Where results go** to **Companion note** and the **Companion output** tab appears. There you choose whether the companion runs automatically or only when asked, how its note is shown, and how much of the chat, character card, persona and lorebooks it reads.\nNotes can be fed back into later replies, so a companion can keep a plot outline or a tracker that the main model follows. Advanced routing lets companions run in a batch, share context or wait for each other.',
                hint: 'Companions take notes. The reply stays yours.',
            },
            {
                id: 'editor-regex', dialog: 'editor', tab: '#ica--editor-tab-regex',
                targets: ['#ica--editor-panel-regex'],
                title: 'Tidy the output with regex',
                body: '**Regex** scripts are find-and-replace rules that tidy an agent’s output, for example to hide tracker tags or reformat a block. Each agent keeps its own scripts.\nBundled agents can restore their original scripts if you change them and regret it.',
                hint: 'Regex is powerful and unforgiving. Test on a copy.',
            },
            {
                id: 'editor-save', dialog: 'editor',
                targets: ['.popup-controls'],
                title: 'Save or walk away',
                body: '**Save** keeps your changes to this agent. **Cancel** closes the editor and forgets them.\nThe tour presses Cancel for you on the next step, so nothing you looked at was changed.',
                hint: 'Nothing saved. I am careful with other people’s things.',
            },
            {
                id: 'connections', tab: '.ica--workspace-tab[data-workspace-view="connections"]',
                targets: ['#ica--panel-connections .ica--settings-group:nth-of-type(1)'],
                title: 'Default connections',
                body: '**Connections & defaults** holds settings shared by every agent. **Default connection profile** is used by any agent without its own profile; **Current connection** follows the model you chat with.\n**Companion connection profile** gives companions a separate default. A quick, inexpensive model is usually enough for notes.',
                hint: 'Set the defaults once. Override only where it matters.',
            },
            {
                id: 'rhythm', tab: '.ica--workspace-tab[data-workspace-view="connections"]',
                targets: ['#ica--panel-connections .ica--settings-group:nth-of-type(2)'],
                title: 'Together or one at a time',
                body: '**Run together** starts several agents at once, which is faster. **Run one at a time** is gentler on services that limit how many requests you send.\nThe last switch lets companions start while reply changes are still running, instead of waiting for them to finish.',
                hint: 'If your provider starts refusing requests, slow down here first.',
            },
            {
                id: 'context', tab: '.ica--workspace-tab[data-workspace-view="connections"]',
                targets: ['#ica--panel-connections .ica--settings-group:nth-of-type(3)'],
                title: 'Context and notices',
                body: '**Helper prefill messages** add text to the start of every agent request, written as [system], [user] or [assistant] blocks. **Keep individual and group chat switches separate** lets group chats use different agents.\nThe notification switches control the small notices about reply changes. **Companion panel button** chooses where the button for the companion panel sits.',
                hint: 'Fewer notices, calmer chat. Your call.',
            },
            {
                id: 'pawthfinder', tab: '.ica--workspace-tab[data-workspace-view="connections"]', optional: true,
                targets: ['#ica--panel-connections .ica--settings-group:nth-of-type(4)'],
                title: 'Pawthfinder',
                body: '**Pawthfinder** is a bundled agent with its own page. It looks things up in your lorebooks while you chat. This switch keeps it available, and **Open Pawthfinder** takes you to its settings.',
                hint: 'My own little project. Treat it kindly.',
            },
            {
                id: 'glossary',
                targets: ['#ica--workspaceNav a[href="/docs/in-chat-agents-glossary"]'],
                optional: true,
                title: 'The glossary',
                body: 'The **ICA glossary** explains every term on this page in more detail. It opens in a new tab, so you will not lose your place here.',
                hint: 'I wrote notes in the margins. You will find them.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Start with one agent from the library, run it once by hand, then switch it on. Open **Edit** when you want to change when it runs, which model it uses or what it does to the reply.\nPress **Tour** whenever you want this walk again.',
                hint: 'Now, about that cigarette.',
            },
        ],
    },
    persona: {
        assistant: 'miso',
        name: 'Persona',
        kicker: 'Who you are',
        description: 'Your persona is the character you play: a name, a picture and a short description the model reads so it knows who it is talking to.',
        invite: 'Miso will show you how to set up who you are, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What a persona is',
                body: 'A **persona** is you, in the story. Its name replaces **{{user}}** in cards and prompts, and its description tells the model what you look like and how you act.\nYou can have as many personas as you like and switch between them.',
                hint: 'You can be anyone! A knight, a cat, a cat knight. I vote cat knight.',
            },
            {
                id: 'list',
                targets: ['#persona_workspace_panel_browse'],
                tab: '#persona_workspace_tab_browse',
                optional: true,
                title: 'Your personas',
                body: 'Click a persona to use it. **Create** makes a new one, **Import persona** loads one from a file, and the search box finds one by name.',
                hint: 'Ooh, so many of you to choose from!',
            },
            {
                id: 'controls',
                targets: ['#persona_controls'],
                tab: '#persona_workspace_tab_edit',
                optional: true,
                title: 'Name, picture and file',
                body: '**Rename** changes the name, **Image** changes the picture, and **Export** saves this persona with its picture to a file you can keep or share.',
                hint: 'Pick a cute picture. It shows next to every message you send!',
            },
            {
                id: 'lore',
                targets: ['#persona_lore_actions'],
                tab: '#persona_workspace_tab_edit',
                optional: true,
                title: 'Linked lorebook',
                body: 'A **lorebook** is a set of notes the model reads when certain words come up. Linking one here means it follows this persona into every chat.',
                hint: 'Perfect for your backstory. Everyone deserves a backstory.',
            },
            {
                id: 'description',
                targets: ['#persona_description'],
                tab: '#persona_workspace_tab_edit',
                optional: true,
                title: 'Persona Description',
                body: 'Write who you are in a few lines: looks, personality, anything the model should know. Keep it short; the model reads it before every reply.\n**Scenario Notes**, just below, add extra details for one chat only.',
                open: ['#persona_appendices_heading'],
                hint: 'A few good lines beat a whole essay. Trust me!',
            },
            {
                id: 'position',
                targets: ['.persona_management_description_position_container'],
                tab: '#persona_workspace_tab_edit',
                optional: true,
                title: 'Where it goes',
                body: '**Position** decides where your description is placed in the prompt. **In Story String / Prompt Manager** suits almost everyone.',
                hint: 'Leave this one alone unless something feels off.',
            },
            {
                id: 'use',
                targets: ['#persona_editor_tab_connections'],
                tab: '#persona_workspace_tab_edit',
                optional: true,
                title: 'Use and More',
                body: '**Use** locks this persona to the current chat, to a character, or makes it your default. **More** has duplicate, delete, backup and a few global settings.',
                hint: 'Lock it to your favourite character and it will always be ready!',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. A name, a picture and two lines of description are enough to start.',
                hint: 'Now, if anyone wants to give me belly rubs, I am right here.',
            },
        ],
    },
    'dialogue-colors': {
        assistant: 'miso',
        name: 'Dialogue Colors',
        kicker: 'Who said what',
        aliases: ['sillytavern-character-colors'],
        description: 'Give every speaker their own colour, so you can tell at a glance who is talking in busy scenes.',
        invite: 'Miso will show you how to colour your chats, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What Dialogue Colors does',
                body: '**Dialogue Colors** finds the quoted speech in replies, works out who said it, and colours it to match that speaker.\nIt helps most in group chats and stories with lots of characters.',
                hint: 'Everybody gets a colour! I want orange. Obviously.',
            },
            {
                id: 'setup',
                targets: ['#dc-page-setup'],
                open: ['#dc-page-setup'],
                title: 'Current setup',
                body: '**Enabled** turns colouring on. **Colors saved** decides whether colours are kept per chat, per character card, or everywhere.\n**Engine** chooses how it works: **Local** colours the screen only and never changes your messages; **LLM** asks a model to add colour tags into the text itself.',
                hint: 'Local is the gentle one. Start with Local!',
            },
            {
                id: 'process',
                targets: ['#dc-page-process'],
                open: ['#dc-page-process'],
                title: 'Process chat',
                body: '**Scan entire chat** reads the chat and finds the speakers. **Colorize** fills in colours where dialogue has none yet, and **Recolor** updates colours you already have.',
                hint: 'Scan first, then colour. Order matters, even for cats.',
            },
            {
                id: 'characters',
                targets: ['#dc-page-characters'],
                open: ['#dc-page-characters'],
                title: 'Characters',
                body: 'Every speaker found is listed here with their colour. Click a colour to change it, or add a name by hand if someone was missed.',
                hint: 'Give the villain a dramatic colour. It is more fun.',
            },
            {
                id: 'appearance',
                targets: ['#dc-page-appearance'],
                open: ['#dc-page-appearance'],
                title: 'Appearance',
                body: 'Pick a palette and brightness, preview it for colour-blind readers, and choose extras such as bold speech or a small legend of who is who.',
                hint: 'Pretty and readable. Like me!',
            },
            {
                id: 'more',
                targets: ['#dc-page-engine', '#dc-page-automation'],
                optional: true,
                title: 'The rest',
                body: 'The sections further down set the model used in **LLM** mode, what runs automatically after each reply, saved styles, file import and export, and tidy-up tools.\n**Danger zone** at the very bottom removes colours for good, so read it twice before pressing anything there.',
                hint: 'Danger zone means danger. I hide under the sofa for that one.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. Turn on **Enabled**, keep **Local**, and press **Scan entire chat** to begin.',
                hint: 'Now go make everything colourful! And maybe rub my belly on the way.',
            },
        ],
    },
    background: {
        assistant: 'miso',
        name: 'Background',
        kicker: 'Behind your chats',
        description: 'Choose the picture or video behind your chats, for every chat or just this one.',
        invite: 'Miso will show you how to change the background, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What this page is for',
                body: 'The **background** is the picture behind your messages. Pick one from your collection, upload your own, or use a looping video.',
                hint: 'Pick something cosy! A sunny windowsill, maybe.',
            },
            {
                id: 'fit',
                targets: ['#bg-header-fixed'],
                title: 'Fitting and adding',
                body: 'The first list sets how the picture fills the screen, such as **Cover** or **Contain**. The second chooses which part stays in view.\n**Auto-select** asks your model to pick a background that suits the current chat. **New Folder** and **Add Background** organise and upload pictures, and the search box finds one by name.',
                hint: 'Auto-select is like letting me decorate. Bold, but it works!',
            },
            {
                id: 'animated',
                targets: ['#bpt-animated-bg-panel'],
                optional: true,
                title: 'Animated Backgrounds',
                body: 'Paste a YouTube link or a direct video link and press **Use URL** to play it behind the chat. **Muted**, **Loop** and **Autoplay** control how it plays, and saved links appear below.',
                hint: 'A crackling fireplace video. Trust me. So cosy.',
            },
            {
                id: 'list',
                targets: ['#bg_tabs'],
                optional: true,
                title: 'Your backgrounds',
                body: 'Click a picture to use it. **Global** sets the background for every chat; **Chat** sets one just for the chat you have open.\nThe pencil lets you select several to delete or move, and the minus and plus buttons make the pictures smaller or bigger.',
                hint: 'A different background for every story! Fancy.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. Try the **Chat** tab to give one story its own look.',
                hint: 'Now, about that sunny windowsill...',
            },
        ],
    },
    server: {
        assistant: 'taro',
        name: 'Server',
        kicker: 'Behind the scenes',
        description: 'Check that Neconyan is running properly, install updates, and change the settings that live on the server itself.',
        invite: 'Taro will walk you through the server controls, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What the server is',
                body: 'Neconyan has two halves: the page in your browser, and the **server**, the program that stores your chats and talks to the model. This page looks after the server.',
                hint: 'The part nobody sees. I respect it.',
            },
            {
                id: 'status',
                targets: ['.sb-server-card'],
                title: 'Server status',
                body: 'The top card shows whether the server is running, which version you have, and where it was installed from. Mention these when you report a problem.',
                hint: 'Facts first. Always.',
            },
            {
                id: 'updates',
                targets: ['.sb-server-card:nth-of-type(2)', '.sb-server-card + .sb-server-card'],
                optional: true,
                title: 'Updates & Restart',
                body: '**Check for updates** looks for a newer version. **Update & Restart** installs it and restarts the server, which takes a few seconds. **Restart server** restarts without updating.\nYour chats are not touched by an update.',
                hint: 'Restart when nobody is mid-reply. Basic manners.',
            },
            {
                id: 'thumbnails',
                targets: ['.sb-thumbnail-card'],
                optional: true,
                title: 'Thumbnails',
                body: '**Thumbnails** are the small copies of avatars and backgrounds shown in lists. Smaller ones load faster on phones; larger ones look sharper.',
                hint: 'Sharp or fast. Choose. You cannot have both for free.',
            },
            {
                id: 'config',
                targets: ['.sb-server-config-editor'],
                optional: true,
                title: 'Server settings file',
                body: 'This box edits **config.yaml**, the file that holds the server settings, such as the port and the login. **Save & Restart** applies changes.\nA typing mistake here can stop the server starting, so change one line at a time.',
                hint: 'Careful. I have seen people take a whole server down with one stray space.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. Check for updates now and then; that is all most people need here.',
                hint: 'Right. Smoke break.',
            },
        ],
    },
    'console-logs': {
        assistant: 'taro',
        name: 'Console Logs',
        kicker: 'Troubleshooting',
        description: 'Read what the server is doing right now, so you can see why a reply failed or something will not load.',
        invite: 'Taro will show you how to read the logs, one step at a time.',
        steps: [
            {
                id: 'welcome',
                targets: ['.neconyan-tool-page-intro'],
                title: 'What logs are',
                body: '**Logs** are the notes the server writes as it works: each request to the model, each error, each restart. When something breaks, the reason is usually here.',
                hint: 'Evidence. My favourite thing after a quiet room.',
            },
            {
                id: 'output',
                targets: ['.sb-console-log-card'],
                title: 'Reading the log',
                body: 'New lines appear at the bottom while **Live** is on. **Pause Live** freezes the view so you can read; **Refresh** reloads it.\n**Copy logs** copies everything, ready to paste into a bug report. Check it for anything private first.',
                hint: 'Read from the bottom up. The newest mess is at the bottom.',
            },
            {
                id: 'verbose',
                targets: ['.sb-console-log-verbose-card'],
                optional: true,
                title: 'Debug Logging',
                body: 'Turning on **Debug Logging** makes the server write much more detail. It helps track down hard problems; switch it off afterwards to keep the log readable.',
                hint: 'More detail is good. Until it is not.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. When a reply fails, come here first and look at the last few red lines.',
                hint: 'Done. Lighter?',
            },
        ],
    },
});

/**
 * Finds the full-page tool that matches an Included tool id or label.
 * @param {string} id Tool id such as 'pathfinder' or 'third-party/Name'
 * @returns {string} Page key, or '' when the tool has no full page
 */
export function getToolPageKey(id) {
    const wanted = String(id ?? '').trim().replace(/^third-party[\\/]/i, '').toLowerCase();
    if (!wanted) return '';
    const matches = name => wanted === name || wanted.endsWith(`/${name}`);
    return Object.keys(TOOL_PAGES).find(key => matches(key) || (TOOL_PAGES[key].aliases ?? []).some(matches)) || '';
}

/**
 * Returns the page details and tour for a full-page tool.
 * @param {string} id Tool id or page key
 * @returns {object|null} Page details, or null
 */
export function getToolPage(id) {
    const key = getToolPageKey(id);
    return key ? { key, ...TOOL_PAGES[key] } : null;
}

/**
 * Lists the tour steps for a page, dropping optional steps whose control is not on screen.
 * @param {string} id Tool id or page key
 * @param {{ isShown?: (step: object) => boolean, empty?: boolean }} [state] What is visible right now
 * @returns {object[]} Steps in order
 */
export function getToolTourSteps(id, { isShown = () => true, empty = false } = {}) {
    const page = getToolPage(id);
    if (!page) return [];
    return page.steps
        .filter(step => !step.optional || isShown(step))
        .map(step => ({ ...step, body: empty && step.emptyBody ? step.emptyBody : step.body }));
}

/**
 * Splits tour copy into paragraphs of text and bold runs, so it never needs HTML strings.
 * @param {string} text Copy with newline paragraphs and **bold** runs
 * @returns {{ text: string, bold: boolean }[][]} Paragraphs of runs
 */
export function parseToolTourCopy(text) {
    return String(text ?? '').split('\n').filter(line => line.trim()).map(line =>
        line.split('**').map((segment, index) => ({ text: segment, bold: index % 2 === 1 })).filter(run => run.text));
}

function translateCopy(text) {
    return String(text ?? '').split('\n').map(line => line.trim() && t([line.trim()])).join('\n');
}

const tour = {
    key: '',
    root: null,
    heading: null,
    card: null,
    stepId: '',
    target: null,
    watch: 0,
    observer: null,
    token: 0,
    opener: null,
    spacer: null,
    dialog: null,
    dialogConfig: null,
    dialogObserver: null,
};

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function portrait(assistant) {
    const image = element('img', 'neconyan-tool-tour-portrait');
    image.src = getAssistantIconSrc(assistant);
    image.alt = '';
    image.width = 48;
    image.height = 48;
    return image;
}

function isShown(node) {
    return node instanceof HTMLElement && node.getClientRects().length > 0;
}

function findShown(root, selector) {
    try {
        return [...root.querySelectorAll(selector)].find(isShown)
            || (root === tour.root ? [...(tour.heading?.querySelectorAll(selector) ?? [])].find(isShown) : null) || null;
    } catch {
        return null;
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function prefersReducedMotion() {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function coveredByCard(node) {
    const card = tour.card?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    if (!card) return false;
    return rect.bottom > card.top && rect.top < card.bottom && rect.right > card.left && rect.left < card.right;
}

function getDialogConfig(step) {
    return step?.dialog ? TOOL_PAGES[tour.key]?.dialogs?.[step.dialog] ?? null : null;
}

function stepScope(step) {
    return step?.dialog ? tour.dialog : tour.root;
}

function isDialogStepShown(step) {
    // Until the dialog is open its tabs cannot be checked, so keep the step and decide once it opens.
    if (!tour.dialog) return true;
    const tab = step.tab ? tour.dialog.querySelector(step.tab) : null;
    if (step.tab) return Boolean(tab && !tab.hidden);
    return step.targets.some(selector => tour.dialog.querySelector(selector));
}

function currentSteps() {
    const root = tour.root;
    const emptyWhen = TOOL_PAGES[tour.key]?.emptyWhen;
    const empty = Boolean(emptyWhen && root?.querySelector(emptyWhen));
    return getToolTourSteps(tour.key, {
        empty,
        isShown: step => step.dialog ? isDialogStepShown(step) : Boolean(root && (step.targets.some(selector => findShown(root, selector))
            || (step.tab && findShown(root, step.tab) && step.targets.some(selector => root.querySelector(selector))))),
    });
}

function releaseTourDialog() {
    tour.dialogObserver?.disconnect();
    tour.dialogObserver = null;
    tour.dialog = null;
    tour.dialogConfig = null;
    if (tour.card && tour.card.parentElement !== document.body) {
        tour.card.style.removeProperty('bottom');
        document.body.append(tour.card);
    }
}

function closeTourDialog() {
    const dialog = tour.dialog;
    const config = tour.dialogConfig;
    if (!dialog) return;
    releaseTourDialog();
    if (dialog.open && !dialog.hasAttribute('closing')) findShown(dialog, config?.close ?? '')?.click();
}

function onTourDialogClosing() {
    const dialog = tour.dialog;
    if (!dialog || (dialog.open && !dialog.hasAttribute('closing'))) return;
    // The user closed the dialog, so the tour carries on with the first step outside it.
    releaseTourDialog();
    if (!tour.card) return;
    const steps = currentSteps();
    const index = steps.findIndex(step => step.id === tour.stepId);
    if (!steps[index]?.dialog) return;
    const next = steps.slice(index).find(step => !step.dialog);
    if (next) void show(next.id);
    else endToolTour({ restoreFocus: false });
}

async function openTourDialog(step, token) {
    const config = getDialogConfig(step);
    if (!config) return null;
    if (tour.dialog?.isConnected && tour.dialog.open && tour.dialogConfig === config) return tour.dialog;
    closeTourDialog();
    let host = findShown(document, config.root);
    if (!host) {
        const opener = config.openers.map(selector => findShown(tour.root, selector)).find(Boolean);
        if (!opener) return null;
        opener.click();
        for (let attempt = 0; attempt < 40 && !host; attempt++) {
            await wait(100);
            if (token !== tour.token) return null;
            host = findShown(document, config.root);
        }
    }
    const dialog = host?.closest('dialog');
    if (!dialog || token !== tour.token) return null;
    tour.dialog = dialog;
    tour.dialogConfig = config;
    tour.dialogObserver = new MutationObserver(onTourDialogClosing);
    tour.dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['closing', 'open'] });
    // A modal dialog makes everything outside it unclickable, so the card moves inside while the dialog is open.
    if (tour.card) {
        dialog.append(tour.card);
        // The card sits above the dialog's own buttons so Save and Cancel stay reachable.
        const controls = findShown(dialog, '.popup-controls');
        const clearance = controls ? Math.max(0, window.innerHeight - controls.getBoundingClientRect().top) : 0;
        if (clearance) tour.card.style.bottom = `${Math.ceil(clearance + 12)}px`;
    }
    return dialog;
}

function selectDialogSection(step, scope) {
    const tab = scope.querySelector(step.tab);
    const select = tour.dialogConfig?.sectionSelect ? findShown(scope, tour.dialogConfig.sectionSelect) : null;
    const value = tab?.dataset.editorTab;
    if (!select || !value || tab.hidden || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function clearTarget() {
    tour.target?.classList.remove('neconyan-tool-tour-target');
    tour.target = null;
}

function followMewmoryTab(event) {
    if (tour.key !== 'mewmory' || !event.isTrusted) return;
    const tab = event.target.closest('.mewmory-tabs button');
    const step = { 'mewmory-tab-now': 'pane', 'mewmory-tab-pawspective': 'pawspective',
        'mewmory-tab-archive': 'archive', 'mewmory-tab-recall': 'recall', 'mewmory-tab-settings': 'settings' }[tab?.id];
    if (step) void show(step);
}

function refreshTourTarget() {
    if (!tour.card || !tour.root) return;
    const step = currentSteps().find(item => item.id === tour.stepId);
    const target = step?.targets.map(selector => findShown(tour.root, selector)).find(Boolean);
    if (!target || target === tour.target) return;
    clearTarget();
    tour.target = target;
    target.classList.add('neconyan-tool-tour-target');
}

function openStep(step) {
    const scope = stepScope(step);
    if (!scope) return;
    const tab = step.tab ? findShown(scope, step.tab) : null;
    if (tab?.getAttribute('aria-selected') === 'false') tab.click();
    else if (!tab && step.tab && step.dialog) selectDialogSection(step, scope);
    if (!step.open) return;
    for (const selector of [].concat(step.open)) {
        const header = findShown(scope, selector);
        const details = header?.closest('details');
        if (details && !details.open) details.open = true;
        else if (header?.getAttribute('aria-expanded') === 'false' || header?.getAttribute('aria-pressed') === 'false') header.click();
    }
}

function renderCopy(host, text) {
    host.replaceChildren(...parseToolTourCopy(text).map(runs => {
        const paragraph = element('p');
        for (const run of runs) paragraph.append(run.bold ? element('strong', '', run.text) : document.createTextNode(run.text));
        return paragraph;
    }));
}

async function show(stepId) {
    if (!tour.card) return;
    const token = ++tour.token;
    let steps = currentSteps();
    const step = steps.find(item => item.id === stepId) || steps[0];
    if (!step) return;
    clearTarget();
    tour.stepId = step.id;
    if (step.dialog) {
        const dialog = await openTourDialog(step, token);
        if (token !== tour.token) return;
        if (!dialog) {
            const after = steps.slice(steps.indexOf(step)).find(item => !item.dialog);
            if (after) void show(after.id);
            return;
        }
        steps = currentSteps();
        if (!steps.some(item => item.id === step.id)) {
            const all = getToolPage(tour.key).steps;
            const nextId = all.slice(all.findIndex(item => item.id === step.id) + 1)
                .find(item => steps.some(entry => entry.id === item.id))?.id;
            if (nextId) void show(nextId);
            return;
        }
    } else {
        closeTourDialog();
    }
    openStep(step);
    const index = Math.max(0, steps.findIndex(item => item.id === step.id));
    const card = tour.card;
    card.dataset.step = step.id;
    card.querySelector('.neconyan-tool-tour-count').textContent = t`Step ${index + 1} of ${steps.length}`;
    card.querySelector('.neconyan-tool-tour-title').textContent = t([step.title]);
    renderCopy(card.querySelector('.neconyan-tool-tour-body'), translateCopy(step.body));
    card.querySelector('.neconyan-tool-tour-hint').textContent = t([step.hint]);
    card.querySelector('[data-tool-tour-back]').disabled = index === 0;
    card.querySelector('[data-tool-tour-next]').textContent = index === steps.length - 1 ? t`Done` : t`Next`;
    if (tour.spacer) {
        tour.root.append(tour.spacer);
        tour.spacer.style.height = `${Math.ceil(card.getBoundingClientRect().height) + 24}px`;
    }
    await wait(60);
    if (token !== tour.token) return;
    const scope = stepScope(step);
    const target = scope ? step.targets.map(selector => findShown(scope, selector)).find(Boolean) : null;
    if (!target) return;
    tour.target = target;
    target.classList.add('neconyan-tool-tour-target');
    const reduced = prefersReducedMotion();
    target.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    await wait(reduced ? 50 : 500);
    if (token === tour.token && coveredByCard(target)) target.scrollIntoView({ block: 'start' });
}

async function move(delta) {
    const steps = currentSteps();
    const index = steps.findIndex(step => step.id === tour.stepId);
    const nextIndex = index + delta;
    if (nextIndex >= steps.length) {
        endToolTour();
        return;
    }
    await show(steps[Math.max(0, nextIndex)].id);
}

function rememberInvite(key) {
    dismissTourInvitation(`${TOOL_TOUR_INVITE_PREFIX}${key}`);
    document.querySelectorAll(`.neconyan-tool-tour-invite[data-tool-page="${key}"]`).forEach(invite => { invite.hidden = true; });
}

function onKeydown(event) {
    if (event.key === 'Escape' && tour.card) {
        event.stopPropagation();
        event.preventDefault();
        endToolTour();
    }
}

function buildCard(page) {
    const card = element('aside', 'neconyan-tool-tour');
    card.id = 'neconyan-tool-tour';
    card.dataset.toolPage = page.key;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', 'neconyan-tool-tour-title');
    card.setAttribute('aria-describedby', 'neconyan-tool-tour-body');
    card.tabIndex = -1;

    const head = element('div', 'neconyan-tool-tour-head');
    const heading = element('div', 'neconyan-tool-tour-heading');
    const count = element('span', 'neconyan-tool-tour-count');
    count.setAttribute('aria-live', 'polite');
    const title = element('strong', 'neconyan-tool-tour-title');
    title.id = 'neconyan-tool-tour-title';
    const speaker = t([`${ASSISTANT_NAMES[page.assistant]}'s ${page.name} tour`]);
    heading.append(element('span', 'neconyan-tool-tour-speaker', speaker), title, count);
    const close = element('button', 'menu_button menu_button_icon neconyan-tool-tour-close');
    close.type = 'button';
    close.setAttribute('aria-label', t`End the tour`);
    close.title = t`End tour`;
    const closeIcon = element('i', 'fa-solid fa-xmark');
    closeIcon.setAttribute('aria-hidden', 'true');
    close.append(closeIcon);
    close.addEventListener('click', () => endToolTour());
    head.append(portrait(page.assistant), heading, close);

    const body = element('div', 'neconyan-tool-tour-body');
    body.id = 'neconyan-tool-tour-body';
    body.setAttribute('aria-live', 'polite');
    const hint = element('p', 'neconyan-tool-tour-hint');

    const actions = element('div', 'neconyan-tool-tour-actions');
    const back = element('button', 'menu_button', t`Back`);
    back.type = 'button';
    back.dataset.toolTourBack = '';
    back.addEventListener('click', () => void move(-1));
    const next = element('button', 'menu_button menu_button_primary neconyan-tool-tour-next', t`Next`);
    next.type = 'button';
    next.dataset.toolTourNext = '';
    next.addEventListener('click', () => void move(1));
    actions.append(back, next);

    card.append(head, body, hint, actions);
    return card;
}

/**
 * Opens the assistant's step-by-step tour for a full-page tool.
 * @param {string} id Tool id or page key
 * @param {HTMLElement} root The page that holds the tool's controls
 * @param {HTMLElement|null} [heading] Optional introduction outside the scrolling page
 */
export function startToolTour(id, root, heading = null) {
    const page = getToolPage(id);
    if (!page || !(root instanceof HTMLElement)) return;
    endToolTour({ restoreFocus: false });
    rememberInvite(page.key);
    tour.key = page.key;
    tour.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tour.root = root;
    tour.heading = heading;
    if (page.key === 'mewmory') {
        root.addEventListener('click', followMewmoryTab);
        // Switching tabs or roles rebuilds Mewmory's controls, including the highlighted node.
        tour.observer = new MutationObserver(refreshTourTarget);
        tour.observer.observe(root, { childList: true, subtree: true });
    }
    tour.card = buildCard(page);
    document.body.append(tour.card);
    document.addEventListener('keydown', onKeydown, true);
    document.body.classList.add('neconyan-tool-tour-active');
    tour.spacer = element('div', 'neconyan-tool-tour-spacer');
    tour.spacer.setAttribute('aria-hidden', 'true');
    tour.watch = setInterval(() => {
        if (!isShown(tour.root) || (tour.heading && tour.heading.dataset.toolPage !== tour.key)) endToolTour({ restoreFocus: false });
    }, 1000);
    void show(page.steps[0].id).then(() => tour.card?.focus({ preventScroll: true }));
}

/**
 * Closes the tool tour and removes its highlight.
 * @param {{ restoreFocus?: boolean }} [options] Whether focus returns to the control that opened it
 */
export function endToolTour({ restoreFocus = true } = {}) {
    tour.token++;
    clearInterval(tour.watch);
    clearTarget();
    closeTourDialog();
    tour.observer?.disconnect();
    tour.observer = null;
    tour.root?.removeEventListener('click', followMewmoryTab);
    tour.spacer?.remove();
    tour.spacer = null;
    clearTarget();
    tour.card?.remove();
    tour.card = null;
    tour.stepId = '';
    tour.key = '';
    tour.root = null;
    tour.heading = null;
    document.removeEventListener('keydown', onKeydown, true);
    document.body.classList.remove('neconyan-tool-tour-active');
    if (restoreFocus && isShown(tour.opener)) tour.opener.focus({ preventScroll: true });
    tour.opener = null;
}

function buildInvite(page, root, heading) {
    const invite = element('div', 'neconyan-tool-tour-invite');
    invite.dataset.toolPage = page.key;
    invite.setAttribute('role', 'note');
    const copy = element('p');
    copy.append(element('strong', '', t([`New to ${page.name}?`])), document.createTextNode(` ${t([page.invite])}`));
    const actions = element('div', 'neconyan-tool-tour-invite-actions');
    const start = element('button', 'menu_button menu_button_primary neconyan-tool-tour-next', t`Show me around`);
    start.type = 'button';
    start.addEventListener('click', () => startToolTour(page.key, root, heading));
    const later = element('button', 'menu_button', t`Not now`);
    later.type = 'button';
    later.addEventListener('click', () => rememberInvite(page.key));
    actions.append(start, later);
    invite.append(portrait(page.assistant), copy, actions);
    addTourInvitationDismiss(invite, `${TOOL_TOUR_INVITE_PREFIX}${page.key}`, heading ?? root);
    return invite;
}

/**
 * Builds the page introduction, Tour button and first-visit invitation for a full-page tool.
 * @param {string} id Tool id or page key
 * @param {HTMLElement} heading Where the introduction goes
 * @param {HTMLElement} root The page that holds the tool's controls
 * @param {HTMLElement|null} [headerHeading] Optional introduction beneath the shell title
 * @returns {boolean} Whether the tool has a full page
 */
export function mountToolPage(id, heading, root, headerHeading = null) {
    const page = getToolPage(id);
    heading?.querySelector('.neconyan-tool-page-intro')?.remove();
    heading?.querySelector('.neconyan-tool-tour-invite')?.remove();
    headerHeading?.replaceChildren();
    if (!page || !(heading instanceof HTMLElement)) return false;
    const launch = element('button', 'menu_button menu_button_icon neconyan-tool-tour-button');
    launch.type = 'button';
    launch.setAttribute('aria-label', t([`Start ${ASSISTANT_NAMES[page.assistant]}'s ${page.name} tour`]));
    launch.title = t([`A guided walk through ${page.name}`]);
    const icon = element('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    launch.append(icon, element('span', '', t`Tour`));
    launch.addEventListener('click', () => startToolTour(page.key, root, headerHeading));
    const intro = createPageIntro(page.key, t([page.kicker]), t([page.description]), launch, { header: Boolean(headerHeading) });
    (headerHeading ?? heading).append(intro);
    if (headerHeading) headerHeading.dataset.toolPage = page.key;
    heading.append(buildInvite(page, root, headerHeading));
    return true;
}
