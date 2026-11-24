/**
 * Shared formatting for the fixed problem checks. Dependency-free, so the
 * checks can also be run outside the browser.
 */

export const MAX_FINDINGS_PER_ITEM = 40;

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const LOGIC_LABELS = ['AND ANY', 'NOT ALL', 'NOT ANY', 'AND ALL'];

function valueText(value) {
    return String(value ?? '').trim();
}

/** The item a finding belongs to, in one short phrase. */
export function targetLabel(target = {}) {
    const name = valueText(target.name) || 'Unnamed';
    if (target.kind === 'preset') {
        return [`Preset: ${name}`, valueText(target.module) ? `module ${target.module}` : ''].filter(Boolean).join(' | ');
    }
    if (target.kind === 'lorebook') {
        return [
            `Lorebook: ${name}`,
            target.uid !== undefined && target.uid !== '' ? `uid ${target.uid}` : '',
            valueText(target.title),
        ].filter(Boolean).join(' | ');
    }
    return [`Character: ${name}`, valueText(target.field)].filter(Boolean).join(' | ');
}

function capItem(findings) {
    const sorted = [...findings].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
    if (sorted.length <= MAX_FINDINGS_PER_ITEM) return { findings: sorted, cut: 0 };
    return { findings: sorted.slice(0, MAX_FINDINGS_PER_ITEM), cut: sorted.length - MAX_FINDINGS_PER_ITEM };
}

/**
 * Formats the results of checkCharacterCard, checkPreset and checkLorebook.
 * @param {{kind: string, name: string, findings: object[]}[]} results Checked items
 * @returns {string} The Checks section body
 */
export function formatChecks(results = []) {
    const lines = [];
    for (const result of results) {
        const findings = Array.isArray(result.findings) ? result.findings : [];
        const base = { kind: result.kind, name: result.name };
        const item = targetLabel(base);
        const real = findings.filter(item => item.severity === 'error' || item.severity === 'warning');
        if (!real.length) lines.push(`- ok | ${item} | No problems found by the fixed checks.`);
        const { findings: kept, cut } = capItem(findings);
        for (const finding of kept) {
            lines.push(`- ${finding.severity} | ${targetLabel({ ...base, ...finding.target })} | ${finding.message}`);
        }
        if (cut) lines.push(`- info | ${item} | ${cut} more findings were left out.`);
    }
    return lines.join('\n');
}

function bookSettingsLine(settings = {}) {
    const onOff = value => value ? 'on' : 'off';
    return [
        `scan depth: ${Number(settings.scanDepth) || 0}`,
        `token budget: ${Number(settings.tokenBudget) || 0}%`,
        `token cap: ${Number(settings.tokenBudgetCap) || 0}`,
        `recursion: ${onOff(settings.recursive)}${settings.recursive ? ` (max ${Number(settings.maxRecursionSteps) || 0} steps)` : ''}`,
        `case sensitive: ${onOff(settings.caseSensitive)}`,
        `whole words: ${onOff(settings.matchWholeWords)}`,
    ].join(' | ');
}

function activationLine(entry) {
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    const secondary = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [];
    const onOff = value => value ? 'yes' : 'no';
    const defaulted = (value, label) => value === undefined || value === null || value === '' ? `${label}: book default` : `${label}: ${value}`;
    const parts = [
        `- [shared] ${valueText(entry.title) || `Entry ${entry.uid}`} | uid: ${entry.uid} | keys: ${keys.length ? keys.join(', ') : 'none'}`,
        `secondary keys: ${secondary.length ? secondary.join(', ') : 'none'}`,
        `logic: ${LOGIC_LABELS[Number(entry.selectiveLogic) || 0] || Number(entry.selectiveLogic) || 0}`,
        `constant: ${onOff(entry.constant)}`,
        `disabled: ${onOff(entry.disabled)}`,
        `hidden from Agents: ${onOff(entry.hiddenFromAgents)}`,
        `selective: ${onOff(entry.selective)}`,
        `probability: ${entry.probability === undefined || entry.probability === null ? 100 : entry.probability}%`,
    ];
    if (entry.useProbability === false) parts.push('use probability: no');
    parts.push(
        `order: ${entry.order ?? 100}`,
        `position: ${entry.position ?? 0}`,
        defaulted(entry.depth, 'depth'),
        defaulted(entry.scanDepth, 'scan depth'),
        defaulted(entry.caseSensitive === undefined || entry.caseSensitive === null ? '' : onOff(entry.caseSensitive), 'case sensitive'),
        defaulted(entry.matchWholeWords === undefined || entry.matchWholeWords === null ? '' : onOff(entry.matchWholeWords), 'whole words'),
        `exclude recursion: ${onOff(entry.excludeRecursion)}`,
        `prevent recursion: ${onOff(entry.preventRecursion)}`,
    );
    if (entry.delayUntilRecursion) {
        const level = entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion);
        parts.push(`delay until recursion: level ${level}`);
    }
    const groupText = valueText(entry.group);
    parts.push(`group: ${groupText || 'none'}`);
    if (groupText) {
        if (entry.groupOverride) parts.push('group override: yes');
        if (entry.groupWeight !== undefined && entry.groupWeight !== null && Number(entry.groupWeight) !== 100) {
            parts.push(`group weight: ${entry.groupWeight}`);
        }
        if (typeof entry.useGroupScoring === 'boolean') {
            parts.push(`group scoring: ${onOff(entry.useGroupScoring)}`);
        }
    }
    if (entry.ignoreBudget) parts.push('ignore budget: yes');
    parts.push(
        `sticky: ${Number(entry.sticky) || 0}`,
        `cooldown: ${Number(entry.cooldown) || 0}`,
        `delay: ${Number(entry.delay) || 0}`,
    );
    return parts.join(' | ');
}

function skippedLine(entry) {
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    return `- not shared: ${valueText(entry.title) || `Entry ${entry.uid}`} | uid: ${entry.uid} | keys: ${keys.length ? keys.join(', ') : 'none'} | reason: ${entry.reason}`;
}

export const MAX_DETAIL_LINES = 400;
export const MAX_DETAIL_CHARS = 24_000;

/**
 * Formats the full lorebook detail that accompanies the problem checks.
 * When `traced` is true, entries whose only skip reason was 'no keyword matched'
 * are left to the activation trace section so each entry is explained once.
 * @param {{books?: object[]}} lore Lore returned by collectLore
 * @param {{traced?: boolean, maxLines?: number, maxChars?: number}} [options]
 * @returns {string} The Lorebook details section body
 */
export function formatLorebookDetails(lore, { traced = false, maxLines = MAX_DETAIL_LINES, maxChars = MAX_DETAIL_CHARS } = {}) {
    const books = Array.isArray(lore?.details?.books) ? lore.details.books : [];
    const lines = [];
    let cut = 0;
    let used = 0;
    for (const book of books) {
        const block = [];
        block.push(`### ${book.name}`);
        block.push(`Book settings: ${bookSettingsLine(book.settings)}`);
        for (const entry of book.shared ?? []) {
            if (!entry.included) continue;
            block.push(activationLine(entry));
        }
        for (const entry of book.skipped ?? []) block.push(skippedLine(entry));
        const limited = (book.shared ?? []).filter(entry => !entry.included && entry.shareReason === 'limit').length;
        for (const entry of book.shared ?? []) {
            if (entry.included || !entry.shareReason || entry.shareReason === 'limit') continue;
            if (traced && entry.shareReason === 'no keyword matched') continue;
            block.push(skippedLine({ ...entry, reason: entry.shareReason }));
        }
        if (book.hiddenCount) block.push(`- ${book.hiddenCount} ${book.hiddenCount === 1 ? 'entry is hidden from Agents and was not shared.' : 'entries are hidden from Agents and were not shared.'}`);
        if (limited) block.push(`- ${limited} more ${limited === 1 ? 'entry was' : 'entries were'} left out by the sharing size limits.`);
        for (const line of block) {
            if (lines.length >= maxLines || used + line.length > maxChars) {
                cut++;
                continue;
            }
            lines.push(line);
            used += line.length + 1;
        }
    }
    if (cut) lines.push(`- ${cut} more lines were left out by the size limits.`);
    return lines.join('\n');
}

function samplerLine(values = {}) {
    const samplers = Array.isArray(values.samplers) ? values.samplers : [];
    return samplers
        .filter(item => item && item.key !== 'seed')
        .map(item => `${item.label}: ${item.value === '' || item.value === undefined ? 'unset' : item.value}`)
        .join(' | ');
}

/**
 * Formats the read-only preset values that the checks used.
 * @param {object} preset Snapshot from readCurrentPreset
 * @returns {string} The Preset values section body
 */
export function formatPresetValues(preset) {
    const values = preset?.values || {};
    const connection = preset?.connection || {};
    const lines = [];
    const connectionText = [
        connection.sourceLabel || connection.source || 'Not selected',
        connection.model ? `Model: ${connection.model}` : '',
    ].filter(Boolean).join(' | ');
    lines.push(`Connection: ${connectionText}`);
    lines.push(`Context size: ${Number(values.contextSize) || 0} | Reply length: ${Number(values.replyLength) || 0}`);
    const samplers = samplerLine(values);
    if (samplers) lines.push(samplers);
    if (preset?.kind === 'text') {
        lines.push(`Instruct mode: ${values.instructEnabled ? 'on' : 'off'} | Instruct template: ${values.instructPreset || 'none'} | Context template: ${values.contextPreset || 'none'}`);
    } else {
        lines.push(`Continue prefill: ${values.continuePrefill ? 'on' : 'off'}`);
        const prefill = String(values.assistantPrefill ?? '').trim();
        lines.push(`Assistant Prefill: ${prefill ? (prefill.length > 500 ? `${prefill.slice(0, 500)}...` : prefill) : 'none'}`);
    }
    return lines.join('\n');
}
