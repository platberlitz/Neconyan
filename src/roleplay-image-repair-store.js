import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRoleplayDirectory, readRoleplayFile, roleplayError, roleplayHash, roleplayLease, roleplayStoreDirectory } from './roleplay-store.js';
import { tryWriteFileSync } from './util.js';
import { uiText } from '../public/scripts/ui-text.js';

export const REPAIR_LIMIT = 256 * 1024;
export const REPAIR_CHAT_LIMIT = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
export const repairFailure = (message, { integrity = false } = {}) => Object.assign(roleplayError('ROLEPLAY_IMAGE_RECOVERY', message), integrity ? { integrity: true } : {});
// A saved record that is missing, changed or inconsistent. Its English stays as written; the route tags the error so the page can explain it once.
export const integrityFailure = message => repairFailure(message, { integrity: true });
export function repairDirectory(scope) { return path.join(roleplayStoreDirectory(scope), 'image-repair'); }
export function repairPath(scope, id, suffix) {
    if (!HASH.test(id) || (!['plan.json', 'manifest.json', 'candidate.jsonl', 'before.jsonl'].includes(suffix) && !/^image\.(?:0|[1-9]\d{0,2})\.bin$/.test(suffix))) throw repairFailure('Invalid image recovery record.');
    return path.join(repairDirectory(scope), id + '.' + suffix);
}
export function readRepairJson(filename, limit = REPAIR_LIMIT, optional = false) {
    const file = readRoleplayFile(filename, limit, { allowMissingParent: true });
    if (!file && optional) return null;
    if (!file) throw integrityFailure('An image recovery record is missing. Keep its files for recovery.');
    let envelope;
    try { envelope = JSON.parse(file.bytes.toString('utf8')); } catch { throw integrityFailure('An image recovery record is unreadable.'); }
    if (envelope?.hash !== roleplayHash(envelope?.value)) throw integrityFailure('An image recovery record changed.');
    return { file, value: envelope.value };
}
export function writeRepairBytes(filename, bytes, limit, expected = null) {
    if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw integrityFailure('The image recovery record exceeds its storage limit.');
    const validateBeforeReplace = () => {
        const current = readRoleplayFile(filename, limit, { allowMissingParent: true });
        if (Boolean(current) !== Boolean(expected) || current && (current.rawHash !== expected.rawHash || !isDeepStrictEqual(current.physical, expected.physical))) {
            throw integrityFailure('Image recovery evidence changed. Its files were kept.');
        }
    };
    validateBeforeReplace();
    tryWriteFileSync(filename, bytes, { mode: 0o600 }, expected
        ? { replaceFileOnly: true, expectedFileIdentity: { dev: BigInt(expected.physical.dev), ino: BigInt(expected.physical.ino) }, validateBeforeReplace }
        : { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    const written = readRoleplayFile(filename, limit, { flush: true });
    if (!written || !written.bytes.equals(bytes)) throw integrityFailure('The image recovery backup could not be verified.');
    return written;
}
export function writeRepairJson(filename, value, limit = REPAIR_LIMIT, expected = null) {
    return writeRepairBytes(filename, Buffer.from(JSON.stringify({ hash: roleplayHash(value), value })), limit, expected);
}
export function ensureRepairStore(lease, { checkpoint = () => {} } = {}) {
    const { scope, root } = roleplayLease(lease);
    const directory = repairDirectory(scope), cataloguePath = path.join(directory, 'catalogue.json');
    const intentPath = path.join(root, 'image-repair-init.json');
    const empty = { version: 1, entries: {} };
    let intent = readRepairJson(intentPath, 4096, true);
    const catalogue = readRepairJson(cataloguePath, REPAIR_LIMIT, true);
    // Existing complete stores predate this initialisation marker. Never adopt an incomplete one.
    if (!intent && catalogue) { repairCatalogue(scope); pins(scope); return directory; }
    const identity = { version: 1, kind: 'image-repair-store', accountId: scope.accountId, dataEpoch: scope.dataEpoch };
    const validateIntent = () => {
        if (!intent || !['creating', 'ready'].includes(intent.value.phase)
            || !isDeepStrictEqual(intent.value, { ...identity, phase: intent.value.phase })) {
            throw integrityFailure('The image recovery initialisation record changed. Keep its files for recovery.');
        }
    };
    const fs = process.getBuiltinModule('fs');
    if (!intent) {
        // The protected read above verifies directory ancestry before inspecting it.
        if (fs.existsSync(directory)) throw integrityFailure('The image recovery catalogue is missing. Keep the directory for recovery.');
        writeRepairJson(intentPath, { ...identity, phase: 'creating' }, 4096);
        intent = readRepairJson(intentPath, 4096);
        checkpoint('repair-init-intent');
    }
    validateIntent();
    if (intent.value.phase === 'ready') { repairCatalogue(scope); pins(scope); return directory; }
    const pinPath = path.join(directory, 'pins.json'), pin = readRepairJson(pinPath, 16 * 1024, true);
    if (catalogue && !isDeepStrictEqual(catalogue.value, empty) || pin && !isDeepStrictEqual(pin.value, empty)
        || fs.existsSync(directory) && fs.readdirSync(directory).some(name => !['pins.json', 'catalogue.json'].includes(name))) {
        throw integrityFailure('Unfinished image recovery initialisation has unexpected records. Its files were retained.');
    }
    createRoleplayDirectory(directory, root);
    checkpoint('repair-init-directory');
    if (!pin) writeRepairJson(pinPath, empty, 16 * 1024);
    checkpoint('repair-init-pins');
    if (!catalogue) writeRepairJson(cataloguePath, empty);
    checkpoint('repair-init-catalogue');
    writeRepairJson(intentPath, { ...identity, phase: 'ready' }, 4096, intent.file);
    checkpoint('repair-init-ready');
    return directory;
}
export function repairCatalogue(scope) {
    const result = readRepairJson(path.join(repairDirectory(scope), 'catalogue.json'));
    if (result.value?.version !== 1 || !result.value.entries || Object.keys(result.value.entries).length > 1024
        || Object.entries(result.value.entries).some(([id, row]) => !HASH.test(id) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
            || typeof row.complete !== 'boolean')) throw integrityFailure('The image recovery catalogue is damaged.');
    return result;
}
export function reserveRepair(lease, id, bytes, plan) {
    const { scope } = roleplayLease(lease);
    ensureRepairStore(lease);
    const catalogue = repairCatalogue(scope);
    const planHash = roleplayHash(plan);
    const old = catalogue.value.entries[id];
    if (old) {
        if (old.planHash !== planHash || old.bytes !== bytes) throw repairFailure('This repair already has different saved inputs.');
        return;
    }
    const entries = Object.values(catalogue.value.entries);
    if (entries.length >= 1024 || entries.filter(item => !item.complete).length >= 8
        || entries.reduce((sum, item) => sum + item.bytes, bytes) > 1024 * 1024 * 1024
        || bytes > 256 * 1024 * 1024) throw repairFailure(uiText('Change history is full. Download and delete old backups there, or change fewer images at a time.'));
    catalogue.value.entries[id] = { bytes, complete: false, phase: 'staging', planHash,
        accountId: scope.accountId, dataEpoch: scope.dataEpoch, requestHash: plan.requestHash,
        operationKeyHash: plan.native.operationKeyHash, intentHash: plan.native.intentHash,
        locator: plan.input.source.locator, createdAt: plan.createdAt };
    writeRepairJson(path.join(repairDirectory(scope), 'catalogue.json'), catalogue.value, REPAIR_LIMIT, catalogue.file);
}
export function validateRepairReservation(scope, entry, plan = null) {
    if (!entry || entry.accountId !== scope.accountId || entry.dataEpoch !== scope.dataEpoch
        || !['staging', 'prepared', 'aborting', 'aborted'].includes(entry.phase)
        || ![entry.planHash, entry.requestHash, entry.operationKeyHash, entry.intentHash].every(value => HASH.test(value))
        || !entry.locator || (entry.phase === 'aborted' && (!entry.complete || entry.bytes !== 0))) {
        throw integrityFailure('The repair reservation needs recovery. Its files were retained.');
    }
    if (plan && (entry.planHash !== roleplayHash(plan) || entry.requestHash !== plan.requestHash
        || entry.operationKeyHash !== plan.native.operationKeyHash || entry.intentHash !== plan.native.intentHash
        || !isDeepStrictEqual(entry.locator, plan.input.source.locator)
        || plan.input.source.accountId !== scope.accountId || plan.input.source.dataEpoch !== scope.dataEpoch)) {
        throw integrityFailure('The repair reservation differs from its saved intent.');
    }
    return entry;
}
export function assertRepairUnstarted(scope, state, id, entry, index = pins(scope).value) {
    validateRepairReservation(scope, entry);
    if (!['staging', 'aborting', 'aborted'].includes(entry.phase) || index.entries[id]
        || Object.values(index.entries).some(pin => pin.operationKeyHash === entry.operationKeyHash)
        || state.submissions[entry.operationKeyHash] || state.pending?.operationKeyHash === entry.operationKeyHash) {
        throw integrityFailure('This repair may have changed the chat. Keep its records for recovery.');
    }
}
export function setRepairPhase(lease, id, phase) {
    const { scope } = roleplayLease(lease);
    const catalogue = repairCatalogue(scope);
    const entry = validateRepairReservation(scope, catalogue.value.entries[id]);
    entry.phase = phase;
    if (phase === 'aborted') { entry.bytes = 0; entry.complete = true; }
    writeRepairJson(path.join(repairDirectory(scope), 'catalogue.json'), catalogue.value, REPAIR_LIMIT, catalogue.file);
}
function pins(scope) {
    const result = readRepairJson(path.join(repairDirectory(scope), 'pins.json'), 16 * 1024);
    if (result.value?.version !== 1 || !result.value.entries || Object.keys(result.value.entries).length > 8) throw integrityFailure('Image recovery receipt pins are damaged.');
    return result;
}
export function pinRepair(lease, id, plan) {
    const { scope } = roleplayLease(lease);
    const index = pins(scope);
    const pin = { accountId: scope.accountId, dataEpoch: scope.dataEpoch, planHash: roleplayHash(plan),
        operationKeyHash: plan.native.operationKeyHash, intentHash: plan.native.intentHash, candidateHash: plan.candidateHash };
    if (index.value.entries[id] && !isDeepStrictEqual(index.value.entries[id], pin)) throw integrityFailure('The repair receipt pin disagrees with its original intent.');
    if (!index.value.entries[id] && Object.keys(index.value.entries).length >= 8) throw repairFailure(uiText('Too many image changes in this account need attention. Review them in Change history before trying again.'));
    index.value.entries[id] = pin;
    writeRepairJson(path.join(repairDirectory(scope), 'pins.json'), index.value, 16 * 1024, index.file);
}
export function finishRepair(lease, id) {
    const { scope } = roleplayLease(lease);
    const manifest = readRepairJson(repairPath(scope, id, 'manifest.json')).value;
    if (manifest.stage !== 'committed' || !manifest.result) throw integrityFailure('The image repair result has not been saved.');
    const catalogue = repairCatalogue(scope);
    if (!catalogue.value.entries[id] || catalogue.value.entries[id].planHash !== manifest.planHash) throw integrityFailure('The repair result does not match its catalogue.');
    catalogue.value.entries[id].complete = true;
    writeRepairJson(path.join(repairDirectory(scope), 'catalogue.json'), catalogue.value, REPAIR_LIMIT, catalogue.file);
    const index = pins(scope);
    delete index.value.entries[id];
    writeRepairJson(path.join(repairDirectory(scope), 'pins.json'), index.value, 16 * 1024, index.file);
}
/** null means uncertain evidence: retain every native receipt, without blocking ordinary writes. */
export function pinnedImageRepairReceipts(scope, state) {
    try {
        const fs = process.getBuiltinModule('fs');
        const directory = repairDirectory(scope);
        readRoleplayFile(path.join(directory, '.path-check'), 1, { allowMissingParent: true });
        if (!fs.existsSync(directory)) return new Set();
        const catalogue = repairCatalogue(scope).value;
        const index = pins(scope).value;
        const kept = new Set();
        for (const [id, entry] of Object.entries(catalogue.entries)) {
            validateRepairReservation(scope, entry);
            if (['staging', 'aborting', 'aborted'].includes(entry.phase)) {
                assertRepairUnstarted(scope, state, id, entry, index);
                const plan = readRepairJson(repairPath(scope, id, 'plan.json'), REPAIR_LIMIT, true)?.value;
                if (plan) validateRepairReservation(scope, entry, plan);
                const manifest = readRepairJson(repairPath(scope, id, 'manifest.json'), REPAIR_LIMIT, true)?.value;
                if (manifest && (manifest.planHash !== entry.planHash || manifest.stage !== 'backup-verified')) return null;
                continue;
            }
            if (!entry.complete && !index.entries[id]) return null;
        }
        for (const [id, pin] of Object.entries(index.entries)) {
            if (pin.accountId !== state.accountId || pin.dataEpoch !== state.dataEpoch) return null;
            const plan = readRepairJson(repairPath(scope, id, 'plan.json')).value;
            const manifest = readRepairJson(repairPath(scope, id, 'manifest.json')).value;
            if (roleplayHash(plan) !== pin.planHash || manifest.planHash !== pin.planHash || catalogue.entries[id]?.planHash !== pin.planHash
                || plan.candidateHash !== pin.candidateHash || plan.native.operationKeyHash !== pin.operationKeyHash
                || plan.native.intentHash !== pin.intentHash) return null;
            const candidate = readRoleplayFile(repairPath(scope, id, 'candidate.jsonl'), REPAIR_CHAT_LIMIT);
            if (!candidate || candidate.rawHash !== pin.candidateHash) return null;
            const receipt = state.submissions[pin.operationKeyHash];
            if (receipt && receipt.intentHash !== pin.intentHash) return null;
            kept.add(pin.operationKeyHash);
        }
        return kept;
    } catch { return null; }
}
