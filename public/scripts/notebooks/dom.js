/**
 * Small DOM helpers for the Notes workspace. Every string goes in through
 * textContent or attributes, never through innerHTML.
 */
export function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key === 'dataset') Object.assign(element.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value') element.value = value;
        else if (key === 'checked') element.checked = Boolean(value);
        else if (key === 'disabled') element.disabled = Boolean(value);
        else element.setAttribute(key, value === true ? '' : String(value));
    }
    append(element, children);
    return element;
}

export function append(element, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
}

export function clear(element) {
    while (element?.firstChild) element.firstChild.remove();
    return element;
}

/**
 * With userText, the label and title are the user's own words (or were translated already), so the run-time localiser leaves the
 * whole button alone. A label may also be a node from userPhrase (user-text.js).
 */
export function button(label, onClick, { icon = '', className = '', title = '', pressed = null, disabled = false, userText = false } = {}) {
    const primaryClass = pressed || className.split(/\s+/).includes('notes-primary') ? ' menu_button_primary' : '';
    const element = h('button', {
        type: 'button',
        class: `menu_button notes-button ${className}${primaryClass}`.trim(),
        title: title || null,
        'data-i18n-ignore': userText ? '' : null,
        'aria-pressed': pressed === null ? null : String(Boolean(pressed)),
        disabled,
        onclick: onClick,
    });
    if (icon) element.append(h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
    if (label !== null && typeof label === 'object') element.append(h('span', {}, label));
    else if (label) element.append(h('span', { text: label }));
    if (!label && title) element.setAttribute('aria-label', title);
    return element;
}

export function setButtonPressed(element, pressed) {
    element.setAttribute('aria-pressed', String(Boolean(pressed)));
    element.classList.toggle('menu_button_primary', Boolean(pressed) || element.classList.contains('notes-primary'));
}

/** With userLabel, the label is the user's own text (a property name), so the run-time localiser leaves it alone. A hint may be a node from userPhrase. */
export function field(label, control, hint = '', { userLabel = false } = {}) {
    const id = control.id || `notes-field-${Math.random().toString(36).slice(2, 10)}`;
    control.id = id;
    return h('div', { class: 'notes-field' },
        h('label', { for: id, text: label, 'data-i18n-ignore': userLabel ? '' : null }),
        control,
        hint !== null && typeof hint === 'object' ? h('p', { class: 'notes-hint' }, hint) : hint ? h('p', { class: 'notes-hint', text: hint }) : null);
}

export function choiceRow(label, options, current, onChoose) {
    const row = h('div', { class: 'notes-choice-row', role: 'group', 'aria-label': label });
    for (const [value, text] of options) {
        row.append(button(text, () => onChoose(value), { pressed: value === current, className: 'notes-choice' }));
    }
    return h('div', { class: 'notes-choice-group' }, h('span', { class: 'notes-choice-label', text: label }), row);
}

export function formatTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

export function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}
