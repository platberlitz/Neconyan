import { EMBED_KEY, EMBED_VERSION } from './constants.js';
import { ctxOf, getContext } from './host.js';
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
    return readEmbeddedValue(context?.characters?.[index]?.data?.extensions?.[EMBED_KEY]);
}

export function readEmbeddedValue(stored) {
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
export function adoptEmbeddedCases(cases, avatar, regex) {
    return cases.map(item => normalizeCase({
        ...item,
        id: newId(),
        assertions: (Array.isArray(item.assertions) ? item.assertions : [])
            .filter(assertion => validateAssertion(assertion, regex).length === 0),
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
