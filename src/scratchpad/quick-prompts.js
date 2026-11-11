import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease } from '../roleplay-store.js';
import { ScratchpadError } from './store.js';

export const MAX_QUICK_PROMPTS = 24;
export const MAX_QUICK_PROMPT_LABEL = 40;
export const MAX_QUICK_PROMPT_BYTES = 8000;
const FILE_LIMIT = 512 * 1024;

function quickPromptsFile(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'scratchpad', 'quick-prompts.json');
}

function normaliseQuickPrompts(input) {
    if (!Array.isArray(input) || input.some(item => !item || typeof item.label !== 'string' || typeof item.text !== 'string')) {
        throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_INVALID', 'Each quick prompt needs a name and the text it fills in.');
    }
    if (input.length > MAX_QUICK_PROMPTS) {
        throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_FULL', `You can save up to ${MAX_QUICK_PROMPTS} quick prompts.`);
    }
    return input.map(item => {
        const label = item.label.replace(/\s+/g, ' ').trim();
        if (!label || !item.text.trim()) {
            throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_INVALID', 'Each quick prompt needs a name and the text it fills in.');
        }
        if ([...label].length > MAX_QUICK_PROMPT_LABEL) {
            throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_INVALID', `Quick prompt names must be no longer than ${MAX_QUICK_PROMPT_LABEL} characters.`);
        }
        if (Buffer.byteLength(item.text, 'utf8') > MAX_QUICK_PROMPT_BYTES) {
            throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_TOO_LARGE', 'Quick prompt text must be no longer than 8,000 bytes.', 413);
        }
        return { label, text: item.text };
    });
}

/** Account-wide, like the global instructions: the saved prompts follow the account into every Scratchpad. */
export function readQuickPromptsLocked(lease) {
    const file = readAuthoringFileLocked(lease, quickPromptsFile(lease), FILE_LIMIT);
    if (!file) return { version: 1, revision: 0, prompts: [] };
    try {
        const input = JSON.parse(file.bytes.toString('utf8'));
        if (input?.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('Invalid quick prompts.');
        return { version: 1, revision: input.revision, prompts: normaliseQuickPrompts(input.prompts) };
    } catch {
        throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_DAMAGED', 'The saved quick prompts could not be read.', 500);
    }
}

export function updateQuickPromptsLocked(lease, input, expectedRevision) {
    const previous = readQuickPromptsLocked(lease);
    if (expectedRevision !== previous.revision) {
        throw new ScratchpadError('SCRATCHPAD_QUICK_PROMPTS_CHANGED', 'Your quick prompts changed elsewhere. Copy your edits, then reopen the editor to load the saved version.', 409);
    }
    const quickPrompts = { version: 1, revision: previous.revision + 1, prompts: normaliseQuickPrompts(input) };
    writeAuthoringFileLocked(lease, quickPromptsFile(lease), JSON.stringify(quickPrompts), { limit: FILE_LIMIT });
    return quickPrompts;
}
