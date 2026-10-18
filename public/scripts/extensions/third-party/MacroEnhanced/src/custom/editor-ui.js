/**
 * The custom macro editor. It keeps its draft in the UI state module, so a
 * redraw caused by a persona switch, a pronoun save or a data event cannot wipe
 * what someone is typing. Saving is checked against the context the editor was
 * opened in, so a switched character or chat never receives the draft.
 */
import { announce, announceError, button, el } from '../dom.js';
import {
    SCOPE_BROWSER,
    SCOPE_CHARACTER,
    SCOPE_CHAT,
    SCOPE_GLOBAL,
    createDef,
    getAllCustomNames,
    getDefsForScope,
    saveDefsForScope,
    validateDef,
} from './store.js';
import { getBrowserIdentity } from './browser-store.js';
import { syncRegistrations } from './registrar.js';
import { SCOPE_COPY, scopeAvailability, snapshotContext, validateScopeForSave } from './scopes.js';
import { createSaveGate, moveMacroBetweenScopes, MoveMacroError } from './scope-move.js';
import { renderMacroText } from '../ui/macro-text.js';

const VALIDATE_DEBOUNCE_MS = 250;

const SCOPE_LABELS = Object.freeze({
    [SCOPE_GLOBAL]: 'Everywhere',
    [SCOPE_BROWSER]: 'This browser',
    [SCOPE_CHARACTER]: 'This character',
    [SCOPE_CHAT]: 'This chat',
});

function scopeLabel(scope) {
    return SCOPE_LABELS[scope] ?? 'that scope';
}

function currentScopeIdentity(scope) {
    const ctx = SillyTavern.getContext();
    if (scope === SCOPE_GLOBAL) {
        return 'global';
    }
    if (scope === SCOPE_BROWSER) {
        try {
            return getBrowserIdentity({ ctx });
        } catch {
            return null;
        }
    }
    if (scope === SCOPE_CHARACTER) {
        return ctx.characters?.[ctx.characterId]?.avatar ?? null;
    }
    if (scope === SCOPE_CHAT) {
        return `${ctx.groupId ?? ''}:${ctx.chatId ?? ''}`;
    }
    return null;
}

async function persist(scope, defs) {
    await saveDefsForScope(scope, defs);
    syncRegistrations();
}

function callSignature(def) {
    const args = (def.args ?? [])
        .filter(arg => String(arg.name ?? '').trim())
        .map(arg => (arg.optional ? `::[${arg.name.trim()}]` : `::${arg.name.trim()}`))
        .join('');
    return `{{${String(def.name ?? '').trim() || 'name'}${args}}}`;
}

/** A fresh draft, owned by uiState so a redraw does not lose it. */
export function createEditorDraft({ existingDef = null, existingScope = null, ctx = SillyTavern.getContext() } = {}) {
    return {
        def: createDef(existingDef ? structuredClone(existingDef) : {}),
        scope: existingScope ?? SCOPE_GLOBAL,
        persistedScope: existingDef ? existingScope : null,
        snapshot: snapshotContext(ctx),
        isNew: !existingDef,
    };
}

function labeledField(caption, input, { hint = '' } = {}) {
    const label = el('label', 'me-field');
    label.appendChild(el('span', 'me-field-label', caption));
    label.appendChild(input);
    if (hint) {
        label.appendChild(el('span', 'me-field-hint', hint));
    }
    return label;
}

function createInput(value, placeholder = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text_pole';
    input.value = value ?? '';
    input.placeholder = placeholder;
    return input;
}

/**
 * Mounts the editor into a container. Replaces its contents.
 *
 * @param {HTMLElement} container
 * @param {ReturnType<typeof createEditorDraft>} draft
 * @param {object} hooks
 * @param {(info: {saved: boolean}) => void} hooks.onClose
 * @param {(def: object, scope: string, options: {tryAfter: boolean}) => void} hooks.onSaved
 */
export function renderMacroEditor(container, draft, { onClose, onSaved } = {}) {
    container.replaceChildren();
    const def = draft.def;
    const form = el('form', 'me-macro-editor');
    form.noValidate = true;

    const head = el('div', 'me-editor-head');
    const back = button('me-back', '← All macros', () => onClose?.({ saved: false }));
    head.appendChild(back);
    head.appendChild(el('h2', 'me-editor-title', draft.isNew ? 'New macro' : `Edit {{${def.name}}}`));
    form.appendChild(head);

    const nameInput = createInput(def.name, 'greet');
    nameInput.id = 'me-editor-name';
    const signature = el('div', 'me-signature-line');
    const signatureValue = el('div', 'me-signature-value');
    signature.append(el('span', 'me-field-label', 'Call it as'), signatureValue);
    const descriptionInput = createInput(def.description, 'Shown in the reference and /help macros');
    descriptionInput.id = 'me-editor-description';
    const templateInput = document.createElement('textarea');
    templateInput.id = 'me-editor-template';
    templateInput.className = 'text_pole me-template-input';
    templateInput.rows = 5;
    templateInput.value = def.template ?? '';
    templateInput.placeholder = 'What the macro expands to. Other macros work here, for example: Hello {{user}}, it is {{timeofday}}.';

    form.append(
        labeledField('Name', nameInput, { hint: 'Start with a letter; letters, numbers, hyphens and underscores are fine.' }),
        signature,
        labeledField('What it expands to', templateInput),
        labeledField('Description', descriptionInput, { hint: 'Shown in the reference and /help macros. Optional.' }),
    );

    const argsSection = el('section', 'me-editor-section');
    const argsHead = el('div', 'me-editor-section-head');
    argsHead.appendChild(el('h3', 'me-section-title', 'Arguments'));
    argsHead.appendChild(el('p', 'me-section-note', 'Callers pass them as {{yourmacro::value1::value2}}. Inside the template they are {{argname}} or {{arg1}}.'));
    argsSection.appendChild(argsHead);
    const argsHost = el('div', 'me-arg-list');
    argsSection.appendChild(argsHost);
    form.appendChild(argsSection);

    const scopeSection = el('fieldset', 'me-editor-section me-scope-group');
    scopeSection.appendChild(el('legend', 'me-section-title', 'Saved for'));
    const scopeReasons = new Map();
    const scopeInputs = new Map();
    const scopeWarning = el('p', 'me-form-problem');
    scopeWarning.hidden = true;

    for (const scope of [SCOPE_GLOBAL, SCOPE_BROWSER, SCOPE_CHARACTER, SCOPE_CHAT]) {
        const row = el('label', 'me-radio-row');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'me-editor-scope';
        input.value = scope;
        input.checked = draft.scope === scope;
        input.addEventListener('change', () => {
            if (!input.checked) {
                return;
            }
            draft.scope = scope;
            updateScopeAvailability();
            scheduleValidation();
        });
        scopeInputs.set(scope, input);
        row.appendChild(input);
        const copy = el('span', 'me-radio-copy');
        const title = el('span', 'me-radio-title', SCOPE_COPY[scope].title);
        copy.appendChild(title);
        const hint = el('span', 'me-radio-hint', SCOPE_COPY[scope].hint);
        copy.appendChild(hint);
        const reason = el('span', 'me-radio-reason');
        reason.hidden = true;
        copy.appendChild(reason);
        scopeReasons.set(scope, reason);
        row.appendChild(copy);
        scopeSection.appendChild(row);
    }
    scopeSection.appendChild(scopeWarning);
    form.appendChild(scopeSection);

    const problems = el('p', 'me-form-problem');
    problems.hidden = true;
    form.appendChild(problems);

    const buttons = el('div', 'me-editor-actions');
    const saveButton = button('menu_button menu_button_primary', 'Save', async () => {
        await save({ tryAfter: false });
    });
    const tryButton = button('menu_button', 'Save and try it', async () => {
        await save({ tryAfter: true });
    });
    const cancelButton = button('menu_button', 'Cancel', () => onClose?.({ saved: false }));
    buttons.append(saveButton, tryButton, cancelButton);
    form.appendChild(buttons);
    container.appendChild(form);

    let validateTimer = null;
    const saveGate = createSaveGate();

    function setSaving(saving) {
        for (const control of [saveButton, tryButton, cancelButton, back]) {
            control.disabled = saving;
        }
        if (saving) {
            for (const input of scopeInputs.values()) {
                input.disabled = true;
            }
        } else {
            updateScopeAvailability();
        }
    }

    function syncFieldsToDef() {
        def.name = nameInput.value.trim();
        def.description = descriptionInput.value.trim();
        def.template = templateInput.value;
    }

    function updateSignature() {
        signatureValue.replaceChildren();
        const name = nameInput.value.trim();
        if (!name) {
            signatureValue.appendChild(el('span', 'me-signature-empty', 'Name it and the way to call it appears here.'));
            return;
        }
        signatureValue.appendChild(renderMacroText(callSignature({ ...def, name }), { tag: 'span', className: 'me-mt me-signature-macro' }));
    }

    function showProblems(messages) {
        const list = messages.filter(Boolean);
        problems.hidden = list.length === 0;
        problems.textContent = list.join(' ');
    }

    function candidate() {
        return {
            ...def,
            name: nameInput.value.trim(),
            description: descriptionInput.value.trim(),
            template: templateInput.value,
            args: (def.args ?? []).filter(arg => String(arg.name ?? '').trim()),
        };
    }

    function validate({ saving = false } = {}) {
        const ctx = SillyTavern.getContext();
        const candidateDef = candidate();
        const messages = [];
        let siblings = [];
        try {
            siblings = getDefsForScope(draft.scope).filter(other => other.id !== def.id);
        } catch (error) {
            messages.push(`Could not read ${scopeLabel(draft.scope)} macros: ${error?.message ?? error}`);
        }
        messages.push(...validateDef(candidateDef, {
            siblings,
            registry: ctx.macros?.registry,
            customNames: getAllCustomNames(),
        }));
        if (saving) {
            const scopeProblem = validateScopeForSave({
                scope: draft.scope,
                persistedScope: draft.persistedScope,
                snapshot: draft.snapshot,
                ctx,
            });
            if (scopeProblem) {
                messages.push(scopeProblem);
            }
        }
        return messages;
    }

    function scheduleValidation() {
        clearTimeout(validateTimer);
        validateTimer = setTimeout(() => {
            // A still-empty new draft should not nag; save still checks it.
            if (!nameInput.value.trim() && !templateInput.value.trim()) {
                showProblems([]);
                return;
            }
            showProblems(validate());
        }, VALIDATE_DEBOUNCE_MS);
    }

    function updateScopeAvailability() {
        const availability = scopeAvailability();
        for (const [scope, input] of scopeInputs) {
            const state = availability[scope];
            input.disabled = !state.available;
            const row = input.closest('.me-radio-row');
            row?.classList.toggle('me-radio-disabled', !state.available);
            const reason = scopeReasons.get(scope);
            reason.hidden = state.available;
            reason.textContent = state.reason || '';
        }
        const warning = validateScopeForSave({
            scope: draft.scope,
            persistedScope: draft.persistedScope,
            snapshot: draft.snapshot,
        });
        scopeWarning.hidden = !warning;
        scopeWarning.textContent = warning;
    }

    function renderArgs() {
        argsHost.replaceChildren();
        if (!def.args.length) {
            argsHost.appendChild(el('p', 'me-section-note', 'No arguments. The macro is called as {{name}}.'));
        } else {
            def.args.forEach((arg, index) => {
                const card = el('div', 'me-arg-card');
                const cardHead = el('div', 'me-arg-card-head');
                cardHead.appendChild(el('span', 'me-arg-card-title', `Argument ${index + 1}`));
                const remove = button('me-icon-button', '×', () => {
                    def.args.splice(index, 1);
                    renderArgs();
                    updateSignature();
                    scheduleValidation();
                });
                remove.setAttribute('aria-label', `Remove argument ${index + 1}`);
                remove.title = 'Remove argument';
                cardHead.appendChild(remove);
                card.appendChild(cardHead);

                const argName = createInput(arg.name ?? '', 'argument name');
                argName.setAttribute('aria-label', `Argument ${index + 1} name`);
                argName.addEventListener('input', () => {
                    arg.name = argName.value;
                    updateSignature();
                    scheduleValidation();
                });
                card.appendChild(labeledField('Name', argName));

                const optionalRow = el('label', 'me-check-row');
                const optional = document.createElement('input');
                optional.type = 'checkbox';
                optional.checked = !!arg.optional;
                optionalRow.appendChild(optional);
                optionalRow.appendChild(el('span', 'me-check-label', 'Optional'));
                card.appendChild(optionalRow);

                const defaultValue = createInput(arg.defaultValue ?? '', 'used when the caller leaves it out');
                defaultValue.disabled = !arg.optional;
                defaultValue.setAttribute('aria-label', `Argument ${index + 1} default value`);
                defaultValue.addEventListener('input', () => {
                    arg.defaultValue = defaultValue.value;
                });
                card.appendChild(labeledField('Default value', defaultValue, { hint: 'Only used for an optional argument.' }));

                const argDescription = createInput(arg.description ?? '', 'what this argument is for');
                argDescription.setAttribute('aria-label', `Argument ${index + 1} description`);
                argDescription.addEventListener('input', () => {
                    arg.description = argDescription.value;
                });
                card.appendChild(labeledField('What it is for', argDescription, { hint: 'Optional. Shown in the reference.' }));

                optional.addEventListener('change', () => {
                    arg.optional = optional.checked;
                    defaultValue.disabled = !arg.optional;
                    updateSignature();
                    scheduleValidation();
                });

                argsHost.appendChild(card);
            });
        }

        const addArg = button('menu_button', '+ Add argument', () => {
            def.args.push({ name: '', optional: false, defaultValue: '', description: '' });
            renderArgs();
            updateSignature();
            scheduleValidation();
        });
        argsHost.appendChild(addArg);
    }

    async function save({ tryAfter }) {
        if (saveGate.busy) {
            const message = 'A save is already in progress. Wait for it to finish before saving again.';
            showProblems([message]);
            announceError(message);
            return false;
        }
        clearTimeout(validateTimer);
        syncFieldsToDef();
        def.args = def.args.filter(arg => String(arg.name ?? '').trim());
        renderArgs();
        updateSignature();
        updateScopeAvailability();

        const messages = validate({ saving: true });
        if (messages.length) {
            showProblems(messages);
            announceError(messages.join(' '));
            if (messages.some(message => message.toLowerCase().includes('name'))) {
                nameInput.focus();
            } else if (messages.some(message => message.toLowerCase().includes('template'))) {
                templateInput.focus();
            }
            return false;
        }

        // Freeze the save target and the exact definition. A control lock below
        // stops a second save, while this clone means later typing cannot change
        // the version already on its way to the card or chat.
        const targetScope = draft.scope;
        const movingFrom = draft.persistedScope && draft.persistedScope !== targetScope ? draft.persistedScope : null;
        const savedDef = structuredClone(def);
        let targetDefs;
        let sourceDefs = null;
        try {
            targetDefs = getDefsForScope(targetScope)
                .filter(other => other.id !== savedDef.id)
                .concat(savedDef);
        } catch (error) {
            const message = `Could not read ${scopeLabel(targetScope)} macros: ${error?.message ?? error}`;
            showProblems([message]);
            announceError(message);
            updateScopeAvailability();
            return false;
        }
        try {
            sourceDefs = movingFrom
                ? getDefsForScope(movingFrom).filter(other => other.id !== savedDef.id)
                : null;
        } catch (error) {
            const message = `Could not read ${scopeLabel(movingFrom)} macros: ${error?.message ?? error}`;
            showProblems([message]);
            announceError(message);
            updateScopeAvailability();
            return false;
        }

        let gateResult;
        try {
            gateResult = await saveGate.run(async () => {
                setSaving(true);
                try {
                    if (movingFrom) {
                        return await moveMacroBetweenScopes({
                            sourceScope: movingFrom,
                            targetScope,
                            defId: savedDef.id,
                            sourceDefs,
                            targetDefs,
                            identityFor: currentScopeIdentity,
                            readDefs: getDefsForScope,
                            persist,
                        });
                    }
                    await persist(targetScope, targetDefs);
                    return { targetScope };
                } finally {
                    setSaving(false);
                }
            });
        } catch (error) {
            if (error instanceof MoveMacroError) {
                const target = scopeLabel(targetScope);
                const source = scopeLabel(movingFrom);
                const message = error.rollback === 'not-written'
                    ? `Move incomplete: the original {{${savedDef.name}}} is still in ${source}. No ${target} copy was written.`
                    : error.rollback === 'done'
                        ? `Move incomplete: the original {{${savedDef.name}}} is still in ${source}. The ${target} copy was removed.`
                        : error.rollback === 'failed'
                            ? `Move incomplete: the original {{${savedDef.name}}} is still in ${source}. A copy may also remain in ${target} because the rollback failed.`
                            : `Move incomplete: the original {{${savedDef.name}}} is still in ${source}. A copy may also remain in ${target}.`;
                showProblems([message]);
                announceError(message);
                return false;
            }
            const message = `Saving failed: ${error?.message ?? error}`;
            showProblems([message]);
            announceError(message);
            return false;
        }

        if (!gateResult.started) {
            const message = 'A save is already in progress. Wait for it to finish before saving again.';
            showProblems([message]);
            announceError(message);
            return false;
        }

        draft.persistedScope = targetScope;
        draft.isNew = false;
        showProblems([]);
        announce(`Saved {{${savedDef.name}}} for ${scopeLabel(targetScope)}.`);
        onSaved?.(savedDef, targetScope, { tryAfter });
        return true;
    }

    nameInput.addEventListener('input', () => {
        def.name = nameInput.value;
        updateSignature();
        scheduleValidation();
    });
    templateInput.addEventListener('input', () => {
        def.template = templateInput.value;
        scheduleValidation();
    });
    descriptionInput.addEventListener('input', () => {
        def.description = descriptionInput.value;
        scheduleValidation();
    });

    form.addEventListener('submit', event => {
        event.preventDefault();
        void save({ tryAfter: false });
    });

    updateSignature();
    renderArgs();
    updateScopeAvailability();
    nameInput.focus({ preventScroll: true });
    nameInput.select();

    return {
        refreshAvailability: updateScopeAvailability,
        focusName: () => nameInput.focus({ preventScroll: true }),
        destroy: () => clearTimeout(validateTimer),
    };
}
