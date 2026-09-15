import { copyPrompt } from '../clipboard.js';
import { button, confirmButton, element, emptyState, errorMessage, field, formatTokens, promptField, replace, statusRegion } from '../dom.js';
import { countTokens } from '../host.js';
import { registerActiveTask } from '../operations.js';
import {
    addVersion,
    draftToModule,
    getSelectedVersion,
    removeVersion,
    selectVersion,
    updateVersion,
} from '../prompt-drafts.js';
import { addPromptModule } from '../presets.js';
import { createPromptDraft, validatePromptDraft } from '../schema.js';
import * as storage from '../storage.js';

const ROLES = ['system', 'user', 'assistant'];

/**
 * The Prompts space: titled prompts kept on their own, outside any preset.
 * Each prompt can hold several draft versions of its text; the selected
 * version is what gets copied, sent to a preset, or compared. Prompts here
 * are never part of a built prompt until they are sent to a preset.
 */
export function createPromptsTab({ onChanged = null } = {}) {
    let root = null;
    let searchInput = null;
    let listHost = null;
    let editorHost = null;
    let status = null;

    let prompts = [];
    let presetDrafts = [];
    let editing = null;
    let expandedVersion = '';
    let reloadEpoch = 0;

    async function reload({ keepEditor = false } = {}) {
        const epoch = ++reloadEpoch;
        const [nextPrompts, drafts] = await Promise.all([
            storage.listPromptDrafts(),
            storage.listDrafts(),
        ]);
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        prompts = nextPrompts;
        presetDrafts = drafts.filter(draft => draft.apiId === 'openai');
        renderAll({ keepEditor });
    }

    function matches(prompt) {
        const term = searchInput.value.trim().toLowerCase();
        if (!term) {
            return true;
        }
        return [prompt.title, prompt.notes, ...prompt.tags]
            .some(value => value.toLowerCase().includes(term));
    }

    function describePrompt(prompt) {
        const selected = getSelectedVersion(prompt);
        const count = prompt.versions.length;
        const drafts = count === 1 ? '1 draft' : `${count} drafts`;
        return `${prompt.role} · ${drafts} · selected: ${selected?.label ?? ''}`;
    }

    function renderList() {
        const shown = prompts.filter(prompt => matches(prompt));
        if (!shown.length) {
            replace(listHost, emptyState(
                prompts.length ? 'Nothing matches.' : 'No prompts here yet.',
                prompts.length
                    ? 'Clear the search box to see every prompt.'
                    : 'Write a prompt once, keep several drafts of it, and send the one you pick to a preset.',
            ));
            return;
        }
        const list = element('ul', { className: 'sbpl-preset-list' });
        for (const prompt of shown) {
            const item = element('li', { className: 'sbpl-preset-item' });
            const label = element('div', { className: 'sbpl-preset-label' });
            label.append(
                element('span', { className: 'sbpl-preset-name', text: prompt.title }),
                element('span', { className: 'sbpl-preset-meta', text: describePrompt(prompt) }),
            );
            const actions = element('div', { className: 'sbpl-preset-actions' });
            actions.append(
                button('Edit', () => {
                    editing = structuredClone(prompt);
                    expandedVersion = '';
                    renderEditor();
                }, { className: 'menu_button sbpl-button' }),
                button('Duplicate', async () => {
                    const source = structuredClone(prompt);
                    const copy = createPromptDraft({
                        ...source,
                        id: undefined,
                        title: `${source.title} (copy)`,
                    });
                    const task = registerActiveTask('prompt duplication');
                    try {
                        await storage.savePromptDraft(copy);
                        onChanged?.();
                        status.textContent = `Duplicated "${source.title}".`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button' }),
                confirmButton('Delete', async () => {
                    const promptId = prompt.id;
                    const editor = editing;
                    const task = registerActiveTask('prompt deletion');
                    try {
                        await storage.deletePromptDraft(promptId);
                        if (editing === editor && editing?.id === promptId) {
                            editing = null;
                        }
                        onChanged?.();
                        status.textContent = `Deleted "${prompt.title}" and every draft it held.`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button', confirmLabel: 'Press again to delete' }),
            );
            item.append(label, actions);
            list.append(item);
        }
        replace(listHost, list);
    }

    /* ------------------------------------------------------------ editor */

    function renderEditor() {
        replace(editorHost);
        if (!editing) {
            return;
        }
        const form = element('div', { className: 'sbpl-editor' });

        const titleInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        titleInput.value = editing.title;
        titleInput.addEventListener('input', () => { editing.title = titleInput.value; });

        const roleSelect = element('select', { className: 'text_pole sbpl-select' });
        for (const role of ROLES) {
            roleSelect.append(element('option', { text: role, attributes: { value: role } }));
        }
        roleSelect.value = editing.role;
        roleSelect.addEventListener('change', () => { editing.role = roleSelect.value; });

        const notesInput = element('textarea', { className: 'text_pole sbpl-textarea', attributes: { rows: '2' } });
        notesInput.value = editing.notes;
        notesInput.addEventListener('input', () => { editing.notes = notesInput.value; });

        const tagsInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        tagsInput.value = editing.tags.join(', ');
        tagsInput.addEventListener('input', () => {
            editing.tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
        });

        form.append(
            field('Title', titleInput),
            field('Speaking as', roleSelect, { hint: 'The role this prompt uses when it becomes a preset module.' }),
            field('Notes', notesInput, { hint: 'For you only. Notes are never sent anywhere.' }),
            field('Tags', tagsInput, { hint: 'Separate tags with commas.' }),
            renderVersions(),
            renderSendToPreset(),
        );

        const problems = element('ul', { className: 'sbpl-problems' });
        const actions = element('div', { className: 'sbpl-editor-actions' });
        actions.append(
            button('Save prompt', async () => {
                const editor = editing;
                const payload = structuredClone(editor);
                const found = validatePromptDraft(payload);
                replace(problems, ...found.map(text => element('li', { text })));
                if (found.length) {
                    return;
                }
                const task = registerActiveTask('prompt save');
                try {
                    const saved = await storage.savePromptDraft(payload);
                    if (editing === editor) {
                        editing = saved;
                    }
                    onChanged?.();
                    status.textContent = `Saved "${saved.title}".`;
                    await reload({ keepEditor: editing !== saved && Boolean(editing) });
                } finally {
                    task.release();
                }
            }, { className: 'menu_button menu_button_primary sbpl-button' }),
            button('Copy for pasting', () => {
                copyPrompt(draftToModule(editing), `prompt "${editing.title}"`);
                status.textContent = `Copied "${editing.title}". Paste it into a preset draft on the Presets tab.`;
            }, {
                className: 'menu_button sbpl-button',
                title: 'Copy the selected draft so it can be pasted into a preset',
            }),
            button('Close', () => {
                editing = null;
                renderEditor();
            }, { className: 'menu_button sbpl-button' }),
        );
        form.append(problems, actions);
        editorHost.append(form);
    }

    function renderVersions() {
        const wrapper = element('div', { className: 'sbpl-modules' });
        const head = element('div', { className: 'sbpl-modules-head' });
        head.append(
            element('p', { className: 'sbpl-field-label', text: 'Draft versions' }),
            button('Add draft', () => {
                editing = addVersion(editing);
                expandedVersion = editing.selectedVersionId;
                renderEditor();
            }, {
                className: 'menu_button sbpl-button',
                title: 'Start a new draft from the selected one',
            }),
        );
        wrapper.append(head, element('p', {
            className: 'sbpl-field-hint',
            text: 'Keep as many drafts of this prompt as you like. The selected draft is the one that gets copied, sent to a preset, or compared.',
        }));

        const list = element('ul', { className: 'sbpl-module-list' });
        for (const version of editing.versions) {
            list.append(renderVersion(version));
        }
        wrapper.append(list);
        return wrapper;
    }

    function renderVersion(version) {
        const item = element('li', { className: 'sbpl-module-item' });

        const pick = element('input', {
            className: 'sbpl-checkbox',
            attributes: { type: 'radio', name: 'sbpl-prompt-version' },
        });
        pick.checked = version.id === editing.selectedVersionId;
        pick.setAttribute('aria-label', `Select ${version.label}`);
        pick.addEventListener('change', () => {
            editing = selectVersion(editing, version.id);
        });

        const label = element('div', { className: 'sbpl-module-label' });
        const tokens = element('span', { className: 'sbpl-module-meta' });
        label.append(element('span', { className: 'sbpl-module-name', text: version.label }), tokens);
        void countTokens(version.content).then((count) => {
            if (count !== null) {
                tokens.textContent = `${formatTokens(count)} tokens`;
            }
        }).catch(() => {});

        const actions = element('div', { className: 'sbpl-module-actions' });
        actions.append(
            button(expandedVersion === version.id ? 'Done' : 'Edit', () => {
                expandedVersion = expandedVersion === version.id ? '' : version.id;
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
            button('Duplicate', () => {
                editing = addVersion(editing, {
                    label: `${version.label} (copy)`,
                    content: version.content,
                });
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
        );
        if (editing.versions.length > 1) {
            actions.append(button('Delete', () => {
                editing = removeVersion(editing, version.id);
                if (expandedVersion === version.id) {
                    expandedVersion = '';
                }
                renderEditor();
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
        }

        const row = element('div', { className: 'sbpl-module-row' });
        row.append(pick, label, actions);
        item.append(row);
        if (expandedVersion === version.id) {
            item.append(renderVersionEditor(version));
        }
        return item;
    }

    function renderVersionEditor(version) {
        const wrapper = element('div', { className: 'sbpl-module-editor' });

        const labelInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        labelInput.value = version.label;
        labelInput.addEventListener('input', () => {
            editing = updateVersion(editing, version.id, { label: labelInput.value });
        });
        wrapper.append(field('Draft label', labelInput));

        const { wrapper: contentWrapper, textarea } = promptField('Text', { rows: 6 });
        textarea.value = version.content;
        textarea.addEventListener('input', () => {
            editing = updateVersion(editing, version.id, { content: textarea.value });
        });
        wrapper.append(contentWrapper);
        return wrapper;
    }

    /* ---------------------------------------------------- send to preset */

    function renderSendToPreset() {
        const wrapper = element('div', { className: 'sbpl-send-to-preset' });
        wrapper.append(element('p', { className: 'sbpl-field-label', text: 'Send to a preset' }));
        if (!presetDrafts.length) {
            wrapper.append(element('p', {
                className: 'sbpl-field-hint',
                text: 'No Chat Completion drafts to send to yet. Copy or create one on the Presets tab first.',
            }));
            return wrapper;
        }
        const targetSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Preset draft to send this prompt to' },
        });
        for (const draft of presetDrafts) {
            targetSelect.append(element('option', { text: draft.name, attributes: { value: draft.id } }));
        }
        const controls = element('div', { className: 'sbpl-controls' });
        controls.append(
            targetSelect,
            button('Send selected draft', () => {
                void sendToPreset(targetSelect.value).catch((error) => {
                    status.textContent = errorMessage(error);
                });
            }, { className: 'menu_button sbpl-button' }),
        );
        wrapper.append(controls, element('p', {
            className: 'sbpl-field-hint',
            text: 'Adds the selected draft as a new module at the end of that preset draft. The preset itself is not published.',
        }));
        return wrapper;
    }

    async function sendToPreset(draftId) {
        const targetId = draftId;
        const prompt = structuredClone(editing);
        const module = draftToModule(prompt);
        const task = registerActiveTask('prompt send to preset');
        try {
            const target = await storage.getDraft(targetId);
            if (!target) {
                status.textContent = 'That preset draft could not be loaded.';
                return;
            }
            target.payload = addPromptModule(target.payload, module);
            await storage.saveDraft(target);
            status.textContent = `Sent "${prompt.title}" to "${target.name}". Open it on the Presets tab to review.`;
            onChanged?.();
            await reload();
        } finally {
            task.release();
        }
    }

    function renderAll({ keepEditor = false } = {}) {
        renderList();
        // A background refresh must not rebuild the editor mid-keystroke.
        if (!(keepEditor && editorHost.hasChildNodes())) {
            renderEditor();
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-prompts-tab' });

        const controls = element('div', { className: 'sbpl-controls' });
        searchInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'search', placeholder: 'Search prompts', 'aria-label': 'Search prompts' },
        });
        searchInput.addEventListener('input', renderList);
        controls.append(
            searchInput,
            button('New prompt', async () => {
                const editor = editing;
                const draft = createPromptDraft({ title: `Prompt ${prompts.length + 1}` });
                const task = registerActiveTask('prompt creation');
                try {
                    await storage.savePromptDraft(draft);
                    if (editing === editor) {
                        editing = draft;
                        expandedVersion = draft.selectedVersionId;
                    }
                    onChanged?.();
                    await reload();
                } finally {
                    task.release();
                }
            }, { className: 'menu_button menu_button_primary sbpl-button' }),
        );

        status = statusRegion('');
        listHost = element('div', { className: 'sbpl-preset-library' });
        editorHost = element('div', { className: 'sbpl-editor-host' });
        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'A space for prompts on their own, outside any preset. Keep several drafts of each prompt, pick the one you mean, and send it to a preset when it is ready.',
            }),
            controls,
            status,
            listHost,
            editorHost,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved prompts could not be loaded: ${errorMessage(error)}`;
                });
            }
            return root;
        },
        refresh() {
            void reload({ keepEditor: true }).catch(() => {});
        },
        dispose() {
            reloadEpoch++;
            root?.remove();
            root = null;
        },
    };
}
