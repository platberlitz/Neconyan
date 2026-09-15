import { normalizeSettings } from './core.js';
import { mergeStore, normalizeFeed } from './storage.js';
import { browserRecovery } from './recovery.js';
import { storeFrom } from './storage-format.js';

const clone = value => structuredClone(value);
function equal(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const emptyFeed = () => ({ version: 1, posts: [], interactions: [] });
const id = () => globalThis.crypto.randomUUID?.() ?? [...globalThis.crypto.getRandomValues(new Uint32Array(4))].join('-');

function preparedFeed(feed) {
    const normal = normalizeFeed(feed);
    const preserves = (source, target) => source && typeof source === 'object'
        ? target && typeof target === 'object' && Object.keys(source).every(key => Object.hasOwn(target, key) && preserves(source[key], target[key]))
        : Object.is(source, target);
    // Fill omitted defaults, but leave invalid input intact for a visible save rejection.
    return preserves(feed, normal) ? normal : clone({ ...feed, version: 1 });
}

function envelope(raw) {
    if (typeof raw?.account !== 'string' || !raw.account.trim()) throw new Error('The storage response has no signed-in account.');
    return { ...storeFrom(raw).store, account: raw.account };
}

function validateCandidate(candidate) {
    for (const feed of Object.values(candidate.feeds)) {
        if (new TextEncoder().encode(JSON.stringify(feed)).length > 20 * 1024 * 1024) {
            throw new Error('The feed is too large to save safely (20 MiB limit).');
        }
        if (!equal(feed, normalizeFeed(feed))) throw new Error('The timeline contains invalid or unsupported rows. Export recovery before replacing it.');
    }
    if (new TextEncoder().encode(JSON.stringify(candidate)).length > 128 * 1024 * 1024) {
        throw new Error('The Meower store is too large to save safely (128 MiB limit).');
    }
}

export function createStorageClient({ request, recovery = browserRecovery(), drafts = () => globalThis.localStorage, events = globalThis } = {}) {
    const owner = id();
    let base;
    let local;
    let initialising;
    let stopped = false;
    let blocked = false;
    let pendingDurability = 0;
    let durable = Promise.resolve();
    let chain = Promise.resolve();
    let timer;
    let visibleEntry;
    let sequence = 0;
    let releaseOwner;
    let disposed = false;
    let disposal;
    let status = { state: 'saved', message: '' };
    let storeStatus = status;
    const listeners = new Set();
    const draftReads = new Map();
    const views = new WeakMap();
    const memoryPending = new Map();
    const failedDurability = new Map();
    const draftIssues = new Map();
    const draftConflicts = new Set();
    const draftScopes = new Set();
    const unsafeDrafts = new Set();
    const unsavedDrafts = new Map();

    function report(state, message = '') {
        storeStatus = { state, message };
        publishStatus();
    }
    function publishStatus() {
        let { state, message } = storeStatus;
        if (blocked && state !== 'error') {
            state = 'error';
            message = 'Recovery needs attention. Export or discard the conflicting changes before saving again.';
        }
        if (failedDurability.size && state !== 'error') {
            state = 'error';
            message = 'Some changes have no browser recovery copy. Keep this tab open and export recovery.';
        }
        const draftIssue = draftIssues.values().next().value
            || (draftConflicts.size ? 'Another tab has a different draft. Both versions are kept in browser recovery.' : '');
        if (draftIssue && state !== 'error') { state = 'error'; message = draftIssue; }
        if (status.state === state && status.message === message) return;
        status = { state, message };
        for (const callback of listeners) {
            try { callback({ ...status }); } catch (error) { console.error('[Meower] save observer failed', error); }
        }
    }
    function fail(error) { report('error', error.message); return error; }
    function ready() {
        if (disposed) throw new Error('This Meower storage client has been disposed. Open a new client before editing.');
        if (stopped) throw new Error('The signed-in account changed. Reload Meower before continuing.');
        if (!local) throw new Error('Open Meower storage before editing.');
    }
    function checkAccount(raw) {
        if (base && raw.account !== base.account) {
            stopped = true;
            throw fail(new Error('The signed-in account changed. Reload Meower before continuing.'));
        }
    }
    async function readRemote(revision) {
        const raw = await request('GET', undefined, revision);
        checkAccount(raw);
        if (raw.unchanged && (!base || revision !== base.revision || raw.revision !== revision)) {
            throw new Error('The storage response returned an invalid unchanged revision.');
        }
        return raw.unchanged ? clone(base) : envelope(raw);
    }
    function record(before, value, key = `${owner}:visible`) {
        return { id: key, token: id(), owner, ownerProtected: Boolean(releaseOwner), sequence: ++sequence,
            account: before.account, base: clone(before), local: clone(value), attempted: false };
    }
    function persist(entry) {
        pendingDurability += 1;
        memoryPending.set(entry.id, entry);
        report('saving', 'Saving a browser recovery copy...');
        const saved = durable.catch(() => {}).then(() => recovery.put(entry));
        durable = saved.then(() => { failedDurability.delete(entry.id); }, error => { failedDurability.set(entry.id, entry.token); throw fail(error); });
        durable.catch(() => {});
        saved.finally(() => { pendingDurability -= 1; }).catch(() => {});
        return saved;
    }
    function serial(action) {
        const attempt = chain.then(action);
        chain = attempt.catch(() => {});
        return attempt.catch(error => { throw fail(error); });
    }
    async function commit(before, candidate, entry) {
        validateCandidate(candidate);
        const uncertain = entry.attempted ? clone(entry) : null;
        let remote = await readRemote(); // Confirm account before sending any private bytes.
        for (let attempt = 0; attempt < 4; attempt += 1) {
            if (uncertain && remote.revision > uncertain.base.revision) {
                let checked;
                try { checked = mergeStore(uncertain.base, uncertain.local, remote); }
                catch (error) { blocked = true; throw error; }
                const withoutSelection = settings => Object.fromEntries(Object.entries(settings)
                    .filter(([key]) => !['activeSessionId', 'activeSessionByPersona'].includes(key)));
                if (!equal(checked.feeds, remote.feeds) || !equal(withoutSelection(checked.settings), withoutSelection(remote.settings))) {
                    blocked = true;
                    throw new Error('A save response was lost and newer saved changes no longer contain that edit. Export recovery or explicitly discard it; it will not be replayed automatically.');
                }
                return remote;
            }
            let merged;
            try { merged = mergeStore(before, candidate, remote); }
            catch (error) { blocked = true; throw error; }
            if (equal(merged.settings, remote.settings) && equal(merged.feeds, remote.feeds)) return remote;
            // Retain the exact attempted merge, including the base for an uncertain response.
            await persist({ ...entry, base: clone(remote), local: clone(merged), attempted: true });
            const response = await request('POST', merged);
            checkAccount(response);
            remote = envelope(response);
            if (!response.conflict) return remote;
            // A 409 proves this attempt did not write. An earlier lost response remains uncertain.
            if (!uncertain) await persist({ ...entry, attempted: false });
        }
        blocked = true;
        throw new Error('Meower keeps changing on another device. Your changes are kept for recovery; reload or export them.');
    }
    async function save() {
        ready();
        if (blocked) throw new Error('Resolve or discard the conflicting changes before saving again.');
        await durable;
        const uncertain = memoryPending.get(`${owner}:flush`);
        if (uncertain?.attempted) {
            const committed = await commit(uncertain.base, uncertain.local, uncertain);
            local = mergeStore(uncertain.local, local, committed);
            base = committed;
            await forget(uncertain);
            await checkpoint();
        }
        if (equal(base, local)) { report('saved'); return; }
        const before = clone(base);
        const candidate = clone(local);
        const visible = visibleEntry;
        const entry = record(before, candidate, `${owner}:flush`);
        await persist(entry);
        const committed = await commit(before, candidate, entry);
        try { local = mergeStore(candidate, local, committed); }
        catch (error) { blocked = true; throw error; }
        base = committed;
        try {
            await forget(entry);
            if (visible) await forget(visible);
            if (!equal(local, base)) await checkpoint();
            report(equal(local, base) ? 'saved' : 'saving');
        } catch (error) { fail(error); }
    }
    function schedule(delay = 1200) {
        clearTimeout(timer);
        timer = setTimeout(() => { client.flush().catch(() => {}); }, delay);
    }
    function changed() {
        checkpoint().catch(() => {});
        schedule();
    }
    function checkpoint() {
        visibleEntry = record(base, local);
        return persist(visibleEntry);
    }
    async function forget(entry) {
        await recovery.remove(entry);
        if (memoryPending.get(entry.id)?.token === entry.token) memoryPending.delete(entry.id);
        if (failedDurability.get(entry.id) === entry.token) failedDurability.delete(entry.id);
    }
    function withFeed(store, sessionId, feed) {
        return { ...store, feeds: { ...store.feeds, [sessionId]: feed } };
    }
    const client = {
        get initialised() { return Boolean(local); },
        get settings() { ready(); return clone(local.settings); },
        async initialise() {
            if (disposed) ready();
            if (stopped) ready();
            if (initialising) return initialising;
            initialising = (async () => {
                base = await readRemote();
                releaseOwner ??= await recovery.claimOwner?.(owner);
                if (releaseOwner === null) throw new Error('This recovery owner is already active in another tab.');
                local = clone(base);
                const claims = [];
                try {
                    const captured = (await recovery.list(base.account)).filter(entry => !entry.archived);
                    const recoverable = new Set();
                    for (const other of new Set(captured.map(entry => entry.owner))) {
                        if (captured.some(entry => entry.owner === other && !entry.ownerProtected)) {
                            blocked = true;
                            fail(new Error('A pending recovery owner did not hold a Web Lock. Its copies are kept for export; automatic recovery is blocked.'));
                            return clone(local.settings);
                        }
                        const release = await recovery.claimOwner?.(other);
                        if (release === undefined) {
                            blocked = true;
                            fail(new Error('Browser recovery ownership cannot be checked without Web Locks. Pending copies are kept for export; automatic recovery is blocked.'));
                            return clone(local.settings);
                        }
                        if (release) { claims.push(release); recoverable.add(other); }
                    }
                    const all = captured.filter(entry => recoverable.has(entry.owner));
                    const superseded = new Set(captured.flatMap(entry => entry.supersedes ?? []));
                    const entries = all.filter(entry => !superseded.has(entry.token) && (entry.attempted || entry.id.includes(':transaction:')
                        || !all.some(other => other.owner === entry.owner && !other.id.includes(':transaction:') && other.sequence > entry.sequence)))
                        .sort((a, b) => Number(Boolean(b.attempted)) - Number(Boolean(a.attempted)) || a.sequence - b.sequence);
                    for (const entry of entries) {
                        if (entry.id.endsWith(':flush')) {
                            // Later visible snapshots supersede this owner's earlier visible intent.
                            // Persist the causal base before settling an uncertain earlier flush.
                            for (const later of entries.filter(item => item.owner === entry.owner && item.sequence > entry.sequence
                                && !item.id.includes(':transaction:'))) {
                                later.base = mergeStore(entry.base, entry.local, later.base);
                                await recovery.put(later);
                            }
                        }
                        const older = all.filter(item => (entry.supersedes ?? []).includes(item.token)
                            || (item.owner === entry.owner && !item.id.includes(':transaction:') && item.sequence < entry.sequence));
                        // Keep a separately owned marker until cleanup finishes, including after a lost response.
                        const replay = record(entry.base, entry.local, `${owner}:transaction:${id()}`);
                        replay.attempted = entry.attempted;
                        replay.supersedes = [entry.token, ...(entry.supersedes ?? []), ...older.map(item => item.token)];
                        try {
                            await persist(replay);
                            const committed = await commit(entry.base, entry.local, replay);
                            base = committed;
                            local = clone(base);
                            for (const old of older) {
                                await recovery.put({ ...old, id: `${old.id}:archived:${old.token}`, archived: true });
                                await forget(old);
                            }
                            await forget(entry);
                            await forget(replay);
                        } catch (error) {
                            blocked = true;
                            fail(error);
                            // The server version stays usable for reading; recovery is explicit.
                            return clone(local.settings);
                        }
                    }
                    report('saved');
                    return clone(local.settings);
                } finally { await Promise.all(claims.map(release => release())); }
            })().catch(error => { initialising = null; local = null; throw fail(error); });
            return initialising;
        },
        updateSettings(patch) {
            ready();
            local.settings = normalizeSettings({ ...local.settings, ...patch });
            local.feeds = Object.fromEntries(Object.keys(local.settings.sessions).map(key => [key,
                Object.hasOwn(local.feeds, key) ? local.feeds[key] : emptyFeed()]));
            changed();
            return clone(local.settings);
        },
        feed(sessionId) {
            ready();
            if (!Object.hasOwn(local.feeds, sessionId)) throw new Error('That timeline session no longer exists.');
            const result = clone(local.feeds[sessionId]);
            views.set(result, clone(result));
            return result;
        },
        queue(feed, sessionId, delay = 1200) {
            client.feed(sessionId);
            if (feed.epoch !== local.feeds[sessionId].epoch) throw fail(new Error('This timeline was reset. Reload it before editing.'));
            const before = withFeed(local, sessionId, views.get(feed) ?? local.feeds[sessionId]);
            const candidate = withFeed(local, sessionId, preparedFeed(feed));
            if (!equal(candidate.feeds[sessionId], normalizeFeed(candidate.feeds[sessionId]))) {
                local = candidate;
                changed();
                schedule(delay);
                return;
            }
            try { local = mergeStore(before, candidate, local); }
            catch (error) {
                persist(record(before, candidate, `${owner}:transaction:${id()}`)).catch(() => {});
                blocked = true;
                throw fail(error);
            }
            Object.assign(feed, clone(local.feeds[sessionId]));
            views.set(feed, clone(local.feeds[sessionId]));
            changed();
            schedule(delay);
        },
        async flush() {
            clearTimeout(timer);
            if (!local) return;
            return serial(async () => {
                do { await save(); } while (!equal(base, local));
            });
        },
        write(feed, sessionId, { signal, sessionPatch, replace = false, baseFeed = feed, generatedInteractionIds = [] } = {}) {
            ready();
            const snapshot = clone(feed);
            const starting = clone(local);
            if (views.has(baseFeed)) starting.feeds[sessionId] = clone(views.get(baseFeed));
            const sameTabMerge = { discardableInteractions: { [sessionId]: [...generatedInteractionIds] } };
            return serial(async () => {
                signal?.throwIfAborted();
                if (!replace) await save();
                client.feed(sessionId);
                const superseded = replace ? [...new Map([...(await recovery.list(base.account)), ...memoryPending.values()]
                    .filter(item => item.id.startsWith(`${owner}:`) && !item.archived).map(item => [item.id, item])).values()] : [];
                const previous = clone(local);
                let candidate = clone(replace ? local : starting);
                candidate.feeds[sessionId] = preparedFeed(snapshot);
                if (replace) candidate.feeds[sessionId].epoch = id();
                else if (starting.feeds[sessionId].epoch !== undefined) candidate.feeds[sessionId].epoch = starting.feeds[sessionId].epoch;
                if (sessionPatch) candidate.settings = normalizeSettings({ ...candidate.settings, sessions: {
                    ...candidate.settings.sessions, [sessionId]: { ...candidate.settings.sessions[sessionId], ...sessionPatch },
                } });
                const entry = record(replace ? base : starting, candidate, `${owner}:transaction:${id()}`);
                entry.supersedes = superseded.map(item => item.token);
                await persist(entry);
                if (signal?.aborted) { await forget(entry); signal.throwIfAborted(); }
                let committed;
                try {
                    validateCandidate(candidate);
                    if (!replace) candidate = mergeStore(starting, candidate, local, sameTabMerge);
                    committed = await commit(base, candidate, entry);
                } catch (error) { blocked = true; throw error; }
                try { local = mergeStore(previous, local, committed, sameTabMerge); }
                catch (error) { blocked = true; throw error; }
                base = committed;
                blocked = false;
                // Capture exactly the acknowledged tokens before any cleanup can yield.
                const acknowledged = equal(local, base) ? [...memoryPending.values()]
                    .filter(item => item.id === `${owner}:visible` || item.id === `${owner}:flush`) : [];
                try {
                    // Archive the superseded records before dropping the reset's recovery marker.
                    for (const old of superseded) {
                        await recovery.put({ ...old, id: `${old.id}:archived:${old.token}`, archived: true });
                        await forget(old);
                    }
                    for (const old of acknowledged) await forget(old);
                    if (!equal(local, base)) await checkpoint();
                    await forget(entry);
                    report(equal(local, base) ? 'saved' : 'saving');
                } catch (error) { fail(error); }
                return client.feed(sessionId);
            });
        },
        async sync(feed, sessionId) {
            return serial(async () => {
                ready();
                client.feed(sessionId);
                const before = withFeed(local, sessionId, views.get(feed) ?? local.feeds[sessionId]);
                const candidate = withFeed(local, sessionId, preparedFeed(feed));
                try { local = mergeStore(before, candidate, local); }
                catch (error) {
                    await persist(record(before, candidate, `${owner}:transaction:${id()}`));
                    blocked = true;
                    throw error;
                }
                if (!equal(base, local)) await checkpoint();
                const remote = await readRemote(base.revision);
                try { local = mergeStore(base, local, remote); }
                catch (error) { blocked = true; throw error; }
                base = remote;
                if (!equal(base, local)) await checkpoint();
                const next = client.feed(sessionId);
                for (const key of Object.keys(feed)) delete feed[key];
                Object.assign(feed, next);
                views.set(feed, clone(next));
                return feed;
            });
        },
        getSaveStatus() { refreshDraftStatus(); return { ...status }; },
        dispose() {
            disposal ??= (async () => {
                clearTimeout(timer);
                await initialising?.catch(() => {});
                do {
                    const pending = chain;
                    const saving = durable;
                    await pending;
                    await saving;
                    if (pending === chain && saving === durable) break;
                } while (true);
                clearTimeout(timer);
                disposed = true;
                events.removeEventListener?.('storage', onStorage);
                await releaseOwner?.();
                releaseOwner = undefined;
                listeners.clear();
            })().catch(error => { disposal = undefined; throw error; });
            return disposal;
        },
        subscribeSaveStatus(callback) { listeners.add(callback); return () => listeners.delete(callback); },
        needsUnloadWarning: () => pendingDurability > 0 || unsafeDrafts.size > 0 || failedDurability.size > 0,
        async exportRecovery() {
            ready();
            await durable.catch(() => {});
            const errors = [];
            let pending = [];
            let savedDrafts = [];
            try { pending = await recovery.list(base.account); } catch (error) { errors.push(error.message); }
            try { savedDrafts = draftEntries(); } catch (error) { errors.push(error.message); }
            return JSON.stringify({ account: base.account, pending, memoryPending: [...memoryPending.values()], current: { base, local },
                drafts: savedDrafts, unsavedDrafts: [...unsavedDrafts], errors }, null, 2);
        },
        async discardRecoveryAndReload() {
            return serial(async () => {
                ready();
                clearTimeout(timer);
                await durable.catch(() => {});
                const previous = clone(local);
                const captured = [...new Map([...(await recovery.list(base.account)), ...memoryPending.values()]
                    .map(entry => [entry.id, entry])).values()];
                const claims = [];
                try {
                    const writable = new Set([owner]);
                    for (const other of new Set(captured.map(entry => entry.owner).filter(value => value !== owner))) {
                        if (captured.some(entry => entry.owner === other && !entry.ownerProtected)) {
                            throw new Error('A recovery owner did not hold a Web Lock. Export its copies before resolving them explicitly.');
                        }
                        const release = await recovery.claimOwner?.(other);
                        if (release === undefined) throw new Error('Recovery ownership cannot be checked without Web Locks. No copies were discarded.');
                        if (release) { claims.push(release); writable.add(other); }
                    }
                    const remote = await readRemote();
                    const next = equal(previous, local) ? clone(remote) : mergeStore(previous, local, remote);
                    for (const entry of captured.filter(item => writable.has(item.owner))) await forget(entry);
                    base = remote;
                    local = next;
                    blocked = false;
                    if (!equal(base, local)) await checkpoint();
                    report(equal(base, local) ? 'saved' : 'saving');
                    return clone(local.settings);
                } finally { await Promise.all(claims.map(release => release())); }
            });
        },
        readDraft(sessionId, personaId) {
            ready();
            const scope = JSON.stringify([base.account, sessionId, personaId]);
            draftScopes.add(scope);
            let entries;
            try { entries = checkDraftConflict(scope); }
            catch (error) {
                if (!unsafeDrafts.has(scope)) draftIssues.set(scope, error.message);
                publishStatus();
                throw error;
            }
            publishStatus();
            if (draftConflicts.has(scope)) throw new Error('Several tabs have different drafts. Export recovery to keep every version before choosing one.');
            draftReads.set(scope, entries.map(item => item.token));
            return clone(entries.find(item => item.value !== null)?.value ?? null);
        },
        saveDraft(sessionId, personaId, value) {
            ready();
            const scope = JSON.stringify([base.account, sessionId, personaId]);
            draftScopes.add(scope);
            const key = `hopper:draft:${scope}:${owner}`;
            try {
                validateDraft(value);
                unsavedDrafts.set(scope, clone(value));
                const storage = drafts();
                if (!storage) throw new Error('Browser draft storage is unavailable.');
                const prior = storage.getItem(key);
                const supersedes = [...new Set([...(prior ? JSON.parse(prior).supersedes ?? [] : []), ...(draftReads.get(scope) ?? [])])];
                storage.setItem(key, JSON.stringify({ scope, owner, value, key, token: id(), supersedes }));
                unsavedDrafts.delete(scope);
                unsafeDrafts.delete(scope);
                draftIssues.delete(scope);
                checkDraftConflict(scope);
                publishStatus();
            } catch (error) { unsafeDrafts.add(scope); draftIssues.set(scope, error.message); publishStatus(); throw error; }
        },
        clearDraft(sessionId, personaId) { client.saveDraft(sessionId, personaId, null); },
        resolveDraft(sessionId, personaId, value) {
            ready();
            const scope = JSON.stringify([base.account, sessionId, personaId]);
            draftReads.set(scope, draftEntries(scope).map(item => item.token));
            client.saveDraft(sessionId, personaId, value);
        },
    };
    function checkDraftConflict(scope) {
        const all = draftEntries(scope);
        const superseded = new Set(all.flatMap(item => item.supersedes ?? []));
        const entries = all.filter(item => !superseded.has(item.token));
        const values = entries.filter(item => item.value !== null);
        for (const item of values) validateDraft(item.value);
        if (values.length > 1 && !values.every(item => equal(item.value, values[0].value))) draftConflicts.add(scope);
        else draftConflicts.delete(scope);
        if (!unsafeDrafts.has(scope)) draftIssues.delete(scope);
        return entries;
    }
    function refreshDraftStatus() {
        if (!local || stopped || disposed) return;
        for (const scope of draftScopes) {
            try { checkDraftConflict(scope); }
            catch (error) { if (!unsafeDrafts.has(scope)) draftIssues.set(scope, error.message); }
        }
        publishStatus();
    }
    function onStorage(event) {
        if (!local || stopped || disposed || (event.key !== null
            && !event.key?.startsWith(`hopper:draft:[${JSON.stringify(base.account)},`))) return;
        try { if (event.storageArea !== drafts()) return; }
        catch { /* Refresh reports unavailable draft storage without changing write-failure flags. */ }
        refreshDraftStatus();
    }
    events.addEventListener?.('storage', onStorage);
    function draftEntries(scope) {
        const storage = drafts();
        if (!storage) throw new Error('Browser draft storage is unavailable.');
        const entries = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key?.startsWith('hopper:draft:')) continue;
            // Check the encoded account before parsing any other account's content.
            if (!key.startsWith(`hopper:draft:[${JSON.stringify(base.account)},`)) continue;
            const entry = JSON.parse(storage.getItem(key));
            if (!scope || entry.scope === scope) entries.push({ ...entry, key });
        }
        return entries;
    }
    return client;
}

function validateDraft(value) {
    if (value === null) return;
    const draft = value?.draft;
    if (!draft || typeof draft.text !== 'string' || typeof draft.imageDescription !== 'string'
        || !(draft.image === null || typeof draft.image === 'string')
        || !(draft.poll === null || (Array.isArray(draft.poll) && draft.poll.every(item => typeof item === 'string')))
        || !Array.isArray(value.replies) || !value.replies.every(item => Array.isArray(item) && item.length === 2
            && typeof item[0] === 'string' && typeof item[1] === 'string')) {
        throw new Error('The saved draft format is invalid. Export recovery before replacing it.');
    }
    for (const [key] of value.replies) JSON.parse(key);
}
