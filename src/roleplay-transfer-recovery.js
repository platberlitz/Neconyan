import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import { parseChatJsonl } from './chat-recovery.js';
import { USER_DIRECTORY_TEMPLATE } from './constants.js';
import { FILE_WRITE_RECOVERY_MAX_BYTES, FILE_WRITE_RECOVERY_SUFFIX, fsyncDirectorySync } from './util.js';
import { normaliseRoleplayLocator, normaliseRoleplayGroupId, roleplayChatPath, roleplayContentHash, roleplayEntityContent,
    roleplayParsedContentHash } from './generation/roleplay-source.js';
import { confirmRoleplayAccount, createRoleplayDirectory, inspectRoleplayFile, readRoleplayFile, readRoleplayWriteJournal,
    roleplayAvatarOwner, roleplayError, roleplayHash, roleplayLease, roleplayLockCleanupFailed, roleplayPathKey, roleplayStoreDirectory,
    saveRoleplayAccount, withRoleplayAccount } from './roleplay-store.js';

const FILE_LIMIT = Math.max(64 * 1024 * 1024, FILE_WRITE_RECOVERY_MAX_BYTES);
const FILE_COUNT_LIMIT = 100000;
// Retained import uploads and saved downloads are binary copies of up to 8 GiB owned by
// their operation records, not Roleplay evidence. Repair never rewrites or moves them.
const OPERATION_BINARY_DIRECTORIES = new Set(['_roleplay/application-inputs', '_roleplay/application-binaries']);
const changed = () => roleplayError('ROLEPLAY_RECOVERY_CHANGED', 'The files changed after the check. Check transferred data again.');

function checked(relative, read) {
    try { return read(); } catch (error) {
        if (error.code !== 'ROLEPLAY_STORE_DAMAGED') throw error;
        throw Object.assign(roleplayError(error.code, `Repair cannot check ${relative}: it is a link, larger than ${Math.floor(FILE_LIMIT / 1024 / 1024)} MB,`
            + ' or changed while it was read. Nothing was changed.'), { protectedRead: error.protectedRead });
    }
}

/** Includes staged writes and journals, but never follows links or copies live locks. */
function inventory(lease, strictLocks = false) {
    const { scope, root } = roleplayLease(lease);
    const files = [];
    const walk = (directory, prefix, library) => {
        // Validate every parent through the protected reader, including empty directories.
        checked(prefix, () => readRoleplayFile(path.join(directory, '.neconyan-recovery-check'), 0, { allowMissingParent: true }));
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            const lockArtifact = strictLocks ? /^\.neconyan-chat-[a-f0-9]{64}\.lock(?:\.owner)?$/.test(entry.name)
                : entry.name.endsWith('.lock') || entry.name.endsWith('.lock.owner');
            if (lockArtifact) {
                if (strictLocks) {
                    const stat = fs.lstatSync(filename);
                    if (stat.isSymbolicLink() || (stat.isDirectory() ? fs.readdirSync(filename).length > 0 : !stat.isFile() || stat.nlink !== 1)) throw relocationChanged();
                }
                continue;
            }
            const relative = path.posix.join(prefix, entry.name);
            if (entry.isDirectory()) {
                if (!OPERATION_BINARY_DIRECTORIES.has(relative)) walk(filename, relative, library);
            } else {
                const file = checked(relative, () => readRoleplayFile(filename, FILE_LIMIT));
                if (!file) throw changed();
                files.push({ filename, relative, library, rawHash: file.rawHash, physical: file.physical, size: file.bytes.length });
                if (files.length > FILE_COUNT_LIMIT) throw roleplayError('ROLEPLAY_RECOVERY_LIMIT', 'There are too many files for one repair.', 413);
            }
        }
    };
    for (const key of ['characters', 'groups', 'chats', 'groupChats']) walk(scope.directories[key], key, key);
    walk(root, '_roleplay', null);
    return files;
}

function inspect(lease) {
    const { state, stateFile } = roleplayLease(lease);
    const files = inventory(lease);
    const entries = [];
    // Issues block repair (a broken group breaks the whole group list); skipped files stay
    // untracked and unchanged on disk while everything healthy is adopted.
    const issues = [];
    const skipped = [];
    const warnings = [];
    const groups = [];
    const avatars = new Map();
    for (const file of files.filter(file => file.library === 'characters' && /^characters\/[^/]+\.png$/.test(file.relative))) {
        const avatar = path.basename(file.relative);
        const owner = roleplayAvatarOwner(avatar);
        if (avatars.has(owner)) issues.push({ file: file.relative, reason: 'More than one character uses this chat folder.' });
        avatars.set(owner, avatar);
    }
    for (const file of files) {
        const parts = file.relative.split('/');
        let kind, locator, id;
        if (file.library === 'characters' && parts.length === 2 && parts[1].endsWith('.png')) kind = 'character';
        else if (file.library === 'groups' && parts.length === 2 && parts[1].endsWith('.json')) kind = 'group';
        else if (file.library === 'groupChats' && parts.length === 2 && parts[1].endsWith('.jsonl')) kind = 'chat';
        else if (file.library === 'chats' && parts.length === 3 && parts[2].endsWith('.jsonl')) kind = 'chat';
        else continue;
        const report = kind === 'group' ? issues : skipped;
        try {
            if (kind === 'character') {
                id = parts[1];
                normaliseRoleplayLocator({ group: false, chat: 'check', avatar: id });
                locator = { avatar: id };
            } else if (kind === 'group') {
                id = normaliseRoleplayGroupId(parts[1].slice(0, -5)); locator = { groupId: id };
            } else if (file.library === 'groupChats') {
                locator = normaliseRoleplayLocator({ group: true, chat: parts[1].slice(0, -6) });
            } else {
                locator = normaliseRoleplayLocator({ group: false, avatar: avatars.get(parts[1]) ?? parts[1] + '.png', chat: parts[2].slice(0, -6) });
            }
        } catch (error) {
            if (error.code !== 'ROLEPLAY_INVALID') throw error;
            report.push({ file: file.relative, reason: 'The file name ends with a space or a full stop, or uses characters Neconyan cannot save. Rename it, then check again.' });
            continue;
        }
        try {
            if (file.library === 'chats' && !avatars.has(parts[1])) {
                warnings.push({ file: file.relative, reason: 'The character card is missing. Import it to show this chat in the character list.' });
            }
            // Adopt only files the ordinary protected readers can open afterwards.
            const current = readRoleplayFile(file.filename, 64 * 1024 * 1024);
            if (!current || current.rawHash !== file.rawHash || !isDeepStrictEqual(current.physical, file.physical)) throw changed();
            let contentHash;
            if (kind === 'chat') {
                const parsed = parseChatJsonl(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes));
                if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'The chat is incomplete or is not valid chat JSONL.');
                contentHash = roleplayContentHash(parsed.records);
            } else {
                const parsed = roleplayEntityContent(kind, id, current.bytes, { storage: true });
                contentHash = parsed.contentHash;
                if (kind === 'group') groups.push({ file: file.relative, data: parsed.data });
            }
            entries.push({ kind, locator, head: { rawHash: file.rawHash, physical: file.physical, contentHash, writeId: null } });
        } catch (error) {
            if (error.code === 'ROLEPLAY_RECOVERY_CHANGED') throw error;
            report.push({ file: file.relative, reason: error.reason ?? (error.code?.startsWith('ROLEPLAY_') ? error.message : 'The file could not be decoded.') });
        }
    }
    // A chat left out of repair still exists; it is listed as skipped, not missing.
    const groupChats = new Set(files.filter(file => file.library === 'groupChats' && /^groupChats\/[^/]+\.jsonl$/.test(file.relative))
        .map(file => path.posix.basename(file.relative, '.jsonl')));
    for (const group of groups) {
        for (const avatar of group.data.members ?? []) {
            if (![...avatars.values()].includes(avatar)) warnings.push({ file: group.file, reason: `Missing character card: ${avatar}` });
        }
        for (const chat of group.data.chats ?? []) {
            if (!groupChats.has(String(chat))) warnings.push({ file: group.file, reason: `Missing chat file: ${chat}` });
        }
    }
    const counts = { chats: 0, characters: 0, groups: 0 };
    for (const entry of entries) counts[{ chat: 'chats', character: 'characters', group: 'groups' }[entry.kind]]++;
    const token = roleplayHash({ state: stateFile.rawHash, files, entries });
    return { files, entries, report: { token, counts, issues, skipped, warnings, canRepair: entries.length > 0 && issues.length === 0,
        pending: state.pending?.kind ?? null, lastRepair: state.transferRecovery?.dataEpoch === state.dataEpoch ? state.transferRecovery : null } };
}

export function inspectTransferredRoleplay(base) {
    return withRoleplayAccount(base, null, lease => inspect(lease).report);
}

/** Offline callers hold a validated account lease; this does not publish or retire journals. */
export function inspectTransferredRoleplayLocked(lease) {
    return inspect(lease);
}

/** Build the exact replacement state without mutating the active ledger. */
export function prepareTransferredRoleplayState(lease, checked, receipt, instanceIds, device = null) {
    const { state, identityFile } = roleplayLease(lease);
    if (!checked || !receipt || receipt.token !== checked.report.token || receipt.dataEpoch !== state.dataEpoch + 1
        || checked.report.issues.length || !Array.isArray(instanceIds)) throw changed();
    const entries = state.status === 'deleted' ? [] : checked.entries;
    if (instanceIds.length !== entries.length || new Set(instanceIds).size !== instanceIds.length
        || instanceIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) throw changed();
    const project = physical => {
        if (device === null) return structuredClone(physical);
        if (physical.dev !== device) throw roleplayError('ROLEPLAY_RECOVERY_INVALID', 'A protected file is on another filesystem. Its data was left untouched.', 409);
        return { ...physical, birthtimeNs: '0' };
    };
    const next = structuredClone(state);
    next.dataEpoch++;
    next.paths = {}; next.resources = {}; next.submissions = {}; next.pending = null;
    next.accountResets = {};
    next.placement = project(identityFile.physical);
    next.transferRecovery = { ...structuredClone(receipt), journals: receipt.journals.map(journal => ({ ...journal, physical: project(journal.physical) })) };
    const physicals = new Set();
    for (const [index, entry] of entries.entries()) {
        const instanceId = instanceIds[index];
        const physical = project(entry.head.physical);
        const key = JSON.stringify(physical);
        if (physicals.has(key)) throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Protected files have conflicting identities. Their data was left untouched.', 409);
        physicals.add(key);
        next.paths[roleplayPathKey(next, entry.kind, entry.locator)] = { generation: 1, instanceId };
        next.resources[instanceId] = { ...entry, head: { ...entry.head, physical }, accountId: next.accountId, dataEpoch: next.dataEpoch,
            status: 'live', revision: 1, busySubmission: null };
    }
    return next;
}

const relocationChanged = () => roleplayError('ROLEPLAY_RECOVERY_CHANGED', 'Roleplay storage changed while its new folder was being checked. Nothing was changed.');
const relocationCollision = () => roleplayError('ROLEPLAY_SOURCE_CHANGED', 'Relocated Roleplay storage has conflicting file identities. Nothing was changed.');

function handoffDiagnostic(stage, error, reason = 'validation-refused') {
    return { stage, reason: error?.protectedRead?.reason ?? reason,
        ...(error?.protectedRead ? { changedFields: error.protectedRead.changedFields } : {}) };
}

function handoffRefusal(stage, reason, error = relocationChanged()) {
    return Object.assign(error, { handoffDiagnostic: handoffDiagnostic(stage, error, reason) });
}


function relocationFilename(scope, resource) {
    if (resource.kind === 'chat') return roleplayChatPath(scope, resource.locator);
    return path.join(resource.kind === 'character' ? scope.directories.characters : scope.directories.groups,
        resource.kind === 'character' ? resource.locator.avatar : resource.locator.groupId + '.json');
}

/** The exact content hash the ledger would have stored for these bytes. */
function relocationContentHash(resource, bytes) {
    if (resource.kind === 'chat') {
        const parsed = parseChatJsonl(bytes);
        if (parsed.status !== 'ok') throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A relocated Roleplay chat could not be read.');
        return roleplayParsedContentHash(parsed.records);
    }
    const id = resource.kind === 'character' ? resource.locator.avatar : resource.locator.groupId;
    return roleplayEntityContent(resource.kind, id, bytes, { storage: true }).contentHash;
}

/**
 * One protected read of a live resource. The cheap inspection settles the common
 * unchanged case from the exact raw hash and physical identity without parsing. Only a
 * file with the stored raw bytes at a new physical identity is read again and parsed to
 * prove the stored content hash and size. Every unreadable, linked, oversized,
 * journal-backed or changed file is a conservative refusal, never a rebind.
 */
function observeRelocation(scope, state, instanceId, resource, verifyContent = false) {
    if (state.paths[roleplayPathKey(state, resource.kind, resource.locator)]?.instanceId !== instanceId) return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', null, 'path-index') };
    try {
        const filename = relocationFilename(scope, resource);
        if (readRoleplayWriteJournal(filename, { allowMissingParent: true })) return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', null, 'write-journal') };
        const inspection = inspectRoleplayFile(filename, FILE_LIMIT, { allowMissingParent: true });
        if (!inspection) return { outcome: 'refused', missing: true, diagnostic: handoffDiagnostic('resource', null, 'missing-file') };
        if (inspection.rawHash !== resource.head.rawHash) return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', null, 'content-changed') };
        if (!verifyContent && isDeepStrictEqual(inspection.physical, resource.head.physical)) return { outcome: 'match' };
        // The same exact bytes now have a different physical identity. Read them through the
        // protected reader once more and require both observations to agree before parsing.
        let file, contentHash;
        try {
            if (readRoleplayWriteJournal(filename, { allowMissingParent: true })) return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', null, 'write-journal') };
            file = readRoleplayFile(filename, FILE_LIMIT, { allowMissingParent: true });
            if (!file) return { outcome: 'refused', missing: true, diagnostic: handoffDiagnostic('resource', null, 'missing-file') };
            if (file.rawHash !== inspection.rawHash || file.bytes.length !== inspection.size
                || !isDeepStrictEqual(file.physical, inspection.physical)) throw relocationChanged();
            contentHash = relocationContentHash(resource, file.bytes);
        } catch (error) {
            if (error?.code === 'ROLEPLAY_RECOVERY_CHANGED') throw error;
            return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', error) };
        }
        if (contentHash !== resource.head.contentHash) return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', null, 'content-changed') };
        return { outcome: 'relocated', instanceId, filename, physical: file.physical, rawHash: file.rawHash,
            contentHash, size: file.bytes.length };
    } catch (error) {
        if (error?.code === 'ROLEPLAY_RECOVERY_CHANGED') throw error;
        return { outcome: 'refused', diagnostic: handoffDiagnostic('resource', error) };
    }
}

/**
 * Only current live resources claim a final physical identity. Deleted, replaced and
 * earlier-epoch records keep their evidence but no longer own files, so stale inode
 * numbers must not block a moved copy. A refused live resource is compared by its
 * recorded head because it still owns its path; a candidate must not take that identity.
 * A moving candidate's old head is never treated as its final identity.
 */
function assertRelocationCollision(observations, candidates) {
    const final = new Map(observations.map(observation => [observation.instanceId, observation.outcome === 'relocated'
        ? observation.physical : observation.resource.head.physical]));
    const incoming = new Set();
    for (const candidate of candidates) {
        const identity = JSON.stringify(candidate.physical);
        if (incoming.has(identity)) throw relocationCollision();
        incoming.add(identity);
    }
    for (const candidate of candidates) {
        for (const [instanceId, physical] of final) {
            if (instanceId !== candidate.instanceId && isDeepStrictEqual(physical, candidate.physical)) throw relocationCollision();
        }
    }
}

/** Guard against files changing between the scan and the single ledger publication. */
function assertRelocationStable(candidates) {
    for (const candidate of candidates) {
        if (readRoleplayWriteJournal(candidate.filename, { allowMissingParent: true })) throw relocationChanged();
        const file = inspectRoleplayFile(candidate.filename, FILE_LIMIT, { allowMissingParent: true });
        if (!file || file.rawHash !== candidate.rawHash || file.size !== candidate.size
            || !isDeepStrictEqual(file.physical, candidate.physical)) throw relocationChanged();
    }
}

/** Physical discovery includes disabled accounts; the user database is not authority here. */
export function discoverHandoffAccounts(dataRoot, { allowMissingUserRoot = false } = {}) {
    const protectedRoot = path.join(dataRoot, '_roleplay');
    return fs.readdirSync(protectedRoot).sort().map(name => {
        if (!/^[a-f0-9]{64}$/.test(name)) throw relocationChanged();
        const root = path.join(protectedRoot, name);
        const file = readRoleplayFile(path.join(root, 'identity.json'), 4096);
        if (!file) throw relocationChanged();
        const identity = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
        const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE)
            .map(([key, relative]) => [key, path.join(dataRoot, identity.owner, relative)]));
        const base = { owner: identity.owner, directories };
        if (roleplayStoreDirectory(base) !== root) throw relocationChanged();
        // Do not create a missing account root to make the handoff appear complete.
        readRoleplayFile(path.join(directories.root, '.neconyan-handoff-check'), 0, { allowMissingParent: allowMissingUserRoot });
        return base;
    });
}

function observeCleanHandoff(lease, device) {
    const { state, scope, root, identityFile, stateFile } = roleplayLease(lease);
    if (state.pending || Object.values(state.accountResets ?? {}).some(receipt => receipt.phase !== 'complete')) {
        throw handoffRefusal('account', 'unfinished-operation');
    }
    if (!state.placement || (state.placement.dev === identityFile.physical.dev && state.placement.ino === identityFile.physical.ino)) {
        throw handoffRefusal('account', 'placement-unproven');
    }
    // All active libraries participate, including journals belonging to untracked files.
    // Backups beneath the protected store are historical evidence, not active journals.
    let files;
    try { files = inventory(lease, true); } catch (error) { throw handoffRefusal('inventory', 'unreadable-evidence', error); }
    if (files.some(file => file.library && file.relative.endsWith(FILE_WRITE_RECOVERY_SUFFIX))) throw handoffRefusal('inventory', 'write-journal');
    const observations = [];
    for (const [instanceId, resource] of Object.entries(state.resources)) {
        if (resource.status !== 'live' || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch) continue;
        const observed = observeRelocation(scope, state, instanceId, resource, true);
        if (observed.outcome !== 'relocated') throw Object.assign(relocationChanged(), { handoffDiagnostic: observed.diagnostic });
        observations.push({ instanceId, resource, ...observed });
    }
    assertRelocationCollision(observations, observations);
    const projected = observations.map(item => ({ ...item, physical: { ...item.physical,
        birthtimeNs: item.physical.dev === device ? '0' : item.physical.birthtimeNs } }));
    assertRelocationCollision(projected, projected);
    // This confirmation is deliberately read-only: ordinary confirmation may retire
    // historical repair journals. No cleanup authority is granted by this preflight.
    for (const [name, expected] of [['identity.json', identityFile], ['state.json', stateFile]]) {
        if (readRoleplayWriteJournal(path.join(root, name))) throw relocationChanged();
        const current = readRoleplayFile(path.join(root, name));
        if (!current || current.rawHash !== expected.rawHash || !isDeepStrictEqual(current.physical, expected.physical)) throw relocationChanged();
    }
    return { files, observations };
}

/**
 * Publish only the existing stable-policy marker, under every account lease and the
 * original raw policy. Ordinary startup later reconnects each ledger atomically.
 * Validation refusals return false; publication and lock-cleanup errors must escape.
 */
export function publishCleanTermuxHandoff(dataRoot, device, publish, report = () => {}) {
    const attempt = () => {
        let refusal;
        const refused = (error, stage) => {
            if (roleplayLockCleanupFailed(error)) throw error;
            refusal = error?.handoffDiagnostic ?? handoffDiagnostic(stage, error);
            return false;
        };
        let accounts;
        try { accounts = discoverHandoffAccounts(dataRoot); } catch (error) {
            refused(error, 'discovery');
            return { published: false, refusal };
        }
        if (!accounts.length) return { published: false, refusal: handoffDiagnostic('discovery', null, 'no-accounts') };
        const held = [];
        let publishing = false;
        const lockNext = index => {
            if (index < accounts.length) return withRoleplayAccount(accounts[index], null, lease => {
                let observation;
                try { observation = observeCleanHandoff(lease, device); } catch (error) { return refused(error, 'validation'); }
                held.push({ lease, observation });
                return lockNext(index + 1);
            });
            try {
                for (const { lease, observation } of held) {
                    if (!isDeepStrictEqual(observeCleanHandoff(lease, device), observation)) throw relocationChanged();
                }
                if (!isDeepStrictEqual(discoverHandoffAccounts(dataRoot), accounts)) throw relocationChanged();
            } catch (error) { return refused(error, 'confirmation'); }
            publishing = true;
            publish();
            return true;
        };
        let published;
        try { published = lockNext(0); } catch (error) {
            // Publication and every lease-cleanup failure escape without retrying.
            if (publishing || roleplayLockCleanupFailed(error)
                || !['ROLEPLAY_STORE_DAMAGED', 'ROLEPLAY_ACCOUNT_UNAVAILABLE'].includes(error?.code)) throw error;
            published = refused(error, 'account-load');
        }
        return { published, refusal };
    };
    for (let number = 1; number <= 2; number++) {
        // Returning from attempt proves all raw-policy leases were released. No
        // rejected observation is reused, and publication is never retried.
        const { published, refusal } = attempt();
        if (published) return true;
        const retry = number === 1 && refusal.reason === 'metadata-changed';
        report({ attempt: number, ...refusal, retry });
        if (!retry) return false;
    }
    return false;
}

/**
 * Startup-only reconnection for a stopped copy of a whole data folder. identity.json
 * is written once when the account is created, so its physical identity witnesses the
 * folder placement. A matching marker is a no-op. A moved marker may update only the
 * physical identity of live resources whose exact stored content and size still match,
 * keeping instance ids, revisions, write ids, source bytes, account ids, data epochs,
 * receipts, jobs and scratchpad links. Missing, changed, linked, oversized or
 * journal-backed resources keep their recorded identity and stay refused. While no file
 * proves a moved placement, missing files leave it unrecorded so a later completed copy
 * can reconnect; the first candidate seals it and other refusals do not keep it open.
 * Any physical collision aborts the whole reconnection; one atomic ledger publication
 * follows the re-inspection of every candidate. An unfinished transaction changes nothing.
 */
export function reconnectRelocatedRoleplay(base) {
    return withRoleplayAccount(base, null, lease => {
        const { state, scope, identityFile } = roleplayLease(lease);
        const placement = identityFile.physical;
        if (isDeepStrictEqual(state.placement, placement)) return { status: 'in-place', rebound: 0, retained: 0 };
        if (state.pending) {
            console.warn('Roleplay storage relocation was not checked because an earlier operation is unfinished.');
            return { status: 'pending', rebound: 0, retained: 0 };
        }
        const observations = [];
        for (const [instanceId, resource] of Object.entries(state.resources)) {
            if (resource.status !== 'live' || resource.accountId !== state.accountId || resource.dataEpoch !== state.dataEpoch) continue;
            observations.push({ instanceId, resource, ...observeRelocation(scope, state, instanceId, resource) });
        }
        const candidates = observations.filter(item => item.outcome === 'relocated');
        const matches = observations.filter(item => item.outcome === 'match').length;
        // A ledger written before placement existed seeds the marker only when at least
        // one live identity still matches. Mixed matching and mismatching evidence must
        // not rebind the mismatches: without an old marker they are indistinguishable from
        // same-path replacements. Empty records seed the marker as well.
        if (state.placement === undefined && (matches > 0 || observations.length === 0)) {
            state.placement = placement;
            confirmRoleplayAccount(lease);
            saveRoleplayAccount(lease);
            confirmRoleplayAccount(lease);
            const retained = observations.length - matches;
            return { status: 'seeded', rebound: 0, retained };
        }
        // No live file matched and none can be rebound. Recording the new placement here
        // would seal it while every tracked file is still unresolved, so a transfer that
        // finishes later could never reconnect. Leave the ledger untouched and let a later
        // startup prove the move from exact files. This applies to legacy and moved
        // placements; a candidate that proves itself seals below even if other files
        // are still missing.
        if (observations.length > 0 && candidates.length === 0 && matches === 0) {
            console.warn(`Roleplay storage could not prove a moved folder; ${observations.length} protected `
                + `${observations.length === 1 ? 'file stays' : 'files stay'} refused.`);
            return { status: 'unverified', rebound: 0, retained: observations.length };
        }
        assertRelocationCollision(observations, candidates);
        // Missing files are the one unresolved kind that a completed copy can still supply.
        // While no candidate proves the new placement, write nothing: sealing it would strand
        // them. Once a candidate exists the move is proven, so the operation seals and leaves
        // still-missing files refused. This bounded wait is not a blanket same-path adoption
        // window: nothing is adopted while it is open, and the first exact proof closes it.
        const missing = observations.filter(item => item.outcome === 'refused' && item.missing).length;
        if (missing && candidates.length === 0) {
            console.warn(`Roleplay storage relocation is waiting for ${missing} protected `
                + `${missing === 1 ? 'file that is' : 'files that are'} not present yet; nothing was changed.`);
            return { status: 'incomplete', rebound: 0, retained: observations.length - matches };
        }
        confirmRoleplayAccount(lease);
        assertRelocationStable(candidates);
        for (const candidate of candidates) state.resources[candidate.instanceId].head.physical = candidate.physical;
        state.placement = placement;
        saveRoleplayAccount(lease);
        confirmRoleplayAccount(lease);
        const retained = observations.length - candidates.length - matches;
        if (candidates.length) {
            console.info(`Roleplay storage was moved; reconnected ${candidates.length} protected ${candidates.length === 1 ? 'file' : 'files'}.`);
        }
        if (retained) {
            console.warn(`Roleplay storage was moved; ${retained} protected ${retained === 1
                ? 'file keeps its recorded identity and stays refused'
                : 'files keep their recorded identities and stay refused'}.`);
        }
        return { status: 'moved', rebound: candidates.length, retained };
    });
}

function writeBackupFile(filename, bytes, root) {
    createRoleplayDirectory(path.dirname(filename), root);
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDirectorySync(path.dirname(filename));
}

/**
 * Explicit adoption, never an ordinary read fallback. No user file is rewritten.
 * A durable independent backup precedes one atomic ledger publication, so an
 * interruption leaves either the old authority or the complete new authority.
 * The epoch fences captured saves/jobs; orphaned native markers are not authority.
 */
export function repairTransferredRoleplay(base, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw changed();
    return withRoleplayAccount(base, null, lease => {
        confirmRoleplayAccount(lease);
        const { state, scope, root } = roleplayLease(lease);
        if (state.transferRecovery?.token === token && state.transferRecovery.dataEpoch === state.dataEpoch) return state.transferRecovery;
        const checked = inspect(lease);
        if (checked.report.token !== token) throw changed();
        if (!checked.report.canRepair) throw roleplayError('ROLEPLAY_RECOVERY_INVALID', 'Some files need attention. Review the check before repairing.', 422);
        const backupId = crypto.randomUUID();
        const dataRoot = path.dirname(scope.directories.root);
        const backup = path.join(dataRoot, '_roleplay-recovery', path.basename(root), backupId);
        createRoleplayDirectory(backup, dataRoot);
        for (const file of checked.files) {
            const current = readRoleplayFile(file.filename, FILE_LIMIT);
            if (!current || current.rawHash !== file.rawHash || !isDeepStrictEqual(current.physical, file.physical)) throw changed();
            writeBackupFile(path.join(backup, file.relative), current.bytes, dataRoot);
        }
        const journals = checked.files.filter(file => file.library && file.relative.endsWith(FILE_WRITE_RECOVERY_SUFFIX))
            .map(({ relative, library, rawHash, physical }) => ({ relative, library, rawHash, physical }));
        const receipt = { token, backup, dataEpoch: state.dataEpoch + 1, counts: checked.report.counts,
            skipped: checked.report.skipped.length, repairedAt: new Date().toISOString(), journals };
        writeBackupFile(path.join(backup, 'manifest.json'), JSON.stringify({ ...receipt, owner: scope.owner, accountId: state.accountId,
            previousEpoch: state.dataEpoch, files: checked.files, skipped: checked.report.skipped, warnings: checked.report.warnings }), dataRoot);
        // Cooperating writers hold this lock; check again for manual copying during the backup.
        if (inspect(lease).report.token !== token) throw changed();
        confirmRoleplayAccount(lease);
        // Old evidence remains in the backup, including unfinished operations and their payloads.
        // Removing receipts here also prevents old receipt cleanup from touching retained journals.
        const prepared = prepareTransferredRoleplayState(lease, checked, receipt, checked.entries.map(() => crypto.randomUUID()));
        Object.assign(state, prepared);
        saveRoleplayAccount(lease);
        confirmRoleplayAccount(lease);
        return receipt;
    });
}
