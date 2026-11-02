import { t } from './i18n.js';
import { getAssistantIconSrc } from './neconyan-assistant-art.js';
import {
    MISO_GUIDE_ANSWERS_VERSION,
    MISO_GUIDE_QUESTIONS,
    createDefaultMisoGuideAnswers,
    getMisoUndoBlockReason,
    isSameMisoSettingValue,
    mergeMisoSelection,
    normalizeMisoGuideAnswers,
    recommendSettings,
    sortMisoTargetsForApply,
} from './miso-settings-recommendations.js';

const GUIDE_ROOT_ID = 'nn-settings-miso-guide';
const GUIDE_TRIGGER_ID = 'nn-settings-ask-miso';
const SHELL_APPEARANCE_CONTROL_IDS = new Set([
    'sb-desktop-compact-mode-input',
    'sb-mobile-compact-mode-input',
    'sb-kittyless-enabled-input',
]);

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function button(label, className = 'menu_button') {
    const node = element('button', className, label);
    node.type = 'button';
    return node;
}

function appliedMessage(count) {
    return count === 1 ? t`Applied 1 setting.` : t`Applied ${count} settings.`;
}

function readSavedAnswers(deps) {
    try {
        const raw = deps.loadAnswers?.();
        if (!raw) return null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const candidate = parsed.answers ?? parsed;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        if (!['look', 'reading', 'chatting', 'device'].some(key => key in candidate)) return null;
        return {
            answers: normalizeMisoGuideAnswers(candidate),
            version: parsed.version ?? MISO_GUIDE_ANSWERS_VERSION,
        };
    } catch {
        return null;
    }
}

function writeSavedAnswers(deps, answers) {
    try {
        const saved = deps.saveAnswers?.({ version: MISO_GUIDE_ANSWERS_VERSION, answers: normalizeMisoGuideAnswers(answers) });
        if (saved && typeof saved.catch === 'function') saved.catch(() => {});
    } catch {
        // Answers stay in memory when account storage is blocked.
    }
}

/**
 * Builds the inline guide inside the Settings page. The caller owns every
 * setting read, write, snapshot and restore through `deps`.
 */
export function createMisoSettingsGuide({ root, deps = {} }) {
    if (!(root instanceof HTMLElement)) throw new Error('Miso\'s settings guide needs its page section.');

    let answers = createDefaultMisoGuideAnswers();
    let stepIndex = 0;
    let view = 'questions';
    let result = null;
    let selectedSettingIds = new Set();
    let knownSettingIds = new Set();
    let busy = false;
    let undoState = null;
    let undoBlockedReason = '';
    let lastFocus = null;
    let savedAnswersAvailable = false;
    let status = { text: '', tone: '' };
    let built = false;
    let primaryButton = null;
    let portrait = null;
    let settingsRefreshTimer = 0;
    let settingsContent = null;
    let settingsBlock = null;

    const body = element('div', 'nn-miso-guide-body');
    const statusRegion = element('p', 'nn-miso-guide-status');
    statusRegion.setAttribute('role', 'status');
    statusRegion.setAttribute('aria-live', 'polite');

    const closeButton = button(t`Close`, 'menu_button nn-miso-guide-close');
    closeButton.setAttribute('aria-label', t`Close Miso's settings guide`);
    closeButton.addEventListener('click', () => close());

    function build() {
        if (built) return;
        built = true;
        const header = element('header', 'nn-miso-guide-header');
        portrait = element('img', 'nn-miso-guide-portrait');
        portrait.alt = '';
        portrait.width = 48;
        portrait.height = 48;
        portrait.decoding = 'async';
        updatePortrait();
        const copy = element('div', 'nn-miso-guide-copy');
        copy.append(
            element('p', 'nn-miso-guide-kicker', t`Miso asks, you decide`),
            element('h3', 'nn-miso-guide-title', t`Help me choose`),
        );
        copy.querySelector('h3')?.setAttribute('id', `${GUIDE_ROOT_ID}-title`);
        const lead = element('p', 'nn-miso-guide-lead', t`Four short questions. Miso suggests settings for how you read and chat, and nothing changes until you press the button.`);
        header.append(portrait, copy, closeButton);
        root.append(header, lead, body, statusRegion);
        if (!root.getAttribute('aria-label')) root.setAttribute('aria-label', t`Miso's settings guide`);
    }

    function updatePortrait() {
        if (!portrait) return;
        const next = getAssistantIconSrc('miso');
        if (portrait.getAttribute('src') !== next) portrait.src = next;
    }

    function setStatus(text = '', tone = '') {
        status = { text: String(text ?? ''), tone };
        statusRegion.textContent = status.text;
        statusRegion.dataset.tone = tone;
        statusRegion.hidden = !status.text;
    }

    function saveAnswers() {
        writeSavedAnswers(deps, answers);
        savedAnswersAvailable = true;
    }

    function blockedReason() {
        try {
            return String(deps.getBlockedReason?.() || '').trim();
        } catch (error) {
            return error?.message || t`The settings page is not ready yet.`;
        }
    }

    function readValues() {
        try {
            return deps.getValues?.() ?? {};
        } catch {
            return null;
        }
    }

    function pruneUndoState() {
        if (!undoState) {
            undoBlockedReason = '';
            return;
        }
        const current = readValues();
        if (!current) {
            undoBlockedReason = t`Miso could not read the settings to check this Undo. Check them in Settings.`;
            return;
        }
        let currentPreferences = null;
        try {
            currentPreferences = deps.getLowMemoryPreferences?.() ?? null;
        } catch {
            undoBlockedReason = t`Miso could not read the low-memory choices. Check them before undoing.`;
            return;
        }
        undoBlockedReason = getMisoUndoBlockReason({
            applied: undoState.appliedValues,
            current,
            expectedPreferences: undoState.preferences,
            currentPreferences,
        });
    }

    function computeResults({ resetSelection = false } = {}) {
        const previousSelection = new Set(selectedSettingIds);
        const previousKnown = new Set(knownSettingIds);
        const values = readValues();
        if (!values) {
            result = null;
            setStatus(t`Miso could not read the settings on this page. Try again.`, 'error');
            return;
        }
        try {
            const lockedSettings = deps.getLockedSettings?.() ?? {};
            const locked = Array.isArray(lockedSettings) ? lockedSettings : Object.keys(lockedSettings);
            const lockedReasons = Array.isArray(lockedSettings) ? {} : lockedSettings;
            result = recommendSettings(answers, { values, locked, lockedReasons });
        } catch (error) {
            result = null;
            setStatus(error?.message || t`Miso could not read the settings on this page. Try again.`, 'error');
            return;
        }
        selectedSettingIds = mergeMisoSelection({
            previousSelection,
            previousKnown,
            picks: result.picks,
            resetSelection,
        });
        knownSettingIds = new Set(result.picks.map(pick => pick.settingId));
    }

    function setExpanded(expanded) {
        const trigger = document.getElementById(GUIDE_TRIGGER_ID);
        if (trigger instanceof HTMLElement) trigger.setAttribute('aria-expanded', String(Boolean(expanded)));
    }

    function focusFirstControl() {
        const target = body.querySelector('input:not([disabled]), button:not([disabled])')
            ?? root.querySelector('.nn-miso-guide-header h3');
        target?.focus?.();
    }

    function open() {
        if (busy) return;
        build();
        lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const saved = readSavedAnswers(deps);
        setStatus();
        updatePortrait();
        if (saved) {
            answers = saved.answers;
            savedAnswersAvailable = true;
            view = 'results';
            stepIndex = 0;
            pruneUndoState();
            computeResults({ resetSelection: true });
        } else {
            answers = createDefaultMisoGuideAnswers();
            savedAnswersAvailable = false;
            view = 'questions';
            stepIndex = 0;
            result = null;
            selectedSettingIds = new Set();
            knownSettingIds = new Set();
        }
        root.hidden = false;
        setExpanded(true);
        render();
        focusFirstControl();
    }

    function close() {
        if (busy || root.hidden) return;
        root.hidden = true;
        setExpanded(false);
        const focusTarget = lastFocus instanceof HTMLElement && document.contains(lastFocus)
            ? lastFocus
            : document.getElementById(GUIDE_TRIGGER_ID);
        focusTarget?.focus?.({ preventScroll: true });
        focusTarget?.scrollIntoView?.({ block: 'nearest' });
    }

    function reset() {
        if (busy) return;
        answers = createDefaultMisoGuideAnswers();
        stepIndex = 0;
        view = 'questions';
        result = null;
        selectedSettingIds = new Set();
        knownSettingIds = new Set();
        undoState = null;
        undoBlockedReason = '';
        savedAnswersAvailable = false;
        setStatus();
        if (!root.hidden) render();
    }

    function scheduleSettingsRefresh() {
        if (!built || root.hidden || view !== 'results' || busy) return;
        if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
        settingsRefreshTimer = setTimeout(() => {
            settingsRefreshTimer = 0;
            refresh();
        }, 150);
    }

    function refresh() {
        if (busy || root.hidden || view !== 'results') return;
        const activeElement = document.activeElement;
        const activeId = activeElement instanceof HTMLElement && body.contains(activeElement) ? activeElement.id : '';
        const skippedOpen = Boolean(body.querySelector('.nn-miso-guide-skipped')?.open);
        pruneUndoState();
        computeResults();
        render();
        const skipped = body.querySelector('.nn-miso-guide-skipped');
        if (skippedOpen && skipped instanceof HTMLDetailsElement) skipped.open = true;
        if (activeId) document.getElementById(activeId)?.focus?.({ preventScroll: true });
    }

    function changeStep(delta) {
        const next = stepIndex + delta;
        if (next < 0 || next >= MISO_GUIDE_QUESTIONS.length) return;
        stepIndex = next;
        setStatus();
        render();
        focusFirstControl();
    }

    function showResults() {
        saveAnswers();
        setStatus();
        computeResults({ resetSelection: true });
        view = 'results';
        render();
        root.scrollIntoView?.({ block: 'start' });
        body.querySelector('h4')?.focus?.({ preventScroll: true });
    }

    function changeAnswers() {
        setStatus();
        view = 'questions';
        stepIndex = 0;
        render();
        focusFirstControl();
    }

    function useLastAnswers() {
        const saved = readSavedAnswers(deps);
        if (!saved) {
            setStatus(t`There are no saved answers yet.`, 'warn');
            render();
            return;
        }
        answers = saved.answers;
        savedAnswersAvailable = true;
        view = 'results';
        computeResults({ resetSelection: true });
        setStatus(t`Using your last answers.`, 'saved');
        render();
        root.scrollIntoView?.({ block: 'start' });
        body.querySelector('h4')?.focus?.({ preventScroll: true });
    }

    function answerValues(question) {
        return question.type === 'radio' ? [answers[question.id]] : answers[question.id];
    }

    function toggleAnswer(question, input) {
        if (question.type === 'radio') {
            answers = { ...answers, [question.id]: input.value };
        } else {
            const next = new Set(answers[question.id]);
            if (input.checked) {
                if (question.singleChoice?.includes(input.value)) {
                    for (const other of question.singleChoice) next.delete(other);
                }
                next.add(input.value);
            } else {
                next.delete(input.value);
            }
            answers = { ...answers, [question.id]: [...next] };
        }
        answers = normalizeMisoGuideAnswers(answers);
        if (input.checked && question.singleChoice?.includes(input.value)) {
            for (const other of question.singleChoice) {
                if (other === input.value) continue;
                const sibling = document.getElementById(`nn-miso-guide-${question.id}-${other}`);
                if (sibling instanceof HTMLInputElement) sibling.checked = false;
            }
        }
        setStatus();
    }

    function renderQuestions() {
        const question = MISO_GUIDE_QUESTIONS[stepIndex];
        primaryButton = null;
        const progress = element('p', 'nn-miso-guide-progress', t`Step ${stepIndex + 1} of ${MISO_GUIDE_QUESTIONS.length}`);
        const form = element('form', 'nn-miso-guide-form');
        form.noValidate = true;
        const fieldset = element('fieldset', 'nn-miso-guide-fieldset');
        const legend = element('legend', '', question.title);
        const help = element('p', 'nn-miso-guide-help', question.help);
        fieldset.append(legend, help);

        const selected = new Set(answerValues(question));
        for (const option of question.options) {
            const label = element('label', 'nn-miso-guide-option');
            const input = element('input');
            input.type = question.type;
            input.name = `nn-miso-guide-${question.id}`;
            input.value = option.value;
            input.id = `nn-miso-guide-${question.id}-${option.value}`;
            input.checked = selected.has(option.value);
            input.addEventListener('change', () => toggleAnswer(question, input));
            const text = element('span', 'nn-miso-guide-option-copy');
            text.append(element('strong', '', option.label), element('small', '', option.hint));
            label.append(input, text);
            fieldset.append(label);
        }

        const actions = element('div', 'nn-miso-guide-actions');
        const back = button(t`Back`);
        back.disabled = stepIndex === 0;
        back.addEventListener('click', () => changeStep(-1));
        const next = button(stepIndex === MISO_GUIDE_QUESTIONS.length - 1 ? t`Show my settings` : t`Next`, 'menu_button menu_button_primary');
        next.type = 'submit';
        actions.append(back, next);
        form.append(fieldset, actions);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (stepIndex === MISO_GUIDE_QUESTIONS.length - 1) showResults();
            else changeStep(1);
        });

        body.replaceChildren(progress, form);
    }

    function selectedPickCount() {
        if (!result) return 0;
        return result.picks.filter(pick => selectedSettingIds.has(pick.settingId)).length;
    }

    function updatePrimaryButton() {
        if (!primaryButton) return;
        const count = selectedPickCount();
        primaryButton.textContent = count
            ? (count === 1 ? t`Apply 1 setting` : t`Apply ${count} settings`)
            : t`Tick at least one setting`;
        primaryButton.disabled = busy || Boolean(blockedReason()) || count === 0;
        primaryButton.setAttribute('aria-busy', String(busy));
    }

    function makePickRow(pick, { alreadySet = false } = {}) {
        const label = element('label', `nn-miso-guide-row${alreadySet ? ' is-already-set' : ''}`);
        const input = element('input');
        input.type = 'checkbox';
        input.id = `nn-miso-guide-pick-${pick.settingId}`;
        input.value = pick.settingId;
        input.checked = alreadySet || selectedSettingIds.has(pick.settingId);
        if (alreadySet) {
            input.disabled = true;
        } else {
            input.addEventListener('change', () => {
                if (input.checked) selectedSettingIds.add(pick.settingId);
                else selectedSettingIds.delete(pick.settingId);
                updatePrimaryButton();
            });
        }

        const copy = element('span', 'nn-miso-guide-row-copy');
        const title = element('span', 'nn-miso-guide-row-title');
        title.append(element('strong', '', pick.title));
        if (alreadySet) title.append(element('span', 'nn-miso-guide-badge', t`Already set`));
        const targetLine = element('span', 'nn-miso-guide-target');
        targetLine.textContent = alreadySet
            ? t`Already set to ${pick.valueLabel}.`
            : t`Set to ${pick.valueLabel}`;
        const reasons = element('span', 'nn-miso-guide-reasons', pick.reasons.join(' '));
        const location = element('span', 'nn-miso-guide-location', t`Find it in ${pick.location}`);
        copy.append(title, targetLine, reasons, location);
        label.append(input, copy);
        return label;
    }

    function renderResults() {
        pruneUndoState();
        if (!result) computeResults({ resetSelection: true });
        if (!result) {
            primaryButton = null;
            const retry = button(t`Try again`);
            retry.addEventListener('click', () => { computeResults(); render(); });
            body.replaceChildren(retry);
            return;
        }

        const heading = element('h4', 'nn-miso-guide-results-title', t`Settings Miso suggests`);
        heading.tabIndex = -1;
        const notes = element('ul', 'nn-miso-guide-notes');
        for (const note of result.notes) notes.append(element('li', '', note));

        const list = element('div', 'nn-miso-guide-rows');
        for (const pick of result.picks) list.append(makePickRow(pick));
        for (const pick of result.alreadySet) list.append(makePickRow(pick, { alreadySet: true }));
        if (!result.picks.length && !result.alreadySet.length) {
            list.append(element('p', 'nn-miso-guide-empty', t`Nothing matches those answers yet. Go back, choose an answer and look again.`));
        }

        const skipped = element('details', 'nn-miso-guide-skipped');
        const skippedSummary = element('summary', '', t`Not changed (${result.skipped.length})`);
        skipped.append(skippedSummary);
        if (result.skipped.length) {
            const skippedList = element('ul');
            for (const entry of result.skipped) {
                const item = element('li');
                item.append(element('strong', '', entry.title), element('span', '', entry.reason));
                skippedList.append(item);
            }
            skipped.append(skippedList);
        } else {
            skipped.append(element('p', '', t`Every suggested setting is in the list above.`));
        }

        const primary = button('', 'menu_button menu_button_primary nn-miso-guide-primary');
        primary.id = 'nn-miso-guide-apply';
        primaryButton = primary;
        updatePrimaryButton();
        primary.addEventListener('click', applySelected);

        const actions = element('div', 'nn-miso-guide-actions');
        const change = button(t`Change answers`);
        change.id = 'nn-miso-guide-change';
        change.disabled = busy;
        change.addEventListener('click', changeAnswers);
        const lastAnswers = button(t`Use my last answers`);
        lastAnswers.id = 'nn-miso-guide-last-answers';
        lastAnswers.disabled = busy || !savedAnswersAvailable;
        lastAnswers.addEventListener('click', useLastAnswers);
        const closeInline = button(t`Close`);
        closeInline.id = 'nn-miso-guide-inline-close';
        closeInline.disabled = busy;
        closeInline.addEventListener('click', close);
        actions.append(primary, change, lastAnswers, closeInline);

        const applied = undoState ? element('div', 'nn-miso-guide-applied') : null;
        if (applied) {
            applied.append(element('span', '', appliedMessage(undoState.settings.length)));
            const undo = button(t`Undo`);
            undo.id = 'nn-miso-guide-undo';
            undo.disabled = busy || Boolean(undoBlockedReason);
            undo.addEventListener('click', undoApplied);
            applied.append(undo);
            if (undoBlockedReason) applied.append(element('small', 'nn-miso-guide-undo-blocked', undoBlockedReason));
        }

        body.replaceChildren(heading);
        body.append(notes);
        if (applied) body.append(applied);
        body.append(list);
        if (result.skipped.length) body.append(skipped);
        body.append(actions);
    }

    function render() {
        closeButton.disabled = busy;
        root.setAttribute('aria-busy', String(busy));
        if (view === 'results') renderResults();
        else renderQuestions();
    }

    function applySelected() {
        if (busy) return;
        const blocked = blockedReason();
        if (blocked) {
            setStatus(blocked, 'error');
            render();
            return;
        }
        saveAnswers();
        const requested = new Set(selectedSettingIds);
        computeResults();
        if (!result) {
            render();
            return;
        }
        const selected = sortMisoTargetsForApply(
            result.picks.filter(pick => requested.has(pick.settingId)),
        );
        if (!selected.length) {
            setStatus(t`Tick at least one setting first.`, 'warn');
            render();
            return;
        }
        if (typeof deps.applySetting !== 'function'
            || typeof deps.captureSnapshot !== 'function'
            || typeof deps.restoreSnapshot !== 'function') {
            setStatus(t`This page cannot change settings right now. Reload and try again.`, 'error');
            render();
            return;
        }

        busy = true;
        setStatus(selected.length === 1 ? t`Applying 1 setting…` : t`Applying ${selected.length} settings…`, 'working');
        render();
        let snapshot = null;
        let rolledBack = false;
        try {
            snapshot = deps.captureSnapshot(selected.map(pick => pick.settingId));
            for (const pick of selected) {
                deps.applySetting(pick.settingId, pick.value);
            }
            const values = readValues();
            if (!values) throw new Error(t`Miso could not read the settings after changing them.`);
            const failed = selected.find(pick => !isSameMisoSettingValue(values[pick.settingId], pick.value));
            if (failed) {
                throw new Error(t`${failed.title} did not keep the new value. Nothing was applied.`);
            }
            let preferences = null;
            if (selected.some(pick => pick.settingId === 'fastUi' || pick.settingId === 'chatTruncation')) {
                try {
                    preferences = deps.getLowMemoryPreferences?.() ?? null;
                } catch {
                    preferences = null;
                }
            }
            undoState = {
                settings: selected,
                snapshot,
                appliedValues: Object.fromEntries(selected.map(pick => [pick.settingId, pick.value])),
                preferences,
            };
            undoBlockedReason = '';
            setStatus(appliedMessage(selected.length), 'saved');
            deps.onApplied?.();
            computeResults();
            view = 'results';
        } catch (error) {
            if (snapshot) {
                try {
                    deps.restoreSnapshot(snapshot);
                    rolledBack = true;
                } catch {
                    rolledBack = false;
                }
            }
            const message = error?.message || t`Miso could not apply those settings.`;
            setStatus(
                rolledBack
                    ? t`${message} The earlier values were put back.`
                    : t`${message} Check the settings before trying again.`,
                'error',
            );
            computeResults();
        } finally {
            busy = false;
            render();
            body.querySelector('.nn-miso-guide-primary, .nn-miso-guide-applied button')?.focus?.({ preventScroll: true });
        }
    }

    function undoApplied() {
        if (busy || !undoState) return;
        pruneUndoState();
        if (undoBlockedReason) {
            setStatus(undoBlockedReason, 'warn');
            render();
            return;
        }
        const current = undoState;
        busy = true;
        setStatus(current.settings.length === 1 ? t`Putting 1 setting back…` : t`Putting ${current.settings.length} settings back…`, 'working');
        render();
        try {
            if (typeof deps.restoreSnapshot !== 'function') throw new Error(t`That change cannot be undone from here.`);
            deps.restoreSnapshot(current.snapshot);
            const values = readValues();
            if (!values) throw new Error(t`Miso could not read the settings after putting them back.`);
            const failed = current.settings.find(pick => !isSameMisoSettingValue(
                values[pick.settingId],
                current.snapshot.effective?.[pick.settingId],
            ));
            if (failed) throw new Error(t`${failed.title} did not return to its earlier value. Check it in Settings.`);
            undoState = null;
            undoBlockedReason = '';
            setStatus(current.settings.length === 1 ? t`Put 1 setting back.` : t`Put ${current.settings.length} settings back.`, 'saved');
            deps.onApplied?.();
            computeResults();
        } catch (error) {
            setStatus(error?.message || t`Miso could not put those settings back. Check them in Settings.`, 'error');
            computeResults();
        } finally {
            busy = false;
            render();
        }
    }

    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });

    const handleSettingsChanged = () => scheduleSettingsRefresh();
    const handleAppearanceControlChange = event => {
        const target = event.target;
        if (target instanceof HTMLInputElement && SHELL_APPEARANCE_CONTROL_IDS.has(target.id)) {
            scheduleSettingsRefresh();
        }
    };
    const handleGenderChanged = () => updatePortrait();
    settingsContent = document.getElementById('user-settings-block-content');
    settingsContent?.addEventListener('input', handleSettingsChanged);
    settingsContent?.addEventListener('change', handleSettingsChanged);
    settingsBlock = document.getElementById('user-settings-block');
    settingsBlock?.addEventListener('change', handleAppearanceControlChange);
    window.addEventListener('neconyan:simple-mode-changed', handleSettingsChanged);
    window.addEventListener('neconyan:assistant-gender-changed', handleGenderChanged);

    root.hidden = true;
    root.dataset.misoGuideReady = 'true';
    if (!root.id) root.id = GUIDE_ROOT_ID;

    return {
        open,
        close,
        refresh,
        reset,
        get answers() { return answers; },
        get isOpen() { return !root.hidden; },
        get isBusy() { return busy; },
        destroy() {
            if (settingsRefreshTimer) {
                clearTimeout(settingsRefreshTimer);
                settingsRefreshTimer = 0;
            }
            settingsContent?.removeEventListener('input', handleSettingsChanged);
            settingsContent?.removeEventListener('change', handleSettingsChanged);
            settingsBlock?.removeEventListener('change', handleAppearanceControlChange);
            window.removeEventListener('neconyan:simple-mode-changed', handleSettingsChanged);
            window.removeEventListener('neconyan:assistant-gender-changed', handleGenderChanged);
            root.replaceChildren();
            root.hidden = true;
            built = false;
        },
    };
}
