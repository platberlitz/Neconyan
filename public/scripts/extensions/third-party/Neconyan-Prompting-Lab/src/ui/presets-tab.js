import { copyPrompt, onClipboardChange, readClipboard } from '../clipboard.js';
import { button, confirmButton, element, emptyState, errorMessage, field, promptField, replace, statusRegion } from '../dom.js';
import { countTokens, getContext, listInstalledPresets, readInstalledPreset } from '../host.js';
import { runPromptingLab } from '../native.js';
import { registerActiveTask } from '../operations.js';
import { moduleToDraft, pastePromptModule } from '../prompt-drafts.js';
import {
    PRESET_API_IDS,
    PRESET_FIELDS,
    addPromptModule,
    blankPayload,
    canEditPrompt,
    canRemovePrompt,
    fingerprint,
    isCcApiId,
    labelForApiId,
    listPromptModules,
    movePromptModule,
    removePromptModule,
    reviewConnectionFields,
    setPromptModuleEnabled,
    updatePromptModule,
    withCanonicalName,
    withoutFields,
} from '../presets.js';
import { createDraft, newId, validateDraft } from '../schema.js';
import * as storage from '../storage.js';

const ROLES = ['system', 'user', 'assistant'];

/**
 * The preset workshop.
 *
 * Presets that Neconyan has installed are only ever read here. Everything
 * you change lives in a Prompting Lab draft until you publish it, so an
 * experiment can never damage a preset you rely on.
 */
export function createPresetsTab({ onChanged = null, onPromptSaved = null } = {}) {
    let root = null;
    let searchInput = null;
    let typeSelect = null;
    let libraryHost = null;
    let editorHost = null;
    let status = null;
    let reloadHost = null;
    let unsubscribeClipboard = null;
    let pasteButton = null;

    let drafts = [];
    let editing = null;
    let expanded = '';
    let browsing = '';
    let rawOpen = false;
    let reloadEpoch = 0;
    let publishing = false;

    async function reload({ keepEditor = false } = {}) {
        const epoch = ++reloadEpoch;
        const nextDrafts = await storage.listDrafts();
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        drafts = nextDrafts;
        renderAll({ keepEditor });
        onChanged?.();
    }

    /** Saves one module into the Prompts space as its own titled prompt. */
    async function saveModuleAsPrompt(prompt, sourceName) {
        const draft = moduleToDraft(prompt, { sourceName });
        const task = registerActiveTask('prompt module save');
        try {
            await storage.savePromptDraft(draft);
            status.textContent = `Saved "${draft.title}" to the Prompts tab.`;
            onPromptSaved?.();
        } finally {
            task.release();
        }
    }

    function matches(name, apiId) {
        const term = searchInput.value.trim().toLowerCase();
        if (typeSelect.value && typeSelect.value !== apiId) {
            return false;
        }
        return !term || name.toLowerCase().includes(term);
    }

    async function copyToDrafts(apiId, name) {
        const installed = readInstalledPreset(apiId, name);
        const editor = editing;
        const payload = installed ? structuredClone(installed) : null;
        if (!payload) {
            status.textContent = `"${name}" could not be read from Neconyan.`;
            return;
        }
        const task = registerActiveTask('preset copy');
        try {
            const draft = createDraft({
                apiId,
                name: `${name} (copy)`,
                payload,
                source: { name, fingerprint: await fingerprint(payload) },
            });
            await storage.saveDraft(draft);
            if (editing === editor) {
                editing = draft;
                expanded = '';
            }
            status.textContent = `Copied "${name}" into your drafts.`;
            await reload();
        } finally {
            task.release();
        }
    }

    function renderInstalled() {
        const wrapper = element('div', { className: 'sbpl-preset-group' });
        wrapper.append(element('h3', { className: 'sbpl-preset-heading', text: 'Installed in Neconyan' }));
        const list = element('ul', { className: 'sbpl-preset-list' });
        let shown = 0;
        for (const apiId of PRESET_API_IDS) {
            for (const name of listInstalledPresets(apiId, getContext())) {
                if (!matches(name, apiId)) {
                    continue;
                }
                shown += 1;
                const key = `${apiId}:${name}`;
                const item = element('li', { className: 'sbpl-preset-item' });
                const row = element('div', { className: 'sbpl-module-row' });
                const label = element('div', { className: 'sbpl-preset-label' });
                label.append(
                    element('span', { className: 'sbpl-preset-name', text: name }),
                    element('span', { className: 'sbpl-preset-meta', text: labelForApiId(apiId) }),
                );
                const actions = element('div', { className: 'sbpl-preset-actions' });
                actions.append(button('Copy to drafts', () => {
                    void copyToDrafts(apiId, name).catch((error) => {
                        status.textContent = errorMessage(error);
                    });
                }, { className: 'menu_button sbpl-button' }));
                if (isCcApiId(apiId)) {
                    actions.append(button(browsing === key ? 'Hide prompts' : 'Browse prompts', () => {
                        browsing = browsing === key ? '' : key;
                        renderLibrary();
                    }, {
                        className: 'menu_button sbpl-button',
                        title: `Copy single prompts out of "${name}" without copying the whole preset`,
                    }));
                }
                row.append(label, actions);
                item.append(row);
                if (browsing === key) {
                    item.append(renderInstalledModules(apiId, name));
                }
                list.append(item);
            }
        }
        if (!shown) {
            wrapper.append(emptyState('Nothing matches.', 'Clear the search box or choose another preset type.'));
            return wrapper;
        }
        wrapper.append(list);
        return wrapper;
    }

    /**
     * The prompt modules of one installed preset, read only, each with a copy
     * action. This is how a single prompt travels out of a preset you have
     * not copied into a draft.
     */
    function renderInstalledModules(apiId, name) {
        const panel = element('div', { className: 'sbpl-module-editor' });
        const payload = readInstalledPreset(apiId, name);
        if (!payload) {
            panel.append(element('p', {
                className: 'sbpl-field-hint',
                text: `"${name}" could not be read from Neconyan.`,
            }));
            return panel;
        }
        const modules = listPromptModules(payload);
        if (!modules.length) {
            panel.append(element('p', { className: 'sbpl-field-hint', text: 'This preset has no prompt modules.' }));
            return panel;
        }
        const list = element('ul', { className: 'sbpl-module-list' });
        for (const module of modules) {
            const { prompt } = module;
            const item = element('li', { className: 'sbpl-module-item' });
            const row = element('div', { className: 'sbpl-module-row' });
            const label = element('div', { className: 'sbpl-module-label' });
            label.append(
                element('span', { className: 'sbpl-module-name', text: prompt.name || prompt.identifier }),
                element('span', {
                    className: 'sbpl-module-meta',
                    text: canEditPrompt(prompt) ? (module.enabled ? '' : 'turned off') : 'filled in by Neconyan',
                }),
            );
            const actions = element('div', { className: 'sbpl-module-actions' });
            actions.append(button('Copy', () => {
                copyPrompt(prompt, `"${name}"`);
                status.textContent = `Copied "${prompt.name || prompt.identifier}" from "${name}". Paste it into the preset draft you are editing.`;
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
            if (canEditPrompt(prompt)) {
                actions.append(button('To Prompts tab', () => {
                    void saveModuleAsPrompt(prompt, name).catch((error) => {
                        status.textContent = errorMessage(error);
                    });
                }, {
                    className: 'menu_button sbpl-button sbpl-button-quiet',
                    title: 'Keep this prompt in the Prompts space, with its own drafts',
                }));
            }
            row.append(label, actions);
            item.append(row);
            list.append(item);
        }
        panel.append(list);
        return panel;
    }

    function describeDraft(draft) {
        if (draft.publishedAs) {
            return `${labelForApiId(draft.apiId)} · published as "${draft.publishedAs}"`;
        }
        if (draft.source?.name) {
            return `${labelForApiId(draft.apiId)} · copied from "${draft.source.name}"`;
        }
        return `${labelForApiId(draft.apiId)} · not published yet`;
    }

    function renderDrafts() {
        const wrapper = element('div', { className: 'sbpl-preset-group' });
        wrapper.append(element('h3', { className: 'sbpl-preset-heading', text: 'Your drafts' }));
        const shown = drafts.filter(draft => matches(draft.name, draft.apiId));
        if (!shown.length) {
            wrapper.append(emptyState(
                'No drafts here yet.',
                'Copy an installed preset, or start a new one, then publish it when you are happy with it.',
            ));
            return wrapper;
        }
        const list = element('ul', { className: 'sbpl-preset-list' });
        for (const draft of shown) {
            const item = element('li', { className: 'sbpl-preset-item' });
            const label = element('div', { className: 'sbpl-preset-label' });
            const meta = element('span', { className: 'sbpl-preset-meta', text: describeDraft(draft) });
            label.append(element('span', { className: 'sbpl-preset-name', text: draft.name }), meta);
            void markSourceChanges(draft, meta);
            const actions = element('div', { className: 'sbpl-preset-actions' });
            actions.append(
                button('Edit', () => {
                    editing = structuredClone(draft);
                    expanded = '';
                    renderEditor();
                }, { className: 'menu_button sbpl-button' }),
                button('Duplicate', async () => {
                    const source = structuredClone(draft);
                    const copy = createDraft({ ...source, id: undefined, name: `${source.name} (copy)`, publishedAs: '' });
                    const task = registerActiveTask('preset duplication');
                    try {
                        await storage.saveDraft(copy);
                        status.textContent = `Duplicated "${source.name}".`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button' }),
                button('Export', () => exportDraft(draft), { className: 'menu_button sbpl-button' }),
                confirmButton('Delete', async () => {
                    const draftId = draft.id;
                    const editor = editing;
                    const task = registerActiveTask('preset deletion');
                    try {
                        await storage.deleteDraft(draftId);
                        if (editing === editor && editing?.id === draftId) {
                            editing = null;
                        }
                        status.textContent = `Deleted "${draft.name}". Published copies in Neconyan are not affected.`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button', confirmLabel: 'Press again to delete' }),
            );
            item.append(label, actions);
            list.append(item);
        }
        wrapper.append(list);
        return wrapper;
    }

    /** Says so when the preset a draft was copied from has been changed since. */
    async function markSourceChanges(draft, meta) {
        if (!draft.source?.name || !draft.source.fingerprint) {
            return;
        }
        const installed = readInstalledPreset(draft.apiId, draft.source.name);
        if (!installed) {
            meta.textContent = `${meta.textContent}, which is no longer installed`;
            return;
        }
        if (await fingerprint(installed) !== draft.source.fingerprint) {
            meta.textContent = `${meta.textContent}, which has changed since`;
        }
    }

    function renderLibrary() {
        replace(libraryHost, renderInstalled(), renderDrafts());
    }

    /* ------------------------------------------------------------ editor */

    function renderEditor() {
        replace(editorHost);
        if (!editing) {
            return;
        }
        const form = element('div', { className: 'sbpl-editor' });

        const nameInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        nameInput.value = editing.name;
        nameInput.addEventListener('input', () => { editing.name = nameInput.value; });

        const kindSelect = element('select', { className: 'text_pole sbpl-select' });
        for (const apiId of PRESET_API_IDS) {
            kindSelect.append(element('option', { text: labelForApiId(apiId), attributes: { value: apiId } }));
        }
        kindSelect.value = editing.apiId;
        kindSelect.addEventListener('change', () => {
            editing.apiId = kindSelect.value;
            renderEditor();
        });

        const notesInput = element('textarea', { className: 'text_pole sbpl-textarea', attributes: { rows: '2' } });
        notesInput.value = editing.notes;
        notesInput.addEventListener('input', () => { editing.notes = notesInput.value; });

        const tagsInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        tagsInput.value = editing.tags.join(', ');
        tagsInput.addEventListener('input', () => {
            editing.tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
        });

        form.append(
            field('Name', nameInput),
            field('Kind', kindSelect),
            field('Notes', notesInput, { hint: 'For you only. Notes are never sent anywhere.' }),
            field('Tags', tagsInput, { hint: 'Separate tags with commas.' }),
            isCcApiId(editing.apiId) ? renderPromptModules() : renderFieldEditor(),
            renderRawEditor(),
        );

        const problems = element('ul', { className: 'sbpl-problems' });
        const actions = element('div', { className: 'sbpl-editor-actions' });
        actions.append(
            button('Save draft', async () => {
                if (publishing) {
                    return;
                }
                const editor = editing;
                const payload = structuredClone(editor);
                const found = validateDraft(payload);
                replace(problems, ...found.map(text => element('li', { text })));
                if (found.length) {
                    return;
                }
                const task = registerActiveTask('preset draft save');
                try {
                    const saved = await storage.saveDraft(payload);
                    if (editing === editor) {
                        editing = saved;
                    }
                    status.textContent = `Saved "${saved.name}".`;
                    await reload({ keepEditor: editing !== saved && Boolean(editing) });
                } finally {
                    task.release();
                }
            }, { className: 'menu_button menu_button_primary sbpl-button' }),
            button('Publish to Neconyan', () => {
                if (publishing) {
                    return;
                }
                const found = validateDraft(editing);
                replace(problems, ...found.map(text => element('li', { text })));
                if (!found.length) {
                    void publish().catch((error) => {
                        status.textContent = errorMessage(error);
                    });
                }
            }, { className: 'menu_button sbpl-button' }),
            button('Close', () => {
                editing = null;
                renderEditor();
            }, { className: 'menu_button sbpl-button' }),
        );
        form.append(problems, actions);
        editorHost.append(form);
    }

    function renderFieldEditor() {
        const wrapper = element('div', { className: 'sbpl-preset-fields' });
        const fields = PRESET_FIELDS[editing.apiId];
        if (!fields) {
            wrapper.append(element('p', {
                className: 'sbpl-field-hint',
                text: 'Sampler presets differ between backends, so they are edited as text below.',
            }));
            return wrapper;
        }
        for (const spec of fields) {
            wrapper.append(renderFieldControl(spec));
        }
        return wrapper;
    }

    function renderFieldControl(spec) {
        const current = editing.payload[spec.key];
        if (spec.type === 'boolean') {
            const input = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
            input.checked = Boolean(current);
            input.addEventListener('change', () => { editing.payload[spec.key] = input.checked; });
            const label = element('label', { className: 'sbpl-field sbpl-field-inline' });
            label.append(input, element('span', { className: 'sbpl-field-label', text: spec.label }));
            return label;
        }
        if (spec.type === 'prompt') {
            const { wrapper, textarea } = promptField(spec.label, { rows: spec.rows ?? 4 });
            textarea.value = typeof current === 'string' ? current : '';
            textarea.addEventListener('input', () => { editing.payload[spec.key] = textarea.value; });
            return wrapper;
        }
        const input = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: spec.type === 'number' ? 'number' : 'text' },
        });
        input.value = current === undefined || current === null ? '' : String(current);
        input.addEventListener('input', () => {
            editing.payload[spec.key] = spec.type === 'number' ? Number(input.value) : input.value;
        });
        return field(spec.label, input);
    }

    /* --------------------------------------------- chat completion modules */

    /** Keeps the paste button honest about what the clipboard holds. */
    function updatePasteButton() {
        // The button is updated even before it is attached: it is created
        // disabled-or-not from the clipboard state, then kept in sync.
        if (!pasteButton) {
            return;
        }
        const held = readClipboard();
        pasteButton.disabled = !held;
        pasteButton.title = held
            ? `Paste "${held.prompt.name || held.prompt.identifier}", copied from ${held.sourceName}`
            : 'Copy a prompt from another preset first';
    }

    function renderPromptModules() {
        const wrapper = element('div', { className: 'sbpl-modules' });
        const head = element('div', { className: 'sbpl-modules-head' });
        const paste = button('Paste', () => {
            const clip = readClipboard();
            const result = pastePromptModule(editing.payload, clip?.prompt);
            if (result.problem) {
                status.textContent = result.problem;
                return;
            }
            editing.payload = result.payload;
            status.textContent = `Pasted "${clip.prompt.name || clip.prompt.identifier}" from ${clip.sourceName}.`;
            renderEditor();
        }, { className: 'menu_button sbpl-button' });
        pasteButton = paste;
        updatePasteButton();
        head.append(
            element('p', { className: 'sbpl-field-label', text: 'Prompt modules' }),
            button('Add module', () => {
                const identifier = newId();
                editing.payload = addPromptModule(editing.payload, {
                    identifier,
                    name: 'New module',
                    role: 'system',
                    content: '',
                });
                expanded = identifier;
                renderEditor();
            }, { className: 'menu_button sbpl-button' }),
            paste,
        );
        wrapper.append(head, element('p', {
            className: 'sbpl-field-hint',
            text: 'The prompt is built from top to bottom. Turning a module off leaves it in the preset but keeps it out of the prompt. Copy takes one module to paste into another preset draft.',
        }));

        const modules = listPromptModules(editing.payload);
        if (!modules.length) {
            wrapper.append(emptyState('No prompt modules.', 'Add one, or paste a full preset into the text view below.'));
            return wrapper;
        }
        const list = element('ul', { className: 'sbpl-module-list' });
        modules.forEach((module, index) => {
            list.append(renderModule(module, index, modules.length));
        });
        wrapper.append(list);
        return wrapper;
    }

    function renderModule(module, index, total) {
        const { prompt } = module;
        const item = element('li', { className: 'sbpl-module-item' });

        const toggle = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        toggle.checked = module.enabled;
        toggle.setAttribute('aria-label', `Use ${prompt.name || prompt.identifier}`);
        toggle.addEventListener('change', () => {
            editing.payload = setPromptModuleEnabled(editing.payload, prompt.identifier, toggle.checked);
        });

        const label = element('div', { className: 'sbpl-module-label' });
        const tokens = element('span', { className: 'sbpl-module-meta', text: canEditPrompt(prompt) ? '' : 'filled in by Neconyan' });
        label.append(element('span', { className: 'sbpl-module-name', text: prompt.name || prompt.identifier }), tokens);
        if (canEditPrompt(prompt) && typeof prompt.content === 'string') {
            void countTokens(prompt.content).then((count) => {
                tokens.textContent = `${count.toLocaleString()} tokens`;
            }).catch(() => {});
        }

        const actions = element('div', { className: 'sbpl-module-actions' });
        const move = (offset, text) => button(text, () => {
            editing.payload = movePromptModule(editing.payload, prompt.identifier, offset);
            renderEditor();
        }, { className: 'menu_button sbpl-button sbpl-button-quiet', title: `Move ${prompt.name || prompt.identifier} ${offset < 0 ? 'up' : 'down'}` });
        const up = move(-1, 'Up');
        const down = move(1, 'Down');
        up.disabled = index === 0;
        down.disabled = index === total - 1;
        actions.append(up, down);
        if (canEditPrompt(prompt)) {
            actions.append(button(expanded === prompt.identifier ? 'Done' : 'Edit', () => {
                expanded = expanded === prompt.identifier ? '' : prompt.identifier;
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
        }
        actions.append(button('Copy', () => {
            copyPrompt(prompt, `"${editing.name}"`);
            status.textContent = `Copied "${prompt.name || prompt.identifier}". Paste it into any preset draft, or into this one.`;
        }, {
            className: 'menu_button sbpl-button sbpl-button-quiet',
            title: `Copy ${prompt.name || prompt.identifier} for pasting into another preset draft`,
        }));
        if (canEditPrompt(prompt) && canRemovePrompt(prompt)) {
            actions.append(button('Duplicate', () => {
                editing.payload = addPromptModule(editing.payload, {
                    ...structuredClone(prompt),
                    identifier: newId(),
                    name: `${prompt.name || prompt.identifier} (copy)`,
                });
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
        }
        if (canEditPrompt(prompt)) {
            actions.append(button('To Prompts tab', () => {
                void saveModuleAsPrompt(prompt, editing.name).catch((error) => {
                    status.textContent = errorMessage(error);
                });
            }, {
                className: 'menu_button sbpl-button sbpl-button-quiet',
                title: 'Keep this prompt in the Prompts space, with its own drafts',
            }));
        }
        if (canRemovePrompt(prompt)) {
            actions.append(button('Delete', () => {
                editing.payload = removePromptModule(editing.payload, prompt.identifier);
                if (expanded === prompt.identifier) {
                    expanded = '';
                }
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
        }

        const row = element('div', { className: 'sbpl-module-row' });
        row.append(toggle, label, actions);
        item.append(row);
        if (expanded === prompt.identifier) {
            item.append(renderModuleEditor(prompt));
        }
        return item;
    }

    function renderModuleEditor(prompt) {
        const wrapper = element('div', { className: 'sbpl-module-editor' });
        if (!canEditPrompt(prompt)) {
            wrapper.append(element('p', {
                className: 'sbpl-field-hint',
                text: 'Neconyan fills this module in from the character, the chat, or your settings. Only its position can be changed.',
            }));
            return wrapper;
        }
        const change = (changes) => {
            editing.payload = updatePromptModule(editing.payload, prompt.identifier, changes);
        };

        const nameInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        nameInput.value = prompt.name ?? '';
        nameInput.addEventListener('input', () => change({ name: nameInput.value }));
        wrapper.append(field('Module name', nameInput));

        const roleSelect = element('select', { className: 'text_pole sbpl-select' });
        for (const role of ROLES) {
            roleSelect.append(element('option', { text: role, attributes: { value: role } }));
        }
        roleSelect.value = ROLES.includes(prompt.role) ? prompt.role : 'system';
        roleSelect.addEventListener('change', () => change({ role: roleSelect.value }));
        wrapper.append(field('Speaking as', roleSelect));

        const { wrapper: contentWrapper, textarea } = promptField('Text', { rows: 6 });
        textarea.value = prompt.content ?? '';
        textarea.addEventListener('input', () => change({ content: textarea.value }));
        wrapper.append(contentWrapper);

        const positionSelect = element('select', { className: 'text_pole sbpl-select' });
        positionSelect.append(
            element('option', { text: 'In order, with the other modules', attributes: { value: '0' } }),
            element('option', { text: 'Inside the chat, at a set depth', attributes: { value: '1' } }),
        );
        positionSelect.value = String(prompt.injection_position === 1 ? 1 : 0);
        positionSelect.addEventListener('change', () => {
            change({ injection_position: Number(positionSelect.value) });
            renderEditor();
        });
        wrapper.append(field('Position', positionSelect));

        if (prompt.injection_position === 1) {
            const depthInput = element('input', {
                className: 'text_pole sbpl-input',
                attributes: { type: 'number', min: '0' },
            });
            depthInput.value = String(prompt.injection_depth ?? 4);
            depthInput.addEventListener('input', () => change({ injection_depth: Number(depthInput.value) }));
            wrapper.append(field('Depth', depthInput, {
                hint: 'How many messages up from the end of the chat this module sits.',
            }));
        }
        return wrapper;
    }

    /* -------------------------------------------------------- text view */

    function renderRawEditor() {
        const details = element('details', { className: 'sbpl-raw' });
        details.open = rawOpen;
        details.addEventListener('toggle', () => { rawOpen = details.open; });
        details.append(element('summary', { text: 'All settings (text)' }));
        const { wrapper, textarea } = promptField('Preset contents', { rows: 12, macros: false, hint: 'Every setting this preset holds, including the ones without their own control above.' });
        textarea.value = JSON.stringify(editing.payload, null, 2);
        const note = element('p', { className: 'sbpl-field-hint', text: '' });
        textarea.addEventListener('change', () => {
            try {
                const parsed = JSON.parse(textarea.value);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    note.textContent = 'A preset has to be a set of settings.';
                    return;
                }
                editing.payload = parsed;
                // The editor is rebuilt to show the pasted settings, so the
                // confirmation has to outlive this note.
                status.textContent = 'Applied the text to this draft. The controls above now show it.';
                renderEditor();
            } catch {
                note.textContent = 'That is not valid preset text, so nothing was changed.';
            }
        });
        details.append(wrapper, note);
        return details;
    }

    /* -------------------------------------------------- publish and share */

    async function publish() {
        if (publishing || !editing || !root) {
            return;
        }
        const task = registerActiveTask('preset publish');
        const publishingRoot = root;
        const controls = [...publishingRoot.querySelectorAll('.sbpl-editor-actions button')]
            .filter(control => !control.disabled);
        publishing = true;
        publishingRoot.inert = true;
        for (const control of controls) {
            control.disabled = true;
        }
        try {
            const editor = editing;
            const draft = await storage.saveDraft(structuredClone(editor));
            const published = await runPromptingLab('publish', { draftId: draft.id, version: await fingerprint(draft) }, { signal: task.signal });
            const savedName = published.name;
            if (task.signal.aborted) {
                return;
            }
            const saved = published.draft;
            if (editing === editor) {
                editing = saved;
            }
            status.textContent = `Published "${savedName}". Neconyan reads its preset lists while starting, so reload before using it.`;
            replace(
                reloadHost,
                button('Reload Neconyan', () => {
                    globalThis.location?.reload?.();
                }, { className: 'menu_button menu_button_primary sbpl-button' }),
                element('p', {
                    className: 'sbpl-field-hint',
                    text: 'Your lab drafts are saved, but reloading discards anything unsaved elsewhere in Neconyan, such as an unsent message.',
                }),
            );
            await reload({ keepEditor: editing !== saved && Boolean(editing) });
        } finally {
            publishing = false;
            publishingRoot.inert = false;
            for (const control of controls) {
                control.disabled = false;
            }
            task.release();
        }
    }

    function exportDraft(draft) {
        const fields = reviewConnectionFields(draft.apiId, draft.payload);
        if (!fields.length) {
            download(draft, draft.payload);
            return;
        }
        editing = null;
        renderEditor();
        const panel = element('div', { className: 'sbpl-review' });
        panel.append(
            element('h3', { className: 'sbpl-preset-heading', text: `Before sharing "${draft.name}"` }),
            element('p', {
                text: 'This preset holds settings that describe where your requests go. They are left out unless you tick them.',
            }),
        );
        const list = element('ul', { className: 'sbpl-review-list' });
        const keep = new Set();
        for (const entry of fields) {
            const input = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
            input.addEventListener('change', () => {
                if (input.checked) {
                    keep.add(entry.field);
                } else {
                    keep.delete(entry.field);
                }
            });
            const item = element('li', { className: 'sbpl-review-item' });
            const label = element('label', { className: 'sbpl-field sbpl-field-inline' });
            label.append(input, element('span', {
                className: 'sbpl-field-label',
                text: entry.sensitive ? `${entry.field} (private)` : entry.field,
            }));
            item.append(label, element('span', { className: 'sbpl-preset-meta', text: entry.value }));
            list.append(item);
        }
        const actions = element('div', { className: 'sbpl-editor-actions' });
        actions.append(
            button('Export', () => {
                const dropped = fields.map(entry => entry.field).filter(name => !keep.has(name));
                download(draft, withoutFields(draft.payload, dropped));
                replace(editorHost);
            }, { className: 'menu_button menu_button_primary sbpl-button' }),
            button('Cancel', () => replace(editorHost), { className: 'menu_button sbpl-button' }),
        );
        panel.append(list, actions);
        editorHost.append(panel);
    }

    function download(draft, payload) {
        const text = JSON.stringify(withCanonicalName(draft.apiId, payload, draft.name), null, 4);
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = element('a', { attributes: { href: url, download: `${draft.name.replace(/[^\w.-]+/g, '_')}.json` } });
        link.click();
        URL.revokeObjectURL(url);
        status.textContent = `Exported "${draft.name}". It can be imported here or by Neconyan itself.`;
    }

    async function importFile(file) {
        const editor = editing;
        const task = registerActiveTask('preset import');
        try {
            const text = await file.text();
            const payload = JSON.parse(text);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                throw new Error('That file does not hold a preset.');
            }
            const draft = createDraft({
                apiId: guessApiId(payload),
                name: String(payload.name || file.name.replace(/\.json$/i, '')),
                payload,
            });
            await storage.saveDraft(draft);
            if (editing === editor) {
                editing = draft;
                expanded = '';
            }
            status.textContent = `Imported "${draft.name}" as a draft. Check the kind is right, then publish it.`;
            await reload();
        } finally {
            task.release();
        }
    }

    function renderAll({ keepEditor = false } = {}) {
        renderLibrary();
        // A background refresh must not rebuild the editor mid-keystroke or
        // wipe an open export review panel.
        if (!(keepEditor && editorHost.hasChildNodes())) {
            renderEditor();
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-presets-tab' });

        const controls = element('div', { className: 'sbpl-controls' });
        searchInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'search', placeholder: 'Search presets', 'aria-label': 'Search presets' },
        });
        searchInput.addEventListener('input', renderLibrary);
        typeSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Preset type' },
        });
        typeSelect.append(element('option', { text: 'Every kind', attributes: { value: '' } }));
        for (const apiId of PRESET_API_IDS) {
            typeSelect.append(element('option', { text: labelForApiId(apiId), attributes: { value: apiId } }));
        }
        typeSelect.addEventListener('change', renderLibrary);

        const fileInput = element('input', {
            className: 'sbpl-file-input',
            attributes: { type: 'file', accept: 'application/json,.json', 'aria-label': 'Preset file to import' },
        });
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (file) {
                void importFile(file)
                    .catch((error) => { status.textContent = errorMessage(error); })
                    .finally(() => { fileInput.value = ''; });
            }
        });

        controls.append(
            searchInput,
            typeSelect,
            button('New draft', async () => {
                const editor = editing;
                const apiId = typeSelect.value || 'openai';
                const name = `Draft ${drafts.length + 1}`;
                const draft = createDraft({
                    apiId,
                    name,
                    payload: blankPayload(apiId, name),
                });
                const task = registerActiveTask('preset draft creation');
                try {
                    await storage.saveDraft(draft);
                    if (editing === editor) {
                        editing = draft;
                        expanded = '';
                    }
                    await reload();
                } finally {
                    task.release();
                }
            }, { className: 'menu_button menu_button_primary sbpl-button' }),
        );

        status = statusRegion('');
        reloadHost = element('div', { className: 'sbpl-reload-host' });
        libraryHost = element('div', { className: 'sbpl-preset-library' });
        editorHost = element('div', { className: 'sbpl-editor-host' });
        root.append(controls, field('Import a preset file', fileInput), status, reloadHost, libraryHost, editorHost);
        // Updating the button in place keeps focus and open panels intact
        // when something is copied elsewhere in the lab.
        unsubscribeClipboard = onClipboardChange(updatePasteButton);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved drafts could not be loaded: ${errorMessage(error)}`;
                });
            }
            return root;
        },
        refresh() {
            void reload({ keepEditor: true }).catch(() => {});
        },
        dispose() {
            reloadEpoch++;
            unsubscribeClipboard?.();
            unsubscribeClipboard = null;
            pasteButton = null;
            root?.remove();
            root = null;
        },
    };
}

/**
 * Works out which kind of preset a file holds from the settings it carries.
 * The kind can still be corrected in the editor.
 */
export function guessApiId(payload) {
    if (payload.prompts || payload.prompt_order || payload.chat_completion_source) {
        return 'openai';
    }
    if (payload.story_string !== undefined) {
        return 'context';
    }
    if (payload.input_sequence !== undefined || payload.output_sequence !== undefined) {
        return 'instruct';
    }
    if (payload.post_history !== undefined || (payload.content !== undefined && payload.prefix === undefined)) {
        return 'sysprompt';
    }
    if (payload.prefix !== undefined && payload.suffix !== undefined) {
        return 'reasoning';
    }
    return 'textgenerationwebui';
}
