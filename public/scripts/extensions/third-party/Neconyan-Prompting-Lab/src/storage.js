import { LEGACY_DB_NAME } from './constants.js';
import { createPromptingStorage } from './storage-core.js';
import { getLabClient } from '../../../../labs-client.js';

let injected = null;
let queue = Promise.resolve();
const migrated = new Map();
export const createMemoryStore = initial => createPromptingStorage(null).createMemoryStore(initial);
export function __setStoreForTests(value) { injected = value ? createPromptingStorage(value) : null; }

async function ready() {
    const client = await getLabClient();
    const { getCurrentUserHandle } = await import('../../../../user.js');
    const owner = getCurrentUserHandle();
    if (!migrated.has(owner)) {
        const migration = (async () => {
            const legacy = globalThis.localforage?.createInstance?.({ name: LEGACY_DB_NAME });
            if (!legacy) throw new Error('The browser record store is not ready. Its records have been retained.');
            const ownershipKey = 'prompting-legacy-owner';
            const claimed = localStorage.getItem(ownershipKey);
            if (claimed && claimed !== owner) return;
            if (!claimed) localStorage.setItem(ownershipKey, owner);
            const core = createPromptingStorage(legacy);
            await core.listSuites();
            const entries = await Promise.all((await legacy.keys()).map(async key => [key, await legacy.getItem(key)]));
            if (!entries.length) return;
            const marker = `prompting-server-import:${owner}`;
            if (localStorage.getItem(marker) === 'complete') return;
            if (localStorage.getItem(ownershipKey) !== owner || getCurrentUserHandle() !== owner) {
                throw new Error('The account changed while reading the retained browser records.');
            }
            await client.run('prompting.storage', { method: 'importLegacy', args: [entries] }, { scope: 'prompting:importLegacy' });
            localStorage.setItem(marker, 'complete');
        })();
        migrated.set(owner, migration);
        migration.catch(() => migrated.delete(owner));
    }
    await migrated.get(owner);
    return client;
}

function read(method, args) {
    if (injected) return injected[method](...args);
    return queue.then(async () => {
        const client = await ready();
        const result = await client.request('/api/labs/prompting/read', { method: 'POST', body: JSON.stringify({ method, args }) });
        return result.value;
    });
}

function write(method, args) {
    if (injected) return injected[method](...args);
    const operation = queue.then(async () => {
        const client = await ready();
        const record = await client.run('prompting.storage', { method, args }, { scope: `prompting:storage:${method}` });
        return record.result;
    });
    queue = operation.catch(() => {});
    return operation;
}

export const getDraft = (...args) => read('getDraft', args);
export const listDrafts = (...args) => read('listDrafts', args);
export const getPromptDraft = (...args) => read('getPromptDraft', args);
export const listPromptDrafts = (...args) => read('listPromptDrafts', args);
export const listLedger = (...args) => read('listLedger', args);
export const countLedger = (...args) => read('countLedger', args);
export const getCase = (...args) => read('getCase', args);
export const listCases = (...args) => read('listCases', args);
export const getSuite = (...args) => read('getSuite', args);
export const listSuites = (...args) => read('listSuites', args);
export const getRun = (...args) => read('getRun', args);
export const listRuns = (...args) => read('listRuns', args);
export const getLatestRun = (...args) => read('getLatestRun', args);
export const saveDraft = (...args) => write('saveDraft', args);
export const deleteDraft = (...args) => write('deleteDraft', args);
export const savePromptDraft = (...args) => write('savePromptDraft', args);
export const deletePromptDraft = (...args) => write('deletePromptDraft', args);
export const saveLedgerEntry = (...args) => write('saveLedgerEntry', args);
export const pruneLedger = (...args) => write('pruneLedger', args);
export const clearLedger = (...args) => write('clearLedger', args);
export const saveCase = (...args) => write('saveCase', args);
export const deleteCase = (...args) => write('deleteCase', args);
export const saveSuite = (...args) => write('saveSuite', args);
export const deleteSuite = (...args) => write('deleteSuite', args);
export const saveRun = (...args) => write('saveRun', args);
export const deleteRun = (...args) => write('deleteRun', args);
export const pruneRuns = (...args) => write('pruneRuns', args);
export const saveImportBatch = (...args) => write('saveImportBatch', args);
export const clearAll = (...args) => write('clearAll', args);
export async function updateSuite(id, updater) {
    if (injected) return injected.updateSuite(id, updater);
    if (typeof updater !== 'function') throw new TypeError('A suite updater function is required.');
    const before = await getSuite(id);
    if (!before) throw new Error('That suite no longer exists.');
    const draft = structuredClone(before);
    const next = await updater(draft);
    return write('updateSuite', [id, before, next === undefined ? draft : next]);
}
