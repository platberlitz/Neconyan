/**
 * An accessible tab row. Real buttons with `role="tab"` and our own classes:
 * never `.menu_button`, because the host accessibility observer rewrites the
 * role of those to plain `button`.
 */
import { el } from '../dom.js';

/**
 * @param {object} options
 * @param {{key: string, label: string, panel: HTMLElement}[]} options.tabs
 * @param {string} options.active
 * @param {(key: string, options: {focus: boolean}) => void} options.onChange
 * @param {string} [options.idPrefix]
 * @param {string} [options.label]
 */
export function createTabs({ tabs, active, onChange, idPrefix = 'me', label = 'Macro Enhanced sections' }) {
    const element = el('div', 'me-tabs');
    element.setAttribute('role', 'tablist');
    element.setAttribute('aria-label', label);

    const buttons = new Map();
    for (const tab of tabs) {
        const button = el('button', 'me-tab', tab.label);
        button.type = 'button';
        button.id = `${idPrefix}-tab-${tab.key}`;
        button.setAttribute('role', 'tab');
        button.dataset.meTab = tab.key;
        button.setAttribute('aria-controls', tab.panel.id);
        button.setAttribute('aria-selected', 'false');
        button.tabIndex = -1;
        button.addEventListener('click', () => select(tab.key, { focus: false }));
        button.addEventListener('keydown', event => onKeydown(event, tab.key));
        element.appendChild(button);
        buttons.set(tab.key, button);
    }

    let current = '';

    function focusButton(key) {
        const button = buttons.get(key);
        if (!button) {
            return;
        }
        for (const [candidateKey, candidate] of buttons) {
            candidate.tabIndex = candidateKey === key ? 0 : -1;
        }
        button.focus({ preventScroll: true });
    }

    function onKeydown(event, key) {
        const keys = tabs.map(tab => tab.key);
        const index = keys.indexOf(key);
        let next = null;
        if (event.key === 'ArrowRight') {
            next = keys[(index + 1) % keys.length];
        } else if (event.key === 'ArrowLeft') {
            next = keys[(index - 1 + keys.length) % keys.length];
        } else if (event.key === 'Home') {
            next = keys[0];
        } else if (event.key === 'End') {
            next = keys[keys.length - 1];
        }
        if (!next) {
            return;
        }
        event.preventDefault();
        select(next, { focus: true });
    }

    function select(key, { focus = false, notify = true } = {}) {
        const next = buttons.has(key) ? key : tabs[0]?.key;
        if (!next) {
            return;
        }
        current = next;
        for (const tab of tabs) {
            const selected = tab.key === next;
            const button = buttons.get(tab.key);
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = selected ? 0 : -1;
            button.classList.toggle('me-tab-selected', selected);
            tab.panel.hidden = !selected;
        }
        if (focus) {
            focusButton(next);
        }
        if (notify) {
            onChange?.(next, { focus });
        }
    }

    return {
        element,
        select,
        get active() {
            return current;
        },
        focusActive() {
            focusButton(current);
        },
    };
}
