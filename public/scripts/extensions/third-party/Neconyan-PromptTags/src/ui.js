import { createBlankRule, createDefaultRules, GROUPS, MODULE_NAME, SECTION_IDS, SECTIONS } from './sections.js';
import { isValidTagName } from './wrap.js';
import {
    clearAllPresetRules,
    clearPresetRule,
    getCurrentPresetName,
    getPresetRuleOverrides,
    getPresetWriteState,
    isPresetScopeAvailable,
    listPresetPrompts,
    setPresetRule,
    setPresetRules,
    subscribePresetWriteState,
} from './preset-store.js';
import { applyFix, captureFixTarget, detectLiveConflicts, undoFix } from './conflicts.js';
import {
    applyTags,
    getRecoveryState,
    removeTags,
    restore,
    saveAsPreset,
} from './context-template.js';
import {
    describeSkip,
    SKIP_ALREADY_TAGGED,
    SKIP_MULTIPLE,
    SKIP_NOT_REFERENCED,
    SKIP_NO_TEMPLATE,
} from './story-string.js';
import {
    createProfile,
    deleteProfile,
    exportProfiles,
    getActiveRules,
    getAssignmentState,
    getEditableRules,
    getResolvedProfileRules,
    getSettings,
    importProfiles,
    INHERIT,
    listProfiles,
    MAX_IMPORT_BYTES,
    renameProfile,
    resolveProfile,
    save,
    setActiveProfile,
    setChatProfile,
    setCharacterProfile,
    setEnabled,
    setPresetProfile,
} from './settings.js';

const DRAWER_ID = `${MODULE_NAME}-drawer`;
const CONTENT_ID = `${MODULE_NAME}-content`;
const INVALID_ASSIGNMENT = '__promptTags_invalid_assignment__';

let existingRefresh = null;
let existingCleanup = null;
let rowIdSequence = 0;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
};

const toast = (message, type = 'info') => globalThis.toastr?.[type]?.(message, 'Prompt Tags');

function actionButton(label, icon, className = '') {
    const button = el('button', `menu_button interactable promptTags-button ${className}`.trim());
    button.type = 'button';

    if (icon) {
        const iconNode = el('i', `fa-solid ${icon}`);
        iconNode.setAttribute('aria-hidden', 'true');
        button.append(iconNode);
    }

    button.append(el('span', 'promptTags-button-label', label));
    return button;
}

async function promptForText(header, initial = '') {
    const ctx = SillyTavern.getContext();
    const value = await ctx.callGenericPopup(header, ctx.POPUP_TYPE.INPUT, initial);
    return typeof value === 'string' ? value.trim() : '';
}

async function confirmAction(title, message) {
    const ctx = SillyTavern.getContext();

    if (ctx.Popup?.show?.confirm) {
        const result = await ctx.Popup.show.confirm(title, message);
        return result === ctx.POPUP_RESULT?.AFFIRMATIVE;
    }

    const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM);
    return result === true || result === 1 || result === ctx.POPUP_RESULT?.AFFIRMATIVE;
}

function errorText(error, fallback) {
    return error?.message ? `${fallback} ${error.message}` : fallback;
}

/** Runs a host-facing async operation with one consistent busy and rejection path. */
async function runAsyncAction(control, work, { onError = null } = {}) {
    if (!control || control.disabled) {
        return null;
    }

    const previousDisabled = control.disabled;
    const previousFocus = typeof document !== 'undefined' ? document.activeElement : null;
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');

    try {
        return await work();
    } catch (error) {
        const message = errorText(error, 'The operation could not be completed.');
        if (onError) {
            onError(message, error);
        } else {
            toast(message, 'error');
        }
        return null;
    } finally {
        // A refresh may have changed the control's disabled state while the operation was
        // running, for example after deleting the last profile. Honor the latest desired
        // state when the drawer recorded one.
        const desiredDisabled = control.dataset.promptTagsDisabled;
        control.disabled = desiredDisabled === undefined ? previousDisabled : desiredDisabled === 'true';
        control.removeAttribute('aria-busy');
        if (previousFocus && typeof previousFocus.focus === 'function'
            && typeof document !== 'undefined'
            && !control.disabled
            && (document.activeElement === document.body || !document.activeElement)) {
            previousFocus.focus();
        }
    }
}

const skipLabels = {
    [SKIP_ALREADY_TAGGED]: 'already tagged',
    [SKIP_NOT_REFERENCED]: 'missing variable',
    [SKIP_MULTIPLE]: 'duplicate variable',
    [SKIP_NO_TEMPLATE]: 'invalid wrapper',
};

function buildStoryReport(result, operation) {
    const report = el('div', 'promptTags-operation-report');
    const applied = result.applied?.length ?? 0;
    const skipped = result.skipped ?? [];

    if (!result.ok) {
        report.append(el('strong', undefined, result.diverged ? 'Review required' : 'Text Completion update failed'));
        report.append(el('span', undefined, result.error ?? 'The operation could not be completed.'));
        return report;
    }

    if (operation === 'restore') {
        report.append(el('strong', undefined, 'Restored the saved context template.'));
        return report;
    }
    if (operation === 'remove') {
        report.append(el('strong', undefined, 'Removed matching Prompt Tags wrappers.'));
        return report;
    }

    const action = operation === 'copy' ? 'Tagged copy' : operation === 'remove' ? 'Tag removal' : 'Template update';
    let summary;
    if (!applied && !skipped.length && !result.changed) {
        summary = `${action}: no sections changed.`;
    } else {
        const appliedLabel = `${applied} applied`;
        const skippedLabel = `${skipped.length} skipped`;
        summary = `${action}: ${appliedLabel}, ${skippedLabel}.`;
    }
    report.append(el('strong', undefined, summary));

    if (skipped.length) {
        const counts = new Map();
        for (const entry of skipped) {
            const label = skipLabels[entry.reason] ?? 'not updated';
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        const countText = [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
        report.append(el('span', undefined, ` Reasons: ${countText}.`));

        const details = el('details', 'promptTags-operation-details');
        details.append(el('summary', undefined, 'Show section details'));
        const list = el('ul');
        for (const entry of skipped) {
            list.append(el('li', undefined, describeSkip(entry)));
        }
        details.append(list);
        report.append(details);
    }

    return report;
}

function syncControlValue(control, value) {
    const nextValue = String(value ?? '');
    if (control.value === nextValue) {
        return;
    }

    const focused = document.activeElement === control;
    const start = focused && typeof control.selectionStart === 'number' ? control.selectionStart : null;
    const end = focused && typeof control.selectionEnd === 'number' ? control.selectionEnd : null;
    const direction = focused ? control.selectionDirection : null;
    control.value = nextValue;

    if (start !== null && typeof control.setSelectionRange === 'function') {
        const max = nextValue.length;
        control.setSelectionRange(Math.min(start, max), Math.min(end, max), direction ?? 'none');
    }
}

/** Rows keep their refs while a profile is edited and are rebuilt only when their source changes. */
function buildSectionRow(section, rules, onEdit, { namespace = 'row', isReadOnly = () => false } = {}) {
    const wrapper = el('div', 'promptTags-section');
    const row = el('div', 'promptTags-row');
    const idPrefix = `${MODULE_NAME}-${namespace.replace(/[^a-z0-9_-]/gi, '-')}-${++rowIdSequence}`;

    const checkboxLabel = el('label', 'checkbox_label promptTags-section-toggle');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkboxLabel.append(checkbox, el('span', undefined, section.label));

    const tagField = el('div', 'promptTags-field promptTags-tag-field');
    const tagInputId = `${idPrefix}-tag`;
    const tagLabel = el('label', 'promptTags-field-label', 'Tag name');
    tagLabel.htmlFor = tagInputId;
    const tagInput = el('input', 'text_pole promptTags-tag');
    tagInput.id = tagInputId;
    tagInput.type = 'text';
    tagInput.autocomplete = 'off';
    tagInput.placeholder = section.tag;
    tagField.append(tagLabel, tagInput);

    const advancedToggle = actionButton('Custom wrapper', 'fa-code', 'promptTags-wrapper-toggle');
    advancedToggle.setAttribute('aria-pressed', 'false');

    row.append(checkboxLabel, tagField, advancedToggle);

    const templateField = el('div', 'promptTags-field promptTags-template-field');
    const templateId = `${idPrefix}-template`;
    const templateLabel = el('label', 'promptTags-field-label', 'Wrapper template');
    templateLabel.htmlFor = templateId;
    const template = el('textarea', 'text_pole textarea_compact promptTags-template');
    template.id = templateId;
    template.rows = 4;
    template.placeholder = `<${section.tag}>\n{{content}}\n</${section.tag}>`;
    template.spellcheck = false;
    templateField.append(templateLabel, template);

    const hint = el('small', 'promptTags-hint');
    hint.id = `${idPrefix}-hint`;
    hint.setAttribute('aria-live', 'polite');
    const preview = el('small', 'promptTags-wrapper-preview');
    preview.setAttribute('aria-live', 'off');
    tagInput.setAttribute('aria-describedby', hint.id);
    template.setAttribute('aria-describedby', hint.id);
    advancedToggle.setAttribute('aria-controls', templateId);

    wrapper.append(row, templateField, hint, preview);

    const syncValues = () => {
        const rule = rules[section.id];
        const readOnly = !!isReadOnly();

        checkbox.checked = !!rule.enabled;
        syncControlValue(tagInput, rule.tag);
        syncControlValue(template, rule.template);
        checkbox.disabled = readOnly;
        tagInput.readOnly = readOnly;
        template.readOnly = readOnly;
        advancedToggle.disabled = readOnly;
        tagInput.setAttribute('aria-readonly', String(readOnly));
        template.setAttribute('aria-readonly', String(readOnly));
        wrapper.classList.toggle('promptTags-inherited', readOnly);
    };

    const syncDerived = () => {
        const rule = rules[section.id];
        const hasTemplateError = !!rule.enabled && rule.advanced && !template.value.includes('{{content}}');
        const hasTagError = !!rule.enabled && !rule.advanced && !isValidTagName(rule.tag);

        templateField.hidden = !rule.advanced;
        tagField.hidden = !!rule.advanced;
        advancedToggle.classList.toggle('promptTags-active', !!rule.advanced);
        advancedToggle.setAttribute('aria-pressed', String(!!rule.advanced));
        advancedToggle.querySelector('.promptTags-button-label').textContent = rule.advanced
            ? 'Use tag name'
            : 'Custom wrapper';
        wrapper.classList.toggle('promptTags-disabled', !rule.enabled);

        tagInput.setAttribute('aria-invalid', String(hasTagError));
        template.setAttribute('aria-invalid', String(hasTemplateError));

        if (hasTemplateError) {
            hint.textContent = 'Add {{content}} to the wrapper. Until then, this section will not be tagged.';
            hint.hidden = false;
        } else if (hasTagError) {
            hint.textContent = 'Enter a valid XML tag name. Until then, this section will not be tagged.';
            hint.hidden = false;
        } else {
            hint.textContent = '';
            hint.hidden = true;
        }

        const wrapperText = rule.advanced
            ? String(rule.template ?? '').split('{{content}}').join('…')
            : `<${rule.tag || section.tag}> … </${rule.tag || section.tag}>`;
        preview.textContent = `Preview: ${wrapperText}`;
        preview.hidden = !rule.enabled || (rule.advanced && hasTemplateError) || (!rule.advanced && hasTagError);
    };

    const sync = () => {
        syncValues();
        syncDerived();
    };

    const editRule = (kind, mutate, localControl = false) => {
        if (isReadOnly()) {
            sync();
            return;
        }
        const before = { ...rules[section.id] };
        mutate(rules[section.id]);
        if (onEdit(kind, before) === false) {
            rules[section.id] = before;
            sync();
            return;
        }
        if (localControl) {
            syncDerived();
        } else {
            sync();
        }
    };

    checkbox.addEventListener('change', () => {
        editRule('enabled', rule => { rule.enabled = checkbox.checked; }, true);
    });

    tagInput.addEventListener('input', () => {
        editRule('tag', rule => { rule.tag = tagInput.value; }, true);
    });

    tagInput.addEventListener('blur', () => {
        const trimmed = tagInput.value.trim();
        if (trimmed !== tagInput.value) {
            editRule('tag', rule => { rule.tag = trimmed; });
        }
    });

    template.addEventListener('input', () => {
        editRule('template', rule => { rule.template = template.value; }, true);
    });

    advancedToggle.addEventListener('click', () => {
        editRule('template', rule => {
            rule.advanced = !rule.advanced;
            if (rule.advanced && !rule.template) {
                rule.template = `<${rule.tag || section.tag}>\n{{content}}\n</${rule.tag || section.tag}>`;
            }
        });
        const rule = rules[section.id];
        if (!isReadOnly()) {
            (rule.advanced ? template : tagInput).focus();
        }
    });

    sync();
    return { wrapper, sync, syncValues, syncDerived };
}

export function renderSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById(DRAWER_ID)) {
        return existingRefresh;
    }

    existingCleanup?.();
    existingCleanup = null;

    const drawer = el('div', 'inline-drawer');
    drawer.id = DRAWER_ID;

    // Plain <div>, exactly like every host drawer header: a <button> would need
    // a font/colour reset that outranks theme rules on .inline-drawer-header.
    const toggle = el('div', 'inline-drawer-toggle inline-drawer-header promptTags-drawer-toggle');
    const title = el('b', undefined, 'Prompt Tags');
    // No aria-hidden: with a <div> header the host's a11y pass makes this
    // chevron the keyboard control, so hiding it would hide the only control.
    const chevron = el('span', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
    toggle.append(title, chevron);

    const content = el('div', 'inline-drawer-content promptTags-content');
    content.id = CONTENT_ID;
    content.style.display = 'none';
    content.setAttribute('aria-hidden', 'true');
    drawer.append(toggle, content);
    host.append(drawer);

    const syncDrawerAccessibility = () => {
        const open = chevron.classList.contains('up');
        content.setAttribute('aria-hidden', String(!open));
    };
    const handleHostDrawerToggle = (event) => {
        if (event.target === drawer) {
            syncDrawerAccessibility();
        }
    };
    const drawerStateObserver = new MutationObserver(syncDrawerAccessibility);
    drawer.addEventListener('inline-drawer-toggle', handleHostDrawerToggle);
    drawerStateObserver.observe(chevron, { attributes: true, attributeFilter: ['class'] });
    syncDrawerAccessibility();

    content.append(el('p', 'promptTags-intro', 'Add clear boundaries around prompt sections while keeping profile, preset, and Text Completion behavior explicit.'));

    // Master switch
    const enabledLabel = el('label', 'checkbox_label promptTags-master');
    const enabledBox = el('input');
    enabledBox.type = 'checkbox';
    const enabledText = el('span');
    enabledText.append(el('strong', undefined, 'Enable prompt tags'));
    enabledText.append(el('small', 'promptTags-note', 'Turn all wrapping on or off without changing your profiles.'));
    enabledLabel.append(enabledBox, enabledText);
    content.append(enabledLabel);

    const overview = el('dl', 'promptTags-overview');
    const overviewItem = (label) => {
        const item = el('div', 'promptTags-overview-item');
        item.append(el('dt', undefined, label));
        const value = el('dd');
        item.append(value);
        overview.append(item);
        return value;
    };
    const effectiveProfileValue = overviewItem('Effective profile');
    const profileSourceValue = overviewItem('Source');
    const currentPresetValue = overviewItem('Current preset');
    const autosaveValue = overviewItem('Autosave');
    autosaveValue.setAttribute('aria-live', 'polite');
    content.append(overview);

    // Profile editor
    const profileSection = el('section', 'promptTags-panel-section');
    profileSection.append(el('h3', 'promptTags-heading', 'Profiles'));
    profileSection.append(el('p', 'promptTags-note', 'Choose a profile to edit, then decide where Neconyan should use it.'));

    const editorRow = el('div', 'promptTags-editor-row');
    const editorField = el('div', 'promptTags-field promptTags-editor-field');
    const editorLabel = el('label', 'promptTags-field-label', 'Edit profile');
    editorLabel.htmlFor = `${MODULE_NAME}-editor-profile`;
    const editorSelect = el('select', 'text_pole');
    editorSelect.id = `${MODULE_NAME}-editor-profile`;
    editorField.append(editorLabel, editorSelect);

    const profileActions = el('div', 'promptTags-actions promptTags-profile-actions');
    const addButton = actionButton('Duplicate', 'fa-copy');
    const renameButton = actionButton('Rename', 'fa-pencil');
    const resetButton = actionButton('Reset', 'fa-rotate-left');
    const deleteButton = actionButton('Delete', 'fa-trash');
    const exportButton = actionButton('Export', 'fa-file-export');
    const importButton = actionButton('Import', 'fa-file-import');
    const moreProfileActions = el('details', 'promptTags-action-menu');
    const moreProfileSummary = el('summary', 'menu_button interactable promptTags-button', 'More profile actions');
    const secondaryActions = el('div', 'promptTags-action-menu-body');
    secondaryActions.append(renameButton, resetButton, exportButton, importButton, deleteButton);
    moreProfileActions.append(moreProfileSummary, secondaryActions);
    profileActions.append(addButton, moreProfileActions);
    editorRow.append(editorField, profileActions);
    profileSection.append(editorRow);

    const importReport = el('div', 'promptTags-status promptTags-import-report');
    importReport.setAttribute('role', 'status');
    importReport.setAttribute('aria-live', 'polite');
    importReport.hidden = true;
    profileSection.append(importReport);

    const assignmentGrid = el('div', 'promptTags-assignment-grid');
    const createAssignment = (labelText, id) => {
        const field = el('div', 'promptTags-field promptTags-scope-field');
        const label = el('label', 'promptTags-field-label', labelText);
        label.htmlFor = id;
        const select = el('select', 'text_pole');
        select.id = id;
        const note = el('small', 'promptTags-note promptTags-scope-note');
        field.append(label, select, note);
        assignmentGrid.append(field);
        return { select, note };
    };
    profileSection.append(el('h4', 'promptTags-subheading', 'Profile scope precedence'));
    profileSection.append(el('p', 'promptTags-note', 'The first available assignment wins. Clearing a scope falls through to the next one.'));
    const { select: chatSelect, note: chatScopeNote } = createAssignment('1. This chat', `${MODULE_NAME}-chat-profile`);
    const { select: characterSelect, note: characterScopeNote } = createAssignment('2. This character', `${MODULE_NAME}-character-profile`);
    const { select: presetSelect, note: presetScopeNote } = createAssignment('3. This preset', `${MODULE_NAME}-preset-profile`);
    const { select: defaultSelect, note: defaultScopeNote } = createAssignment('4. Default', `${MODULE_NAME}-default-profile`);
    profileSection.append(assignmentGrid);

    const activeNote = el('p', 'promptTags-status');
    activeNote.setAttribute('aria-live', 'polite');
    activeNote.tabIndex = -1;
    profileSection.append(activeNote);
    content.append(profileSection);

    // Conflicts
    const conflictBox = el('div', 'promptTags-conflicts');
    conflictBox.setAttribute('aria-live', 'polite');
    const conflictUndoBox = el('div', 'promptTags-status promptTags-conflict-undo');
    conflictUndoBox.setAttribute('role', 'status');
    conflictUndoBox.setAttribute('aria-live', 'polite');
    conflictUndoBox.tabIndex = -1;
    conflictUndoBox.hidden = true;
    content.append(conflictBox, conflictUndoBox);

    // Sections
    const rulesSection = el('section', 'promptTags-panel-section');
    const sectionHeading = el('div', 'promptTags-section-heading');
    const sectionTitle = el('h3', 'promptTags-heading');
    const sectionSaveNote = el('small', 'promptTags-note', 'Profile changes queue automatically.');
    sectionHeading.append(sectionTitle, sectionSaveNote);
    rulesSection.append(sectionHeading);
    const sectionHost = el('div', 'promptTags-sections');
    rulesSection.append(sectionHost);
    content.append(rulesSection);

    const presetSection = el('section', 'promptTags-panel-section promptTags-preset-overrides');
    presetSection.append(el('h3', 'promptTags-heading', 'Preset overrides'));
    presetSection.append(el('p', 'promptTags-note', 'Known prompts inherit the effective profile until you enable an override. Preset-only prompts are configured here directly.'));
    const presetHost = el('div', 'promptTags-sections promptTags-preset-sections');
    presetSection.append(presetHost);
    content.append(presetSection);

    // Text Completion
    const textSection = el('section', 'promptTags-panel-section promptTags-text-completion');
    textSection.append(el('h3', 'promptTags-heading', 'Text Completion'));
    textSection.append(el('p', 'promptTags-note', 'Chat Completion applies tags automatically. For Text Completion, save a tagged copy or update the active context template.'));
    const storyPresetNote = el('p', 'promptTags-context-preset');
    textSection.append(storyPresetNote);

    const storyRow = el('div', 'promptTags-actions promptTags-story-actions');
    const presetButton = actionButton('Save tagged copy', 'fa-copy');
    const applyButton = actionButton('Update current template', 'fa-pen-to-square');
    const restoreButton = actionButton('Restore saved version', 'fa-rotate-left');
    const removeButton = actionButton('Remove this profile\'s tags', 'fa-eraser');
    storyRow.append(presetButton, applyButton, restoreButton, removeButton);
    textSection.append(storyRow);

    const storyRecoveryNote = el('small', 'promptTags-note promptTags-story-recovery');
    textSection.append(storyRecoveryNote);
    const storyStatus = el('div', 'promptTags-status promptTags-story-status');
    storyStatus.setAttribute('role', 'status');
    storyStatus.setAttribute('aria-live', 'polite');
    storyStatus.hidden = true;
    textSection.append(storyStatus);
    content.append(textSection);

    // Wiring
    let editingProfile = resolveProfile().name;
    let sectionRefs = [];
    let groupRefs = [];
    let builtForProfile = null;
    let presetRows = [];
    let presetPrompts = [];
    let presetWorkingRules = {};
    let presetCountRef = null;
    let presetFilterCount = null;
    let presetFilterEmpty = null;
    let builtForPreset = null;
    let presetSearchValue = '';
    let showPresetOverridesOnly = false;
    const groupOpenState = new Map();
    let storyOperation = null;
    let conflictSignature = '';
    let conflictUndoToken = null;
    let settingsChangeQueued = false;

    const updateAutosaveStatus = () => {
        const presetName = isPresetScopeAvailable() ? getCurrentPresetName() : '';
        const writeState = presetName ? getPresetWriteState(presetName) : { status: 'saved', error: '' };
        const labels = {
            pending: 'Preset change pending',
            saving: 'Saving preset',
            error: 'Preset save failed',
        };
        autosaveValue.textContent = labels[writeState.status]
            ?? (settingsChangeQueued
                ? `${presetName ? 'Preset saved; ' : ''}settings change queued`
                : (presetName ? 'Preset saved' : 'On'));
        autosaveValue.classList.toggle('promptTags-save-error', writeState.status === 'error');
        autosaveValue.title = writeState.error || '';
    };

    const markSettingsQueued = () => {
        settingsChangeQueued = true;
        updateAutosaveStatus();
    };

    const ensureEditingProfile = () => {
        if (!listProfiles().includes(editingProfile)) {
            editingProfile = resolveProfile().name;
        }
    };

    const updateGroupCounts = () => {
        const rules = getEditableRules(editingProfile) ?? {};
        for (const { count, members } of groupRefs) {
            const enabled = members.filter(section => rules[section.id]?.enabled).length;
            count.textContent = `${enabled} of ${members.length} on`;
        }
    };

    const rebuildSections = () => {
        const rules = getEditableRules(editingProfile);
        if (!rules) {
            return;
        }

        sectionTitle.textContent = `Sections in “${editingProfile}”`;

        if (builtForProfile === editingProfile && sectionRefs.length) {
            for (const row of sectionRefs) {
                row.sync();
            }
            updateGroupCounts();
            return;
        }

        sectionHost.replaceChildren();
        sectionRefs = [];
        groupRefs = [];

        for (const group of GROUPS) {
            const members = SECTIONS.filter(section => section.group === group.id);
            if (!members.length) {
                continue;
            }

            const details = el('details', 'promptTags-group');
            details.open = groupOpenState.has(group.id) ? groupOpenState.get(group.id) : group.id === 'character';
            const summary = el('summary', 'promptTags-group-summary promptTags-disclosure-summary');
            const summaryContent = el('span', 'promptTags-disclosure-summary-content');
            const groupLabel = el('span', 'promptTags-group-label', group.label);
            const count = el('span', 'promptTags-group-count');
            summaryContent.append(groupLabel, count);
            const disclosure = el('span', 'promptTags-disclosure');
            const disclosureLabel = el('span', 'promptTags-disclosure-label');
            const disclosureIcon = el('i', 'fa-solid fa-chevron-right');
            disclosureIcon.setAttribute('aria-hidden', 'true');
            disclosure.append(disclosureLabel, disclosureIcon);
            summary.append(summaryContent, disclosure);
            const updateGroupDisclosure = () => {
                disclosureLabel.textContent = details.open ? 'Hide sections' : 'Show sections';
            };
            details.addEventListener('toggle', () => {
                groupOpenState.set(group.id, details.open);
                updateGroupDisclosure();
            });
            updateGroupDisclosure();
            details.append(summary);

            const groupBody = el('div', 'promptTags-group-body');
            const groupActions = el('div', 'promptTags-actions promptTags-group-actions');
            const enableAllButton = actionButton('Enable all', 'fa-check');
            const disableAllButton = actionButton('Disable all', 'fa-xmark');
            const resetGroupButton = actionButton('Reset group', 'fa-rotate-left');
            groupActions.append(enableAllButton, disableAllButton, resetGroupButton);
            groupBody.append(groupActions);

            const updateGroup = (operation) => {
                const defaults = operation === 'reset' ? createDefaultRules() : null;
                for (const section of members) {
                    if (operation === 'reset') {
                        Object.assign(rules[section.id], defaults[section.id]);
                    } else {
                        rules[section.id].enabled = operation === 'enable';
                    }
                }
                save();
                markSettingsQueued();
                for (const row of sectionRefs) {
                    row.sync();
                }
                updateGroupCounts();
                rebuildPresetPrompts();
                storyOperation = null;
                renderRecoveryControls();
                conflictSignature = '';
                renderConflicts();
            };
            enableAllButton.addEventListener('click', () => updateGroup('enable'));
            disableAllButton.addEventListener('click', () => updateGroup('disable'));
            resetGroupButton.addEventListener('click', () => {
                runAsyncAction(resetGroupButton, async () => {
                    if (await confirmAction('Reset section group', `Reset all settings in “${group.label}” to their defaults?`)) {
                        updateGroup('reset');
                    }
                });
            });

            for (const section of members) {
                const row = buildSectionRow(section, rules, (kind) => {
                    save();
                    markSettingsQueued();
                    updateGroupCounts();
                    rebuildPresetPrompts();
                    storyOperation = null;
                    renderRecoveryControls();
                    if (kind === 'enabled') {
                        conflictSignature = '';
                        renderConflicts();
                    }
                }, { namespace: 'profile' });
                groupBody.append(row.wrapper);
                sectionRefs.push(row);
            }
            details.append(groupBody);
            sectionHost.append(details);
            groupRefs.push({ count, members });
        }

        updateGroupCounts();
        builtForProfile = editingProfile;
    };

    const updatePresetCount = () => {
        if (!presetCountRef) {
            return;
        }
        const overrides = getPresetRuleOverrides();
        const enabled = presetPrompts.filter(prompt => presetWorkingRules[prompt.identifier]?.enabled).length;
        const inherited = presetPrompts.filter(prompt => prompt.isKnownSection && !Object.hasOwn(overrides, prompt.identifier)).length;
        const custom = presetPrompts.filter(prompt => !prompt.isKnownSection).length;
        presetCountRef.textContent = `${enabled} of ${presetPrompts.length} on · ${inherited} inherited · ${Object.keys(overrides).length} overridden · ${custom} custom`;
    };

    const applyPresetFilters = () => {
        if (!presetRows.length) {
            return;
        }
        const overrides = getPresetRuleOverrides();
        const query = presetSearchValue.trim().toLowerCase();
        let visible = 0;
        for (const record of presetRows) {
            const rule = presetWorkingRules[record.prompt.identifier] ?? {};
            const searchText = `${record.prompt.label} ${record.prompt.identifier} ${rule.tag ?? ''}`.toLowerCase();
            const matchesSearch = !query || searchText.includes(query);
            const matchesOverride = !showPresetOverridesOnly || Object.hasOwn(overrides, record.prompt.identifier);
            const containsFocus = record.row.wrapper.contains(document.activeElement);
            record.row.wrapper.hidden = !(matchesSearch && matchesOverride) && !containsFocus;
            if (!record.row.wrapper.hidden) {
                visible++;
            }
        }
        if (presetFilterCount) {
            presetFilterCount.textContent = `${visible} of ${presetRows.length} shown`;
        }
        if (presetFilterEmpty) {
            presetFilterEmpty.hidden = visible !== 0;
        }
    };

    const syncPresetWorkingRules = (overrides = getPresetRuleOverrides()) => {
        const resolvedRules = getResolvedProfileRules();
        for (const prompt of presetPrompts) {
            if (Object.hasOwn(overrides, prompt.identifier)) {
                presetWorkingRules[prompt.identifier] = { ...overrides[prompt.identifier] };
            } else if (prompt.isKnownSection) {
                presetWorkingRules[prompt.identifier] = {
                    ...(resolvedRules[prompt.identifier] ?? createBlankRule(prompt.suggestedTag)),
                };
            } else if (!presetWorkingRules[prompt.identifier]) {
                presetWorkingRules[prompt.identifier] = createBlankRule(prompt.suggestedTag);
            }
        }
    };

    /**
     * Renders the prompts belonging to the equipped preset.
     *
     * These are stored on the preset itself, so the list and the rules both change when another
     * preset is equipped. Rows reuse buildSectionRow by presenting each prompt as a section.
     */
    const rebuildPresetPrompts = () => {
        const available = isPresetScopeAvailable();
        const presetName = available ? getCurrentPresetName() : '';

        if (!available) {
            presetHost.replaceChildren();
            const note = el('p', 'promptTags-note', 'Preset prompts apply to Chat Completion. Switch to a Chat Completion API to tag them.');
            presetHost.append(note);
            presetRows = [];
            presetCountRef = null;
            presetFilterCount = null;
            presetFilterEmpty = null;
            builtForPreset = null;
            return;
        }

        const overrides = getPresetRuleOverrides();
        presetPrompts = listPresetPrompts(SECTION_IDS);

        // Keyed on the preset and its prompt list only, deliberately not on the stored rules.
        // Saving a preset field makes the host save settings, which brings us back here; if
        // storing the first rule for a prompt counted as a change, the panel would rebuild
        // underneath the user and take focus out of the field they are typing in. Callers that
        // really do replace the rules (clear, revert) set builtForPreset to null instead.
        const signature = JSON.stringify([presetName, presetPrompts.map(p => p.identifier)]);
        if (builtForPreset === signature && presetRows.length) {
            syncPresetWorkingRules(overrides);
            for (const record of presetRows) {
                record.row.sync();
                record.updateMeta();
            }
            updatePresetCount();
            applyPresetFilters();
            return;
        }

        presetWorkingRules = {};
        syncPresetWorkingRules(overrides);

        presetHost.replaceChildren();
        presetRows = [];

        const details = el('details', 'promptTags-group');
        const openKey = '__preset__';
        details.open = groupOpenState.has(openKey) ? groupOpenState.get(openKey) : false;

        const summary = el('summary', 'promptTags-group-summary promptTags-disclosure-summary');
        const summaryContent = el('span', 'promptTags-disclosure-summary-content');
        summaryContent.append(el('span', 'promptTags-group-label', `Prompts in “${presetName}”`));
        presetCountRef = el('span', 'promptTags-group-count');
        summaryContent.append(presetCountRef);
        const disclosure = el('span', 'promptTags-disclosure');
        const disclosureLabel = el('span', 'promptTags-disclosure-label');
        const disclosureIcon = el('i', 'fa-solid fa-chevron-right');
        disclosureIcon.setAttribute('aria-hidden', 'true');
        disclosure.append(disclosureLabel, disclosureIcon);
        summary.append(summaryContent, disclosure);
        const updatePresetDisclosure = () => {
            disclosureLabel.textContent = details.open ? 'Hide prompts' : 'Show prompts';
        };
        details.addEventListener('toggle', () => {
            groupOpenState.set(openKey, details.open);
            updatePresetDisclosure();
        });
        updatePresetDisclosure();
        details.append(summary);

        const groupBody = el('div', 'promptTags-group-body');
        groupBody.append(el('small', 'promptTags-note', 'Overrides are saved inside this preset and travel with it. Search and filters change only what is shown, not what bulk actions affect.'));

        if (!presetPrompts.length) {
            presetCountRef.remove();
            presetCountRef = null;
            groupBody.append(el('p', 'promptTags-note', 'This preset has no taggable prompts yet. Add one in the Prompt Manager.'));
            details.append(groupBody);
            presetHost.append(details);
            builtForPreset = signature;
            return;
        }

        const groupActions = el('div', 'promptTags-actions promptTags-group-actions');
        const disableAllButton = actionButton('Disable all effective tags', 'fa-xmark');
        const clearAllButton = actionButton('Remove all overrides', 'fa-eraser');
        groupActions.append(disableAllButton, clearAllButton);
        groupBody.append(groupActions);

        disableAllButton.addEventListener('click', () => {
            const updates = {};
            for (const prompt of presetPrompts) {
                const rule = presetWorkingRules[prompt.identifier];
                if (rule?.enabled) {
                    updates[prompt.identifier] = { ...rule, enabled: false };
                }
            }
            if (!Object.keys(updates).length) {
                toast('All effective preset tags are already off.', 'info');
                return;
            }
            if (!setPresetRules(updates)) {
                toast('Could not disable every prompt atomically. The preset may have reached its override limit.', 'error');
                return;
            }
            syncPresetWorkingRules();
            for (const record of presetRows) {
                record.row.sync();
                record.updateMeta();
            }
            updatePresetCount();
            applyPresetFilters();
        });

        clearAllButton.addEventListener('click', () => {
            runAsyncAction(clearAllButton, async () => {
                if (!await confirmAction(
                    'Remove all preset overrides',
                    `Remove every Prompt Tags override from “${presetName}”? Known prompts will return to their profile settings, and preset-only prompts will become unconfigured.`,
                )) {
                    return;
                }
                clearAllPresetRules();
                builtForPreset = null;
                rebuildPresetPrompts();
            });
        });

        const filterBar = el('div', 'promptTags-filter-bar');
        const searchField = el('div', 'promptTags-field promptTags-search-field');
        const searchId = `${MODULE_NAME}-preset-search`;
        const searchLabel = el('label', 'promptTags-field-label', 'Search preset prompts');
        searchLabel.htmlFor = searchId;
        const searchInput = el('input', 'text_pole');
        searchInput.id = searchId;
        searchInput.type = 'search';
        searchInput.value = presetSearchValue;
        searchInput.placeholder = 'Label, identifier, or tag';
        searchField.append(searchLabel, searchInput);
        const overrideFilterLabel = el('label', 'checkbox_label promptTags-filter-toggle');
        const overrideFilter = el('input');
        overrideFilter.type = 'checkbox';
        overrideFilter.checked = showPresetOverridesOnly;
        overrideFilterLabel.append(overrideFilter, el('span', undefined, 'Show overridden only'));
        presetFilterCount = el('small', 'promptTags-note promptTags-filter-count');
        filterBar.append(searchField, overrideFilterLabel, presetFilterCount);
        groupBody.append(filterBar);

        searchInput.addEventListener('input', () => {
            presetSearchValue = searchInput.value;
            applyPresetFilters();
        });
        overrideFilter.addEventListener('change', () => {
            showPresetOverridesOnly = overrideFilter.checked;
            applyPresetFilters();
        });

        for (const prompt of presetPrompts) {
            const meta = el('div', 'promptTags-preset-meta');
            const overrideNote = el('small', 'promptTags-note');
            let overrideToggle = null;
            if (prompt.isKnownSection) {
                const toggleLabel = el('label', 'checkbox_label promptTags-override-toggle');
                overrideToggle = el('input');
                overrideToggle.type = 'checkbox';
                toggleLabel.append(overrideToggle, el('span', undefined, 'Override for this preset'));
                meta.append(overrideNote, toggleLabel);
            } else {
                meta.append(overrideNote);
            }

            const updateOverrideNote = () => {
                const stored = Object.hasOwn(getPresetRuleOverrides(), prompt.identifier);
                if (overrideToggle) {
                    overrideToggle.checked = stored;
                }
                overrideNote.className = 'promptTags-note promptTags-rule-state';
                if (stored && prompt.isKnownSection) {
                    overrideNote.textContent = 'Overridden: this preset replaces the effective profile rule.';
                } else if (prompt.isKnownSection) {
                    overrideNote.textContent = `Inherited from “${resolveProfile().name}”. Enable Override to edit.`;
                } else if (stored) {
                    overrideNote.textContent = 'Custom prompt: saved in this preset.';
                } else {
                    overrideNote.textContent = 'Custom prompt: edit normally to save it in this preset.';
                }
            };

            overrideToggle?.addEventListener('change', () => {
                if (overrideToggle.checked) {
                    if (!setPresetRule(prompt.identifier, presetWorkingRules[prompt.identifier])) {
                        overrideToggle.checked = false;
                        toast('Could not add this override. The preset may have reached its override limit.', 'error');
                    }
                } else {
                    clearPresetRule(prompt.identifier);
                    const inherited = getResolvedProfileRules()[prompt.identifier]
                        ?? createBlankRule(prompt.suggestedTag);
                    presetWorkingRules[prompt.identifier] = { ...inherited };
                }
                const record = presetRows.find(entry => entry.prompt.identifier === prompt.identifier);
                record?.row.sync();
                updateOverrideNote();
                updatePresetCount();
                applyPresetFilters();
            });

            const descriptor = { id: prompt.identifier, label: prompt.label, tag: prompt.suggestedTag };
            const row = buildSectionRow(descriptor, presetWorkingRules, () => {
                const accepted = setPresetRule(prompt.identifier, presetWorkingRules[prompt.identifier]);
                if (!accepted) {
                    toast('Could not save this prompt rule. The preset may have reached its override limit.', 'error');
                    return false;
                }
                updatePresetCount();
                updateOverrideNote();
                applyPresetFilters();
                return true;
            }, {
                namespace: 'preset',
                isReadOnly: () => prompt.isKnownSection
                    && !Object.hasOwn(getPresetRuleOverrides(), prompt.identifier),
            });
            row.wrapper.addEventListener('focusout', () => {
                queueMicrotask(applyPresetFilters);
            });

            row.wrapper.append(meta);
            updateOverrideNote();

            groupBody.append(row.wrapper);
            presetRows.push({ row, prompt, updateMeta: updateOverrideNote });
        }

        presetFilterEmpty = el('p', 'promptTags-empty-filter', 'No preset prompts match these filters.');
        presetFilterEmpty.hidden = true;
        groupBody.append(presetFilterEmpty);

        details.append(groupBody);
        presetHost.append(details);
        updatePresetCount();
        applyPresetFilters();
        builtForPreset = signature;
    };

    function renderConflictUndo() {
        conflictUndoBox.replaceChildren();
        if (!conflictUndoToken) {
            conflictUndoBox.hidden = true;
            return;
        }

        const message = el('span', undefined, `Replaced ${conflictUndoToken.label} with its shipped default.`);
        const undoButton = actionButton('Undo', 'fa-rotate-left', 'promptTags-fix');
        undoButton.addEventListener('click', () => {
            const result = undoFix(conflictUndoToken);
            if (!result.ok) {
                message.textContent = result.error;
                undoButton.disabled = true;
                toast(result.error, 'warning');
                return;
            }
            conflictUndoToken = null;
            conflictSignature = '';
            toast('Restored the previous formatting value.', 'success');
            renderConflictUndo();
            renderConflicts();
        });
        conflictUndoBox.append(message, undoButton);
        conflictUndoBox.hidden = false;
    }

    function renderConflicts() {
        const settings = getSettings();
        const resolved = resolveProfile();
        // The effective rules, not just the profile's: a preset override can enable a section
        // the profile leaves off, and that section can still collide with a host format setting.
        const rules = getActiveRules();
        const conflicts = detectLiveConflicts(rules);

        const signature = JSON.stringify({
            enabled: settings.enabled,
            profile: resolved.name,
            scope: resolved.scope,
            editingProfile,
            conflicts,
        });
        if (signature === conflictSignature) {
            return;
        }
        conflictSignature = signature;
        conflictBox.replaceChildren();

        const inactivePrefix = settings.enabled ? '' : 'Preview while Prompt Tags is disabled: ';
        const profilePrefix = editingProfile === resolved.name ? '' : `Active profile “${resolved.name}”: `;

        for (const conflict of conflicts) {
            const item = el('div', 'promptTags-conflict');
            const icon = el('i', 'fa-solid fa-triangle-exclamation');
            icon.setAttribute('aria-hidden', 'true');
            const body = el('div', 'promptTags-conflict-body');
            body.append(el('span', undefined, `${inactivePrefix}${profilePrefix}${conflict.message}`));

            if (conflict.currentValue !== undefined) {
                const currentDetails = el('details', 'promptTags-conflict-current');
                currentDetails.append(el('summary', undefined, 'Show current value'));
                currentDetails.append(el('pre', undefined, conflict.currentValue || '(empty)'));
                body.append(currentDetails);
            }
            item.append(icon, body);

            if (conflict.fix) {
                const fixTarget = captureFixTarget(conflict.fix);
                const resetLabels = {
                    wi_format: 'World Info Format',
                    personality_format: 'Personality Format',
                    scenario_format: 'Scenario Format',
                };
                const formatLabel = resetLabels[conflict.fix] ?? 'format';
                const label = `Replace ${formatLabel}`;
                const fixButton = actionButton(label, undefined, 'promptTags-fix');
                fixButton.setAttribute('aria-label', label);
                fixButton.addEventListener('click', () => {
                    runAsyncAction(fixButton, async () => {
                        const confirmed = await confirmAction(
                            `Replace ${formatLabel}`,
                            `Replace the current ${formatLabel} with Neconyan's shipped default? Prompt Tags will retain the current value for one Undo action.`,
                        );
                        if (!confirmed) {
                            return;
                        }
                        const token = applyFix(conflict.fix, fixTarget);
                        if (!token) {
                            conflictSignature = '';
                            renderConflicts();
                            toast(`${formatLabel} or its active preset changed. Review it and try again.`, 'warning');
                            return;
                        }
                        conflictUndoToken = token;
                        toast(`Replaced ${formatLabel}.`, 'success');
                        conflictSignature = '';
                        renderConflictUndo();
                        renderConflicts();
                        conflictUndoBox.focus?.();
                    });
                });
                item.append(fixButton);
            }

            conflictBox.append(item);
        }
        renderConflictUndo();
    }

    function fillProfileSelect(select, { includeInherit = false, inheritLabel = 'Use inherited profile' } = {}) {
        select.replaceChildren();
        if (includeInherit) {
            const option = el('option', undefined, inheritLabel);
            option.value = INHERIT;
            select.append(option);
        }
        for (const name of listProfiles()) {
            const option = el('option', undefined, name);
            option.value = name;
            select.append(option);
        }
    }

    function setAssignmentSelect(select, state, inheritLabel) {
        fillProfileSelect(select, { includeInherit: true, inheritLabel });
        if (state.assigned && !state.valid) {
            const option = el('option', undefined, `Unavailable profile: ${state.reference}`);
            option.value = INVALID_ASSIGNMENT;
            option.title = 'Choose the inherited option to clear this assignment.';
            select.append(option);
            select.value = INVALID_ASSIGNMENT;
            return;
        }
        select.value = state.profileName || INHERIT;
    }

    const scopeLabels = {
        chat: 'This chat',
        character: 'This character',
        preset: 'This preset',
        global: 'Default',
    };

    function setScopeNote(note, scope, state, resolved, available = true) {
        if (!available) {
            note.textContent = scope === 'preset'
                ? 'Available for Chat Completion presets.'
                : `No current ${scope}.`;
            return;
        }
        if (state.assigned && !state.valid) {
            note.textContent = `Unavailable assignment “${state.reference}”; resolution falls through.`;
            return;
        }
        if (resolved.scope === scope) {
            note.textContent = `Active source: “${resolved.name}”.`;
            return;
        }
        const ranks = { chat: 0, character: 1, preset: 2, global: 3 };
        if (state.assigned && state.valid) {
            note.textContent = `Assigned “${state.profileName}”, shadowed by ${scopeLabels[resolved.scope]}.`;
        } else if (ranks[resolved.scope] < ranks[scope]) {
            note.textContent = `No assignment; ${scopeLabels[resolved.scope]} currently takes precedence.`;
        } else {
            note.textContent = `Inherits “${resolved.name}” from ${scopeLabels[resolved.scope]}.`;
        }
    }

    function renderStoryOperation() {
        storyStatus.replaceChildren();
        if (!storyOperation) {
            storyStatus.hidden = true;
            return;
        }
        storyStatus.append(buildStoryReport(storyOperation.result, storyOperation.operation));
        storyStatus.hidden = false;
    }

    function renderImportReport(result) {
        importReport.replaceChildren();
        if (!result) {
            importReport.hidden = true;
            return;
        }

        if (result.error) {
            importReport.append(el('strong', undefined, 'Import failed'));
            importReport.append(el('span', undefined, result.error));
        } else {
            const imported = result.imported ?? [];
            importReport.append(el('strong', undefined, `Imported ${imported.length} profile${imported.length === 1 ? '' : 's'}.`));
            if (imported.length) {
                importReport.append(el('span', undefined, imported.map(name => `“${name}”`).join(', ')));
            }
        }

        if (result.rejected?.length) {
            const details = el('details', 'promptTags-operation-details');
            details.open = true;
            details.append(el('summary', undefined, `${result.rejected.length} rejected profile${result.rejected.length === 1 ? '' : 's'}`));
            const list = el('ul');
            for (const rejection of result.rejected) {
                list.append(el('li', undefined, `${rejection.name || 'Unnamed profile'}: ${rejection.reason}`));
            }
            details.append(list);
            importReport.append(details);
        }
        importReport.hidden = false;
    }

    function renderRecoveryControls() {
        const rules = getEditableRules(editingProfile) ?? {};
        const recovery = getRecoveryState(rules);
        storyPresetNote.textContent = recovery.presetName
            ? `Active context preset: “${recovery.presetName}”`
            : 'Active context preset: unavailable';
        restoreButton.disabled = !recovery.hasBackup;
        restoreButton.dataset.promptTagsDisabled = String(restoreButton.disabled);
        removeButton.disabled = !recovery.canRemove;
        removeButton.dataset.promptTagsDisabled = String(removeButton.disabled);

        if (!recovery.hasBackup && !recovery.canRemove) {
            storyRecoveryNote.textContent = 'No saved version or matching wrappers are available for this preset.';
        } else if (recovery.diverged) {
            storyRecoveryNote.textContent = 'The current template changed after tagging. Review it before restoring; tag removal keeps other edits.';
        } else if (recovery.hasBackup) {
            storyRecoveryNote.textContent = 'A saved version for the active context preset is available.';
        } else {
            storyRecoveryNote.textContent = 'No saved version is available. You can remove matching wrappers from the current template.';
        }
    }

    function refresh() {
        ensureEditingProfile();
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        const resolved = resolveProfile();
        const characterState = getAssignmentState('character');
        const chatState = getAssignmentState('chat');
        const presetState = getAssignmentState('preset');
        const presetAvailable = isPresetScopeAvailable();
        const character = ctx.characters?.[ctx.characterId];
        const presetFallback = settings.activeProfile;
        const characterFallback = presetAvailable && presetState.assigned && presetState.valid
            ? presetState.profileName
            : presetFallback;
        const chatFallback = character && characterState.assigned && characterState.valid
            ? characterState.profileName
            : characterFallback;
        const defaultState = {
            assigned: true,
            valid: true,
            profileName: settings.activeProfile,
            reference: settings.activeProfile,
        };

        enabledBox.checked = !!settings.enabled;
        effectiveProfileValue.textContent = resolved.name;
        profileSourceValue.textContent = scopeLabels[resolved.scope];
        currentPresetValue.textContent = presetAvailable && getCurrentPresetName()
            ? getCurrentPresetName()
            : 'Not available';
        updateAutosaveStatus();

        fillProfileSelect(editorSelect);
        editorSelect.value = editingProfile;

        fillProfileSelect(defaultSelect);
        defaultSelect.value = settings.activeProfile;

        setAssignmentSelect(chatSelect, chatState, `Inherit: “${chatFallback}”`);
        chatSelect.disabled = !ctx.chatMetadata;
        chatSelect.dataset.promptTagsDisabled = String(!ctx.chatMetadata);

        setAssignmentSelect(characterSelect, character ? characterState : { assigned: false, valid: true, profileName: '' }, `Inherit: “${characterFallback}”`);
        characterSelect.disabled = !character;
        characterSelect.dataset.promptTagsDisabled = String(!character);

        setAssignmentSelect(presetSelect, presetAvailable ? presetState : { assigned: false, valid: true, profileName: '' }, `Inherit: “${presetFallback}”`);
        presetSelect.disabled = !presetAvailable;
        presetSelect.dataset.promptTagsDisabled = String(!presetAvailable);
        presetSelect.title = presetAvailable
            ? `Applies while “${getCurrentPresetName()}” is equipped.`
            : 'Preset bindings apply to Chat Completion presets.';

        setScopeNote(chatScopeNote, 'chat', chatState, resolved, !!ctx.chatMetadata);
        setScopeNote(characterScopeNote, 'character', characterState, resolved, !!character);
        setScopeNote(presetScopeNote, 'preset', presetState, resolved, presetAvailable);
        setScopeNote(defaultScopeNote, 'global', defaultState, resolved);

        const statusText = {
            chat: `Using “${resolved.name}” for this chat through a chat override.`,
            character: `Using “${resolved.name}” through this character's override.`,
            preset: `Using “${resolved.name}” because the equipped preset is bound to it.`,
            global: `Using “${resolved.name}” as the default profile.`,
        }[resolved.scope];
        const invalidAssignments = [chatState, characterState, presetState].filter(state => state.assigned && !state.valid);
        const invalidNote = invalidAssignments.length
            ? ` Unavailable assignments: ${invalidAssignments.map(state => `${scopeLabels[state.scope]} “${state.reference}”`).join(', ')}. Choose the inherited option to clear them.`
            : '';
        activeNote.textContent = (editingProfile === resolved.name
            ? statusText
            : `${statusText} Editing “${editingProfile}”.`) + invalidNote;

        deleteButton.disabled = listProfiles().length <= 1;
        deleteButton.dataset.promptTagsDisabled = String(deleteButton.disabled);
        renderRecoveryControls();

        rebuildSections();
        rebuildPresetPrompts();
        renderConflicts();
        renderStoryOperation();
    }

    enabledBox.addEventListener('change', () => {
        setEnabled(enabledBox.checked);
        markSettingsQueued();
        conflictSignature = '';
        storyOperation = null;
        refresh();
    });

    editorSelect.addEventListener('change', () => {
        editingProfile = editorSelect.value;
        storyOperation = null;
        refresh();
    });

    defaultSelect.addEventListener('change', () => {
        setActiveProfile(defaultSelect.value);
        markSettingsQueued();
        conflictSignature = '';
        storyOperation = null;
        refresh();
    });

    addButton.addEventListener('click', () => {
        runAsyncAction(addButton, async () => {
            const name = await promptForText('Name the duplicate profile', `${editingProfile} copy`);
            if (!name) {
                return;
            }
            if (!createProfile(name, editingProfile)) {
                toast('A profile with that name already exists.', 'warning');
                return;
            }
            editingProfile = name;
            markSettingsQueued();
            refresh();
        });
    });

    resetButton.addEventListener('click', () => {
        runAsyncAction(resetButton, async () => {
            if (!await confirmAction('Reset profile', `Reset “${editingProfile}” to the shipped defaults?`)) {
                return;
            }
            const rules = getEditableRules(editingProfile);
            const defaults = createDefaultRules();
            for (const section of SECTIONS) {
                Object.assign(rules[section.id], defaults[section.id]);
            }
            save();
            markSettingsQueued();
            storyOperation = null;
            conflictSignature = '';
            toast(`Reset “${editingProfile}”.`, 'success');
            refresh();
        });
    });

    renameButton.addEventListener('click', () => {
        runAsyncAction(renameButton, async () => {
            const current = editingProfile;
            const name = await promptForText('Rename this profile', current);
            if (!name || name === current) {
                return;
            }
            if (!renameProfile(current, name)) {
                toast('A profile with that name already exists.', 'warning');
                return;
            }
            editingProfile = name;
            markSettingsQueued();
            refresh();
        });
    });

    deleteButton.addEventListener('click', () => {
        runAsyncAction(deleteButton, async () => {
            const current = editingProfile;
            if (!await confirmAction('Delete profile', `Delete the profile “${current}”? This cannot be undone.`)) {
                return;
            }
            if (!deleteProfile(current)) {
                toast('Keep at least one profile.', 'warning');
                return;
            }
            toast(`Deleted “${current}”.`, 'success');
            editingProfile = resolveProfile().name;
            markSettingsQueued();
            conflictSignature = '';
            storyOperation = null;
            refresh();
        });
    });

    exportButton.addEventListener('click', () => {
        const blob = new Blob([exportProfiles()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = el('a');
        link.href = url;
        link.download = 'prompt-tags-profiles.json';
        link.click();
        URL.revokeObjectURL(url);
    });

    importButton.addEventListener('click', () => {
        const picker = el('input');
        picker.type = 'file';
        picker.accept = 'application/json,.json';
        picker.addEventListener('change', () => {
            runAsyncAction(importButton, async () => {
                const file = picker.files?.[0];
                if (!file) {
                    return;
                }
                if (file.size > MAX_IMPORT_BYTES) {
                    const message = 'That import is too large. Choose a file smaller than 1 MB.';
                    renderImportReport({ error: message, imported: [], rejected: [] });
                    toast(message, 'error');
                    return;
                }
                const result = importProfiles(await file.text());
                renderImportReport(result);
                if (result.error) {
                    toast(result.error, 'error');
                    return;
                }
                const noun = result.imported.length === 1 ? 'profile' : 'profiles';
                if (result.rejected.length) {
                    toast(`Imported ${result.imported.length} ${noun}; rejected ${result.rejected.length} invalid profile(s).`, 'warning');
                } else {
                    toast(`Imported ${result.imported.length} ${noun}.`, 'success');
                }
                editingProfile = result.imported[0] ?? editingProfile;
                markSettingsQueued();
                refresh();
            }, { onError: message => {
                renderImportReport({ error: message, imported: [], rejected: [] });
                toast(message, 'error');
            } });
        });
        picker.click();
    });

    characterSelect.addEventListener('change', () => {
        runAsyncAction(characterSelect, async () => {
            const value = characterSelect.value === INVALID_ASSIGNMENT ? INHERIT : characterSelect.value;
            if (!await setCharacterProfile(value)) {
                throw new Error('The current character is unavailable.');
            }
            markSettingsQueued();
            conflictSignature = '';
            storyOperation = null;
            refresh();
        });
    });

    chatSelect.addEventListener('change', () => {
        const value = chatSelect.value === INVALID_ASSIGNMENT ? INHERIT : chatSelect.value;
        if (!setChatProfile(value)) {
            toast('The current chat is unavailable.', 'error');
            refresh();
            return;
        }
        markSettingsQueued();
        conflictSignature = '';
        storyOperation = null;
        refresh();
    });

    presetSelect.addEventListener('change', () => {
        const value = presetSelect.value === INVALID_ASSIGNMENT ? INHERIT : presetSelect.value;
        if (!setPresetProfile(value)) {
            toast('The equipped preset is unavailable.', 'error');
            refresh();
            return;
        }
        conflictSignature = '';
        storyOperation = null;
        refresh();
    });

    applyButton.addEventListener('click', () => {
        runAsyncAction(applyButton, async () => {
            const rules = getEditableRules(editingProfile) ?? {};
            let result = applyTags(rules);

            if (result.diverged) {
                const proceed = await confirmAction(
                    'Review context template',
                    'The template changed after Prompt Tags saved it. Updating may overwrite those edits. Continue? Tag removal is safer when you want to keep them.',
                );
                if (!proceed) {
                    storyOperation = { result, operation: 'update' };
                    renderStoryOperation();
                    return;
                }
                result = applyTags(rules, { force: true });
            }

            storyOperation = { result, operation: 'update' };
            if (!result.ok) {
                toast(result.error, 'error');
            } else if (result.changed) {
                toast(`Updated ${result.applied.length} section(s) in the current template.`, 'success');
            } else {
                toast('The current context template did not change.', 'info');
            }
            if (result.skipped?.length) {
                console.info('[Prompt Tags] Sections not updated in the context template:\n' + result.skipped.map(describeSkip).join('\n'));
            }
            refresh();
        });
    });

    restoreButton.addEventListener('click', () => {
        runAsyncAction(restoreButton, async () => {
            const rules = getEditableRules(editingProfile) ?? {};
            const state = getRecoveryState(rules);
            let result;
            if (state.diverged) {
                const proceed = await confirmAction(
                    'Restore saved version',
                    'The current template changed after tagging. Restoring will replace those edits. Continue?',
                );
                if (!proceed) {
                    result = { ok: false, diverged: true, error: 'Restore cancelled. The current template was not changed.' };
                } else {
                    result = restore(rules, { force: true });
                }
            } else {
                result = restore(rules);
            }
            storyOperation = { result, operation: 'restore' };
            if (!result.ok) {
                toast(result.error, 'warning');
            } else {
                toast('Restored the saved context template.', 'success');
            }
            refresh();
        });
    });

    removeButton.addEventListener('click', () => {
        runAsyncAction(removeButton, async () => {
            const rules = getEditableRules(editingProfile) ?? {};
            const result = removeTags(rules);
            storyOperation = { result, operation: 'remove' };
            if (!result.ok) {
                toast(result.error, 'warning');
            } else {
                toast('Removed this profile’s tags from the current template.', 'success');
            }
            refresh();
        });
    });

    presetButton.addEventListener('click', () => {
        runAsyncAction(presetButton, async () => {
            const rules = getEditableRules(editingProfile) ?? {};
            let initial = '';
            while (true) {
                const name = await promptForText('Name the tagged context preset', initial);
                if (!name) {
                    return;
                }
                const result = await saveAsPreset(name, rules);
                if (result.code === 'preset-collision') {
                    storyOperation = { result, operation: 'copy' };
                    renderStoryOperation();
                    toast(result.error, 'warning');
                    initial = result.suggestedName;
                    continue;
                }
                storyOperation = { result, operation: 'copy' };
                if (!result.ok) {
                    toast(result.error, 'error');
                    renderStoryOperation();
                    return;
                }
                toast(`Saved the context preset “${result.name}”.`, 'success');
                if (result.skipped?.length) {
                    console.info('[Prompt Tags] Sections not updated in the saved context preset:\n' + result.skipped.map(describeSkip).join('\n'));
                }
                refresh();
                return;
            }
        });
    });

    const unsubscribePresetWriteState = subscribePresetWriteState(() => {
        if (drawer.isConnected) {
            updateAutosaveStatus();
        }
    });
    existingCleanup = () => {
        unsubscribePresetWriteState();
        drawer.removeEventListener('inline-drawer-toggle', handleHostDrawerToggle);
        drawerStateObserver.disconnect();
    };

    refresh();
    existingRefresh = refresh;
    return refresh;
}

export function removeSettings() {
    existingCleanup?.();
    existingCleanup = null;
    document.getElementById(DRAWER_ID)?.remove();
    existingRefresh = null;
}
