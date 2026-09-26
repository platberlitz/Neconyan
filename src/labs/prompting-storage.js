import path from 'node:path';
import { createPromptingStorage } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/storage-core.js';
import { createRoleplayDirectory, readRoleplayFile, roleplayHash, roleplayLease, roleplayStoreDirectory, withRoleplayAccount } from '../roleplay-store.js';
import { tryWriteFileSync } from '../util.js';
import { labError, withLabRecord } from './store.js';

const LIMIT = 64 * 1024 * 1024;
const READS = new Set(['getDraft', 'listDrafts', 'getPromptDraft', 'listPromptDrafts', 'listLedger', 'countLedger',
    'getCase', 'listCases', 'getSuite', 'listSuites', 'getRun', 'listRuns', 'getLatestRun']);
const WRITES = new Set(['saveDraft', 'deleteDraft', 'savePromptDraft', 'deletePromptDraft', 'saveLedgerEntry', 'pruneLedger',
    'clearLedger', 'saveCase', 'deleteCase', 'saveSuite', 'deleteSuite', 'updateSuite', 'saveRun', 'deleteRun', 'pruneRuns',
    'saveImportBatch', 'clearAll', 'importLegacy', 'clearRuns']);
const stamp = scope => ({ accountId: scope.accountId, dataEpoch: scope.dataEpoch });

export function readPromptingDatabaseLocked(lease) {
    const { scope } = roleplayLease(lease);
    const filename = path.join(roleplayStoreDirectory(scope), `prompting-${roleplayHash(scope.accountId)}.json`);
    const file = readRoleplayFile(filename, LIMIT, { allowMissingParent: true });
    let value;
    try { value = file ? JSON.parse(file.bytes.toString('utf8')) : { version: 1, account: stamp(scope), revision: 0, data: {}, applied: {} }; } catch { throw labError('The saved Prompting Lab records are unreadable.'); }
    if (value.version !== 1 || roleplayHash(value.account) !== roleplayHash(stamp(scope)) || !Number.isSafeInteger(value.revision)
        || value.revision < 0 || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)
        || !value.applied || typeof value.applied !== 'object' || Array.isArray(value.applied)) {
        throw labError('The saved Prompting Lab records belong to a different account state or need recovery.');
    }
    for (const [key, receipt] of Object.entries(value.applied)) {
        if (!key || key.length > 200 || receipt?.version !== 1 || typeof receipt.jobId !== 'string'
            || !/^[a-f0-9]{64}$/.test(receipt.planHash) || receipt.hash !== roleplayHash(receipt.result)) {
            throw labError('A permanent Prompting Lab completion record needs recovery.');
        }
    }
    return { filename, file, value };
}

export function promptingCompletion(database, record) {
    const receipt = database.value.applied[record.key];
    if (receipt && (receipt.jobId !== record.jobId || receipt.planHash !== record.planHash)) {
        throw labError('The Prompting Lab completion record belongs to a different operation.');
    }
    return receipt;
}

const completed = promptingCompletion;

const completion = (record, result) => ({ version: 1, jobId: record.jobId, planHash: record.planHash, result, hash: roleplayHash(result) });
const refused = message => Object.assign(labError(message), { labRefused: true });

function writeDatabase(lease, current, value) {
    const { scope } = roleplayLease(lease);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > LIMIT) throw labError('Prompting Lab storage is full. Existing records and completion evidence were retained.', 413);
    createRoleplayDirectory(roleplayStoreDirectory(scope), roleplayStoreDirectory(scope));
    const validate = () => {
        const after = readPromptingDatabaseLocked(lease).file;
        if (roleplayHash(after ? [after.rawHash, after.physical] : null) !== roleplayHash(current.file ? [current.file.rawHash, current.file.physical] : null)) {
            throw labError('Prompting Lab records changed before publication.');
        }
    };
    validate();
    tryWriteFileSync(current.filename, bytes, { encoding: 'utf8', mode: 0o600 }, current.file ? {
        replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(current.file.physical.dev), ino: BigInt(current.file.physical.ino) }, validateBeforeReplace: validate,
    } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const saved = readRoleplayFile(current.filename, LIMIT, { flush: true });
    if (!saved || saved.bytes.toString('utf8') !== bytes) throw labError('The Prompting Lab record publication needs recovery.');
}

export function promptingMemory(data = {}) {
    const memory = createPromptingStorage(null).createMemoryStore(data);
    return { memory, storage: createPromptingStorage(memory) };
}

export async function readPromptingStorage(base, account, method, args = []) {
    if (!READS.has(method) || !Array.isArray(args)) throw labError('Choose a supported Prompting Lab read.', 400);
    const current = withRoleplayAccount(base, account, readPromptingDatabaseLocked);
    const { storage } = promptingMemory(current.value.data);
    return { value: await storage[method](...args), revision: current.value.revision };
}

export function capturePromptingStorage(base, account, input) {
    if (!WRITES.has(input.method) || !Array.isArray(input.args)) throw labError('Choose a supported Prompting Lab write.', 400);
    const current = withRoleplayAccount(base, account, readPromptingDatabaseLocked);
    return { method: input.method, args: structuredClone(input.args), revision: current.value.revision };
}

async function migrateLegacy(memory, entries) {
    if (!Array.isArray(entries) || entries.length > 50000) throw labError('The legacy Prompting Lab records are invalid.', 400);
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0] === 'meta:transaction') throw labError('The legacy Prompting Lab record needs recovery.');
        const [key, value] = entry;
        const previous = await memory.getItem(key);
        if (previous == null) await memory.setItem(key, value);
        else if (roleplayHash(previous) !== roleplayHash(value)) {
            if (!key.startsWith('index:') || !Array.isArray(previous) || !Array.isArray(value)) {
                throw labError(`A different Prompting Lab record already uses ${key}. The browser copy was retained.`);
            }
            const ids = new Set(previous.map(item => typeof item === 'string' ? item : item?.id));
            await memory.setItem(key, [...previous, ...value.filter(item => !ids.has(typeof item === 'string' ? item : item?.id))]);
        }
    }
    return { imported: entries.length };
}

/** Publish records and the operation receipt together; replay never restores deleted runs. */
export async function runPromptingStorage(context, plan, { beforeStoragePublish } = {}) {
    const current = withLabRecord(context, ({ lease, value }) => {
        const database = readPromptingDatabaseLocked(lease);
        if (completed(database, value)) return { replay: completed(database, value).result };
        if (database.value.revision !== plan.revision) throw refused('Prompting Lab records changed after this operation was accepted. Review the current records before trying again.');
        return database;
    });
    if (Object.hasOwn(current, 'replay')) return current.replay;
    const { memory, storage } = promptingMemory(current.value.data);
    let result;
    if (plan.method === 'importLegacy') result = await migrateLegacy(memory, plan.args[0]);
    else if (plan.method === 'updateSuite') {
        const [id, before, next] = plan.args;
        const saved = await storage.getSuite(id);
        if (roleplayHash(saved) !== roleplayHash(before)) throw refused('This suite changed before its reviewed update.');
        result = await storage.saveSuite({ ...next, id });
    } else if (plan.method === 'clearRuns') {
        let removed = 0;
        for (const testCase of await storage.listCases()) for (const run of await storage.listRuns(testCase.id)) {
            await storage.deleteRun(testCase.id, run.id); removed++;
        }
        for (const suite of await storage.listSuites()) await storage.saveSuite({ ...suite, baselines: {} });
        result = { removed };
    } else if (plan.method === 'adoptCases') {
        const [before, cases] = plan.args;
        const suite = await storage.getSuite(before.id);
        if (roleplayHash(suite) !== roleplayHash(before)) throw refused('The suite changed before its embedded cases could be added.');
        for (const item of cases) await storage.saveCase(item);
        result = { cases, suite: await storage.saveSuite({ ...suite, caseIds: [...suite.caseIds, ...cases.map(item => item.id)] }) };
    } else result = await storage[plan.method](...plan.args);
    result = result === undefined ? null : JSON.parse(JSON.stringify(result));
    const data = Object.fromEntries(await Promise.all((await memory.keys()).map(async key => [key, await memory.getItem(key)])));
    context.signal.throwIfAborted();
    withLabRecord(context, ({ lease, value }) => {
        const latest = readPromptingDatabaseLocked(lease);
        if (completed(latest, value)) return;
        if (latest.value.revision !== plan.revision) throw refused('Prompting Lab records changed before publication. Review the current records before trying again.');
        if (latest.value.revision >= Number.MAX_SAFE_INTEGER) throw labError('Prompting Lab record revisions are exhausted.', 413);
        writeDatabase(lease, latest, { ...latest.value, revision: latest.value.revision + 1, data,
            applied: { ...latest.value.applied, [value.key]: completion(value, result) } });
        beforeStoragePublish?.();
    });
    return result;
}

/** Append a completed batch to current records, preserving concurrent edits and every baseline. */
export async function publishPromptingRuns(context, runs, result, retention) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = withLabRecord(context, ({ lease, value }) => {
            const database = readPromptingDatabaseLocked(lease);
            return completed(database, value) ? { replay: completed(database, value).result } : database;
        });
        if (Object.hasOwn(current, 'replay')) return current.replay;
        const { storage, memory } = promptingMemory(current.value.data);
        for (const run of runs) {
            const previous = await storage.getRun(run.id);
            if (previous && roleplayHash(previous) !== roleplayHash(run)) throw labError('A different saved run already uses this identifier.');
            await storage.saveRun(run);
        }
        const pinned = new Set(runs.map(run => run.id));
        for (const suite of await storage.listSuites()) for (const id of Object.values(suite.baselines ?? {})) pinned.add(id);
        for (const caseId of new Set(runs.map(run => run.caseId))) {
            await storage.pruneRuns(caseId, Math.max(0, retention - runs.filter(run => run.caseId === caseId).length), [...pinned]);
        }
        const data = Object.fromEntries(await Promise.all((await memory.keys()).map(async key => [key, await memory.getItem(key)])));
        context.signal.throwIfAborted();
        const committed = withLabRecord(context, ({ lease, value }) => {
            const latest = readPromptingDatabaseLocked(lease);
            if (completed(latest, value)) return true;
            if (latest.value.revision !== current.value.revision) return false;
            if (latest.value.revision >= Number.MAX_SAFE_INTEGER) throw labError('Prompting Lab record revisions are exhausted.', 413);
            writeDatabase(lease, latest, { ...latest.value, revision: latest.value.revision + 1, data,
                applied: { ...latest.value.applied, [value.key]: completion(value, result) } });
            return true;
        });
        if (committed) return result;
    }
    throw labError('Prompting Lab records kept changing. The completed batch is retained for retry.');
}

/** Complete an already-published preset without overwriting a subsequently edited draft. */
export async function publishPromptingDraft(context, plan) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = withLabRecord(context, ({ lease, value }) => {
            const database = readPromptingDatabaseLocked(lease);
            return completed(database, value) ? { replay: completed(database, value).result } : database;
        });
        if (Object.hasOwn(current, 'replay')) return current.replay;
        const { storage, memory } = promptingMemory(current.value.data);
        const draft = await storage.getDraft(plan.draft.id);
        const unchanged = draft && roleplayHash(draft) === plan.draftHash;
        const saved = unchanged ? await storage.saveDraft({ ...draft, publishedAs: plan.target.name }) : draft;
        const result = { name: plan.target.name, draft: saved, draftChanged: !unchanged };
        const data = Object.fromEntries(await Promise.all((await memory.keys()).map(async key => [key, await memory.getItem(key)])));
        const committed = withLabRecord(context, ({ lease, value }) => {
            const latest = readPromptingDatabaseLocked(lease);
            if (completed(latest, value)) return true;
            if (latest.value.revision !== current.value.revision) return false;
            if (latest.value.revision >= Number.MAX_SAFE_INTEGER) throw labError('Prompting Lab record revisions are exhausted.', 413);
            writeDatabase(lease, latest, { ...latest.value, revision: latest.value.revision + 1, data,
                applied: { ...latest.value.applied, [value.key]: completion(value, result) } });
            return true;
        });
        if (committed) return result;
    }
    throw labError('The preset is published, but its draft completion record needs recovery.');
}
