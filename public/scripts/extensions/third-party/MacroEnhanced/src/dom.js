/**
 * Tiny DOM helpers shared by the UI modules. No Neconyan imports.
 */

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * A real `<button type="button">`, so Enter and Space work without a keyboard
 * shim. Host `.menu_button` classes are allowed on ordinary buttons; they are
 * never used on tabs or pressed-filter chips.
 *
 * @param {string} className
 * @param {string} text
 * @param {(event: Event) => void} onActivate
 */
export function button(className, text, onActivate) {
    const node = el('button', className, text);
    node.type = 'button';
    if (className.split(/\s+/).includes('menu_button')) {
        // a11y.js sets this on insertion too; setting it here keeps the legacy
        // `.me-pronoun-input` parent lookup working before the observer runs.
        node.setAttribute('role', 'button');
    }
    if (onActivate) {
        node.addEventListener('click', onActivate);
    }
    return node;
}

/**
 * A small "?" that opens the matching guide in the Reference tab. The caller
 * supplies the action so this module stays free of extension imports.
 *
 * @param {string} topicTitle - Named in the tooltip and to screen readers.
 * @param {(event: Event) => void} onActivate
 */
export function helpButton(topicTitle, onActivate) {
    const node = button('me-help-button', '?', onActivate);
    node.title = `Help: ${topicTitle}`;
    node.setAttribute('aria-label', `Help: ${topicTitle}`);
    return node;
}

/**
 * Announces polite status text through the app's single live region.
 * @param {string} text
 */
export function announce(text) {
    const live = document.querySelector('[data-me-live]');
    if (!live) {
        return;
    }
    live.textContent = '';
    requestAnimationFrame(() => {
        live.textContent = String(text ?? '');
    });
}

/**
 * Announces a failure through the app's single alert region.
 * @param {string} text
 */
export function announceError(text) {
    const alert = document.querySelector('[data-me-alert]');
    if (!alert) {
        return;
    }
    alert.textContent = '';
    requestAnimationFrame(() => {
        alert.textContent = String(text ?? '');
    });
}

/**
 * Copies text, falling back to the legacy path when the async clipboard is
 * unavailable (insecure origin, or permission denied).
 *
 * @param {string} text
 * @returns {Promise<boolean>} Whether the copy succeeded.
 */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Insecure origin or permission denied. Try the legacy path.
    }
    try {
        const scratch = document.createElement('textarea');
        scratch.value = text;
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        document.body.appendChild(scratch);
        scratch.select();
        const ok = document.execCommand('copy');
        scratch.remove();
        return ok;
    } catch {
        return false;
    }
}

/**
 * Briefly swaps a button's label to confirm an action, then puts it back.
 * Re-entrant: a second flash before the first expires still restores the
 * original text. Also announces the result politely.
 *
 * @param {HTMLElement} node
 * @param {string} text
 * @param {number} [revertMs]
 */
export function flashButtonText(node, text, revertMs = 1500) {
    if (node.dataset.flashTimer) {
        clearTimeout(Number(node.dataset.flashTimer));
    } else {
        node.dataset.originalText = node.textContent;
    }
    node.textContent = text;
    announce(text);
    node.dataset.flashTimer = String(setTimeout(() => {
        node.textContent = node.dataset.originalText ?? text;
        delete node.dataset.flashTimer;
        delete node.dataset.originalText;
    }, revertMs));
}
