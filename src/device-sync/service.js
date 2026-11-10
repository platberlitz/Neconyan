import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { categories, decrypt, encrypt, fail, hash, METHODS, reconcile } from './protocol.js';
import { currentEntry, publishEntry, snapshotHash, snapshotLocked, validateData, discardEntryStage, dependencyEntries, currentDependencies } from './data.js';
import { accountKey, publicState, requireMethod, withSync } from './store.js';

const active = new Map();
const secretHash = secret => hash(Buffer.from(secret));
export const readSyncState = (base, account) => withSync(base, account, ({ state }) => publicState(state));

export function configureSync(base, account, input) {
    return withSync(base, account, ({ state, save }) => {
        if (input.categories !== undefined) state.categories = categories(input.categories);
        if (input.passphrase !== undefined) {
            if (typeof input.passphrase !== 'string' || input.passphrase.length < 12 || Buffer.byteLength(input.passphrase) > 1024) throw fail('Use a shared passphrase of 12 to 1024 characters.');
            state.passphrase = input.passphrase;
        }
        if (input.method !== undefined) {
            if (!METHODS.includes(input.method) || typeof input.enabled !== 'boolean') throw fail('Choose a supported sync method.');
            const method = state.methods[input.method];
            method.enabled = input.enabled;
            if (input.config) Object.assign(method, input.config);
            if (input.method === 'pairing' && !input.enabled) state.grants = {};
        }
        state.revision += 1;
        save();
        for (const [key, controller] of active) if (key.startsWith(accountKey(base) + ':')) controller.abort();
        return publicState(state);
    });
}

export async function manualSync(base, account, method, operation) {
    const key = accountKey(base) + ':' + method;
    if (active.has(key)) throw fail('This sync method is already running.', 409);
    const controller = new AbortController();
    const captured = withSync(base, account, ({ state }) => { requireMethod(state, method); return { revision: state.revision, config: structuredClone(state.methods[method]), passphrase: state.passphrase }; });
    if (!captured.passphrase) throw fail('Save the same shared passphrase on both installations first.');
    active.set(key, controller);
    const guard = () => {
        controller.signal.throwIfAborted();
        return withSync(base, account, ({ state }) => { requireMethod(state, method, captured.revision); return true; });
    };
    const context = { base, account, method, ...captured, signal: controller.signal, guard };
    try {
        const result = await operation(context);
        guard();
        withSync(base, account, ({ state, save }) => {
            const summary = { ...result }; delete summary.envelope;
            state.lastResult = { method, at: new Date().toISOString(), ok: true, ...summary }; save();
        });
        return result;
    } catch (error) {
        // Only publish safe summaries, never provider bodies, URLs, tokens or account paths.
        try {
            withSync(base, account, ({ state, save }) => {
                state.lastResult = { method, at: new Date().toISOString(), ok: false, error: error.syncSafe ? error.message : 'Sync stopped safely. Check the connection and try again.' }; save();
            });
        } catch { /* A reset or deletion must not recreate account data. */ }
        throw error;
    } finally { active.delete(key); }
}

export async function exportEnvelope(context) {
    context.guard();
    const snapshot = withSync(context.base, context.account, ({ lease, state, save }) => {
        requireMethod(state, context.method, context.revision);
        const value = snapshotLocked(lease, state.deviceId, state.sequence + 1, state.categories);
        state.exported ??= {};
        state.exportedRevisions ??= {};
        for (const item of value.entries) {
            // A receiver can recognise its own previously shared content when a
            // different device returns a one-sided edit. Unknown history never
            // authorises replacing differing local data.
            const bases = new Map();
            for (const target of Object.values(state.targets)) {
                const accepted = target.accepted[item.path];
                const previous = bases.get(target.deviceId);
                if (target.deviceId && accepted && (!previous || (accepted.remoteSequence ?? 0) > (previous.sequence ?? 0))) {
                    bases.set(target.deviceId, { deviceId: target.deviceId, hash: accepted.remote,
                        ...(accepted.remoteSequence ? { sequence: accepted.remoteSequence } : {}) });
                }
            }
            if (bases.size) item.bases = [...bases.values()].slice(-8);
            state.exported[item.path] = [...new Set([...(state.exported[item.path] ?? []), item.hash])].slice(-8);
            state.exportedRevisions[item.path] = [...(state.exportedRevisions[item.path] ?? []), { sequence: value.sequence, hash: item.hash }].slice(-8);
        }
        state.sequence += 1; save(); return value;
    });
    const envelope = await encrypt(snapshot, context.passphrase);
    context.guard();
    return envelope;
}

function acceptedHistory(state, local, remote, remoteSequence) {
    return { local, remote, exportedThrough: state.sequence, ...(remoteSequence ? { remoteSequence } : {}) };
}

function preserveConflict(state, target, method, local, remote, companions = {}, remoteSequence) {
    const id = hash(Buffer.from(JSON.stringify([target, remote.path, local?.hash ?? null, remote.hash,
        (companions.local ?? []).map(item => [item.path, item.hash]), (companions.remote ?? []).map(item => [item.path, item.hash])])));
    if (Object.keys(state.conflicts).length >= 1000 && !state.conflicts[id]) throw fail('Download and remove resolved preserved copies before importing more conflicts.', 413);
    for (const [previousId, previous] of Object.entries(state.conflicts)) {
        if (previousId !== id && previous.target === target && previous.remote.path === remote.path && !previous.resolved) {
            previous.resolved = true; previous.superseded = true;
        }
    }
    state.conflicts[id] ??= { target, method, local, remote, companions };
    state.conflicts[id].remoteSequence = remoteSequence;
    // The same pair can diverge again after somebody deliberately restores old
    // content. Its preserved bytes are reusable, but the decision must be fresh.
    state.conflicts[id].resolved = false;
    delete state.conflicts[id].superseded;
    return id;
}

/** The journal is durable before any file is published. A later local edit always becomes a conflict. */
function finishJournal({ lease, state, save }, method) {
    const journal = state.journal;
    if (!journal) return { imported: 0, conflicts: 0, unchanged: 0 };
    if (journal.method !== method) throw fail('Finish the interrupted sync using its original method first.', 409);
    const target = state.targets[journal.target];
    for (; journal.next < journal.items.length; journal.next++) {
        const item = journal.items[journal.next];
        if (!state.categories.includes(item.remote.category)) throw fail('Select the original data categories before recovering or resolving this transfer.', 409);
        const current = currentEntry(lease, item.remote.path);
        const localHash = current?.hash ?? null;
        const parents = item.companions?.remote ?? [];
        if (parents.some(parent => !state.categories.includes(parent.category) && currentEntry(lease, parent.path)?.hash !== parent.hash)) throw fail('This chat requires its persona and avatar. Select Personas and avatars on this installation before importing.', 409);
        const localParents = parents.map(parent => currentEntry(lease, parent.path)).filter(Boolean);
        const changedParent = parents.some(parent => !localParents.some(local => local.path === parent.path && local.hash === parent.hash));
        if (changedParent || localHash !== item.before && localHash !== item.remote.hash) {
            preserveConflict(state, journal.target, method, current, item.remote, { ...item.companions, local: currentDependencies(lease, current, [...parents, item.remote]) }, journal.sequence);
            discardEntryStage(lease, item.effect);
            journal.result.conflicts += 1;
        } else {
            item.effect ??= {};
            publishEntry(lease, item.remote, item.effect, `device-sync:${journal.id}:${journal.next}`, save);
            target.accepted[item.remote.path] = acceptedHistory(state, item.remote.hash, item.remote.hash, journal.sequence);
            journal.result.imported += 1;
        }
        // Save cursor with the effect; after a crash, re-reading the desired hash is harmless.
        journal.next += 1; save(); journal.next -= 1;
    }
    const result = journal.result;
    if (journal.resolution && !result.conflicts) state.conflicts[journal.resolution].resolved = true;
    state.journal = null; save(); return result;
}

export function recoverSync(base, account, method) {
    return withSync(base, account, context => { requireMethod(context.state, method); return finishJournal(context, method); });
}

export async function importEnvelope(context, envelope, targetName) {
    const snapshot = validateData(await decrypt(envelope, context.passphrase));
    context.guard();
    return withSync(context.base, context.account, storage => {
        const { lease, state, save } = storage;
        requireMethod(state, context.method, context.revision);
        if (state.journal) throw fail('An interrupted sync needs recovery before importing another package.', 409);
        if (snapshot.recovery && context.method !== 'file') throw fail('Import preserved recovery packages with Encrypted file.');
        if (!snapshot.recovery && snapshot.deviceId === state.deviceId) return { imported: 0, conflicts: 0, unchanged: snapshot.entries.length, replayed: true };
        const targetKey = hash(Buffer.from(snapshot.recovery ? `recovery:${snapshot.recovery.id}` : `${targetName}:${snapshot.deviceId}`));
        const target = state.targets[targetKey] ??= { accepted: {}, sequence: 0, digest: null };
        target.deviceId = snapshot.deviceId;
        const digest = snapshotHash(snapshot);
        if (snapshot.sequence < target.sequence || snapshot.sequence === target.sequence && digest === target.digest) return { imported: 0, conflicts: 0, unchanged: snapshot.entries.length, replayed: true };
        if (snapshot.sequence === target.sequence) throw fail('This device reused a snapshot sequence with different data.', 409);
        if (Object.keys(state.targets).length > 64) throw fail('The sync target limit has been reached.', 413);
        const result = { imported: 0, conflicts: 0, unchanged: 0 };
        const items = [];
        const selected = snapshot.entries.filter(item => state.categories.includes(item.category));
        for (const remote of selected) for (const parent of dependencyEntries(remote, snapshot.entries)) {
            if (!state.categories.includes(parent.category) && currentEntry(lease, parent.path)?.hash !== parent.hash) throw fail('This chat requires its persona and avatar. Select Personas and avatars on this installation before importing.', 409);
        }
        const plans = new Map(selected.map(remote => {
            const local = currentEntry(lease, remote.path);
            const base = remote.bases?.find(item => item.deviceId === state.deviceId && state.exported?.[remote.path]?.includes(item.hash));
            const accepted = target.accepted[remote.path];
            // Advance stale accepted history only with an exact export that the
            // peer saw after that decision. A matching old hash alone could be
            // a simultaneous local reversion. An unchanged rejected remote
            // version must still honour keep-mine, even with a newer hint.
            const newerShared = base && base.hash === local?.hash && remote.hash !== accepted?.remote
                && Number.isSafeInteger(accepted?.exportedThrough) && base.sequence > accepted.exportedThrough
                && state.exportedRevisions?.[remote.path]?.some(item => item.sequence === base.sequence && item.hash === base.hash);
            const history = snapshot.recovery ? undefined : base && (!accepted || newerShared) ? { local: base.hash, remote: base.hash } : accepted;
            return [remote.path, { local, action: reconcile(local?.hash ?? null, remote.hash, history), remote }];
        }));
        // Parents publish first even if a received manifest lists children first.
        const dependencies = item => dependencyEntries(item, snapshot.entries);
        const depth = item => Math.max(0, ...dependencies(item).map(parent => 1 + depth(parent)));
        selected.sort((a, b) => depth(a) - depth(b));
        for (const remote of selected) {
            if (!state.categories.includes(remote.category)) continue;
            const { local } = plans.get(remote.path);
            let { action } = plans.get(remote.path);
            const parents = dependencies(remote);
            const localParents = currentDependencies(lease, local, snapshot.entries);
            const companions = { local: localParents, remote: parents };
            if (parents.some(parent => {
                const dependency = plans.get(parent.path);
                return dependency && ['conflict', 'local'].includes(dependency.action) && dependency.local?.hash !== parent.hash;
            }) && action === 'incoming') action = 'conflict';
            if (action === 'incoming') items.push({ before: local?.hash ?? null, remote, companions });
            else if (action === 'conflict') { preserveConflict(state, targetKey, context.method, local, remote, companions, snapshot.sequence); result.conflicts += 1; } else {
                result.unchanged += 1;
                if (action === 'equal') target.accepted[remote.path] = acceptedHistory(state, remote.hash, remote.hash, snapshot.sequence);
                else if (target.accepted[remote.path]?.remote === remote.hash) target.accepted[remote.path].remoteSequence = snapshot.sequence;
            }
        }
        target.sequence = snapshot.sequence; target.digest = digest;
        state.journal = { id: randomUUID(), target: targetKey, method: context.method, sequence: snapshot.sequence, items, next: 0, result };
        save();
        return finishJournal(storage, context.method);
    });
}

export function resolveConflict(base, account, id, choice) {
    return withSync(base, account, storage => {
        const { lease, state, save } = storage;
        const conflict = state.conflicts[id];
        if (!conflict || conflict.resolved || !['local', 'incoming'].includes(choice)) throw fail('Choose an unresolved conflict and which version to keep.');
        requireMethod(state, conflict.method);
        if (!state.categories.includes(conflict.remote.category)) throw fail('Select the original data categories before recovering or resolving this transfer.', 409);
        if (state.journal) throw fail('Finish interrupted sync before resolving another conflict.', 409);
        const current = currentEntry(lease, conflict.remote.path);
        if ((current?.hash ?? null) !== (conflict.local?.hash ?? null)) throw fail('This file changed since the conflict was shown. Sync again to review its newer version.', 409);
        // Retain both versions even after resolution, until explicitly discarded by the account owner.
        if (choice === 'incoming') {
            if (conflict.companions?.remote?.some(parent => currentEntry(lease, parent.path)?.hash !== parent.hash)) throw fail('Choose the incoming character card or avatar before applying this dependent copy.', 409);
            state.journal = { id: randomUUID(), resolution: id, target: conflict.target, method: conflict.method, sequence: conflict.remoteSequence, items: [{ before: current?.hash ?? null, remote: conflict.remote, companions: conflict.companions }], next: 0,
                result: { imported: 0, conflicts: 0, unchanged: 0 } };
            save(); finishJournal(storage, conflict.method);
        } else state.targets[conflict.target].accepted[conflict.remote.path] = acceptedHistory(state, current?.hash ?? null, conflict.remote.hash, conflict.remoteSequence);
        conflict.resolved = true; save(); return { resolved: true };
    });
}

export function conflictCopy(base, account, id, side) {
    return withSync(base, account, ({ state }) => {
        const conflict = state.conflicts[id];
        if (!conflict || !['local', 'remote'].includes(side) || !conflict[side]) throw fail('This preserved version is unavailable.', 404);
        requireMethod(state, conflict.method);
        const copy = { entry: conflict[side], companions: conflict.companions?.[side] ?? [] };
        if ([copy.entry, ...copy.companions].some(item => !state.categories.includes(item.category))) throw fail('Select the original data categories before exporting this preserved copy.', 409);
        return copy;
    });
}

export function forgetConflict(base, account, id) {
    return withSync(base, account, ({ state, save }) => {
        if (!state.conflicts[id]?.resolved || state.journal) throw fail('Finish recovery and resolve this conflict before removing its preserved copies.');
        delete state.conflicts[id]; save();
        return { removed: true };
    });
}

export function createGrant(base, account) {
    return withSync(base, account, ({ state, save }) => {
        requireMethod(state, 'pairing');
        for (const [id, grant] of Object.entries(state.grants)) if (grant.expires <= Date.now()) delete state.grants[id];
        if (Object.keys(state.grants).length >= 4) throw fail('Revoke an existing pairing grant before creating another.', 409);
        const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('base64url');
        state.grants[id] = { hash: secretHash(token), expires: Date.now() + 30 * 24 * 60 * 60 * 1000 };
        save(); return { id, token, owner: base.owner, expires: state.grants[id].expires };
    });
}

export function revokeGrant(base, account, id) {
    return withSync(base, account, ({ state, save }) => { delete state.grants[id]; state.revision += 1; save(); return { revoked: true }; });
}

export function authoriseGrant(base, account, id, token) {
    return withSync(base, account, ({ state }) => {
        requireMethod(state, 'pairing');
        const grant = state.grants[id];
        if (typeof token !== 'string' || token.length > 100 || !grant || grant.expires <= Date.now()
            || !timingSafeEqual(Buffer.from(grant.hash, 'hex'), Buffer.from(secretHash(token), 'hex'))) throw fail('The pairing grant is invalid, expired or revoked.', 403);
        return state.revision;
    });
}
