const creator = 'public/scripts/creator/';

export default [
    {
        id: 'catelier.start', title: 'Creating a character in Catelier', keys: ['Catelier', 'character studio', 'private character draft', 'Review & save', 'Save to library'],
        sources: [creator + 'index.js'], anchors: ['Create a character', 'Review & save', 'Save to library', 'Save as a new copy'],
        content: 'Open Characters → Catelier and choose Create a character, or reopen a saved draft. Start with a name and an idea in Dossier, then fill in Identity and Greetings & examples. You can write by hand or ask the model for a proposal. Drafts are private work in progress; editing one does not change the published card. Review & save shows what will change, then Save to library publishes it. Save as a new copy keeps the existing card. Discarding a draft leaves published library items alone. Generated writing uses your model connection and can cost money; writing by hand does not.',
    },
    {
        id: 'catelier.writing', title: 'Directing and reviewing Catelier writing', keys: ['Catelier writing', 'Ask questions first', 'Catelier greeting count', 'Number of greetings', 'Catelier proposal', 'Catelier fallbacks'],
        sources: [creator + 'index.js', creator + 'questions.js', creator + 'format-picker.js', creator + 'connection.js'], anchors: ['Ask questions first', 'Number of greetings', 'Accept this field', 'Reject proposal'],
        content: 'In Catelier, choose the writing connection and any fallback profiles in Writing instructions. Length, tense and style sets rough length targets, point of view and the number of greetings; that count includes the first greeting and its alternatives. Ask questions first pauses dossier and writing proposals for missing details: answer what you want, then choose Generate. Review the result before keeping it. Accept this field keeps one proposed field; Regenerate this field asks for another version; Accept all fields or Reject proposal handles the whole proposal. Accepted text stays in the draft until Review & save. Custom User Instructions guide Catelier and are not exported as the character prompt.',
    },
    {
        id: 'catelier.server', title: 'Returning to Catelier writing after closing the page', keys: ['Catelier close the page', 'Catelier background writing', 'Catelier server writing', 'Catelier Server requests'],
        sources: [creator + 'server-generation.js', 'public/scripts/browser-reply-routing.js'], anchors: ['prefersServerReplies', 'Server requests', 'Review the proposal before accepting it.'],
        content: 'Catelier follows Where replies are written. With On the server selected, submitted writing can continue after you close the page. Return to the draft or Server requests to collect the result, then review the proposal before accepting it. Closing the page is different from Cancel, which stops the request. If the draft changed while the model was writing, Catelier keeps the result available for review instead of silently overwriting your edits. This does not make browser-written requests survive a closed page, and a stopped server cannot keep working.',
    },
    {
        id: 'characters.purrks', title: 'Switchable character traits with Purrks', keys: ['Purrks', 'Character Purrks', 'switchable traits', 'Orb fragments', 'Create switchable Purrks on import'],
        sources: ['public/scripts/purrks/index.js', 'public/index.html', 'public/scripts/neconyan-tabs.js'], anchors: ['Enable Purrks for this character', 'Extract from card', 'Character Purrks', 'Create switchable Purrks on import'],
        content: 'Purrks are switchable character instructions: traits, moods, keyword triggers or Scene AI directions. Use Character Purrks in the chat tools menu, or Purrks in Catelier\'s Prompts section. Enable Purrks for this character, then choose Always active, Manual switch, Keyword trigger or Scene AI director for each item. Extract from card finds existing traits and Orb fragments without a model request and adds them switched off. Generate Purrks uses a model. Create switchable Purrks on import also starts extracted traits off; existing Orb fragments are converted even when that import switch is off. System prompt and After chat history placements follow the Prefer character prompt settings. Review active Purrks when a character starts behaving differently.',
    },
    {
        id: 'mewmory.jev', title: 'Choosing a Jev memory recall model', keys: ['Mewmory Jev', 'Recall decision model', 'Selector endpoint', 'Memory focus and window', 'custom Jev model'],
        sources: ['public/scripts/mewmory/ui.js', 'public/scripts/mewmory/jev-presets.js'], anchors: ['Memory focus and window', 'Recall decision model', 'Manual endpoint & API key'],
        content: 'Open Mewmory → Now → Memory focus and window. Recall decision model offers Jev presets and a custom model. Choose a saved connection profile, or Manual endpoint & API key for a separate endpoint, model and key. A saved profile can have a model override. Enter keys in these settings, never in chat. Jev scores which memories belong in the next reply; it does not write the reply or replace the extraction model. The memory window controls how much recent chat stays visible. All model settings opens the detailed controls, including the decision protocol and score threshold. Start with the preset\'s values rather than changing several settings at once.',
    },
    {
        id: 'pathfinder.jev', title: 'Choosing a Jev lore retrieval model', keys: ['Pawthfinder Jev', 'Jev lore', 'lore decision model', 'Pawthfinder decision protocol'],
        sources: ['public/scripts/extensions/in-chat-agents/pathfinder-settings.html'], anchors: ['Jev / decision model preset', 'Summary writing still uses your chat model.'],
        content: 'In Pawthfinder settings, choose a Jev / decision model preset, then connect its endpoint or select a saved connection profile. Jev scores which lore to retrieve; Summary writing still uses your chat model. Decision protocol chooses automatic detection, the Jev decision API or chat completions. Keep the preset\'s score threshold to begin with. This is separate from Disable World Info keyword activation, which controls whether ordinary keyword matching also adds lore. Choosing a preset does not supply API access or credits.',
    },
    {
        id: 'start.iphone-app', title: 'Installing the standalone iPhone app', keys: ['standalone iPhone app', 'iPhone IPA', 'iPhone install', 'install this on my iPhone', 'iloader', 'iOS app', 'iPhone without a computer server'],
        sources: ['README.md', 'ios/README.md'], anchors: ['iOS 17', 'iloader'],
        content: 'The standalone iPhone app runs Neconyan on the phone and needs iOS 17 or newer. Download the unsigned IPA from the latest GitHub release and sign and install it with a tool such as iloader. You still need your own model connection. A free Apple account normally needs re-signing every seven days and permits three sideloaded apps. Back up before replacing or removing the app: deleting it deletes its local data. iOS can suspend background work, so keep the app open for long tasks. This is separate from using Safari to connect to a computer running Neconyan; that option needs the computer to stay on.',
    },
];
