/**
 * The Cache Audit card on This chat. It scans what prompt assembly re-evaluates
 * every generation and lists the macros that break the caching discount.
 */
import { button, el, helpButton } from '../dom.js';
import { getSettings, saveSettings } from '../settings.js';
import { isVolatileClass, runAudit } from './audit.js';
import { renderMacroText } from '../ui/macro-text.js';

const VERDICT_TEXT = {
    costly: 'Costs money every generation because it sits inside the cached prefix.',
    harmless: 'Below the cache breakpoints, so it is harmless.',
    'no-caching': 'Caching looks off or unknown. It would cost money if caching were on.',
    baked: 'Already baked into one of your messages.',
    friendly: 'Cache-friendly by design.',
};

function describeConfig(config) {
    if (config.source === 'server') {
        const depth = config.cachingAtDepth === null ? 'off' : String(config.cachingAtDepth);
        const modified = config.lastModifiedMs
            ? ` The config.yaml changed ${new Date(config.lastModifiedMs).toLocaleString()}; the server uses it after a restart.`
            : '';
        return `Server settings: caching depth ${depth}, system-prompt cache ${config.enableSystemPromptCache ? 'on' : 'off'}, TTL ${config.extendedTTL ? '1 hour' : '5 minutes'}.${modified}`;
    }
    if (config.source === 'manual') {
        return `Using your manual caching depth: ${config.cachingAtDepth}.`;
    }
    return 'Caching settings unknown (the server config is admin-only). Set a manual depth for precise verdicts.';
}

function fixFor(finding) {
    const name = String(finding.name ?? '').toLowerCase();
    if (name === 'time') {
        return 'Use {{timeofday}} for a coarse time that changes a few times a day.';
    }
    if (name === 'date') {
        return 'Use {{season}} or {{daily}} when a date only needs to change once a day.';
    }
    if (name === 'random') {
        return 'Use {{listpick}} or {{rollonce}} so the pick stays stable.';
    }
    if (name === 'roll') {
        return 'Use {{rollonce}} so the roll is saved once per chat.';
    }
    return 'Wrap the changing part in {{freeze}}, {{sticky}} or {{daily}}, or move it below the cache breakpoint.';
}

function renderFindingCard(finding) {
    const card = el('article', 'me-audit-card');
    const head = el('div', 'me-audit-card-head');
    head.appendChild(el('span', 'me-pill me-pill-quiet', finding.sourceKind));
    head.appendChild(renderMacroText(`{{${finding.name}}}${finding.count > 1 ? ` ×${finding.count}` : ''}`, { tag: 'code', className: 'me-mt me-audit-macro' }));
    card.appendChild(head);
    card.appendChild(el('p', 'me-audit-source', finding.sourceLabel));
    card.appendChild(el('p', 'me-audit-verdict', VERDICT_TEXT[finding.verdict] ?? finding.verdict));
    if (finding.why) {
        card.appendChild(el('p', 'me-audit-why', finding.why));
    }
    if (finding.verdict !== 'harmless' && finding.verdict !== 'friendly') {
        card.appendChild(el('p', 'me-audit-fix', `Fix: ${fixFor(finding)}`));
    }
    return card;
}

function renderResults(container, report) {
    container.replaceChildren();
    container.appendChild(el('p', 'me-audit-config', describeConfig(report.config)));

    const problems = report.findings.filter(finding => isVolatileClass(finding.cls));
    const friendly = report.findings.filter(finding => !isVolatileClass(finding.cls));

    if (!problems.length) {
        container.appendChild(el('p', 'me-audit-clean', 'No cache-breaking macros found. Nice and byte-stable.'));
    } else {
        container.appendChild(el('h4', 'me-audit-result-title', problems.length === 1
            ? '1 cache-breaking finding'
            : `${problems.length} cache-breaking findings`));
        for (const finding of problems) {
            container.appendChild(renderFindingCard(finding));
        }
    }

    if (friendly.length) {
        const names = [...new Set(friendly.map(finding => `{{${finding.name}}}`))].join(', ');
        container.appendChild(el('p', 'me-section-note', `Cache-friendly by design: ${names}`));
    }
    for (const note of report.notes) {
        container.appendChild(el('p', 'me-section-note', `Note: ${note}`));
    }
    container.appendChild(el('p', 'me-footnote',
        'Depth verdicts are estimates; prompt injections and summaries can shift message depth slightly. The same report is available as text with /me-audit.'));
}

/**
 * @param {HTMLElement} container
 * @param {object} hooks
 * @param {() => (text: string) => string} [hooks.makeSandboxEvaluate]
 * @param {() => void} [hooks.onHelp]
 */
export function renderAuditorTab(container, { makeSandboxEvaluate, onHelp } = {}) {
    container.replaceChildren();

    const depthLabel = el('label', 'me-field me-audit-depth-label');
    depthLabel.appendChild(el('span', 'me-field-label', 'Manual caching depth'));
    const depthInput = document.createElement('input');
    depthInput.type = 'number';
    depthInput.min = '0';
    depthInput.className = 'text_pole me-audit-depth';
    depthInput.placeholder = 'for example 2';
    const savedDepth = getSettings().auditor?.manualCachingAtDepth;
    depthInput.value = Number.isInteger(savedDepth) ? String(savedDepth) : '';
    depthInput.setAttribute('aria-label', 'Manual caching depth');
    depthInput.addEventListener('change', () => {
        const parsed = Number.parseInt(depthInput.value, 10);
        getSettings().auditor.manualCachingAtDepth = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
        saveSettings();
    });
    depthLabel.appendChild(depthInput);
    depthLabel.appendChild(el('span', 'me-field-hint', 'Used only when the server settings cannot be read.'));
    container.appendChild(depthLabel);

    const actions = el('div', 'me-actions');
    const runButton = button('menu_button menu_button_primary', 'Run cache audit', async () => {
        runButton.disabled = true;
        results.replaceChildren(el('p', 'me-section-note', 'Auditing…'));
        try {
            const report = await runAudit({ sandboxEvaluate: makeSandboxEvaluate?.() });
            renderResults(results, report);
        } catch (error) {
            results.replaceChildren(el('div', 'me-warning', `Audit failed: ${error?.message ?? error}`));
        } finally {
            runButton.disabled = false;
        }
    });
    actions.appendChild(runButton);
    if (onHelp) {
        actions.appendChild(helpButton('Why prompt caching matters', onHelp));
    }
    container.appendChild(actions);

    const results = el('div', 'me-audit-results');
    container.appendChild(results);
}
