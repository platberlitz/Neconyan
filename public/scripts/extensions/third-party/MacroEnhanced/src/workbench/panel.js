import { isEngineAvailable } from '../engine-gate.js';
import { getChatState } from '../chat-state.js';
import { button, copyToClipboard, el, flashButtonText, helpButton } from '../dom.js';
import { createSandbox, findUnshadowedVariableMacros } from './sandbox.js';
import { renderInspector } from './inspector.js';
import { extractMacroInfos, runTrace } from './trace.js';
import { isImportFixesActive } from '../import-fixes.js';
import { rewriteMacros } from '../import-fixes-impl.js';
import { renderAuditorTab } from '../auditor/auditor-ui.js';
import { renderReferenceTab } from '../help/reference-ui.js';

const EVAL_DEBOUNCE_MS = 300;
const ENGINE_OFF_NOTICE = 'The Macro Workbench needs the Experimental Macro Engine. Turn it on under User Settings → Experimental Macro Engine.';

let openPopup = null;

function evaluateSandboxed(ctx, sandbox, input) {
    return sandbox.run((text, dynamicMacros) => {
        const env = ctx.macros.envBuilder.buildFromRawEnv({
            content: text,
            replaceCharacterCard: true,
            dynamicMacros,
            postProcessFn: (x) => x,
        });
        // Layer C: stateful macros ({{freeze}} etc.) write to the sandbox overlay.
        env.extra = { ...(env.extra ?? {}), meSandboxState: sandbox.chatState };
        return ctx.macros.engine.evaluate(text, env);
    }, input);
}

export function isWorkbenchOpen() {
    return !!openPopup;
}

export function closeWorkbench() {
    if (openPopup) {
        const popup = openPopup;
        openPopup = null;
        popup.completeCancelled?.();
    }
}

/**
 * Opens the Workbench popup. Evaluation is sandboxed: variable macros write to a
 * throwaway copy, and shorthand writes are reverted after each evaluation.
 *
 * @param {object} [options]
 * @param {string} [options.initialText] - Pre-filled playground text.
 * @param {string} [options.tab] - Tab to open on ('Playground' by default).
 * @param {string} [options.topic] - Guide to reveal in the Reference tab.
 * @param {string} [options.macro] - Macro to reveal in the Reference tab.
 */
export async function openWorkbench({ initialText = '', tab = 'Playground', topic = '', macro = '' } = {}) {
    const ctx = SillyTavern.getContext();
    if (openPopup) {
        return;
    }
    if (!isEngineAvailable()) {
        await ctx.Popup?.show?.text?.('Macro Workbench', ENGINE_OFF_NOTICE);
        return;
    }

    const sandbox = createSandbox({
        getLocalStore: () => {
            const meta = SillyTavern.getContext().chatMetadata;
            if (meta && !meta.variables) {
                meta.variables = {};
            }
            return meta?.variables ?? {};
        },
        getGlobalStore: () => {
            const settings = SillyTavern.getContext().extensionSettings;
            if (settings && !settings.variables) {
                settings.variables = { global: {} };
            }
            if (settings?.variables && !settings.variables.global) {
                settings.variables.global = {};
            }
            return settings?.variables?.global ?? {};
        },
        getChatState: () => getChatState(),
    });
    const unshadowed = findUnshadowedVariableMacros(ctx.macros?.registry);

    const root = el('div', 'me-workbench');
    root.appendChild(el('h3', 'me-workbench-heading', 'Macro Workbench'));

    // Tab strip: Playground | Cache Audit (Phase 6 adds Trace).
    const tabs = el('div', 'me-workbench-tabs');
    root.appendChild(tabs);
    const views = new Map();
    const activateTab = (name) => {
        const target = views.get(name) ?? views.get('Playground');
        for (const [, { tab: otherTab, view: otherView }] of views) {
            otherTab.classList.remove('me-workbench-tab-active');
            otherView.style.display = 'none';
        }
        target.tab.classList.add('me-workbench-tab-active');
        target.view.style.display = '';
    };
    const addTab = (name) => {
        const view = el('div', 'me-workbench-view');
        const tab = button('menu_button me-workbench-tab', name, () => activateTab(name));
        tabs.appendChild(tab);
        root.appendChild(view);
        views.set(name, { tab, view });
        return view;
    };
    const playgroundView = addTab('Playground');
    const referenceView = addTab('Reference');
    const auditView = addTab('Cache Audit');
    const traceView = addTab('Trace');

    renderAuditorTab(auditView, {
        makeSandboxEvaluate: () => {
            const liveCtx = SillyTavern.getContext();
            const auditSandbox = createSandbox({
                getLocalStore: () => SillyTavern.getContext().chatMetadata?.variables ?? {},
                getGlobalStore: () => SillyTavern.getContext().extensionSettings?.variables?.global ?? {},
                getChatState: () => getChatState(),
            });
            return (text) => evaluateSandboxed(liveCtx, auditSandbox, text);
        },
        onHelp: () => openGuide('prompt-caching'),
    });

    const columns = el('div', 'me-workbench-columns');
    const left = el('div', 'me-workbench-left');
    const right = el('div', 'me-workbench-right');
    columns.appendChild(left);
    columns.appendChild(right);
    playgroundView.appendChild(columns);

    const input = document.createElement('textarea');
    input.className = 'text_pole me-workbench-input';
    input.rows = 8;
    input.placeholder = 'Type text with macros, e.g. {{upper::{{char}}}} rolled {{roll::d20}}';
    input.value = initialText;
    left.appendChild(input);

    const outputLabel = el('div', 'me-workbench-label', 'Result');
    const evalMeta = el('span', 'me-workbench-meta', '');
    outputLabel.appendChild(evalMeta);
    left.appendChild(outputLabel);

    const output = el('pre', 'me-workbench-output', '');
    left.appendChild(output);

    const buttonRow = el('div', 'me-workbench-buttons');
    const copyButton = button('menu_button', 'Copy result', async () => {
        const ok = await copyToClipboard(output.textContent ?? '');
        flashButtonText(copyButton, ok ? 'Copied ✓' : 'Copy failed');
    });
    const resetButton = button('menu_button', 'Reset sandbox', () => {
        sandbox.reset();
        evaluateNow();
    });
    buttonRow.appendChild(copyButton);
    buttonRow.appendChild(resetButton);
    left.appendChild(buttonRow);

    const inspectorContainer = el('div', 'me-workbench-inspector');
    right.appendChild(inspectorContainer);

    playgroundView.appendChild(el('div', 'me-workbench-footnote',
        'Sandboxed. nothing is saved. Variable macros and frozen values ({{freeze}}, {{sticky}}, …) write to a throwaway copy; {{.var}} shorthand changes are reverted after each preview. Ctrl+Enter evaluates immediately.'));

    // ---- Trace tab: per-span timing of the Playground text ----
    const traceIntro = el('div', 'me-audit-intro',
        'Evaluates the Playground text one macro span at a time (sandboxed, sharing the Playground\'s variable state) and shows what each span produced and how long it took. Macros nested inside a span are not timed individually.');
    traceIntro.appendChild(helpButton('What the Workbench does and does not save', () => openGuide('sandbox')));
    traceView.appendChild(traceIntro);
    const traceResults = el('div', 'me-trace-results');
    traceView.appendChild(button('menu_button', 'Trace Playground text', () => {
        traceResults.innerHTML = '';
        // Spans come from the parser, which sees the text as it is. The engine
        // sees it after the pre-processors, so trace what the engine gets or the
        // syntax this repairs enumerates no spans at all.
        const text = isImportFixesActive() ? rewriteMacros(input.value) : input.value;
        if (text !== input.value) {
            traceResults.appendChild(el('div', 'me-drawer-hint',
                'Tracing the repaired text, which is what the engine evaluates.'));
        }
        if (!text.trim()) {
            traceResults.appendChild(el('div', 'me-inspector-empty', 'Type something in the Playground tab first.'));
            return;
        }
        const liveCtx = SillyTavern.getContext();
        try {
            const rows = runTrace(text, {
                extract: (slice) => extractMacroInfos(slice, { parser: liveCtx.macros.parser, cstWalker: liveCtx.macros.cstWalker }),
                evaluate: (slice) => evaluateSandboxed(liveCtx, sandbox, slice),
            });
            if (!rows.length) {
                traceResults.appendChild(el('div', 'me-inspector-empty', 'No macros found in the Playground text.'));
                refreshInspector();
                return;
            }
            const table = el('table', 'me-inspector-table');
            for (const row of rows) {
                const tr = el('tr');
                tr.appendChild(el('td', 'me-inspector-name', row.text.length > 60 ? `${row.text.slice(0, 59)}…` : row.text));
                tr.appendChild(el('td', 'me-inspector-value', row.error ? `Error: ${row.error}` : (row.output.length > 80 ? `${row.output.slice(0, 79)}…` : row.output)));
                tr.appendChild(el('td', 'me-trace-ms', `${row.ms.toFixed(1)} ms`));
                table.appendChild(tr);
            }
            traceResults.appendChild(table);
        } catch (error) {
            traceResults.appendChild(el('div', 'me-inspector-warning', `Trace failed: ${error?.message ?? error}`));
        }
        refreshInspector();
    }));
    traceView.appendChild(traceResults);

    // ---- Reference tab: the documentation, next door to the Playground ----
    const reference = renderReferenceTab(referenceView, {
        onInsert: (example) => {
            input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n${example}` : example;
            activateTab('Playground');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            evaluateNow();
        },
    });

    const openGuide = (id) => {
        activateTab('Reference');
        reference.focusTopic(id);
    };

    activateTab(tab);
    if (topic) {
        reference.focusTopic(topic);
    } else if (macro) {
        reference.focusMacro(macro);
    }

    const refreshInspector = () => {
        const liveCtx = SillyTavern.getContext();
        renderInspector(inspectorContainer, {
            localVars: liveCtx.chatMetadata?.variables ?? {},
            globalVars: liveCtx.extensionSettings?.variables?.global ?? {},
            pending: sandbox.pendingChanges(),
            unshadowed,
        });
    };

    const evaluateNow = () => {
        const text = input.value;
        if (!text) {
            output.textContent = '';
            evalMeta.textContent = '';
            refreshInspector();
            return;
        }
        const liveCtx = SillyTavern.getContext();
        const started = performance.now();
        try {
            output.textContent = evaluateSandboxed(liveCtx, sandbox, text);
            evalMeta.textContent = ` ${(performance.now() - started).toFixed(1)} ms`;
        } catch (error) {
            output.textContent = `Evaluation failed: ${error?.message ?? error}`;
            evalMeta.textContent = '';
        }
        refreshInspector();
    };

    let debounceTimer = null;
    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(evaluateNow, EVAL_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            clearTimeout(debounceTimer);
            evaluateNow();
        }
    });

    refreshInspector();
    if (initialText) {
        evaluateNow();
    }

    const popup = new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Close',
    });
    openPopup = popup;
    input.focus();

    try {
        await popup.show();
    } finally {
        clearTimeout(debounceTimer);
        openPopup = null;
    }
}
