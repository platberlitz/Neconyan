import { t } from '../../i18n.js';
import { getAssistantIconSrc } from '../../neconyan-assistant-art.js';
import {
    TARO_GUIDE_ANSWERS_VERSION,
    TARO_GUIDE_MAX_NEW_PICKS,
    TARO_GUIDE_QUESTIONS,
    createDefaultTaroGuideAnswers,
    isTerminalTaroUndoError,
    mergePickSelection,
    normalizeTaroGuideAnswers,
    recommendAgents,
} from './agent-recommendations.js';

const GUIDE_ROOT_ID = 'ica--taroGuide';
const GUIDE_TRIGGER_ID = 'ica--askTaro';

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

function switchedOnMessage(count) {
    return count === 1 ? t`Switched on 1 agent.` : t`Switched on ${count} agents.`;
}

function costLabel(cost) {
    if (cost === 'manual') return t`Runs only when you press Run; no automatic request`;
    if (cost === 'before') return t`One extra request before the reply`;
    if (cost === 'after') return t`One extra request after the reply`;
    return t`Adds prompt text; no extra request`;
}

function readSavedAnswers(deps) {
    try {
        const raw = deps.loadAnswers?.();
        if (!raw) return null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const candidate = parsed.answers ?? parsed;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
        if (!['styles', 'fixes', 'extras', 'explicit', 'budget'].some(key => key in candidate)) return null;
        const answers = normalizeTaroGuideAnswers(candidate);
        return { answers, version: parsed.version ?? TARO_GUIDE_ANSWERS_VERSION };
    } catch {
        return null;
    }
}

function writeSavedAnswers(deps, answers) {
    try {
        const saved = deps.saveAnswers?.({ version: TARO_GUIDE_ANSWERS_VERSION, answers: normalizeTaroGuideAnswers(answers) });
        if (saved && typeof saved.catch === 'function') saved.catch(() => {});
    } catch {
        // Answers stay in memory when account storage is blocked.
    }
}

/**
 * Builds the inline guide inside the Agents page. The caller owns every agent
 * mutation; this module only collects answers and asks for the checked picks.
 */
export function createTaroGuide({ root, deps = {} }) {
    if (!(root instanceof HTMLElement)) throw new Error('The agent guide needs its page section.');

    let answers = createDefaultTaroGuideAnswers();
    let stepIndex = 0;
    let view = 'questions';
    let result = null;
    let selectedTemplateIds = new Set();
    let knownPickIds = new Set();
    let busy = false;
    let undoState = null;
    let lastFocus = null;
    let savedAnswersAvailable = false;
    let status = { text: '', tone: '' };
    let built = false;
    let primaryButton = null;

    const body = element('div', 'ica--taro-guide-body');
    const statusRegion = element('p', 'ica--taro-guide-status');
    statusRegion.setAttribute('role', 'status');
    statusRegion.setAttribute('aria-live', 'polite');

    const closeButton = button(t`Close`, 'menu_button ica--taro-guide-close');
    closeButton.setAttribute('aria-label', t`Close Taro's guide`);
    closeButton.addEventListener('click', () => close());

    function build() {
        if (built) return;
        built = true;
        const header = element('header', 'ica--taro-guide-header');
        const portrait = element('img', 'ica--taro-guide-portrait');
        portrait.src = getAssistantIconSrc('taro');
        portrait.alt = '';
        portrait.width = 56;
        portrait.height = 56;
        portrait.decoding = 'async';
        const copy = element('div', 'ica--taro-guide-copy');
        copy.append(
            element('p', 'ica--taro-guide-kicker', t`Taro asks, you decide`),
            element('h3', 'ica--taro-guide-title', t`Help me choose`),
        );
        const lead = element('p', 'ica--taro-guide-lead', t`Four short questions. Taro suggests agents from this library, and nothing is switched on until you press the button.`);
        header.append(portrait, copy, closeButton);
        root.append(header, lead, body, statusRegion);
        root.setAttribute('aria-labelledby', `${GUIDE_ROOT_ID}-title`);
        root.querySelector('h3')?.setAttribute('id', `${GUIDE_ROOT_ID}-title`);
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
            return error?.message || 'The agent library is not ready yet.';
        }
    }

    function pruneUndoState() {
        if (!undoState) return;
        const workspaceChanged = typeof deps.isWorkspaceCurrent === 'function'
            && !deps.isWorkspaceCurrent(undoState.identity);
        const scopeChanged = typeof deps.getScope === 'function' && deps.getScope() !== undoState.scope;
        if (workspaceChanged || scopeChanged) undoState = null;
    }

    function computeResults({ resetSelection = false } = {}) {
        const previousSelection = new Set(selectedTemplateIds);
        const previousKnown = new Set(knownPickIds);
        try {
            result = recommendAgents(answers, {
                agents: deps.getAgents?.() ?? [],
                templates: deps.getTemplates?.() ?? [],
                isEnabled: deps.isEnabled,
            });
        } catch (error) {
            result = null;
            setStatus(error?.message || t`Taro could not read your agents. Try again.`, 'error');
            return;
        }
        selectedTemplateIds = mergePickSelection({
            previousSelection,
            previousKnown,
            picks: result.picks,
            resetSelection,
        });
        knownPickIds = new Set(result.picks.map(pick => pick.templateId));
    }

    function setExpanded(expanded) {
        const trigger = document.getElementById(GUIDE_TRIGGER_ID);
        if (trigger instanceof HTMLElement) trigger.setAttribute('aria-expanded', String(Boolean(expanded)));
    }

    function focusFirstControl() {
        const target = body.querySelector('input:not([disabled]), button:not([disabled])')
            ?? root.querySelector('.ica--taro-guide-header h3');
        target?.focus?.({ preventScroll: true });
    }

    function open() {
        if (busy) return;
        build();
        lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const saved = readSavedAnswers(deps);
        setStatus();
        if (saved) {
            answers = saved.answers;
            savedAnswersAvailable = true;
            view = 'results';
            stepIndex = 0;
            pruneUndoState();
            computeResults({ resetSelection: true });
        } else {
            answers = createDefaultTaroGuideAnswers();
            savedAnswersAvailable = false;
            view = 'questions';
            stepIndex = 0;
            result = null;
            selectedTemplateIds = new Set();
            knownPickIds = new Set();
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
    }

    function reset() {
        if (busy) return;
        answers = createDefaultTaroGuideAnswers();
        stepIndex = 0;
        view = 'questions';
        result = null;
        selectedTemplateIds = new Set();
        knownPickIds = new Set();
        undoState = null;
        savedAnswersAvailable = false;
        setStatus();
        if (!root.hidden) render();
    }

    function refresh() {
        if (busy || root.hidden || view !== 'results') return;
        const activeElement = document.activeElement;
        const activeId = activeElement instanceof HTMLElement && body.contains(activeElement) ? activeElement.id : '';
        const skippedOpen = Boolean(body.querySelector('.ica--taro-guide-skipped')?.open);
        pruneUndoState();
        computeResults();
        render();
        if (skippedOpen) {
            const skipped = body.querySelector('.ica--taro-guide-skipped');
            if (skipped instanceof HTMLDetailsElement) skipped.open = true;
        }
        if (activeId) document.getElementById(activeId)?.focus?.({ preventScroll: true });
    }

    function changeStep(delta) {
        const next = stepIndex + delta;
        if (next < 0 || next >= TARO_GUIDE_QUESTIONS.length) return;
        stepIndex = next;
        render();
        focusFirstControl();
    }

    function showResults() {
        saveAnswers();
        setStatus();
        computeResults({ resetSelection: true });
        view = 'results';
        render();
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
    }

    function toggleAnswer(question, input) {
        if (question.type === 'radio') {
            answers = { ...answers, budget: input.value };
        } else if (question.id === 'style' && input.value === 'explicit') {
            answers = { ...answers, explicit: input.checked };
        } else {
            const key = question.id === 'style' ? 'styles' : question.id === 'fixes' ? 'fixes' : 'extras';
            const next = new Set(answers[key]);
            if (input.checked) next.add(input.value); else next.delete(input.value);
            answers = { ...answers, [key]: [...next] };
        }
        answers = normalizeTaroGuideAnswers(answers);
        setStatus();
    }

    function renderQuestions() {
        const question = TARO_GUIDE_QUESTIONS[stepIndex];
        primaryButton = null;
        const progress = element('p', 'ica--taro-guide-progress', t`Step ${stepIndex + 1} of ${TARO_GUIDE_QUESTIONS.length}`);
        const form = element('form', 'ica--taro-guide-form');
        form.noValidate = true;
        const fieldset = element('fieldset', 'ica--taro-guide-fieldset');
        const legend = element('legend', '', question.title);
        const help = element('p', 'ica--taro-guide-help', question.help);
        fieldset.append(legend, help);

        for (const option of question.options) {
            const label = element('label', 'ica--taro-guide-option');
            const input = element('input');
            input.type = question.type;
            input.name = `ica--taro-guide-${question.id}`;
            input.value = option.value;
            input.id = `ica--taro-guide-${question.id}-${option.value}`;
            const checked = question.type === 'radio'
                ? answers.budget === option.value
                : question.id === 'style' ? answers.styles.includes(option.value)
                    : question.id === 'fixes' ? answers.fixes.includes(option.value)
                        : answers.extras.includes(option.value);
            input.checked = checked;
            input.addEventListener('change', () => toggleAnswer(question, input));
            const text = element('span', 'ica--taro-guide-option-copy');
            text.append(element('strong', '', option.label), element('small', '', option.hint));
            label.append(input, text);
            fieldset.append(label);
        }

        if (question.explicitOption) {
            const label = element('label', 'ica--taro-guide-option ica--taro-guide-option--explicit');
            const input = element('input');
            input.type = 'checkbox';
            input.id = 'ica--taro-guide-explicit';
            input.value = 'explicit';
            input.checked = answers.explicit;
            input.addEventListener('change', () => toggleAnswer(question, input));
            const text = element('span', 'ica--taro-guide-option-copy');
            text.append(element('strong', '', question.explicitOption.label), element('small', '', question.explicitOption.hint));
            label.append(input, text);
            fieldset.append(label);
        }

        const actions = element('div', 'ica--taro-guide-actions');
        const back = button(t`Back`, 'menu_button');
        back.disabled = stepIndex === 0;
        back.addEventListener('click', () => changeStep(-1));
        const next = button(stepIndex === TARO_GUIDE_QUESTIONS.length - 1 ? t`Show my agents` : t`Next`, 'menu_button menu_button_primary');
        next.type = 'submit';
        actions.append(back, next);
        form.append(fieldset, actions);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (stepIndex === TARO_GUIDE_QUESTIONS.length - 1) showResults();
            else changeStep(1);
        });

        body.replaceChildren(progress, form);
    }

    function selectedPickCount() {
        if (!result) return 0;
        return result.picks.filter(pick => selectedTemplateIds.has(pick.templateId)).length;
    }

    function updatePrimaryButton() {
        if (!primaryButton) return;
        const count = selectedPickCount();
        primaryButton.textContent = count
            ? (count === 1 ? t`Switch on 1 agent` : t`Switch on ${count} agents`)
            : t`Choose at least one agent`;
        primaryButton.disabled = busy || Boolean(blockedReason()) || count === 0;
        primaryButton.setAttribute('aria-busy', String(busy));
    }

    function budgetLine() {
        if (!result) return '';
        const budget = result.budget;
        if (budget.mode === 'free') {
            if (budget.activeExtraCount === 1) return t`No extra requests: this pass adds none. 1 extra-request agent is already on.`;
            return budget.activeExtraCount
                ? t`No extra requests: this pass adds none. ${budget.activeExtraCount} extra-request agents are already on.`
                : t`No extra requests: picks either add prompt text or wait for a manual Run.`;
        }
        if (budget.mode === 'light') {
            const remaining = Math.max(0, budget.remainingExtraRequests);
            return remaining === 1
                ? t`${budget.label}: 1 of two extra-request slots is free for new picks. ${budget.activeExtraCount} already on.`
                : t`${budget.label}: ${remaining} of two extra-request slots are free for new picks. ${budget.activeExtraCount} already on.`;
        }
        return t`${budget.label}: every matching agent can be suggested, up to ${TARO_GUIDE_MAX_NEW_PICKS} new ones.`;
    }

    function makePickRow(pick, { alreadyOn = false } = {}) {
        const label = element('label', `ica--taro-guide-row${alreadyOn ? ' is-already-on' : ''}`);
        const input = element('input');
        input.type = 'checkbox';
        input.id = `ica--taro-guide-pick-${pick.templateId}`;
        input.value = pick.templateId;
        input.checked = alreadyOn || selectedTemplateIds.has(pick.templateId);
        if (alreadyOn) {
            input.disabled = true;
        } else {
            input.addEventListener('change', () => {
                if (input.checked) selectedTemplateIds.add(pick.templateId);
                else selectedTemplateIds.delete(pick.templateId);
                updatePrimaryButton();
            });
        }
        const copy = element('span', 'ica--taro-guide-row-copy');
        const title = element('span', 'ica--taro-guide-row-title');
        title.append(element('strong', '', pick.name));
        if (alreadyOn) title.append(element('span', 'ica--taro-guide-badge', t`Already on`));
        if (!alreadyOn && pick.needsCreate) title.append(element('span', 'ica--taro-guide-badge', t`Adds to library`));
        const cost = element('span', `ica--taro-guide-cost ica--taro-guide-cost--${pick.cost}`, costLabel(pick.cost));
        const reasons = element('span', 'ica--taro-guide-reasons', pick.reasons.join(' '));
        copy.append(title, cost, reasons);
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

        const heading = element('h4', 'ica--taro-guide-results-title', t`Your agents`);
        heading.tabIndex = -1;
        const scope = deps.isSeparateScopes?.()
            ? t`Switches apply to ${String(deps.getScopeLabel?.() ?? '').toLowerCase()}.`
            : t`Switches apply to all chats.`;
        const scopeLine = element('p', 'ica--taro-guide-scope', scope);
        const budget = element('p', 'ica--taro-guide-budget', budgetLine());
        const notes = element('ul', 'ica--taro-guide-notes');
        for (const note of result.notes) notes.append(element('li', '', note));

        const list = element('div', 'ica--taro-guide-rows');
        for (const pick of result.picks) list.append(makePickRow(pick));
        for (const pick of result.alreadyOn) list.append(makePickRow(pick, { alreadyOn: true }));
        if (!result.picks.length && !result.alreadyOn.length) {
            list.append(element('p', 'ica--taro-guide-empty', t`Nothing from the library matches those answers. Change a fix or add an extra, then look again.`));
        }

        const skipped = element('details', 'ica--taro-guide-skipped');
        const skippedSummary = element('summary', '', t`Not chosen (${result.skipped.length})`);
        skippedSummary.id = 'ica--taro-guide-skipped-summary';
        skipped.append(skippedSummary);
        if (result.skipped.length) {
            const skippedList = element('ul');
            for (const entry of result.skipped) {
                const item = element('li');
                item.append(element('strong', '', entry.name), element('span', '', entry.reason));
                skippedList.append(item);
            }
            skipped.append(skippedList);
        } else {
            skipped.append(element('p', '', t`Every recommended agent is in the list above.`));
        }

        const paused = deps.isGloballyPaused?.();
        const pausedLine = paused
            ? element('p', 'ica--taro-guide-paused', t`Agents are paused at the top of Manage agents. Your picks will be saved, but they will not run until you turn Agents On.`)
            : null;
        const blocked = blockedReason();
        const blockedLine = blocked
            ? element('p', 'ica--taro-guide-blocked', blocked)
            : null;

        const primary = button('', 'menu_button menu_button_primary ica--taro-guide-primary');
        primary.id = 'ica--taro-guide-primary';
        primaryButton = primary;
        updatePrimaryButton();
        primary.addEventListener('click', () => { void applyPicks(); });

        const actions = element('div', 'ica--taro-guide-actions');
        const change = button(t`Change answers`);
        change.id = 'ica--taro-guide-change';
        change.disabled = busy;
        change.addEventListener('click', changeAnswers);
        const lastAnswers = button(t`Use my last answers`);
        lastAnswers.id = 'ica--taro-guide-last-answers';
        lastAnswers.disabled = busy || !savedAnswersAvailable;
        lastAnswers.addEventListener('click', useLastAnswers);
        const closeButtonInline = button(t`Close`);
        closeButtonInline.id = 'ica--taro-guide-inline-close';
        closeButtonInline.disabled = busy;
        closeButtonInline.addEventListener('click', close);
        actions.append(primary, change, lastAnswers, closeButtonInline);

        const applied = undoState
            ? element('div', 'ica--taro-guide-applied')
            : null;
        if (applied) {
            applied.append(element('span', '', switchedOnMessage(undoState.count)));
            const undo = button(t`Undo`, 'menu_button');
            undo.id = 'ica--taro-guide-undo';
            undo.disabled = busy;
            undo.addEventListener('click', () => { void undoPicks(); });
            applied.append(undo);
        }

        body.replaceChildren();
        body.append(heading, scopeLine);
        if (pausedLine) body.append(pausedLine);
        if (budget.textContent) body.append(budget);
        if (result.notes.length) body.append(notes);
        if (blockedLine) body.append(blockedLine);
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

    async function applyPicks() {
        if (busy) return;
        const blocked = blockedReason();
        if (blocked) {
            setStatus(blocked, 'error');
            render();
            return;
        }
        saveAnswers();
        const requestedTemplateIds = new Set(selectedTemplateIds);
        computeResults();
        const selected = result?.picks.filter(pick => requestedTemplateIds.has(pick.templateId)) ?? [];
        if (!selected.length) {
            const missing = result?.skipped.some(entry => entry.reason.includes('not in the bundled library'));
            setStatus(
                missing
                    ? t`A recommended agent is no longer in the library. Reload the page and run the guide again.`
                    : t`Choose at least one agent first.`,
                missing ? 'error' : 'warn',
            );
            render();
            return;
        }
        if (!deps.switchOn) {
            setStatus(t`This page cannot switch agents on. Reload and try again.`, 'error');
            render();
            return;
        }

        const identity = deps.getWorkspaceIdentity?.();
        let scope = 'individual';
        try {
            scope = deps.getScope?.() ?? scope;
        } catch {
            // The default scope is used only when the page cannot report one.
        }
        busy = true;
        setStatus(selected.length === 1 ? t`Switching on 1 agent…` : t`Switching on ${selected.length} agents…`, 'working');
        render();
        try {
            const outcome = await deps.switchOn(selected.map(pick => pick.templateId), { scope, workspaceIdentity: identity });
            const ids = Array.isArray(outcome?.ids) ? outcome.ids : [];
            const stillCurrent = !deps.isWorkspaceCurrent || deps.isWorkspaceCurrent(identity);
            undoState = stillCurrent && ids.length && typeof outcome?.undo === 'function' ? {
                ids,
                undo: outcome.undo,
                count: ids.length,
                createdCount: Math.max(0, Number(outcome?.createdCount) || 0),
                identity,
                scope,
            } : null;
            let message = ids.length
                ? switchedOnMessage(ids.length)
                : t`Nothing needed switching on. The recommended agents were already on.`;
            if (ids.length && !stillCurrent) {
                message += ' ' + t`The chat changed while that saved, so check the chat you meant to set up.`;
            }
            setStatus(message, 'saved');
            deps.onApplied?.();
            computeResults();
            view = 'results';
        } catch (error) {
            setStatus(error?.message || t`The agents could not be switched on. Try again.`, 'error');
            computeResults();
        } finally {
            busy = false;
            render();
            body.querySelector('.ica--taro-guide-primary, .ica--taro-guide-applied button')?.focus?.({ preventScroll: true });
        }
    }

    async function undoPicks() {
        if (busy || !undoState) return;
        const current = undoState;
        busy = true;
        setStatus(current.count === 1 ? t`Switching off 1 agent…` : t`Switching off ${current.count} agents…`, 'working');
        render();
        try {
            if (typeof current.undo !== 'function') throw new Error(t`That change cannot be undone from here.`);
            await current.undo();
            undoState = null;
            const libraryNote = current.createdCount
                ? t`Any agents Taro added to the library stay there, switched off.`
                : '';
            const message = current.count === 1 ? t`Switched off 1 agent.` : t`Switched off ${current.count} agents.`;
            setStatus([message, libraryNote].filter(Boolean).join(' '), 'saved');
            deps.onApplied?.();
            computeResults();
        } catch (error) {
            const message = error?.message || t`The switches could not be undone. Check the agent list.`;
            if (isTerminalTaroUndoError(message)) undoState = null;
            setStatus(
                undoState
                    ? t`${message} Press Undo to try again.`
                    : message,
                'error',
            );
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

    root.hidden = true;
    root.dataset.taroGuideReady = 'true';
    if (!root.id) root.id = GUIDE_ROOT_ID;

    const handleAgentsChanged = () => refresh();
    document.addEventListener('neconyan:agents-changed', handleAgentsChanged);

    return {
        open,
        close,
        refresh,
        reset,
        get answers() { return answers; },
        get isOpen() { return !root.hidden; },
        get isBusy() { return busy; },
        destroy() {
            document.removeEventListener('neconyan:agents-changed', handleAgentsChanged);
            root.replaceChildren();
            root.hidden = true;
            built = false;
        },
    };
}
