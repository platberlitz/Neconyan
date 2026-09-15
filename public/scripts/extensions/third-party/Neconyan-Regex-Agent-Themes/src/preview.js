/**
 * Builds gallery previews by running a theme's real generated markup over the real sample
 * marker blocks, then through Neconyan's own message formatter.
 *
 * Going through `messageFormatting` matters: it applies the markdown pass, DOMPurify (which
 * renames every class to `custom-*`) and decodeStyleTags (which prefixes and rewrites
 * `<style>` selectors). A preview built any other way would not show what chat shows.
 *
 * Previews are injected into a host carrying the `mes_text` class for the same reason: the
 * message-content rules in style.css and the `.mes_text ` prefix baked into decoded style
 * blocks both depend on it.
 */

import { ARCHETYPES, SPECS } from './specs.js';
import { STOCK } from './stock.js';
import { SAMPLES, sampleFor } from './samples.js';
import { buildAgentScripts } from './build.js';
import { applyList } from './interpolate.js';
import { getContext } from './host.js';

/** One representative spec per previewable archetype, chosen for visual richness. */
export const PREVIEW_KEYS = Object.freeze({
    [ARCHETYPES.PANEL]: 'scene',
    [ARCHETYPES.PROFILE]: 'npc-major',
    [ARCHETYPES.SLOTS]: 'choices',
    [ARCHETYPES.STATCARD]: 'relationship',
    [ARCHETYPES.CHIP]: 'npc-ref',
    [ARCHETYPES.STREAM]: 'chatroom',
    [ARCHETYPES.TRANSCRIPT]: 'chat-only',
});

/** Reconstructs a live-shaped `regexScripts` array from the stock baseline. */
export function stockScriptsFor(templateId) {
    return STOCK.filter(entry => entry.templateId === templateId).map(entry => ({
        id: entry.scriptId,
        scriptName: entry.scriptName,
        findRegex: entry.findRegex,
        replaceString: entry.replaceString,
        trimStrings: [],
        placement: entry.placement,
        disabled: false,
        markdownOnly: entry.markdownOnly,
        promptOnly: entry.promptOnly,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: entry.minDepth,
        maxDepth: entry.maxDepth,
    }));
}

/**
 * Renders one archetype in one theme to an HTML string.
 * @returns {string} Sanitized HTML, or '' when there is nothing to show.
 */
export function renderPreviewHtml(archetype, theme, options = {}) {
    const key = PREVIEW_KEYS[archetype];
    const spec = SPECS.find(item => item.key === key);
    if (!spec || !SAMPLES[key]) {
        return '';
    }

    const stockScripts = stockScriptsFor(spec.templateId);
    const scripts = theme
        ? buildAgentScripts(spec.templateId, stockScripts, theme, options, 'preview').scripts
        : stockScripts;

    const context = getContext();
    const substitute = value => String(value).replaceAll('{{user}}', context?.name1 ?? 'You');
    const raw = applyList(sampleFor(spec), scripts, substitute);

    if (typeof context?.messageFormatting !== 'function') {
        return '';
    }
    return context.messageFormatting(raw, 'Preview', false, false, null);
}

/** Renders a preview into a host element, creating the `mes_text` wrapper it needs. */
export function mountPreview(hostElement, archetype, theme, options = {}) {
    const html = renderPreviewHtml(archetype, theme, options);
    hostElement.textContent = '';

    const surface = document.createElement('div');
    surface.className = 'mes_text';
    if (html) {
        surface.innerHTML = html;
    } else {
        const unavailable = document.createElement('p');
        unavailable.className = 'rat-preview-unavailable';
        unavailable.textContent = 'Preview unavailable until Neconyan formatting is ready.';
        surface.append(unavailable);
    }
    hostElement.append(surface);
    return surface;
}

/**
 * Detects the one host setting that silently breaks all tracker markup, stock included:
 * with `encode_tags` on, Neconyan escapes `<` in message text so the HTML never renders.
 */
export function detectEncodedTags() {
    const context = getContext();
    if (typeof context?.messageFormatting !== 'function') {
        return false;
    }
    const probe = context.messageFormatting('<div data-rat-probe="1">x</div>', 'Preview', false, false, null);
    return probe.includes('&lt;div');
}
