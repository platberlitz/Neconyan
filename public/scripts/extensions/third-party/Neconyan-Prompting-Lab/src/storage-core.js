import { INDEX_KEY, STORE_PREFIX } from './constants.js';
import {
    migrateCase,
    migrateDraft,
    migrateLedgerEntry,
    migratePromptDraft,
    migrateRun,
    migrateSuite,
    normalizeCase,
    normalizeDraft,
    normalizeLedgerEntry,
    normalizePromptDraft,
    normalizeRun,
    normalizeSuite,
} from './schema.js';

/** Isolated transactions shared by native storage and legacy record migration. */
export function createPromptingStorage(initialStore) {
    let store = initialStore;
    let mutationQueue = Promise.resolve();
    let activeTransaction = null;

    const TRANSACTION_KEY = 'meta:transaction';
    const TRANSACTION_VERSION = 1;
    const recoveries = new WeakMap();

    function getStore() {
        if (!store) {
            throw new Error('Prompting Lab storage is unavailable.');
        }
        return store;
    }

    function __setStoreForTests(value) {
        store = value;
        if (value && typeof value === 'object') {
            recoveries.delete(value);
        }
    }

    function enqueueMutation(work, { recover = true } = {}) {
        const result = mutationQueue.then(async () => {
            const target = getStore();
            if (recover) {
                await recoverBeforeAccess(target);
            }
            return work(target);
        });
        mutationQueue = result.catch(() => {});
        return result;
    }

    /** In-memory stand-in with the small slice of the localforage API used here. */
    function createMemoryStore(initial = {}) {
        const data = new Map(Object.entries(initial));
        return {
            async getItem(key) {
                return data.has(key) ? structuredClone(data.get(key)) : null;
            },
            async setItem(key, value) {
                data.set(key, structuredClone(value));
                return value;
            },
            async removeItem(key) {
                data.delete(key);
            },
            async clear() {
                data.clear();
            },
            async keys() {
                return [...data.keys()];
            },
            get size() {
                return data.size;
            },
        };
    }

    async function readIndex(key, target = getStore()) {
        const value = await target.getItem(key);
        return Array.isArray(value) ? value : [];
    }

    async function writeIndex(key, value, target = getStore()) {
        await target.setItem(key, value);
    }

    async function addToIndex(key, id, target = getStore()) {
        const index = await readIndex(key, target);
        if (!index.includes(id)) {
            index.push(id);
            await writeIndex(key, index, target);
        }
    }

    async function removeFromIndex(key, id, target = getStore()) {
        const index = await readIndex(key, target);
        const next = index.filter(item => item !== id);
        if (next.length !== index.length) {
            await writeIndex(key, next, target);
        }
    }

    function transactionEntries(journal) {
        if (journal?.v !== TRANSACTION_VERSION || !Array.isArray(journal.entries)) {
            throw new Error('Prompting Lab found an unreadable storage recovery journal.');
        }
        const seen = new Set();
        for (const entry of journal.entries) {
            if (!entry || typeof entry.key !== 'string' || entry.key === TRANSACTION_KEY || seen.has(entry.key)) {
                throw new Error('Prompting Lab found an unreadable storage recovery journal.');
            }
            seen.add(entry.key);
        }
        return journal.entries;
    }

    async function restoreJournal(journal, target) {
        let failure = null;
        for (const { key, value } of [...transactionEntries(journal)].reverse()) {
            try {
                if (value === null) {
                    await target.removeItem(key);
                } else {
                    await target.setItem(key, value);
                }
            } catch (error) {
                failure ??= error;
            }
        }
        if (failure) {
            throw failure;
        }
        await target.removeItem(TRANSACTION_KEY);
    }

    async function recoverJournal(target) {
        const journal = await target.getItem(TRANSACTION_KEY);
        if (journal !== null) {
            await restoreJournal(journal, target);
        }
    }

    function recoverBeforeAccess(target) {
        let recovery = recoveries.get(target);
        if (!recovery) {
            recovery = recoverJournal(target).catch((error) => {
                recoveries.delete(target);
                throw error;
            });
            recoveries.set(target, recovery);
        }
        return recovery;
    }

    async function readyStore() {
        const target = getStore();
        await recoverBeforeAccess(target);
        return target;
    }

    // localForage has no cross-key transaction API. Persist the undo snapshot
    // first so a later load can finish rollback after an interrupted mutation.
    async function withRollback(keys, work, target = getStore()) {
        const uniqueKeys = [...new Set(keys)].filter(key => key !== TRANSACTION_KEY);
        if (activeTransaction) {
            if (activeTransaction.target !== target
            || uniqueKeys.some(key => !activeTransaction.before.has(key))) {
                throw new Error('A nested storage mutation touched undeclared keys.');
            }
            const before = new Map();
            for (const key of uniqueKeys) {
                before.set(key, await target.getItem(key));
            }
            return work(target, before);
        }

        const before = new Map();
        for (const key of uniqueKeys) {
            before.set(key, await target.getItem(key));
        }
        const journal = {
            v: TRANSACTION_VERSION,
            entries: [...before].map(([key, value]) => ({ key, value })),
        };
        await target.setItem(TRANSACTION_KEY, journal);
        const transaction = { target, before };
        activeTransaction = transaction;
        try {
            const result = await work(target, before);
            await target.removeItem(TRANSACTION_KEY);
            return result;
        } catch (error) {
            try {
                await restoreJournal(journal, target);
            } catch {
            // Keep the journal for the next read or mutation to retry.
            }
            recoveries.delete(target);
            throw error;
        } finally {
            if (activeTransaction === transaction) {
                activeTransaction = null;
            }
        }
    }

    async function saveIndexedUnlocked(prefix, indexKey, value, normalize, target = getStore()) {
        const normalized = normalize(value);
        const recordKey = `${prefix}${normalized.id}`;
        await withRollback([recordKey, indexKey], async () => {
            await target.setItem(recordKey, normalized);
            await addToIndex(indexKey, normalized.id, target);
        }, target);
        return normalized;
    }

    async function deleteIndexedUnlocked(prefix, indexKey, id, target = getStore()) {
        const recordKey = `${prefix}${id}`;
        await withRollback([recordKey, indexKey], async () => {
            await target.removeItem(recordKey);
            await removeFromIndex(indexKey, id, target);
        }, target);
    }

    /* -------------------------------------------------------- preset drafts */

    async function saveDraftUnlocked(draft, target = getStore()) {
        return saveIndexedUnlocked(
            STORE_PREFIX.DRAFT,
            INDEX_KEY.DRAFTS,
            { ...draft, updatedAt: new Date().toISOString() },
            normalizeDraft,
            target,
        );
    }

    function saveDraft(draft) {
        return enqueueMutation(target => saveDraftUnlocked(draft, target));
    }

    async function getDraft(id) {
        const target = await readyStore();
        const value = await target.getItem(`${STORE_PREFIX.DRAFT}${id}`);
        return value ? migrateDraft(value) : null;
    }

    async function listDrafts() {
        const target = await readyStore();
        const ids = await readIndex(INDEX_KEY.DRAFTS, target);
        const drafts = await Promise.all(ids.map(async (id) => {
            const value = await target.getItem(`${STORE_PREFIX.DRAFT}${id}`);
            return value ? migrateDraft(value) : null;
        }));
        return drafts.filter(Boolean);
    }

    function deleteDraft(id) {
        return enqueueMutation(target => deleteIndexedUnlocked(STORE_PREFIX.DRAFT, INDEX_KEY.DRAFTS, id, target));
    }

    /* -------------------------------------------------------- prompt drafts */

    async function savePromptDraftUnlocked(draft, target = getStore()) {
        return saveIndexedUnlocked(
            STORE_PREFIX.PROMPT,
            INDEX_KEY.PROMPTS,
            { ...draft, updatedAt: new Date().toISOString() },
            normalizePromptDraft,
            target,
        );
    }

    function savePromptDraft(draft) {
        return enqueueMutation(target => savePromptDraftUnlocked(draft, target));
    }

    async function getPromptDraft(id) {
        const target = await readyStore();
        const value = await target.getItem(`${STORE_PREFIX.PROMPT}${id}`);
        return value ? migratePromptDraft(value) : null;
    }

    async function listPromptDrafts() {
        const target = await readyStore();
        const ids = await readIndex(INDEX_KEY.PROMPTS, target);
        const drafts = await Promise.all(ids.map(async (id) => {
            const value = await target.getItem(`${STORE_PREFIX.PROMPT}${id}`);
            return value ? migratePromptDraft(value) : null;
        }));
        return drafts.filter(Boolean);
    }

    function deletePromptDraft(id) {
        return enqueueMutation(target => deleteIndexedUnlocked(STORE_PREFIX.PROMPT, INDEX_KEY.PROMPTS, id, target));
    }

    /* -------------------------------------------------------------- ledger */

    function saveLedgerEntry(entry) {
        return enqueueMutation(target => saveIndexedUnlocked(
            STORE_PREFIX.LEDGER,
            INDEX_KEY.LEDGER,
            entry,
            normalizeLedgerEntry,
            target,
        ));
    }

    /** Newest first: the index appends in arrival order. */
    async function listLedger() {
        const target = await readyStore();
        const ids = await readIndex(INDEX_KEY.LEDGER, target);
        const entries = await Promise.all(ids.map(async (id) => {
            const value = await target.getItem(`${STORE_PREFIX.LEDGER}${id}`);
            return value ? migrateLedgerEntry(value) : null;
        }));
        return entries.filter(Boolean).reverse();
    }

    async function countLedger() {
        const target = await readyStore();
        return (await readIndex(INDEX_KEY.LEDGER, target)).length;
    }

    /** Keeps the newest `retention` recorded prompts, by arrival order. */
    async function pruneLedgerUnlocked(retention, target = getStore()) {
        const ids = await readIndex(INDEX_KEY.LEDGER, target);
        const excess = ids.slice(0, Math.max(0, ids.length - Math.max(0, retention)));
        if (!excess.length) {
            return 0;
        }
        await withRollback([INDEX_KEY.LEDGER, ...excess.map(id => `${STORE_PREFIX.LEDGER}${id}`)], async () => {
            for (const id of excess) {
                await target.removeItem(`${STORE_PREFIX.LEDGER}${id}`);
            }
            await writeIndex(INDEX_KEY.LEDGER, ids.slice(excess.length), target);
        }, target);
        return excess.length;
    }

    function pruneLedger(retention) {
        return enqueueMutation(target => pruneLedgerUnlocked(retention, target));
    }

    function clearLedger() {
        return enqueueMutation(target => pruneLedgerUnlocked(0, target));
    }

    /* ---------------------------------------------------------- test cases */

    async function saveCaseUnlocked(testCase, target = getStore()) {
        return saveIndexedUnlocked(STORE_PREFIX.CASE, INDEX_KEY.CASES, testCase, normalizeCase, target);
    }

    function saveCase(testCase) {
        return enqueueMutation(target => saveCaseUnlocked(testCase, target));
    }

    async function getCase(id) {
        const target = await readyStore();
        const value = await target.getItem(`${STORE_PREFIX.CASE}${id}`);
        return value ? migrateCase(value) : null;
    }

    async function listCases() {
        const target = await readyStore();
        const ids = await readIndex(INDEX_KEY.CASES, target);
        const cases = await Promise.all(ids.map(async (id) => {
            const value = await target.getItem(`${STORE_PREFIX.CASE}${id}`);
            return value ? migrateCase(value) : null;
        }));
        return cases.filter(Boolean);
    }

    async function hydrateRunIndex(caseId, target = getStore()) {
        const index = await readIndex(`${INDEX_KEY.RUNS}${caseId}`, target);
        return Promise.all(index.map(async (entry) => {
            const id = typeof entry?.id === 'string' ? entry.id : '';
            const value = id ? await target.getItem(`${STORE_PREFIX.RUN}${id}`) : null;
            return { entry, value, run: value ? migrateRun(value) : null };
        }));
    }

    async function deleteCaseUnlocked(id, target = getStore()) {
        const caseKey = `${STORE_PREFIX.CASE}${id}`;
        const runIndexKey = `${INDEX_KEY.RUNS}${id}`;
        const indexedRuns = await hydrateRunIndex(id, target);
        const runIds = [...new Set(indexedRuns
            .filter(({ entry, run }) => run?.id === entry?.id && run.caseId === id)
            .map(({ entry }) => entry.id))];
        const protectedRunEntries = indexedRuns
            .filter(({ entry, value }) => value !== null && !runIds.includes(entry?.id))
            .map(({ entry }) => entry);
        const suites = [];
        for (const suiteId of await readIndex(INDEX_KEY.SUITES, target)) {
            const value = await target.getItem(`${STORE_PREFIX.SUITE}${suiteId}`);
            const suite = value ? migrateSuite(value) : null;
            if (suite) {
                suites.push(suite);
            }
        }
        const changedSuites = [];
        for (const suite of suites) {
            const baselines = { ...(suite.baselines ?? {}) };
            const hadBaseline = Object.prototype.hasOwnProperty.call(baselines, id);
            delete baselines[id];
            const caseIds = (suite.caseIds ?? []).filter(caseId => caseId !== id);
            if (hadBaseline || caseIds.length !== (suite.caseIds ?? []).length) {
                changedSuites.push(normalizeSuite({ ...suite, caseIds, baselines }));
            }
        }
        const keys = [
            caseKey,
            INDEX_KEY.CASES,
            runIndexKey,
            ...runIds.map(runId => `${STORE_PREFIX.RUN}${runId}`),
            ...changedSuites.map(suite => `${STORE_PREFIX.SUITE}${suite.id}`),
        ];
        await withRollback(keys, async (_store, before) => {
            await target.removeItem(caseKey);
            const caseIndex = Array.isArray(before.get(INDEX_KEY.CASES)) ? before.get(INDEX_KEY.CASES) : [];
            if (caseIndex.includes(id)) {
                await target.setItem(INDEX_KEY.CASES, caseIndex.filter(caseId => caseId !== id));
            }
            for (const runId of runIds) {
                await target.removeItem(`${STORE_PREFIX.RUN}${runId}`);
            }
            if (protectedRunEntries.length) {
                await target.setItem(runIndexKey, protectedRunEntries);
            } else {
                await target.removeItem(runIndexKey);
            }
            for (const suite of changedSuites) {
                await target.setItem(`${STORE_PREFIX.SUITE}${suite.id}`, suite);
            }
        }, target);
    }

    function deleteCase(id) {
        return enqueueMutation(target => deleteCaseUnlocked(id, target));
    }

    /* -------------------------------------------------------------- suites */

    async function saveSuiteUnlocked(suite, target = getStore()) {
        return saveIndexedUnlocked(STORE_PREFIX.SUITE, INDEX_KEY.SUITES, suite, normalizeSuite, target);
    }

    function saveSuite(suite) {
        return enqueueMutation(target => saveSuiteUnlocked(suite, target));
    }

    async function getSuite(id) {
        const target = await readyStore();
        const value = await target.getItem(`${STORE_PREFIX.SUITE}${id}`);
        return value ? migrateSuite(value) : null;
    }

    async function listSuites() {
        const target = await readyStore();
        const ids = await readIndex(INDEX_KEY.SUITES, target);
        const suites = await Promise.all(ids.map(async (id) => {
            const value = await target.getItem(`${STORE_PREFIX.SUITE}${id}`);
            return value ? migrateSuite(value) : null;
        }));
        return suites.filter(Boolean);
    }

    function deleteSuite(id) {
        return enqueueMutation(target => deleteIndexedUnlocked(STORE_PREFIX.SUITE, INDEX_KEY.SUITES, id, target));
    }

    /** Reads and writes a suite inside the mutation queue, preventing stale updates. */
    function updateSuite(id, updater) {
        return enqueueMutation(async (target) => {
            if (typeof updater !== 'function') {
                throw new TypeError('A suite updater function is required.');
            }
            const value = await target.getItem(`${STORE_PREFIX.SUITE}${id}`);
            const current = value ? migrateSuite(value) : null;
            if (!current) {
                throw new Error(`Suite "${id}" was not found.`);
            }
            const draft = structuredClone(current);
            const result = await updater(draft);
            const next = result === undefined ? draft : result;
            if (!next || typeof next !== 'object' || Array.isArray(next)) {
                throw new TypeError('A suite updater must return a suite object.');
            }
            return saveSuiteUnlocked({ ...next, id }, target);
        });
    }

    /* ---------------------------------------------------------------- runs */

    async function saveRunUnlocked(run, target = getStore()) {
        const normalized = normalizeRun(run);
        const recordKey = `${STORE_PREFIX.RUN}${normalized.id}`;
        const previous = await target.getItem(recordKey);
        const key = `${INDEX_KEY.RUNS}${normalized.caseId}`;
        const previousKey = typeof previous?.caseId === 'string'
            ? `${INDEX_KEY.RUNS}${previous.caseId}`
            : null;
        await withRollback([recordKey, key, ...(previousKey ? [previousKey] : [])], async (_store, before) => {
            await target.setItem(recordKey, normalized);
            if (previousKey && previousKey !== key) {
                const oldIndex = Array.isArray(before.get(previousKey)) ? before.get(previousKey) : [];
                await writeIndex(previousKey, oldIndex.filter(entry => entry?.id !== normalized.id), target);
            }
            const index = Array.isArray(before.get(key)) ? before.get(key) : [];
            const without = index.filter(entry => entry?.id !== normalized.id);
            without.push({
                id: normalized.id,
                startedAt: normalized.startedAt,
                status: normalized.status,
                suiteRunId: normalized.suiteRunId,
                variantLabel: normalized.variantLabel,
            });
            await writeIndex(key, without, target);
        }, target);
        return normalized;
    }

    function saveRun(run) {
        return enqueueMutation(target => saveRunUnlocked(run, target));
    }

    async function getRun(id) {
        const target = await readyStore();
        const value = await target.getItem(`${STORE_PREFIX.RUN}${id}`);
        return value ? migrateRun(value) : null;
    }

    /** Newest first. */
    async function listRuns(caseId) {
        const target = await readyStore();
        const indexedRuns = await hydrateRunIndex(caseId, target);
        const runs = indexedRuns.map(({ entry, run }) => {
            return run ? {
                ...entry,
                id: run.id,
                status: run.status,
                startedAt: run.startedAt,
                suiteRunId: run.suiteRunId,
                variantLabel: run.variantLabel,
            } : null;
        });
        return runs
            .filter(Boolean)
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    }

    async function getLatestRun(caseId) {
        const [newest] = await listRuns(caseId);
        return newest ? getRun(newest.id) : null;
    }

    async function deleteRunUnlocked(caseId, runId, target = getStore()) {
        const recordKey = `${STORE_PREFIX.RUN}${runId}`;
        const previous = await target.getItem(recordKey);
        if (previous && !migrateRun(previous)) {
            return;
        }
        const caseIds = new Set([caseId, previous?.caseId].filter(value => typeof value === 'string'));
        const indexKeys = [...caseIds].map(id => `${INDEX_KEY.RUNS}${id}`);
        await withRollback([recordKey, ...indexKeys], async (_store, before) => {
            await target.removeItem(recordKey);
            for (const key of indexKeys) {
                const index = Array.isArray(before.get(key)) ? before.get(key) : [];
                await writeIndex(key, index.filter(entry => entry?.id !== runId), target);
            }
        }, target);
    }

    function deleteRun(caseId, runId) {
        return enqueueMutation(target => deleteRunUnlocked(caseId, runId, target));
    }

    /**
 * Keeps the newest `retention` runs for a case. Runs listed in `pinned` are
 * always kept and do not count against the limit, so promoting a baseline can
 * never lose the run it points at.
 */
    async function pruneRunsUnlocked(caseId, retention, pinned = [], target = getStore()) {
        const keep = new Set(pinned.filter(Boolean));
        const key = `${INDEX_KEY.RUNS}${caseId}`;
        const indexedRuns = await hydrateRunIndex(caseId, target);
        const index = indexedRuns.map(({ entry }) => entry);
        const prunable = indexedRuns
            .filter(({ entry, run }) => run?.id === entry?.id
            && run.caseId === caseId
            && !keep.has(entry.id))
            .sort((a, b) => String(b.run.startedAt).localeCompare(String(a.run.startedAt)));
        const excess = prunable.slice(Math.max(0, retention));
        if (!excess.length) {
            return 0;
        }
        const runIds = new Set(excess.map(({ entry }) => entry.id));
        await withRollback([key, ...[...runIds].map(id => `${STORE_PREFIX.RUN}${id}`)], async () => {
            for (const id of runIds) {
                await target.removeItem(`${STORE_PREFIX.RUN}${id}`);
            }
            await writeIndex(key, index.filter(entry => !runIds.has(entry?.id)), target);
        }, target);
        return runIds.size;
    }

    function pruneRuns(caseId, retention, pinned = []) {
        return enqueueMutation(target => pruneRunsUnlocked(caseId, retention, pinned, target));
    }

    /** Saves one parsed import as a unit and restores every touched key on failure. */
    function saveImportBatch({ suite, cases = [], baselineRuns = [], presets = [] } = {}) {
        return enqueueMutation(async (target) => {
            if (!suite || !Array.isArray(cases) || !Array.isArray(baselineRuns) || !Array.isArray(presets)) {
                throw new TypeError('A suite import requires a suite and arrays of cases, runs, and presets.');
            }
            const prepared = {
                suite: normalizeSuite(suite),
                cases: cases.map(normalizeCase),
                baselineRuns: baselineRuns.map(normalizeRun),
                presets: presets.map(normalizeDraft),
            };
            const keys = [
                INDEX_KEY.SUITES,
                INDEX_KEY.CASES,
                INDEX_KEY.DRAFTS,
                `${STORE_PREFIX.SUITE}${prepared.suite.id}`,
                ...prepared.cases.map(item => `${STORE_PREFIX.CASE}${item.id}`),
                ...prepared.baselineRuns.flatMap(item => [
                    `${STORE_PREFIX.RUN}${item.id}`,
                    `${INDEX_KEY.RUNS}${item.caseId}`,
                ]),
                ...prepared.presets.map(item => `${STORE_PREFIX.DRAFT}${item.id}`),
            ];
            for (const run of prepared.baselineRuns) {
                const previous = await target.getItem(`${STORE_PREFIX.RUN}${run.id}`);
                if (typeof previous?.caseId === 'string') {
                    keys.push(`${INDEX_KEY.RUNS}${previous.caseId}`);
                }
            }
            return withRollback(keys, async () => {
                const savedCases = [];
                const savedRuns = [];
                const savedPresets = [];
                for (const testCase of prepared.cases) {
                    savedCases.push(await saveCaseUnlocked(testCase, target));
                }
                for (const run of prepared.baselineRuns) {
                    savedRuns.push(await saveRunUnlocked(run, target));
                }
                for (const draft of prepared.presets) {
                    savedPresets.push(await saveDraftUnlocked(draft, target));
                }
                return {
                    suite: await saveSuiteUnlocked(prepared.suite, target),
                    cases: savedCases,
                    baselineRuns: savedRuns,
                    presets: savedPresets,
                };
            }, target);
        });
    }

    /** Removes every object this extension owns. Used by the manifest clean hook. */
    async function clearAllUnlocked(target = getStore()) {
        if (typeof target.clear !== 'function') {
            throw new Error('Prompting Lab storage cannot clear its records.');
        }
        await target.clear();
        recoveries.delete(target);
    }

    function clearAll() {
        return enqueueMutation(clearAllUnlocked, { recover: false });
    }

    return { __setStoreForTests, createMemoryStore, saveDraft, getDraft, listDrafts, deleteDraft,
        savePromptDraft, getPromptDraft, listPromptDrafts, deletePromptDraft, saveLedgerEntry, listLedger, countLedger,
        pruneLedger, clearLedger, saveCase, getCase, listCases, deleteCase, saveSuite, getSuite, listSuites, deleteSuite,
        updateSuite, saveRun, getRun, listRuns, getLatestRun, deleteRun, pruneRuns, saveImportBatch, clearAll };
}
