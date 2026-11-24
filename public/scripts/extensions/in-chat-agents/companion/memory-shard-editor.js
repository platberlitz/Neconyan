/**
 * Section-aware Memory Shard editor surface for editCompanionResult().
 *
 * Lets humans edit Memory Shards section by section (with collapsible cards,
 * add/rename/reorder/remove controls and per-section fullscreen expand) or
 * switch to Raw Markdown at any time without losing content.
 */

import { attachTextareaFullscreen } from '../textarea-fullscreen.js';
import {
    countMemoryShardSectionLines,
    getMemoryShardSectionMeta,
    getMissingMemoryShardStandardSections,
    parseMemoryShardDocument,
    serializeMemoryShardDocument,
    summarizeMemoryShardSection,
} from './memory-shard-format.js';

const DEFAULT_MAX_CHARS = 65536;
const MIN_SECTION_ROWS = 4;
const MAX_SECTION_ROWS = 14;

/**
 * Compute an initial textarea row count that fits the section without excessive scrolling.
 *
 * @param {string} body
 * @returns {number}
 */
function computeSectionRows(body) {
    const lineCount = String(body || '').split('\n').length;
    return Math.max(MIN_SECTION_ROWS, Math.min(MAX_SECTION_ROWS, lineCount + 1));
}

/**
 * Build a readable count badge string for a section body.
 *
 * @param {string} body
 * @returns {string}
 */
function formatLineCountLabel(body) {
    const count = countMemoryShardSectionLines(body);
    if (count === 0) {
        return 'Empty';
    }
    return count === 1 ? '1 line' : `${count} lines`;
}

/**
 * Create an icon element using a verified Catline Font Awesome class name.
 *
 * @param {string} iconClass
 * @returns {HTMLElement}
 */
function createIcon(iconClass) {
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

/**
 * Create the interactive Memory Shard editor DOM and controller.
 *
 * @param {{
 *   initialContent?: string,
 *   maxLength?: number,
 * }} options
 * @returns {{
 *   root: HTMLDivElement,
 *   getValue: () => string,
 *   getMode: () => 'sections' | 'raw',
 *   setMode: (mode: 'sections' | 'raw') => void,
 *   focusPrimary: () => void,
 * }}
 */
export function createMemoryShardEditor({
    initialContent = '',
    maxLength = DEFAULT_MAX_CHARS,
} = {}) {
    const initialRaw = String(initialContent ?? '');
    let mode = 'sections';
    let sectionsDirty = false;
    let docState = parseMemoryShardDocument(initialRaw);

    /** @type {Map<string, boolean>} */
    const openByKey = new Map();
    const initialExpandAll = docState.sections.length <= 2;
    docState.sections.forEach((section, index) => {
        openByKey.set(makeSectionKey(section.heading, index), initialExpandAll || index === 0);
    });

    const root = document.createElement('div');
    root.className = 'ica--ms-editor';
    root.dataset.msEditorMode = mode;

    // Top toolbar: Sections / Raw toggle + Expand/Collapse all + live character count
    const toolbar = document.createElement('div');
    toolbar.className = 'ica--ms-editor-toolbar';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'ica--ms-editor-mode-toggle';
    modeGroup.setAttribute('role', 'tablist');
    modeGroup.setAttribute('aria-label', 'Editor view');

    const sectionsModeBtn = document.createElement('button');
    sectionsModeBtn.type = 'button';
    sectionsModeBtn.className = 'ica--ms-editor-mode-btn is-active';
    sectionsModeBtn.dataset.msMode = 'sections';
    sectionsModeBtn.setAttribute('role', 'tab');
    sectionsModeBtn.setAttribute('aria-selected', 'true');
    sectionsModeBtn.append(createIcon('fa-solid fa-list'), document.createTextNode(' Sections'));

    const rawModeBtn = document.createElement('button');
    rawModeBtn.type = 'button';
    rawModeBtn.className = 'ica--ms-editor-mode-btn';
    rawModeBtn.dataset.msMode = 'raw';
    rawModeBtn.setAttribute('role', 'tab');
    rawModeBtn.setAttribute('aria-selected', 'false');
    rawModeBtn.append(createIcon('fa-solid fa-code'), document.createTextNode(' Raw Markdown'));

    modeGroup.append(sectionsModeBtn, rawModeBtn);

    const toolbarMeta = document.createElement('div');
    toolbarMeta.className = 'ica--ms-editor-toolbar-meta';

    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.className = 'menu_button ica--ms-editor-toggle-all';
    toggleAllBtn.textContent = 'Expand all';

    const charCountEl = document.createElement('span');
    charCountEl.className = 'ica--ms-editor-char-count';
    charCountEl.setAttribute('aria-live', 'polite');

    toolbarMeta.append(toggleAllBtn, charCountEl);
    toolbar.append(modeGroup, toolbarMeta);
    root.appendChild(toolbar);

    // Sections view container
    const sectionsView = document.createElement('div');
    sectionsView.className = 'ica--ms-editor-sections-view';

    const titleRow = document.createElement('div');
    titleRow.className = 'ica--ms-editor-title-row';

    const titleLabel = document.createElement('label');
    titleLabel.className = 'ica--ms-editor-label';
    titleLabel.textContent = 'Shard heading';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'text_pole ica--ms-editor-title-input';
    titleInput.placeholder = 'MEMORY SHARD: A-1';
    titleInput.value = docState.title;
    titleInput.setAttribute('aria-label', 'Shard heading');

    titleRow.append(titleLabel, titleInput);
    sectionsView.appendChild(titleRow);

    // Optional preamble block (shown when preamble exists or there are no ## sections yet)
    const preambleBox = document.createElement('div');
    preambleBox.className = 'ica--ms-editor-preamble';

    const preambleLabel = document.createElement('label');
    preambleLabel.className = 'ica--ms-editor-label';
    preambleLabel.textContent = 'Opening notes';

    const preambleTextarea = document.createElement('textarea');
    preambleTextarea.className = 'text_pole ica--ms-editor-textarea ica--ms-editor-preamble-textarea';
    preambleTextarea.rows = 4;
    preambleTextarea.placeholder = 'Write a summary or add sections below.';
    preambleTextarea.value = docState.preamble;
    preambleTextarea.setAttribute('aria-label', 'Opening notes');

    preambleBox.append(preambleLabel, preambleTextarea);
    sectionsView.appendChild(preambleBox);

    // Collapsible section cards
    const cardsHost = document.createElement('div');
    cardsHost.className = 'ica--ms-editor-cards';
    sectionsView.appendChild(cardsHost);

    // Add section row
    const addRow = document.createElement('div');
    addRow.className = 'ica--ms-editor-add-row';

    const addSelect = document.createElement('select');
    addSelect.className = 'text_pole ica--ms-editor-add-select';
    addSelect.setAttribute('aria-label', 'Choose a section to add');

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'menu_button ica--ms-editor-add-btn';
    addBtn.append(createIcon('fa-solid fa-plus'), document.createTextNode(' Add section'));

    addRow.append(addSelect, addBtn);
    sectionsView.appendChild(addRow);

    root.appendChild(sectionsView);

    // Raw Markdown view container
    const rawView = document.createElement('div');
    rawView.className = 'ica--ms-editor-raw-view';
    rawView.hidden = true;

    const rawTextarea = document.createElement('textarea');
    rawTextarea.className = 'text_pole ica--ms-editor-raw-textarea';
    rawTextarea.rows = 16;
    rawTextarea.maxLength = maxLength;
    rawTextarea.value = initialRaw;
    rawTextarea.setAttribute('aria-label', 'Raw Memory Shard Markdown');

    rawView.appendChild(rawTextarea);
    root.appendChild(rawView);

    attachTextareaFullscreen(preambleTextarea);
    attachTextareaFullscreen(rawTextarea);

    /**
     * Build a stable map key for tracking section expanded state.
     *
     * @param {string} heading
     * @param {number} index
     * @returns {string}
     */
    function makeSectionKey(heading, index) {
        const clean = String(heading || '').trim().toLowerCase();
        return clean ? `h:${clean}` : `i:${index}`;
    }

    /**
     * Produce the current Markdown value for saving or syncing.
     *
     * @returns {string}
     */
    function getValue() {
        if (mode === 'raw') {
            return rawTextarea.value;
        }
        if (!sectionsDirty) {
            return initialRaw;
        }
        return serializeMemoryShardDocument(docState);
    }

    /**
     * Refresh character counter text and limit warning state.
     */
    function updateCharCounter() {
        const length = getValue().length;
        charCountEl.textContent = `${length.toLocaleString()} / ${maxLength.toLocaleString()}`;
        const overLimit = length > maxLength;
        const nearLimit = !overLimit && length > maxLength * 0.9;
        charCountEl.dataset.tone = overLimit ? 'error' : (nearLimit ? 'warning' : 'normal');
    }

    /**
     * Update Expand all / Collapse all button visibility and label.
     */
    function updateToggleAllButton() {
        const total = docState.sections.length;
        toggleAllBtn.hidden = mode !== 'sections' || total < 2;
        if (toggleAllBtn.hidden) {
            return;
        }
        const allOpen = docState.sections.every((section, index) => (
            openByKey.get(makeSectionKey(section.heading, index)) === true
        ));
        toggleAllBtn.textContent = allOpen ? 'Collapse all' : 'Expand all';
    }

    /**
     * Refresh the "+ Add section" dropdown with standard sections not yet in the shard.
     */
    function refreshAddSectionOptions() {
        const previous = addSelect.value;
        addSelect.textContent = '';

        const missing = getMissingMemoryShardStandardSections(docState.sections);
        for (const preset of missing) {
            const opt = document.createElement('option');
            opt.value = `preset:${preset.id}`;
            opt.textContent = preset.heading;
            addSelect.appendChild(opt);
        }

        const customOpt = document.createElement('option');
        customOpt.value = 'custom';
        customOpt.textContent = 'Custom section...';
        addSelect.appendChild(customOpt);

        if (previous && Array.from(addSelect.options).some((opt) => opt.value === previous)) {
            addSelect.value = previous;
        }
    }

    /**
     * Toggle visibility of the opening-notes field.
     */
    function syncPreambleVisibility() {
        const hasPreamble = docState.preamble.trim().length > 0;
        const hasSections = docState.sections.length > 0;
        preambleBox.hidden = hasSections && !hasPreamble;
        preambleTextarea.value = docState.preamble;
    }

    /**
     * Render all collapsible section cards from `docState.sections`.
     *
     * @param {{ focusIndex?: number, focusTarget?: 'body' | 'heading' }} [focusOptions]
     */
    function renderSectionCards(focusOptions = {}) {
        cardsHost.textContent = '';
        syncPreambleVisibility();
        refreshAddSectionOptions();

        /** @type {HTMLElement | null} */
        let focusElement = null;

        docState.sections.forEach((section, index) => {
            const meta = getMemoryShardSectionMeta(section.heading);
            const key = makeSectionKey(section.heading, index);
            const isOpen = openByKey.get(key) === true;

            const card = document.createElement('section');
            card.className = 'ica--ms-editor-card';
            card.dataset.msTone = meta.tone;
            card.dataset.msSectionIndex = String(index);
            if (isOpen) {
                card.classList.add('is-open');
            }

            // Header toggle button
            const headerBtn = document.createElement('button');
            headerBtn.type = 'button';
            headerBtn.className = 'ica--ms-editor-card-header';
            headerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

            const iconChip = document.createElement('span');
            iconChip.className = 'ica--ms-editor-card-icon';
            iconChip.appendChild(createIcon(meta.icon));

            const titleWrap = document.createElement('span');
            titleWrap.className = 'ica--ms-editor-card-title-wrap';

            const headingTextEl = document.createElement('span');
            headingTextEl.className = 'ica--ms-editor-card-heading';
            headingTextEl.textContent = section.heading || 'Untitled section';

            const previewEl = document.createElement('span');
            previewEl.className = 'ica--ms-editor-card-preview';
            previewEl.textContent = summarizeMemoryShardSection(section.body) || 'Empty section';

            titleWrap.append(headingTextEl, previewEl);

            const countBadge = document.createElement('span');
            countBadge.className = 'ica--ms-editor-card-count';
            countBadge.textContent = formatLineCountLabel(section.body);

            const chevron = createIcon('fa-solid fa-chevron-down ica--ms-editor-card-chevron');

            headerBtn.append(iconChip, titleWrap, countBadge, chevron);

            // Body container
            const bodyEl = document.createElement('div');
            bodyEl.className = 'ica--ms-editor-card-body';
            bodyEl.hidden = !isOpen;

            const controlsRow = document.createElement('div');
            controlsRow.className = 'ica--ms-editor-card-controls';

            const headingInput = document.createElement('input');
            headingInput.type = 'text';
            headingInput.className = 'text_pole ica--ms-editor-section-heading';
            headingInput.value = section.heading;
            headingInput.placeholder = 'Section name';
            headingInput.setAttribute('aria-label', 'Section name');

            const moveUpBtn = document.createElement('button');
            moveUpBtn.type = 'button';
            moveUpBtn.className = 'menu_button ica--ms-editor-icon-btn';
            moveUpBtn.title = 'Move section up';
            moveUpBtn.setAttribute('aria-label', 'Move section up');
            moveUpBtn.disabled = index === 0;
            moveUpBtn.appendChild(createIcon('fa-solid fa-chevron-up'));

            const moveDownBtn = document.createElement('button');
            moveDownBtn.type = 'button';
            moveDownBtn.className = 'menu_button ica--ms-editor-icon-btn';
            moveDownBtn.title = 'Move section down';
            moveDownBtn.setAttribute('aria-label', 'Move section down');
            moveDownBtn.disabled = index === docState.sections.length - 1;
            moveDownBtn.appendChild(createIcon('fa-solid fa-chevron-down'));

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'menu_button ica--ms-editor-icon-btn ica--ms-editor-remove-btn';
            removeBtn.title = 'Remove section';
            removeBtn.setAttribute('aria-label', 'Remove section');
            removeBtn.appendChild(createIcon('fa-solid fa-trash-can'));

            controlsRow.append(headingInput, moveUpBtn, moveDownBtn, removeBtn);

            const bodyTextarea = document.createElement('textarea');
            bodyTextarea.className = 'text_pole ica--ms-editor-textarea';
            bodyTextarea.rows = computeSectionRows(section.body);
            bodyTextarea.value = section.body;
            bodyTextarea.placeholder = meta.placeholder;
            bodyTextarea.setAttribute('aria-label', section.heading ? `${section.heading} notes` : 'Section notes');

            bodyEl.append(controlsRow, bodyTextarea);
            card.append(headerBtn, bodyEl);
            cardsHost.appendChild(card);

            attachTextareaFullscreen(bodyTextarea);

            // Interactions
            headerBtn.addEventListener('click', () => {
                const nextOpen = !card.classList.contains('is-open');
                card.classList.toggle('is-open', nextOpen);
                bodyEl.hidden = !nextOpen;
                headerBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                openByKey.set(makeSectionKey(section.heading, index), nextOpen);
                updateToggleAllButton();
            });

            headingInput.addEventListener('input', () => {
                const prevKey = makeSectionKey(section.heading, index);
                section.heading = headingInput.value;
                sectionsDirty = true;
                const nextKey = makeSectionKey(section.heading, index);
                if (prevKey !== nextKey) {
                    const wasOpen = openByKey.get(prevKey) === true;
                    openByKey.delete(prevKey);
                    openByKey.set(nextKey, wasOpen);
                }
                const nextMeta = getMemoryShardSectionMeta(section.heading);
                card.dataset.msTone = nextMeta.tone;
                headingTextEl.textContent = section.heading.trim() || 'Untitled section';
                iconChip.textContent = '';
                iconChip.appendChild(createIcon(nextMeta.icon));
                bodyTextarea.placeholder = nextMeta.placeholder;
                bodyTextarea.setAttribute('aria-label', section.heading.trim() ? `${section.heading.trim()} notes` : 'Section notes');
                refreshAddSectionOptions();
                updateCharCounter();
            });

            bodyTextarea.addEventListener('input', () => {
                section.body = bodyTextarea.value;
                sectionsDirty = true;
                previewEl.textContent = summarizeMemoryShardSection(section.body) || 'Empty section';
                countBadge.textContent = formatLineCountLabel(section.body);
                updateCharCounter();
            });

            moveUpBtn.addEventListener('click', () => {
                if (index <= 0) {
                    return;
                }
                const [moved] = docState.sections.splice(index, 1);
                docState.sections.splice(index - 1, 0, moved);
                sectionsDirty = true;
                renderSectionCards();
            });

            moveDownBtn.addEventListener('click', () => {
                if (index >= docState.sections.length - 1) {
                    return;
                }
                const [moved] = docState.sections.splice(index, 1);
                docState.sections.splice(index + 1, 0, moved);
                sectionsDirty = true;
                renderSectionCards();
            });

            removeBtn.addEventListener('click', () => {
                openByKey.delete(makeSectionKey(section.heading, index));
                docState.sections.splice(index, 1);
                sectionsDirty = true;
                renderSectionCards();
                updateCharCounter();
            });

            if (focusOptions.focusIndex === index) {
                focusElement = focusOptions.focusTarget === 'heading' ? headingInput : bodyTextarea;
            }
        });

        updateToggleAllButton();
        updateCharCounter();

        if (focusElement) {
            focusElement.focus();
            if (focusElement instanceof HTMLTextAreaElement) {
                const end = focusElement.value.length;
                focusElement.setSelectionRange(end, end);
            }
        }
    }

    /**
     * Switch between Sections view and Raw Markdown view, preserving content in both directions.
     *
     * @param {'sections' | 'raw'} nextMode
     */
    function setMode(nextMode) {
        if (nextMode !== 'sections' && nextMode !== 'raw') {
            return;
        }
        if (nextMode === mode) {
            return;
        }

        if (nextMode === 'raw') {
            rawTextarea.value = getValue();
            mode = 'raw';
            root.dataset.msEditorMode = mode;
            sectionsView.hidden = true;
            rawView.hidden = false;
            sectionsModeBtn.classList.remove('is-active');
            rawModeBtn.classList.add('is-active');
            sectionsModeBtn.setAttribute('aria-selected', 'false');
            rawModeBtn.setAttribute('aria-selected', 'true');
            updateToggleAllButton();
            updateCharCounter();
            rawTextarea.focus();
            return;
        }

        // Switching Raw -> Sections
        const rawText = rawTextarea.value;
        docState = parseMemoryShardDocument(rawText);
        if (rawText !== initialRaw) {
            sectionsDirty = true;
        }
        titleInput.value = docState.title;
        if (docState.sections.length > 0 && !docState.sections.some((section, index) => openByKey.has(makeSectionKey(section.heading, index)))) {
            openByKey.set(makeSectionKey(docState.sections[0].heading, 0), true);
        }
        mode = 'sections';
        root.dataset.msEditorMode = mode;
        rawView.hidden = true;
        sectionsView.hidden = false;
        sectionsModeBtn.classList.add('is-active');
        rawModeBtn.classList.remove('is-active');
        sectionsModeBtn.setAttribute('aria-selected', 'true');
        rawModeBtn.setAttribute('aria-selected', 'false');
        renderSectionCards();
    }

    // Event bindings
    sectionsModeBtn.addEventListener('click', () => setMode('sections'));
    rawModeBtn.addEventListener('click', () => setMode('raw'));

    titleInput.addEventListener('input', () => {
        docState.title = titleInput.value;
        sectionsDirty = true;
        updateCharCounter();
    });

    preambleTextarea.addEventListener('input', () => {
        docState.preamble = preambleTextarea.value;
        sectionsDirty = true;
        updateCharCounter();
    });

    rawTextarea.addEventListener('input', () => {
        updateCharCounter();
    });

    toggleAllBtn.addEventListener('click', () => {
        const allOpen = docState.sections.every((section, index) => (
            openByKey.get(makeSectionKey(section.heading, index)) === true
        ));
        const targetOpen = !allOpen;
        docState.sections.forEach((section, index) => {
            openByKey.set(makeSectionKey(section.heading, index), targetOpen);
        });
        renderSectionCards();
    });

    addBtn.addEventListener('click', () => {
        const selected = addSelect.value;
        let heading = 'Notes';
        let body = '';
        let focusTarget = /** @type {'body' | 'heading'} */ ('body');

        if (selected.startsWith('preset:')) {
            const presetId = selected.slice('preset:'.length);
            const missing = getMissingMemoryShardStandardSections(docState.sections);
            const preset = missing.find((entry) => entry.id === presetId);
            if (preset) {
                heading = preset.heading;
                body = preset.starter;
            }
        } else {
            heading = '';
            focusTarget = 'heading';
        }

        const nextIndex = docState.sections.length;
        docState.sections.push({ heading, body });
        openByKey.set(makeSectionKey(heading, nextIndex), true);
        sectionsDirty = true;
        renderSectionCards({ focusIndex: nextIndex, focusTarget });
    });

    // Initial render
    renderSectionCards();

    return {
        root,
        getValue,
        getMode: () => mode,
        setMode,
        focusPrimary() {
            if (mode === 'raw') {
                rawTextarea.focus();
                return;
            }
            const firstOpenTextarea = cardsHost.querySelector('.ica--ms-editor-card.is-open textarea');
            if (firstOpenTextarea instanceof HTMLTextAreaElement) {
                firstOpenTextarea.focus();
                return;
            }
            if (!preambleBox.hidden) {
                preambleTextarea.focus();
                return;
            }
            titleInput.focus();
        },
    };
}
