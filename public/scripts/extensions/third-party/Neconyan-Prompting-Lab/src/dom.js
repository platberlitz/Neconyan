/**
 * Small DOM helpers with no imports, so they stay usable from every module and
 * from the browser fixture tests.
 */

export function element(tagName, {
    className = '',
    id = '',
    text = null,
    attributes = {},
} = {}) {
    const node = document.createElement(tagName);
    if (className) {
        node.className = className;
    }
    if (id) {
        node.id = id;
    }
    if (text !== null) {
        node.textContent = String(text);
    }
    for (const [name, value] of Object.entries(attributes)) {
        if (value !== null && value !== undefined) {
            node.setAttribute(name, String(value));
        }
    }
    return node;
}

export function replace(node, ...children) {
    node.replaceChildren(...children.filter(Boolean));
    return node;
}

export function button(label, onActivate, {
    className = 'menu_button sbpl-button',
    title = '',
    id = '',
} = {}) {
    const node = element('button', {
        className,
        id,
        text: label,
        attributes: {
            type: 'button',
            ...(title ? { title } : {}),
        },
    });
    if (typeof onActivate === 'function') {
        node.addEventListener('click', onActivate);
    }
    return node;
}

export function field(labelText, control, {
    className = 'sbpl-field',
    hint = '',
} = {}) {
    const wrapper = element('label', { className });
    wrapper.append(
        element('span', { className: 'sbpl-field-label', text: labelText }),
        control,
    );
    if (hint) {
        wrapper.append(element('span', { className: 'sbpl-field-hint', text: hint }));
    }
    return wrapper;
}

let promptFieldCount = 0;

/**
 * A text area wired into Neconyan's own editing helpers: macro suggestions
 * while typing and the large editor button the rest of the app uses.
 * @returns {{wrapper: HTMLElement, textarea: HTMLTextAreaElement}}
 */
export function promptField(labelText, {
    rows = 4,
    hint = '',
    macros = true,
    className = 'sbpl-field sbpl-prompt-field',
} = {}) {
    promptFieldCount += 1;
    const id = `sbpl-prompt-${promptFieldCount}`;
    const textarea = element('textarea', {
        className: 'text_pole sbpl-textarea',
        id,
        attributes: {
            rows: String(rows),
            ...(macros ? { 'data-macros': 'true', 'data-macros-autocomplete': 'always' } : {}),
        },
    });
    const label = element('label', { className: 'sbpl-field-label', attributes: { for: id } });
    label.textContent = labelText;
    const head = element('div', { className: 'sbpl-prompt-head' });
    const maximize = element('div', {
        className: 'editor_maximize sbpl-maximize',
        attributes: {
            'data-for': id,
            title: 'Open in a large editor',
            role: 'button',
            tabindex: '0',
            'aria-label': `Open ${labelText} in a large editor`,
        },
    });
    maximize.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            maximize.click();
        }
    });
    head.append(label, maximize);
    const wrapper = element('div', { className });
    wrapper.append(head, textarea);
    if (hint) {
        wrapper.append(element('span', { className: 'sbpl-field-hint', text: hint }));
    }
    return { wrapper, textarea };
}

/**
 * A destructive button that asks to be pressed twice. The first press arms it
 * and renames it; the second press within a few seconds runs the action. No
 * dialog, so it works the same with a keyboard, a screen reader, and touch.
 */
export function confirmButton(label, onConfirm, {
    className = 'menu_button sbpl-button',
    title = '',
    confirmLabel = 'Press again to confirm',
} = {}) {
    let armed = false;
    let timer = null;
    const node = button(label, async () => {
        if (node.disabled) {
            return;
        }
        if (armed) {
            armed = false;
            clearTimeout(timer);
            timer = null;
            node.textContent = label;
            node.disabled = true;
            try {
                await onConfirm();
            } catch (error) {
                node.textContent = `${label} failed: ${errorMessage(error)}`;
            } finally {
                node.disabled = false;
            }
            return;
        }
        armed = true;
        node.textContent = confirmLabel;
        timer = setTimeout(() => {
            armed = false;
            timer = null;
            if (node.isConnected) {
                node.textContent = label;
            }
        }, 5000);
    }, { className, title });
    return node;
}

export function statusRegion(text = '') {
    return element('p', {
        className: 'sbpl-status',
        text,
        attributes: {
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        },
    });
}

export function emptyState(title, body) {
    const wrapper = element('div', { className: 'sbpl-empty' });
    wrapper.append(
        element('p', { className: 'sbpl-empty-title', text: title }),
        element('p', { className: 'sbpl-empty-body', text: body }),
    );
    return wrapper;
}

export function errorMessage(error) {
    return String(error?.message ?? error ?? 'Unknown error');
}

export function formatTokens(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '0';
}
