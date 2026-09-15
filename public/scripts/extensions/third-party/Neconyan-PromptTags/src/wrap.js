export const CONTENT_PLACEHOLDER = '{{content}}';

// Macros in a wrapper template are substituted while the section body is held out of reach,
// so a {{char}} in the template resolves but the body is never substituted twice.
const CONTENT_SENTINEL = '\u0000__PROMPT_TAGS_CONTENT__\u0000';

const VALID_TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function isValidTagName(tag) {
    return VALID_TAG_NAME.test(String(tag ?? '').trim());
}

export function buildTemplate(tag) {
    return `<${tag}>\n${CONTENT_PLACEHOLDER}\n</${tag}>`;
}

/**
 * Resolves the wrapper template for a rule, or null when the rule cannot produce one.
 * @param {{enabled?: boolean, tag?: string, template?: string, advanced?: boolean}} rule
 * @returns {string|null}
 */
export function resolveTemplate(rule) {
    if (!rule?.enabled) {
        return null;
    }

    if (rule.advanced) {
        const template = String(rule.template ?? '');
        // A template without the placeholder would silently swallow the section.
        return template.includes(CONTENT_PLACEHOLDER) ? template : null;
    }

    const tag = String(rule.tag ?? '').trim();
    return isValidTagName(tag) ? buildTemplate(tag) : null;
}

/**
 * True when the content already sits inside the wrapper this rule would apply, so that
 * re-applying is a no-op rather than a nested double-wrap.
 */
export function isAlreadyWrapped(content, template) {
    const [prefix = '', suffix = ''] = template.split(CONTENT_PLACEHOLDER);
    const trimmed = content.trim();
    const head = prefix.trim();
    const tail = suffix.trim();

    if (!head && !tail) {
        return false;
    }

    return (!head || trimmed.startsWith(head)) && (!tail || trimmed.endsWith(tail));
}

/**
 * Wraps a single section's content.
 *
 * @param {string} content Section body, already macro-substituted by the caller.
 * @param {object} rule Rule for this section.
 * @param {{substitute?: (text: string) => string}} [options] `substitute` runs macros over the
 *        wrapper template only.
 * @returns {string} The wrapped content, or the original content when the rule does not apply.
 */
export function applyWrap(content, rule, options = {}) {
    const text = typeof content === 'string' ? content : '';

    // Blank sections are left alone so the prompt never contains an empty tag pair.
    if (!text.trim()) {
        return text;
    }

    const template = resolveTemplate(rule);
    if (!template) {
        return text;
    }

    if (isAlreadyWrapped(text, template)) {
        return text;
    }

    const held = template.split(CONTENT_PLACEHOLDER).join(CONTENT_SENTINEL);
    const substituted = typeof options.substitute === 'function' ? options.substitute(held) : held;

    return substituted.split(CONTENT_SENTINEL).join(text);
}
