import {
    MAX_INJECTION_DEPTH,
    animation_duration,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    this_chid,
} from '../script.js';
import { getGroupMembers, getSelectedGroupSpeakerAvatar, selected_group } from './group-chats.js';
import { extension_settings, getContext, saveMetadataDebounced } from './extensions.js';
import { getCharaFilename, debounce, delay, uuidv4 } from './utils.js';
import { POPUP_RESULT, Popup } from './popup.js';
import { DEFAULT_NOTE_PROFILE_ID, composeAuthorsNote, getActiveNoteProfileId, getNoteProfiles, getPersonaNoteEntry, isValidNotePosition } from './authors-note-profiles.js';
import { getTokenCountAsync } from './tokenizers.js';
import { debounce_timeout } from './constants.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from './slash-commands/SlashCommandArgument.js';
export { MODULE_NAME as NOTE_MODULE_NAME };
import { t } from './i18n.js';
import { macros, MacroCategory } from './macros/macro-system.js';
import { MacrosParser } from './macros.js';
import { power_user } from './power-user.js';

const MODULE_NAME = '2_floating_prompt'; // <= Deliberate, for sorting lower than memory

export var shouldWIAddPrompt = false;

export const metadata_keys = {
    prompt: 'note_prompt',
    interval: 'note_interval',
    depth: 'note_depth',
    position: 'note_position',
    role: 'note_role',
    chara: 'note_chara',
};

const chara_note_position = {
    replace: 0,
    before: 1,
    after: 2,
};

const DEFAULT_DEPTH = 4;
const DEFAULT_POSITION = 1;
const DEFAULT_INTERVAL = 1;
// script.js and this module import each other, so extension_prompt_roles is still in its temporal
// dead zone while this module body runs. The default role has to be read lazily, at call time.
const getDefaultRole = () => extension_prompt_roles.SYSTEM;

// Neconyan: resolving these at read time keeps a chat that never used an Author's Note out of
// chat_metadata. Stamping the defaults in on load dirtied every chat the moment it was opened, and
// there is no metadata-only write: saving chat metadata rewrites the entire chat file.
export function getAuthorsNotePrompt() {
    return chat_metadata[metadata_keys.prompt] ?? extension_settings.note?.default ?? '';
}

export function getAuthorsNoteInterval() {
    return chat_metadata[metadata_keys.interval] ?? extension_settings.note?.defaultInterval ?? DEFAULT_INTERVAL;
}

export function getAuthorsNotePosition() {
    return chat_metadata[metadata_keys.position] ?? extension_settings.note?.defaultPosition ?? DEFAULT_POSITION;
}

export function getAuthorsNoteDepth() {
    return chat_metadata[metadata_keys.depth] ?? extension_settings.note?.defaultDepth ?? DEFAULT_DEPTH;
}

export function getAuthorsNoteRole() {
    return chat_metadata[metadata_keys.role] ?? extension_settings.note?.defaultRole ?? getDefaultRole();
}

// Neconyan divergence: character and group Author's Notes use a fork-owned scoped store while preserving existing note settings.
function ensureCharacterNoteStore() {
    if (!extension_settings.note.chara) {
        extension_settings.note.chara = [];
    }

    return extension_settings.note.chara;
}

function getCharacterNoteKey(avatarId, groupId = '') {
    const avatarName = getCharaFilename(null, { manualAvatarKey: avatarId });
    if (!avatarName) {
        return null;
    }

    return groupId ? `group:${groupId}:${avatarName}` : `individual:${avatarName}`;
}

function getCharacterNoteByKey(noteKey) {
    if (!noteKey || !extension_settings.note.chara) {
        return null;
    }

    return extension_settings.note.chara.find((entry) => entry.name === noteKey) ?? null;
}

function getCharacterNoteByAvatar(avatarId, groupId = '') {
    const noteKey = getCharacterNoteKey(avatarId, groupId);
    const scopedNote = getCharacterNoteByKey(noteKey);
    if (scopedNote || groupId) {
        return scopedNote;
    }

    const legacyName = getCharaFilename(null, { manualAvatarKey: avatarId });
    return getCharacterNoteByKey(legacyName);
}

function getPersonaAvatar() {
    return getContext().userAvatar || '';
}

function normalizeNoteProfile(profile) {
    const position = Number(profile?.position);
    return {
        id: String(profile?.id || DEFAULT_NOTE_PROFILE_ID),
        name: String(profile?.name ?? '').trim() || t`Default`,
        prompt: String(profile?.prompt ?? ''),
        position: isValidNotePosition(position) ? position : chara_note_position.replace,
    };
}

/**
 * Profile fields for a character or persona note, with notes saved before profiles existed read as
 * one Default profile. `perPersona` fields only apply to character notes.
 */
function normalizeNoteProfiles(entry, { perPersona = false } = {}) {
    const profiles = getNoteProfiles(entry ?? {}).map(normalizeNoteProfile);
    const ids = new Set(profiles.map(profile => profile.id));
    const state = {
        profiles,
        activeProfile: ids.has(entry?.activeProfile) ? entry.activeProfile : profiles[0].id,
    };

    if (perPersona) {
        const saved = entry?.personaProfiles && typeof entry.personaProfiles === 'object' ? entry.personaProfiles : {};
        state.perPersona = Boolean(entry?.perPersona);
        state.personaProfiles = Object.fromEntries(Object.entries(saved).filter(([avatar, id]) => avatar && ids.has(id)));
    }

    return state;
}

function ensureNoteProfiles(entry, options) {
    return Object.assign(entry, normalizeNoteProfiles(entry, options));
}

function getNoteView(entry, options) {
    const state = normalizeNoteProfiles(entry, options);
    const activeId = getActiveNoteProfileId({ ...entry, ...state }, getPersonaAvatar());
    return { ...state, profile: state.profiles.find(profile => profile.id === activeId) ?? state.profiles[0] };
}

function getCurrentNoteProfile(entry) {
    const activeId = getActiveNoteProfileId(entry, getPersonaAvatar());
    return entry.profiles.find(profile => profile.id === activeId) ?? entry.profiles[0];
}

// The top-level prompt and position mirror the profile in use, for readers that predate profiles.
function syncNoteMirror(entry) {
    const profile = getCurrentNoteProfile(entry);
    entry.prompt = profile.prompt;
    entry.position = profile.position;
}

function normalizeCharacterNote(note, noteKey = '') {
    if (!note || typeof note !== 'object') {
        return null;
    }

    const normalized = {
        name: noteKey || note.name || '',
        useChara: Boolean(note.useChara),
        ...normalizeNoteProfiles(note, { perPersona: true }),
    };
    syncNoteMirror(normalized);
    return normalized;
}

function getLegacyGroupCharacterNote(groupId) {
    if (!groupId) {
        return null;
    }

    const avatars = [
        getSelectedGroupSpeakerAvatar(),
        ...getGroupMembers(groupId).map(character => character?.avatar),
    ].filter(Boolean);

    const groupNotes = avatars
        .map(avatarId => getCharacterNoteByAvatar(avatarId, groupId))
        .filter(note => note?.prompt || note?.useChara);

    return groupNotes[0] ?? null;
}

function getGroupChatCharacterNote({ migrate = false } = {}) {
    const context = getContext();
    if (!context.groupId) {
        return null;
    }

    const metadataNote = normalizeCharacterNote(chat_metadata[metadata_keys.chara], `group:${context.groupId}`);
    if (metadataNote) {
        chat_metadata[metadata_keys.chara] = metadataNote;
        return metadataNote;
    }

    const legacyNote = normalizeCharacterNote(getLegacyGroupCharacterNote(context.groupId), `group:${context.groupId}`);
    if (legacyNote && migrate) {
        chat_metadata[metadata_keys.chara] = legacyNote;
        saveMetadataDebounced();
    }

    return legacyNote;
}

function getEditableCharacterNoteAvatar() {
    const context = getContext();
    return context.characterId !== undefined ? context.characters[context.characterId]?.avatar || '' : '';
}

function getEditableCharacterNoteName() {
    const context = getContext();
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatarId = getEditableCharacterNoteAvatar();
    return avatarId ? getCharacterNoteKey(avatarId) : null;
}

function getEditableCharacterNote(options = {}) {
    const context = getContext();
    if (context.groupId) {
        return getGroupChatCharacterNote(options);
    }

    const note = getCharacterNoteByKey(getEditableCharacterNoteName());
    if (note) {
        return note;
    }

    const avatarId = getEditableCharacterNoteAvatar();
    return avatarId ? getCharacterNoteByAvatar(avatarId) : null;
}

function getActiveGroupCharacterNote(context) {
    if (!context.groupId) {
        return null;
    }

    return getGroupChatCharacterNote({ migrate: true });
}

function getWritableCharacterNote() {
    const context = getContext();
    const noteKey = getEditableCharacterNoteName();
    if (!noteKey) {
        return null;
    }

    if (context.groupId) {
        const groupNote = getGroupChatCharacterNote() ?? normalizeCharacterNote({ useChara: false }, noteKey);
        chat_metadata[metadata_keys.chara] = groupNote;
        return groupNote;
    }

    let note = getEditableCharacterNote();
    if (!note) {
        note = { name: noteKey, prompt: '', useChara: false, position: chara_note_position.replace };
        ensureCharacterNoteStore().push(note);
    } else if (note.name !== noteKey) {
        // Notes saved under the bare file name move to the individual key on their first edit.
        note.name = noteKey;
    }

    return ensureNoteProfiles(note, { perPersona: true });
}

function isUnusedNote(note, enabledKey) {
    return !note[enabledKey] && !note.perPersona && note.profiles.length === 1 && !note.profiles[0].prompt;
}

function commitCharacterNote(note) {
    syncNoteMirror(note);

    if (getContext().groupId) {
        chat_metadata[metadata_keys.chara] = note;
        saveMetadataDebounced();
        updateSettings({ saveExtensionSettings: false });
        return;
    }

    const store = ensureCharacterNoteStore();
    const index = store.indexOf(note);
    if (index >= 0 && isUnusedNote(note, 'useChara')) {
        store.splice(index, 1);
    }

    updateSettings();
}

function ensurePersonaNoteStore() {
    const store = extension_settings.note.persona;
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
        extension_settings.note.persona = {};
    }

    return extension_settings.note.persona;
}

function getPersonaNote() {
    return getPersonaNoteEntry(extension_settings.note?.persona, getPersonaAvatar());
}

function getWritablePersonaNote() {
    const avatar = getPersonaAvatar();
    if (!avatar) {
        return null;
    }

    const store = ensurePersonaNoteStore();
    if (!getPersonaNoteEntry(store, avatar)) {
        store[avatar] = { useNote: false, prompt: '', position: chara_note_position.replace };
    }

    return ensureNoteProfiles(store[avatar]);
}

function commitPersonaNote(note) {
    syncNoteMirror(note);

    const store = ensurePersonaNoteStore();
    const avatar = getPersonaAvatar();
    if (avatar && store[avatar] === note && isUnusedNote(note, 'useNote')) {
        delete store[avatar];
    }

    updateSettings();
}

/**
 * The character and persona note panels share their profile controls; these describe what differs.
 */
const noteSlots = {
    chara: {
        enabledKey: 'useChara',
        checkbox: '#extension_use_floating_chara',
        radioName: 'extension_floating_char_position',
        perPersona: true,
        getReadable: () => getEditableCharacterNote({ migrate: true }),
        getWritable: getWritableCharacterNote,
        commit: commitCharacterNote,
        canEdit: () => Boolean(getContext().groupId || getEditableCharacterNoteAvatar()),
        setTokenCounter: value => setCharaPromptTokenCounterDebounced(value),
    },
    persona: {
        enabledKey: 'useNote',
        checkbox: '#extension_use_floating_persona',
        radioName: 'extension_floating_persona_position',
        perPersona: false,
        getReadable: getPersonaNote,
        getWritable: getWritablePersonaNote,
        commit: commitPersonaNote,
        canEdit: () => Boolean(getPersonaAvatar()),
        setTokenCounter: value => setPersonaPromptTokenCounterDebounced(value),
    },
};

function getNotePart(slotName, entry) {
    const slot = noteSlots[slotName];
    if (!entry?.[slot.enabledKey]) {
        return { enabled: false, prompt: '', position: chara_note_position.replace };
    }

    const { profile } = getNoteView(entry, { perPersona: slot.perPersona });
    return { enabled: true, prompt: profile.prompt, position: profile.position };
}

function getActiveNotePrompt(slotName) {
    const entry = noteSlots[slotName].getReadable();
    return entry ? getNoteView(entry, { perPersona: noteSlots[slotName].perPersona }).profile.prompt : '';
}

function editNote(slotName, mutate) {
    const slot = noteSlots[slotName];
    const note = slot.getWritable();
    if (!note) {
        console.warn(`Author's Note: no ${slotName} is selected to save this note for.`);
        toastr.error(slotName === 'persona'
            ? t`Select a persona before editing the persona author's note.`
            : t`Something went wrong. Could not save character's author's note.`);
        return false;
    }

    mutate(note, getCurrentNoteProfile(note));
    slot.commit(note);
    return true;
}

function selectNoteProfile(note, profileId) {
    const persona = getPersonaAvatar();
    if (note.perPersona && persona) {
        note.personaProfiles[persona] = profileId;
    } else {
        note.activeProfile = profileId;
    }
}

function refreshNoteTokenCounter(slotName) {
    noteSlots[slotName].setTokenCounter(getActiveNotePrompt(slotName));
}

function onNotePromptInput(slotName, value) {
    noteSlots[slotName].setTokenCounter(value);
    editNote(slotName, (_note, profile) => {
        profile.prompt = value;
    });
}

function onNoteEnabledChanged(slotName, value) {
    editNote(slotName, (note) => {
        note[noteSlots[slotName].enabledKey] = value;
    });
}

function onNotePositionChanged(slotName, value) {
    editNote(slotName, (_note, profile) => {
        profile.position = Number(value);
    });
}

function onNoteProfileSelected(slotName, profileId) {
    editNote(slotName, (note) => {
        if (note.profiles.some(profile => profile.id === profileId)) {
            selectNoteProfile(note, profileId);
        }
    });
    refreshNoteTokenCounter(slotName);
}

function onCharaPerPersonaChanged(value) {
    editNote('chara', (note, profile) => {
        const persona = getPersonaAvatar();
        note.perPersona = value;
        if (value && persona) {
            note.personaProfiles[persona] = profile.id;
        } else if (!value) {
            // Keep showing the profile that was on screen when the persona link is switched off.
            note.activeProfile = profile.id;
        }
    });
}

async function onNewNoteProfile(slotName) {
    const slot = noteSlots[slotName];
    if (!slot.canEdit()) {
        return;
    }

    const current = getNoteView(slot.getReadable(), { perPersona: slot.perPersona });
    const name = await Popup.show.input(
        t`Save as a new profile`,
        t`Name the new profile. It starts as a copy of the one on screen.`,
        t`${current.profile.name} copy`,
    );
    if (!String(name ?? '').trim()) {
        return;
    }

    editNote(slotName, (note, profile) => {
        const created = { id: uuidv4(), name: String(name).trim(), prompt: profile.prompt, position: profile.position };
        note.profiles.push(created);
        selectNoteProfile(note, created.id);
    });
    refreshNoteTokenCounter(slotName);
}

async function onRenameNoteProfile(slotName) {
    const slot = noteSlots[slotName];
    if (!slot.canEdit()) {
        return;
    }

    const current = getNoteView(slot.getReadable(), { perPersona: slot.perPersona });
    const name = await Popup.show.input(t`Rename profile`, t`Enter a new name for this profile.`, current.profile.name);
    if (!String(name ?? '').trim()) {
        return;
    }

    editNote(slotName, (_note, profile) => {
        profile.name = String(name).trim();
    });
}

async function onDeleteNoteProfile(slotName) {
    const slot = noteSlots[slotName];
    if (!slot.canEdit()) {
        return;
    }

    const current = getNoteView(slot.getReadable(), { perPersona: slot.perPersona });
    if (current.profiles.length <= 1) {
        toastr.info(t`This is the only profile. Clear its text instead if you no longer need it.`);
        return;
    }

    const confirmed = await Popup.show.confirm(t`Delete profile`, t`Delete the profile "${current.profile.name}"? This cannot be undone.`);
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    editNote(slotName, (note, profile) => {
        note.profiles = note.profiles.filter(item => item.id !== profile.id);
        if (note.activeProfile === profile.id) {
            note.activeProfile = note.profiles[0].id;
        }
        for (const [avatar, id] of Object.entries(note.personaProfiles ?? {})) {
            if (id === profile.id) {
                delete note.personaProfiles[avatar];
            }
        }
    });
    refreshNoteTokenCounter(slotName);
}

function renderNoteSlot(slotName) {
    const slot = noteSlots[slotName];
    const canEdit = slot.canEdit();
    const entry = canEdit ? slot.getReadable() : null;
    const view = getNoteView(entry, { perPersona: slot.perPersona });
    const $select = $(`#extension_floating_${slotName}_profile`);
    const optionsChanged = $select.children('option').length !== view.profiles.length
        || view.profiles.some((profile, index) => {
            const option = $select.children('option').get(index);
            return option?.value !== profile.id || option?.textContent !== profile.name;
        });

    if (optionsChanged) {
        $select.empty();
        for (const profile of view.profiles) {
            $select.append(new Option(profile.name, profile.id));
        }
    }

    $select.val(view.profile.id);
    $(`#extension_floating_${slotName}`).val(canEdit ? view.profile.prompt : '');
    $(slot.checkbox).prop('checked', Boolean(entry?.[slot.enabledKey]));
    $(`input[name="${slot.radioName}"][value="${view.profile.position}"]`).prop('checked', true);
    if (slot.perPersona) {
        $('#extension_floating_chara_per_persona').prop('checked', Boolean(canEdit && view.perPersona));
    }
}

function setNoteSlotDisabled(slotName) {
    const slot = noteSlots[slotName];
    const disabled = !slot.canEdit();
    $(`#extension_floating_${slotName}, #extension_floating_${slotName}_profile, ${slot.checkbox}, input[name="${slot.radioName}"]`).prop('disabled', disabled);
    $(`[data-an-profile-slot="${slotName}"]`).toggleClass('disabled', disabled).attr('aria-disabled', String(disabled));
    if (slot.perPersona) {
        $('#extension_floating_chara_per_persona').prop('disabled', disabled);
    }
}

function onPersonaDeleted({ avatarId } = {}) {
    if (!avatarId) {
        return;
    }

    let changed = false;
    const personaStore = extension_settings.note.persona;
    if (getPersonaNoteEntry(personaStore, avatarId)) {
        delete personaStore[avatarId];
        changed = true;
    }
    for (const note of extension_settings.note.chara ?? []) {
        if (note?.personaProfiles && Object.hasOwn(note.personaProfiles, avatarId)) {
            delete note.personaProfiles[avatarId];
            changed = true;
        }
    }
    if (changed) {
        saveSettingsDebounced();
    }
}

function renderPersonaNoteLabel() {
    const avatar = getPersonaAvatar();
    const name = avatar ? power_user.personas?.[avatar] || avatar : '';
    $('#extension_floating_persona_name').text(name ? t`Saved for ${name}.` : t`Select a persona to use this note.`);
}

function setNoteTextCommand(_, text) {
    if (text) {
        $('#extension_floating_prompt').val(text).trigger('input');
        toastr.success(t`Author's Note text updated`);
    }
    return getAuthorsNotePrompt();
}

function setNoteDepthCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        $('#extension_floating_depth').val(Math.abs(value)).trigger('input');
        toastr.success(t`Author's Note depth updated`);
    }
    return getAuthorsNoteDepth();
}

function setNoteIntervalCommand(_, text) {
    if (text) {
        const value = Number(text);

        if (Number.isNaN(value)) {
            toastr.error(t`Not a valid number`);
            return;
        }

        $('#extension_floating_interval').val(Math.abs(value)).trigger('input');
        toastr.success(t`Author's Note frequency updated`);
    }
    return getAuthorsNoteInterval();
}

function setNotePositionCommand(_, text) {
    const validPositions = {
        'after': 0,
        'scenario': 0,
        'chat': 1,
        'before_scenario': 2,
        'before': 2,
    };

    if (text) {
        const position = validPositions[text?.trim()?.toLowerCase()];

        if (typeof position === 'undefined') {
            toastr.error(t`Not a valid position`);
            return;
        }

        $(`input[name="extension_floating_position"][value="${position}"]`).prop('checked', true).trigger('input');
        toastr.info(t`Author's Note position updated`);
    }
    return Object.keys(validPositions).find(key => validPositions[key] == getAuthorsNotePosition());
}

function setNoteRoleCommand(_, text) {
    const validRoles = {
        'system': 0,
        'user': 1,
        'assistant': 2,
    };

    if (text) {
        const role = validRoles[text?.trim()?.toLowerCase()];

        if (typeof role === 'undefined') {
            toastr.error(t`Not a valid role`);
            return;
        }

        $('#extension_floating_role').val(Math.abs(role)).trigger('input');
        toastr.info(t`Author's Note role updated`);
    }
    return Object.keys(validRoles).find(key => validRoles[key] == getAuthorsNoteRole());
}

function updateSettings({ saveExtensionSettings = true } = {}) {
    if (saveExtensionSettings) {
        saveSettingsDebounced();
    }
    loadSettings();
    setFloatingPrompt();
}

const setMainPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_prompt_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);
const setCharaPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_chara_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);
const setPersonaPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_persona_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);
const setDefaultPromptTokenCounterDebounced = debounce(async (value) => $('#extension_floating_default_token_counter').text(await getTokenCountAsync(value)), debounce_timeout.relaxed);

async function onExtensionFloatingPromptInput() {
    chat_metadata[metadata_keys.prompt] = $(this).val();
    setMainPromptTokenCounterDebounced(chat_metadata[metadata_keys.prompt]);
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingIntervalInput() {
    chat_metadata[metadata_keys.interval] = Number($(this).val());
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingDepthInput() {
    let value = Number($(this).val());

    if (value < 0) {
        value = Math.abs(value);
        $(this).val(value);
    }

    chat_metadata[metadata_keys.depth] = value;
    updateSettings();
    saveMetadataDebounced();
}

async function onExtensionFloatingPositionInput(e) {
    chat_metadata[metadata_keys.position] = Number(e.target.value);
    updateSettings();
    saveMetadataDebounced();
}

async function onDefaultPositionInput(e) {
    extension_settings.note.defaultPosition = Number(e.target.value);
    saveSettingsDebounced();
}

async function onDefaultDepthInput() {
    let value = Number($(this).val());

    if (value < 0) {
        value = Math.abs(value);
        $(this).val(value);
    }

    extension_settings.note.defaultDepth = value;
    saveSettingsDebounced();
}

async function onDefaultIntervalInput() {
    extension_settings.note.defaultInterval = Number($(this).val());
    saveSettingsDebounced();
}

function onExtensionFloatingRoleInput(e) {
    chat_metadata[metadata_keys.role] = Number(e.target.value);
    updateSettings();
    saveMetadataDebounced();
}

function onExtensionDefaultRoleInput(e) {
    extension_settings.note.defaultRole = Number(e.target.value);
    saveSettingsDebounced();
}

function onExtensionFloatingDefaultInput() {
    extension_settings.note.default = $(this).val();
    setDefaultPromptTokenCounterDebounced(extension_settings.note.default);
    updateSettings();
}

function loadSettings() {
    if (extension_settings.note.defaultPosition === undefined) {
        extension_settings.note.defaultPosition = DEFAULT_POSITION;
    }

    if (extension_settings.note.defaultDepth === undefined) {
        extension_settings.note.defaultDepth = DEFAULT_DEPTH;
    }

    if (extension_settings.note.defaultInterval === undefined) {
        extension_settings.note.defaultInterval = DEFAULT_INTERVAL;
    }

    if (extension_settings.note.defaultRole === undefined) {
        extension_settings.note.defaultRole = getDefaultRole();
    }

    $('#extension_floating_prompt').val(getAuthorsNotePrompt());
    $('#extension_floating_interval').val(getAuthorsNoteInterval());
    $('#extension_floating_allow_wi_scan').prop('checked', extension_settings.note.allowWIScan ?? false);
    $('#extension_floating_depth').val(getAuthorsNoteDepth());
    $('#extension_floating_role').val(getAuthorsNoteRole());
    $(`input[name="extension_floating_position"][value="${getAuthorsNotePosition()}"]`).prop('checked', true);

    renderNoteSlot('chara');
    renderNoteSlot('persona');
    renderPersonaNoteLabel();

    $('#extension_floating_default').val(extension_settings.note.default);
    $('#extension_default_depth').val(extension_settings.note.defaultDepth);
    $('#extension_default_interval').val(extension_settings.note.defaultInterval);
    $('#extension_default_role').val(extension_settings.note.defaultRole);
    $(`input[name="extension_default_position"][value="${extension_settings.note.defaultPosition}"]`).prop('checked', true);
}

export function setFloatingPrompt() {
    const context = getContext();
    if (!context.groupId && context.characterId === undefined) {
        console.debug('setFloatingPrompt: Not in a chat. Skipping.');
        shouldWIAddPrompt = false;
        return;
    }

    // take the count of messages
    let lastMessageNumber = Array.isArray(context.chat) && context.chat.length ? context.chat.filter(m => m.is_user).length : 0;

    console.debug(`
    setFloatingPrompt entered
    ------
    lastMessageNumber = ${lastMessageNumber}
    metadata_keys.interval = ${getAuthorsNoteInterval()}
    metadata_keys.position = ${getAuthorsNotePosition()}
    metadata_keys.depth = ${getAuthorsNoteDepth()}
    metadata_keys.role = ${getAuthorsNoteRole()}
    ------
    `);

    // interval 1 should be inserted no matter what
    if (getAuthorsNoteInterval() === 1) {
        lastMessageNumber = 1;
    }

    if (lastMessageNumber <= 0 || getAuthorsNoteInterval() <= 0) {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
        $('#extension_floating_counter').text('(disabled)');
        shouldWIAddPrompt = false;
        return;
    }

    const messagesTillInsertion = lastMessageNumber >= getAuthorsNoteInterval()
        ? (lastMessageNumber % getAuthorsNoteInterval())
        : (getAuthorsNoteInterval() - lastMessageNumber);
    const shouldAddPrompt = messagesTillInsertion == 0;
    shouldWIAddPrompt = shouldAddPrompt;

    let prompt = shouldAddPrompt ? $('#extension_floating_prompt').val() : '';
    if (shouldAddPrompt) {
        const charaNote = context.groupId ? getActiveGroupCharacterNote(context) : getEditableCharacterNote();
        prompt = composeAuthorsNote(prompt, [getNotePart('chara', charaNote), getNotePart('persona', getPersonaNote())]);
    }
    context.setExtensionPrompt(
        MODULE_NAME,
        String(prompt),
        getAuthorsNotePosition(),
        getAuthorsNoteDepth(),
        extension_settings.note.allowWIScan,
        getAuthorsNoteRole(),
    );
    $('#extension_floating_counter').text(shouldAddPrompt ? '0' : messagesTillInsertion);
}

function onANMenuItemClick() {
    if (!selected_group && this_chid === undefined) {
        toastr.warning(t`Select a character before trying to use Author's Note`, '', { timeOut: 5000 });
        return;
    }

    //show AN if it's hidden
    const $ANcontainer = $('#floatingPrompt');
    if ($ANcontainer.css('display') !== 'flex') {
        $ANcontainer.addClass('resizing');
        $ANcontainer.css('display', 'flex');
        $ANcontainer.css('opacity', 0.0);
        $ANcontainer.transition({
            opacity: 1.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $ANcontainer.removeClass('resizing');
        });

        //auto-open the main AN inline drawer
        if ($('#ANBlockToggle')
            .siblings('.inline-drawer-content')
            .css('display') !== 'block') {
            $ANcontainer.addClass('resizing');
            $('#ANBlockToggle').trigger('click');
        }
    } else {
        //hide AN if it's already displayed
        $ANcontainer.addClass('resizing');
        $ANcontainer.transition({
            opacity: 0.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $ANcontainer.removeClass('resizing');
        });
        setTimeout(function () {
            $ANcontainer.hide();
        }, animation_duration);
    }

    //duplicate options menu close handler from script.js
    //because this listener takes priority
    $('#options').stop().fadeOut(animation_duration);
}

async function onChatChanged() {
    loadSettings();
    setFloatingPrompt();
    setNoteSlotDisabled('chara');
    setNoteSlotDisabled('persona');

    const authorsNotePrompt = getAuthorsNotePrompt();
    const tokenCounter1 = authorsNotePrompt ? await getTokenCountAsync(authorsNotePrompt) : 0;
    $('#extension_floating_prompt_token_counter').text(tokenCounter1);

    const charaPrompt = getActiveNotePrompt('chara');
    $('#extension_floating_chara_token_counter').text(charaPrompt ? await getTokenCountAsync(charaPrompt) : 0);

    const personaPrompt = getActiveNotePrompt('persona');
    $('#extension_floating_persona_token_counter').text(personaPrompt ? await getTokenCountAsync(personaPrompt) : 0);

    const tokenCounter3 = extension_settings.note.default ? await getTokenCountAsync(extension_settings.note.default) : 0;
    $('#extension_floating_default_token_counter').text(tokenCounter3);
}

function onAllowWIScanCheckboxChanged() {
    extension_settings.note.allowWIScan = !!$(this).prop('checked');
    updateSettings();
}

/**
 * Inject author's note options and setup event listeners.
 */
// Inserts the extension first since it's statically imported
export function initAuthorsNote() {
    $('#extension_floating_prompt').on('input', onExtensionFloatingPromptInput);
    $('#extension_floating_interval').on('input', onExtensionFloatingIntervalInput);
    $('#extension_floating_depth').on('input', onExtensionFloatingDepthInput);
    for (const slotName of Object.keys(noteSlots)) {
        const slot = noteSlots[slotName];
        $(`#extension_floating_${slotName}`).on('input', function () { onNotePromptInput(slotName, String($(this).val() ?? '')); });
        $(slot.checkbox).on('input', function () { onNoteEnabledChanged(slotName, !!$(this).prop('checked')); });
        $(`input[name="${slot.radioName}"]`).on('change', function () { onNotePositionChanged(slotName, $(this).val()); });
        $(`#extension_floating_${slotName}_profile`).on('change', function () { onNoteProfileSelected(slotName, String($(this).val() ?? '')); });
    }
    $('#extension_floating_chara_per_persona').on('input', function () { onCharaPerPersonaChanged(!!$(this).prop('checked')); });
    $(document).on('click', '[data-an-profile-action]', function () {
        if ($(this).hasClass('disabled')) {
            return;
        }
        const slotName = String($(this).data('an-profile-slot'));
        const action = String($(this).data('an-profile-action'));
        if (!noteSlots[slotName]) {
            return;
        }
        if (action === 'new') {
            onNewNoteProfile(slotName);
        } else if (action === 'rename') {
            onRenameNoteProfile(slotName);
        } else if (action === 'delete') {
            onDeleteNoteProfile(slotName);
        }
    });
    $('#extension_floating_default').on('input', onExtensionFloatingDefaultInput);
    $('#extension_default_depth').on('input', onDefaultDepthInput);
    $('#extension_default_interval').on('input', onDefaultIntervalInput);
    $('#extension_floating_allow_wi_scan').on('input', onAllowWIScanCheckboxChanged);
    $('#extension_floating_role').on('input', onExtensionFloatingRoleInput);
    $('#extension_default_role').on('input', onExtensionDefaultRoleInput);
    $('input[name="extension_floating_position"]').on('change', onExtensionFloatingPositionInput);
    $('input[name="extension_default_position"]').on('change', onDefaultPositionInput);
    $('#ANClose').on('click', function () {
        $('#floatingPrompt').transition({
            opacity: 0,
            duration: animation_duration,
            easing: 'ease-in-out',
        });
        setTimeout(function () { $('#floatingPrompt').hide(); }, animation_duration);
    });
    $('#option_toggle_AN').on('click', onANMenuItemClick);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note',
        callback: setNoteTextCommand,
        returns: 'current author\'s note',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note for the currently selected chat if specified and returns the current note.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-depth',
        aliases: ['depth'],
        callback: setNoteDepthCommand,
        returns: 'current author\'s note depth',
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note depth for in-chat positioning if specified and returns the current depth.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-frequency',
        aliases: ['freq', 'note-freq'],
        callback: setNoteIntervalCommand,
        returns: 'current author\'s note insertion frequency',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'number', [ARGUMENT_TYPE.NUMBER], false,
            ),
        ],
        helpString: `
            <div>
                Sets an author's note insertion frequency if specified and returns the current frequency.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-position',
        callback: setNotePositionCommand,
        aliases: ['pos', 'note-pos'],
        returns: 'current author\'s note insertion position',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'position', [ARGUMENT_TYPE.STRING], false, false, null, ['before', 'after', 'chat'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note position if specified and returns the current position.
            </div>
        `,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'note-role',
        callback: setNoteRoleCommand,
        returns: 'current author\'s note chat insertion role',
        namedArgumentList: [],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'role', [ARGUMENT_TYPE.STRING], false, false, null, ['system', 'user', 'assistant'],
            ),
        ],
        helpString: `
            <div>
                Sets an author's note chat insertion role if specified and returns the current role.
            </div>
        `,
    }));
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GROUP_UPDATED, onChatChanged);
    eventSource.on(event_types.PERSONA_CHANGED, onChatChanged);
    eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);

    registerAuthorsNoteMacros();
}

function registerAuthorsNoteMacros() {
    if (power_user.experimental_macro_engine) {
        macros.register('authorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Author's Note`,
            handler: () => getAuthorsNotePrompt(),
        });
        macros.register('charAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Character Author's Note`,
            handler: () => getActiveNotePrompt('chara'),
        });
        macros.register('personaAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Persona Author's Note`,
            handler: () => getActiveNotePrompt('persona'),
        });
        macros.register('defaultAuthorsNote', {
            category: MacroCategory.PROMPTS,
            description: t`The contents of the Default Author's Note`,
            handler: () => extension_settings.note.default ?? '',
        });
    } else {
        // TODO: Remove this when the experimental macro engine is replacing the old macro engine
        MacrosParser.registerMacro('authorsNote',
            () => getAuthorsNotePrompt(),
            t`The contents of the Author's Note`,
        );
        MacrosParser.registerMacro('charAuthorsNote',
            () => getActiveNotePrompt('chara'),
            t`The contents of the Character Author's Note`,
        );
        MacrosParser.registerMacro('personaAuthorsNote',
            () => getActiveNotePrompt('persona'),
            t`The contents of the Persona Author's Note`,
        );
        MacrosParser.registerMacro('defaultAuthorsNote',
            () => extension_settings.note.default ?? '',
            t`The contents of the Default Author's Note`,
        );
    }
}
