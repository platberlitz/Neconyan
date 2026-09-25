import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { readJson } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked } from './roleplay-source.js';

const invalid = message => { throw roleplayError('ROLEPLAY_WORKFLOW_INVALID', message, 409); };
const MAX_ATTEMPTS = 16;
const filterWorker = new URL('./roleplay-workflow-filter-worker.cjs', import.meta.url);

function preflightSwipePattern(terms, threshold) {
    const shared = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(shared);
    let worker;
    try {
        worker = new Worker(filterWorker, { workerData: { mode: 'probe', terms, threshold, shared } });
        worker.on('error', () => {
            Atomics.store(state, 1, -1);
            Atomics.store(state, 0, 1);
            Atomics.notify(state, 0);
        });
        const ready = Atomics.wait(state, 0, 0, 750);
        if (!['ok', 'not-equal'].includes(ready) || Atomics.load(state, 1) !== 1) {
            invalid('The saved automatic swipe pattern cannot run safely.');
        }
    } catch {
        invalid('The saved automatic swipe pattern cannot run safely.');
    } finally {
        worker?.terminate();
    }
}

function boundedSwipePattern(terms, threshold, text) {
    return new Promise((resolve, reject) => {
        let worker;
        let settled = false;
        let timer;
        const done = (value, error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker?.terminate();
            if (error) reject(roleplayError('ROLEPLAY_WORKFLOW_INVALID', 'The saved automatic swipe pattern exceeded its safe deadline.', 409));
            else resolve(value);
        };
        try { worker = new Worker(filterWorker, { workerData: { mode: 'match', terms, threshold, text } }); } catch {
            done(false, true);
            return;
        }
        timer = setTimeout(() => done(false, true), 1500);
        worker.once('message', result => result?.error ? done(false, true) : done(result?.filtered === true, false));
        worker.once('error', () => done(false, true));
        worker.once('exit', code => { if (code !== 0) done(false, true); });
    });
}

/** Freeze browser-compatible automatic decisions under the accepted account and source. */
export function captureRoleplayWorkflowPolicy(base, account, source, worldInfo, { backend = 'chat' } = {}) {
    return withRoleplayAccount(base, account, lease => {
        assertRoleplaySourceLocked(lease, source);
        const settings = readJson(path.join(base.directories.root, 'settings.json'), {});
        if (roleplayHash(settings) !== worldInfo.settingsHash) invalid('The saved automatic reply settings changed before admission.');
        const power = settings.power_user ?? {};
        const swipe = power.auto_swipe === true;
        const continuation = power.auto_continue?.enabled === true
            && (backend !== 'chat' || power.auto_continue?.allow_chat_completions === true);
        if (!swipe && !continuation) return null;
        const terms = swipe ? power.auto_swipe_blacklist ?? [] : [];
        const minimumLength = swipe ? Number(power.auto_swipe_minimum_length ?? 0) : 0;
        const threshold = swipe ? Number(power.auto_swipe_blacklist_threshold ?? 2) : 0;
        const targetTokens = continuation ? Number(power.auto_continue.target_length ?? 0) : 0;
        if (!Array.isArray(terms) || terms.length > 128 || terms.some(item => typeof item !== 'string' || item.length > 128)
            || !Number.isSafeInteger(minimumLength) || minimumLength < 0 || minimumLength > 256 * 1024
            || !Number.isSafeInteger(threshold) || threshold < 0 || threshold > 256 * 1024
            || !Number.isSafeInteger(targetTokens) || targetTokens < 0 || targetTokens > 200000) {
            invalid('The saved automatic reply controls need a bounded server selection.');
        }
        let pattern = null;
        if (terms.length && threshold) {
            try { pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'gi'); } catch {
                invalid('The saved automatic swipe pattern is invalid.');
            }
            if (!pattern || pattern.source.length > 16384) invalid('The saved automatic swipe pattern is too long.');
            preflightSwipePattern(terms, threshold);
        }
        const value = { version: 1, settingsHash: worldInfo.settingsHash, maxAttempts: MAX_ATTEMPTS,
            swipe: { enabled: swipe, minimumLength, terms, threshold },
            continuation: { enabled: continuation && targetTokens > 0, targetTokens } };
        return { ...value, hash: roleplayHash(value) };
    });
}

async function isFiltered(text, swipe) {
    if (!swipe.enabled || !text.trim()) return false;
    if (swipe.minimumLength && text.trim().length < swipe.minimumLength) return true;
    if (!swipe.terms.length || !swipe.threshold) return false;
    return boundedSwipePattern(swipe.terms, swipe.threshold, text.trim());
}

/** This decision is saved before admitting another paid candidate turn. */
export async function decideRoleplayWorkflowCandidate(policy, output, { tokenizer = 'o200k_base', fullText = '' } = {}) {
    if (!policy) return { kind: 'final' };
    const { hash, ...value } = policy;
    if (hash !== roleplayHash(value) || value.version !== 1 || value.maxAttempts !== MAX_ATTEMPTS) {
        invalid('The saved automatic reply policy changed.');
    }
    const text = output?.message?.mes ?? output?.messages?.[0]?.mes ?? output?.continuedText ?? output?.text;
    if (typeof text !== 'string' || text.length > 256 * 1024) invalid('An automatic reply needs saved model text.');
    if (await isFiltered(text, value.swipe)) return { kind: 'swipe', textHash: roleplayHash(text) };
    if (value.continuation.enabled && text.trim().length > 5) {
        const { count } = await getCounter(tokenizer);
        if (await count(fullText || text) < value.continuation.targetTokens) return { kind: 'continue', textHash: roleplayHash(text) };
    }
    return { kind: 'final', textHash: roleplayHash(text) };
}
