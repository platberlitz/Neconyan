const conversation = 'public/scripts/neconyan-conversation/';
const story = 'public/scripts/extensions/third-party/Neconyan-Story-Mode/src/';
const meower = 'public/scripts/extensions/third-party/Neconyan-Hopper/src/';

export default [
    {
        id: 'conversation.start', title: 'Conversation DMs and Pals', keys: ['Conversation', 'DM', 'direct message', 'Pals'],
        covers: ['mode:conversation'], sources: [conversation + 'chrome.js', 'docs/conversation-mode-glossary.md'], anchors: ['Conversation'],
        content: 'Choose Conversation from the workspace modes and open a character\'s DM through Pals. Conversation uses its own message timeline, settings and branches. The active persona separates your DM histories, so check it when a thread appears empty. The character answering in a DM can differ from the character selected in Roleplay. Card personality still contributes to replies, but Conversation uses its own compact prompt and normally requests short, natural messages.',
    },
    {
        id: 'conversation.settings', title: 'Conversation settings and scope', keys: ['DM settings', 'Conversation settings', 'chatroom prompt', 'custom instructions', 'grounded dialogue'],
        sources: [conversation + 'settings-panel.js', conversation + 'constants.js', conversation + 'timeline-render.js'], anchors: ['custom_instructions', 'grounded_dialogue_rules_enabled'],
        content: 'Open the Conversation thread\'s settings panel. Its sections group behaviour, timing, prompts and other DM options. Settings are not all global: some belong to the current character/thread, some to a group and some to the Conversation workspace. Save/close applies edits to the captured thread/persona. Custom instructions and grounded-dialogue rules influence replies; an Author\'s Note adds further guidance. A lorebook override names a book in the DM prompt; it does not run the full Roleplay lorebook scanner.',
    },
    {
        id: 'conversation.presence', title: 'Online, idle, DND and offline behaviour', keys: ['presence', 'idle', 'do not disturb', 'DND', 'offline message', 'availability'],
        sources: [conversation + 'constants.js', 'docs/conversation-mode-glossary.md'], anchors: ['availability', 'offline_message'],
        content: 'Conversation presence can be online, idle, do-not-disturb or offline. Idle behaviour can allow a follow-up or spontaneous message when configured. Offline/DND behaviour and the offline responder are distinct from a failed model connection. Availability and schedules influence when automatic replies occur; they do not prove a real person is online. Check quiet hours and notification settings separately when messages arrive without alerts.',
    },
    {
        id: 'conversation.automation', title: 'Proactive messages and automatic Conversation replies', keys: ['proactive messaging', 'automatic messages', 'followups', 'inactivity threshold', 'talkativeness', 'auto message'],
        sources: [conversation + 'constants.js', conversation + 'timers.js', 'docs/conversation-mode-rest-api.md'], anchors: ['proactive_messaging', 'max_followups'],
        content: 'Conversation settings control automatic messages, cooldowns, inactivity thresholds, talkativeness and maximum follow-ups. These features can make additional model requests. Automatic/proactive messaging starts disabled. Browser timers perform this work, so do not promise that closing the app leaves all automation running on the server. The separate Conversation HTTP API does not automatically run reminders, schedules, autonomous group chats, images or speech.',
    },
    {
        id: 'conversation.schedule', title: 'Schedules, reminders and quiet hours', keys: ['schedule', 'reminder', 'weekly schedule', 'quiet hours', 'notifications'],
        sources: [conversation + 'constants.js', conversation + 'timeline-render.js', 'docs/conversation-mode-glossary.md'], anchors: ['quiet_hours_start', 'schedule_command_enabled'],
        content: 'Conversation has availability schedules, optional schedule commands, reminders and notification controls. Quiet hours restrict alerts; muting and notification priority are separate. Browser/OS permission is also needed for supported system notifications. A model mentioning a reminder is not proof it was scheduled: look for the app\'s recognised command/result. Automatic timing relies on the running browser and is not a guaranteed delivery service while the app is closed.',
    },
    {
        id: 'conversation.groups', title: 'Conversation group DMs', keys: ['group DM', 'Conversation group', 'automatic character chat', 'multi character DM'],
        sources: [conversation + 'attachments.js', conversation + 'constants.js', 'docs/conversation-mode-glossary.md'], anchors: ['auto_character_chat', 'multi_char'],
        content: 'Create/manage a group in Conversation and choose its participants. Multi-character and automatic-character-chat options determine who can reply and whether characters talk without a new user message. Group reply delays, follow-up limits and token limits have group scope. Replies may be prepared concurrently, each for its actual speaker. This is separate from a Roleplay group and its joined-card prompt settings. Additional speakers and automatic turns can increase provider usage.',
    },
    {
        id: 'conversation.messages', title: 'Conversation message actions and branches', keys: ['DM reactions', 'pin DM', 'edit DM', 'rewrite reply with AI', 'Conversation branch', 'DM search'],
        sources: [conversation + 'timeline-render.js', conversation + 'interface.js', 'docs/conversation-mode-glossary.md'], anchors: ['Rewrite reply with AI'],
        content: 'Conversation message actions include reactions, pins, editing where enabled, regeneration and branch-related actions. Search finds messages within the relevant Conversation scope. Rewrite reply with AI makes a model request to revise a reply; a manual text edit is different. Regeneration uses the history preceding that reply. Branches preserve alternate timelines; copying summary memory to a new branch is a separate setting. Pins are not a substitute for the summary-memory controls.',
    },
    {
        id: 'conversation.images', title: 'Conversation selfies and image generation', keys: ['selfie', 'DM images', 'Conversation image generation', 'spontaneous selfies'],
        sources: [conversation + 'constants.js', conversation + 'media.js', 'docs/conversation-mode-glossary.md'], anchors: ['image_gen_enabled', 'selfie_command_enabled'],
        content: 'Conversation supports image-generation settings, prompt templates, negative prompts, cooldowns and optional spontaneous selfies. The recognised selfie command and permission to generate images are separate controls. Configure the image provider first; enabling a DM option does not supply image credits or a model. Image prompting/generation can incur additional requests. An ordinary text promise of a selfie is not evidence that an image was generated.',
    },
    {
        id: 'conversation.connection', title: 'A separate model connection for Conversation', keys: ['DM model', 'Conversation connection', 'Conversation profile', 'reply delay', 'DM reply length'],
        sources: [conversation + 'generation.js', conversation + 'constants.js'], anchors: ['connection_profile', 'reply_max_tokens'],
        content: 'Conversation\'s Connection profile selects a saved connection by name. With a valid selected profile, DM requests use its provider/model and preset; otherwise the normal generation route is used. Reply token limits and delay multipliers are separate from model selection. A connection error can trigger the existing fallback route, so check the actual connection before assuming which model answered. Conversation does not supply the normal Roleplay assistant editing tools.',
    },
    {
        id: 'story.writing', title: 'Writing in Story Mode', keys: ['Story Mode', 'manuscript', 'Continue story', 'Direction'],
        covers: ['mode:story', 'extension:third-party/Neconyan-Story-Mode'], sources: [story + 'ui.js', story + 'core.js', story + 'api.js'], anchors: ['Direction'],
        content: 'Choose Story Mode to work with a continuous manuscript based on the chat. Continue generates the next passage. Direction supplies a one-use instruction for the next continuation. Retry requests another continuation; Undo and Redo navigate supported edits. The mode provides a word count and plain-text export. It still needs a configured text-model connection and uses the character/chat context. Export before destructive edits if you need an independent copy.',
    },
    {
        id: 'story.editing', title: 'Story Mode editing, rewrites and settings', keys: ['rewrite story', 'edit manuscript', 'story undo', 'story defaults', 'story token cap'],
        sources: [story + 'ui.js', story + 'core.js', story + 'api.js'], anchors: ['Undo', 'Redo'],
        content: 'Tap/edit manuscript text directly or use selection rewrites for an AI-assisted revision. Rewrites make model requests; manual edits do not themselves require a completion. Story settings distinguish card, chat and global defaults, plus appearance and continuation limits. The continuation token cap limits requested output rather than guaranteeing a word count. Agent participation is restricted by Story settings and generation type, so do not assume every Roleplay automation runs on every rewrite.',
    },
    {
        id: 'meower.timeline', title: 'Meower private timelines', keys: ['Meower', 'Hopper', 'social timeline', 'feed', 'posts'],
        covers: ['mode:meower', 'extension:third-party/Neconyan-Hopper'], sources: [meower + 'ui.js', meower + 'core.js'], anchors: ['Meower'],
        content: 'Meower creates a private AI-generated social timeline inside Neconyan. It is not connected to a public social network. The selected persona and timeline identity determine your profile and feed. Configure its connection and cast, then generate/refresh posts. Posts, replies, likes, reposts and polls are simulated content stored by the app. Refreshing or asking characters to respond can make model requests; viewing already saved posts does not require generating them again.',
    },
    {
        id: 'meower.cast', title: 'Meower cast, profiles and generation settings', keys: ['Meower cast', 'timeline cast', 'strangers', 'Meower profile', 'Meower pictures', 'feed recovery'],
        sources: [meower + 'ui.js', meower + 'core.js', meower + 'api.js'], anchors: ['persona'],
        content: 'Use Meower\'s settings to choose invited characters, optional strangers, profiles and generation behaviour. A Meower cast is separate from Roleplay and Conversation groups. Optional Roleplay context can inform the feed; it does not merge the two histories. Pictures need image-generation configuration. Meower saves timeline state and handles conflicting saves; inspect a failed-save or recovery notice rather than refreshing repeatedly and assuming all generated posts were retained.',
    },
];
