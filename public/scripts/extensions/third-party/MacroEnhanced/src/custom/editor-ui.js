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
import { button, el } from '../dom.js';

const VALIDATE_DEBOUNCE_MS = 300;

function scopeLabel(scope) {
    if (scope === SCOPE_CHARACTER) {
        return 'Character';
    }
    return scope === SCOPE_CHAT ? 'Chat' : 'Global';
}

async function persist(scope, defs) {
    if (scope === SCOPE_CHARACTER) {
        await saveCharacterDefs(defs);
    } else if (scope === SCOPE_CHAT) {
        saveChatDefs(defs);
    } else {
        saveGlobalDefs(defs);
    }
    syncRegistrations();
}

function defsForScope(scope) {
    if (scope === SCOPE_CHARACTER) {
        return getCharacterDefs();
    }
    return scope === SCOPE_CHAT ? getChatDefs() : getGlobalDefs();
}

function isChatUnavailable() {
    const ctx = SillyTavern.getContext();
    return ctx.chatId === undefined || ctx.chatId === null;
}

/** A <label> wrapping the input, so the caption reads and clicks as its label. */
function labeledField(caption, inputEl) {
    const wrap = el('label', 'me-custom-field');
    wrap.appendChild(el('span', 'me-custom-label', caption));
    wrap.appendChild(inputEl);
    return wrap;
}

/**
 * Renders the custom-macro manager into the settings drawer.
 *
 * @param {HTMLElement} container
 * @param {object} [hooks]
 * @param {(text: string) => void} [hooks.onTestInWorkbench] - Opens the Workbench pre-filled.
 */
export function renderCustomMacroManager(container, { onTestInWorkbench } = {}) {
    container.innerHTML = '';

    const list = el('div', 'me-custom-list');
    const editorHost = el('div', 'me-custom-editor-host');

    const refreshList = () => {
        list.innerHTML = '';
        const groups = [
            { scope: SCOPE_GLOBAL, defs: getGlobalDefs() },
            { scope: SCOPE_CHARACTER, defs: getCharacterDefs() },
            { scope: SCOPE_CHAT, defs: getChatDefs() },
        ];
        let any = false;
        for (const { scope, defs } of groups) {
            for (const def of defs) {
                any = true;
                list.appendChild(renderRow(def, scope));
            }
        }
        if (!any) {
            list.appendChild(el('div', 'me-custom-empty', 'No custom macros yet. Click "New macro" to create one.'));
        }
    };

    const renderRow = (def, scope) => {
        const row = el('div', 'me-custom-row');

        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = def.enabled !== false;
        enabled.title = 'Enabled';
        enabled.setAttribute('aria-label', `Enable {{${def.name}}}`);
        enabled.addEventListener('change', async () => {
            const previous = def.enabled;
            def.enabled = enabled.checked;
            try {
                await persist(scope, defsForScope(scope));
            } catch (error) {
                def.enabled = previous;
                enabled.checked = previous !== false;
                console.warn(`[Macro Enhanced] Failed to save the enabled state of {{${def.name}}}.`, error);
            }
        });
        row.appendChild(enabled);

        row.appendChild(el('span', 'me-custom-name', `{{${def.name}}}`));
        row.appendChild(el('span', 'me-custom-scope', scopeLabel(scope)));
        if (def.description) {
            row.appendChild(el('span', 'me-custom-desc', def.description));
        }

        row.appendChild(button('menu_button me-custom-button', 'Edit', () => openEditor(def, scope)));

        row.appendChild(button('menu_button me-custom-button', 'Delete', async () => {
            const ctx = SillyTavern.getContext();
            const confirmFn = ctx.Popup?.show?.confirm;
            // POPUP_RESULT: yes=1, no=0, Escape=null. only a truthy result may delete.
            const confirmed = confirmFn
                ? !!(await confirmFn('Delete custom macro', `Delete {{${def.name}}}?`))
                : globalThis.confirm(`Delete {{${def.name}}}?`);
            if (!confirmed) {
                return;
            }
            try {
                await persist(scope, defsForScope(scope).filter(other => other.id !== def.id));
            } catch (error) {
                await ctx.Popup?.show?.text?.('Macro Enhanced', `Deleting failed: ${error?.message ?? error}`);
                return;
            }
            refreshList();
        }));

        return row;
    };

    const openEditor = (existingDef, existingScope) => {
        editorHost.innerHTML = '';
        const def = createDef(existingDef ? structuredClone(existingDef) : {});
        let scope = existingScope ?? SCOPE_GLOBAL;
        /** Scope the def is currently saved under; null until its first save. */
        let persistedScope = existingDef ? (existingScope ?? null) : null;

        const form = el('div', 'me-custom-editor');
        const title = el('div', 'me-custom-editor-title', existingDef ? `Edit {{${def.name}}}` : 'New macro');
        form.appendChild(title);

        const nameInput = document.createElement('input');
        nameInput.className = 'text_pole';
        nameInput.placeholder = 'e.g. greet. used as {{greet}} in prompts';
        nameInput.value = def.name;
        form.appendChild(labeledField('Name', nameInput));

        // How you actually call the thing, kept correct as the name and
        // arguments change. the question the editor never used to answer.
        const signature = el('div', 'me-custom-signature');
        form.appendChild(signature);
        const updateSignature = () => {
            const name = nameInput.value.trim();
            if (!name) {
                signature.textContent = 'Name it, and the way to call it appears here.';
                signature.classList.add('me-custom-signature-empty');
                return;
            }
            signature.classList.remove('me-custom-signature-empty');
            const args = def.args
                .filter(arg => String(arg.name ?? '').trim())
                .map(arg => (arg.optional ? `::[${arg.name.trim()}]` : `::${arg.name.trim()}`))
                .join('');
            signature.textContent = `Call it as  {{${name}${args}}}`;
        };
        nameInput.addEventListener('input', updateSignature);

        const descInput = document.createElement('input');
        descInput.className = 'text_pole';
        descInput.placeholder = 'Shown in the macro reference and /help macros';
        descInput.value = def.description;
        form.appendChild(labeledField('Description', descInput));

        const templateInput = document.createElement('textarea');
        templateInput.className = 'text_pole me-custom-template';
        templateInput.rows = 4;
        templateInput.placeholder = 'What the macro expands to. Other macros work here, e.g.:\nMy {{mood}} greeting for {{user}}';
        templateInput.value = def.template;
        form.appendChild(labeledField('Template', templateInput));

        form.appendChild(el('div', 'me-custom-hint',
            'Arguments: add names below, then use {{argname}} (or {{arg1}}, {{arg2}}, …) inside the template. Callers pass them as {{yourmacro::value1::value2}}.'));

        const problems = el('div', 'me-custom-problems');

        // Live validation while typing; also run by the args UI and scope select.
        let validateTimer = null;
        const validateLive = () => {
            const name = nameInput.value.trim();
            if (!name) {
                problems.textContent = '';
                return;
            }
            const ctx = SillyTavern.getContext();
            const candidate = {
                ...def,
                name,
                // A still-empty template shouldn't nag while the name is being typed.
                template: templateInput.value.trim() || 'placeholder',
                args: def.args.filter(arg => String(arg.name ?? '').trim()),
            };
            const siblings = defsForScope(scope).filter(other => other.id !== def.id);
            const errors = validateDef(candidate, { siblings, registry: ctx.macros?.registry, customNames: getAllCustomNames() });
            const filtered = existingDef && existingDef.name === name
                ? errors.filter(problem => !problem.includes('already exists'))
                : errors;
            problems.textContent = filtered.join(' ');
        };
        const scheduleValidation = () => {
            clearTimeout(validateTimer);
            validateTimer = setTimeout(validateLive, VALIDATE_DEBOUNCE_MS);
        };
        nameInput.addEventListener('input', scheduleValidation);

        const argsHost = el('div', 'me-custom-args');
        const renderArgs = () => {
            argsHost.innerHTML = '';
            def.args.forEach((arg, index) => {
                const argRow = el('div', 'me-custom-arg-row');

                const argName = document.createElement('input');
                argName.className = 'text_pole';
                argName.placeholder = 'argument name';
                argName.setAttribute('aria-label', `Argument ${index + 1} name`);
                argName.value = arg.name ?? '';
                argName.addEventListener('input', () => {
                    arg.name = argName.value;
                    updateSignature();
                    scheduleValidation();
                });
                argRow.appendChild(argName);

                const optional = document.createElement('input');
                optional.type = 'checkbox';
                optional.checked = !!arg.optional;
                optional.title = 'Optional';
                optional.setAttribute('aria-label', `Argument ${index + 1} is optional`);
                optional.addEventListener('change', () => {
                    arg.optional = optional.checked;
                    updateSignature();
                    scheduleValidation();
                });
                argRow.appendChild(optional);
                argRow.appendChild(el('span', 'me-custom-arg-label', 'optional'));

                const defaultValue = document.createElement('input');
                defaultValue.className = 'text_pole';
                defaultValue.placeholder = 'default (if optional)';
                defaultValue.setAttribute('aria-label', `Argument ${index + 1} default value`);
                defaultValue.value = arg.defaultValue ?? '';
                defaultValue.addEventListener('input', () => { arg.defaultValue = defaultValue.value; });
                argRow.appendChild(defaultValue);

                // Already carried by the data model, the pack format and
                // compileDef. it just had nowhere to be typed.
                const argDesc = document.createElement('input');
                argDesc.className = 'text_pole me-custom-arg-desc';
                argDesc.placeholder = 'what this argument is for (optional)';
                argDesc.setAttribute('aria-label', `Argument ${index + 1} description`);
                argDesc.value = arg.description ?? '';
                argDesc.addEventListener('input', () => { arg.description = argDesc.value; });
                argRow.appendChild(argDesc);

                const removeArg = button('menu_button me-custom-button', '×', () => {
                    def.args.splice(index, 1);
                    renderArgs();
                    updateSignature();
                    scheduleValidation();
                });
                removeArg.title = 'Remove argument';
                removeArg.setAttribute('aria-label', `Remove argument ${index + 1}`);
                argRow.appendChild(removeArg);

                argsHost.appendChild(argRow);
            });

            const addArg = button('menu_button me-custom-button', '+ Add argument', () => {
                def.args.push({ name: '', optional: false, defaultValue: '' });
                renderArgs();
            });
            argsHost.appendChild(addArg);
        };
        renderArgs();
        updateSignature();
        form.appendChild(argsHost);

        const scopeRow = el('label', 'me-custom-scope-row');
        scopeRow.appendChild(el('span', undefined, 'Saved for: '));
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
            if (value === SCOPE_CHAT && isChatUnavailable()) {
                option.disabled = true;
                option.title = 'Open a chat first.';
            }
            scopeSelect.appendChild(option);
        }
        scopeSelect.value = scope;
        scopeSelect.addEventListener('change', () => {
            scope = scopeSelect.value;
            validateLive();
        });
        scopeRow.appendChild(scopeSelect);
        form.appendChild(scopeRow);

        form.appendChild(problems);

        /** Validates and persists the editor state. Returns false (with a message) on any problem. */
        const doSave = async () => {
            def.name = nameInput.value.trim();
            def.description = descInput.value.trim();
            def.template = templateInput.value;
            def.args = def.args.filter(arg => String(arg.name ?? '').trim());
            renderArgs();

            const ctx = SillyTavern.getContext();
            const noCharacter = ctx.characterId === undefined || ctx.characterId === null;
            if (noCharacter && scope === SCOPE_CHARACTER) {
                problems.textContent = 'Open a character chat first to save a character-scoped macro.';
                return false;
            }
            if (noCharacter && persistedScope === SCOPE_CHARACTER && persistedScope !== scope) {
                problems.textContent = 'Open the character this macro belongs to before moving it to another scope.';
                return false;
            }
            if (isChatUnavailable() && (scope === SCOPE_CHAT || persistedScope === SCOPE_CHAT)) {
                problems.textContent = 'Open a chat first to work with a chat-scoped macro.';
                return false;
            }

            const siblings = defsForScope(scope).filter(other => other.id !== def.id);
            const errors = validateDef(def, { siblings, registry: ctx.macros?.registry, customNames: getAllCustomNames() });
            // When editing an existing macro of ours, its own live registration is fine.
            const filteredErrors = existingDef && existingDef.name === def.name
                ? errors.filter(problem => !problem.includes('already exists'))
                : errors;
            if (filteredErrors.length) {
                problems.textContent = filteredErrors.join(' ');
                return false;
            }

            const scopeDefs = defsForScope(scope).filter(other => other.id !== def.id);
            scopeDefs.push(def);

            try {
                // Moving between scopes removes the def from its previous home.
                if (persistedScope && persistedScope !== scope) {
                    await persist(persistedScope, defsForScope(persistedScope).filter(other => other.id !== def.id));
                }
                await persist(scope, scopeDefs);
            } catch (error) {
                problems.textContent = `Saving failed: ${error?.message ?? error}`;
                return false;
            }

            persistedScope = scope;
            title.textContent = `Edit {{${def.name}}}`;
            problems.textContent = '';
            return true;
        };

        const buttons = el('div', 'me-custom-editor-buttons');
        buttons.appendChild(button('menu_button', 'Save', async () => {
            if (await doSave()) {
                clearTimeout(validateTimer);
                editorHost.innerHTML = '';
                refreshList();
            }
        }));

        if (typeof onTestInWorkbench === 'function') {
            const testButton = button('menu_button', 'Test in Workbench', async () => {
                // Saves first, so the Workbench always tests exactly what is typed here.
                if (!(await doSave())) {
                    return;
                }
                refreshList();
                const requiredArgs = (def.args ?? []).filter(arg => !arg.optional);
                onTestInWorkbench(`{{${def.name}${requiredArgs.map(arg => `::${arg.name}`).join('')}}}`);
            });
            testButton.title = 'Saves the macro, then opens it in the Workbench';
            buttons.appendChild(testButton);
        }

        buttons.appendChild(button('menu_button', 'Cancel', () => {
            clearTimeout(validateTimer);
            editorHost.innerHTML = '';
        }));

        form.appendChild(buttons);
        editorHost.appendChild(form);
        nameInput.focus();
    };

    container.appendChild(button('menu_button', 'New macro', () => openEditor(null, SCOPE_GLOBAL)));
    container.appendChild(list);
    container.appendChild(editorHost);
    refreshList();

    return { refreshList };
}
