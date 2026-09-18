const renderedScopes = new WeakMap();
const contentSelector = '.ica--companion-body, .ica--tpanel-agent-body';

function controlKey(element) {
    const agent = element.closest('[data-agent-id]')?.dataset.agentId ?? '';
    const entry = element.closest('.ica--tpanel-history-entry')?.dataset.messageIndex ?? '';
    return JSON.stringify([agent, entry, element.tagName, element.dataset.role || element.dataset.action || element.classList[0] || '']);
}

/** Keep live form nodes: pending handlers still own the same inputs and buttons after a refresh. */
export function replaceCompanionView(root, html, isCurrent) {
    const element = root[0];
    if (!element?.querySelectorAll) {
        root.html(html);
        return;
    }

    const sameScope = renderedScopes.get(element)?.() === true;
    const controls = new Map();
    const expanded = new Map();
    const focused = element.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && controlKey(focused);
    const selection = focused && [focused.selectionStart, focused.selectionEnd];
    if (sameScope) {
        for (const control of element.querySelectorAll('input[data-role], textarea[data-role], [data-ica-busy]')) {
            if (!control.closest(contentSelector)) controls.set(controlKey(control), control);
        }
        for (const details of element.querySelectorAll('details')) {
            if (!details.closest(contentSelector)) expanded.set(controlKey(details), details.open);
        }
    }

    root.html(html);
    renderedScopes.set(element, isCurrent);
    if (!sameScope) return;
    for (const control of element.querySelectorAll('input[data-role], textarea[data-role], [data-action]')) {
        const previous = controls.get(controlKey(control));
        if (previous && !control.closest(contentSelector)) control.replaceWith(previous);
    }
    for (const details of element.querySelectorAll('details')) {
        const open = expanded.get(controlKey(details));
        if (open !== undefined && !details.closest(contentSelector)) details.open = open;
    }
    if (focusKey) {
        const next = [...element.querySelectorAll('input, textarea, button, summary, select')].find(control => controlKey(control) === focusKey);
        next?.focus({ preventScroll: true });
        if (Number.isInteger(selection?.[0]) && typeof next?.setSelectionRange === 'function') {
            next.setSelectionRange(...selection);
        }
    }
}

export async function runCompanionViewAction(button, action) {
    if (button?.disabled || button?.dataset?.icaBusy) return;
    if (button?.dataset) button.dataset.icaBusy = 'true';
    try {
        await action();
    } finally {
        if (button?.dataset) delete button.dataset.icaBusy;
    }
}
