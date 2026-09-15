import { generateRaw } from '../script.js';
import { resolveConnectionProfile } from './extensions/in-chat-agents/agent-store.js';
import { extractProfileResponseText } from './extensions/in-chat-agents/llm-utils.js';
import { getConnectionManagerRequestService } from './extensions/in-chat-agents/profile-utils.js';
import { isAbortLikeError } from './util/abort-error.js';

export { isAbortLikeError };

export const CUSTOM_CSS_AI_MAX_TOKENS = 3072;

export const CUSTOM_CSS_AI_PALETTE_VARIABLES = Object.freeze([
    '--neco-canvas',
    '--neco-surface',
    '--neco-raised',
    '--neco-ink',
    '--neco-muted',
    '--neco-ginger',
    '--neco-ginger-hover',
    '--neco-border',
    '--neco-user',
    '--neco-on-accent',
    '--neco-cream',
    '--neco-charcoal',
    '--neco-panel-gradient',
    '--neco-action-gradient',
    '--mainFontFamily',
    '--mainFontSize',
    '--sb-radius-button',
    '--sb-radius-md',
    '--sb-radius-lg',
    '--sb-message-radius',
    '--SmartThemeBodyColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBorderColor',
]);

export const CUSTOM_CSS_AI_SYSTEM_PROMPT = [
    'You are a CSS specialist for Neconyan, a SillyTavern fork with a warm paper-and-ginger "calico cat" design.',
    'Generate custom CSS for the Custom CSS editor.',
    'Output ONLY raw CSS. Do not include markdown fences, prose, HTML, <style> tags, JavaScript, @import, or external URLs.',
    'Style with the theme tokens instead of hard-coded colours so both Calico tones keep working: --neco-canvas (page background), --neco-surface (panels and cards), --neco-raised (hover surfaces), --neco-ink (primary text), --neco-muted (secondary text), --neco-ginger (accent), --neco-ginger-hover, --neco-border, --neco-user (user bubble tint), --neco-on-accent (text on the accent), --neco-panel-gradient and --neco-action-gradient (translucent panel/button fills).',
    'Radii: --sb-radius-button is 6px, --sb-radius-md 8px, --sb-radius-lg 10px, --sb-message-radius 8px; the look is soft and rounded. Fonts: --mainFontFamily is Nunito for body text with Fredoka One reserved for headings and brand slots, sized by --mainFontSize.',
    'Structure hooks: body.neconyan is always set (body.sbterm means the Terminal UI theme is active and expects plain monochrome styling); chat messages are #chat .mes with text in .mes_text; the shell is #top-bar, #sheld, #form_sheld and the slide-in sheets #left-nav-panel / #right-nav-panel; Conversation mode marks #sheld[data-sb-conversation-mode="on"] and its styles live in css/neconyan-conversation.css, which loads after the core sheets, so overriding it needs higher specificity.',
    'Keep desktop and mobile usable, scope risky changes narrowly, and never break touch targets on phones. Short CSS comments are allowed only when they clarify non-obvious rules.',
].join(' ');

export function stripCssMarkdownFences(text = '') {
    const value = String(text ?? '').trim();
    const fencedBlock = value.match(/```(?:css)?\s*([\s\S]*?)```/i);
    if (fencedBlock) {
        return fencedBlock[1].trim();
    }

    return value
        .replace(/^```(?:css)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

export function normalizeGeneratedCustomCss(text = '') {
    return stripCssMarkdownFences(text)
        .replace(/^<style[^>]*>/i, '')
        .replace(/<\/style>$/i, '')
        .trim();
}

export function getCustomCssPaletteSnapshot(root = typeof document === 'undefined' ? null : document.documentElement) {
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

export function buildCustomCssAIMessages({ instruction = '', currentCss = '', paletteSnapshot = getCustomCssPaletteSnapshot() } = {}) {
    const request = String(instruction ?? '').trim();
    const current = String(currentCss ?? '').trim();
    const palette = String(paletteSnapshot ?? '').trim();

    const userContent = [
        `Request:\n${request}`,
        `Current custom CSS:\n${current || '/* No custom CSS is currently set. */'}`,
        palette ? `Current theme CSS variables:\n${palette}` : '',
        'Return CSS that can be pasted directly into the Custom CSS textarea.',
    ].filter(Boolean).join('\n\n');

    return [
        { role: 'system', content: CUSTOM_CSS_AI_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];
}

export function resolveCustomCssAIProfile(profileId = '') {
    return resolveConnectionProfile(profileId);
}

export async function generateCustomCssWithAI({
    instruction = '',
    currentCss = '',
    profileId = '',
    maxTokens = CUSTOM_CSS_AI_MAX_TOKENS,
    signal = null,
    paletteSnapshot = getCustomCssPaletteSnapshot(),
} = {}) {
    if (!String(instruction ?? '').trim()) {
        throw new Error('Instruction is required to generate custom CSS.');
    }

    const messages = buildCustomCssAIMessages({ instruction, currentCss, paletteSnapshot });
    const resolvedProfileId = resolveCustomCssAIProfile(profileId);
    const CMRS = getConnectionManagerRequestService();

    if (resolvedProfileId && CMRS && typeof CMRS.sendRequest === 'function') {
        try {
            const response = await CMRS.sendRequest(resolvedProfileId, messages, maxTokens, {
                extractData: true,
                includePreset: true,
                includeInstruct: true,
                stream: false,
                signal,
            });
            const profileText = typeof response === 'string' ? response : extractProfileResponseText(response);
            const css = normalizeGeneratedCustomCss(profileText);
            if (css) {
                return css;
            }
        } catch (error) {
            if (isAbortLikeError(error, signal)) {
                throw error;
            }
            console.warn(`[CustomCssAI] Profile "${resolvedProfileId}" request failed, falling back to the main model.`, error);
        }
    }

    const fallbackText = await generateRaw({
        prompt: messages,
        responseLength: maxTokens,
        trimNames: false,
        signal,
        cacheScope: 'auxiliary',
    });
    return normalizeGeneratedCustomCss(fallbackText);
}
