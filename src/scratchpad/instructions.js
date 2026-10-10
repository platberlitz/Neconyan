import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { ASSISTANT_IDS, ScratchpadError } from './store.js';

export const MAX_USER_INSTRUCTIONS_BYTES = 64000;
const FILE_LIMIT = 512 * 1024;

function instructionsFile(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'scratchpad', 'global-instructions.json');
}

function normaliseInstructions(input) {
    if (!input || typeof input.text !== 'string' || !['all', 'selected'].includes(input.scope)
        || !Array.isArray(input.assistants) || input.assistants.length > ASSISTANT_IDS.length
        || input.assistants.some(id => !ASSISTANT_IDS.includes(id))) {
        throw new ScratchpadError('SCRATCHPAD_INSTRUCTIONS_INVALID', 'Choose all assistants or a selection of Miso, Taro and Nori.');
    }
    if (Buffer.byteLength(input.text, 'utf8') > MAX_USER_INSTRUCTIONS_BYTES) {
        throw new ScratchpadError('SCRATCHPAD_INSTRUCTIONS_TOO_LARGE', 'User instructions must be no longer than 64,000 bytes.', 413);
    }
    const assistants = ASSISTANT_IDS.filter(id => input.assistants.includes(id));
    if (input.scope === 'selected' && !assistants.length) {
        throw new ScratchpadError('SCRATCHPAD_INSTRUCTIONS_TARGET_REQUIRED', 'Choose at least one assistant.');
    }
    return { text: input.text, scope: input.scope, assistants };
}

/** Account-wide preferences, deliberately separate from chat/session exports. */
export function readInstructionsLocked(lease) {
    const file = readAuthoringFileLocked(lease, instructionsFile(lease), FILE_LIMIT);
    if (!file) return { version: 1, revision: 0, text: '', scope: 'all', assistants: [...ASSISTANT_IDS] };
    try {
        const input = JSON.parse(file.bytes.toString('utf8'));
        if (input?.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid instructions.');
        return { version: 1, revision: input.revision, ...normaliseInstructions(input) };
    } catch {
        throw new ScratchpadError('SCRATCHPAD_INSTRUCTIONS_DAMAGED', 'The saved user instructions could not be read.', 500);
    }
}

export function updateInstructionsLocked(lease, input, expectedRevision) {
    const previous = readInstructionsLocked(lease);
    if (expectedRevision !== previous.revision) {
        throw new ScratchpadError('SCRATCHPAD_INSTRUCTIONS_CHANGED', 'User instructions changed elsewhere. Copy your edits, then reopen the editor to load the saved version.', 409);
    }
    const instructions = { version: 1, revision: previous.revision + 1, ...normaliseInstructions(input) };
    writeAuthoringFileLocked(lease, instructionsFile(lease), JSON.stringify(instructions), { limit: FILE_LIMIT });
    return instructions;
}

export function instructionsForAssistant(instructions, assistant) {
    return instructions.scope === 'all' || instructions.assistants.includes(assistant) ? instructions.text : '';
}
