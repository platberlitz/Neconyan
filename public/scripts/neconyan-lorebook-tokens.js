import { lorebookEntryTitle } from './neconyan-lorebook-tools-core.js';

export const TOKEN_NEAR_BUDGET = 0.85;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Rough token count: one per CJK character, one per four other characters.
 * @param {unknown} text Text to measure
 * @returns {number}
 */
export function estimateTokens(text) {
    const value = String(text ?? '');
    if (!value) return 0;
    const cjk = value.match(CJK)?.length ?? 0;
    return Math.ceil(cjk + ([...value].length - cjk) / 4);
}

/**
 * Short token count such as 950, 1.2k or 24k.
 * @param {number} count Token count
 * @returns {string}
 */
export function formatTokenCount(count) {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${Math.round(count / 1000)}k`;
}

/**
 * The World Info budget used during generation: a share of the prompt size, limited by the optional cap.
 * @param {{percent: number, maxPromptTokens: number, cap?: number}} settings World Info budget settings
 * @returns {number|null}
 */
export function worldInfoTokenBudget({ percent, maxPromptTokens, cap = 0 }) {
    if (!Number.isFinite(percent) || !Number.isFinite(maxPromptTokens) || maxPromptTokens <= 0) return null;
    const budget = Math.round(percent * maxPromptTokens / 100) || 1;
    return cap > 0 && budget > cap ? cap : budget;
}

/**
 * Tokens the always-active (constant, enabled) entries take up, largest first.
 * @param {object} book Native lorebook
 * @param {{count?: (text: string) => number|Promise<number>, budget?: number|null}} options Token counter and budget
 * @returns {Promise<{items: {uid: string, title: string, tokens: number}[], total: number, budget: number|null, usage: number|null, nearBudget: boolean, overBudget: boolean}>}
 */
export async function measureTokenFootprint(book, { count = estimateTokens, budget = null } = {}) {
    const entries = Object.values(book?.entries ?? {}).filter(entry => entry && entry.constant && !entry.disable);
    const items = await Promise.all(entries.map(async entry => ({
        uid: String(entry.uid),
        title: lorebookEntryTitle(entry),
        tokens: Number(await count(String(entry.content ?? ''))) || 0,
    })));
    items.sort((a, b) => b.tokens - a.tokens);
    const total = items.reduce((sum, item) => sum + item.tokens, 0);
    const usage = budget ? total / budget : null;
    return {
        items,
        total,
        budget: budget || null,
        usage,
        nearBudget: usage !== null && usage >= TOKEN_NEAR_BUDGET && total <= budget,
        overBudget: usage !== null && total > budget,
    };
}

/**
 * Hover text for the token meter.
 * @param {{items: object[], total: number, budget: number|null, usage: number|null, overBudget: boolean}} footprint Result from measureTokenFootprint
 * @returns {string}
 */
export function tokenFootprintTitle({ items, total, budget, usage, overBudget }) {
    const entries = `${items.length} always-active entr${items.length === 1 ? 'y' : 'ies'}`;
    const share = budget ? ` of the ${formatTokenCount(budget)} World Info budget (${Math.round(usage * 100)}%)` : '';
    return `Always active: ~${formatTokenCount(total)} tokens across ${entries}${share}${overBudget ? ' - over budget!' : '.'} Click to inspect.`;
}
