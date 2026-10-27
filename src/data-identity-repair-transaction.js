import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { USER_DIRECTORY_TEMPLATE } from './constants.js';
import { FILE_WRITE_RECOVERY_SUFFIX, fsyncDirectorySync, tryWriteFileSync } from './util.js';
import { DATA_IDENTITY_REPAIR_DIRECTORY, inspectIdentityRepairRoot, inventoryIdentityRepairRoot } from './data-identity-repair-inspection.js';
import { createIdentityRepairBackup, verifyIdentityRepairBackup } from './data-identity-repair-backup.js';
import { confirmRoleplayAccount, encodePreparedRoleplayState, publishPreparedRoleplayState, readRoleplayFile, withRoleplayFileHandle,
    roleplayHash, roleplayLease, roleplayPathKey, roleplayStoreDirectory, withOwnedOfflineRoleplayAccount } from './roleplay-store.js';
import { assertDataRootRepairOwner } from './data-root-owner.js';
import { inspectTransferredRoleplayLocked, prepareTransferredRoleplayState } from './roleplay-transfer-recovery.js';
import { probeTermuxFileIdentity, useZeroTermuxBirthtime } from './termux-file-identity.js';

const policy = '{"version":1,"birthtime":"zero"}';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value ?? '');
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const fail = message => Object.assign(new Error(message), { code: 'DATA_IDENTITY_REPAIR_FAILED' });

function exclusiveFile(filename, bytes) {
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectorySync(path.dirname(filename));
}

function writeJournal(directory, value, expected = null) {
    const filename = path.join(directory, 'journal.json');
    const text = JSON.stringify(value);
    const verify = () => {
        const current = readRoleplayFile(filename, 128 * 1024 * 1024, { allowMissingParent: true });
        if ((!current !== !expected) || current && (current.rawHash !== expected.rawHash
            || JSON.stringify(current.physical) !== JSON.stringify(expected.physical))) throw fail('The repair journal changed. Its evidence was retained.');
    };
    verify();
    tryWriteFileSync(filename, text, { mode: 0o600 }, expected ? {
        replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(expected.physical.dev), ino: BigInt(expected.physical.ino) }, validateBeforeReplace: verify,
    } : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const written = readRoleplayFile(filename, 128 * 1024 * 1024, { flush: true });
    if (!written || written.rawHash !== hash(Buffer.from(text))) throw fail('The repair journal publication is uncertain.');
    return written;
}

function accountBase(root, owner) {
    return { owner, directories: Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(root, owner, relative)])) };
}

function readJournal(root, candidate = null) {
    const directory = candidate ?? path.join(root, DATA_IDENTITY_REPAIR_DIRECTORY);
    const dir = fs.lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw fail('The active repair directory is unsafe.');
    const record = readRoleplayFile(path.join(directory, 'journal.json'), 128 * 1024 * 1024);
    const idFile = readRoleplayFile(path.join(directory, 'operation-id'), 64);
    if (!record || !idFile) throw fail('The active repair record is incomplete. Keep it and its backup for inspection.');
    let journal;
    try { journal = JSON.parse(record.bytes.toString('utf8')); } catch { throw fail('The active repair record is unreadable.'); }
    const rootStat = fs.statSync(root, { bigint: true });
    if (journal?.version !== 1 || !uuid(journal.id) || idFile.bytes.toString('utf8') !== journal.id
        || !['prepared', 'publishing', 'policy-installed', 'retiring', 'complete'].includes(journal.phase)
        || journal.root !== root || journal.rootIdentity?.dev !== String(rootStat.dev) || journal.rootIdentity?.ino !== String(rootStat.ino)
        || !/^\d+$/.test(journal.device) || typeof journal.backup !== 'string' || !path.isAbsolute(journal.backup)
        || !digest(journal.backupHash) || !digest(journal.inputToken) || !journal.input || journal.inputToken !== roleplayHash(journal.input)
        || journal.input.root !== root || journal.input.device !== journal.device
        || JSON.stringify(journal.input.rootIdentity) !== JSON.stringify(journal.rootIdentity)
        || journal.backup !== path.join(journal.input.backupRoot, `neconyan-identity-${journal.id}`)
        || !Array.isArray(journal.accounts)
        || !Array.isArray(journal.input.inventory?.files) || !Array.isArray(journal.input.inventory?.directories)) throw fail('The active repair record is invalid.');
    if (candidate && directory !== path.join(root, `_neconyan-policy-repair-preparing-${journal.id}`)) throw fail('The prepared repair path does not match its operation.');
    const seen = new Set();
    for (const item of journal.accounts) {
        if (!digest(item.accountHash) || seen.has(item.accountHash) || typeof item.owner !== 'string'
            || path.basename(roleplayStoreDirectory(accountBase(root, item.owner))) !== item.accountHash
            || !digest(item.oldStateHash) || !digest(item.newStateHash) || !digest(item.identityHash)
            || !['pending', 'published'].includes(item.status) || !Number.isSafeInteger(item.oldEpoch) || item.oldEpoch < 1
            || !uuid(item.accountId) || !['ready', 'deleted'].includes(item.accountStatus) || !Array.isArray(item.journals)) throw fail('A repair account record is invalid.');
        seen.add(item.accountHash);
    }
    if (journal.accounts.length !== journal.input.accounts.length || journal.accounts.some((item, index) => {
        const source = journal.input.accounts[index];
        return item.accountHash !== source.accountHash || item.owner !== source.owner || item.accountId !== source.accountId
            || item.accountStatus !== source.status || item.oldEpoch !== source.dataEpoch || item.oldStateHash !== source.stateHash
            || item.identityHash !== source.identityHash;
    })) throw fail('The repair account inventory changed.');
    for (const item of journal.accounts) {
        const bytes = stagedLedger(directory, item);
        let state;
        try { state = JSON.parse(bytes.toString('utf8')).state; } catch { throw fail('A prepared account ledger is unreadable.'); }
        if (!state || state.accountId !== item.accountId || state.status !== item.accountStatus || state.dataEpoch !== item.oldEpoch + 1
            || !state.transferRecovery || !Array.isArray(state.transferRecovery.journals)) throw fail('A prepared account ledger is invalid.');
        const base = accountBase(root, item.owner);
        const expected = state.transferRecovery.journals.map(saved => ({ ...saved,
            rootRelative: path.relative(root, path.join(base.directories[saved.library], ...saved.relative.split('/').slice(1))).split(path.sep).join('/') }));
        if (JSON.stringify(expected) !== JSON.stringify(item.journals)) throw fail('The prepared journal retirements changed.');
    }
    return { directory, journal, record };
}

function preparedCandidates(root) {
    return fs.readdirSync(root).filter(name => /^_neconyan-policy-repair-preparing-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name))
        .sort().map(name => path.join(root, name));
}

export function identityRepairStatus(root) {
    try {
        const { journal } = readJournal(root);
        return { operationId: journal.id, phase: journal.phase, backup: journal.backup, accounts: journal.accounts.length };
    } catch (error) {
        if (error.code === 'ENOENT' && !fs.existsSync(path.join(root, DATA_IDENTITY_REPAIR_DIRECTORY))) {
            const candidates = preparedCandidates(root);
            if (!candidates.length) return null;
            if (candidates.length !== 1) return { phase: 'needs-inspection', message: 'Several prepared repairs were retained. Keep them and run a new check to begin again.' };
            try {
                const { journal } = readJournal(root, candidates[0]);
                if (journal.phase !== 'prepared') throw fail('The preparation did not finish.');
                return { operationId: journal.id, phase: 'prepared-candidate', backup: journal.backup, accounts: journal.accounts.length };
            } catch { return { phase: 'preparation-incomplete', message: 'An incomplete preparation was retained. No publication will be attempted from it. Run a new check to begin again.' }; }
        }
        return { phase: 'needs-inspection', message: error.message };
    }
}

/** Activate only one fully prepared orphan whose original data is still exact. */
export async function activatePreparedIdentityRepair(root, owner) {
    assertDataRootRepairOwner(owner, root);
    const candidates = preparedCandidates(root);
    if (candidates.length !== 1) throw fail('There must be one fully prepared repair to resume. Keep the existing evidence.');
    const { directory, journal, record } = readJournal(root, candidates[0]);
    if (journal.phase !== 'prepared') throw fail('The prepared repair is incomplete.');
    const probe = await probeTermuxFileIdentity(root);
    assertDataRootRepairOwner(owner, root);
    if (probe.device !== journal.device || !probe.fallback) throw fail('The data filesystem no longer matches the recorded compatibility policy.');
    const rechecked = readJournal(root, directory);
    if (rechecked.record.rawHash !== record.rawHash || JSON.stringify(rechecked.record.physical) !== JSON.stringify(record.physical)) throw fail('The prepared repair changed during the filesystem check.');
    compareBackup(journal);
    verifySource(root, journal, { verifiedDevice: probe.device });
    const policyCopy = readRoleplayFile(path.join(directory, 'policy'), 4096);
    if (!policyCopy || policyCopy.bytes.toString('utf8') !== policy) throw fail('The prepared identity policy changed.');
    for (const item of journal.accounts) {
        stagedLedger(directory, item);
        const publication = readRoleplayFile(path.join(directory, 'publication', item.accountHash + '.json'), 128 * 1024 * 1024);
        if (!publication || publication.rawHash !== item.newStateHash) throw fail('A prepared publication copy changed.');
        withOwnedOfflineRoleplayAccount(owner, accountBase(root, item.owner), lease => {
            const held = roleplayLease(lease);
            const original = journal.input.accounts.find(account => account.accountHash === item.accountHash);
            if (!original || held.identityFile.rawHash !== item.identityHash || held.stateFile.rawHash !== item.oldStateHash
                || held.state.accountId !== item.accountId || held.state.dataEpoch !== item.oldEpoch
                || held.state.status !== item.accountStatus) throw fail('The data changed after the repair was prepared.');
        });
    }
    const active = path.join(root, DATA_IDENTITY_REPAIR_DIRECTORY);
    try { fs.lstatSync(active); throw fail('Another identity repair already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(directory, active);
    fsyncDirectorySync(root);
    return readJournal(root).journal;
}

function stagedLedger(directory, item) {
    const filename = path.join(directory, 'staged', item.accountHash + '.json');
    const file = readRoleplayFile(filename, 128 * 1024 * 1024);
    if (!file || file.rawHash !== item.newStateHash) throw fail('A prepared account ledger changed.');
    return file.bytes;
}

function compareBackup(journal) {
    const manifest = verifyIdentityRepairBackup(journal.backup, journal.backupHash);
    const expected = journal.input.inventory.files.map(({ relative, size, hash: rawHash }) => ({ relative, size, hash: rawHash }));
    if (JSON.stringify(manifest.files) !== JSON.stringify(expected)
        || JSON.stringify(manifest.directories) !== JSON.stringify(journal.input.inventory.directories.map(item => item.relative))) {
        throw fail('The backup manifest does not match the original inspection.');
    }
}

// ctime can settle between complete reads on the selected Termux device. The
// inventory reader still requires ctime and every other stat to remain stable
// across each held-handle/path read; only this durable checkpoint comparison
// permits ctime to differ.
function sameDurableSourceFile(actual, expected, device) {
    if (actual.dev !== device || expected.dev !== device) return JSON.stringify(actual) === JSON.stringify(expected);
    if (typeof actual.ctimeNs !== 'string' || typeof expected.ctimeNs !== 'string'
        || !/^(?:0|[1-9]\d*)$/.test(actual.ctimeNs) || !/^(?:0|[1-9]\d*)$/.test(expected.ctimeNs)) return false;
    const actualStable = { ...actual }, expectedStable = { ...expected };
    delete actualStable.ctimeNs; delete expectedStable.ctimeNs;
    return JSON.stringify(actualStable) === JSON.stringify(expectedStable);
}

function verifySource(root, journal, { policyAllowed = false, retiredJournals = false, verifiedDevice = null } = {}) {
    const current = inventoryIdentityRepairRoot(root, { activeOperationId: journal.id });
    const expectedFiles = new Map(journal.input.inventory.files.map(file => [file.relative, file]));
    const actualFiles = new Map(current.files.map(file => [file.relative, file]));
    const changedStates = new Map(journal.accounts.map(item => [`_roleplay/${item.accountHash}/state.json`, item]));
    const allowedMissing = new Set(retiredJournals ? journal.accounts.flatMap(item => item.journals.map(journalFile => journalFile.rootRelative)) : []);
    if (policyAllowed) {
        const marker = actualFiles.get('_termux-file-identity.json');
        if (!marker || marker.hash !== hash(Buffer.from(policy))) throw fail('The saved identity policy changed.');
        actualFiles.delete('_termux-file-identity.json');
    }
    for (const [relative, expected] of expectedFiles) {
        const actual = actualFiles.get(relative);
        if (!actual && allowedMissing.has(relative)) continue;
        if (!actual) throw fail(`A source file is missing: ${relative}`);
        const account = changedStates.get(relative);
        if (account) {
            if (![account.oldStateHash, account.newStateHash].includes(actual.hash)) throw fail('A protected ledger changed during repair.');
        } else if (!(verifiedDevice === journal.device ? sameDurableSourceFile(actual, expected, verifiedDevice)
            : JSON.stringify(actual) === JSON.stringify(expected))) throw fail(`A source file changed: ${relative}`);
        actualFiles.delete(relative);
    }
    if (actualFiles.size) throw fail('Unexpected files appeared in the data folder.');
    const expectedDirs = journal.input.inventory.directories.map(({ relative, dev, ino }) => ({ relative, dev, ino }));
    const actualDirs = current.directories.map(({ relative, dev, ino }) => ({ relative, dev, ino }));
    if (JSON.stringify(expectedDirs) !== JSON.stringify(actualDirs)) throw fail('A data folder directory changed.');
}

/** Create all verified backup and exact staged ledgers before any protected publication. */
export async function prepareIdentityRepair(root, backupRoot, token, owner) {
    assertDataRootRepairOwner(owner, root);
    const checked = await inspectIdentityRepairRoot(root, backupRoot, { owner });
    if (checked.token !== token) throw fail('The data changed after the check. Check it again.');
    const id = crypto.randomUUID();
    const backup = createIdentityRepairBackup(root, checked.input.backupRoot, id, checked.input.inventory);
    const confirmed = await inspectIdentityRepairRoot(root, backupRoot, { owner });
    if (confirmed.token !== token) throw fail('The data changed during backup. The backup was retained and no policy was changed.');
    const directory = path.join(root, `_neconyan-policy-repair-preparing-${id}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectorySync(root);
    exclusiveFile(path.join(directory, 'operation-id'), id);
    const archiveParent = path.join(root, `_neconyan-policy-repair-complete-${id}`);
    fs.mkdirSync(archiveParent, { mode: 0o700 });
    fsyncDirectorySync(root);
    exclusiveFile(path.join(archiveParent, 'operation-id'), id);
    const stage = path.join(directory, 'staged');
    fs.mkdirSync(stage, { mode: 0o700 });
    const publication = path.join(directory, 'publication');
    fs.mkdirSync(publication, { mode: 0o700 });
    exclusiveFile(path.join(directory, 'policy'), policy);
    fsyncDirectorySync(directory);
    const accounts = checked.input.accounts.map(account => withOwnedOfflineRoleplayAccount(owner, accountBase(root, account.owner), lease => {
        const held = roleplayLease(lease);
        const inspected = inspectTransferredRoleplayLocked(lease);
        if (held.stateFile.rawHash !== account.stateHash || held.identityFile.rawHash !== account.identityHash
            || inspected.report.token !== account.report.token) throw fail('An account changed during preparation.');
        const journals = inspected.files.filter(file => file.library && file.relative.endsWith(FILE_WRITE_RECOVERY_SUFFIX))
            .map(({ relative, library, rawHash, physical }) => ({ relative, library, rawHash, physical }));
        const receipt = { token: inspected.report.token, backup: path.join(backup.destination, 'files', account.owner),
            dataEpoch: account.dataEpoch + 1, counts: inspected.report.counts, skipped: inspected.report.skipped.length,
            repairedAt: new Date().toISOString(), journals };
        const ids = held.state.status === 'deleted' ? [] : inspected.entries.map(() => crypto.randomUUID());
        const state = prepareTransferredRoleplayState(lease, inspected, receipt, ids, checked.input.device);
        const bytes = encodePreparedRoleplayState(lease, state);
        exclusiveFile(path.join(stage, account.accountHash + '.json'), bytes);
        exclusiveFile(path.join(publication, account.accountHash + '.json'), bytes);
        return { owner: account.owner, accountHash: account.accountHash, accountId: account.accountId, accountStatus: account.status,
            oldEpoch: account.dataEpoch, identityHash: account.identityHash, oldStateHash: account.stateHash,
            newStateHash: hash(bytes), status: 'pending', journals: state.transferRecovery.journals.map(item => ({ ...item,
                rootRelative: path.relative(root, path.join(held.scope.directories[item.library], ...item.relative.split('/').slice(1))).split(path.sep).join('/') })) };
    }));
    const journal = { version: 1, id, phase: 'prepared', root, rootIdentity: checked.input.rootIdentity, device: checked.input.device,
        backup: backup.destination, backupHash: backup.manifestHash, inputToken: token, input: checked.input, accounts };
    compareBackup(journal);
    verifySource(root, journal);
    for (const item of accounts) {
        stagedLedger(directory, item);
        const copy = readRoleplayFile(path.join(publication, item.accountHash + '.json'), 128 * 1024 * 1024);
        if (!copy || copy.rawHash !== item.newStateHash) throw fail('A publication ledger changed during preparation.');
    }
    const policyCopy = readRoleplayFile(path.join(directory, 'policy'), 4096);
    if (!policyCopy || policyCopy.bytes.toString('utf8') !== policy) throw fail('The prepared identity policy changed.');
    writeJournal(directory, journal);
    const active = path.join(root, DATA_IDENTITY_REPAIR_DIRECTORY);
    try { fs.lstatSync(active); throw fail('Another identity repair already exists.'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    fs.renameSync(directory, active);
    fsyncDirectorySync(root);
    const published = readJournal(root);
    if (published.journal.id !== id || published.journal.phase !== 'prepared') throw fail('The prepared repair gate needs inspection.');
    return journal;
}

/** Resume old/new ledger publication under the held root lease, leaving final verification to a fresh process. */
export async function publishIdentityRepair(root, owner) {
    assertDataRootRepairOwner(owner, root);
    const initial = readJournal(root);
    const probe = await probeTermuxFileIdentity(root);
    if (probe.device !== initial.journal.device || !probe.fallback) throw fail('The data filesystem no longer matches the recorded compatibility policy.');
    useZeroTermuxBirthtime(initial.journal.device);
    const loaded = readJournal(root);
    if (loaded.record.rawHash !== initial.record.rawHash || loaded.record.physical.dev !== initial.record.physical.dev
        || loaded.record.physical.ino !== initial.record.physical.ino || loaded.record.physical.birthtimeNs !== '0') {
        throw fail('The repair journal changed while its policy was selected.');
    }
    const { directory, journal } = loaded;
    let record = loaded.record;
    compareBackup(journal);
    const markerPath = path.join(root, '_termux-file-identity.json');
    const marker = readRoleplayFile(markerPath, 4096, { allowMissingParent: true });
    if (marker && marker.bytes.toString('utf8') !== policy) throw fail('The saved identity policy differs from the prepared policy.');
    verifySource(root, journal, { policyAllowed: Boolean(marker), verifiedDevice: probe.device });
    for (const item of journal.accounts) {
        stagedLedger(directory, item);
        const base = accountBase(root, item.owner);
        const state = readRoleplayFile(path.join(roleplayStoreDirectory(base), 'state.json'));
        const candidate = readRoleplayFile(path.join(directory, 'publication', item.accountHash + '.json'), 128 * 1024 * 1024, { allowMissingParent: true });
        if (!state || state.rawHash === item.oldStateHash && (!candidate || candidate.rawHash !== item.newStateHash)
            || state.rawHash === item.newStateHash && candidate || ![item.oldStateHash, item.newStateHash].includes(state.rawHash)) {
            throw fail('A prepared publication copy is missing, changed or unexpected.');
        }
    }
    if (marker) {
        if (journal.accounts.some(item => item.status !== 'published')) throw fail('The identity policy was installed before every account was recorded.');
        journal.phase = 'policy-installed';
        writeJournal(directory, journal, record);
        return journal;
    }
    journal.phase = 'publishing';
    record = writeJournal(directory, journal, record);
    for (const item of journal.accounts) {
        const bytes = stagedLedger(directory, item);
        withOwnedOfflineRoleplayAccount(owner, accountBase(root, item.owner), lease => {
            const held = roleplayLease(lease);
            if (held.identityFile.rawHash !== item.identityHash || held.state.accountId !== item.accountId
                || held.state.status !== item.accountStatus) throw fail('A protected account identity changed.');
            if (held.stateFile.rawHash === item.newStateHash && held.state.dataEpoch === item.oldEpoch + 1) return;
            if (held.stateFile.rawHash !== item.oldStateHash || held.state.dataEpoch !== item.oldEpoch) throw fail('A protected account ledger changed.');
            publishPreparedRoleplayState(lease, bytes, item.oldStateHash, item.newStateHash,
                path.join(directory, 'publication', item.accountHash + '.json'));
        });
        item.status = 'published';
        record = writeJournal(directory, journal, record);
    }
    verifySource(root, journal, { verifiedDevice: probe.device });
    const stagedPolicy = path.join(directory, 'policy');
    withRoleplayFileHandle(stagedPolicy, 4096, (prepared, readHeld) => {
        if (prepared.rawHash !== hash(Buffer.from(policy)) || prepared.size !== Buffer.byteLength(policy)) throw fail('The prepared identity policy changed.');
        try { fs.lstatSync(markerPath); throw fail('An identity policy appeared during repair.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(stagedPolicy, markerPath);
        fsyncDirectorySync(directory);
        fsyncDirectorySync(root);
        const held = readHeld(markerPath);
        const saved = readRoleplayFile(markerPath, 4096, { flush: true });
        if (held.rawHash !== prepared.rawHash || held.size !== prepared.size || held.physical.dev !== prepared.physical.dev
            || held.physical.birthtimeNs !== prepared.physical.birthtimeNs || !saved || saved.rawHash !== held.rawHash
            || JSON.stringify(saved.physical) !== JSON.stringify(held.physical)) throw fail('The identity policy publication is uncertain.');
    });
    journal.phase = 'policy-installed';
    writeJournal(directory, journal, record);
    return journal;
}

/** A later process verifies the installed policy and every account before releasing the boot gate. */
export async function verifyIdentityRepair(root, owner) {
    assertDataRootRepairOwner(owner, root);
    const loaded = readJournal(root);
    const { directory, journal } = loaded;
    let record = loaded.record;
    if (!['policy-installed', 'retiring', 'complete'].includes(journal.phase)) throw fail('The repair still needs its prepared accounts published.');
    const marker = readRoleplayFile(path.join(root, '_termux-file-identity.json'), 4096);
    if (!marker || marker.bytes.toString('utf8') !== policy) throw fail('The expected identity policy is missing or changed.');
    const probe = await probeTermuxFileIdentity(root);
    if (probe.device !== journal.device || !probe.fallback) throw fail('The data filesystem no longer matches the recorded compatibility policy.');
    useZeroTermuxBirthtime(journal.device);
    process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE = journal.device;
    const projectedRecord = readRoleplayFile(path.join(directory, 'journal.json'), 128 * 1024 * 1024, { flush: true });
    if (!projectedRecord || projectedRecord.rawHash !== record.rawHash
        || projectedRecord.physical.dev !== record.physical.dev || projectedRecord.physical.ino !== record.physical.ino
        || projectedRecord.physical.birthtimeNs !== '0') throw fail('The repair journal changed while its policy was selected.');
    record = projectedRecord;
    compareBackup(journal);
    verifySource(root, journal, { policyAllowed: true, retiredJournals: journal.phase === 'retiring' || journal.phase === 'complete', verifiedDevice: probe.device });
    if (journal.phase === 'policy-installed') {
        journal.phase = 'retiring';
        record = writeJournal(directory, journal, record);
    }
    for (const item of journal.accounts) {
        const bytes = stagedLedger(directory, item);
        const staged = JSON.parse(bytes.toString('utf8')).state;
        withOwnedOfflineRoleplayAccount(owner, accountBase(root, item.owner), lease => {
            const held = roleplayLease(lease);
            if (held.identityFile.rawHash !== item.identityHash || held.stateFile.rawHash !== item.newStateHash
                || held.state.accountId !== item.accountId || held.state.status !== item.accountStatus
                || held.state.dataEpoch !== item.oldEpoch + 1 || JSON.stringify(held.identityFile.physical) !== JSON.stringify(staged.placement)) {
                throw fail('A repaired account did not verify under the saved identity policy.');
            }
            const inspected = inspectTransferredRoleplayLocked(lease);
            const original = journal.input.accounts.find(account => account.accountHash === item.accountHash);
            if (!original || JSON.stringify(inspected.report.skipped) !== JSON.stringify(original.report.skipped)
                || JSON.stringify(inspected.report.warnings) !== JSON.stringify(original.report.warnings)) throw fail('The repaired account report changed.');
            if (item.accountStatus !== 'deleted') {
                if (inspected.entries.length !== Object.keys(staged.resources).length) throw fail('The repaired account files do not match its prepared ledger.');
                for (const entry of inspected.entries) {
                    const link = staged.paths[roleplayPathKey(staged, entry.kind, entry.locator)];
                    const resource = link && staged.resources[link.instanceId];
                    if (!resource || resource.head.rawHash !== entry.head.rawHash || resource.head.contentHash !== entry.head.contentHash
                        || JSON.stringify(resource.head.physical) !== JSON.stringify(entry.head.physical)) throw fail('A repaired resource changed.');
                }
            }
            for (const saved of staged.transferRecovery.journals) {
                const filename = path.join(held.scope.directories[saved.library], ...saved.relative.split('/').slice(1));
                const current = readRoleplayFile(filename, undefined, { allowMissingParent: true });
                if (current && (current.rawHash !== saved.rawHash || JSON.stringify(current.physical) !== JSON.stringify(saved.physical))) {
                    throw fail('A retained write journal changed.');
                }
            }
            confirmRoleplayAccount(lease);
            for (const saved of staged.transferRecovery.journals) {
                const filename = path.join(held.scope.directories[saved.library], ...saved.relative.split('/').slice(1));
                if (readRoleplayFile(filename, undefined, { allowMissingParent: true })) throw fail('A backed-up write journal could not be retired.');
            }
        });
    }
    compareBackup(journal);
    verifySource(root, journal, { policyAllowed: true, retiredJournals: true, verifiedDevice: probe.device });
    journal.phase = 'complete';
    record = writeJournal(directory, journal, record);
    const before = fs.lstatSync(directory, { bigint: true });
    const archiveParent = path.join(root, `_neconyan-policy-repair-complete-${journal.id}`);
    const archiveParentStat = fs.lstatSync(archiveParent);
    const archiveId = readRoleplayFile(path.join(archiveParent, 'operation-id'), 64);
    if (!archiveParentStat.isDirectory() || archiveParentStat.isSymbolicLink() || !archiveId
        || archiveId.bytes.toString('utf8') !== journal.id || fs.readdirSync(archiveParent).join() !== 'operation-id') {
        throw fail('The repair archive already exists and needs inspection.');
    }
    fsyncDirectorySync(root);
    const after = fs.lstatSync(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
        || readRoleplayFile(path.join(directory, 'journal.json'), 128 * 1024 * 1024).rawHash !== record.rawHash) throw fail('The completed repair evidence changed.');
    const archive = path.join(archiveParent, 'operation');
    if (fs.existsSync(archive)) throw fail('The repair archive already contains an operation.');
    fs.renameSync(directory, archive);
    fsyncDirectorySync(root);
    fsyncDirectorySync(archiveParent);
    const completed = readRoleplayFile(path.join(archive, 'journal.json'), 128 * 1024 * 1024, { flush: true });
    if (!completed || completed.rawHash !== record.rawHash) throw fail('The completed repair archive needs inspection.');
    return { operationId: journal.id, backup: journal.backup, archive };
}
