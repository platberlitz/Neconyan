/**
 * One spec per bundled regex script: which archetype renders it, and how its capture
 * groups map onto that archetype's slots.
 *
 * `findRegex` is never touched by a theme, so `groups` here must match the real capture
 * count of the shipped pattern. tests/regex-agent-themes.test.js checks the bundled templates.
 *
 * Slot shapes:
 *   head[]      {g}|{text}   plus optional icon, label, glue, arrow
 *   rows[]      {g, label?, pre?, tint?}
 *   sections[]  {g, label, accent}
 *   slots[]     {g}  or  {k, v}  when kv is true
 *   stats[]     {g, label, glyph, accent, meter?}
 *   fields[]    {g, tone, suffix?}
 */

export const ARCHETYPES = Object.freeze({
    PANEL: 'panel',
    PROFILE: 'profile',
    SLOTS: 'slots',
    STATCARD: 'statcard',
    CHIP: 'chip',
    TERMINAL: 'terminal',
    STREAM: 'stream',
    TRANSCRIPT: 'transcript',
    BOLD: 'bold',
    CLEANUP: 'cleanup',
    PASSTHROUGH: 'passthrough',
});

/** Macros a generated string is allowed to contain. Anything else is a bug. */
export const ALLOWED_MACROS = Object.freeze(['{{user}}', '{{char}}']);

/**
 * Scripts whose `findRegex` faces model output. Group numbering is shared with the
 * prompt-side extract patterns, so it is frozen. Themes only touch `replaceString`.
 * The CLEANUP archetype is the sole exception: its pattern matches our own generated
 * markup and has no capture groups, so it must be regenerated alongside the renderer.
 */

const SPEC_LIST = [
    // ---------------------------------------------------------------- trackers: panel
    {
        templateId: 'tpl-scene-tracker',
        scriptId: 'ad25f07e-e86c-480e-9a8f-ffe90ce33e85',
        scriptName: 'Replace Scene Tracker',
        key: 'scene', archetype: ARCHETYPES.PANEL, groups: 4, accent: 4, open: true,
        icon: '📍',
        head: [{ g: 1 }, { g: 2, icon: '🕐' }, { g: 3 }],
        rows: [{ g: 4, pre: true }],
    },
    {
        templateId: 'tpl-time-tracker',
        scriptId: 'ad1d4f9f-8a1b-4f84-9ce2-b92dc9bbb345',
        scriptName: 'Replace Time Tracker',
        key: 'time', archetype: ARCHETYPES.PANEL, groups: 4, accent: 5,
        icon: '🕐',
        head: [{ g: 1 }, { g: 2 }, { g: 3 }],
        rows: [{ g: 4, label: 'Context', pre: true }],
    },
    {
        templateId: 'tpl-item-tracker',
        scriptId: '5c667ee9-0037-4eb5-a93d-a578c5b78048',
        scriptName: 'Replace Item Tracker',
        key: 'item', archetype: ARCHETYPES.PANEL, groups: 4, accent: 3,
        icon: null,
        head: [{ g: 1, glue: ' ' }, { g: 2 }, { g: 3 }],
        rows: [{ g: 4, pre: true }],
    },
    {
        templateId: 'tpl-event-tracker',
        scriptId: '6675f320-6ffe-44fc-a73a-735b17d235c2',
        scriptName: 'Replace Pending Events Tracker',
        key: 'event', archetype: ARCHETYPES.PANEL, groups: 4, accent: 2,
        icon: null,
        head: [{ g: 1, glue: ' ' }, { g: 2 }, { g: 3, icon: '⏳' }],
        rows: [{ g: 4, pre: true }],
    },
    {
        templateId: 'tpl-world-detail',
        scriptId: 'a0c2d813-1d47-4250-bd53-cd8fac504259',
        scriptName: 'Replace World Detail',
        key: 'world', archetype: ARCHETYPES.PANEL, groups: 3, accent: 1,
        icon: '🌐',
        head: [{ text: 'World' }, { g: 1 }, { g: 2 }],
        rows: [{ g: 3 }],
    },
    {
        templateId: 'tpl-status-tracker',
        scriptId: 'a7f9df62-7674-4406-9eb0-86910c77eb3d',
        scriptName: 'Replace Status/Conditions Tracker',
        key: 'status', archetype: ARCHETYPES.PANEL, groups: 4, accent: 6,
        icon: '🩹',
        head: [{ g: 1 }, { g: 2 }],
        rows: [{ g: 3, label: 'Severity' }, { g: 4, label: 'Note', pre: true }],
    },
    {
        templateId: 'tpl-secrets-tracker',
        scriptId: 'f9c4458e-3072-405a-94b2-07662fed10dd',
        scriptName: 'Replace Secret Tracker',
        key: 'secret', archetype: ARCHETYPES.PANEL, groups: 4, accent: 2,
        icon: '🔒',
        head: [{ g: 1 }, { g: 2 }],
        rows: [{ g: 3, label: 'Also Know' }, { g: 4, label: 'Context', pre: true }],
    },
    {
        templateId: 'tpl-reputation-tracker',
        scriptId: '26f01a16-8260-4e89-849c-e00e44b71442',
        scriptName: 'Replace Reputation Tracker',
        key: 'reputation', archetype: ARCHETYPES.PANEL, groups: 4, accent: 0,
        icon: null,
        head: [{ g: 1, label: 'Source', icon: '👥' }, { g: 2, label: 'Perception', icon: '👁' }],
        rows: [{ g: 3, label: 'Direction' }, { g: 4, label: 'Cause', pre: true }],
    },
    {
        templateId: 'tpl-achievements-tracker',
        scriptId: '12fd0ac4-e9d1-4e4a-ac9a-24ed111d217a',
        scriptName: 'Replace Achievement Tracker',
        key: 'achievement', archetype: ARCHETYPES.PANEL, groups: 4, accent: 3, open: true,
        icon: '🏆',
        head: [{ g: 1 }, { g: 2 }],
        rows: [{ g: 3, label: 'Description', tint: true }, { g: 4, pre: true }],
    },

    // ------------------------------------------------------------- trackers: profile
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '4cdb1a49-f071-4768-911d-063a35b5bbc5',
        scriptName: 'Replace Major NPC',
        key: 'npc-major', archetype: ARCHETYPES.PROFILE, groups: 6, accent: 4,
        tier: 'major', icon: '🔍',
        head: [{ g: 1 }],
        sections: [
            { g: 2, label: 'BASICS', accent: 0 },
            { g: 3, label: 'APPEARANCE', accent: 3 },
            { g: 4, label: 'PERSONALITY', accent: 1 },
            { g: 5, label: 'BACKGROUND', accent: 2 },
            { g: 6, label: 'RELATIONSHIPS', accent: 6 },
        ],
    },
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '3e450d46-14f2-4318-8803-ca3a96d7cb28',
        scriptName: 'Replace Support NPC',
        key: 'npc-support', archetype: ARCHETYPES.PROFILE, groups: 6, accent: 5,
        tier: 'support', icon: '📋', optionalSections: [1, 2, 3, 4],
        head: [{ g: 1 }],
        sections: [
            { g: 2, label: 'Basics', accent: 0 },
            { g: 3, label: 'Appearance', accent: 3 },
            { g: 4, label: 'Personality', accent: 1 },
            { g: 5, label: 'History', accent: 2 },
            { g: 6, label: 'Ties', accent: 6 },
        ],
    },
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '4db3f379-1f43-4c1b-b93a-50f1a36ff17a',
        scriptName: 'Replace NPC Upgrade',
        key: 'npc-upgrade', archetype: ARCHETYPES.PROFILE, groups: 7, accent: 1,
        tier: 'upgrade', icon: '⬆️',
        head: [{ g: 1 }, { g: 2, arrow: true }],
        sections: [
            { g: 3, label: 'Basics', accent: 0 },
            { g: 4, label: 'Appearance', accent: 3 },
            { g: 5, label: 'Personality', accent: 1 },
            { g: 6, label: 'History', accent: 2 },
            { g: 7, label: 'Relationship', accent: 6 },
        ],
    },
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '5df8a270-4f37-4d92-8000-28a2a0f29dc4',
        scriptName: 'Replace Minor NPC',
        key: 'npc-minor', archetype: ARCHETYPES.PROFILE, groups: 4, accent: 5,
        tier: 'minor', icon: '👤',
        head: [{ g: 1 }],
        sections: [
            { g: 2, label: null, accent: 0 },
            { g: 3, label: null, accent: 3 },
            { g: 4, label: null, accent: 1 },
        ],
    },

    // --------------------------------------------------------------- trackers: chip
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '79104497-032b-4d27-9ab2-df2a8f5e5bfd',
        scriptName: 'Replace NPC Reference',
        key: 'npc-ref', archetype: ARCHETYPES.CHIP, groups: 3, accent: 5,
        fields: [{ g: 1, tone: 'strong' }, { g: 2, tone: 'warm' }, { g: 3, tone: 'cool' }],
    },
    {
        templateId: 'tpl-npc-profiles',
        scriptId: '0766e9f5-7d1c-4bb8-ab43-e047a3c82794',
        scriptName: 'Replace NPC Relationship',
        key: 'npc-rel', archetype: ARCHETYPES.CHIP, groups: 2, accent: 6,
        icon: '⚡',
        fields: [{ g: 1, tone: 'label', suffix: ':' }, { g: 2, tone: 'warm' }],
    },

    // -------------------------------------------------------------- trackers: slots
    {
        templateId: 'tpl-cyoa-choices',
        scriptId: '1a3158de-fb03-4471-9718-2022bd6b5f44',
        scriptName: 'Replace CYOA Choices',
        key: 'choices', archetype: ARCHETYPES.SLOTS, groups: 14, accent: 1, open: true,
        icon: '📌', rainbow: true,
        head: [{ text: 'Choose your next action' }],
        slots: Array.from({ length: 7 }, (_, i) => ({ number: i * 2 + 1, g: i * 2 + 2 })),
    },
    {
        templateId: 'tpl-direction-menu',
        scriptId: 'd6535a9b-df85-4b55-a0e2-3314afa0952f',
        scriptName: 'Replace Directions',
        key: 'directions', archetype: ARCHETYPES.SLOTS, groups: 4, accent: 4, open: true,
        icon: '🧭', rainbow: true,
        head: [{ text: 'Choose the next direction' }],
        slots: [{ g: 1 }, { g: 2 }, { g: 3 }, { g: 4 }],
    },
    {
        templateId: 'tpl-parallel-tracker',
        scriptId: 'e820b7d0-c517-49d9-abe6-fe8cd2e19d8a',
        scriptName: 'Replace Parallel Tracker',
        key: 'parallel', archetype: ARCHETYPES.SLOTS, groups: 8, accent: 5,
        icon: '🕸', kv: true,
        head: [{ text: 'Parallel' }, { g: 1 }, { g: 2 }],
        slots: [{ k: 3, v: 4 }, { k: 5, v: 6 }, { k: 7, v: 8 }],
    },

    // ----------------------------------------------------------- trackers: statcard
    {
        templateId: 'tpl-relationship-tracker',
        scriptId: 'c81e4b95-2d7a-4a60-8f3c-7b9e0d6a4c22',
        scriptName: 'Replace Relationship Bond',
        key: 'relationship-bond', archetype: ARCHETYPES.STATCARD, groups: 21, accent: 6,
        icon: '💞', portrait: { initial: 1, name: 2 },
        head: [{ g: 2 }, { g: 3 }, { g: 4 }, { g: 5 }],
        stats: [
            { g: 10, label: 'Heart', glyph: '❤', accent: 6, meter: true },
            { g: 11, label: 'Trust', glyph: '◆', accent: 5, meter: true },
            { g: 12, label: 'Wants', glyph: '✦', accent: 2, meter: true },
            { g: 13, label: 'Guard', glyph: '⛨', accent: 4, meter: true },
        ],
        rows: [
            { g: 6, label: 'Route' }, { g: 7, label: 'Previous step' },
            { g: 8, label: 'Current step' }, { g: 9, label: 'Next step' },
            { g: 14, label: 'Likes' }, { g: 15, label: 'Dislikes' },
            { g: 16, label: 'Tell' }, { g: 17, label: 'Unsaid', concealed: true },
            { g: 18, label: 'Keepsake memory' }, { g: 19, label: 'Would say yes to' },
            { g: 20, label: 'Turning point' }, { g: 21, label: 'Next threshold' },
        ],
    },
    {
        templateId: 'tpl-relationship-tracker',
        scriptId: '2ed3a072-ebe8-48aa-a36b-62b7c284ae8a',
        scriptName: 'Replace Relationship Tracker',
        key: 'relationship', archetype: ARCHETYPES.STATCARD, groups: 6, accent: 6,
        icon: '💞',
        head: [{ g: 1 }, { g: 4 }],
        stats: [
            { g: 2, label: 'Affection', glyph: '❤', accent: 6, meter: true },
            { g: 3, label: 'Trust', glyph: '◆', accent: 5, meter: true },
        ],
        pill: { g: 5, label: 'Condition' },
        rows: [{ g: 6, label: 'Change', pre: true }],
    },

    // ---------------------------------------------------------- companions: stream
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-shell-open',
        scriptName: 'Chatroom shell',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 1, accent: 5,
        family: 'companion', set: 'chatroom', role: 'open', depth: 2,
        title: 'Chatroom', badge: 'LIVE',
        meta: { g: 1, label: 'STYLE' },
    },
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-message-row-greentext',
        scriptName: 'Chatroom greentext row',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 4, accent: 1,
        family: 'companion', set: 'chatroom', role: 'row', variant: 'greentext',
        speaker: { g: 1 }, meta: { g: 2 }, hue: { g: 3 }, body: { g: 4 }, tone: 'green',
    },
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-greentext-continuation',
        scriptName: 'Chatroom greentext continuation',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 1, accent: 1,
        family: 'companion', set: 'chatroom', role: 'row', variant: 'greentext-cont',
        body: { g: 1 }, tone: 'green',
    },
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-message-row',
        scriptName: 'Chatroom message row',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 4, accent: 5,
        family: 'companion', set: 'chatroom', role: 'row', variant: 'hued',
        speaker: { g: 1 }, meta: { g: 2 }, hue: { g: 3 }, body: { g: 4 },
    },
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-message-row-legacy',
        scriptName: 'Chatroom legacy message row',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 3, accent: 5,
        family: 'companion', set: 'chatroom', role: 'row', variant: 'plain',
        speaker: { g: 1 }, meta: { g: 2 }, body: { g: 3 },
    },
    {
        templateId: 'tpl-chatroom-companion',
        scriptId: 'chatroom-shell-close',
        scriptName: 'Chatroom shell close',
        key: 'chatroom', archetype: ARCHETYPES.STREAM, groups: 0, accent: 5,
        family: 'companion', set: 'chatroom', role: 'close', depth: 2,
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-phone-shell-open',
        scriptName: 'Message Inbox phone shell',
        key: 'inbox-phone', archetype: ARCHETYPES.STREAM, groups: 2, accent: 5,
        family: 'companion', set: 'phone', role: 'open', depth: 3, chrome: 'notch',
        title: { g: 1 }, meta: { g: 2 },
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-phone-text-row',
        scriptName: 'Message Inbox phone text row',
        key: 'inbox-phone', archetype: ARCHETYPES.STREAM, groups: 3, accent: 5,
        family: 'companion', set: 'phone', role: 'row', variant: 'bubble',
        speaker: { g: 1 }, meta: { g: 2 }, body: { g: 3 },
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-phone-shell-close',
        scriptName: 'Message Inbox phone shell close',
        key: 'inbox-phone', archetype: ARCHETYPES.STREAM, groups: 0, accent: 5,
        family: 'companion', set: 'phone', role: 'close', depth: 3,
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-letter-shell-open',
        scriptName: 'Message Inbox parchment shell',
        key: 'inbox-letter', archetype: ARCHETYPES.STREAM, groups: 2, accent: 3,
        family: 'companion', set: 'letter', role: 'open', depth: 2, chrome: 'texture',
        title: { g: 1 }, meta: { g: 2 },
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-letter-text-row',
        scriptName: 'Message Inbox parchment text row',
        key: 'inbox-letter', archetype: ARCHETYPES.STREAM, groups: 3, accent: 3,
        family: 'companion', set: 'letter', role: 'row', variant: 'block',
        speaker: { g: 1 }, meta: { g: 2 }, body: { g: 3 },
    },
    {
        templateId: 'tpl-message-inbox-companion',
        scriptId: 'message-inbox-letter-shell-close',
        scriptName: 'Message Inbox parchment shell close',
        key: 'inbox-letter', archetype: ARCHETYPES.STREAM, groups: 0, accent: 3,
        family: 'companion', set: 'letter', role: 'close', depth: 2,
    },

    // ------------------------------------------------------ companions: transcript
    {
        templateId: 'tpl-chat-only-companion',
        scriptId: 'chat-only-transcript-row',
        scriptName: 'Chat Only transcript row',
        key: 'chat-only', archetype: ARCHETYPES.TRANSCRIPT, groups: 2, accent: 5,
        family: 'companion',
        speaker: { g: 1 }, body: { g: 2 },
    },

    // --------------------------------------------------------------- cleanup
    // Its findRegex matches our own generated empty-slot markup, not model output, so it
    // must be regenerated whenever the slots renderer changes or empty rows reappear.
    // in-chat-agents/index.js:1568 detects this script by id, so the id is preserved.
    {
        templateId: 'tpl-cyoa-choices',
        scriptId: 'bdb64078-4ee6-5349-b111-88893c372ad9',
        scriptName: 'Remove Empty Choice Rows',
        key: 'choices', archetype: ARCHETYPES.CLEANUP, groups: 0,
        cleanupFor: '1a3158de-fb03-4471-9718-2022bd6b5f44',
    },

    // ------------------------------------------------------------- pass-through
    {
        templateId: 'tpl-cyoa-choices',
        scriptId: '1c892238-de70-40bf-8394-97dd68d8eaff',
        scriptName: 'Trim Choices',
        key: 'choices', archetype: ARCHETYPES.PASSTHROUGH, groups: 0,
    },
    {
        templateId: 'tpl-direction-menu',
        scriptId: 'e1877fab-669e-467e-9495-43dd90a77295',
        scriptName: 'Trim Directions',
        key: 'directions', archetype: ARCHETYPES.PASSTHROUGH, groups: 0,
    },
];

// The skill-check variant uses the same numbered choices and cleanup contract.
SPEC_LIST.push(...SPEC_LIST.filter(spec => spec.templateId === 'tpl-cyoa-choices')
    .map(spec => ({ ...spec, templateId: 'tpl-cyoa-choices-skill-checks' })), {
    templateId: 'tpl-cyoa-choices-skill-checks', scriptId: '4678436c-2ab7-49fd-bc64-b7e1aa2ff779',
    scriptName: 'Bold', key: 'choices-bold', archetype: ARCHETYPES.BOLD, groups: 1,
});

// Ethereal panels retain every field in the current tag-based output contracts.
for (const [id, scriptId, title, icon, accent, head, rows] of [
    ['drift-tracker', 'f09c020a-405d-4b98-8f55-4cce8e21da7c', 'Drift', '✦', 4, [1, 2], [[3, 'Note']]],
    ['motif-tracker', '8e541238-0960-4f13-b08d-e03f019d4e23', 'Motif', '❦', 1, [1, 2], [[3, 'Accrued meaning'], [4, 'Note']]],
    ['thin-places-tracker', 'f94aa5a1-6d40-475c-bb9c-e0333048d884', 'Thin place', '🚪', 5, [1, 3], [[2, 'What leaks through'], [4, 'Note']]],
    ['omen-tracker', '1d2db72f-20f0-4e3d-8d9f-5c48ae9b2d3c', 'Omen', '🕯', 3, [1, 3], [[2, 'The reading'], [4, 'Context']]],
    ['entanglement-tracker', '98e47116-298c-4d41-a6b4-72eb12ef0242', 'Thread', '🪡', 6, [1, 3], [[2, 'The bond'], [4, 'Note']]],
    ['clock-is-lying', '108a87e8-11e3-4d12-9969-26ac4b642e55', 'The Clock Is Lying', '⏳', 4, [1, 2, 3], [[4, 'Note']]],
    ['improbable-effects', '7d4f82dc-ead2-43d6-b511-0080ba1fe7ca', 'Effects', '📦', 2, [2, 1], [[3, 'Current disposition'], [4, 'Note']]],
    ['afflictions-blessings', 'ae215399-4e5d-4f50-8af9-7f5e33f87251', 'Affliction', '🍄', 1, [1, 3], [[2, 'The condition'], [4, 'Note']]],
    ['the-ledger', 'e1a1f5ca-9f2b-418d-a13c-d259b746507a', 'Owed to the Strange', '✒', 4, [1, 3], [[2, 'What is owed'], [4, 'Context']]],
    ['what-the-town-knows', '5682b217-a23f-43b2-a05b-11b7d74b65f3', 'Rumour', '🦋', 6, [1, 3], [[2, 'As currently told'], [4, 'Cause']]],
    ['small-miracles', 'fb09f6d3-e5bf-4aec-8166-07f3f33aaeaa', 'Certificate of Miracle', '✿', 3, [1, 2], [[3, 'In recognition of'], [4, 'Clerk\'s remarks']]],
    ['thought-cabinet', '8617a87e-3f5e-40f5-b915-218214cd3ab3', 'Thought Cabinet', '💭', 5, [1, 2, 3], [[4, 'Tenancy report']]],
    ['the-committee', 'ee837a2a-b363-4b98-9a98-7f0d58d0980c', 'The Committee', '❝', 2, [1, 2, 3], [[4, 'Says']]],
    ['the-becoming', '0264a997-ded4-4b0f-945b-3e5d776fa986', 'The Becoming', '🪞', 5, [1, 2, 3], [[4, 'Evidence']]],
    ['doors', '2499f4e2-2e16-4b5b-b00f-d1a19879cd33', 'The Corridor', '🚪', 3, [], [[1, null]]],
    ['doors-fate-checks', '2499f4e2-2e16-4b5b-b00f-d1a19879cd33-fate', 'The Corridor', '🚪', 3, [], [[1, null]]],
    ['almanac-generator', '2d65af99-f6f0-4a30-a956-0a2866e4e753', 'The Almanac · {{user}}', '🕯', 3, [], [[1, null]]],
    ['the-turning', 'bef7746f-e03f-46a5-acd9-8e49a6697ac7', 'A Season Turns', '❀', 1, [], [[1, null]]],
]) {
    SPEC_LIST.push({
        templateId: `tpl-${id}`, scriptId, scriptName: title, key: id,
        archetype: ARCHETYPES.PANEL, groups: Math.max(...head, ...rows.map(([g]) => g)),
        icon, accent, open: head.length === 0 || id === 'drift-tracker' || id === 'clock-is-lying',
        head: [{ text: title }, ...head.map(g => ({ g }))],
        rows: rows.map(([g, label]) => ({ g, label, pre: true })),
    });
}

SPEC_LIST.push({
    templateId: 'tpl-meanwhile-impossibly', scriptId: 'ca2dbaa6-9615-48c4-b5bb-913b93177c30',
    scriptName: 'Meanwhile, Impossibly', key: 'elsewhere', archetype: ARCHETYPES.SLOTS, groups: 5,
    icon: '🌫', accent: 4, head: [{ text: 'Meanwhile' }, { g: 1 }, { g: 2 }],
    slots: [{ g: 3 }, { g: 4 }, { g: 5 }],
}, {
    templateId: 'tpl-four-winds', scriptId: '4385577e-0178-4bf6-8b8c-5bc3abc5c39e',
    scriptName: 'The Four Winds', key: 'winds', archetype: ARCHETYPES.SLOTS, groups: 4,
    icon: '🧭', accent: 4, open: true, rainbow: true, head: [{ text: 'The Four Winds' }],
    slots: [{ g: 1 }, { g: 2 }, { g: 3 }, { g: 4 }],
});

for (const [id, scriptId] of [
    ['doors', 'a5768625-fb47-4997-a554-e9d12e44f542'],
    ['doors-fate-checks', 'a5768625-fb47-4997-a554-e9d12e44f542-fate'],
    ['four-winds', '55ef1440-f695-419f-9d8a-a5f3349eb9b2'],
]) {
    SPEC_LIST.push({ templateId: `tpl-${id}`, scriptId, scriptName: `Trim ${id}`,
        key: id, archetype: ARCHETYPES.PASSTHROUGH, groups: 0 });
}

for (const [key, scriptId, tier, head, labels, optionalSections] of [
    ['resident', 'd4e7dd7e-8197-4ca3-90dd-a7708963ff1b', 'major', [1], ['Identity', 'Appearance', 'Strangeness', 'Manner', 'History', 'Ties'], []],
    ['lodger', '84839535-8869-4d50-9276-4e564a5e7f59', 'support', [1], ['Identity', 'Appearance', 'Strangeness', 'Manner', 'Ties'], [1, 2, 3, 4]],
    ['passerby', 'fc31e907-e677-4003-80cc-c6960d9fe08e', 'minor', [1], ['Who', 'Seen', 'Manner'], []],
    ['promotion', 'b780606f-07d0-4646-b917-581a45ef6fac', 'upgrade', [1, 2], ['Identity', 'Appearance', 'Strangeness', 'Manner'], []],
]) {
    SPEC_LIST.push({
        templateId: 'tpl-the-census', scriptId, scriptName: `Census ${key}`, key: `census-${key}`,
        archetype: ARCHETYPES.PROFILE, groups: head.length + labels.length, accent: 4, icon: '🪶',
        tier, optionalSections, head: [{ text: `Census · ${key}` }, ...head.map(g => ({ g }))],
        sections: labels.map((label, index) => ({ g: head.length + index + 1, label, accent: index })),
    });
}

SPEC_LIST.push({
    templateId: 'tpl-the-census', scriptId: '5f9b54de-fc98-493e-8d30-bdfbfca28f29',
    scriptName: 'Census Sighting', key: 'census-sighting', archetype: ARCHETYPES.CHIP, groups: 3,
    icon: '👁', accent: 4, fields: [{ g: 1, tone: 'strong' }, { g: 2, tone: 'warm' }, { g: 3, tone: 'cool' }],
}, {
    templateId: 'tpl-the-census', scriptId: '4af2ceec-ec51-420f-a591-a26a0825eda5',
    scriptName: 'Census Amendment', key: 'census-amendment', archetype: ARCHETYPES.CHIP, groups: 2,
    icon: '🖋', accent: 4, fields: [{ g: 1, tone: 'strong' }, { g: 2, tone: 'warm' }],
});

function withDefaults(spec) {
    return Object.freeze({
        family: 'tracker',
        icon: null,
        open: false,
        accent: 0,
        head: [],
        rows: [],
        sections: [],
        slots: [],
        stats: [],
        fields: [],
        kv: false,
        rainbow: false,
        ...spec,
        passthrough: spec.archetype === ARCHETYPES.PASSTHROUGH,
        regenerateFindRegex: spec.archetype === ARCHETYPES.CLEANUP,
    });
}

export const SPECS = Object.freeze(SPEC_LIST.map(withDefaults));

export function specKey(templateId, scriptId) {
    return `${templateId}/${scriptId}`;
}

/** @type {Map<string, typeof SPECS[number]>} */
export const SPEC_BY_KEY = new Map(SPECS.map(spec => [specKey(spec.templateId, spec.scriptId), spec]));

export function getSpec(templateId, scriptId) {
    return SPEC_BY_KEY.get(specKey(templateId, scriptId)) ?? null;
}

/** Template ids the extension can theme, in the order the UI lists them. */
export const THEMABLE_TEMPLATE_IDS = Object.freeze([...new Set(SPECS.map(spec => spec.templateId))]);

/** Distinct archetypes that produce markup, for the preview gallery's switcher. */
export const PREVIEWABLE_ARCHETYPES = Object.freeze([
    ARCHETYPES.PANEL,
    ARCHETYPES.PROFILE,
    ARCHETYPES.SLOTS,
    ARCHETYPES.STATCARD,
    ARCHETYPES.CHIP,
    ARCHETYPES.STREAM,
    ARCHETYPES.TRANSCRIPT,
]);
