import { resolveConnectionProfile } from './extensions/in-chat-agents/agent-store.js';
import { isAbortLikeError } from './util/abort-error.js';
import { CUSTOM_CSS_AI_PALETTE_VARIABLES, buildCustomCssAIMessages as buildCustomCssMessages } from './neconyan-custom-css-core.js';

export { isAbortLikeError };

export {
    CUSTOM_CSS_AI_MAX_TOKENS,
    CUSTOM_CSS_AI_PALETTE_VARIABLES,
    CUSTOM_CSS_AI_SYSTEM_PROMPT,
    stripCssMarkdownFences,
    normalizeGeneratedCustomCss,
} from './neconyan-custom-css-core.js';

// Neconyan palettes are declared on body; reading only :root misses the active colours.
export function getCustomCssPaletteSnapshot(root = typeof document === 'undefined' ? null : (document.body || document.documentElement)) {
    if (!root || typeof getComputedStyle !== 'function') {
        return '';
    }

    const computedStyle = getComputedStyle(root);
    return CUSTOM_CSS_AI_PALETTE_VARIABLES
        .map(name => [name, String(computedStyle.getPropertyValue(name) ?? '').trim()])
        .filter(([, value]) => value)
        .map(([name, value]) => `${name}: ${value};`)
        .join('\n');
}

export function buildCustomCssAIMessages({ instruction = '', currentCss = '', paletteSnapshot = getCustomCssPaletteSnapshot(), mode = 'replace' } = {}) {
    return buildCustomCssMessages({ instruction, currentCss, paletteSnapshot, mode });
}

export function resolveCustomCssAIProfile(profileId = '') {
    return resolveConnectionProfile(profileId);
}

/**
 * Generate custom CSS as one retained server job. The server saves it into the account settings
 * only while the saved CSS still matches what was sent, so closing the page does not lose it.
 */
export async function generateCustomCssWithAI({
    instruction = '',
    profileId = '',
    mode = 'replace',
    signal = null,
    paletteSnapshot = getCustomCssPaletteSnapshot(),
    onProgress,
} = {}) {
    if (!String(instruction ?? '').trim()) {
        throw new Error('Instruction is required to generate custom CSS.');
    }
    const [{ getOperationClient }, core, { getCurrentUserHandle }] = await Promise.all([
        import('./operations-client.js'), import('../script.js'), import('./user.js')]);
    const account = getCurrentUserHandle();
    const client = await getOperationClient();
    const record = await client.run('custom-css', { instruction, paletteSnapshot, mode, profileId }, {
        scope: 'custom-css', signal, onProgress,
        prepareInput: async input => {
            if (!await core.saveSettings(0, { returnResult: true })) throw new Error('Save your settings before generating custom CSS.');
            return profileId ? input : { ...input, acknowledgement: core.getActiveGenerationAcknowledgement() };
        },
    });
    const result = record?.result ?? {};
    if (result.applied && account === getCurrentUserHandle()) {
        core.adoptServerSettingsWrite({ account, previousVersion: result.previousVersion, version: result.version, settingsRevision: result.settingsRevision });
    }
    return result;
}
