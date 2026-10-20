import { t } from './i18n.js';

/**
 * Whether an element has a rendered box, matching what checkVisibility() reports
 * by default. Safari before 17.4 has no checkVisibility; the layout boxes stand
 * in for it and still tell a shown header from one hidden by display: none.
 * @param {HTMLElement|null} element
 */
function hasRenderedBox(element) {
    return typeof element?.checkVisibility === 'function'
        ? element.checkVisibility()
        : Boolean(element?.getClientRects().length);
}

/** A display-only waiting label, owned by one stream rather than saved in chat. */
export class StreamingThinkingIndicator {
    /** @type {HTMLElement|null} */
    #element = null;

    /**
     * Show the fallback only while there is no visible output or reasoning header.
     * @param {HTMLElement|null} message The stream's current message element
     * @param {boolean} waiting Whether the stream is still waiting for output
     */
    update(message, waiting) {
        if (!waiting || !message || hasRenderedBox(message.querySelector('.mes_reasoning_details'))) {
            this.clear();
            return;
        }
        const text = message.querySelector('.mes_text');
        if (this.#element?.isConnected && this.#element.parentElement === text?.parentElement) return;
        this.clear();
        if (!text) return;
        const element = document.createElement('span');
        element.className = 'mes_reasoning_header neconyan-streaming-thinking';
        element.setAttribute('role', 'status');
        element.textContent = t`Thinking...`;
        text.before(element);
        this.#element = element;
    }

    /** Remove only this stream's label, even if another stream replaced it. */
    clear() {
        this.#element?.remove();
        this.#element = null;
    }
}
