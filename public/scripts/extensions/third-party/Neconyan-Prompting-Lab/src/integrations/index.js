import { readMacroEnhanced } from './macroenhanced.js';
import { readPromptTags } from './prompttags.js';

/**
 * Records what the neighbouring extensions were set to when a prompt was built.
 * These are recorded, never changed: a testing tool that rewrote a user's macro
 * definitions or chat state would be able to corrupt the very configuration it
 * is supposed to be checking.
 */
export async function collectIntegrations(hostRef) {
    const caveats = [];
    const promptTags = readPromptTags(hostRef);
    const macroEnhanced = readMacroEnhanced(hostRef);
    return {
        promptTags,
        macroEnhanced,
        profileName: promptTags?.profileName ?? '',
        caveats,
    };
}

export { readMacroEnhanced, readPromptTags };
