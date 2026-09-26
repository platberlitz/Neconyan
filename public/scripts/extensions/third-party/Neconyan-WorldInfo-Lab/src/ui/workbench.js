import {
    GENERATION_TRIGGERS,
    LOGIC_LABEL,
    POSITION_LABEL,
} from '../constants.js';
import { getContext, loadHost, notify } from '../host.js';
import { appendHistory } from '../history.js';
import { getSettings, updateSettings } from '../settings.js';
import { runWorldInfoLab, restoredSnapshot, mountSavedWorldInfoResults } from '../native.js';
import {
    element,
    errorMessage,
    field,
    formatValue,
    humanize,
    statusRegion,
} from './dom.js';
import { createBatchTab, createHealthTab, createTestsTab } from './future-tabs.js';

const TABS = [
    { id: 'scan', label: 'Scan', icon: 'fa-magnifying-glass', hint: 'Test current chat or pasted text' },
    { id: 'trace', label: 'Trace', icon: 'fa-route', hint: 'Follow every activation decision' },
    { id: 'tests', label: 'Saved Tests', icon: 'fa-vials', hint: 'Replay saved scan expectations' },
    { id: 'batch', label: 'Batch Edit', icon: 'fa-pen-to-square', hint: 'Preview and apply grouped edits' },
    { id: 'health', label: 'Health', icon: 'fa-heart-pulse', hint: 'Audit one lorebook for problems' },
];

const TRIGGER_LABEL = Object.freeze({
    normal: 'New reply',
    continue: 'Continue response',
    impersonate: 'Impersonate user',
    swipe: 'Swipe response',
    regenerate: 'Regenerate response',
    quiet: 'Quiet or background reply',
});

const ACTIVATION_REASON_LABEL = Object.freeze({
    decorator: 'Forced by @@activate',
    forced: 'Forced by test input',
    constant: 'Always active',
    sticky: 'Sticky entry',
    primary: 'Primary key matched',
    'primary-secondary': 'Primary and secondary keys matched',
});

const OUTCOME_LABEL = Object.freeze({
    activated: 'Activated',
    disabled: 'Skipped: entry disabled',
    'trigger-filtered': 'Skipped: reply action does not match',
    'character-filtered': 'Skipped: character filter',
    'timed-effect': 'Skipped: delay or cooldown',
    'recursion-gated': 'Skipped in this scan round',
    'decorator-blocked': 'Blocked by entry directive',
    'primary-miss': 'No primary key matched',
    'no-primary-keys': 'No usable primary keys',
    'secondary-miss': 'Secondary-key rule not met',
    'group-rejected': 'Not chosen from inclusion group',
    'probability-rejected': 'Probability check failed',
    'probability-failed-earlier': 'Probability failed in an earlier round',
    'budget-rejected': 'Did not fit the token budget',
    'not-evaluated-after-overflow': 'Not checked after the token budget filled',
    'already-activated': 'Already activated in an earlier round',
    candidate: 'Reached final activation checks',
    'not-evaluated': 'Not activated',
    rejected: 'Not activated',
});

const STAGE_LABEL = Object.freeze({
    'Generation trigger': 'Reply action',
    'Timed effects': 'Sticky, cooldown, and delay',
    'Recursion gate': 'Recursive-scan rule',
    Decorator: 'Entry directive',
    Keys: 'Key matching',
    Activation: 'Activation source',
});

const STAGE_STATUS_LABEL = Object.freeze({
    pass: 'Passed',
    fail: 'Blocked',
    skip: 'Skipped',
    active: 'Continues',
});

const ROUND_LABEL = Object.freeze({
    Initial: 'Initial scan',
    Recursion: 'Recursive scan',
    'Minimum activations': 'Deeper scan for minimum activations',
    Stopped: 'Scan ended',
});

const OMISSION_LABEL = Object.freeze({
    'empty-after-regex': 'Not inserted: regex processing produced empty content',
    'missing-outlet-name': 'Not inserted: the entry has no outlet name',
});

const PLACEMENT_STATUS_LABEL = Object.freeze({
    'conditional-author-note': "Prepared for Author's Note; inserted only when its schedule is active",
    'outlet-value': 'Available to a matching outlet macro; not inserted by itself',
});

function plural(count, singular, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

function metric(label, value) {
    const node = element('div', { className: 'sbwil-metric' });
    node.append(
        element('span', { className: 'sbwil-metric-value', text: value }),
        element('span', { className: 'sbwil-metric-label', text: label }),
    );
    return node;
}

function contextLine(snapshot = null) {
    const context = getContext();
    const messages = (context?.chat ?? []).filter(message => (
        message && !message.is_system && typeof message.mes === 'string'
    )).length;
    const parts = [plural(messages, 'chat message')];
    if (snapshot) {
        parts.push(plural(snapshot.plan?.all?.length ?? 0, 'active lorebook'));
        parts.push(plural(snapshot.entries?.length ?? 0, 'entry', 'entries'));
    }
    return parts.join('; ');
}

function staleMessage(reason) {
    if (reason === 'chat-changed') {
        return 'These results are out of date because the chat changed. Run the scan again to update them.';
    }
    if (reason === 'worldinfo-updated' || reason === 'worldinfo-settings-updated') {
        return 'These results are out of date because a lorebook or its settings changed. Run the scan again to update them.';
    }
    if (reason === 'scan-input-changed') {
        return 'These results are out of date because the chat, character, group, persona, or character tags changed. Run the scan again.';
    }
    if (reason === 'settings-updated') {
        return 'These results are out of date because Neconyan settings or scan-enabled prompts changed. Run the scan again.';
    }
    if (reason === 'local-input-changed') {
        return 'These results are out of date because a scan option changed. Run the scan again.';
    }
    return '';
}

function detailText(value, omitted = []) {
    const detail = Object.entries(value ?? {})
        .filter(([key, item]) => !omitted.includes(key) && item !== undefined && item !== '')
        .map(([key, item]) => `${humanize(key)}: ${formatValue(item)}`);
    return detail.join('; ');
}

function quoteList(values) {
    return values.map(value => `"${value}"`).join(', ');
}

function describeKeyMatch(trace) {
    const match = trace?.match;
    if (!match) {
        return '';
    }
    if (trace.outcome === 'no-primary-keys') {
        return 'This entry has no usable primary keys.';
    }
    if (trace.outcome === 'primary-miss') {
        const tried = (match.primary ?? []).map(item => item.expanded).filter(Boolean);
        return tried.length
            ? `No primary key matched. Tried: ${quoteList(tried)}.`
            : 'No primary key matched.';
    }
    const primary = match.primaryMatch;
    if (!primary) {
        return '';
    }
    if (trace.outcome === 'secondary-miss') {
        const rule = LOGIC_LABEL[match.logic] ?? `rule ${match.logic}`;
        return `Primary key "${primary.expanded}" matched, but the secondary keys did not satisfy ${rule}.`;
    }
    const matchedText = primary.value ? ` "${primary.value}"` : '';
    const matchType = {
        regex: 'with a regular expression',
        'whole-word': 'as a whole word',
        phrase: 'as a phrase',
        plain: 'as text',
    }[primary.kind] ?? 'in the scan text';
    const secondary = match.reason === 'primary-secondary'
        ? ` The secondary-key rule ${LOGIC_LABEL[match.logic] ?? match.logic} also passed.`
        : '';
    return `Primary key "${primary.expanded}" matched${matchedText} ${matchType}.${secondary}`;
}

function resultWarnings(result) {
    const section = element('section', {
        className: 'sbwil-warnings',
        attributes: { 'aria-labelledby': 'sbwil-warnings-title' },
    });
    section.append(element('h4', { id: 'sbwil-warnings-title', text: 'Warnings and accuracy notes' }));
    const warnings = result?.warnings ?? [];
    if (!warnings.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No warnings or known accuracy limits for this scan.',
        }));
        return section;
    }
    const list = element('ul', { className: 'sbwil-warning-list' });
    warnings.forEach((warning) => {
        list.append(element('li', { text: warning }));
    });
    section.append(list);
    return section;
}

function renderScanResult(container, result, stale) {
    container.replaceChildren();
    if (!result) {
        const empty = element('section', { className: 'sbwil-empty-state' });
        empty.append(
            element('p', { className: 'sbwil-kicker', text: 'NO SCAN YET' }),
            element('h3', { text: 'See which lorebook entries would activate' }),
            element('p', {
                text: 'Choose Current chat or Pasted text, then select Run scan. No reply will be generated and no lorebook will be edited.',
            }),
        );
        container.append(empty);
        return;
    }

    const section = element('section', { className: 'sbwil-result' });
    const heading = element('div', { className: 'sbwil-result-heading' });
    heading.append(element('div'));
    heading.firstElementChild.append(
        element('p', { className: 'sbwil-kicker', text: 'LATEST COMPLETED SCAN' }),
        element('h3', { text: 'Which entries would activate' }),
    );
    heading.append(element('code', {
        className: 'sbwil-fingerprint',
        text: `Result ID: ${result.fingerprint ?? 'unavailable'}`,
    }));
    section.append(heading);

    if (stale) {
        section.append(element('p', {
            className: 'sbwil-stale-notice',
            text: stale,
        }));
    }

    const budget = result.budget ?? {};
    const metrics = element('div', { className: 'sbwil-metrics' });
    metrics.append(
        metric('Entries activated', result.activated?.length ?? 0),
        metric('Scan rounds', result.rounds?.length ?? 0),
        metric('Lorebook tokens', `${budget.used ?? 0} / ${budget.limit ?? 0}`),
        metric('Random seed', result.seed ?? 0),
    );
    section.append(metrics);

    const budgetBlock = element('div', { className: 'sbwil-budget' });
    const budgetLabel = element('div', { className: 'sbwil-budget-label' });
    budgetLabel.append(
        element('span', { text: 'Token budget' }),
        element('strong', {
            text: budget.overflowed
                ? `${budget.used ?? 0} of ${budget.limit ?? 0} tokens used; another entry did not fit`
                : `${budget.used ?? 0} of ${budget.limit ?? 0} used`,
        }),
    );
    const progress = element('progress', {
        className: 'sbwil-progress',
        attributes: {
            max: Math.max(1, Number(budget.limit) || 1),
            value: Math.min(Number(budget.used) || 0, Math.max(1, Number(budget.limit) || 1)),
            'aria-label': 'Token budget used',
        },
    });
    budgetBlock.append(budgetLabel, progress);
    section.append(budgetBlock);

    const activatedSection = element('section', {
        className: 'sbwil-activated',
        attributes: { 'aria-labelledby': 'sbwil-activated-title' },
    });
    activatedSection.append(
        element('h4', { id: 'sbwil-activated-title', text: 'Activated entries' }),
        element('p', {
            className: 'sbwil-field-hint',
            text: 'These entries passed the scan rules. An activated entry can still produce no prompt content; check Insertion results in Trace.',
        }),
    );
    if (!result.activated?.length) {
        activatedSection.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No entries would activate. Open Trace to see which rule blocked each entry, and check that the expected lorebooks are active.',
        }));
    } else {
        const list = element('ol', { className: 'sbwil-activated-list' });
        result.activated.forEach((entry) => {
            const item = element('li');
            const identity = element('div');
            identity.append(
                element('strong', { text: entry.label }),
                element('code', { text: entry.id }),
            );
            item.append(
                identity,
                element('span', {
                    className: 'sbwil-reason',
                    text: ACTIVATION_REASON_LABEL[entry.activationReason] ?? 'Activated',
                }),
            );
            list.append(item);
        });
        activatedSection.append(list);
    }
    section.append(activatedSection, resultWarnings(result));
    container.append(section);
}

function signalItem(title, meta, status = 'neutral') {
    const normalized = ['pass', 'fail', 'skip', 'active', 'neutral'].includes(status)
        ? status
        : 'neutral';
    const item = element('li', { className: `sbwil-signal-item sbwil-signal-${normalized}` });
    item.append(element('span', {
        className: 'sbwil-signal-node',
        attributes: { 'aria-hidden': 'true' },
    }));
    const body = element('div', { className: 'sbwil-signal-body' });
    const titleRow = element('div', { className: 'sbwil-signal-title' });
    titleRow.append(element('strong', { text: title }));
    if (normalized !== 'neutral') {
        titleRow.append(element('span', {
            className: 'sbwil-signal-status',
            text: STAGE_STATUS_LABEL[normalized] ?? humanize(normalized),
        }));
    }
    body.append(titleRow);
    if (meta) {
        body.append(element('span', { text: meta }));
    }
    item.append(body);
    return item;
}

function renderRounds(result) {
    const section = element('section', {
        className: 'sbwil-trace-rounds',
        attributes: { 'aria-labelledby': 'sbwil-rounds-title' },
    });
    section.append(element('h4', { id: 'sbwil-rounds-title', text: 'Scan rounds' }));
    section.append(element('p', {
        className: 'sbwil-field-hint',
        text: 'Additional rounds happen when recursion or minimum-activation settings scan more text.',
    }));
    const rail = element('ol', { className: 'sbwil-signal-rail' });
    (result.rounds ?? []).forEach((round) => {
        const details = [
            `Chat depth: ${plural(round.depth ?? 0, 'message')}`,
            `${plural(round.candidates?.length ?? 0, 'entry', 'entries')} reached activation checks`,
            plural(round.activated?.length ?? 0, 'activation'),
        ];
        if (round.activated?.length) {
            details.push(`Activated entry IDs: ${round.activated.join(', ')}`);
        }
        if (round.nextStateLabel) {
            details.push(round.nextStateLabel === 'Stopped'
                ? 'Scan ended'
                : `Next round: ${ROUND_LABEL[round.nextStateLabel] ?? round.nextStateLabel}`);
        }
        rail.append(signalItem(
            `Round ${round.number}: ${ROUND_LABEL[round.stateLabel] ?? round.stateLabel ?? 'Unknown scan state'}`,
            details.join('; '),
            round.stateLabel === 'Recursion' ? 'active' : 'neutral',
        ));
    });
    if (!result.rounds?.length) {
        rail.append(signalItem('No scan rounds were returned', 'Try running the scan again. If this repeats, include the technical details in a bug report.', 'skip'));
    }
    section.append(rail);
    return section;
}

function renderPlacements(result) {
    const section = element('section', {
        className: 'sbwil-trace-section',
        attributes: { 'aria-labelledby': 'sbwil-placements-title' },
    });
    section.append(element('h4', { id: 'sbwil-placements-title', text: 'Insertion results' }));
    const records = result.placements?.records ?? [];
    if (!records.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No entries activated, so there is no lorebook content to insert.',
        }));
        return section;
    }

    const list = element('div', { className: 'sbwil-placement-list' });
    records.forEach((record) => {
        const details = element('details', { className: 'sbwil-placement' });
        const summary = element('summary');
        const identity = element('span');
        identity.append(
            element('strong', { text: record.label }),
            element('code', { text: record.id }),
        );
        const placement = POSITION_LABEL[record.position] ?? `Position ${record.position}`;
        const qualifiers = [placement];
        if (record.depth !== null && record.depth !== undefined) {
            qualifiers.push(`chat depth ${record.depth}`);
        }
        if (record.outlet) {
            qualifiers.push(`outlet: ${record.outlet}`);
        }
        const inserted = record.placementStatus === 'inserted';
        summary.append(
            identity,
            element('span', {
                className: inserted ? 'sbwil-chip' : 'sbwil-chip sbwil-chip-muted',
                text: inserted
                    ? qualifiers.join('; ')
                    : PLACEMENT_STATUS_LABEL[record.placementStatus]
                        ? `${qualifiers.join('; ')}; ${PLACEMENT_STATUS_LABEL[record.placementStatus]}`
                    : (OMISSION_LABEL[record.omissionReason] ?? 'Not inserted'),
            }),
        );
        const content = element('pre', { className: 'sbwil-log' });
        content.textContent = record.renderedContent || record.rawContent || '(No content)';
        details.append(summary, content);
        list.append(details);
    });
    section.append(list);
    return section;
}

function renderEntryTraces(result) {
    const section = element('section', {
        className: 'sbwil-trace-section',
        attributes: { 'aria-labelledby': 'sbwil-entry-traces-title' },
    });
    section.append(element('h4', { id: 'sbwil-entry-traces-title', text: 'Why entries activated or were skipped' }));
    const traces = result.traces ?? [];
    if (!traces.length) {
        section.append(element('p', {
            className: 'sbwil-empty-line',
            text: 'No entry checks were recorded. The loaded lorebooks may contain no entries.',
        }));
        return section;
    }

    const byRound = new Map();
    traces.forEach((trace) => {
        if (!byRound.has(trace.round)) {
            byRound.set(trace.round, []);
        }
        byRound.get(trace.round).push(trace);
    });

    for (const [round, roundTraces] of byRound) {
        const roundDetails = element('details', { className: 'sbwil-trace-group' });
        if (round === 1) {
            roundDetails.open = true;
        }
        const activated = roundTraces.filter(trace => trace.outcome === 'activated').length;
        roundDetails.append(element('summary', {
            text: `Round ${round}: ${plural(roundTraces.length, 'entry', 'entries')} checked; ${plural(activated, 'activation')}`,
        }));

        const entries = element('div', { className: 'sbwil-entry-trace-list' });
        roundTraces.forEach((trace) => {
            const details = element('details', { className: 'sbwil-entry-trace' });
            const summary = element('summary');
            const identity = element('span');
            identity.append(
                element('strong', { text: trace.label }),
                element('code', { text: trace.id }),
            );
            summary.append(
                identity,
                element('span', {
                    className: `sbwil-chip sbwil-outcome-${trace.outcome === 'activated' ? 'pass' : 'neutral'}`,
                    text: OUTCOME_LABEL[trace.outcome] ?? 'Not activated',
                }),
            );
            details.append(summary);

            const keySummary = describeKeyMatch(trace);
            if (keySummary) {
                details.append(element('p', {
                    className: 'sbwil-match-summary',
                    text: keySummary,
                }));
            }

            const rail = element('ol', { className: 'sbwil-signal-rail sbwil-stage-rail' });
            (trace.stages ?? []).forEach((stage) => {
                rail.append(signalItem(
                    STAGE_LABEL[stage.name] ?? stage.name,
                    detailText(stage, ['name', 'status']),
                    stage.status,
                ));
            });
            if (!trace.stages?.length) {
                rail.append(signalItem('Not checked', 'No rule checks were recorded for this entry.', 'skip'));
            }
            details.append(rail);
            entries.append(details);
        });
        roundDetails.append(entries);
        section.append(roundDetails);
    }
    return section;
}

function renderTrace(container, result, stale) {
    container.replaceChildren();
    if (!result) {
        const empty = element('section', { className: 'sbwil-empty-state' });
        empty.append(
            element('p', { className: 'sbwil-kicker', text: 'NO TRACE YET' }),
            element('h3', { text: 'Run a scan to create a Trace' }),
            element('p', { text: 'Trace will show why each entry activated or was skipped and where activated content would be inserted.' }),
        );
        container.append(empty);
        return;
    }

    const header = element('header', { className: 'sbwil-trace-header' });
    const title = element('div');
    title.append(
        element('p', { className: 'sbwil-kicker', text: 'SCAN TRACE' }),
        element('h3', { text: 'Why each entry did or did not activate' }),
    );
    const budget = result.budget ?? {};
    header.append(
        title,
        element('p', {
            className: 'sbwil-trace-budget',
            text: budget.overflowed
                ? `${budget.used ?? 0} of ${budget.limit ?? 0} lorebook tokens used; at least one entry did not fit`
                : `${budget.used ?? 0} of ${budget.limit ?? 0} lorebook tokens used`,
        }),
    );
    container.append(header);
    if (stale) {
        container.append(element('p', { className: 'sbwil-stale-notice', text: stale }));
    }

    const layout = element('div', { className: 'sbwil-trace-layout' });
    const detail = element('div', { className: 'sbwil-trace-detail' });
    detail.append(renderPlacements(result), renderEntryTraces(result));
    layout.append(renderRounds(result), detail);
    container.append(layout);
}

export function createWorkbench({
    lifetimeSignal = null,
    onStateChange = () => {},
} = {}) {
    let session = null;
    let destroyed = false;
    let latestResult = null;
    let latestSnapshot = null;
    let stale = '';
    let availability = null;
    let resultRunSequence = 0;
    let layout = 'drawer';

    function state() {
        return {
            availability,
            latestResult,
            latestSnapshot,
            stale,
            open: Boolean(session),
            layout,
        };
    }

    function emitState() {
        onStateChange(state());
    }

    function beginResultRun() {
        return ++resultRunSequence;
    }

    function acceptResult(result, sequence, snapshot = null) {
        if (sequence !== resultRunSequence) {
            return false;
        }
        latestResult = result;
        latestSnapshot = snapshot;
        stale = '';
        session?.renderResult();
        emitState();
        return true;
    }

    function buildSession() {
        const sessionController = new AbortController();
        const { signal } = sessionController;
        let disposed = false;
        let runController = null;
        let runSequence = 0;

        const root = element('div', {
            id: 'sbwil-workbench',
            className: 'sbwil-workbench sbwil-workbench-drawer',
        });
        const header = element('header', { className: 'sbwil-workbench-header' });
        const heading = element('div', { className: 'sbwil-title-block' });
        heading.append(
            element('p', { className: 'sbwil-kicker', text: 'LOREBOOK TROUBLESHOOTING' }),
            element('h2', { text: 'World Info Lab' }),
            element('p', {
                className: 'sbwil-muted',
                text: 'See which lorebook entries would activate without generating a reply or editing a lorebook.',
            }),
        );
        const headerMeta = element('div', { className: 'sbwil-header-meta' });
        const hostStatus = element('span', { className: 'sbwil-host-status' });
        const sourceStatus = element('span', { className: 'sbwil-source-status' });
        headerMeta.append(hostStatus, sourceStatus);
        header.append(heading, headerMeta);

        const tabList = element('div', {
            className: 'sbwil-tabs',
            attributes: {
                role: 'tablist',
                'aria-label': 'World Info Lab tools',
            },
        });
        const panels = new Map();
        const tabButtons = [];
        TABS.forEach((tab) => {
            const button = element('button', {
                id: `sbwil-tab-${tab.id}`,
                className: 'sbwil-tab',
                attributes: {
                    type: 'button',
                    role: 'tab',
                    'aria-controls': `sbwil-panel-${tab.id}`,
                    'aria-selected': 'false',
                    'aria-label': tab.label,
                    title: tab.hint,
                    tabindex: '-1',
                },
            });
            const text = element('span', { className: 'sbwil-tab-text' });
            text.append(
                element('span', { className: 'sbwil-tab-label', text: tab.label }),
                element('span', { className: 'sbwil-tab-hint', text: tab.hint }),
            );
            button.append(
                element('span', {
                    className: `sbwil-tab-icon fa-solid ${tab.icon}`,
                    attributes: { 'aria-hidden': 'true' },
                }),
                text,
            );
            const panel = element('section', {
                id: `sbwil-panel-${tab.id}`,
                className: `sbwil-panel sbwil-panel-${tab.id}`,
                attributes: {
                    role: 'tabpanel',
                    'aria-labelledby': button.id,
                    tabindex: '0',
                },
            });
            panel.hidden = true;
            tabList.append(button);
            tabButtons.push(button);
            panels.set(tab.id, panel);
        });

        const tabSelect = element('select', {
            className: 'text_pole sbwil-tab-select',
            attributes: { 'aria-label': 'World Info Lab tool' },
        });
        TABS.forEach(tab => tabSelect.append(element('option', {
            text: tab.label,
            attributes: { value: tab.id },
        })));
        const nav = element('nav', {
            className: 'sbwil-nav',
            attributes: { 'aria-label': 'World Info Lab tools' },
        });
        nav.append(tabList, tabSelect);

        const panelHost = element('div', { className: 'sbwil-panel-host sbwil-main' });
        TABS.forEach(tab => panelHost.append(panels.get(tab.id)));
        root.append(header, nav, panelHost);

        const scanPanel = panels.get('scan');
        const scanLayout = element('div', { className: 'sbwil-scan-layout' });
        const controls = element('section', {
            className: 'sbwil-scan-controls',
            attributes: { 'aria-labelledby': 'sbwil-scan-controls-title' },
        });
        controls.append(
            element('p', { className: 'sbwil-kicker', text: 'INPUT' }),
            element('h3', { id: 'sbwil-scan-controls-title', text: 'Choose what to scan' }),
        );
        const form = element('form', { className: 'sbwil-scan-form' });
        const modeGroup = element('fieldset', { className: 'sbwil-mode-group' });
        modeGroup.append(element('legend', { text: 'Input mode' }));
        const settings = getSettings();
        const modeInputs = [];
        [
            { value: 'chat', label: 'Current chat' },
            { value: 'text', label: 'Pasted text' },
        ].forEach((option) => {
            const label = element('label', { className: 'sbwil-mode-option' });
            const input = element('input', {
                attributes: {
                    type: 'radio',
                    name: 'sbwil-input-mode',
                    value: option.value,
                },
            });
            input.checked = settings.inputMode === option.value;
            modeInputs.push(input);
            label.append(input, element('span', { text: option.label }));
            modeGroup.append(label);
        });

        const textInput = element('textarea', {
            id: 'sbwil-pasted-text',
            className: 'text_pole sbwil-textarea',
            attributes: {
                rows: '10',
                placeholder: 'Paste text to test against your lorebooks',
                spellcheck: 'true',
            },
        });
        const textField = field('Text to scan', textInput, {
            hint: 'Submitted text and results are saved on the server so you can reopen the scan.',
        });

        const triggerSelect = element('select', {
            id: 'sbwil-trigger',
            className: 'text_pole sbwil-select',
        });
        GENERATION_TRIGGERS.forEach((trigger) => {
            triggerSelect.append(element('option', {
                text: TRIGGER_LABEL[trigger] ?? humanize(trigger),
                attributes: { value: trigger },
            }));
        });
        triggerSelect.value = GENERATION_TRIGGERS.includes(settings.trigger)
            ? settings.trigger
            : 'normal';

        const seedInput = element('input', {
            id: 'sbwil-seed',
            className: 'text_pole sbwil-input',
            attributes: {
                type: 'number',
                min: '0',
                max: '4294967295',
                step: '1',
                required: 'required',
                inputmode: 'numeric',
            },
        });
        seedInput.value = String(settings.seed);

        const parameterGrid = element('div', { className: 'sbwil-parameter-grid' });
        parameterGrid.append(
            field('Reply action to simulate', triggerSelect, {
                hint: 'Choose what Neconyan would be doing when it checks the lorebooks.',
            }),
            field('Random-choice seed', seedInput, {
                hint: 'The same seed repeats probability and inclusion-group choices.',
            }),
        );

        const sourceLine = element('p', { className: 'sbwil-context-line' });
        const actions = element('div', { className: 'sbwil-run-actions' });
        const runButton = element('button', {
            className: 'menu_button sbwil-button sbwil-button-primary sbwil-run-button',
            text: 'Run scan',
            attributes: { type: 'submit' },
        });
        const cancelButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Cancel scan',
            attributes: { type: 'button' },
        });
        cancelButton.hidden = true;
        const checkCompatibilityButton = element('button', {
            className: 'menu_button sbwil-button',
            text: 'Check compatibility again',
            attributes: { type: 'button' },
        });
        checkCompatibilityButton.hidden = true;
        actions.append(runButton, cancelButton, checkCompatibilityButton);
        const runStatus = statusRegion('Ready. Run the scan to see which entries would activate.');
        form.append(
            modeGroup,
            textField,
            parameterGrid,
            sourceLine,
            actions,
            runStatus,
        );
        controls.append(form);
        void mountSavedWorldInfoResults(controls, { kinds: ['world-info.scan'], signal,
            onError: error => { runStatus.textContent = errorMessage(error); }, onResult: result => {
                acceptResult(result, beginResultRun(), restoredSnapshot(result));
                runStatus.textContent = 'Saved scan loaded.';
            } }).catch(error => { runStatus.textContent = errorMessage(error); });

        const scanOutput = element('div', {
            className: 'sbwil-scan-output',
            attributes: {
                'aria-label': 'Scan results',
            },
        });
        scanLayout.append(controls, scanOutput);
        scanPanel.append(scanLayout);

        const tracePanel = panels.get('trace');
        const testsTab = createTestsTab({
            panel: panels.get('tests'),
            getLatestResult: () => latestResult,
            isLatestResultStale: () => Boolean(stale),
            acceptResult,
            beginResultRun,
            isCurrentResultRun: sequence => sequence === resultRunSequence,
        });
        const batchTab = createBatchTab({ panel: panels.get('batch') });
        const healthTab = createHealthTab({ panel: panels.get('health') });
        const futureTabs = { tests: testsTab, batch: batchTab, health: healthTab };

        function currentMode() {
            return modeInputs.find(input => input.checked)?.value ?? 'chat';
        }

        function syncMode(focusText = false) {
            const pasted = currentMode() === 'text';
            textField.hidden = !pasted;
            textInput.disabled = !pasted;
            textInput.required = pasted;
            updateSettings({ inputMode: pasted ? 'text' : 'chat' });
            if (pasted && focusText) {
                textInput.focus();
            }
        }

        function setRunning(running) {
            form.setAttribute('aria-busy', String(running));
            runButton.textContent = running ? 'Restart scan' : 'Run scan';
            cancelButton.hidden = !running;
        }

        function updateHeader() {
            if (availability?.ok === true) {
                hostStatus.textContent = 'Ready to scan';
                hostStatus.className = 'sbwil-host-status sbwil-host-ready';
                hostStatus.removeAttribute('title');
            } else if (availability?.ok === false) {
                hostStatus.textContent = 'Cannot scan';
                hostStatus.className = 'sbwil-host-status sbwil-host-error';
                hostStatus.title = `Technical details: ${availability.reason ?? 'Neconyan compatibility check failed.'}`;
            } else {
                hostStatus.textContent = 'Checking compatibility';
                hostStatus.className = 'sbwil-host-status';
                hostStatus.removeAttribute('title');
            }
            sourceStatus.textContent = contextLine(latestSnapshot);
            sourceLine.textContent = currentMode() === 'chat'
                ? `Input: current chat; ${contextLine(latestSnapshot)}${latestSnapshot ? '' : '; lorebooks load when the scan starts'}`
                : 'Input: pasted text';
            runButton.disabled = availability?.ok === false;
            checkCompatibilityButton.hidden = availability?.ok !== false;
            if (availability?.ok === false) {
                runButton.title = 'Update Neconyan or World Info Lab, then reload.';
                if (!runController) {
                    runStatus.textContent = `Lorebook scanning is unavailable. Update Neconyan or World Info Lab, then reload. Technical details: ${availability.reason ?? 'Compatibility check failed.'}`;
                }
            } else {
                runButton.removeAttribute('title');
            }
        }

        function renderResult() {
            renderScanResult(scanOutput, latestResult, stale);
            renderTrace(tracePanel, latestResult, stale);
            testsTab.syncResultState();
            updateHeader();
        }

        function abortRun(message = '') {
            if (!runController) {
                return;
            }
            runSequence++;
            runController.abort();
            runController = null;
            setRunning(false);
            if (message) {
                runStatus.textContent = message;
            }
        }

        function invalidateLocalInput() {
            const wasRunning = Boolean(runController);
            if (wasRunning) {
                abortRun('Scan input changed. Run the scan again.');
            }
            if (latestResult) {
                stale = staleMessage('local-input-changed');
                if (!wasRunning) {
                    runStatus.textContent = 'Scan input changed. Run the scan again.';
                }
                renderResult();
                emitState();
            }
        }

        async function runSimulation() {
            textInput.setCustomValidity(
                currentMode() === 'text' && !textInput.value.trim()
                    ? 'Paste or enter some text to test.'
                    : '',
            );
            if (!form.reportValidity()) {
                return;
            }
            abortRun();
            const sequence = ++runSequence;
            const resultSequence = beginResultRun();
            const controller = new AbortController();
            runController = controller;
            setRunning(true);

            const mode = currentMode();
            const trigger = triggerSelect.value;
            const seed = Number(seedInput.value) >>> 0;
            const text = textInput.value;
            updateSettings({ inputMode: mode, trigger, seed });
            runStatus.textContent = 'Loading active lorebooks...';

            try {
                const result = await runWorldInfoLab('scan', { mode, text, trigger, seed }, {
                    signal: controller.signal,
                    onProgress: progress => { if (!disposed) runStatus.textContent = progress?.stage || 'Checking saved lorebooks...'; },
                });
                const snapshot = restoredSnapshot(result);
                if (disposed || controller.signal.aborted || sequence !== runSequence || resultSequence !== resultRunSequence) {
                    if (!disposed && !controller.signal.aborted && sequence === runSequence) {
                        runStatus.textContent = 'A newer scan or saved test was started; this result was not shown.';
                    }
                    return;
                }
                latestSnapshot = snapshot;
                updateHeader();
                if (disposed || controller.signal.aborted || sequence !== runSequence || resultSequence !== resultRunSequence) {
                    if (!disposed && !controller.signal.aborted && sequence === runSequence) {
                        runStatus.textContent = 'A newer scan or saved test was started; this result was not shown.';
                    }
                    return;
                }
                if (disposed || controller.signal.aborted || sequence !== runSequence) {
                    return;
                }
                if (resultSequence !== resultRunSequence) {
                    runStatus.textContent = 'A newer scan or saved test was started; this result was not shown.';
                    return;
                }
                try {
                    appendHistory(result);
                } catch (error) {
                    result.warnings.push(`The scan completed, but its recent-scan summary could not be saved. Technical details: ${errorMessage(error)}`);
                }
                acceptResult(result, resultSequence, snapshot);
                void testsTab.refresh();
                runStatus.textContent = `Scan complete: ${plural(result.activated?.length ?? 0, 'entry', 'entries')} activated.`;
            } catch (error) {
                if (disposed || sequence !== runSequence) {
                    return;
                }
                if (resultSequence !== resultRunSequence) {
                    runStatus.textContent = 'A newer scan or saved test was started; this result was not shown.';
                    return;
                }
                if (error.cancelled) {
                    runStatus.textContent = 'Scan cancelled.';
                } else if (isAbort(error)) {
                    runStatus.textContent = 'Observation closed. The server keeps the scan.';
                } else {
                    const retained = latestResult ? ' The previous completed result is still shown.' : '';
                    const message = `Scan failed.${retained} Technical details: ${errorMessage(error)}`;
                    runStatus.textContent = message;
                    notify('error', message);
                }
            } finally {
                if (sequence === runSequence) {
                    runController = null;
                    setRunning(false);
                    emitState();
                }
            }
        }

        let activeTab = '';
        function setTab(tabId, { focus = false, persist = true } = {}) {
            const next = TABS.some(tab => tab.id === tabId) ? tabId : 'scan';
            activeTab = next;
            tabSelect.value = next;
            tabButtons.forEach((button, index) => {
                const selected = TABS[index].id === next;
                button.setAttribute('aria-selected', String(selected));
                button.tabIndex = selected ? 0 : -1;
                button.removeAttribute('autofocus');
                panels.get(TABS[index].id).hidden = !selected;
                if (selected) {
                    button.setAttribute('autofocus', '');
                    if (focus) {
                        button.focus();
                    }
                }
            });
            if (persist) {
                updateSettings({ lastTab: next });
            }
            void futureTabs[next]?.activate();
        }

        tabButtons.forEach((button, index) => {
            button.addEventListener('click', () => {
                setTab(TABS[index].id);
            }, { signal });
            button.addEventListener('keydown', (event) => {
                let nextIndex = index;
                if (event.key === 'ArrowRight' || (layout === 'page' && event.key === 'ArrowDown')) {
                    nextIndex = (index + 1) % tabButtons.length;
                } else if (event.key === 'ArrowLeft' || (layout === 'page' && event.key === 'ArrowUp')) {
                    nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
                } else if (event.key === 'Home') {
                    nextIndex = 0;
                } else if (event.key === 'End') {
                    nextIndex = tabButtons.length - 1;
                } else {
                    return;
                }
                event.preventDefault();
                setTab(TABS[nextIndex].id, { focus: true });
            }, { signal });
        });
        tabSelect.addEventListener('change', () => {
            setTab(tabSelect.value);
        }, { signal });

        modeInputs.forEach((input) => {
            input.addEventListener('change', () => {
                syncMode(input.value === 'text');
                updateHeader();
                invalidateLocalInput();
            }, { signal });
        });
        triggerSelect.addEventListener('change', () => {
            updateSettings({ trigger: triggerSelect.value });
            invalidateLocalInput();
        }, { signal });
        seedInput.addEventListener('input', () => {
            if (seedInput.checkValidity()) {
                updateSettings({ seed: Number(seedInput.value) >>> 0 });
            }
            invalidateLocalInput();
        }, { signal });
        textInput.addEventListener('input', () => {
            textInput.setCustomValidity('');
            invalidateLocalInput();
        }, { signal });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void runSimulation();
        }, { signal });
        cancelButton.addEventListener('click', () => {
            runController?.abort('user-stop');
            runStatus.textContent = 'Saving the stop request...';
        }, { signal });
        checkCompatibilityButton.addEventListener('click', async () => {
            availability = null;
            runStatus.textContent = 'Checking compatibility with Neconyan...';
            updateHeader();
            const result = await loadHost();
            if (disposed) {
                return;
            }
            availability = result;
            renderResult();
            emitState();
        }, { signal });

        syncMode(false);
        setTab(settings.lastTab, { persist: false });
        renderResult();

        return {
            root,
            get activeTab() {
                return activeTab;
            },
            renderResult,
            refresh(reason) {
                if (reason === 'history-limit-changed') {
                    void testsTab.refreshHistory();
                    renderResult();
                    return;
                }
                const message = staleMessage(reason);
                if (message) {
                    // Accepted work owns its saved input. A settings refresh must not
                    // detach the observer before that saved result reaches the page.
                    if (runController) {
                        runStatus.textContent = 'Inputs changed. The accepted scan is continuing with its saved inputs.';
                    }
                    if (reason === 'worldinfo-updated') {
                        void testsTab.refresh();
                        void batchTab.refresh();
                        healthTab.refresh();
                    }
                }
                renderResult();
            },
            setLayout(nextLayout) {
                layout = nextLayout === 'page' ? 'page' : 'drawer';
                const isPage = layout === 'page';
                root.classList.toggle('sbwil-workbench-page', isPage);
                root.classList.toggle('sbwil-workbench-drawer', !isPage);
                tabList.setAttribute('aria-orientation', isPage ? 'vertical' : 'horizontal');
            },
            focusActiveTab() {
                const button = tabButtons.find(node => node.getAttribute('aria-selected') === 'true');
                const target = button?.getClientRects().length
                    ? button
                    : tabSelect.getClientRects().length
                        ? tabSelect
                        : panels.get(activeTab);
                target?.focus({ preventScroll: true });
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                abortRun();
                testsTab.dispose();
                batchTab.dispose();
                healthTab.dispose();
                sessionController.abort();
            },
        };
    }

    function mount(target, { layout: nextLayout = 'drawer' } = {}) {
        if (destroyed || !(target instanceof HTMLElement)) {
            return null;
        }
        session ??= buildSession();
        session.setLayout(nextLayout);
        if (session.root.parentElement !== target) {
            target.append(session.root);
        }
        emitState();
        return session.root;
    }

    function focus() {
        session?.focusActiveTab();
    }

    function close() {
        if (!session) {
            return;
        }
        const closingSession = session;
        session = null;
        closingSession.dispose();
        closingSession.root.remove();
        emitState();
    }

    function abortLifetime() {
        destroyed = true;
        close();
    }

    if (lifetimeSignal?.aborted) {
        abortLifetime();
    } else if (lifetimeSignal) {
        lifetimeSignal.addEventListener('abort', abortLifetime, { once: true });
    }

    return {
        mount,
        focus,
        close,
        refresh(reason) {
            const message = staleMessage(reason);
            if (message && latestResult) {
                stale = message;
            }
            if (message) {
                latestSnapshot = null;
            }
            session?.refresh(reason);
            emitState();
        },
        setAvailability(value) {
            availability = value;
            session?.renderResult();
            emitState();
        },
        getState: state,
        dispose() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            lifetimeSignal?.removeEventListener('abort', abortLifetime);
            close();
        },
    };
}
