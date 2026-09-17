import { ctxOf, getContext } from './host.js';
import { isPromptTagsAvailable, readPromptTags, readPromptTagsGlobalState } from './integrations/prompttags.js';
import { PRESET_API_IDS as WORKSHOP_API_IDS, describePresetRef, modeOf } from './presets.js';

/**
 * Applies a test case's pinned configuration, and puts the user's own
 * configuration back afterwards.
 *
 * Order matters. Opening a character raises CHAT_CHANGED, and Neconyan reacts
 * to that by selecting a preset named after the character and by applying any
 * persona locked to the chat. Anything applied before the character switch
 * would be silently undone, so the character goes first and the preset last.
 */

const NONE_PROFILE = '<None>';
const SETTLE_TIMEOUT_MS = 5000;
/** Reactions to CHAT_CHANGED are queued, not immediate; let them land. */
const SETTLE_TICK_MS = 300;

/**
 * Preset managers a run can change behind the user's back, either because a
 * connection profile carries them or because a test case pins them.
 */
export const PRESET_API_IDS = Object.freeze([
    ...new Set(['instruct', 'context', 'sysprompt', 'reasoning', ...WORKSHOP_API_IDS]),
]);

// These are the effective fields Neconyan's connection manager reads and
// writes. Using its command callbacks keeps snapshots aligned with live UI state.
const CONNECTION_COMMANDS = Object.freeze({
    cc: Object.freeze([
        'api', 'preset', 'api', 'secret-id', 'api-url', 'model', 'proxy',
        'stop-strings', 'start-reply-with', 'reasoning-template',
        'request-reasoning', 'reasoning-effort', 'verbosity', 'enable-web-search',
        'request-images', 'request-image-resolution', 'request-image-aspect-ratio',
        'custom-reasoning-param-format',
        'custom-reasoning-param-name', 'custom-reasoning-enabled-value',
        'custom-reasoning-disabled-value', 'prompt-post-processing', 'regex-preset',
    ]),
    tc: Object.freeze([
        'api', 'preset', 'api-url', 'model', 'sysprompt', 'sysprompt-state',
        'instruct', 'context', 'instruct-state', 'tokenizer', 'stop-strings',
        'start-reply-with', 'reasoning-template', 'secret-id', 'regex-preset',
    ]),
});
const EMPTY_CONNECTION_FIELDS = new Set([
    'stop-strings', 'start-reply-with', 'request-image-resolution',
    'request-image-aspect-ratio', 'custom-reasoning-param-name',
    'custom-reasoning-enabled-value', 'custom-reasoning-disabled-value',
]);
const PROFILE_PRESET_FIELDS = Object.freeze({
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    'reasoning-template': 'reasoning',
});

export function quoteSlashArg(value) {
    return `"${String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, '\\n')}"`;
}

export function normalizeApiId(source, apiId = '') {
    const value = String(apiId || '').trim();
    if (value) {
        return value === 'koboldhorde' ? 'kobold' : value;
    }
    const main = String(ctxOf(source)?.mainApi ?? '');
    return main === 'koboldhorde' ? 'kobold' : main;
}

export function generationMode(hostRef = getContext) {
    return String(ctxOf(hostRef)?.mainApi ?? '') === 'openai' ? 'cc' : 'tc';
}

function modeLabel(mode) {
    return mode === 'cc' ? 'Chat Completion' : 'Text Completion';
}

/** Why the pinned presets cannot run under the host's live generation mode. */
export function presetModeProblem(hostRef = getContext, pins = null) {
    const modes = new Set(presetRefs(pins).map(ref => modeOf(normalizeApiId(hostRef, ref.apiId))));
    if (modes.size > 1) {
        return 'This test case pins both Chat Completion and Text Completion presets. Only one generation mode can run at a time.';
    }
    const pinnedMode = [...modes][0];
    const liveMode = generationMode(hostRef);
    return pinnedMode && pinnedMode !== liveMode
        ? `This test case pins ${modeLabel(pinnedMode)} presets, but Neconyan is currently using ${modeLabel(liveMode)}.`
        : '';
}

function delay(ms, signal) {
    return new Promise((resolve) => {
        let timer = null;
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', finish);
            resolve();
        };
        if (signal?.aborted) {
            finish();
            return;
        }
        timer = setTimeout(finish, ms);
        signal?.addEventListener?.('abort', finish, { once: true });
    });
}

/**
 * Waits for a host event, but never longer than the timeout. A missing event is
 * not treated as a failure: some hosts skip it, and the run should continue.
 */
export function waitForEvent(hostRef, eventType, timeoutMs = SETTLE_TIMEOUT_MS) {
    const source = ctxOf(hostRef)?.eventSource;
    const add = typeof source?.on === 'function' ? source.on : source?.once;
    if (!eventType || typeof add !== 'function') {
        return delay(0);
    }
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                source.removeListener?.(eventType, finish);
                resolve();
            }
        };
        try {
            add.call(source, eventType, finish);
        } catch {
            finish();
            return;
        }
        timer = setTimeout(finish, timeoutMs);
    });
}

/* ------------------------------------------------------- profile helpers */

export function getConnectionProfiles(hostRef = getContext) {
    const profiles = ctxOf(hostRef)?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

export function getProfileById(hostRef, id) {
    if (!id) {
        return null;
    }
    return getConnectionProfiles(hostRef).find(profile => profile?.id === id) ?? null;
}

export function getProfileByName(hostRef, name) {
    if (!name) {
        return null;
    }
    return getConnectionProfiles(hostRef).find(profile => profile?.name === name) ?? null;
}

/** Accepts an id or, for settings written by hand, a name. */
export function resolveProfile(hostRef = getContext, value = '') {
    return getProfileById(hostRef, value) ?? getProfileByName(hostRef, value);
}

export function getSelectedProfileId(hostRef = getContext) {
    return ctxOf(hostRef)?.extensionSettings?.connectionManager?.selectedProfile ?? '';
}

function profilePresetApi(field, mode) {
    return field === 'preset'
        ? (mode === 'cc' ? 'openai' : 'textgenerationwebui')
        : PROFILE_PRESET_FIELDS[field];
}

function profileFieldValues(profile) {
    const values = {};
    const excluded = new Set(Array.isArray(profile?.exclude) ? profile.exclude : []);
    for (const field of CONNECTION_COMMANDS[profile?.mode] ?? []) {
        if (excluded.has(field)) {
            continue;
        }
        let value = profile[field];
        if (field === 'proxy' && !value) {
            value = 'None';
        }
        if (!value && !(EMPTY_CONNECTION_FIELDS.has(field) && value === '')) {
            continue;
        }
        values[field] = String(value);
    }
    return values;
}

function canWriteConnectionValue(field, value, snapshot) {
    if (value !== '' || EMPTY_CONNECTION_FIELDS.has(field)) {
        return true;
    }
    const apiId = profilePresetApi(field, snapshot?.connection?.mode);
    return Boolean(apiId && snapshot?.presetRestorable?.[apiId]);
}

/** Whether the captured live state can undo every field both profiles apply. */
export function canRestoreProfileOverride(hostRef, targetId, snapshot = null) {
    const originalId = snapshot?.profileId ?? getSelectedProfileId(hostRef);
    const original = resolveProfile(hostRef, originalId);
    const target = resolveProfile(hostRef, targetId);
    if (!target) {
        return false;
    }
    if (target.id === originalId) {
        return true;
    }
    // ponytail: reading the inactive mode would itself switch APIs, so refuse
    // cross-mode overrides instead of pretending their hidden settings restore.
    if (!original || original.mode !== target.mode || snapshot?.connection?.mode !== target.mode) {
        return false;
    }
    if (target.mode === 'cc' && snapshot.connection.modelSamplingProfilesEnabled
        && (snapshot.presetDirty?.openai !== false || !snapshot.presetRestorable?.openai)) {
        return false;
    }

    const originalFields = profileFieldValues(original);
    const targetFields = profileFieldValues(target);
    for (const field of new Set([...Object.keys(originalFields), ...Object.keys(targetFields)])) {
        if (!Object.hasOwn(snapshot.connection.fields, field)) {
            return false;
        }
        const presetApiId = profilePresetApi(field, target.mode);
        if (presetApiId && snapshot.presetDirty?.[presetApiId] !== false) {
            return false;
        }
        const captured = snapshot.connection.fields[field];
        const willChange = (Object.hasOwn(targetFields, field) && targetFields[field] !== captured)
            || (Object.hasOwn(originalFields, field) && originalFields[field] !== captured);
        if (willChange && !canWriteConnectionValue(field, captured, snapshot)) {
            return false;
        }
    }
    return true;
}

/** Whether a selected profile's fields, not just its id, are currently live. */
export function profileMatchesConnectionState(hostRef, profileId, snapshot) {
    const profile = resolveProfile(hostRef, profileId);
    if (!profile || profile.mode !== snapshot?.connection?.mode) {
        return false;
    }
    return Object.entries(profileFieldValues(profile)).every(([field, expected]) => (
        Object.hasOwn(snapshot.connection.fields, field)
        && snapshot.connection.fields[field] === expected
    ));
}

/* -------------------------------------------------------- preset helpers */

export function getPresetName(hostRef = getContext, apiId = '') {
    try {
        const context = ctxOf(hostRef);
        return context?.getPresetManager?.(normalizeApiId(hostRef, apiId))?.getSelectedPresetName?.() ?? '';
    } catch {
        return '';
    }
}

async function selectPreset(hostRef, apiId, presetName) {
    if (!presetName) {
        return false;
    }
    const context = ctxOf(hostRef);
    const manager = context?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (!manager?.findPreset) {
        return false;
    }
    if (manager.getSelectedPresetName?.() === presetName) {
        return true;
    }
    const value = manager.findPreset(presetName);
    if (value === undefined || value === null || value === '') {
        return false;
    }
    await manager.selectPreset(value);
    const selected = manager.getSelectedPresetName?.();
    return selected === undefined || selected === presetName;
}

/**
 * Reports whether the preset panel holds edits the user has not saved.
 * Selecting a preset discards them, so the runner warns first. The dirty check
 * is a private helper in Neconyan; if it disappears, assume the worst.
 */
export function hasUnsavedPresetEdits(hostRef = getContext, apiId = '') {
    const manager = ctxOf(hostRef)?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (!manager) {
        return false;
    }
    if (typeof manager._checkDirty !== 'function') {
        return null;
    }
    try {
        manager._checkDirty({ force: true });
        return typeof manager._dirty === 'boolean' ? manager._dirty : null;
    } catch {
        return null;
    }
}

async function connectionField(hostRef, field, value, write = false) {
    const callback = ctxOf(hostRef)?.SlashCommandParser?.commands?.[field]?.callback;
    if (typeof callback !== 'function') {
        throw new Error(`The host does not expose /${field}.`);
    }
    const result = await callback({
        quiet: 'true',
        force: write && value === '' && EMPTY_CONNECTION_FIELDS.has(field) ? 'true' : 'false',
        forceGet: 'true',
        connect: 'false',
        _hasUnnamedArgument: write,
    }, write ? value : '');
    return String(result ?? '');
}

async function readConnectionState(hostRef) {
    const mode = generationMode(hostRef);
    const fields = {};
    const unavailable = [];
    for (const field of new Set(CONNECTION_COMMANDS[mode])) {
        try {
            fields[field] = await connectionField(hostRef, field);
        } catch {
            unavailable.push(field);
        }
    }
    return {
        mode,
        fields,
        unavailable,
        modelSamplingProfilesEnabled: mode === 'cc'
            && Boolean(ctxOf(hostRef)?.chatCompletionSettings?.model_sampling_profiles_enabled),
    };
}

/* ------------------------------------------------------ character helpers */

export function findCharacterIndex(hostRef = getContext, avatar = '') {
    if (!avatar) {
        return -1;
    }
    const context = ctxOf(hostRef);
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    return characters.findIndex(character => character?.avatar === avatar);
}

/** Always resolved fresh: characterId is copied by value into the context. */
export function getCharacterAvatar(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const index = context?.characterId;
    if (index === undefined || index === null) {
        return '';
    }
    return context?.characters?.[index]?.avatar ?? '';
}

/* ---------------------------------------------------------------- snapshot */

/**
 * Records everything a run can change, so it can all be put back.
 * Read live rather than from a cached context: several of these fields are
 * copied by value when the context object is built.
 */
export async function snapshotState(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const presets = {};
    const presetValues = {};
    const presetDirty = {};
    const presetRestorable = {};
    const mainApiId = normalizeApiId(hostRef);
    const apiIds = new Set([mainApiId, ...PRESET_API_IDS].filter(Boolean));
    for (const apiId of apiIds) {
        const manager = context?.getPresetManager?.(normalizeApiId(hostRef, apiId));
        presets[apiId] = getPresetName(hostRef, apiId);
        try {
            presetValues[apiId] = manager?.getSelectedPreset?.();
        } catch {
            presetValues[apiId] = undefined;
        }
        presetDirty[apiId] = hasUnsavedPresetEdits(hostRef, apiId);
        presetRestorable[apiId] = typeof manager?.selectPreset === 'function'
            && (Boolean(presets[apiId])
                || (presetValues[apiId] !== undefined && presetValues[apiId] !== null));
    }
    return {
        characterAvatar: getCharacterAvatar(hostRef),
        characterId: context?.characterId ?? undefined,
        groupId: context?.groupId ?? undefined,
        chatId: context?.chatId ?? '',
        personaKey: context?.userAvatar ?? '',
        profileId: getSelectedProfileId(hostRef),
        mainApi: context?.mainApi ?? '',
        presets,
        presetValues,
        presetDirty,
        presetRestorable,
        connection: await readConnectionState(hostRef),
        promptTags: readPromptTagsGlobalState(hostRef),
    };
}

/* ------------------------------------------------------------------ apply */

async function runSlash(hostRef, command) {
    const context = ctxOf(hostRef);
    if (typeof context?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('The host slash-command API is unavailable.');
    }
    const result = await context.executeSlashCommandsWithOptions(command);
    if (result?.error === true || result?.isError === true) {
        throw new Error(String(result?.errorMessage || result?.message || 'The host could not run that command in the current chat.'));
    }
    return result;
}

async function applyCharacter(hostRef, avatar, { signal } = {}) {
    if (!avatar) {
        throw new Error('No character is chosen for this test case.');
    }
    const index = findCharacterIndex(hostRef, avatar);
    if (index < 0) {
        throw new Error(`This test case uses a character that is not installed any more (${avatar}). Choose a different character or reinstall that card.`);
    }
    if (getCharacterAvatar(hostRef) === avatar) {
        return;
    }
    const settled = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CHAT_CHANGED);
    const ok = await ctxOf(hostRef).selectCharacterById(index, { switchMenu: false });
    if (ok === false) {
        throw new Error('Neconyan would not switch character, usually because a reply is still being generated. Wait for it to finish and run the tests again.');
    }
    await settled;
    // Let Neconyan's own reactions to the chat change finish before the
    // persona and preset below are applied, or they will be overwritten.
    await delay(SETTLE_TICK_MS, signal);
}

async function applyPersona(hostRef, personaKey) {
    if (!personaKey) {
        return;
    }
    if (ctxOf(hostRef)?.userAvatar !== personaKey) {
        await runSlash(hostRef, `/persona-set mode=lookup ${quoteSlashArg(personaKey)}`);
    }
    if (ctxOf(hostRef)?.userAvatar !== personaKey) {
        throw new Error(`Neconyan did not apply the pinned persona (${personaKey}).`);
    }
}

async function applyProfile(hostRef, profileId) {
    if (!profileId) {
        return;
    }
    const profile = resolveProfile(hostRef, profileId);
    if (!profile) {
        throw new Error('This test case uses a connection profile that no longer exists. Choose a different profile for the test case.');
    }
    if (getSelectedProfileId(hostRef) !== profile.id) {
        const loaded = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CONNECTION_PROFILE_LOADED);
        await runSlash(hostRef, `/profile await=true ${quoteSlashArg(profile.name)}`);
        await loaded;
    }
    if (getSelectedProfileId(hostRef) !== profile.id) {
        throw new Error(`Neconyan did not apply the pinned connection profile (${profile.name}).`);
    }
    const mainApi = String(ctxOf(hostRef)?.mainApi ?? '');
    if ((profile.mode === 'cc' && mainApi !== 'openai')
        || (profile.mode === 'tc' && mainApi === 'openai')) {
        throw new Error(`Neconyan selected connection profile "${profile.name}" but did not apply its ${profile.mode === 'cc' ? 'Chat' : 'Text'} Completion mode.`);
    }
}

async function applyPromptTagsProfile(hostRef, promptTags) {
    if (!promptTags?.profileName && !promptTags?.profileId) {
        return;
    }
    const available = ctxOf(hostRef)?.extensionSettings?.promptTags?.profiles;
    if (!available || !isPromptTagsAvailable(hostRef)) {
        throw new Error('This test case pins a Prompt Tags profile, but Prompt Tags is not installed or enabled.');
    }
    if (ctxOf(hostRef)?.extensionSettings?.promptTags?.enabled === false) {
        throw new Error('This test case pins a Prompt Tags profile, but Prompt Tags is disabled. Enable it before running this test.');
    }
    const name = promptTags.profileName && available[promptTags.profileName]
        ? promptTags.profileName
        : Object.keys(available).find(key => available[key]?.id === promptTags.profileId);
    if (!name) {
        throw new Error('This test case uses a Prompt Tags profile that no longer exists. Choose a different profile for the test case.');
    }
    const expectedId = String(available[name]?.id ?? promptTags.profileId ?? '');
    const current = readPromptTags(hostRef);
    if (current?.profileId !== expectedId && current?.profileName !== name) {
        await runSlash(hostRef, `/prompttags-profile ${quoteSlashArg(name)}`);
    }
    const effective = readPromptTags(hostRef);
    if (!effective?.enabled
        || (expectedId ? effective.profileId !== expectedId : effective.profileName !== name)) {
        throw new Error(`Prompt Tags profile "${name}" is not effective for this chat. A chat, character, or preset profile assignment may be overriding the global profile.`);
    }
}

/** Reads a case's pinned presets, including the pre-v2 single-preset shape. */
export function presetRefs(pins) {
    const list = Array.isArray(pins?.presets) ? pins.presets : [];
    const legacy = pins?.preset?.name ? [pins.preset] : [];
    return [...list, ...legacy].filter(ref => ref?.name);
}

/**
 * Applies every pinned preset and checks afterwards that each one really is
 * selected. Neconyan links some templates together (choosing a context
 * template can pull in the instruct template of the same name), so a pin that
 * was applied first can be replaced by a later one without any error.
 */
async function applyPresets(hostRef, refs) {
    for (const ref of refs) {
        const applied = await selectPreset(hostRef, ref.apiId, ref.name);
        if (!applied) {
            throw new Error(`This test case uses a preset that is not available any more (${describePresetRef(ref)}). Choose a different preset for the test case.`);
        }
    }
    for (const ref of refs) {
        const selected = getPresetName(hostRef, ref.apiId);
        if (selected !== ref.name) {
            throw new Error(`Neconyan replaced the pinned preset ${describePresetRef(ref)} with "${selected}" while applying the other presets in this test case. Templates that are linked to each other cannot be pinned separately.`);
        }
    }
}

async function verifyProfileFields(hostRef, profileId, refs = []) {
    const profile = resolveProfile(hostRef, profileId);
    if (!profile || getSelectedProfileId(hostRef) !== profile.id) {
        throw new Error('The pinned connection profile is no longer selected.');
    }
    if (generationMode(hostRef) !== profile.mode) {
        throw new Error(`The pinned connection profile requires ${modeLabel(profile.mode)}, but Neconyan is using ${modeLabel(generationMode(hostRef))}.`);
    }
    const pinnedPresetApiIds = new Set(refs.map(ref => normalizeApiId(hostRef, ref.apiId)));
    for (const [field, expected] of Object.entries(profileFieldValues(profile))) {
        if (pinnedPresetApiIds.has(profilePresetApi(field, profile.mode))) {
            continue;
        }
        let actual;
        try {
            actual = await connectionField(hostRef, field);
        } catch {
            throw new Error(`Neconyan cannot verify the pinned connection profile field /${field}.`);
        }
        if (actual !== expected) {
            throw new Error(`The pinned presets conflict with connection profile "${profile.name}": /${field} is "${actual}", not "${expected}".`);
        }
    }
}

/**
 * Applies one test case's pins. Throws when a pin cannot be honoured, so the
 * runner can record the case as unrunnable rather than measure the wrong thing.
 */
export async function applyCase(hostRef = getContext, pins = null, { signal = null, originalState = null } = {}) {
    const caveats = [];
    const switchesConversation = Boolean(pins?.characterAvatar)
        && getCharacterAvatar(hostRef) !== pins.characterAvatar;
    const originalPersona = originalState?.personaKey ?? String(ctxOf(hostRef)?.userAvatar ?? '');
    if (originalPersona === '' && (pins?.personaKey || switchesConversation)) {
        throw new Error('This test case may change the empty persona while switching conversations, but Neconyan cannot restore an exact empty persona through its supported APIs. Select a persona before running it.');
    }
    const modeProblem = presetModeProblem(hostRef, pins);
    if (modeProblem) {
        throw new Error(modeProblem);
    }
    const pinnedProfile = pins?.connectionProfileId
        ? resolveProfile(hostRef, pins.connectionProfileId)
        : null;
    if (pins?.connectionProfileId && !pinnedProfile) {
        throw new Error('This test case uses a connection profile that no longer exists. Choose a different profile for the test case.');
    }
    if (pinnedProfile) {
        originalState ??= await snapshotState(hostRef);
        const profileIsSelected = getSelectedProfileId(hostRef) === pinnedProfile.id;
        if ((profileIsSelected && !profileMatchesConnectionState(hostRef, pinnedProfile.id, originalState))
            || (!profileIsSelected && !canRestoreProfileOverride(hostRef, pinnedProfile.id, originalState))) {
            throw new Error('This test case changes connection settings that cannot be restored exactly from the live host state. Select a complete profile of the same completion mode first.');
        }
    }
    if (pins?.promptTags && originalState
        && (!originalState.promptTags
            || originalState.promptTags.valid === false
            || (!originalState.promptTags.profileId && !originalState.promptTags.profileName))) {
        throw new Error('This test case changes Prompt Tags, but its original global profile cannot be restored through the supported command.');
    }
    await applyCharacter(hostRef, pins?.characterAvatar, { signal });
    if (signal?.aborted) {
        return { caveats };
    }
    await applyPersona(hostRef, pins?.personaKey);
    await applyProfile(hostRef, pins?.connectionProfileId);
    const appliedModeProblem = presetModeProblem(hostRef, pins);
    if (appliedModeProblem) {
        throw new Error(appliedModeProblem);
    }
    const refs = presetRefs(pins);
    await applyPresets(hostRef, refs);
    if (pins?.connectionProfileId) {
        await verifyProfileFields(hostRef, pins.connectionProfileId, refs);
    }
    await applyPromptTagsProfile(hostRef, pins?.promptTags);
    return { caveats };
}

/* ---------------------------------------------------------------- restore */

function sameId(left, right) {
    return left !== undefined && left !== null
        && right !== undefined && right !== null
        && String(left) === String(right);
}

function hasConversation(context) {
    return (context?.groupId !== undefined && context?.groupId !== null && context?.groupId !== '')
        || (context?.characterId !== undefined && context?.characterId !== null)
        || Boolean(context?.chatId);
}

function groupForSnapshot(context, groupId) {
    return (Array.isArray(context?.groups) ? context.groups : [])
        .find(group => sameId(group?.id, groupId)) ?? null;
}

async function restoreConversation(hostRef, snapshot, problems) {
    const hasOriginalGroup = snapshot.groupId !== undefined
        && snapshot.groupId !== null
        && snapshot.groupId !== '';
    if (hasOriginalGroup) {
        const initial = ctxOf(hostRef);
        const group = groupForSnapshot(initial, snapshot.groupId);
        if (!group) {
            problems.push(`group: the original group (${snapshot.groupId}) is no longer available.`);
            return;
        }

        const targetChatId = String(snapshot.chatId ?? '');
        if (targetChatId) {
            const availableChats = Array.isArray(group.chats) ? group.chats : [];
            if (!availableChats.some(chatId => String(chatId) === targetChatId)) {
                problems.push(`group chat: chat "${targetChatId}" is no longer available in "${group.name}".`);
                return;
            }
        }

        let current = initial;
        if (!sameId(current.groupId, snapshot.groupId)) {
            let slashFailure = null;
            if (typeof current.executeSlashCommandsWithOptions === 'function') {
                try {
                    await current.executeSlashCommandsWithOptions(`/go ${quoteSlashArg(group.name)}`);
                } catch (error) {
                    slashFailure = `group: selecting "${group.name}" failed: ${error?.message ?? error}`;
                }
            } else {
                slashFailure = 'group: the host cannot select a group because its slash-command API is unavailable.';
            }

            current = ctxOf(hostRef);
            // /go resolves characters before groups. If a character has the
            // same name as the saved group, use the exact group API as a
            // recovery path instead of accepting the wrong conversation.
            if (!sameId(current.groupId, snapshot.groupId)
                && typeof current.openGroupChat === 'function') {
                try {
                    const opened = await current.openGroupChat(group.id, snapshot.chatId);
                    if (opened === false) {
                        slashFailure = `${slashFailure ?? 'group: opening the original group failed.'} The exact group chat was refused.`;
                    }
                } catch (error) {
                    slashFailure = `${slashFailure ?? 'group: opening the original group failed.'} The exact group chat failed: ${error?.message ?? error}`;
                }
            }

            current = ctxOf(hostRef);
            if (!sameId(current.groupId, snapshot.groupId)) {
                problems.push(slashFailure ?? `group: selecting "${group.name}" did not restore the original group.`);
                return;
            }
        }

        current = ctxOf(hostRef);
        if (!sameId(current.groupId, snapshot.groupId)) {
            problems.push(`group: selecting "${group.name}" did not restore the original group.`);
            return;
        }

        if (targetChatId) {
            if (String(current.chatId ?? '') !== targetChatId) {
                if (typeof current.openGroupChat !== 'function') {
                    problems.push('group chat: the host cannot reopen the original group chat because openGroupChat is unavailable.');
                    return;
                }
                try {
                    const opened = await current.openGroupChat(group.id, snapshot.chatId);
                    if (opened === false) {
                        problems.push(`group chat: opening "${targetChatId}" was refused.`);
                        return;
                    }
                } catch (error) {
                    problems.push(`group chat: opening "${targetChatId}" failed: ${error?.message ?? error}`);
                    return;
                }
            }
        }

        const verified = ctxOf(hostRef);
        if (!sameId(verified.groupId, snapshot.groupId)) {
            problems.push(`group: the restored conversation is not in "${group.name}".`);
        }
        if (String(verified.chatId ?? '') !== targetChatId) {
            problems.push(`group chat: the restored chat is "${verified.chatId ?? ''}", not "${targetChatId}".`);
        }
        return;
    }

    if (snapshot.characterAvatar) {
        let current = ctxOf(hostRef);
        const needsCharacter = getCharacterAvatar(hostRef) !== snapshot.characterAvatar
            || hasConversation(current) && (current.groupId !== undefined && current.groupId !== null && current.groupId !== '');
        if (needsCharacter) {
            const index = findCharacterIndex(hostRef, snapshot.characterAvatar);
            if (index < 0) {
                problems.push(`character: the original character (${snapshot.characterAvatar}) is no longer available.`);
                return;
            }
            if (typeof current.selectCharacterById !== 'function') {
                problems.push('character: the host cannot restore the original character because selectCharacterById is unavailable.');
                return;
            }
            try {
                const settled = waitForEvent(hostRef, current.eventTypes?.CHAT_CHANGED);
                const selected = await current.selectCharacterById(index, { switchMenu: false });
                if (selected === false) {
                    problems.push('character: Neconyan refused to restore the original character.');
                    return;
                }
                await settled;
                await delay(SETTLE_TICK_MS);
            } catch (error) {
                problems.push(`character: restoring "${snapshot.characterAvatar}" failed: ${error?.message ?? error}`);
                return;
            }
        }

        current = ctxOf(hostRef);
        if (getCharacterAvatar(hostRef) !== snapshot.characterAvatar
            || (current.groupId !== undefined && current.groupId !== null && current.groupId !== '')) {
            problems.push(`character: the restored conversation is not the original character (${snapshot.characterAvatar}).`);
            return;
        }

        const targetChatId = String(snapshot.chatId ?? '');
        if (targetChatId && String(current.chatId ?? '') !== targetChatId) {
            if (typeof current.openCharacterChat !== 'function') {
                problems.push('character chat: the host cannot reopen the original chat because openCharacterChat is unavailable.');
                return;
            }
            try {
                const opened = await current.openCharacterChat(snapshot.chatId);
                if (opened === false) {
                    problems.push(`character chat: opening "${targetChatId}" was refused.`);
                    return;
                }
            } catch (error) {
                problems.push(`character chat: opening "${targetChatId}" failed: ${error?.message ?? error}`);
                return;
            }
        }
        const verified = ctxOf(hostRef);
        if (getCharacterAvatar(hostRef) !== snapshot.characterAvatar) {
            problems.push(`character: the restored conversation is not the original character (${snapshot.characterAvatar}).`);
        }
        if (String(verified.chatId ?? '') !== targetChatId) {
            problems.push(`character chat: the restored chat is "${verified.chatId ?? ''}", not "${targetChatId}".`);
        }
        return;
    }

    const current = ctxOf(hostRef);
    if (typeof current.closeCurrentChat !== 'function') {
        problems.push('conversation: the host cannot close the current conversation because closeCurrentChat is unavailable.');
        return;
    }
    try {
        const closed = await current.closeCurrentChat();
        if (closed === false) {
            problems.push('conversation: the host refused to close the current conversation.');
            return;
        }
    } catch (error) {
        problems.push(`conversation: closing the current conversation failed: ${error?.message ?? error}`);
        return;
    }
    if (hasConversation(ctxOf(hostRef))) {
        problems.push('conversation: closing the current conversation did not leave an empty context.');
    }
}

async function restoreMainApi(hostRef, expected, problems) {
    if (String(ctxOf(hostRef)?.mainApi ?? '') === String(expected ?? '')) {
        return;
    }
    const select = globalThis.document?.querySelector?.('#main_api');
    if (!select) {
        problems.push(`main API: the current API is "${ctxOf(hostRef)?.mainApi ?? ''}", not "${expected ?? ''}", and the host exposes no supported setter.`);
        return;
    }
    select.value = String(expected ?? '');
    if (select.value !== String(expected ?? '')) {
        problems.push(`main API: "${expected ?? ''}" is no longer available.`);
        return;
    }
    const EventConstructor = select.ownerDocument?.defaultView?.Event ?? globalThis.Event;
    if (typeof select.dispatchEvent !== 'function' || typeof EventConstructor !== 'function') {
        problems.push('main API: the host API selector cannot dispatch a supported change event.');
        return;
    }
    const settled = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.MAIN_API_CHANGED);
    select.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    await settled;
    if (String(ctxOf(hostRef)?.mainApi ?? '') !== String(expected ?? '')) {
        problems.push(`main API: the restored API is "${ctxOf(hostRef)?.mainApi ?? ''}", not "${expected ?? ''}".`);
    }
}

async function restorePreset(hostRef, apiId, presetName, presetValue, hasValue, force = false) {
    const manager = ctxOf(hostRef)?.getPresetManager?.(normalizeApiId(hostRef, apiId));
    if (getPresetName(hostRef, apiId) === presetName) {
        if (!force) {
            return true;
        }
        if (!hasValue || typeof manager?.selectPreset !== 'function') {
            return false;
        }
        await manager.selectPreset(presetValue);
        return getPresetName(hostRef, apiId) === presetName;
    }
    if (presetName) {
        return selectPreset(hostRef, apiId, presetName);
    }
    if (!hasValue || typeof manager?.selectPreset !== 'function') {
        return false;
    }
    await manager.selectPreset(presetValue);
    return getPresetName(hostRef, apiId) === '';
}

async function restoreConnectionState(hostRef, snapshot, problems) {
    const state = snapshot?.connection;
    if (!state?.fields) {
        return;
    }
    const failed = new Set();
    for (const field of CONNECTION_COMMANDS[state.mode] ?? []) {
        if (failed.has(field) || !Object.hasOwn(state.fields, field)) {
            continue;
        }
        const expected = state.fields[field];
        try {
            if (await connectionField(hostRef, field) === expected) {
                continue;
            }
            if (!canWriteConnectionValue(field, expected, snapshot)) {
                problems.push(`connection /${field}: the original empty value cannot be restored through the host API.`);
                failed.add(field);
                continue;
            }
            await connectionField(hostRef, field, expected, true);
            const actual = await connectionField(hostRef, field);
            if (actual !== expected) {
                problems.push(`connection /${field}: the restored value is "${actual}", not "${expected}".`);
                failed.add(field);
            }
        } catch (error) {
            problems.push(`connection /${field}: ${error?.message ?? error}`);
            failed.add(field);
        }
    }

    // Later template commands can replace earlier linked settings, so verify
    // every captured field once more after the full sequence has settled.
    for (const [field, expected] of Object.entries(state.fields)) {
        if (failed.has(field)) {
            continue;
        }
        try {
            const actual = await connectionField(hostRef, field);
            if (actual !== expected) {
                problems.push(`connection /${field}: the final value is "${actual}", not "${expected}".`);
            }
        } catch (error) {
            problems.push(`connection /${field}: ${error?.message ?? error}`);
        }
    }
}

async function restorePromptTags(hostRef, snapshot, problems) {
    if (!snapshot) {
        return;
    }
    let current = readPromptTagsGlobalState(hostRef);
    if (!current) {
        problems.push('Prompt Tags: the extension is no longer available.');
        return;
    }
    try {
        if (current.profileId !== snapshot.profileId || current.profileName !== snapshot.profileName) {
            if (!snapshot.profileName && !snapshot.profileId) {
                problems.push('Prompt Tags: the original empty profile cannot be restored through the supported command.');
            } else {
                await runSlash(hostRef, `/prompttags-profile ${quoteSlashArg(snapshot.profileName || snapshot.profileId)}`);
            }
        }
        current = readPromptTagsGlobalState(hostRef);
        if (current?.enabled !== snapshot.enabled) {
            await runSlash(hostRef, `/prompttags ${snapshot.enabled ? 'on' : 'off'}`);
        }
    } catch (error) {
        problems.push(`Prompt Tags: ${error?.message ?? error}`);
        return;
    }
    current = readPromptTagsGlobalState(hostRef);
    if (!current
        || current.enabled !== snapshot.enabled
        || (snapshot.profileId
            ? current.profileId !== snapshot.profileId
            : current.profileName !== snapshot.profileName)) {
        problems.push('Prompt Tags: the original enabled state and profile were not restored.');
    }
}

/**
 * Puts the user's configuration back. Every step is guarded: a failure to
 * restore one thing must not stop the others from being restored.
 * Returns the list of things that could not be put back.
 */
export async function restoreState(hostRef = getContext, snapshot = null) {
    const problems = [];
    if (!snapshot) {
        return problems;
    }
    const profileChanged = getSelectedProfileId(hostRef) !== snapshot.profileId;

    // Restore the conversation first. Opening it can re-apply a chat-locked
    // persona or preset, so those settings are deliberately restored below.
    try {
        await restoreConversation(hostRef, snapshot, problems);
    } catch (error) {
        problems.push(`conversation: ${error?.message ?? error}`);
    }

    try {
        if (ctxOf(hostRef)?.userAvatar !== snapshot.personaKey) {
            if (!snapshot.personaKey) {
                problems.push('persona: the host cannot restore the original empty persona through its supported slash command.');
            } else if (typeof ctxOf(hostRef)?.executeSlashCommandsWithOptions !== 'function') {
                problems.push('persona: the host cannot restore the original persona because its slash-command API is unavailable.');
            } else {
                await runSlash(hostRef, `/persona-set mode=lookup ${quoteSlashArg(snapshot.personaKey)}`);
                if (ctxOf(hostRef)?.userAvatar !== snapshot.personaKey) {
                    problems.push(`persona: the restored persona is "${ctxOf(hostRef)?.userAvatar ?? ''}", not "${snapshot.personaKey}".`);
                }
            }
        }
    } catch (error) {
        problems.push(`persona: ${error?.message ?? error}`);
    }

    try {
        if (getSelectedProfileId(hostRef) !== snapshot.profileId) {
            const profile = snapshot.profileId ? resolveProfile(hostRef, snapshot.profileId) : null;
            if (snapshot.profileId && !profile) {
                problems.push(`connection profile: the original profile (${snapshot.profileId}) is no longer available.`);
            } else if (typeof ctxOf(hostRef)?.executeSlashCommandsWithOptions !== 'function') {
                problems.push('connection profile: the host cannot restore the original profile because its slash-command API is unavailable.');
            } else {
                const loaded = waitForEvent(hostRef, ctxOf(hostRef)?.eventTypes?.CONNECTION_PROFILE_LOADED);
                await runSlash(hostRef, `/profile await=true ${quoteSlashArg(profile?.name ?? NONE_PROFILE)}`);
                await loaded;
                if (getSelectedProfileId(hostRef) !== snapshot.profileId) {
                    problems.push(`connection profile: the restored profile is "${getSelectedProfileId(hostRef)}", not "${snapshot.profileId}".`);
                }
            }
        }
    } catch (error) {
        problems.push(`connection profile: ${error?.message ?? error}`);
    }

    try {
        await restoreMainApi(hostRef, snapshot.mainApi, problems);
    } catch (error) {
        problems.push(`main API: ${error?.message ?? error}`);
    }

    // Presets go last so nothing above can overwrite them.
    for (const [apiId, presetName] of Object.entries(snapshot.presets ?? {})) {
        try {
            const restored = await restorePreset(
                hostRef,
                apiId,
                presetName,
                snapshot.presetValues?.[apiId],
                Object.hasOwn(snapshot.presetValues ?? {}, apiId),
                profileChanged
                    && apiId === 'openai'
                    && snapshot.connection?.modelSamplingProfilesEnabled
                    && snapshot.presetDirty?.openai === false
                    && snapshot.presetRestorable?.openai,
            );
            if (!restored) {
                problems.push(presetName
                    ? `preset "${presetName}" (${apiId}) is no longer available.`
                    : `preset (${apiId}): the original empty selection could not be restored.`);
            }
        } catch (error) {
            problems.push(`preset "${presetName}" (${apiId}): ${error?.message ?? error}`);
        }
    }
    try {
        await restoreConnectionState(hostRef, snapshot, problems);
    } catch (error) {
        problems.push(`connection settings: ${error?.message ?? error}`);
    }

    for (const [apiId, presetName] of Object.entries(snapshot.presets ?? {})) {
        if (getPresetName(hostRef, apiId) !== presetName) {
            problems.push(`preset (${apiId}): the restored selection is "${getPresetName(hostRef, apiId)}", not "${presetName}".`);
        }
    }
    await restorePromptTags(hostRef, snapshot.promptTags, problems);

    // A dry run can leave the send buttons disabled if it exited early.
    try {
        ctxOf(hostRef)?.unblockGeneration?.();
    } catch {
        // Nothing to do; this is a courtesy call.
    }

    return problems;
}

/**
 * Asks the server whether a character already has a saved chat. Used only to
 * warn the user that running tests will create one. Any failure answers "no
 * warning", because a preflight notice is not worth blocking a run over.
 */
export async function willCreateChatFile(hostRef = getContext, avatar = '') {
    try {
        const context = ctxOf(hostRef);
        if (typeof globalThis.fetch !== 'function' || typeof context?.getRequestHeaders !== 'function') {
            return false;
        }
        const response = await globalThis.fetch('/api/characters/chats', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!response.ok) {
            return false;
        }
        const chats = await response.json();
        return chats?.error === true || (Array.isArray(chats) && chats.length === 0);
    } catch {
        return false;
    }
}
