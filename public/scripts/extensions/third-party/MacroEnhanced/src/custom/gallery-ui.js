/**
 * The template gallery and pack import/export UI in the settings drawer.
 * Installed templates become ordinary editable custom macros in the chosen
 * scope, going through the same validation and save path as the editor.
 */
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
import { exportPack, parsePack } from './pack.js';
import { TEMPLATE_PACKS } from '../templates/index.js';
import { button, el } from '../dom.js';

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
 * with a numeric suffix (mood -> mood-2). Non-collision validation failures skip
 * the macro with a message.
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

function describeInstall({ installed, skipped }, scope) {
    const parts = [];
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
 * Renders the gallery + import/export into the drawer.
 *
 * @param {HTMLElement} container
 * @param {object} [hooks]
 * @param {() => void} [hooks.onInstalled] - Called after any change to the stored macros.
 */
export function renderTemplateGallery(container, { onInstalled } = {}) {
    container.innerHTML = '';
    const ctx = SillyTavern.getContext();

    const scopeRow = el('label', 'me-custom-scope-row');
    scopeRow.appendChild(el('span', undefined, 'Install into: '));
    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'text_pole';
    const scopeCaptions = {
        [SCOPE_GLOBAL]: 'Everywhere (global)',
        [SCOPE_CHARACTER]: 'Current character only',
        [SCOPE_CHAT]: 'This chat only',
    };
    for (const value of [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = scopeCaptions[value];
        if (value === SCOPE_CHARACTER && (ctx.characterId === undefined || ctx.characterId === null)) {
            option.disabled = true;
        }
        if (value === SCOPE_CHAT && (ctx.chatId === undefined || ctx.chatId === null)) {
            option.disabled = true;
        }
        scopeSelect.appendChild(option);
    }
    scopeRow.appendChild(scopeSelect);
    container.appendChild(scopeRow);

    const status = el('div', 'me-gallery-status');

    const runInstall = async (partials) => {
        status.textContent = 'Installing…';
        try {
            const result = await installMacros(scopeSelect.value, partials);
            status.textContent = describeInstall(result, scopeSelect.value);
            onInstalled?.();
        } catch (error) {
            status.textContent = `Installing failed: ${error?.message ?? error}`;
        }
    };

    for (const pack of TEMPLATE_PACKS) {
        const packBox = el('div', 'me-gallery-pack');
        const header = button('me-gallery-pack-header', `▸ ${pack.name}`, () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : '';
            header.textContent = `${open ? '▸' : '▾'} ${pack.name}`;
        });
        packBox.appendChild(header);

        const body = el('div', 'me-gallery-pack-body');
        body.style.display = 'none';
        body.appendChild(el('div', 'me-drawer-hint', pack.description));
        body.appendChild(button('menu_button me-custom-button', 'Install all', () => runInstall(pack.macros)));
        for (const macro of pack.macros) {
            const card = el('div', 'me-gallery-card');
            const headRow = el('div', 'me-gallery-card-head');
            headRow.appendChild(el('span', 'me-custom-name', `{{${macro.name}${macro.args.filter(arg => !arg.optional).map(arg => `::${arg.name}`).join('')}}}`));
            headRow.appendChild(button('menu_button me-custom-button', 'Install', () => runInstall([macro])));
            card.appendChild(headRow);
            card.appendChild(el('div', 'me-custom-desc', macro.description));
            card.appendChild(el('pre', 'me-gallery-template', macro.template));
            body.appendChild(card);
        }
        packBox.appendChild(body);
        container.appendChild(packBox);
    }

    // ---- pack import/export ----
    const shareRow = el('div', 'me-gallery-share');
    for (const scope of [SCOPE_GLOBAL, SCOPE_CHARACTER, SCOPE_CHAT]) {
        const defs = defsForScope(scope);
        if (!defs.length) {
            continue;
        }
        shareRow.appendChild(button('menu_button me-custom-button', `Export ${scope} (${defs.length})`, () => {
            const stamp = new Date().toISOString().slice(0, 10);
            downloadJson(`macro-enhanced-${scope}-${stamp}.json`, exportPack(defs, { exportedAt: new Date().toISOString() }));
        }));
    }
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.json,application/json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
            const { macros, problems } = parsePack(String(reader.result ?? ''));
            if (problems.length) {
                status.textContent = problems.join(' ');
            }
            if (macros.length) {
                await runInstall(macros);
            } else if (!problems.length) {
                status.textContent = 'The pack is empty.';
            }
        };
        reader.readAsText(file);
    });
    shareRow.appendChild(importInput);
    shareRow.appendChild(button('menu_button me-custom-button', 'Import pack…', () => importInput.click()));
    container.appendChild(shareRow);
    container.appendChild(el('div', 'me-drawer-hint',
        'Installed templates become normal custom macros you can edit above. Name collisions get a -2 suffix.'));
    container.appendChild(status);
}
