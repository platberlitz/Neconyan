import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRoleplayFile, roleplayHash, roleplayLease, roleplayStoreDirectory, withOwnedOfflineRoleplayAccount } from './roleplay-store.js';
import { discoverHandoffAccounts, inspectTransferredRoleplayLocked } from './roleplay-transfer-recovery.js';
import { probeTermuxFileIdentity } from './termux-file-identity.js';
import { isBunRuntime, isNativeTermuxEnvironment } from './runtime.js';
import { assertDataRootRepairOwner, DATA_ROOT_OWNER_DIRECTORY } from './data-root-owner.js';

export const DATA_IDENTITY_REPAIR_DIRECTORY = '_neconyan-policy-repair';
const transientLock = /^\.neconyan-chat-[a-f0-9]{64}\.lock(?:\.owner)?$/;

function failure(message) {
    return Object.assign(new Error(message), { code: 'DATA_IDENTITY_CHECK_FAILED' });
}

function within(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function metadata(stat) {
    return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}

function inspectSurvivingResets(base, state) {
    const directory = path.join(roleplayStoreDirectory(base), 'operations');
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('Application operation evidence is unsafe.');
    for (const name of fs.readdirSync(directory).sort()) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw failure('Unexpected application operation evidence needs inspection.');
        const file = readRoleplayFile(path.join(directory, name), 64 * 1024 * 1024);
        let value;
        try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw failure('Application operation evidence is unreadable.'); }
        if (value?.version !== 1 || !['preparing', 'accepted', 'completed', 'refused'].includes(value.state)
            || !value.account || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.account.accountId ?? '')
            || !Number.isSafeInteger(value.account.dataEpoch) || value.account.dataEpoch < 1
            || typeof value.key !== 'string' || !value.key || value.key.length > 200 || !/^[a-f0-9]{64}$/.test(value.requestHash ?? '')
            || !/^[a-z][a-z.-]{0,63}$/.test(value.kind ?? '') || !value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)
            || value.planHash !== roleplayHash(value.plan) || !value.effects || typeof value.effects !== 'object' || Array.isArray(value.effects)
            || Object.values(value.effects).some(effect => !effect || typeof effect !== 'object' || Array.isArray(effect))
            || value.state !== 'preparing' && typeof value.jobId !== 'string'
            || value.state === 'completed' && value.resultHash !== roleplayHash(value.result)) {
            throw failure('Application operation evidence is invalid.');
        }
        if (value.kind === 'account-reset' && value.account.accountId === state.accountId
            && (['preparing', 'accepted'].includes(value.state)
                || Object.values(value.effects).some(effect => !effect || effect.state !== 'done'))) {
            throw failure('An account reset has unfinished effects. Keep its evidence and resolve it before compatibility repair.');
        }
    }
}

/** Read complete bytes from a held handle and refuse changing, linked or substituted files. */
function inventoryFile(filename, relative) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(filename, flags);
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        const firstPath = fs.lstatSync(filename, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || !firstPath.isFile() || firstPath.isSymbolicLink()
            || before.dev !== firstPath.dev || before.ino !== firstPath.ino) throw failure(`Unsafe file: ${relative}`);
        const hash = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let total = 0;
        for (;;) {
            const count = fs.readSync(fd, chunk, 0, chunk.length, null);
            if (!count) break;
            hash.update(chunk.subarray(0, count));
            total += count;
            if (!Number.isSafeInteger(total)) throw failure(`File is too large to inspect: ${relative}`);
        }
        const after = fs.fstatSync(fd, { bigint: true });
        const lastPath = fs.lstatSync(filename, { bigint: true });
        if (JSON.stringify(metadata(before)) !== JSON.stringify(metadata(after)) || !lastPath.isFile() || lastPath.isSymbolicLink()
            || JSON.stringify(metadata(after)) !== JSON.stringify(metadata(lastPath)) || lastPath.nlink !== 1n || BigInt(total) !== after.size) {
            throw failure(`File changed during inspection: ${relative}`);
        }
        return { relative, ...metadata(after), hash: hash.digest('hex') };
    } finally { fs.closeSync(fd); }
}

/** Unknown ordinary files participate; only Git administration and exact runtime ownership/locks are local. */
export function inventoryIdentityRepairRoot(root, { activeOperationId = null } = {}) {
    const files = [];
    const directories = [];
    const excluded = [];
    function walk(directory, relative) {
        const before = fs.lstatSync(directory, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) throw failure(`Unsafe directory: ${relative || '.'}`);
        const names = fs.readdirSync(directory).sort();
        const portableNames = [];
        directories.push({ relative, dev: String(before.dev), ino: String(before.ino), names: portableNames });
        for (const name of names) {
            const next = relative ? `${relative}/${name}` : name;
            const filename = path.join(directory, name);
            if (!relative && (name === DATA_IDENTITY_REPAIR_DIRECTORY
                || activeOperationId && (name === `_neconyan-policy-repair-complete-${activeOperationId}`
                    || name === `_neconyan-policy-repair-preparing-${activeOperationId}`))) {
                if (!activeOperationId) throw failure('An existing identity repair needs inspection or resumption before a new check.');
                const marker = path.join(filename, 'operation-id');
                const stat = fs.lstatSync(filename);
                const record = readRoleplayFile(marker, 64);
                if (!stat.isDirectory() || stat.isSymbolicLink() || !record || record.bytes.toString('utf8') !== activeOperationId) {
                    throw failure('The active identity repair no longer matches this operation.');
                }
                excluded.push(next);
                continue;
            }
            if (transientLock.test(name)) throw failure(`A storage lock needs inspection before repair: ${next}`);
            if (!relative && ['.git', DATA_ROOT_OWNER_DIRECTORY].includes(name)) {
                excluded.push(next);
                continue;
            }
            portableNames.push(name);
            const stat = fs.lstatSync(filename, { bigint: true });
            if (stat.isSymbolicLink()) throw failure(`A symbolic link cannot be backed up safely: ${next}`);
            if (stat.isDirectory()) walk(filename, next);
            else if (stat.isFile()) files.push(inventoryFile(filename, next));
            else throw failure(`A special file cannot be backed up safely: ${next}`);
        }
        const after = fs.lstatSync(directory, { bigint: true });
        if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
            || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(directory).sort())) throw failure(`Directory changed during inspection: ${relative || '.'}`);
    }
    walk(root, '');
    return { files, directories, excluded };
}

/** Read-only preview: no account, policy, backup or journal publication. */
export async function inspectIdentityRepairRoot(root, backupRoot, { owner, termux = isNativeTermuxEnvironment(), bun = isBunRuntime() } = {}) {
    root = fs.realpathSync(path.resolve(root));
    assertDataRootRepairOwner(owner, root);
    backupRoot = fs.realpathSync(path.resolve(backupRoot));
    if (within(root, backupRoot)) throw failure('Choose an existing backup folder outside the data folder.');
    if (!fs.statSync(backupRoot).isDirectory()) throw failure('The backup location is not a directory.');
    if (!termux || bun) throw failure('This compatibility repair needs Node.js on the affected Termux installation.');
    const marker = path.join(root, '_termux-file-identity.json');
    try {
        fs.lstatSync(marker);
        throw failure('This data folder already has an identity policy. Use the ordinary account repair if it is suitable.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const probe = await probeTermuxFileIdentity(root);
    if (!probe.fallback) throw failure('This filesystem did not show the changing creation-time problem. No identity policy was changed.');
    if (!fs.existsSync(path.join(root, '_roleplay'))) throw failure('No protected account store was found.');
    const bases = discoverHandoffAccounts(root, { allowMissingUserRoot: true });
    if (!bases.length) throw failure('No protected accounts were found.');
    const accounts = bases.map(base => withOwnedOfflineRoleplayAccount(owner, base, lease => {
        const held = roleplayLease(lease);
        let missingRoot = false;
        try { fs.lstatSync(base.directories.root); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            missingRoot = true;
        }
        if (missingRoot && held.state.status !== 'deleted') throw failure('An active account folder is missing. Its evidence was left untouched.');
        const checked = inspectTransferredRoleplayLocked(lease);
        if (held.state.pending?.kind === 'account-reset' || Object.values(held.state.accountResets ?? {}).some(receipt => receipt.phase !== 'complete')) {
            throw failure('An account reset is unfinished. Keep its evidence and resolve it before compatibility repair.');
        }
        inspectSurvivingResets(base, held.state);
        if (checked.report.issues.length) throw failure('An account has invalid files; inspect its normal repair report before continuing.');
        return { owner: base.owner, accountHash: path.basename(roleplayStoreDirectory(base)), accountId: held.state.accountId,
            storageId: held.state.storageId, status: held.state.status, dataEpoch: held.state.dataEpoch,
            identityHash: held.identityFile.rawHash, stateHash: held.stateFile.rawHash, report: checked.report };
    }));
    const inventory = inventoryIdentityRepairRoot(root);
    const rootStat = fs.statSync(root, { bigint: true });
    if (String(rootStat.dev) !== probe.device || inventory.files.some(file => file.dev !== probe.device)
        || inventory.directories.some(directory => directory.dev !== probe.device)) {
        throw failure('The data folder contains another filesystem. Its files were left untouched.');
    }
    const input = { version: 1, root, rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) }, backupRoot,
        device: probe.device, accounts, inventory };
    const bytes = inventory.files.reduce((sum, file) => sum + BigInt(file.size), 0n);
    return { input, token: roleplayHash(input), bytes: String(bytes) };
}
