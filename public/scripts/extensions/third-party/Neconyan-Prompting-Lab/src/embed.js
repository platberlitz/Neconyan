import { EMBED_KEY, EMBED_VERSION } from './constants.js';
import { ctxOf, getContext, requestJson } from './host.js';
import { migrateCase, newId, normalizeCase, validateAssertion } from './schema.js';

/**
 * Stores test cases inside a character card, so they travel with the card when
 * it is shared or exported.
 *
 * Definitions only. Results are never embedded: they would bloat the card, and
 * a captured prompt can contain chat text, persona details and lorebook content
 * that the person receiving the card should not be handed by accident.
 */

/** What a user is agreeing to when they save a test into a card. */
export const PRIVACY_NOTICE = 'These test cases will be saved inside the character card. Anyone you share the card with will receive them, including the example message and any text you are checking for. Saved runs are never included.';

export function findCharacterIndexByAvatar(hostRef, avatar) {
    const characters = ctxOf(hostRef)?.characters ?? [];
    return characters.findIndex(character => character?.avatar === avatar);
}

/** Reads the test cases stored in one character card. */
export function readEmbeddedCases(hostRef, avatar) {
    const context = ctxOf(hostRef);
    const index = findCharacterIndexByAvatar(hostRef, avatar);
    if (index < 0) {
        return [];
    }
    const stored = context?.characters?.[index]?.data?.extensions?.[EMBED_KEY];
    if (!stored || typeof stored !== 'object') {
        return [];
    }
    if (Number(stored.v) > EMBED_VERSION) {
        // Written by a newer version: leave it alone rather than mangle it.
        return [];
    }
    return (Array.isArray(stored.cases) ? stored.cases : [])
        .map(item => migrateCase(item))
        .filter(Boolean);
}

/**
 * Writes test cases into a character card.
 * Pass an empty list to remove them.
 */
export async function writeEmbeddedCases(hostRef, avatar, cases, { signal } = {}) {
    const context = ctxOf(hostRef);
    const index = findCharacterIndexByAvatar(hostRef, avatar);
    if (index < 0) {
        throw new Error('That character is not installed, so the tests could not be saved into its card.');
    }
    const character = context.characters[index];
    const stored = character?.data?.extensions?.[EMBED_KEY];
    if (stored && typeof stored === 'object' && Number(stored.v) > EMBED_VERSION) {
        throw new Error('That character contains Prompting Lab data from a newer version and cannot be changed until the extension is updated.');
    }
    const payload = {
        v: EMBED_VERSION,
        cases: cases.map(item => stripForEmbedding(item)),
    };
    await requestJson('/api/characters/merge-attributes', {
        avatar,
        data: { extensions: { [EMBED_KEY]: payload } },
    }, { signal });
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions[EMBED_KEY] = payload;
    if (character.json_data) {
        try {
            const jsonData = JSON.parse(character.json_data);
            if (jsonData && typeof jsonData === 'object' && !Array.isArray(jsonData)) {
                jsonData.data = jsonData.data && typeof jsonData.data === 'object' && !Array.isArray(jsonData.data)
                    ? jsonData.data
                    : {};
                jsonData.data.extensions = jsonData.data.extensions
                    && typeof jsonData.data.extensions === 'object'
                    && !Array.isArray(jsonData.data.extensions)
                    ? jsonData.data.extensions
                    : {};
                jsonData.data.extensions[EMBED_KEY] = payload;
                character.json_data = JSON.stringify(jsonData);
                if (Number(index) === Number(context.characterId)) {
                    const hidden = globalThis.document?.querySelector?.('#character_json_data');
                    if (hidden) {
                        hidden.value = character.json_data;
                    }
                }
            }
        } catch {
            // The server has the update; preserve malformed host JSON as-is.
        }
    }
    return payload;
}

/**
 * Trims a case down to what is worth carrying inside a card. The pinned
 * character is dropped: a card's own tests belong to that card, and the avatar
 * of the copy that receives them will be different anyway.
 */
export function stripForEmbedding(testCase) {
    const normalized = normalizeCase(testCase);
    return {
        v: normalized.v,
        id: normalized.id,
        name: normalized.name,
        notes: normalized.notes,
        tags: normalized.tags,
        userMessage: normalized.userMessage,
        assertions: normalized.assertions,
        pins: {
            ...normalized.pins,
            characterAvatar: '',
            // Connection profiles and personas are local to an installation, so
            // carrying them would only produce tests that cannot run. A Prompt
            // Tags profile id is local too; the profile name still means
            // something to a recipient who has a profile of the same name.
            connectionProfileId: '',
            personaKey: null,
            promptTags: normalized.pins.promptTags?.profileName
                ? { profileId: '', profileName: normalized.pins.promptTags.profileName }
                : null,
        },
    };
}

/**
 * Prepares embedded cases for use in this installation: they are given fresh
 * identifiers and pinned to the character they came from. A card is written by
 * someone else, so checks that the file-import path would refuse are dropped
 * here the same way.
 */
export function adoptEmbeddedCases(cases, avatar) {
    return cases.map(item => normalizeCase({
        ...item,
        id: newId(),
        assertions: (Array.isArray(item.assertions) ? item.assertions : [])
            .filter(assertion => validateAssertion(assertion).length === 0),
        pins: { ...item.pins, characterAvatar: avatar },
    }));
}

/** Rough size of what would be written into the card. */
export function embeddedSize(cases) {
    try {
        return JSON.stringify({ v: EMBED_VERSION, cases: cases.map(stripForEmbedding) }).length;
    } catch {
        return 0;
    }
}

/** Lists every installed character that carries embedded tests. */
export function findCharactersWithTests(hostRef = getContext) {
    const context = ctxOf(hostRef);
    const found = [];
    for (const character of context?.characters ?? []) {
        const stored = character?.data?.extensions?.[EMBED_KEY];
        const count = Array.isArray(stored?.cases) ? stored.cases.length : 0;
        if (count) {
            found.push({
                avatar: character.avatar,
                name: character.name ?? character.avatar,
                count,
            });
        }
    }
    return found;
}
