import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { ScratchpadError, normaliseSettings } from './store.js';

export const MAX_CONTEXT_SETUPS = 24;
export const MAX_CONTEXT_SETUP_NAME = 40;
const FILE_LIMIT = 4 * 1024 * 1024;

/**
 * Only choices that mean the same in every chat travel. Message picks, lorebook entry choices, shared notes,
 * per-assistant connections and round-table seats name things that belong to one chat or one session, so they stay behind.
 * The compare connection names an account-wide saved profile, so it travels; setups saved before it existed turn compare off.
 */
export const CONTEXT_SETUP_KEYS = Object.freeze(['depth', 'include', 'maxTokens', 'stream', 'webSearch', 'readLinks', 'prefill', 'partialPrefill', 'feedbackTone', 'compareConnection']);
/** Setups saved before these keys existed leave the session's own choice alone. */
const OPTIONAL_SETUP_KEYS = new Set(['feedbackTone']);

function contextSetupsFile(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'scratchpad', 'context-setups.json');
}

export function contextSetupSettings(input) {
    const settings = normaliseSettings(input);
    return Object.fromEntries(CONTEXT_SETUP_KEYS
        .filter(key => !OPTIONAL_SETUP_KEYS.has(key) || input?.[key] !== undefined)
        .map(key => [key, settings[key]]));
}

function normaliseContextSetups(input) {
    const invalid = () => new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_INVALID', 'Each saved setup needs a name and its Context choices.');
    if (!Array.isArray(input) || input.some(item => !item || typeof item.name !== 'string' || !item.settings || typeof item.settings !== 'object' || Array.isArray(item.settings))) {
        throw invalid();
    }
    if (input.length > MAX_CONTEXT_SETUPS) {
        throw new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_FULL', `You can save up to ${MAX_CONTEXT_SETUPS} setups.`);
    }
    const names = new Set();
    return input.map(item => {
        const name = item.name.replace(/\s+/g, ' ').trim();
        if (!name) throw invalid();
        if ([...name].length > MAX_CONTEXT_SETUP_NAME) {
            throw new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_INVALID', `Setup names must be no longer than ${MAX_CONTEXT_SETUP_NAME} characters.`);
        }
        const key = name.toLowerCase();
        if (names.has(key)) {
            throw new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_INVALID', 'Two saved setups cannot share a name.');
        }
        names.add(key);
        return { name, settings: contextSetupSettings(item.settings) };
    });
}

/** Account-wide, like the quick prompts: saved setups follow the account into every Scratchpad. */
export function readContextSetupsLocked(lease) {
    const file = readAuthoringFileLocked(lease, contextSetupsFile(lease), FILE_LIMIT);
    if (!file) return { version: 1, revision: 0, setups: [] };
    try {
        const input = JSON.parse(file.bytes.toString('utf8'));
        if (input?.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid setups.');
        return { version: 1, revision: input.revision, setups: normaliseContextSetups(input.setups) };
    } catch {
        throw new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_DAMAGED', 'The saved setups could not be read.', 500);
    }
}

export function updateContextSetupsLocked(lease, input, expectedRevision) {
    const previous = readContextSetupsLocked(lease);
    if (expectedRevision !== previous.revision) {
        throw new ScratchpadError('SCRATCHPAD_CONTEXT_SETUPS_CHANGED', 'Your saved setups changed elsewhere. Reopen Scratchpad to load the saved list, then try again.', 409);
    }
    const contextSetups = { version: 1, revision: previous.revision + 1, setups: normaliseContextSetups(input) };
    writeAuthoringFileLocked(lease, contextSetupsFile(lease), JSON.stringify(contextSetups), { limit: FILE_LIMIT });
    return contextSetups;
}
