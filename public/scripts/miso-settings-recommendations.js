// Miso's settings guide: local, deterministic recommendations. This module
// never loads a model, reads a chat or writes a setting. The settings page
// owns every change, including the snapshot that makes Undo possible.

export const MISO_GUIDE_ANSWERS_VERSION = 1;
export const MISO_GUIDE_STORAGE_KEY = 'NeconyanMisoSettingsGuide.v1';

export const MISO_GUIDE_SETTING_DETAILS = Object.freeze({
    simpleMode: Object.freeze({ title: 'Simple Mode', location: 'Settings → Appearance → Simple Mode' }),
    compactMode: Object.freeze({ title: 'Compact layout', location: 'Settings → Appearance → UI Theme' }),
    kittyless: Object.freeze({ title: 'Hide decorative cats', location: 'Settings → Appearance → Shell Style' }),
    chatDisplay: Object.freeze({ title: 'Chat style', location: 'Settings → Appearance → Chat Style' }),
    fontScale: Object.freeze({ title: 'Global font size', location: 'Settings → Appearance → Page Size & Clarity' }),
    lineSpacing: Object.freeze({ title: 'Line spacing', location: 'Settings → Appearance → Page Size & Clarity' }),
    messageTokenCount: Object.freeze({ title: 'Message token count', location: 'Settings → Chat & Writing → Chat & messages → Message details' }),
    messageTimer: Object.freeze({ title: 'Message timer', location: 'Settings → Chat & Writing → Chat & messages → Message details' }),
    messageModelName: Object.freeze({ title: 'Model name after messages', location: 'Settings → Chat & Writing → Chat & messages → Message details' }),
    reducedMotion: Object.freeze({ title: 'Reduced motion', location: 'Settings → Appearance → Visual Toggles' }),
    fastUi: Object.freeze({ title: 'No blur effect', location: 'Settings → Appearance → Visual Toggles' }),
    autoLoadChat: Object.freeze({ title: 'Reopen your last chat', location: 'Settings → Chat & Writing → Chat & messages → Chat window' }),
    replyLocation: Object.freeze({ title: 'Where replies are written', location: 'Settings → Chat & Writing → Chat & messages → Replies' }),
    smoothStreaming: Object.freeze({ title: 'Smooth streaming', location: 'Settings → Chat & Writing → Chat & messages → Replies' }),
    quickContinue: Object.freeze({ title: 'Continue button', location: 'Settings → Chat & Writing → Chat & messages → Sending' }),
    quickImpersonate: Object.freeze({ title: 'Impersonate button', location: 'Settings → Chat & Writing → Chat & messages → Sending' }),
    sendOnEnter: Object.freeze({ title: 'Send with Enter', location: 'Settings → Chat & Writing → Chat & messages → Sending' }),
    messageSound: Object.freeze({ title: 'Sound when a reply finishes', location: 'Settings → Chat & Writing → Chat & messages → Replies' }),
    backgroundSound: Object.freeze({ title: 'Sound only in the background', location: 'Settings → Chat & Writing → Chat & messages → Replies' }),
    spoilerFree: Object.freeze({ title: 'Spoiler-free mode', location: 'Settings → Chat & Writing → Characters' }),
    lowMemoryMode: Object.freeze({ title: 'Low-memory mode', location: 'Settings → System & Device → Memory and performance' }),
    streamingFps: Object.freeze({ title: 'Screen updates per second', location: 'Settings → Chat & Writing → Chat & messages → Replies' }),
    chatTruncation: Object.freeze({ title: 'Messages to load', location: 'Settings → Chat & Writing → Chat & messages → Chat window' }),
});

const target = (setting, value, reason) => Object.freeze({ setting, value, reason });

export const MISO_GUIDE_QUESTIONS = Object.freeze([
    Object.freeze({
        id: 'look',
        title: 'How should the screen feel?',
        help: 'Pick anything that fits. Miso leaves your theme and colours alone.',
        type: 'checkbox',
        options: Object.freeze([
            Object.freeze({
                value: 'simple',
                label: 'Simple Mode',
                hint: 'Keeps the chat, characters, connections and presets; tucks the rest away.',
                targets: Object.freeze([target('simpleMode', true, 'You asked for fewer controls on screen.')]),
            }),
            Object.freeze({
                value: 'compact',
                label: 'Compact layout',
                hint: 'Tighter spacing, so more of the chat fits on screen.',
                targets: Object.freeze([target('compactMode', true, 'You asked for a tighter layout.')]),
            }),
            Object.freeze({
                value: 'kittyless',
                label: 'Hide decorative cats',
                hint: 'Removes the cats, ears, paws and sleeping animals, and keeps your style.',
                targets: Object.freeze([target('kittyless', true, 'You asked for fewer cat decorations.')]),
            }),
        ]),
    }),
    Object.freeze({
        id: 'reading',
        title: 'How do you like to read?',
        help: 'Pick a chat style or a reading comfort. Only one chat style can be on at a time.',
        type: 'checkbox',
        singleChoice: Object.freeze(['bubbles', 'messenger', 'storybook']),
        options: Object.freeze([
            Object.freeze({
                value: 'bubbles',
                label: 'Bubbles',
                hint: 'Rounded speech bubbles for both sides of the chat.',
                targets: Object.freeze([target('chatDisplay', 1, 'You picked the Bubbles chat style.')]),
            }),
            Object.freeze({
                value: 'messenger',
                label: 'Messenger',
                hint: 'A familiar direct-message feed with the latest reply in view.',
                targets: Object.freeze([target('chatDisplay', 8, 'You picked the Messenger chat style.')]),
            }),
            Object.freeze({
                value: 'storybook',
                label: 'Storybook',
                hint: 'A page-like scene for long, written replies.',
                targets: Object.freeze([target('chatDisplay', 12, 'You picked the Storybook chat style.')]),
            }),
            Object.freeze({
                value: 'larger_text',
                label: 'Larger text',
                hint: 'A slightly bigger page font and roomier lines.',
                targets: Object.freeze([
                    target('fontScale', 1.15, 'You asked for larger text.'),
                    target('lineSpacing', 1.35, 'You asked for roomier lines.'),
                ]),
            }),
            Object.freeze({
                value: 'hide_details',
                label: 'Hide extra details',
                hint: 'Removes token counts, reply timers and the model name under messages.',
                targets: Object.freeze([
                    target('messageTokenCount', false, 'You asked to hide token counts.'),
                    target('messageTimer', false, 'You asked to hide reply timers.'),
                    target('messageModelName', false, 'You asked to hide the model name under messages.'),
                ]),
            }),
            Object.freeze({
                value: 'calm_motion',
                label: 'Calmer motion',
                hint: 'Turns off animations and drops the frosted blur behind panels.',
                targets: Object.freeze([
                    target('reducedMotion', true, 'You asked for less motion.'),
                    target('fastUi', true, 'You asked for a calmer, lighter screen.'),
                ]),
            }),
        ]),
    }),
    Object.freeze({
        id: 'chatting',
        title: 'What makes chatting easier?',
        help: 'Pick the conveniences you actually use. Each one is a separate switch.',
        type: 'checkbox',
        options: Object.freeze([
            Object.freeze({
                value: 'resume',
                label: 'Reopen my last chat',
                hint: 'Opening Neconyan returns to the chat you had open.',
                targets: Object.freeze([target('autoLoadChat', true, 'You asked to reopen your last chat.')]),
            }),
            Object.freeze({
                value: 'server_replies',
                label: 'Keep replies going on the server',
                hint: 'Ordinary Roleplay replies finish on the server if you close the page or your phone sleeps.',
                targets: Object.freeze([target('replyLocation', 'server', 'You asked replies to keep going after the page closes.')]),
            }),
            Object.freeze({
                value: 'smooth_stream',
                label: 'Smooth streaming',
                hint: 'Replies appear at an even pace instead of in bursts.',
                targets: Object.freeze([target('smoothStreaming', true, 'You asked for smoother streaming.')]),
            }),
            Object.freeze({
                value: 'quick_helpers',
                label: 'Continue and Impersonate buttons',
                hint: 'Adds the two helper buttons beside Send.',
                targets: Object.freeze([
                    target('quickContinue', true, 'You asked for the Continue button.'),
                    target('quickImpersonate', true, 'You asked for the Impersonate button.'),
                ]),
            }),
            Object.freeze({
                value: 'send_newline',
                label: 'Enter adds a new line',
                hint: 'Uses the Send button instead, so Enter does not send by accident.',
                targets: Object.freeze([target('sendOnEnter', -1, 'You asked Enter to add a line instead of sending.')]),
            }),
            Object.freeze({
                value: 'chime',
                label: 'Chime when a reply finishes',
                hint: 'Plays the message sound, including while Neconyan is in another tab.',
                targets: Object.freeze([
                    target('messageSound', true, 'You asked to hear when a reply finishes.'),
                    target('backgroundSound', true, 'You asked to hear it while Neconyan is in the background.'),
                ]),
            }),
            Object.freeze({
                value: 'spoiler_free',
                label: 'Spoiler-free mode',
                hint: 'Hides card descriptions and other details until you look.',
                targets: Object.freeze([target('spoilerFree', true, 'You asked to hide card details until you look.')]),
            }),
        ]),
    }),
    Object.freeze({
        id: 'device',
        title: 'What kind of device is this?',
        help: 'This choice is saved for this browser on this device. Leave it alone if you are not sure.',
        type: 'radio',
        options: Object.freeze([
            Object.freeze({
                value: 'keep',
                label: 'Leave performance settings alone',
                hint: 'Miso suggests nothing for this device.',
                targets: Object.freeze([]),
            }),
            Object.freeze({
                value: 'standard',
                label: 'Let Neconyan decide',
                hint: 'Uses the browser memory report to switch low-memory mode on or off by itself.',
                targets: Object.freeze([target('lowMemoryMode', 'auto', 'You asked Neconyan to decide from the device report.')]),
            }),
            Object.freeze({
                value: 'low_memory',
                label: 'A small or older device',
                hint: 'Turns low-memory mode on and lowers screen updates to 15 per second.',
                targets: Object.freeze([
                    target('lowMemoryMode', 'on', 'You said this is a small or older device.'),
                    target('streamingFps', 15, 'You said this device needs lighter drawing.'),
                ]),
            }),
            Object.freeze({
                value: 'plenty',
                label: 'A desktop or a roomy phone',
                hint: 'Turns low-memory mode off and loads 150 messages when a chat opens.',
                targets: Object.freeze([
                    target('lowMemoryMode', 'off', 'You said this device has memory to spare.'),
                    target('chatTruncation', 150, 'You said this device can load more messages at once.'),
                ]),
            }),
        ]),
    }),
]);

const QUESTION_BY_ID = new Map(MISO_GUIDE_QUESTIONS.map(question => [question.id, question]));

export function getMisoQuestion(id) {
    return QUESTION_BY_ID.get(String(id ?? '')) ?? null;
}

export function createDefaultMisoGuideAnswers() {
    return {
        version: MISO_GUIDE_ANSWERS_VERSION,
        look: [],
        reading: [],
        chatting: [],
        device: 'keep',
    };
}

/** Accepts anything from account storage and returns safe, complete answers. */
export function normalizeMisoGuideAnswers(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const answers = createDefaultMisoGuideAnswers();

    for (const question of MISO_GUIDE_QUESTIONS) {
        if (question.type === 'radio') {
            const allowed = new Set(question.options.map(option => option.value));
            const requested = typeof source[question.id] === 'string'
                ? source[question.id].trim().toLocaleLowerCase('en')
                : '';
            answers[question.id] = allowed.has(requested) ? requested : createDefaultMisoGuideAnswers()[question.id];
            continue;
        }

        const requested = new Set(Array.isArray(source[question.id])
            ? source[question.id]
                .filter(item => typeof item === 'string')
                .map(item => item.trim().toLocaleLowerCase('en'))
            : []);
        const singleChoice = new Set(question.singleChoice ?? []);
        const chosen = [];
        // Walk the definition order so both the storage order and a corrupt
        // "two chat styles" answer resolve the same way every time.
        for (const option of question.options) {
            if (!requested.has(option.value)) continue;
            if (singleChoice.has(option.value) && chosen.some(value => singleChoice.has(value))) continue;
            chosen.push(option.value);
        }
        answers[question.id] = chosen;
    }

    return answers;
}

export function isSameMisoSettingValue(left, right) {
    if (typeof left === 'number' || typeof right === 'number') {
        const leftNumber = Number(left);
        const rightNumber = Number(right);
        return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && Math.abs(leftNumber - rightNumber) < 0.001;
    }
    return left === right;
}

export function formatMisoSettingValue(settingId, value) {
    if (typeof value === 'boolean') return value ? 'On' : 'Off';
    if (settingId === 'chatDisplay') {
        if (Number(value) === 1) return 'Bubbles';
        if (Number(value) === 8) return 'Messenger';
        if (Number(value) === 12) return 'Storybook';
        return `Chat style ${value}`;
    }
    if (settingId === 'sendOnEnter') {
        if (Number(value) === -1) return 'Disabled';
        if (Number(value) === 0) return 'Automatic (PC)';
        if (Number(value) === 1) return 'Enabled';
        return String(value);
    }
    if (settingId === 'lowMemoryMode') {
        if (value === 'auto') return 'Auto';
        if (value === 'on') return 'On';
        if (value === 'off') return 'Off';
        return String(value);
    }
    if (settingId === 'replyLocation') {
        if (value === 'server') return 'On the server';
        if (value === 'browser') return 'In the browser';
        return String(value);
    }
    if (settingId === 'chatTruncation') return `${value} messages`;
    if (settingId === 'streamingFps') return `${value} per second`;
    return String(value);
}

function reasonsOf(item) {
    if (Array.isArray(item?.reasons)) return [...item.reasons];
    return item?.reason ? [item.reason] : [];
}

/**
 * Keeps the first target for a setting and turns a later, different target
 * into a skipped row instead of letting one answer quietly overwrite another.
 */
export function resolveMisoTargetConflicts(targets = []) {
    const resolved = [];
    const conflicts = [];
    const bySetting = new Map();

    for (const candidate of targets) {
        const settingId = String(candidate?.settingId ?? '');
        if (!settingId) continue;
        const existing = bySetting.get(settingId);
        if (!existing) {
            const copy = { ...candidate, reasons: reasonsOf(candidate) };
            bySetting.set(settingId, copy);
            resolved.push(copy);
            continue;
        }
        if (isSameMisoSettingValue(existing.value, candidate.value)) {
            for (const reason of reasonsOf(candidate)) {
                if (reason && !existing.reasons.includes(reason)) existing.reasons.push(reason);
            }
            continue;
        }
        const title = MISO_GUIDE_SETTING_DETAILS[settingId]?.title ?? settingId;
        conflicts.push({
            settingId,
            title,
            optionLabel: candidate.optionLabel,
            valueLabel: candidate.valueLabel,
            reason: `${candidate.optionLabel} also asks for ${title} ${candidate.valueLabel}, but ${existing.optionLabel} already asks for ${existing.valueLabel}. Kept ${existing.valueLabel}.`,
        });
    }

    return { targets: resolved, conflicts };
}

/** New picks start checked; a known pick keeps its previous checked state. */
export function mergeMisoSelection({ previousSelection = [], previousKnown = [], picks = [], resetSelection = false } = {}) {
    const selected = new Set(previousSelection);
    const known = new Set(previousKnown);
    const next = new Set();
    for (const pick of picks) {
        const settingId = typeof pick === 'string' ? pick : pick?.settingId;
        if (!settingId) continue;
        if (resetSelection || !known.has(settingId) || selected.has(settingId)) next.add(settingId);
    }
    return next;
}

/** Low-memory mode first, then settings its policy manages, then everything else. */
export function sortMisoTargetsForApply(targets = []) {
    const rank = settingId => {
        if (settingId === 'lowMemoryMode') return 0;
        if (settingId === 'fastUi' || settingId === 'chatTruncation' || settingId === 'streamingFps') return 1;
        return 2;
    };
    return [...targets].sort((left, right) => rank(left.settingId) - rank(right.settingId));
}

/**
 * @typedef {object} MisoGuideTarget
 * @property {string} settingId
 * @property {string} title
 * @property {string} location
 * @property {*} value
 * @property {string} valueLabel
 * @property {string} optionLabel
 * @property {string[]} reasons
 * @property {*} current
 */

/**
 * Recommends settings for Miso's guide. Local and deterministic.
 * @param {ReturnType<typeof normalizeMisoGuideAnswers>} answers
 * @param {{values?: Record<string, *>, locked?: string[]}} [context]
 *        `values` must hold the effective current value of every setting.
 */
export function recommendSettings(answers, context = {}) {
    const normalized = normalizeMisoGuideAnswers(answers);
    const values = context.values && typeof context.values === 'object' ? context.values : {};
    const lockedSource = context.locked;
    const locked = new Set(Array.isArray(lockedSource) ? lockedSource.map(String) : Object.keys(lockedSource ?? {}));
    const lockedReasons = context.lockedReasons && typeof context.lockedReasons === 'object'
        ? context.lockedReasons
        : (!Array.isArray(lockedSource) && lockedSource && typeof lockedSource === 'object' ? lockedSource : {});

    const requested = [];
    for (const question of MISO_GUIDE_QUESTIONS) {
        const selected = question.type === 'radio' ? [normalized[question.id]] : normalized[question.id];
        for (const option of question.options) {
            if (!selected.includes(option.value)) continue;
            for (const entry of option.targets) {
                requested.push({
                    settingId: entry.setting,
                    value: entry.value,
                    valueLabel: formatMisoSettingValue(entry.setting, entry.value),
                    optionValue: option.value,
                    optionLabel: option.label,
                    reason: entry.reason,
                });
            }
        }
    }

    const { targets, conflicts } = resolveMisoTargetConflicts(requested);
    const picks = [];
    const alreadySet = [];
    const skipped = [...conflicts];

    for (const entry of targets) {
        const details = MISO_GUIDE_SETTING_DETAILS[entry.settingId] ?? { title: entry.settingId, location: 'Settings' };
        const current = values[entry.settingId];
        const currentLabel = current === undefined ? 'Not read' : formatMisoSettingValue(entry.settingId, current);
        const row = { ...entry, ...details, current, currentLabel };

        if (isSameMisoSettingValue(current, entry.value)) {
            alreadySet.push({ ...row, alreadySet: true });
            continue;
        }
        if (locked.has(entry.settingId)) {
            const lockedReason = String(lockedReasons[entry.settingId] ?? '').trim();
            skipped.push({
                settingId: entry.settingId,
                title: row.title,
                optionLabel: row.optionLabel,
                valueLabel: row.valueLabel,
                reason: lockedReason || `${row.title} is set by this device or the current style, so Miso cannot change it.`,
            });
            continue;
        }
        picks.push(row);
    }

    const notes = [];
    if (!picks.length && !alreadySet.length) {
        notes.push('No answers are selected yet. Choose what fits and Miso will show the settings it would change.');
    } else {
        notes.push('Miso reads the settings already on this page. It sends no model request.');
        if (picks.length) notes.push('Only the boxes you tick are applied.');
        if (alreadySet.length) notes.push('Settings already at the suggested value are marked Already set.');
    }
    if (normalized.device !== 'keep') {
        notes.push('Low-memory mode is saved for this browser on this device.');
    }

    return {
        answers: normalized,
        picks,
        alreadySet,
        skipped,
        notes,
        counts: {
            newPicks: picks.length,
            alreadySet: alreadySet.length,
            skipped: skipped.length,
        },
        canApply: picks.length > 0,
    };
}

/** The first reason an undo can no longer safely touch the settings it changed. */
export function getMisoUndoBlockReason({
    applied = {},
    current = {},
    expectedPreferences = null,
    currentPreferences = null,
} = {}) {
    for (const [settingId, expected] of Object.entries(applied)) {
        if (!Object.hasOwn(current, settingId) || !isSameMisoSettingValue(current[settingId], expected)) {
            return 'One of these settings changed elsewhere. Check it before undoing, so Miso does not overwrite your change.';
        }
    }
    if (expectedPreferences !== null && String(expectedPreferences) !== String(currentPreferences)) {
        return 'The low-memory choices changed elsewhere. Check Memory and performance before undoing.';
    }
    return '';
}
