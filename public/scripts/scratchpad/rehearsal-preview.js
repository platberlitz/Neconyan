/**
 * Trying a proposed change in a rehearsal before it is saved. Everything here
 * works on copies of what Scratchpad already reads, so nothing touches the app
 * and the live character, lorebook, preset or chat stay exactly as saved.
 */
import { characterField, characterFieldName, readCharacterField } from './character-fields.js';
import { applyLorebookActivationFields } from './lorebook-fields.js';
import { parseEntry, parseField } from './proposals.js';
import { canRehearse, normaliseRehearsalLabel } from './rehearsal.js';

const STORY_MODES = Object.freeze(['roleplay', 'conversation']);
const ROLEPLAY_ONLY = Object.freeze(['roleplay']);

/** Which proposed changes can be tried first, and in which chat modes. */
export const TRYABLE_CHANGE_TYPES = Object.freeze({
    character: Object.freeze({
        modes: STORY_MODES,
        fields: Object.freeze(['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'alternate_greetings', 'creator_notes']),
    }),
    persona: Object.freeze({ modes: STORY_MODES, fields: Object.freeze(['name', 'description', 'title']) }),
    authors_note: Object.freeze({ modes: ROLEPLAY_ONLY }),
    lore: Object.freeze({ modes: STORY_MODES, actions: Object.freeze(['add', 'edit', 'delete']) }),
    preset: Object.freeze({ modes: ROLEPLAY_ONLY, actions: Object.freeze(['replace']) }),
    chat: Object.freeze({ modes: ROLEPLAY_ONLY, actions: Object.freeze(['edit', 'insert', 'hide', 'unhide', 'delete']) }),
});

export const UNSAVED_LORE_UID = 'unsaved';
export const UNSAVED_MESSAGE_REF = 'unsaved-insert';

/** The kind of tryable change a proposal is, or '' when it cannot be tried. */
export function rehearsalChangeKind(proposal) {
    if (!proposal || typeof proposal !== 'object') return '';
    switch (proposal.type) {
        case 'character':
            return proposal.action !== 'create' && TRYABLE_CHANGE_TYPES.character.fields.includes(characterFieldName(proposal.field)) ? 'character' : '';
        case 'persona':
            return proposal.action !== 'create' && TRYABLE_CHANGE_TYPES.persona.fields.includes(proposal.field) ? 'persona' : '';
        case 'authors-note':
            return 'authors_note';
        case 'lorebook':
            return TRYABLE_CHANGE_TYPES.lore.actions.includes(proposal.action) ? 'lore' : '';
        case 'preset':
            return TRYABLE_CHANGE_TYPES.preset.actions.includes(proposal.action) ? 'preset' : '';
        case 'chat':
            return TRYABLE_CHANGE_TYPES.chat.actions.includes(proposal.action) ? 'chat' : '';
        default:
            return '';
    }
}

/** True when this proposal can be rehearsed unsaved in this chat. */
export function canTryProposalInRehearsal(proposal, source) {
    if (!canRehearse(source)) return false;
    const kind = rehearsalChangeKind(proposal);
    return Boolean(kind) && TRYABLE_CHANGE_TYPES[kind].modes.includes(source.kind);
}

export function buildTryRehearsalRequest(label) {
    const clean = normaliseRehearsalLabel(label);
    return clean
        ? `Rehearse the next story reply using this unsaved change: ${clean}.`
        : 'Rehearse the next story reply using this unsaved change.';
}

function draftText(proposal, value, fallback) {
    return typeof value === 'string' ? value : String(fallback ?? '');
}

/** True when a character snapshot is the one this proposal names. */
export function characterMatchesProposal(person, proposal) {
    const wanted = String(proposal?.character ?? '').trim().toLowerCase();
    return Boolean(wanted) && String(person?.name ?? '').trim().toLowerCase() === wanted;
}

/** A copy of the character with the proposed field in place, as the card would read once saved. */
export function applyCharacterChangeToSnapshot(person, proposal, value) {
    if (rehearsalChangeKind(proposal) !== 'character' || !person || typeof person !== 'object') return person;
    const field = characterFieldName(proposal.field);
    const spec = characterField(field);
    let next;
    if (spec?.type === 'greetings') {
        const proposed = typeof value === 'string' ? parseField(field, value) : [...(Array.isArray(proposal.value) ? proposal.value : [])];
        next = proposal.action === 'append' ? [...readCharacterField(person, field), ...proposed] : proposed;
    } else {
        next = draftText(proposal, value, proposal.value);
    }
    const top = spec?.top;
    return {
        ...person,
        data: { ...(person.data && typeof person.data === 'object' ? person.data : {}), [field]: next },
        ...(top ? { [top]: next } : {}),
    };
}

/**
 * A copy of the persona snapshot ({ name, description, title, text }) with the
 * proposed base field in place. `text` is the description as the chat sends it,
 * which can carry chat-specific additions after the base description.
 */
export function applyPersonaChangeToSnapshot(persona, proposal, value) {
    if (rehearsalChangeKind(proposal) !== 'persona' || !persona || typeof persona !== 'object') return persona;
    const field = proposal.field;
    const next = draftText(proposal, value, proposal.value);
    const copy = { ...persona, [field]: field === 'name' ? next.trim() || String(persona.name ?? '') : next };
    if (field === 'description') {
        const text = String(persona.text ?? '');
        const base = String(persona.description ?? '');
        const at = base ? text.indexOf(base) : -1;
        if (at >= 0) copy.text = `${text.slice(0, at)}${next}${text.slice(at + base.length)}`;
        else copy.text = !base && text.trim() ? `${next}\n\n${text}` : next;
    }
    return copy;
}

export function applyAuthorsNoteChangeToSnapshot(noteText, proposal, value) {
    if (rehearsalChangeKind(proposal) !== 'authors_note') return noteText;
    return draftText(proposal, value, proposal.value);
}

/** The override key the unsaved entry or the edited entry is listed under. */
export function loreChangeKey(proposal) {
    return `${proposal?.book}::${proposal?.action === 'add' ? UNSAVED_LORE_UID : proposal?.uid}`;
}

function entryView(entry) {
    return {
        title: String(entry.comment ?? ''),
        keys: Array.isArray(entry.key) ? [...entry.key] : [],
        content: String(entry.content ?? ''),
        constant: Boolean(entry.constant),
    };
}

function assignEntryText(entry, parsed) {
    entry.comment = parsed.title;
    entry.key = [...parsed.keys];
    entry.content = parsed.content;
    entry.constant = parsed.constant;
    if (parsed.constant) entry.vectorized = false;
}

/**
 * Raw lorebook entries ({ world, uid, comment, key, content, constant, disable, ... })
 * with the proposal applied to copies. Entries hidden from agents are never
 * changed, revealed or removed.
 */
export function applyLoreChangeToEntries(entries, proposal, value) {
    const list = Array.isArray(entries) ? entries : [];
    if (rehearsalChangeKind(proposal) !== 'lore') return list;
    const book = String(proposal.book ?? '');
    const same = entry => String(entry?.world) === book && String(entry?.uid) === String(proposal.uid);
    if (proposal.action === 'add') {
        const draft = { title: String(proposal.title ?? ''), keys: Array.isArray(proposal.keys) ? [...proposal.keys] : [], content: String(proposal.content ?? ''), constant: Boolean(proposal.constant) };
        const entry = { uid: UNSAVED_LORE_UID, world: book, disable: false };
        applyLorebookActivationFields(entry, proposal);
        assignEntryText(entry, typeof value === 'string' ? parseEntry(value, draft) : draft);
        return [...list, entry];
    }
    const target = list.find(same);
    if (!target || target.agentBlacklisted) return list;
    if (proposal.action === 'delete') return list.filter(entry => entry !== target);
    const entry = { ...target, key: Array.isArray(target.key) ? [...target.key] : target.key };
    const textEdit = !target.disable && (Object.hasOwn(proposal, 'title') || Object.hasOwn(proposal, 'content'));
    applyLorebookActivationFields(entry, proposal);
    if (textEdit) {
        const current = entryView(target);
        const proposed = {
            title: proposal.title ?? current.title,
            keys: proposal.keys ?? current.keys,
            content: proposal.content ?? current.content,
            constant: proposal.constant ?? current.constant,
        };
        assignEntryText(entry, typeof value === 'string' ? parseEntry(value, proposed) : proposed);
    } else if (Object.hasOwn(proposal, 'title')) {
        entry.comment = proposal.title;
    }
    return list.map(item => item === target ? entry : item);
}

function textValue(value) {
    return String(value ?? '').trim();
}

function textPresetModules(modules, api, fields) {
    return modules.map(module => {
        if (api === 'sysprompt' && module.id === 'sysprompt') {
            const content = [textValue(fields.content), textValue(fields.post_history) ? `Post-history instructions:\n${textValue(fields.post_history)}` : ''].filter(Boolean).join('\n\n');
            return { ...module, content };
        }
        if (api === 'context' && module.id === 'context') return { ...module, content: textValue(fields.story_string) };
        return module;
    });
}

/** A copy of the preset snapshot from readCurrentPreset with the proposed module field in place. */
export function applyPresetChangeToSnapshot(preset, proposal, value) {
    if (rehearsalChangeKind(proposal) !== 'preset' || !preset || typeof preset !== 'object') return preset;
    const targets = Array.isArray(preset.targets) ? preset.targets : [];
    const target = targets.find(item => item?.api === proposal.api && item?.name === proposal.preset);
    if (!target) return preset;
    const modules = Array.isArray(preset.modules) ? preset.modules : [];
    const next = typeof proposal.value === 'string' ? draftText(proposal, value, proposal.value) : proposal.value;
    if (proposal.api !== 'openai') {
        if (!target.fields || !Object.hasOwn(target.fields, proposal.field)) return preset;
        const fields = { ...target.fields, [proposal.field]: String(next ?? '') };
        return {
            ...preset,
            modules: textPresetModules(modules, proposal.api, fields),
            targets: targets.map(item => item === target ? { ...target, fields } : item),
        };
    }
    const index = modules.findIndex(module => module?.id === proposal.module);
    if (index < 0) return preset;
    const module = { ...modules[index] };
    switch (proposal.field) {
        case 'content':
            if (module.marker) return preset;
            module.content = String(next ?? '');
            break;
        case 'name':
            module.name = textValue(next) || module.name;
            break;
        case 'role':
            if (module.marker) return preset;
            module.role = String(next ?? '');
            break;
        case 'enabled':
            module.enabled = next === true;
            break;
        case 'injection_depth':
            if (module.depth !== null && module.depth !== undefined) module.depth = Number(next);
            break;
        case 'injection_position':
            module.depth = Number(next) === 1 ? (module.depth ?? 4) : null;
            break;
        default:
            return preset;
    }
    return { ...preset, modules: modules.map((item, at) => at === index ? module : item) };
}

function renumber(list) {
    return list.map((item, number) => {
        if (item.number === number) return item;
        const copy = { ...item, number };
        if (Array.isArray(item.swipes)) copy.swipes = item.swipes.map(swipe => ({ ...swipe, number }));
        return copy;
    });
}

/**
 * Chat items from sourceMessages with the proposal applied to copies. Hidden
 * messages keep their hidden flag, so the usual Hidden switch still decides
 * whether they are shared.
 */
export function applyChatChangeToMessages(messages, proposal, value, { userName = 'User', characterName = 'Character' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (rehearsalChangeKind(proposal) !== 'chat') return list;
    if (proposal.action === 'insert') {
        const after = Number(proposal.after);
        if (!Number.isInteger(after) || after < -1 || after >= list.length) return list;
        const isUser = proposal.speaker === 'user';
        const item = {
            ref: UNSAVED_MESSAGE_REF,
            number: after + 1,
            name: String(proposal.name || (isUser ? userName : characterName)),
            text: draftText(proposal, value, proposal.text),
            hidden: false,
            isUser,
            swipes: [],
        };
        return renumber([...list.slice(0, after + 1), item, ...list.slice(after + 1)]);
    }
    const index = list.findIndex(item => item?.number === Number(proposal.message));
    if (index < 0) return list;
    const target = list[index];
    if (proposal.action === 'delete') return renumber(list.filter((_, at) => at !== index));
    let changed;
    if (proposal.action === 'edit') {
        const text = draftText(proposal, value, proposal.text);
        changed = { ...target, text };
        if (Array.isArray(target.swipes)) changed.swipes = target.swipes.map(swipe => swipe.current ? { ...swipe, text } : swipe);
    } else {
        const hidden = proposal.action === 'hide';
        changed = { ...target, hidden };
        if (Array.isArray(target.swipes)) changed.swipes = target.swipes.map(swipe => ({ ...swipe, hidden }));
    }
    return list.map((item, at) => at === index ? changed : item);
}

/** The chat item a rehearsal should keep in view: the rewritten or the added message. */
export function rehearsalMessageRef(messages, proposal) {
    if (rehearsalChangeKind(proposal) !== 'chat') return null;
    if (proposal.action === 'insert') return UNSAVED_MESSAGE_REF;
    if (proposal.action !== 'edit' && proposal.action !== 'unhide') return null;
    const item = (Array.isArray(messages) ? messages : []).find(entry => entry?.number === Number(proposal.message));
    return item ? item.ref : null;
}

/** The note that tells the model which change it is rehearsing. */
export function formatRehearsalChangeNote(label, target) {
    const lines = [
        '## Unsaved change under rehearsal',
        `Change: ${normaliseRehearsalLabel(label) || 'Proposed change'}`,
    ];
    if (target) lines.push(`Applies to: ${target}`);
    lines.push('The context below already shows this change in place. It has not been saved; rehearse the next story reply as if it were.');
    return lines.join('\n');
}
