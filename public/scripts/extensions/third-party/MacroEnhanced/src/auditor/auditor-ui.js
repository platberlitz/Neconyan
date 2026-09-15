/**
 * The Cache Audit tab inside the Workbench popup.
 */
import { button, el, helpButton } from '../dom.js';
import { getSettings, saveSettings } from '../settings.js';
import { isVolatileClass, runAudit } from './audit.js';

const VERDICT_TEXT = {
    costly: 'costs money every generation',
    harmless: 'harmless (below the breakpoints)',
    'no-caching': 'would cost money if caching were on',
    baked: 'baked into your message',
    friendly: 'cache-friendly by design',
};

function describeConfig(config) {
    if (config.source === 'server') {
        const depth = config.cachingAtDepth === null ? 'off' : String(config.cachingAtDepth);
        const modified = config.lastModifiedMs ? ` (config.yaml changed ${new Date(config.lastModifiedMs).toLocaleString()}; the server uses it after a restart)` : '';
        return `Server settings: caching depth ${depth}, system-prompt cache ${config.enableSystemPromptCache ? 'on' : 'off'}, TTL ${config.extendedTTL ? '1 hour' : '5 minutes'}${modified}.`;
    }
    if (config.source === 'manual') {
        return `Using your manual caching depth: ${config.cachingAtDepth}.`;
    }
    return 'Caching settings unknown (the server config is admin-only). set a manual depth below for precise verdicts.';
}

/**
 * Renders the Cache Audit tab.
 *
 * @param {HTMLElement} container
 * @param {object} hooks
 * @param {() => (text: string) => string} [hooks.makeSandboxEvaluate] - Returns a fresh
 *        sandboxed evaluator per audit run (both passes share one sandbox session).
 * @param {() => void} [hooks.onHelp] - Opens the prompt-caching guide.
 */
export function renderAuditorTab(container, { makeSandboxEvaluate, onHelp } = {}) {
    container.innerHTML = '';

    const intro = el('div', 'me-audit-intro',
        'Finds macros that change between generations and silently break the prompt-caching discount. '
        + 'Presets, character card, persona and lorebook sit above the cache breakpoints. anything volatile there costs money on every generation.');
    if (onHelp) {
        intro.appendChild(helpButton('Why prompt caching matters', onHelp));
    }
    container.appendChild(intro);

    const depthRow = el('label', 'me-audit-depth-row');
    depthRow.appendChild(el('span', undefined, 'Manual caching depth (used when the server config is not readable): '));
    const depthInput = document.createElement('input');
    depthInput.type = 'number';
    depthInput.min = '0';
    depthInput.className = 'text_pole me-audit-depth';
    const savedDepth = getSettings().auditor?.manualCachingAtDepth;
    depthInput.value = Number.isInteger(savedDepth) ? String(savedDepth) : '';
    depthInput.placeholder = 'e.g. 2';
    depthInput.addEventListener('change', () => {
        const parsed = Number.parseInt(depthInput.value, 10);
        getSettings().auditor.manualCachingAtDepth = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
        saveSettings();
    });
    depthRow.appendChild(depthInput);
    container.appendChild(depthRow);

    const results = el('div', 'me-audit-results');

    const runButton = button('menu_button', 'Run audit', async () => {
        runButton.classList.add('disabled');
        results.innerHTML = '';
        results.appendChild(el('div', 'me-audit-running', 'Auditing…'));
        try {
            const report = await runAudit({ sandboxEvaluate: makeSandboxEvaluate?.() });
            renderResults(results, report);
        } catch (error) {
            results.innerHTML = '';
            results.appendChild(el('div', 'me-inspector-warning', `Audit failed: ${error?.message ?? error}`));
        } finally {
            runButton.classList.remove('disabled');
        }
    });
    container.appendChild(runButton);
    container.appendChild(results);
}

function renderResults(container, report) {
    container.innerHTML = '';
    container.appendChild(el('div', 'me-audit-config', describeConfig(report.config)));

    const problems = report.findings.filter(finding => isVolatileClass(finding.cls));
    const friendly = report.findings.filter(finding => !isVolatileClass(finding.cls));

    if (!problems.length) {
        container.appendChild(el('div', 'me-audit-clean', 'No cache-breaking macros found. Nice and byte-stable.'));
    } else {
        container.appendChild(el('div', 'me-inspector-title', `${problems.length} cache-breaking finding(s)`));
        const table = el('table', 'me-inspector-table');
        for (const finding of problems) {
            const row = el('tr');
            row.appendChild(el('td', 'me-inspector-scope', finding.sourceKind));
            row.appendChild(el('td', 'me-inspector-name', `{{${finding.name}}}${finding.count > 1 ? ` ×${finding.count}` : ''}`));
            const detail = el('td', 'me-inspector-value');
            detail.appendChild(el('div', undefined, finding.sourceLabel));
            detail.appendChild(el('div', 'me-audit-why', `${finding.cls}. ${VERDICT_TEXT[finding.verdict] ?? finding.verdict}. ${finding.why}`));
            row.appendChild(detail);
            table.appendChild(row);
        }
        container.appendChild(table);
        container.appendChild(el('div', 'me-drawer-hint',
            'Fixes: wrap one-time flavor in {{freeze}}, use {{sticky}}/{{daily}} for slow refreshes, {{timeofday}}/{{season}} instead of {{time}}/{{date}}, and {{listpick}}/{{rollonce}}/{{pick}} instead of {{random}}/{{roll}}.'));
    }

    if (friendly.length) {
        const names = [...new Set(friendly.map(finding => `{{${finding.name}}}`))].join(', ');
        container.appendChild(el('div', 'me-audit-friendly', `Cache-friendly by design: ${names}`));
    }
    for (const note of report.notes) {
        container.appendChild(el('div', 'me-drawer-hint', `Note: ${note}`));
    }
    container.appendChild(el('div', 'me-drawer-hint',
        'Depth verdicts are estimates. prompt injections and summaries can shift message depth slightly. Same report as text: /me-audit.'));
}
