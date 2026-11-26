/**
 * Stricter DOMPurify overrides for model replies shown in Conversation mode and Scratchpad.
 * Those surfaces sit inside the app chrome, so reply HTML may not carry style sheets, inline
 * styles that could cover the interface, form controls or SVG/MathML content.
 */
export const STRICT_REPLY_SANITIZER_OVERRIDES = Object.freeze({
    FORBID_TAGS: Object.freeze(['style', 'custom-style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math']),
    FORBID_ATTR: Object.freeze(['style', 'formaction', 'action']),
    // Encoded style sheets are dropped with their text instead of showing as stray characters.
    ADD_FORBID_CONTENTS: Object.freeze(['style', 'custom-style']),
});

/** DOMPurify may keep a reference to the arrays it receives, so every call gets fresh copies. */
export function strictReplySanitizerOverrides() {
    return {
        FORBID_TAGS: [...STRICT_REPLY_SANITIZER_OVERRIDES.FORBID_TAGS],
        FORBID_ATTR: [...STRICT_REPLY_SANITIZER_OVERRIDES.FORBID_ATTR],
        ADD_FORBID_CONTENTS: [...STRICT_REPLY_SANITIZER_OVERRIDES.ADD_FORBID_CONTENTS],
    };
}

const PORTRAIT_URL_ATTRIBUTES = Object.freeze(['src', 'srcset', 'href', 'poster', 'xlink:href']);

function isPortraitUrl(value) {
    return String(value || '').toLowerCase().includes('/thumbnail/portrait');
}

/**
 * The shared message formatter binds tracker portrait URLs to the character open in the main
 * chat. Conversation and Scratchpad replies belong to other characters, so those URLs would show
 * the wrong character's portrait; they are removed after rendering.
 * @param {ParentNode | null | undefined} root Rendered reply element
 * @returns {number} Number of attributes removed
 */
export function stripForeignPortraitUrls(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
        return 0;
    }
    let removed = 0;
    for (const element of root.querySelectorAll('*')) {
        for (const attribute of PORTRAIT_URL_ATTRIBUTES) {
            if (element.hasAttribute(attribute) && isPortraitUrl(element.getAttribute(attribute))) {
                element.removeAttribute(attribute);
                removed += 1;
            }
        }
    }
    return removed;
}
