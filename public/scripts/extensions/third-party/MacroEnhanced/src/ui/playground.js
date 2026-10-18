/**
 * The Playground: sandboxed macro evaluation in the page itself. These are the
 * old Workbench's Playground, Trace and pending-change ledger, with the sandbox
 * opening no live state and the read-only host guard around every evaluation.
 */
import { announce as defaultAnnounce, button, copyToClipboard, el, flashButtonText } from '../dom.js';
import { peekChatState } from '../chat-state.js';
import { applySandboxEnvironment, createSandbox, findUnshadowedVariableMacros } from '../workbench/sandbox.js';
import { extractMacroInfos, runTrace } from '../workbench/trace.js';
import { isImportFixesActive } from '../import-fixes.js';
import { rewriteMacros } from '../import-fixes-impl.js';
import { withReadOnlyVariables } from '../../../../../variable-read-only.js';
import { renderMacroText } from './macro-text.js';
import { uiState } from './ui-state.js';

const EVAL_DEBOUNCE_MS = 300;
const PLACEHOLDER = 'Type text with macros, for example {{upper::{{char}}}} rolled {{roll::d20}}';

function changeText(before, after) {
    if (after === undefined) {
        return `${before ?? ''} → (removed)`;
    }
    if (before === undefined) {
        return `(new) → ${after}`;
    }
    return `${before} → ${after}`;
}

function ledgerRows(pending) {
    const rows = [];
    const add = (scope, name, change) => {
        rows.push({ scope, name, before: change.before, after: change.after });
    };
    for (const [name, change] of pending.local ?? new Map()) {
        add('chat', name, change);
    }
    for (const [name, change] of pending.global ?? new Map()) {
        add('global', name, change);
    }
    for (const [rawName, change] of pending.chat ?? new Map()) {
        const separator = rawName.indexOf(':');
        const kind = separator > 0 ? rawName.slice(0, separator) : 'state';
        const scope = kind === 'chatvar' ? 'chat variable' : kind === 'counter' ? 'counter' : kind === 'pronoun' ? 'pronoun' : 'state';
        add(scope, rawName, change);
    }
    return rows;
}

function displayValue(value) {
    return value === undefined ? '' : String(value);
}

/**
 * @param {object} [options]
 * @param {string} [options.initialText]
 * @param {(text: string) => void} [options.announce]
 * @param {() => void} [options.openReference]
 * @param {typeof uiState} [options.state]
 */
export function createPlaygroundPanel({ initialText = '', announce = defaultAnnounce, openReference, state = uiState } = {}) {
    if (initialText) {
        state.playgroundText = initialText;
    }

    const element = el('div', 'me-pg');
    const grid = el('div', 'me-pg-grid');
    const left = el('div', 'me-pg-main');
    const right = el('div', 'me-pg-side');
    grid.append(left, right);
    element.appendChild(grid);

    const editorCard = el('div', 'me-editor-card');
    const label = el('label', 'me-field-label', 'Macro text');
    label.htmlFor = 'me-pg-input';
    const input = document.createElement('textarea');
    input.id = 'me-pg-input';
    input.className = 'text_pole me-pg-input';
    input.rows = 6;
    input.placeholder = PLACEHOLDER;
    input.spellcheck = false;
    input.value = state.playgroundText;
    editorCard.append(label, input);
    left.appendChild(editorCard);

    const resultHead = el('div', 'me-result-head');
    resultHead.appendChild(el('span', 'me-field-label', 'Result'));
    const evalMeta = el('span', 'me-result-meta', '');
    resultHead.appendChild(evalMeta);
    resultHead.appendChild(el('span', 'me-pill me-pill-quiet', 'Sandboxed'));
    left.appendChild(resultHead);

    const output = el('pre', 'me-result-output', '');
    output.setAttribute('aria-live', 'off');
    left.appendChild(output);

    const actions = el('div', 'me-actions');
    const copyButton = button('menu_button', 'Copy result', async () => {
        const ok = await copyToClipboard(output.textContent ?? '');
        flashButtonText(copyButton, ok ? 'Copied' : 'Copy failed');
    });
    const resetButton = button('menu_button', 'Start fresh', () => {
        sandbox.reset();
        evaluateNow();
        announce('Playground started fresh. Nothing was saved.');
    });
    const traceButton = button('menu_button', 'Time each macro', () => runTiming());
    actions.append(copyButton, resetButton, traceButton);
    left.appendChild(actions);

    const traceResults = el('div', 'me-trace-results');
    left.appendChild(traceResults);

    const ledger = el('section', 'me-section me-ledger');
    ledger.setAttribute('aria-labelledby', 'me-ledger-title');
    const ledgerTitle = el('h3', 'me-section-title', 'Would change (not saved)');
    ledgerTitle.id = 'me-ledger-title';
    const ledgerSummary = el('p', 'me-section-note', 'Nothing would change.');
    const ledgerRowsHost = el('div', 'me-ledger-rows');
    ledger.append(ledgerTitle, ledgerSummary, ledgerRowsHost);
    right.appendChild(ledger);

    const variables = el('div', 'me-variables');
    right.appendChild(variables);

    const warningHost = el('div', 'me-pg-warning');
    right.appendChild(warningHost);

    const methodNote = el('p', 'me-footnote',
        'Sandboxed. Nothing here is saved. Registry variable macros and shorthand syntax share the same throwaway stores; stored values use a separate sandbox copy. Ctrl+Enter evaluates immediately.');
    element.appendChild(methodNote);

    function currentContext() {
        return SillyTavern.getContext();
    }

    function createPanelSandbox() {
        return createSandbox({
            getLocalStore: () => currentContext().chatMetadata?.variables ?? {},
            getGlobalStore: () => currentContext().extensionSettings?.variables?.global ?? {},
            getChatState: () => peekChatState(),
        });
    }

    let sandbox = createPanelSandbox();

    function evaluateSandboxed(text) {
        const ctx = currentContext();
        return sandbox.run((source, dynamicMacros) => {
            const env = ctx.macros.envBuilder.buildFromRawEnv({
                content: source,
                replaceCharacterCard: true,
                dynamicMacros,
                postProcessFn: x => x,
            });
            applySandboxEnvironment(env, sandbox);
            return ctx.macros.engine.evaluate(source, env);
        }, text);
    }

    function guardedEvaluate(text) {
        return withReadOnlyVariables(() => evaluateSandboxed(text));
    }

    function renderLedger() {
        const rows = ledgerRows(sandbox.pendingChanges());
        ledgerRowsHost.replaceChildren();
        if (!rows.length) {
            ledgerSummary.textContent = 'Nothing would change.';
            return;
        }
        ledgerSummary.textContent = rows.length === 1
            ? 'Would change 1 value. Nothing is saved.'
            : `Would change ${rows.length} values. Nothing is saved.`;
        for (const row of rows) {
            const item = el('div', 'me-ledger-row');
            item.appendChild(el('span', 'me-ledger-scope', row.scope));
            const name = el('code', 'me-ledger-name');
            name.appendChild(renderMacroText(row.name, { tag: 'span', className: 'me-mt me-mt-plain' }));
            item.appendChild(name);
            item.appendChild(el('span', 'me-ledger-change', changeText(row.before === undefined ? undefined : displayValue(row.before), row.after === undefined ? undefined : displayValue(row.after))));
            ledgerRowsHost.appendChild(item);
        }
    }

    function renderValueList(title, values) {
        const details = el('details', 'me-disclosure');
        const names = Object.keys(values ?? {}).sort();
        details.appendChild(el('summary', 'me-disclosure-summary', `${title} (${names.length})`));
        if (!names.length) {
            details.appendChild(el('p', 'me-section-note', 'None yet.'));
            return details;
        }
        const list = el('dl', 'me-value-list');
        for (const name of names) {
            list.appendChild(el('dt', 'me-value-name', name));
            list.appendChild(el('dd', 'me-value-text', String(values[name])));
        }
        details.appendChild(list);
        return details;
    }

    function renderVariables() {
        const ctx = currentContext();
        variables.replaceChildren();
        variables.appendChild(renderValueList('Variables in this chat', ctx.chatMetadata?.variables ?? {}));
        variables.appendChild(renderValueList('Global variables', ctx.extensionSettings?.variables?.global ?? {}));

        warningHost.replaceChildren();
        const unshadowed = findUnshadowedVariableMacros(ctx.macros?.registry);
        if (unshadowed.length) {
            warningHost.appendChild(el('div', 'me-warning',
                `Not sandboxed: ${unshadowed.map(name => `{{${name}}}`).join(', ')}. A preview could change the real value.`));
        }
    }

    function evaluateNow() {
        const text = input.value;
        state.playgroundText = text;
        if (!text.trim()) {
            output.textContent = '';
            evalMeta.textContent = '';
            renderLedger();
            return;
        }
        const started = performance.now();
        try {
            output.textContent = guardedEvaluate(text);
            evalMeta.textContent = `${(performance.now() - started).toFixed(1)} ms`;
        } catch (error) {
            output.textContent = `Evaluation failed: ${error?.message ?? error}`;
            evalMeta.textContent = '';
        }
        renderLedger();
    }

    function runTiming() {
        traceResults.replaceChildren();
        const ctx = currentContext();
        const text = isImportFixesActive() ? rewriteMacros(input.value) : input.value;
        if (!text.trim()) {
            traceResults.appendChild(el('p', 'me-section-note', 'Type something in the Playground first.'));
            return;
        }
        if (text !== input.value) {
            traceResults.appendChild(el('p', 'me-section-note', 'Tracing the repaired text, which is what the engine evaluates.'));
        }
        try {
            const rows = runTrace(text, {
                extract: slice => extractMacroInfos(slice, { parser: ctx.macros.parser, cstWalker: ctx.macros.cstWalker }),
                evaluate: slice => guardedEvaluate(slice),
            });
            if (!rows.length) {
                traceResults.appendChild(el('p', 'me-section-note', 'No macros found in the Playground text.'));
                renderLedger();
                return;
            }
            for (const row of rows) {
                const card = el('article', 'me-trace-row');
                const head = el('div', 'me-trace-head');
                head.appendChild(renderMacroText(row.text, { tag: 'code', className: 'me-mt me-trace-code' }));
                head.appendChild(el('span', 'me-trace-ms', `${row.ms.toFixed(1)} ms`));
                card.appendChild(head);
                card.appendChild(el('pre', row.error ? 'me-trace-error' : 'me-trace-output', row.error ? `Error: ${row.error}` : row.output));
                traceResults.appendChild(card);
            }
        } catch (error) {
            traceResults.appendChild(el('div', 'me-warning', `Timing failed: ${error?.message ?? error}`));
        }
        renderLedger();
    }

    let debounceTimer = null;
    input.addEventListener('input', () => {
        state.playgroundText = input.value;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(evaluateNow, EVAL_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            // The host binds Ctrl+Enter on document to Send/Regenerate. This
            // preview must win while the caret is in the Playground.
            event.preventDefault();
            event.stopPropagation();
            clearTimeout(debounceTimer);
            evaluateNow();
        }
    });

    if (openReference) {
        copyButton.title = 'Copies the result text';
    }

    renderLedger();
    renderVariables();
    if (state.playgroundText) {
        evaluateNow();
    }

    return {
        element,
        focusTextarea() {
            input.focus({ preventScroll: false });
            input.setSelectionRange(input.value.length, input.value.length);
        },
        setText(text) {
            state.playgroundText = String(text ?? '');
            input.value = state.playgroundText;
            clearTimeout(debounceTimer);
            evaluateNow();
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        },
        getText() {
            return input.value;
        },
        refresh(kind) {
            if (kind === 'values' || kind === 'chat' || kind === 'all') {
                renderLedger();
                renderVariables();
            }
        },
        handleChatChanged() {
            clearTimeout(debounceTimer);
            sandbox = createPanelSandbox();
            traceResults.replaceChildren();
            output.textContent = '';
            evalMeta.textContent = '';
            renderLedger();
            renderVariables();
            if (input.value.trim()) {
                evaluateNow();
            }
            announce('Chat changed, so the Playground started fresh.');
        },
        resetSandbox() {
            sandbox.reset();
            traceResults.replaceChildren();
            evaluateNow();
        },
        destroy() {
            clearTimeout(debounceTimer);
        },
    };
}
