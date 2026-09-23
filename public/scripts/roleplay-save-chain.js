const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const records = new WeakMap();
let binding;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameAccount = (a, b) => a?.accountId === b?.accountId && a?.dataEpoch === b?.dataEpoch;
const failure = (code, message) => Object.assign(new Error(message), { code });
const changedAccount = () => failure('ROLEPLAY_ACCOUNT_CHANGED', 'The account changed. Reload before saving.');
const missingRead = () => failure('ROLEPLAY_READ_REQUIRED', 'Reload the chat before saving; its saved version is unavailable.');
const uncertainSave = () => failure('ROLEPLAY_SAVE_UNCERTAIN', 'The save could not be confirmed. Keep a copy of your edits before reloading.');

function validAccount(value) {
    return object(value) && typeof value.accountId === 'string' && UUID.test(value.accountId)
        && Number.isSafeInteger(value.dataEpoch) && value.dataEpoch > 0;
}

function locatorKey(locator) {
    if (!object(locator) || typeof locator.group !== 'boolean' || typeof locator.chat !== 'string' || !locator.chat
        || locator.chat.length > 256 || (!locator.group && (typeof locator.avatar !== 'string' || !locator.avatar))) throw missingRead();
    return JSON.stringify([locator.group, locator.group ? '' : locator.avatar, locator.chat]);
}

function readEvidence(value, account) {
    if (!object(value) || !validAccount(value.account) || !sameAccount(value.account, account)
        || Object.hasOwn(value, 'source') === Object.hasOwn(value, 'vacancy')) throw missingRead();
    if (Object.hasOwn(value, 'source')) {
        const source = value.source;
        if (!object(source) || typeof source.instanceId !== 'string' || !UUID.test(source.instanceId)
            || !Number.isSafeInteger(source.revision) || source.revision < 1 || typeof source.rawHash !== 'string' || !HASH.test(source.rawHash)) throw missingRead();
        return { account: { ...account }, source: { instanceId: source.instanceId, revision: source.revision, rawHash: source.rawHash } };
    }
    if (!Number.isSafeInteger(value.vacancy) || value.vacancy < 0) throw missingRead();
    return { account: { ...account }, vacancy: value.vacancy };
}

/** Bind once per profile. A changed incarnation of the same profile requires a page reload. */
export function bindRoleplayAccount(owner, account) {
    if (typeof owner !== 'string' || !owner) throw changedAccount();
    if (binding?.stamp.owner === owner) {
        if (!sameAccount(binding.stamp.account, account)) binding.available = false;
        return binding.available;
    }
    const valid = validAccount(account);
    binding = { stamp: Object.freeze({ owner, account: Object.freeze(valid ? { ...account } : {}) }), available: valid, chains: new Map() };
    return valid;
}

export function roleplayAccountStamp() {
    if (!binding?.available) throw changedAccount();
    return binding.stamp;
}

function assertCurrent(record) {
    if (!binding?.available || record.binding !== binding) throw changedAccount();
}

/** Parse only evidence for the exact requested file and the account captured before the read. */
export function parseRoleplayRead(response, locator, stamp = roleplayAccountStamp()) {
    if (stamp !== roleplayAccountStamp()) throw changedAccount();
    let value;
    try { value = JSON.parse(response.headers.get('X-Neconyan-Roleplay')); } catch { throw missingRead(); }
    if (!response.ok || locatorKey(value?.locator) !== locatorKey(locator)) throw missingRead();
    return readEvidence(value, stamp.account);
}

function chainFor(locator) {
    roleplayAccountStamp();
    const key = locatorKey(locator);
    if (!binding.chains.has(key)) binding.chains.set(key, { head: null, tail: null, editorTail: null, lineage: null, blocked: false });
    return binding.chains.get(key);
}

/** False means the caller must not apply this late read to its editable chat either. */
export function rememberRoleplayRead(locator, evidence) {
    const entry = chainFor(locator);
    const checked = readEvidence(evidence, binding.stamp.account);
    if (entry.blocked || (entry.tail && !entry.tail.complete)) return false;
    entry.head = checked;
    entry.editorTail = null;
    entry.lineage = {};
    return true;
}

/** Existing solo/group queues schedule these tokens; they are not a second task queue. */
export function beginRoleplaySave(locator, { operationKey, owner = roleplayAccountStamp().owner, create = false, evidence = null } = {}) {
    const stamp = roleplayAccountStamp();
    if (owner !== stamp.owner) throw changedAccount();
    if (typeof operationKey !== 'string' || !operationKey || operationKey.length > 256) throw missingRead();
    const entry = chainFor(locator);
    const token = Object.freeze({ owner, locator: Object.freeze({ ...locator }) });
    let resolve;
    const explicit = evidence ? readEvidence(evidence, stamp.account) : null;
    const record = { binding, entry, key: operationKey, locator: token.locator, create,
        explicit, initial: entry.head, predecessor: entry.tail?.complete ? null : entry.tail,
        editorPredecessor: explicit ? null : entry.editorTail, lineage: entry.lineage,
        source: null, result: null, conflict: null,
        attempt: null, forced: false, status: 'ready', complete: false,
        done: new Promise(settle => { resolve = settle; }), resolve: null };
    record.resolve = resolve;
    records.set(token, record);
    entry.tail = record;
    if (!explicit && !create && entry.lineage) entry.editorTail = record;
    return token;
}

async function sourceFor(record) {
    if (record.predecessor) {
        const previous = await record.predecessor.done;
        if (previous.status === 'unknown') throw uncertainSave();
    }
    if (record.explicit) return record.explicit;
    if (record.editorPredecessor) {
        const previous = await record.editorPredecessor.done;
        if (previous.status === 'unknown') throw uncertainSave();
        return previous.source;
    }
    return record.initial;
}

function acceptResult(record, data) {
    const result = data?.roleplay;
    if (data?.ok !== true || typeof data.integrity !== 'string' || result?.operationKey !== record.key
        || typeof result.changed !== 'boolean') throw uncertainSave();
    const evidence = readEvidence(result, record.binding.stamp.account);
    if (!evidence.source) throw uncertainSave();
    const before = record.source.source;
    if (before ? evidence.source.instanceId !== before.instanceId || evidence.source.revision !== before.revision + Number(result.changed)
        || (result.changed ? evidence.source.rawHash === before.rawHash : evidence.source.rawHash !== before.rawHash)
        : !result.changed || evidence.source.revision !== 1) throw uncertainSave();
    record.source = evidence;
    record.status = 'ok';
}

function refuse(record, status, data) {
    record.status = 'refused';
    record.conflict = null;
    if (data?.error === 'integrity' && data.roleplay) {
        try { record.conflict = readEvidence(data.roleplay, record.binding.stamp.account); } catch { /* No valid overwrite authority was supplied. */ }
    }
    record.result = { ok: false, status, data };
    return record.result;
}

/** Each attempt serialises once. Retry transport may refresh CSRF/compression, never the JSON or key. */
export async function sendRoleplaySave(token, payload, send, loadVacancy) {
    const record = records.get(token);
    if (!record || record.complete) throw uncertainSave();
    assertCurrent(record);
    if (record.status === 'ok') return record.result;
    if (record.entry.blocked) throw uncertainSave();
    if (!record.attempt) {
        try {
            record.source = record.source || await sourceFor(record);
            assertCurrent(record);
            if (!record.source && record.create && typeof loadVacancy === 'function') {
                const response = await loadVacancy(record.locator, record.binding.stamp);
                record.source = parseRoleplayRead(response, record.locator, record.binding.stamp);
            }
            if (!record.source) throw missingRead();
            if (record.create && record.source.source && !record.forced) return refuse(record, 400, { error: 'integrity', roleplay: record.source });
            const matchingTarget = record.locator.group ? String(payload.id) === record.locator.chat
                : payload.file_name === record.locator.chat && payload.avatar_url === record.locator.avatar;
            if (!matchingTarget) throw missingRead();
            record.attempt = JSON.stringify({ ...payload, ...(record.forced ? { force: true } : {}),
                roleplay: { ...record.source, operationKey: record.key } });
        } catch (error) {
            record.status = error.code === 'ROLEPLAY_SAVE_UNCERTAIN' ? 'unknown' : 'refused';
            throw error;
        }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrent(record);
        try {
            const response = await send(record.attempt, record.binding.stamp);
            const data = await response.json();
            assertCurrent(record);
            if (data?.error === 'account_changed' || data?.code === 'ROLEPLAY_ACCOUNT_CHANGED') {
                binding.available = false;
                throw changedAccount();
            }
            if (response.ok) {
                acceptResult(record, data);
                record.result = { ok: true, status: response.status, data };
                return record.result;
            }
            if (object(data) && typeof data.error === 'string'
                && ((response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))
                    || (response.status === 507 && data.error === 'roleplay_store_full'))) return refuse(record, response.status, data);
        } catch (error) {
            if (error.code === 'ROLEPLAY_ACCOUNT_CHANGED') throw error;
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    record.status = 'unknown';
    throw uncertainSave();
}

/** Called only after the existing explicit overwrite confirmation. Successors still await this token. */
export function confirmRoleplayOverwrite(token, operationKey) {
    const record = records.get(token);
    if (!record || record.complete || record.status !== 'refused' || !record.conflict
        || typeof operationKey !== 'string' || !operationKey || operationKey.length > 256 || operationKey === record.key) throw missingRead();
    assertCurrent(record);
    record.key = operationKey;
    record.source = record.conflict;
    record.forced = true;
    record.attempt = record.result = record.conflict = null;
    record.status = 'ready';
}

/** Settle only when the caller has finished any overwrite prompt and all attempts. */
export async function finishRoleplaySave(token) {
    const record = records.get(token);
    if (!record || record.complete) return;
    if (record.status === 'ready') {
        try { record.source = await sourceFor(record); record.status = 'refused'; } catch { record.status = 'unknown'; }
    }
    record.complete = true;
    if (record.status === 'unknown') record.entry.blocked = true;
    else if (!record.explicit && !record.create && record.lineage === record.entry.lineage && record.source) record.entry.head = record.source;
    record.predecessor = record.editorPredecessor = record.initial = record.explicit = record.conflict = null;
    if (record.status !== 'unknown') record.attempt = null;
    record.resolve(record);
}
