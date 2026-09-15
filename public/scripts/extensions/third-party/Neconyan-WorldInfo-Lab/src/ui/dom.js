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

export function field(labelText, control, {
    className = 'sbwil-field',
    hint = '',
} = {}) {
    const wrapper = element('label', { className });
    const label = element('span', {
        className: 'sbwil-field-label',
        text: labelText,
    });
    wrapper.append(label, control);
    if (hint) {
        wrapper.append(element('span', {
            className: 'sbwil-field-hint',
            text: hint,
        }));
    }
    return wrapper;
}

export function statusRegion(text = '') {
    return element('p', {
        className: 'sbwil-status',
        text,
        attributes: {
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        },
    });
}

export function errorMessage(error) {
    return String(error?.message ?? error ?? 'Unknown error');
}

export function formatValue(value) {
    if (Array.isArray(value)) {
        return value.map(item => formatValue(item)).join(', ');
    }
    if (value && typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    if (typeof value === 'number' && !Number.isInteger(value)) {
        return value.toFixed(2);
    }
    return String(value ?? '');
}

export function humanize(value) {
    const text = String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}
