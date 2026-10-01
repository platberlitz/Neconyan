import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';

export const TOOL_TOUR_INVITE_PREFIX = 'neconyanToolTourInvite.';

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
                emptyBody: 'Open a saved Roleplay chat first. Until then, Mewmory has nothing to remember, so most of this page is empty.',
                hint: 'No chat, no memories. Even I need material.',
            },
            {
                id: 'tabs',
                targets: ['.mewmory-tabs'],
                optional: true,
                title: 'The five tabs',
                body: '**Now** shows what Mewmory is tracking at this point in the story. **Pawspective** follows how each character sees things, linked to the messages behind it. **Archive** keeps older memories. **Recall** shows what was added to the last prompt. **Settings** sets the models it uses.',
                hint: 'Check Recall when a character forgets something. It tells you exactly why.',
            },
            {
                id: 'pane',
                targets: ['.mewmory-page'],
                optional: true,
                title: 'Reading and fixing memories',
                body: 'Each memory can be edited or deleted. If Mewmory wrote something wrong, fix it here and the correction is used from the next reply on.',
                hint: 'Wrong notes are worse than no notes. Correct them.',
            },
            {
                id: 'done',
                targets: ['.neconyan-tool-tour-button'],
                title: 'That is the whole page',
                body: 'Press **Tour** at any time to see this again. In **Settings**, choose how often Mewmory updates with **Messages per update**.',
                hint: 'Now, I remember there was a cigarette somewhere.',
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
    card: null,
    stepId: '',
    target: null,
    watch: 0,
    token: 0,
    opener: null,
    spacer: null,
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
        return [...root.querySelectorAll(selector)].find(isShown) || null;
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

function currentSteps() {
    const root = tour.root;
    const emptyWhen = TOOL_PAGES[tour.key]?.emptyWhen;
    const empty = Boolean(emptyWhen && root?.querySelector(emptyWhen));
    return getToolTourSteps(tour.key, {
        empty,
        isShown: step => Boolean(root && (step.targets.some(selector => findShown(root, selector))
            || (step.tab && findShown(root, step.tab) && step.targets.some(selector => root.querySelector(selector))))),
    });
}

function clearTarget() {
    tour.target?.classList.remove('neconyan-tool-tour-target');
    tour.target = null;
}

function openStep(step) {
    if (!tour.root) return;
    const tab = step.tab ? findShown(tour.root, step.tab) : null;
    if (tab?.getAttribute('aria-selected') === 'false') tab.click();
    if (!step.open) return;
    for (const selector of [].concat(step.open)) {
        const header = findShown(tour.root, selector);
        const details = header?.closest('details');
        if (details && !details.open) details.open = true;
        else if (header?.getAttribute('aria-expanded') === 'false') header.click();
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
    const steps = currentSteps();
    const step = steps.find(item => item.id === stepId) || steps[0];
    if (!step) return;
    clearTarget();
    tour.stepId = step.id;
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
    const target = step.targets.map(selector => findShown(tour.root, selector)).find(Boolean);
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
    accountStorage.setItem(`${TOOL_TOUR_INVITE_PREFIX}${key}`, 'seen');
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
 */
export function startToolTour(id, root) {
    const page = getToolPage(id);
    if (!page || !(root instanceof HTMLElement)) return;
    endToolTour({ restoreFocus: false });
    rememberInvite(page.key);
    tour.key = page.key;
    tour.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tour.root = root;
    tour.card = buildCard(page);
    document.body.append(tour.card);
    document.addEventListener('keydown', onKeydown, true);
    document.body.classList.add('neconyan-tool-tour-active');
    tour.spacer = element('div', 'neconyan-tool-tour-spacer');
    tour.spacer.setAttribute('aria-hidden', 'true');
    tour.watch = setInterval(() => {
        if (!isShown(tour.root)) endToolTour({ restoreFocus: false });
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
    tour.spacer?.remove();
    tour.spacer = null;
    clearTarget();
    tour.card?.remove();
    tour.card = null;
    tour.stepId = '';
    tour.key = '';
    tour.root = null;
    document.removeEventListener('keydown', onKeydown, true);
    document.body.classList.remove('neconyan-tool-tour-active');
    if (restoreFocus && isShown(tour.opener)) tour.opener.focus({ preventScroll: true });
    tour.opener = null;
}

function buildInvite(page, root) {
    const invite = element('div', 'neconyan-tool-tour-invite');
    invite.dataset.toolPage = page.key;
    invite.setAttribute('role', 'note');
    const copy = element('p');
    copy.append(element('strong', '', t([`New to ${page.name}?`])), document.createTextNode(` ${t([page.invite])}`));
    const actions = element('div', 'neconyan-tool-tour-invite-actions');
    const start = element('button', 'menu_button menu_button_primary neconyan-tool-tour-next', t`Show me around`);
    start.type = 'button';
    start.addEventListener('click', () => startToolTour(page.key, root));
    const later = element('button', 'menu_button', t`Not now`);
    later.type = 'button';
    later.addEventListener('click', () => rememberInvite(page.key));
    actions.append(start, later);
    invite.append(portrait(page.assistant), copy, actions);
    invite.hidden = accountStorage.getItem(`${TOOL_TOUR_INVITE_PREFIX}${page.key}`) === 'seen';
    return invite;
}

/**
 * Builds the page introduction, Tour button and first-visit invitation for a full-page tool.
 * @param {string} id Tool id or page key
 * @param {HTMLElement} heading Where the introduction goes
 * @param {HTMLElement} root The page that holds the tool's controls
 * @returns {boolean} Whether the tool has a full page
 */
export function mountToolPage(id, heading, root) {
    const page = getToolPage(id);
    heading?.querySelector('.neconyan-tool-page-intro')?.remove();
    heading?.querySelector('.neconyan-tool-tour-invite')?.remove();
    if (!page || !(heading instanceof HTMLElement)) return false;
    const intro = element('div', 'neconyan-tool-page-intro neconyan-cat-panel');
    const copy = element('div', 'neconyan-tool-page-copy');
    copy.append(element('span', 'neconyan-native-kicker', t([page.kicker])), element('p', 'neconyan-tool-page-description', t([page.description])));
    const launch = element('button', 'menu_button menu_button_icon neconyan-tool-tour-button');
    launch.type = 'button';
    launch.setAttribute('aria-label', t([`Start ${ASSISTANT_NAMES[page.assistant]}'s ${page.name} tour`]));
    launch.title = t([`A guided walk through ${page.name}`]);
    const icon = element('i', 'fa-solid fa-paw');
    icon.setAttribute('aria-hidden', 'true');
    launch.append(icon, element('span', '', t`Tour`));
    launch.addEventListener('click', () => startToolTour(page.key, root));
    intro.append(copy, launch);
    heading.append(intro, buildInvite(page, root));
    return true;
}
