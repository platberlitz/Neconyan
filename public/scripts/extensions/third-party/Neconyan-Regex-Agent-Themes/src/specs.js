/**
 * One spec per bundled regex script: which archetype renders it, and how its capture
 * groups map onto that archetype's slots.
 *
 * `findRegex` is never touched by a theme, so `groups` here must match the real capture
 * count of the shipped pattern. test/specs.test.js asserts that against src/stock.js.
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
export const ALLOWED_MACROS = Object.freeze(['{{user}}']);

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
        key: 'npc-upgrade', archetype: ARCHETYPES.PROFILE, groups: 6, accent: 1,
        tier: 'upgrade', icon: '⬆️',
        head: [{ g: 1 }, { g: 2, arrow: true }],
        sections: [
            { g: 3, label: 'Basics', accent: 0 },
            { g: 4, label: 'Appearance', accent: 3 },
            { g: 5, label: 'Personality', accent: 1 },
            { g: 6, label: 'History', accent: 2 },
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
        scriptId: 'eed918c3-7cb6-478d-8c9d-8272868046a9',
        scriptName: 'Replace Choices',
        key: 'choices', archetype: ARCHETYPES.SLOTS, groups: 7, accent: 1, open: true,
        icon: '📌', rainbow: true,
        head: [{ text: 'Choose your next action' }],
        slots: [{ g: 1 }, { g: 2 }, { g: 3 }, { g: 4 }, { g: 5 }, { g: 6 }, { g: 7 }],
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
        scriptId: '9fa2958c-215f-4fef-9a3e-804c0846f4fb',
        scriptName: 'Remove Empty Choice Rows',
        key: 'choices', archetype: ARCHETYPES.CLEANUP, groups: 0,
        cleanupFor: 'eed918c3-7cb6-478d-8c9d-8272868046a9',
    },

    // ------------------------------------------------------------- pass-through
    {
        templateId: 'tpl-cyoa-choices',
        scriptId: '1c892238-de70-40bf-8394-97dd68d8eaff',
        scriptName: 'Trim Choices',
        key: 'choices', archetype: ARCHETYPES.PASSTHROUGH, groups: 7,
    },
    {
        templateId: 'tpl-direction-menu',
        scriptId: 'e1877fab-669e-467e-9495-43dd90a77295',
        scriptName: 'Trim Directions',
        key: 'directions', archetype: ARCHETYPES.PASSTHROUGH, groups: 4,
    },
];

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
