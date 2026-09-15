import { ASSERTION, ASSERTION_LABEL, SECTION_LABEL } from '../constants.js';
import { button, confirmButton, element, emptyState, errorMessage, field, promptField, replace, statusRegion } from '../dom.js';
import { getContext } from '../host.js';
import * as lab from '../lab.js';
import { registerActiveTask } from '../operations.js';
import { MODE, PRESET_API_IDS, labelForApiId, modeOf } from '../presets.js';
import { createCase, createSuite, pinnedMode, validateCase } from '../schema.js';
import * as storage from '../storage.js';
import { avatarThumbnail, createCharacterPicker } from './character-picker.js';

const SCOPES = ['total', 'system', 'final'];

/**
 * Lists suites and their test cases, and edits one case at a time.
 * Every pin is chosen from what is actually installed, so a case cannot be
 * written that names a character or preset that does not exist.
 */
export function createCasesTab({ onChanged = null, onQuickRun = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let searchInput = null;
    let listHost = null;
    let characterNames = new Map();
    let editorHost = null;
    let status = null;

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let editing = null;
    let selected = new Set();
    let reloadEpoch = 0;

    async function reload({ keepEditor = false, preferredSuiteId = '' } = {}) {
        const epoch = ++reloadEpoch;
        const suiteId = preferredSuiteId || activeSuite?.id;
        const nextSuites = await storage.listSuites();
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        const nextSuite = nextSuites.find(suite => suite.id === suiteId) ?? nextSuites[0] ?? null;
        const nextCases = nextSuite ? await lab.getSuiteCases(nextSuite) : [];
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        suites = nextSuites;
        activeSuite = nextSuite;
        cases = nextCases;
        selected = new Set([...selected].filter(id => cases.some(item => item.id === id)));
        renderAll({ keepEditor });
        onChanged?.();
    }

    function renderSuiteSelect() {
        replace(suiteSelect, ...suites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        suiteSelect.disabled = suites.length === 0;
    }

    function visibleCases() {
        const term = searchInput.value.trim().toLowerCase();
        if (!term) {
            return cases;
        }
        return cases.filter(testCase => [
            testCase.name,
            testCase.notes,
            testCase.tags.join(' '),
            testCase.pins.characterAvatar,
            testCase.pins.presets.map(ref => ref.name).join(' '),
        ].join(' ').toLowerCase().includes(term));
    }

    /** Names for the avatars a case pins, so a list reads as people not files. */
    function refreshCharacterNames() {
        try {
            characterNames = new Map(lab.readAvailableOptions(getContext())
                .characters.map(item => [item.avatar, item.name]));
        } catch {
            characterNames = new Map();
        }
    }

    function characterName(testCase) {
        const avatar = testCase?.pins?.characterAvatar ?? '';
        return characterNames.get(avatar) || avatar;
    }

    function describeCase(testCase) {
        const parts = [characterName(testCase) || 'no character'];
        for (const ref of testCase.pins.presets) {
            parts.push(ref.name);
        }
        parts.push(`${testCase.assertions.length} check${testCase.assertions.length === 1 ? '' : 's'}`);
        if (testCase.tags.length) {
            parts.push(testCase.tags.join(', '));
        }
        return parts.join(' · ');
    }

    function renderList() {
        replace(listHost);
        refreshCharacterNames();
        if (!activeSuite) {
            listHost.append(emptyState(
                'No test suites yet.',
                'A suite is a group of test cases you run together, such as every character that uses one preset.',
            ));
            return;
        }
        if (!cases.length) {
            listHost.append(emptyState(
                'This suite has no test cases yet.',
                'A test case pins a character and the settings it uses, then checks the prompt they produce.',
            ));
            return;
        }
        const shown = visibleCases();
        if (!shown.length) {
            listHost.append(emptyState('Nothing matches.', 'Clear the search box to see every test case again.'));
            return;
        }

        const list = element('ul', { className: 'sbpl-case-list' });
        for (const testCase of shown) {
            const suiteId = activeSuite.id;
            const item = element('li', { className: 'sbpl-case-item' });

            const pick = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
            pick.checked = selected.has(testCase.id);
            pick.setAttribute('aria-label', `Select ${testCase.name}`);
            pick.addEventListener('change', () => {
                if (pick.checked) {
                    selected.add(testCase.id);
                } else {
                    selected.delete(testCase.id);
                }
                renderList();
            });

            const label = element('div', { className: 'sbpl-case-label' });
            const name = element('span', { className: 'sbpl-case-name' });
            name.append(
                avatarThumbnail(testCase.pins.characterAvatar, characterName(testCase), 'sbpl-row-avatar'),
                element('span', { text: testCase.name }),
            );
            label.append(
                name,
                element('span', { className: 'sbpl-case-meta', text: describeCase(testCase) }),
            );

            const actions = element('div', { className: 'sbpl-case-actions' });
            actions.append(
                button('Edit', () => {
                    editing = structuredClone(testCase);
                    renderEditor();
                }, { className: 'menu_button sbpl-button' }),
                button('Duplicate', () => {
                    void duplicate([testCase]);
                }, { className: 'menu_button sbpl-button' }),
                confirmButton('Delete', async () => {
                    const caseId = testCase.id;
                    const editor = editing;
                    const task = registerActiveTask('case deletion');
                    try {
                        await storage.deleteCase(caseId);
                        if (editing === editor && editing?.id === caseId) {
                            editing = null;
                        }
                        status.textContent = `Deleted "${testCase.name}". Its saved runs went with it.`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button', confirmLabel: 'Press again to delete' }),
            );
            if (onQuickRun) {
                actions.prepend(button('Run this one', () => onQuickRun({
                    ...structuredClone(testCase),
                    suiteId,
                }), {
                    className: 'menu_button sbpl-button',
                }));
            }
            item.append(pick, label, actions);
            list.append(item);
        }
        listHost.append(renderBulkBar(shown), list);
    }

    function renderBulkBar(shown) {
        const bar = element('div', { className: 'sbpl-bulk' });
        const all = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        all.checked = shown.length > 0 && shown.every(testCase => selected.has(testCase.id));
        all.setAttribute('aria-label', 'Select every test case shown');
        all.addEventListener('change', () => {
            for (const testCase of shown) {
                if (all.checked) {
                    selected.add(testCase.id);
                } else {
                    selected.delete(testCase.id);
                }
            }
            renderList();
        });
        bar.append(all, element('span', {
            className: 'sbpl-case-meta',
            text: selected.size ? `${selected.size} selected` : 'Select test cases to work on several at once',
        }));
        if (selected.size) {
            const chosen = () => cases.filter(testCase => selected.has(testCase.id));
            const tagInput = element('input', {
                className: 'text_pole sbpl-input',
                attributes: { type: 'text', placeholder: 'Tag', 'aria-label': 'Tag to add' },
            });
            bar.append(
                button('Duplicate', () => { void duplicate(chosen()); }, { className: 'menu_button sbpl-button' }),
                tagInput,
                button('Add tag', async () => {
                    const tag = tagInput.value.trim();
                    if (!tag) {
                        return;
                    }
                    const chosenCases = chosen().map(testCase => structuredClone(testCase));
                    const task = registerActiveTask('case tagging');
                    try {
                        for (const testCase of chosenCases) {
                            if (!testCase.tags.includes(tag)) {
                                await storage.saveCase({ ...testCase, tags: [...testCase.tags, tag] });
                            }
                        }
                        status.textContent = `Tagged ${chosenCases.length} test case${chosenCases.length === 1 ? '' : 's'} with "${tag}".`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button' }),
                confirmButton('Delete', async () => {
                    const chosenCases = chosen().map(testCase => structuredClone(testCase));
                    const count = chosenCases.length;
                    const task = registerActiveTask('case bulk deletion');
                    try {
                        for (const testCase of chosenCases) {
                            await storage.deleteCase(testCase.id);
                        }
                        selected.clear();
                        editing = null;
                        status.textContent = `Deleted ${count} test case${count === 1 ? '' : 's'}, along with their saved runs.`;
                        await reload();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button', confirmLabel: 'Press again to delete' }),
            );
        }
        return bar;
    }

    async function duplicate(list) {
        const suiteId = activeSuite?.id;
        const sourceCases = list.map(testCase => structuredClone(testCase));
        if (!suiteId || !sourceCases.length) {
            return;
        }
        const task = registerActiveTask('case duplication');
        try {
            const ids = [];
            for (const testCase of sourceCases) {
                const copy = createCase({ ...structuredClone(testCase), id: undefined, name: `${testCase.name} (copy)` });
                const saved = await storage.saveCase(copy);
                ids.push(saved.id);
            }
            await storage.updateSuite(suiteId, (suite) => {
                suite.caseIds.push(...ids.filter(id => !suite.caseIds.includes(id)));
            });
            status.textContent = `Duplicated ${sourceCases.length} test case${sourceCases.length === 1 ? '' : 's'}.`;
            await reload();
        } finally {
            task.release();
        }
    }

    function optionList(select, items, { valueKey, labelKey, includeBlank = '' }) {
        const options = [];
        if (includeBlank) {
            options.push(element('option', { text: includeBlank, attributes: { value: '' } }));
        }
        for (const item of items) {
            options.push(element('option', {
                text: String(item[labelKey]),
                attributes: { value: String(item[valueKey]) },
            }));
        }
        replace(select, ...options);
    }

    /* ------------------------------------------------------------ editor */

    function renderEditor() {
        replace(editorHost);
        if (!editing) {
            return;
        }
        const options = lab.readAvailableOptions(getContext());
        const form = element('div', { className: 'sbpl-editor' });

        const nameInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        nameInput.value = editing.name;
        nameInput.addEventListener('input', () => { editing.name = nameInput.value; });

        const characterPicker = createCharacterPicker({ label: 'Character' });
        characterPicker.setOptions(options.characters.map(item => ({ value: item.avatar, name: item.name })));
        characterPicker.setValue(editing.pins.characterAvatar);
        characterPicker.input.addEventListener('change', () => {
            editing.pins.characterAvatar = characterPicker.value;
        });

        const personaSelect = element('select', { className: 'text_pole sbpl-select' });
        const personas = [...options.personas];
        const pinnedPersona = editing.pins.personaKey;
        if (pinnedPersona && !personas.some(persona => persona.key === pinnedPersona)) {
            personas.push({ key: pinnedPersona, name: `${pinnedPersona} (not installed)` });
        }
        optionList(personaSelect, personas, {
            valueKey: 'key',
            labelKey: 'name',
            includeBlank: 'Leave the persona as it is',
        });
        personaSelect.value = editing.pins.personaKey ?? '';
        personaSelect.addEventListener('change', () => {
            editing.pins.personaKey = personaSelect.value || null;
        });

        const profileSelect = element('select', { className: 'text_pole sbpl-select' });
        const profiles = [...options.profiles];
        const pinnedProfile = editing.pins.connectionProfileId;
        if (pinnedProfile && !profiles.some(profile => profile.id === pinnedProfile)) {
            profiles.push({ id: pinnedProfile, name: `${pinnedProfile} (not installed)` });
        }
        optionList(profileSelect, profiles, {
            valueKey: 'id',
            labelKey: 'name',
            includeBlank: 'Leave the connection as it is',
        });
        profileSelect.value = editing.pins.connectionProfileId;
        profileSelect.addEventListener('change', () => {
            editing.pins.connectionProfileId = profileSelect.value;
        });

        const promptTagsSelect = element('select', { className: 'text_pole sbpl-select' });
        const promptTags = [...options.promptTagsProfiles];
        const pinnedPromptTags = editing.pins.promptTags;
        if (pinnedPromptTags?.profileName && !promptTags.some(profile => profile.name === pinnedPromptTags.profileName)) {
            promptTags.push({
                name: pinnedPromptTags.profileName,
                id: pinnedPromptTags.profileId,
            });
        }
        optionList(promptTagsSelect, promptTags, {
            valueKey: 'name',
            labelKey: 'name',
            includeBlank: 'Leave Prompt Tags as it is',
        });
        promptTagsSelect.value = pinnedPromptTags?.profileName ?? '';
        promptTagsSelect.disabled = !options.promptTagsProfiles.length && !pinnedPromptTags?.profileName;
        promptTagsSelect.addEventListener('change', () => {
            const profile = options.promptTagsProfiles.find(item => item.name === promptTagsSelect.value);
            if (profile) {
                editing.pins.promptTags = { profileId: profile.id, profileName: profile.name };
            } else if (promptTagsSelect.value === '') {
                editing.pins.promptTags = null;
            } else if (pinnedPromptTags?.profileName === promptTagsSelect.value) {
                // The pinned profile is not installed right now; re-choosing
                // it restores the original pin rather than losing it.
                editing.pins.promptTags = { ...pinnedPromptTags };
            }
        });

        const notesInput = element('textarea', { className: 'text_pole sbpl-textarea', attributes: { rows: '2' } });
        notesInput.value = editing.notes;
        notesInput.addEventListener('input', () => { editing.notes = notesInput.value; });

        const tagsInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
        tagsInput.value = editing.tags.join(', ');
        tagsInput.addEventListener('input', () => {
            editing.tags = tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean);
        });

        const message = promptField('Example message', {
            rows: 3,
            hint: 'Added to the chat while the prompt is built, then removed. Nothing is sent and nothing is saved to the chat.',
        });
        message.textarea.value = editing.userMessage;
        message.textarea.addEventListener('input', () => { editing.userMessage = message.textarea.value; });

        form.append(
            field('Name', nameInput),
            characterPicker.node,
            field('Persona', personaSelect),
            field('Connection profile', profileSelect),
            field('Prompt Tags profile', promptTagsSelect),
            renderPresetPins(options),
            field('Notes', notesInput, { hint: 'For you only. Notes are never sent anywhere.' }),
            field('Tags', tagsInput, { hint: 'Separate tags with commas.' }),
            message.wrapper,
            renderAssertionEditor(),
        );

        const problems = element('ul', { className: 'sbpl-problems' });
        const save = button('Save test case', async () => {
            const editor = editing;
            const payload = structuredClone(editor);
            const suiteId = activeSuite?.id;
            const found = validateCase(payload);
            replace(problems, ...found.map(text => element('li', { text })));
            if (found.length || !suiteId) {
                return;
            }
            const task = registerActiveTask('case save');
            try {
                const saved = await storage.saveCase(payload);
                await storage.updateSuite(suiteId, (suite) => {
                    if (!suite.caseIds.includes(saved.id)) {
                        suite.caseIds.push(saved.id);
                    }
                });
                if (editing === editor) {
                    editing = null;
                }
                status.textContent = `Saved "${saved.name}".`;
                await reload({ keepEditor: Boolean(editing) });
            } finally {
                task.release();
            }
        }, { className: 'menu_button menu_button_primary sbpl-button' });

        const cancel = button('Cancel', () => {
            editing = null;
            renderEditor();
        }, { className: 'menu_button sbpl-button' });

        form.append(problems, element('div', { className: 'sbpl-editor-actions' }));
        form.lastChild.append(save, cancel);
        editorHost.append(form);
    }

    /**
     * One preset picker per kind. Chat Completion uses a single preset, while
     * Text Completion is built from a sampler preset and its templates, so a
     * case can pin as many of those as it needs.
     */
    function renderPresetPins(options) {
        const wrapper = element('div', { className: 'sbpl-preset-pins' });
        wrapper.append(element('p', { className: 'sbpl-field-label', text: 'Presets' }));
        const mode = pinnedMode(editing.pins);
        const apiIds = [...new Set([
            ...PRESET_API_IDS,
            ...editing.pins.presets.map(ref => ref.apiId),
        ])];
        for (const apiId of apiIds) {
            const installed = options.presets[apiId] ?? [];
            const pinned = editing.pins.presets.find(ref => ref.apiId === apiId);
            if (!installed.length && !pinned) {
                continue;
            }
            const choices = installed.map(name => ({ name, label: name }));
            if (pinned && !installed.includes(pinned.name)) {
                choices.push({ name: pinned.name, label: `${pinned.name} (not installed)` });
            }
            const select = element('select', { className: 'text_pole sbpl-select' });
            optionList(select, choices, {
                valueKey: 'name',
                labelKey: 'label',
                includeBlank: 'Leave as it is',
            });
            select.value = pinned?.name ?? '';
            select.disabled = Boolean(mode) && modeOf(apiId) !== mode && !pinned;
            select.addEventListener('change', () => {
                editing.pins.presets = editing.pins.presets.filter(ref => ref.apiId !== apiId);
                if (select.value) {
                    editing.pins.presets.push({ apiId, name: select.value });
                }
                renderEditor();
            });
            const missing = pinned && !installed.includes(pinned.name);
            wrapper.append(field(labelForApiId(apiId), select, {
                hint: missing ? 'This preset is not installed in Neconyan at the moment.' : '',
            }));
        }
        wrapper.append(element('p', {
            className: 'sbpl-field-hint',
            text: mode === MODE.CC
                ? 'Chat Completion uses one preset, so the Text Completion pickers are held back.'
                : 'A test case can only pin one prompt mode at a time.',
        }));
        return wrapper;
    }

    /* --------------------------------------------------------- checks UI */

    function renderAssertionEditor() {
        const wrapper = element('div', { className: 'sbpl-assertions' });
        wrapper.append(element('p', { className: 'sbpl-field-label', text: 'Checks' }));

        const list = element('ul', { className: 'sbpl-assertion-list' });
        const redraw = () => {
            replace(list, ...editing.assertions.map((assertion, index) => {
                const item = element('li', { className: 'sbpl-assertion-item' });
                const summary = element('span', { text: describeAssertion(assertion) });
                // The summary is rewritten in place rather than redrawing the
                // list, so an open check keeps both its settings and the focus.
                const restate = () => { summary.textContent = describeAssertion(assertion); };
                item.append(
                    summary,
                    button('Edit', () => {
                        const open = item.querySelector('.sbpl-assertion-details');
                        if (open) {
                            open.remove();
                        } else {
                            item.append(renderAssertionDetails(assertion, restate));
                        }
                    }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
                    button('Remove', () => {
                        editing.assertions.splice(index, 1);
                        redraw();
                    }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
                );
                return item;
            }));
            if (!editing.assertions.length) {
                list.append(element('li', {
                    className: 'sbpl-assertion-empty',
                    text: 'No checks yet. A test case without checks still records the prompt and compares it against the baseline.',
                }));
            }
        };
        redraw();

        const typeSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Kind of check' },
        });
        for (const [type, label] of Object.entries(ASSERTION_LABEL)) {
            typeSelect.append(element('option', { text: label, attributes: { value: type } }));
        }
        const add = button('Add check', () => {
            editing.assertions.push(blankAssertion(typeSelect.value));
            redraw();
        }, { className: 'menu_button sbpl-button' });

        const adder = element('div', { className: 'sbpl-assertion-adder' });
        adder.append(typeSelect, add);
        wrapper.append(list, adder);
        return wrapper;
    }

    /** The settings that belong to one check, shown only while it is open. */
    function renderAssertionDetails(assertion, redraw) {
        const wrapper = element('div', { className: 'sbpl-assertion-details' });
        const onInput = () => redraw();

        const sectionField = () => {
            const select = element('select', { className: 'text_pole sbpl-select' });
            const names = Object.keys(SECTION_LABEL);
            if (assertion.section && !names.includes(assertion.section)) {
                names.push(assertion.section);
            }
            for (const name of names) {
                select.append(element('option', {
                    text: SECTION_LABEL[name] ?? name,
                    attributes: { value: name },
                }));
            }
            select.value = assertion.section || names[0];
            assertion.section = select.value;
            select.addEventListener('change', () => {
                assertion.section = select.value;
                onInput();
            });
            return field('Part of the prompt', select);
        };

        const scopeField = () => {
            const select = element('select', { className: 'text_pole sbpl-select' });
            for (const scope of SCOPES) {
                select.append(element('option', {
                    text: scope === 'total' ? 'The whole prompt' : `The ${scope} part`,
                    attributes: { value: scope },
                }));
            }
            select.value = assertion.scope;
            select.addEventListener('change', () => {
                assertion.scope = select.value;
                onInput();
            });
            return field('Where to look', select);
        };

        const negateField = () => {
            const input = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
            input.checked = Boolean(assertion.negate);
            input.addEventListener('change', () => {
                assertion.negate = input.checked;
                onInput();
            });
            const label = element('label', { className: 'sbpl-field sbpl-field-inline' });
            label.append(input, element('span', { className: 'sbpl-field-label', text: 'Fail if it is found instead' }));
            return label;
        };

        switch (assertion.type) {
            case ASSERTION.SECTION_PRESENT:
            case ASSERTION.SECTION_ABSENT:
            case ASSERTION.SECTION_UNIQUE:
                wrapper.append(sectionField());
                break;
            case ASSERTION.TOKEN_CEILING: {
                const input = element('input', {
                    className: 'text_pole sbpl-input',
                    attributes: { type: 'number', min: '1' },
                });
                input.value = String(assertion.max);
                input.addEventListener('input', () => {
                    assertion.max = Math.max(0, Math.trunc(Number(input.value) || 0));
                    onInput();
                });
                wrapper.append(scopeField(), field('Stay under', input, { hint: 'Tokens.' }));
                break;
            }
            case ASSERTION.CONTENT_MATCH: {
                const modeSelect = element('select', { className: 'text_pole sbpl-select' });
                modeSelect.append(
                    element('option', { text: 'Contains this text', attributes: { value: 'contains' } }),
                    element('option', { text: 'Matches this pattern', attributes: { value: 'regex' } }),
                );
                modeSelect.value = assertion.mode;
                modeSelect.addEventListener('change', () => {
                    assertion.mode = modeSelect.value;
                    onInput();
                });
                const valueInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
                valueInput.value = assertion.value;
                valueInput.addEventListener('input', () => { assertion.value = valueInput.value; });
                valueInput.addEventListener('change', onInput);
                wrapper.append(scopeField(), field('How to match', modeSelect), field('Text', valueInput), negateField());
                break;
            }
            case ASSERTION.WI_ACTIVATED: {
                const worldInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
                worldInput.value = assertion.worldName;
                worldInput.addEventListener('input', () => { assertion.worldName = worldInput.value; });
                worldInput.addEventListener('change', onInput);
                const keyInput = element('input', { className: 'text_pole sbpl-input', attributes: { type: 'text' } });
                keyInput.value = assertion.entryKey;
                keyInput.addEventListener('input', () => { assertion.entryKey = keyInput.value; });
                keyInput.addEventListener('change', onInput);
                wrapper.append(
                    field('Lorebook', worldInput, { hint: 'Leave empty to look in every lorebook.' }),
                    field('Entry', keyInput),
                    negateField(),
                );
                break;
            }
            default:
                wrapper.append(element('p', {
                    className: 'sbpl-field-hint',
                    text: 'This check has nothing to set up.',
                }));
        }
        return wrapper;
    }

    /* -------------------------------------------------------- generation */

    /**
     * Writes one test case per character and preset pairing, so a whole matrix
     * can be set up without repeating the same form.
     */
    function renderMatrix(options) {
        const wrapper = element('div', { className: 'sbpl-matrix' });
        wrapper.append(
            element('h3', { className: 'sbpl-preset-heading', text: 'Create several test cases' }),
            element('p', {
                className: 'sbpl-field-hint',
                text: 'Pick characters and presets, and one test case is written for every pairing.',
            }),
        );

        const characterList = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { multiple: 'multiple', size: '5', 'aria-label': 'Characters' },
        });
        for (const character of options.characters) {
            characterList.append(element('option', { text: character.name, attributes: { value: character.avatar } }));
        }

        const kindSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Preset kind' },
        });
        for (const apiId of PRESET_API_IDS) {
            kindSelect.append(element('option', { text: labelForApiId(apiId), attributes: { value: apiId } }));
        }
        const presetList = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { multiple: 'multiple', size: '5', 'aria-label': 'Presets' },
        });
        const fillPresets = () => {
            replace(presetList, ...(options.presets[kindSelect.value] ?? []).map(name => element('option', {
                text: name,
                attributes: { value: name },
            })));
        };
        kindSelect.addEventListener('change', fillPresets);
        fillPresets();

        const create = button('Create test cases', async () => {
            const avatars = [...characterList.selectedOptions].map(option => option.value);
            const presets = [...presetList.selectedOptions].map(option => option.value);
            const suiteId = activeSuite?.id;
            if (!avatars.length || !presets.length) {
                status.textContent = 'Pick at least one character and one preset.';
                return;
            }
            if (!suiteId) {
                return;
            }
            const apiId = kindSelect.value;
            const shared = structuredClone(editing?.pins?.presets?.filter(ref => (
                ref.apiId !== apiId && modeOf(ref.apiId) === modeOf(apiId)
            )) ?? []);
            const task = registerActiveTask('case matrix creation');
            try {
                const ids = [];
                for (const avatar of avatars) {
                    const character = options.characters.find(item => item.avatar === avatar);
                    for (const preset of presets) {
                        const testCase = createCase({
                            name: `${character?.name ?? avatar} · ${preset}`,
                            pins: {
                                characterAvatar: avatar,
                                presets: [...shared, { apiId, name: preset }],
                            },
                        });
                        const saved = await storage.saveCase(testCase);
                        ids.push(saved.id);
                    }
                }
                await storage.updateSuite(suiteId, (suite) => {
                    suite.caseIds.push(...ids.filter(id => !suite.caseIds.includes(id)));
                });
                status.textContent = `Created ${ids.length} test cases.`;
                await reload();
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });

        const grid = element('div', { className: 'sbpl-matrix-grid' });
        grid.append(
            field('Characters', characterList, { hint: 'Hold Ctrl or Cmd to pick several.' }),
            field('Preset kind', kindSelect),
            field('Presets', presetList, { hint: 'Hold Ctrl or Cmd to pick several.' }),
        );
        wrapper.append(grid, create);
        return wrapper;
    }

    function renderAll({ keepEditor = false } = {}) {
        renderSuiteSelect();
        renderList();
        // A background refresh (a host event, another tab's change) must not
        // rebuild the form mid-keystroke or wipe an open matrix panel.
        if (!(keepEditor && editorHost.hasChildNodes())) {
            renderEditor();
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-cases-tab' });
        const controls = element('div', { className: 'sbpl-controls' });
        suiteSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Suite' },
        });
        suiteSelect.addEventListener('change', async () => {
            const suiteId = suiteSelect.value;
            const suite = suites.find(item => item.id === suiteId) ?? null;
            const epoch = ++reloadEpoch;
            activeSuite = suite;
            editing = null;
            selected.clear();
            cases = [];
            renderAll();
            const nextCases = suite ? await lab.getSuiteCases(suite) : [];
            if (epoch !== reloadEpoch || activeSuite?.id !== suiteId || !root) {
                return;
            }
            cases = nextCases;
            renderAll();
        });

        searchInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'search', placeholder: 'Search test cases', 'aria-label': 'Search test cases' },
        });
        searchInput.addEventListener('input', renderList);

        const newSuite = button('Create suite', async () => {
            const payload = createSuite({ name: `Suite ${suites.length + 1}` });
            const previousSuiteId = activeSuite?.id ?? '';
            const epoch = reloadEpoch;
            const task = registerActiveTask('suite creation');
            try {
                const suite = await storage.saveSuite(payload);
                const preferredSuiteId = epoch === reloadEpoch && (activeSuite?.id ?? '') === previousSuiteId
                    ? suite.id
                    : activeSuite?.id;
                status.textContent = `Created "${suite.name}".`;
                await reload({ preferredSuiteId });
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });

        const newCase = button('Add test case', () => {
            if (!activeSuite) {
                status.textContent = 'Create a suite first.';
                return;
            }
            editing = createCase({ name: `Test case ${cases.length + 1}` });
            renderEditor();
        }, { className: 'menu_button menu_button_primary sbpl-button' });

        const matrix = button('Create several', () => {
            if (!activeSuite) {
                status.textContent = 'Create a suite first.';
                return;
            }
            replace(editorHost, renderMatrix(lab.readAvailableOptions(getContext())));
        }, { className: 'menu_button sbpl-button' });

        controls.append(suiteSelect, searchInput, newSuite, newCase, matrix);
        status = statusRegion('');
        listHost = element('div', { className: 'sbpl-case-list-host' });
        editorHost = element('div', { className: 'sbpl-editor-host' });
        root.append(controls, status, listHost, editorHost);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Saved test cases could not be loaded: ${errorMessage(error)}`;
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

/** A check of the requested kind, filled in with settings that make sense. */
export function blankAssertion(type) {
    switch (type) {
        case ASSERTION.TOKEN_CEILING:
            return { type, scope: 'total', max: 1000 };
        case ASSERTION.CONTENT_MATCH:
            return { type, scope: 'final', mode: 'contains', value: '', negate: false };
        case ASSERTION.WI_ACTIVATED:
            return { type, worldName: '', entryKey: '', negate: false };
        case ASSERTION.CACHE_PREFIX_STABLE:
            return { type };
        default:
            return { type, section: Object.keys(SECTION_LABEL)[0] };
    }
}

export function describeAssertion(assertion) {
    const label = ASSERTION_LABEL[assertion?.type] ?? assertion?.type ?? 'Unknown check';
    switch (assertion?.type) {
        case ASSERTION.SECTION_PRESENT:
        case ASSERTION.SECTION_ABSENT:
        case ASSERTION.SECTION_UNIQUE:
            return `${label}: ${SECTION_LABEL[assertion.section] ?? assertion.section}`;
        case ASSERTION.TOKEN_CEILING:
            return `${label}: ${assertion.scope === 'total' ? 'whole prompt' : assertion.scope} under ${assertion.max.toLocaleString()} tokens`;
        case ASSERTION.CONTENT_MATCH:
            return `${label}: "${assertion.value}"${assertion.negate ? ' (must not appear)' : ''}`;
        case ASSERTION.WI_ACTIVATED:
            return `${label}: ${assertion.entryKey}${assertion.negate ? ' (must not activate)' : ''}`;
        default:
            return label;
    }
}
