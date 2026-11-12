import path from 'node:path';
import { withChatFileLocks } from '../chat-file-lock.js';
import { readJson, writeJson } from './store.js';

/** Days kept in the account-wide ledger; older days are dropped on the next write. */
export const SPEND_DAYS = 31;

function ledgerPath(directories) {
    return path.join(directories.root, 'mewmory', 'usage.json');
}

export function dayKey(now = new Date()) {
    now = new Date(now);
    const pad = value => String(value).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function count(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function readLedger(directories) {
    const ledger = readJson(ledgerPath(directories), null);
    return ledger && typeof ledger === 'object' && ledger.days && typeof ledger.days === 'object' ? ledger : { days: {} };
}

/** Adds one model call to today's total for the whole account. Cached replies cost nothing and are skipped. */
export function recordSpend(directories, usage, now = new Date()) {
    if (!usage || usage.cached || !directories?.root) return;
    const input = count(usage.input);
    const output = count(usage.output);
    try {
        const filename = ledgerPath(directories);
        withChatFileLocks([filename], () => {
            const ledger = readLedger(directories);
            const key = dayKey(now);
            const day = ledger.days[key] || { requests: 0, input: 0, output: 0 };
            ledger.days[key] = { requests: count(day.requests) + 1, input: count(day.input) + input, output: count(day.output) + output };
            const keep = Object.keys(ledger.days).sort().slice(-SPEND_DAYS);
            ledger.days = Object.fromEntries(keep.map(name => [name, ledger.days[name]]));
            writeJson(filename, ledger);
        });
    } catch (error) {
        // The model call already happened; a ledger problem must not throw its result away.
        console.warn('Mewmory could not record today\'s model use:', error.message);
    }
}

export function spendToday(directories, now = new Date()) {
    let day = null;
    if (directories?.root) try {
        day = readLedger(directories).days[dayKey(now)];
    } catch {
        day = null;
    }
    return { requests: count(day?.requests), input: count(day?.input), output: count(day?.output) };
}

/** Today's use against the daily limit. A limit of 0 means no limit. */
export function spendStatus(directories, config, now = new Date()) {
    const today = spendToday(directories, now);
    const limit = count(config?.dailyTokenLimit);
    const used = today.input + today.output;
    return { day: dayKey(now), ...today, used, limit, reached: limit > 0 && used >= limit };
}

export function overDailyLimit(directories, config, now = new Date()) {
    return spendStatus(directories, config, now).reached;
}
