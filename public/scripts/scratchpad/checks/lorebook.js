/**
 * Fixed checks for a lorebook. Reuses the app's Health, key test and token
 * helpers, which are dependency-free, and adds rules specific to shared books.
 */
import { checkLorebookHealth } from '../../neconyan-lorebook-health.js';
import { canTestEntryKeys, testEntryKeys } from '../../neconyan-lorebook-keytest.js';
import { formatTokenCount, measureTokenFootprint, worldInfoTokenBudget } from '../../neconyan-lorebook-tokens.js';

function entryList(book) {
    return Object.entries(book?.entries ?? {})
        .filter(([, entry]) => entry && typeof entry === 'object' && !entry.agentBlacklisted)
        .map(([uid, entry]) => ({ ...entry, uid: entry.uid ?? uid }));
}

function entryTitle(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    return String(entry?.comment || keys[0] || `Entry ${entry?.uid}`);
}

function target(name, entry) {
    return { kind: 'lorebook', name, ...(entry ? { uid: String(entry.uid), title: entryTitle(entry) } : {}) };
}

function finding(name, entry, rule, severity, message, details) {
    return { rule, severity, target: target(name, entry), message, ...(details ? { details } : {}) };
}

/**
 * Checks one loaded lorebook.
 * @param {{name: string, book?: object, scanText?: string, contextSize?: number, scanDepth?: number, budget?: {percent?: number, cap?: number}, defaults?: {caseSensitive?: boolean, matchWholeWords?: boolean}}} options Check context
 * @returns {Promise<{findings: object[], name: string, budget: number|null}>}
 */
export async function checkLorebook({ name, book, scanText = '', contextSize = 0, scanDepth = null, budget: budgetSettings = {}, defaults = {} }) {
    const bookName = String(name || 'Lorebook');
    const findings = [];
    const push = (entry, rule, severity, message, details) => findings.push(finding(bookName, entry, rule, severity, message, details));
    const entries = entryList(book);
    if (!book || !entries.length) {
        push(null, 'lorebook-unavailable', 'warning', 'The lorebook has no entries, or it could not be read.');
        return { kind: 'lorebook', findings, name: bookName, budget: null };
    }

    const health = checkLorebookHealth(book, { defaults, includeGraphRules: entries.length <= 1500 });
    for (const diagnostic of health.diagnostics) {
        const first = entries.find(entry => String(entry.uid) === String(diagnostic.entryIds?.[0]));
        push(first ?? null, diagnostic.rule, diagnostic.severity, diagnostic.message, diagnostic.details);
    }

    for (const entry of entries) {
        if (entry.disable) continue;
        if (Number(entry.probability) === 0 && !entry.constant) {
            push(entry, 'lorebook-probability-zero', 'warning', `Entry "${entryTitle(entry)}" has probability 0, so it never activates.`);
        }
        const ownScanDepth = entry.scanDepth === undefined || entry.scanDepth === null || entry.scanDepth === '' ? scanDepth : Number(entry.scanDepth);
        if (!entry.constant && Number(ownScanDepth) === 0 && Array.isArray(entry.key) && entry.key.length) {
            push(entry, 'lorebook-scan-depth-zero', 'warning', `Entry "${entryTitle(entry)}" scans 0 messages, so its keywords can never match.`);
        }
    }

    const budget = worldInfoTokenBudget({
        percent: Number(budgetSettings.percent ?? 0),
        maxPromptTokens: Number(contextSize) || 0,
        cap: Number(budgetSettings.cap ?? 0),
    });
    const footprint = await measureTokenFootprint({ entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) }, { budget });
    if (footprint.overBudget) {
        push(null, 'lorebook-constant-over-budget', 'error', `Always-on entries use ${formatTokenCount(footprint.total)} of the ${formatTokenCount(budget)} token lore budget.`);
    }

    if (scanText) {
        let unmatched = 0;
        for (const entry of entries) {
            if (entry.disable || entry.constant || !canTestEntryKeys(entry)) continue;
            const result = testEntryKeys(entry, scanText, defaults);
            if (result.verdict.reason === 'no-key-matched' || result.verdict.reason === 'secondary-logic-denied') unmatched++;
        }
        // One summary line only: the lorebook detail already lists each unmatched entry by name.
        if (unmatched) push(null, 'lorebook-did-not-match', 'info', `${unmatched} ${unmatched === 1 ? 'entry did' : 'entries did'} not match the recent text.`);
    }

    return { kind: 'lorebook', findings, name: bookName, budget };
}
