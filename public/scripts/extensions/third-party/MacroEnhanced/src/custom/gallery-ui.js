/**
 * Template packs, import and export. Installed templates are ordinary custom
 * macros in the chosen scope, saved through the same validated path as the
 * editor. Counts and export buttons are rebuilt from live data.
 */
import { button, el } from '../dom.js';
import { TEMPLATE_PACKS } from '../templates/index.js';
import { exportPack, parsePack } from './pack.js';
import {
    SCOPE_CHARACTER,
    SCOPE_CHAT,
    SCOPE_GLOBAL,
    createDef,
    getAllCustomNames,
    getCharacterDefs,
    getChatDefs,
    getGlobalDefs,
    saveCharacterDefs,
    saveChatDefs,
    saveGlobalDefs,
    validateDef,
} from './store.js';
import { syncRegistrations } from './registrar.js';
import { renderMacroText } from '../ui/macro-text.js';
import { scopeAvailability, snapshotContext, validateScopeForSave } from './scopes.js';

const MAX_RENAME_SUFFIX = 9;

function defsForScope(scope) {
    if (scope === SCOPE_CHARACTER) {
        return getCharacterDefs();
    }
    return scope === SCOPE_CHAT ? getChatDefs() : getGlobalDefs();
}

async function persistScope(scope, defs) {
    if (scope === SCOPE_CHARACTER) {
        await saveCharacterDefs(defs);
    } else if (scope === SCOPE_CHAT) {
        saveChatDefs(defs);
    } else {
        saveGlobalDefs(defs);
    }
    syncRegistrations();
}

/**
 * Installs id-less macro partials into a scope, auto-renaming name collisions
 * with a numeric suffix. Other validation failures skip the macro with a message.
 *
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function installMacros(scope, partials) {
    const registry = SillyTavern.getContext().macros?.registry;
    const installed = [];
    const skipped = [];
    const nextDefs = [...defsForScope(scope)];

    for (const partial of partials) {
        let chosen = null;
        for (let suffix = 1; suffix <= MAX_RENAME_SUFFIX; suffix++) {
            const name = suffix === 1 ? partial.name : `${partial.name}-${suffix}`;
            const candidate = createDef({ ...partial, name, id: undefined });
            const errors = validateDef(candidate, { siblings: nextDefs, registry, customNames: getAllCustomNames() });
            if (!errors.length) {
                chosen = candidate;
                break;
            }
            if (!errors.some(error => error.includes('already'))) {
                skipped.push(`{{${partial.name}}}: ${errors.join(' ')}`);
                break;
            }
        }
        if (chosen) {
            nextDefs.push(chosen);
            installed.push(chosen.name);
        } else if (!skipped.some(message => message.startsWith(`{{${partial.name}}}`))) {
            skipped.push(`{{${partial.name}}}: no free name found (tried up to -${MAX_RENAME_SUFFIX}).`);
        }
    }

    if (installed.length) {
        await persistScope(scope, nextDefs);
    }
    return { installed, skipped };
}

/** The visible install summary. Parse problems from an import stay in it. */
export function formatInstallStatus({ installed, skipped }, scope, { problems = [] } = {}) {
    const parts = [...problems];
    if (installed.length) {
        parts.push(`Installed ${installed.map(name => `{{${name}}}`).join(', ')} (${scope}).`);
    }
    parts.push(...skipped);
    return parts.join(' ') || 'Nothing to install.';
}

function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {HTMLElement} container
 * @param {object} hooks
 * @param {() => void} [hooks.onInstalled]
 * @param {(text: string) => void} [hooks.announce]
 */
export function renderTemplateGallery(container, { onInstalled, announce } = {}) {
    container.replaceChildren();

    const scopeRow = el('label', 'me-field me-gallery-scope');
    scopeRow.appendChild(el('span', 'me-field-label', 'Add to'));
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'text_pole';
    scopeRow.appendChild(scopeSelect);
    container.appendChild(scopeRow);

    const status = el('p', 'me-gallery-status');
    const exportRow = el('div', 'me-export-row');
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.hidden = true;

    function setStatus(text) {
        status.textContent = text;
        if (text) {
            announce?.(text);
        }
    }

    function refreshScopeOptions() {
        const availability = scopeAvailability();
        const previous = scopeSelect.value;
        scopeSelect.replaceChildren();
        for (const scope of [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT]) {
            const option = document.createElement('option');
            option.value = scope;
            option.textContent = scope === SCOPE_GLOBAL ? 'Everywhere' : scope === SCOPE_CHARACTER ? 'This character' : 'This chat';
            const state = availability[scope];
            option.disabled = !state.available;
            if (!state.available) {
                option.textContent += ` (${state.reason})`;
            }
            scopeSelect.appendChild(option);
        }
        if ([SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT].includes(previous)
            && !scopeSelect.querySelector(`option[value="${previous}"]`)?.disabled) {
            scopeSelect.value = previous;
        }
    }

    async function runInstall(partials, { problems = [] } = {}) {
        const scope = scopeSelect.value;
        const snapshot = snapshotContext();
        const scopeProblem = validateScopeForSave({ scope, persistedScope: null, snapshot });
        if (scopeProblem) {
            setStatus(scopeProblem);
            refreshScopeOptions();
            return;
        }
        setStatus('Installing…');
        try {
            const result = await installMacros(scope, partials);
            setStatus(formatInstallStatus(result, scope, { problems }));
            onInstalled?.();
        } catch (error) {
            const suffix = problems.length ? ` ${problems.join(' ')}` : '';
            setStatus(`Installing failed: ${error?.message ?? error}.${suffix}`);
        }
    }

    for (const pack of TEMPLATE_PACKS) {
        const packBox = el('section', 'me-gallery-pack');
        const bodyId = `me-pack-${pack.id}`;
        const header = button('me-gallery-pack-header', '', () => toggle());
        header.setAttribute('aria-controls', bodyId);
        const marker = el('span', 'me-ref-marker', '▸');
        marker.setAttribute('aria-hidden', 'true');
        header.append(marker, el('span', 'me-gallery-pack-name', pack.name));
        const body = el('div', 'me-gallery-pack-body');
        body.id = bodyId;
        body.hidden = true;
        let open = false;
        function toggle() {
            open = !open;
            marker.textContent = open ? '▾' : '▸';
            header.setAttribute('aria-expanded', String(open));
            body.hidden = !open;
        }
        header.setAttribute('aria-expanded', 'false');
        packBox.append(header, body);

        body.appendChild(el('p', 'me-section-note', pack.description));
        body.appendChild(button('menu_button', 'Add all', () => runInstall(pack.macros)));
        for (const macro of pack.macros) {
            const card = el('article', 'me-gallery-card');
            const cardHead = el('div', 'me-gallery-card-head');
            const signature = `{{${macro.name}${(macro.args ?? []).filter(arg => !arg.optional).map(arg => `::${arg.name}`).join('')}}}`;
            cardHead.appendChild(renderMacroText(signature, { tag: 'span', className: 'me-mt me-gallery-signature' }));
            cardHead.appendChild(button('menu_button', 'Add', () => runInstall([macro])));
            card.appendChild(cardHead);
            card.appendChild(el('p', 'me-section-note', macro.description));
            const preview = el('details', 'me-gallery-preview');
            preview.appendChild(el('summary', 'me-gallery-preview-summary', 'Template'));
            const template = renderMacroText(macro.template, { tag: 'code', className: 'me-mt me-gallery-template' });
            preview.appendChild(template);
            card.appendChild(preview);
            body.appendChild(card);
        }
        container.appendChild(packBox);
    }

    container.appendChild(exportRow);
    container.appendChild(importInput);
    container.appendChild(status);

    function refreshExport() {
        exportRow.replaceChildren();
        for (const scope of [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT]) {
            const defs = defsForScope(scope);
            if (!defs.length) {
                continue;
            }
            const label = scope === SCOPE_GLOBAL ? 'Everywhere' : scope === SCOPE_CHARACTER ? 'This character' : 'This chat';
            exportRow.appendChild(button('menu_button', `Export ${label} (${defs.length})`, () => {
                const stamp = new Date().toISOString().slice(0, 10);
                downloadJson(`macro-enhanced-${scope}-${stamp}.json`, exportPack(defs, { exportedAt: new Date().toISOString() }));
            }));
        }
    }

    importInput.addEventListener('change', () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const { macros, problems } = parsePack(String(reader.result ?? ''));
            if (macros.length) {
                void runInstall(macros, { problems });
            } else {
                setStatus(problems.join(' ') || 'The pack is empty.');
            }
        };
        reader.onerror = () => setStatus('That file could not be read.');
        reader.readAsText(file);
    });

    refreshScopeOptions();
    refreshExport();

    return {
        refresh: () => {
            refreshScopeOptions();
            refreshExport();
        },
        openImport: () => importInput.click(),
    };
}
