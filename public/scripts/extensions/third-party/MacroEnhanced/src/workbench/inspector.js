import { el } from '../dom.js';

function renderVarsTable(title, vars) {
    const section = el('div', 'me-inspector-section');
    section.appendChild(el('div', 'me-inspector-title', title));

    const names = Object.keys(vars ?? {});
    if (!names.length) {
        section.appendChild(el('div', 'me-inspector-empty', 'None'));
        return section;
    }

    const table = el('table', 'me-inspector-table');
    for (const name of names.sort()) {
        const row = el('tr');
        row.appendChild(el('td', 'me-inspector-name', name));
        row.appendChild(el('td', 'me-inspector-value', String(vars[name])));
        table.appendChild(row);
    }
    section.appendChild(table);
    return section;
}

function describeChange({ before, after }) {
    if (after === undefined) {
        return `${before} → (deleted)`;
    }
    if (before === undefined) {
        return `(new) → ${after}`;
    }
    return `${before} → ${after}`;
}

function renderChanges(pending) {
    const section = el('div', 'me-inspector-section');
    section.appendChild(el('div', 'me-inspector-title', 'Pending changes (not saved)'));

    const chatChanges = pending.chat ?? new Map();
    const total = pending.local.size + pending.global.size + chatChanges.size;
    if (!total) {
        section.appendChild(el('div', 'me-inspector-empty', 'The previewed text would not change any variables or frozen values.'));
        return section;
    }

    const table = el('table', 'me-inspector-table');
    const addRows = (changes, scopeLabel) => {
        for (const [name, change] of changes) {
            const row = el('tr');
            row.appendChild(el('td', 'me-inspector-scope', scopeLabel));
            row.appendChild(el('td', 'me-inspector-name', name));
            row.appendChild(el('td', 'me-inspector-value', describeChange(change)));
            table.appendChild(row);
        }
    };
    addRows(pending.local, 'chat');
    addRows(pending.global, 'global');
    addRows(chatChanges, 'state');
    section.appendChild(table);
    return section;
}

/**
 * Renders the variables inspector into the given container.
 *
 * @param {HTMLElement} container
 * @param {object} data
 * @param {object} data.localVars - Real chat-scoped variables.
 * @param {object} data.globalVars - Real global variables.
 * @param {{local: Map, global: Map}} data.pending - Sandbox pending changes.
 * @param {string[]} data.unshadowed - Variable macros the sandbox cannot intercept.
 */
export function renderInspector(container, { localVars, globalVars, pending, unshadowed }) {
    container.innerHTML = '';
    container.appendChild(renderChanges(pending));
    container.appendChild(renderVarsTable('Chat variables', localVars));
    container.appendChild(renderVarsTable('Global variables', globalVars));

    if (unshadowed.length) {
        const warning = el('div', 'me-inspector-warning');
        warning.textContent = `Not sandboxed (changes here are real): ${unshadowed.join(', ')}`;
        container.appendChild(warning);
    }
}
