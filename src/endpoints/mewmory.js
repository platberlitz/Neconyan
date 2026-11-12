import { prepareMewmoryPrompt } from '../mewmory/prepare.js';
import express from 'express';
import { abortOnRequestClose } from '../util.js';
import {
    continueState, eligibleRecords, fail, hash, list, object, putRecord, recordEligible, recordRevision,
    refKey, sourceAt, sourceEligible, SOURCE_TYPES, strings, syncSources, text, undoRecord, validateRecord,
} from '../mewmory/core.js';
import { activeReferences, assemblyFingerprint, currentOverviews, generationFingerprint } from '../mewmory/context.js';
import { embed, publicConfig, readConfig, roleVersion, saveConfig } from '../mewmory/models.js';
import { addUsage, pendingSources, processingVersion } from '../mewmory/processing.js';
import { cancelProcessing, startProcessing, waitForProcessing } from '../mewmory/worker.js';
import { recall } from '../mewmory/retrieval.js';
import { hybridCandidates, searchDocuments, updateIndex } from '../mewmory/search.js';
import { loadCurrentState, purgeMissingContextSources, readContextSources } from '../mewmory/sources.js';
import { commitRecovery, listStories, MAX_ARCHIVE_BYTES, mutateState, normalizeLocator, readChat, readStateShared, recoveryState } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { startOperation } from '../mewmory/operations.js';
import { listJobs } from '../jobs/store.js';
import { disableMewmory, resumeVisibilityRestore } from '../mewmory/visibility.js';

export const router = express.Router();

function route(url, handler, { accountScoped = false } = {}) {
    router.post(url, async (request, response) => {
        const controller = new AbortController();
        const cancellation = abortOnRequestClose(request, controller, response);
        try {
            if (!request.user?.directories?.root) return response.sendStatus(401);
            const owner = request.user.profile?.handle;
            const expected = request.get('X-Neconyan-Account');
            if (accountScoped && expected && expected !== owner) {
                return response.status(403).json({
                    error: 'Mewmory settings belong to a different signed-in account. Reload the page before continuing.',
                    code: 'MEWMORY_ACCOUNT_CHANGED',
                });
            }
            if (Buffer.byteLength(JSON.stringify(request.body || {})) > MAX_ARCHIVE_BYTES + 1024 * 1024) fail('This request to Mewmory is too large to accept.', 413);
            const result = await handler(request.user.directories, request.body || {}, controller.signal, owner);
            if (!response.destroyed) response.json(result);
        } catch (error) {
            if (!response.destroyed) response.status(error.status || 500).json({
                error: error.status ? error.message : 'Mewmory hit an unexpected problem and did not finish. Nothing was lost; your memories are as they were before. Try again.',
            });
            if (!error.status) console.error('[Mewmory]', error);
        } finally {
            cancellation.cleanup();
        }
    });
}

function accountConfig(config, owner) {
    return owner ? { ...config, account: owner } : config;
}

function expectedRevision(body, state) {
    if (!Number.isSafeInteger(body.revision) || body.revision !== state.revision) {
        fail('Mewmory changed somewhere else, for example in another tab, while you were making this change. Reload Mewmory and try again.', 409);
    }
}

const DUPLICATE_KINDS = ['state', 'event', 'relationship', 'knowledge', 'commitment'];
const DUPLICATE_SIMILARITY = 0.8;
const DUPLICATE_GROUP_LIMIT = 40;

function recordWords(record) {
    return new Set((record.text || '').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function wordOverlap(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared++;
    return shared / (a.size + b.size - shared);
}

/** Groups memories of one type, about the same character and subjects, whose wording is nearly the same. */
export function duplicateGroups(state) {
    const buckets = new Map();
    for (const record of state.records) {
        if (!DUPLICATE_KINDS.includes(record.kind) || !recordEligible(state, record, { includeExcluded: true })) continue;
        const key = hash([record.kind, record.ownerId, record.entityId || '', [...record.subjectIds].sort()]);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ record, words: recordWords(record) });
    }
    const groups = [];
    for (const bucket of buckets.values()) {
        const taken = new Set();
        for (const [index, first] of bucket.entries()) {
            if (taken.has(index)) continue;
            const group = [first.record];
            for (let next = index + 1; next < bucket.length; next++) {
                if (taken.has(next) || wordOverlap(first.words, bucket[next].words) < DUPLICATE_SIMILARITY) continue;
                taken.add(next);
                group.push(bucket[next].record);
            }
            if (group.length > 1) groups.push(group.sort((a, b) => b.asOf - a.asOf || b.createdAt - a.createdAt));
        }
    }
    return groups.sort((a, b) => b[0].asOf - a[0].asOf).slice(0, DUPLICATE_GROUP_LIMIT);
}

function mergedRefs(records, key) {
    return [...new Map(records.flatMap(record => record[key] || []).map(ref => [refKey(ref), { id: ref.id, revision: ref.revision }])).values()].slice(0, 100);
}

/** Keeps one memory with the sources of all of them, and retires the rest. Each change can be undone on its own memory. */
export function mergeRecords(state, keepId, otherIds) {
    const records = [keepId, ...otherIds].map(id => state.records.find(record => record.id === id));
    if (records.some(record => !record)) fail('One of those memories no longer exists. Reload Mewmory.', 404);
    const [keep, ...others] = records;
    if (others.some(record => record.kind !== keep.kind)) fail('Only memories of the same type can be combined.');
    if (records.some(record => !recordEligible(state, record, { includeExcluded: true }))) {
        fail('One of those memories is no longer used in replies, so it cannot be combined. Reload Mewmory and choose again.', 409);
    }
    const subjectIds = [...new Set(records.flatMap(record => record.subjectIds))].slice(0, 32);
    const merged = {
        ...keep, refs: mergedRefs(records, 'refs'), evidenceRefs: mergedRefs(records, 'evidenceRefs'), subjectIds,
        subjectNames: Object.assign({}, ...[...others, keep].map(record => record.subjectNames || {})),
        asOf: Math.max(...records.map(record => record.asOf)),
        pinned: records.some(record => record.pinned),
        significance: ['high', 'medium', 'low'].find(level => records.some(record => record.significance === level)),
        origin: 'author', authorOverride: true, createdAt: Date.now(),
    };
    if (keep.kind === 'commitment') merged.triggerTerms = [...new Set(records.flatMap(record => record.triggerTerms || []))].slice(0, 12);
    putRecord(state, merged);
    for (const record of others) putRecord(state, { ...record, status: 'invalidated', origin: 'author', authorOverride: true, createdAt: Date.now() });
}

const RECORD_SORTS = {
    story: (a, b) => b.asOf - a.asOf || b.createdAt - a.createdAt,
    oldest: (a, b) => a.asOf - b.asOf || a.createdAt - b.createdAt,
    changed: (a, b) => b.createdAt - a.createdAt || b.asOf - a.asOf,
    pinned: (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.asOf - a.asOf || b.createdAt - a.createdAt,
};

/** A memory Mewmory wrote after the reader last marked this chat's memories as looked at. */
function unreviewed(state, record) {
    return !record.authorOverride && record.createdAt > (state.reviewedAt || 0) && !['invalidated', 'deleted'].includes(record.status);
}

function messageBound(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function inspectState(state, config, { query = '', kind = '', ownerId = '', subjectId = '', significance = '', status = '', offset = 0,
    sort = 'story', flag = '', fromMessage = 0, toMessage = 0 } = {}) {
    const search = String(query).toLocaleLowerCase();
    const from = messageBound(fromMessage);
    const to = messageBound(toMessage);
    const flags = {
        pinned: record => Boolean(record.pinned), excluded: record => Boolean(record.excluded),
        edited: record => Boolean(record.authorOverride), unused: record => !recordEligible(state, record),
        new: record => unreviewed(state, record),
    };
    const flagged = Object.hasOwn(flags, flag) ? flags[flag] : null;
    const filtered = state.records.filter(record => (!kind || (kind === 'objective'
        ? !['interview', 'overview'].includes(record.kind) : record.kind === kind))
        && (!ownerId || record.ownerId === ownerId) && (!subjectId || record.subjectIds.includes(subjectId))
        && (!significance || record.significance === significance) && (!status || record.status === status)
        && (!flagged || flagged(record)) && (!from || record.asOf + 1 >= from) && (!to || record.asOf + 1 <= to)
        && (!search || JSON.stringify(record).toLocaleLowerCase().includes(search)))
        .sort(Object.hasOwn(RECORD_SORTS, sort) ? RECORD_SORTS[sort] : RECORD_SORTS.story);
    const page = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const policy = processingVersion(config);
    let watermark = -1;
    for (const ref of state.timeline) {
        if (sourceEligible(state, ref) && state.checkpoints[refKey(ref)] !== policy) break;
        watermark = sourceAt(state, ref)?.sequence ?? watermark;
    }
    return {
        locator: state.locator, revision: state.revision, storyId: state.storyId, branchId: state.branchId,
        parent: state.parent, enabled: state.enabled, activeNpcIds: state.activeNpcIds,
        visibilityRestore: state.visibilityRestore || null, lastDisableId: state.lastDisableId || '',
        activeReferences: activeReferences(state), overviews: currentOverviews(state),
        entities: eligibleRecords(state).filter(record => record.kind === 'entity'),
        records: filtered.slice(page, page + 80).map(record => ({
            ...record, eligible: recordEligible(state, record),
            unavailableSources: record.refs.filter(ref => !sourceEligible(state, ref)).map(refKey),
        })),
        total: filtered.length, recordCount: state.records.length, offset: page,
        review: {
            reviewedAt: state.reviewedAt || 0,
            fresh: state.records.filter(record => unreviewed(state, record)).length,
            uncertain: state.records.filter(record => record.status === 'uncertain').length,
        },
        sourceCount: Object.keys(state.sources).length,
        sources: [...state.timeline.slice(-60), ...state.contextSources].map(ref => {
            const source = sourceAt(state, ref);
            return { ...ref, type: state.sources[ref.id].type, sequence: source.sequence, speaker: source.speaker,
                text: source.text.slice(0, 240), eligible: sourceEligible(state, ref), excluded: state.excludedSources.includes(ref.id) };
        }),
        health: {
            processing: state.processing || null,
            pending: pendingSources(state, config).length, totalMessages: state.timeline.length,
            preservedThrough: watermark, checkpointPending: pendingSources(state, config, { checkpoint: true }).length,
            indexVersion: state.index.version, indexPending: state.index.pending, jobs: state.jobs.slice(-10),
            indexStatus: !config.roles.embedding.enabled ? 'lexical'
                : state.index.version === roleVersion(config, 'embedding') && !state.index.pending ? 'ready' : 'building',
            usage: state.usage || {}, nativeOffset: state.inheritedTimeline?.length || 0,
        },
        recalls: state.recalls,
        preview: state.preview || null,
        previewCurrent: state.preview?.fingerprint === assemblyFingerprint(state, config),
    };
}

route('/config/get', (directories, body, signal, owner) => ({
    config: accountConfig(publicConfig(directories), owner), stories: listStories(directories),
}), { accountScoped: true });
route('/config/save', (directories, body, signal, owner) => ({
    config: accountConfig(saveConfig(directories, body.config), owner),
}), { accountScoped: true });

route('/inspect', async (directories, body, signal, owner) => {
    const locator = normalizeLocator(body.locator);
    const pending = readStateShared(directories, locator).visibilityRestore;
    if (owner && pending && pending.status !== 'complete') {
        try { resumeVisibilityRestore({ owner, directories }, locator); } catch { /* The inspection exposes the saved retry state. */ }
    }
    const state = await loadCurrentState(directories, locator);
    const inspection = { ...inspectState(state, readConfig(directories), body), operations: [] };
    try {
        inspection.operations = listJobs(directories)
            .filter(job => job.type.startsWith('mewmory.') && job.intent?.locator && hash(job.intent.locator) === hash(locator))
            .slice(0, 5).map(job => ({ id: job.id, label: job.label, state: job.state, error: job.error, warning: job.result?.warning, progress: job.progress }));
    } catch {
        inspection.operationsError = 'Saved job history is unavailable. You can still read memory, but a server owner needs to repair the saved job list before more memory tasks can run.';
    }
    return inspection;
});

route('/enabled', async (directories, body, signal, owner) => {
    const locator = normalizeLocator(body.locator);
    if (typeof body.enabled !== 'boolean') fail('Choose whether Mewmory is on or off.');
    if (body.enabled !== true) {
        const state = disableMewmory({ owner, directories }, locator, {
            account: body.account, branchId: body.branchId, revision: body.revision,
            operationKey: body.operationKey, sourceInstanceId: body.sourceInstanceId,
        });
        return inspectState(state, readConfig(directories));
    }
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    if (current.visibilityRestore && current.visibilityRestore.status !== 'complete') {
        fail('Finish restoring hidden messages before turning Mewmory on.', 409);
    }
    const state = mutateState(directories, locator, state => {
        state.enabled = true;
        state.preview = null;
    }, current.revision);
    return inspectState(state, readConfig(directories));
});

route('/visibility/restore', async (directories, body, signal, owner) => {
    const locator = normalizeLocator(body.locator);
    if (!owner) fail('Reload this chat before restoring messages.', 409);
    const state = resumeVisibilityRestore({ owner, directories }, locator);
    return inspectState(state, readConfig(directories));
});

route('/scene', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    const active = body.activeNpcIds === null ? null : strings(body.activeNpcIds);
    if (active?.some(entityId => !current.records.some(record => record.kind === 'entity' && record.isCharacter
        && record.entityId === entityId && recordEligible(current, record)))) fail('Choose characters played by the AI in this chat.');
    const state = mutateState(directories, locator, state => { state.activeNpcIds = active; }, current.revision);
    return inspectState(state, readConfig(directories));
});

route('/record/save', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    expectedRevision(body, state);
    const saved = mutateState(directories, locator, state => {
        const previous = state.records.find(record => record.id === body.record?.id);
        putRecord(state, validateRecord(state, body.record, { origin: 'author', asOf: previous?.asOf }));
    }, state.revision);
    return inspectState(saved, readConfig(directories), body.filters);
});

const RECORD_ACTION_LIMIT = 80;

function applyRecordAction(state, id, action) {
    const record = state.records.find(item => item.id === id);
    if (!record) fail('That memory no longer exists. Reload Mewmory.', 404);
    if (action === 'undo') return void undoRecord(state, record.id);
    const changes = {
        suspicion: { status: 'uncertain', ...(['event', 'relationship'].includes(record.kind) ? { evidenceStatus: 'reported' } : {}) },
        never_learned: { status: 'invalidated' },
        unsupported: { status: 'invalidated' },
        resolved: { status: 'resolved' }, background: { status: 'background' }, active: { status: 'active' },
        pin: { pinned: !record.pinned }, exclude: { excluded: !record.excluded },
        pin_on: { pinned: true }, pin_off: { pinned: false }, exclude_on: { excluded: true }, exclude_off: { excluded: false },
    }[action];
    if (!changes) fail('Mewmory does not recognise that correction.');
    putRecord(state, { ...record, ...changes, origin: 'author', authorOverride: true, createdAt: Date.now() });
}

route('/record/action', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    expectedRevision(body, state);
    const ids = body.ids === undefined ? [body.id] : [...new Set(strings(body.ids))];
    if (!ids.length) fail('Tick at least one memory first.');
    if (ids.length > RECORD_ACTION_LIMIT) fail('Change at most ' + RECORD_ACTION_LIMIT + ' memories at a time.');
    // One protected write: either every ticked memory changes, or none does.
    const saved = mutateState(directories, locator, state => {
        for (const id of ids) applyRecordAction(state, id, body.action);
    }, state.revision);
    return inspectState(saved, readConfig(directories), body.filters);
});

route('/record/history', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    const current = state.records.find(record => record.id === body.id);
    if (!current) fail('That memory no longer exists. Reload Mewmory.', 404);
    return {
        id: current.id, current,
        versions: state.audit.filter(entry => entry.recordId === current.id && entry.before)
            .map(entry => ({ at: entry.at, action: entry.action, record: entry.before })).reverse(),
    };
});

route('/review/seen', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    const state = mutateState(directories, locator, state => { state.reviewedAt = Date.now(); }, current.revision);
    return inspectState(state, readConfig(directories), body.filters);
});

route('/duplicates', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    return { groups: duplicateGroups(state) };
});

route('/record/merge', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    const others = [...new Set(strings(body.ids))].filter(id => id !== body.keep);
    if (!others.length) fail('Choose at least two memories to combine.');
    if (others.length >= RECORD_ACTION_LIMIT) fail('Combine at most ' + RECORD_ACTION_LIMIT + ' memories at a time.');
    const state = mutateState(directories, locator, state => mergeRecords(state, body.keep, others), current.revision);
    return inspectState(state, readConfig(directories), body.filters);
});

route('/source/get', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    object(body.ref, 'Source reference');
    const source = sourceAt(state, body.ref);
    if (!source) fail('That version of the message is no longer available. It may have been edited or deleted.', 404);
    return { ...source, id: body.ref.id, type: state.sources[body.ref.id].type, eligible: sourceEligible(state, body.ref) };
});

const MESSAGE_USED_LIMIT = 80;

export function messageMemories(state, { messageId = '', index = -1, used = [] } = {}) {
    const offset = state.inheritedTimeline?.length || 0;
    let position = messageId ? state.timeline.findIndex(ref => state.sources[ref.id]?.messageId === messageId) : -1;
    if (position < offset && Number.isSafeInteger(index) && index >= 0) position = offset + index;
    const ref = position >= offset ? state.timeline[position] : null;
    if (!ref || (messageId && state.sources[ref.id]?.messageId && state.sources[ref.id].messageId !== messageId)) {
        fail('Mewmory has not read this message yet. Save the chat and try again in a moment.', 404);
    }
    const decorate = record => ({
        ...record, eligible: recordEligible(state, record),
        unavailableSources: record.refs.filter(item => !sourceEligible(state, item)).map(refKey),
    });
    const cites = record => [...record.refs, ...(record.evidenceRefs || []), ...(record.inputRefs || [])].some(item => item.id === ref.id);
    const wanted = [...new Set(strings(used))].slice(0, MESSAGE_USED_LIMIT);
    const byId = new Map(state.records.map(record => [record.id, record]));
    const source = sourceAt(state, ref);
    return {
        sourceId: ref.id, index: position - offset, speaker: source?.speaker || '',
        excluded: state.excludedSources.includes(ref.id), enabled: source?.enabled !== false,
        made: state.records.filter(record => record.status !== 'invalidated' && cites(record))
            .sort((a, b) => b.createdAt - a.createdAt).slice(0, MESSAGE_USED_LIMIT).map(decorate),
        used: wanted.map(id => byId.get(id)).filter(Boolean).map(decorate),
        missing: wanted.filter(id => !byId.has(id)).length,
    };
}

route('/message', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    return messageMemories(state, { messageId: typeof body.messageId === 'string' ? body.messageId : '',
        index: body.index, used: Array.isArray(body.used) ? body.used : [] });
});

route('/source/exclude', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    if (!current.sources[body.id]) fail('That message or lore entry no longer exists. Reload Mewmory.', 404);
    const state = mutateState(directories, locator, state => {
        state.excludedSources = state.excludedSources.filter(id => id !== body.id);
        if (body.exclude === true) state.excludedSources.push(body.id);
        state.coverage = {};
        state.checkpoints = {};
        state.preview = null;
        state.index.pending = true;
    }, current.revision);
    return inspectState(state, readConfig(directories), body.filters);
});

route('/process', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    let state = await startProcessing(directories, locator, { all: body.all === true, checkpoint: body.checkpoint === true });
    if (body.background !== true && state.processing?.status === 'running') {
        state = await waitForProcessing(directories, locator);
        if (state.processing?.status === 'failed') fail(state.processing.error, state.processing.errorStatus || 500);
    }
    return inspectState(state, readConfig(directories));
});

route('/process/cancel', async (directories, body) => inspectState(
    await cancelProcessing(directories, normalizeLocator(body.locator)), readConfig(directories),
));

route('/search', async (directories, body, signal) => {
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    const config = readConfig(directories);
    const fingerprint = assemblyFingerprint(state, config);
    const query = text(body.query, 'Search query', 6000);
    const mode = body.mode || config.retrieval.mode;
    if (!['keyword', 'hybrid', 'semantic'].includes(mode)) fail('Choose a valid search mode.');
    if (body.dataType && !SOURCE_TYPES.includes(body.dataType)) fail('Choose a valid source type.');
    const asOf = body.asOf ?? Infinity;
    if (asOf !== Infinity && (!Number.isSafeInteger(asOf) || asOf < 0)) fail('Choose a valid message position.');
    const documents = searchDocuments(state, asOf, config).filter(document => (!body.dataType || document.dataType === body.dataType)
        && (!body.ownerId || document.ownerId === body.ownerId) && (!body.subjectId || document.subjectIds.includes(body.subjectId)));
    let vector = null; let error = ''; const usage = [];
    if (mode !== 'keyword' && config.roles.embedding.enabled && state.index.version === roleVersion(config, 'embedding')) {
        try {
            const result = await embed(directories, config, [query], { query: true, dataTypes: ['chat'], signal });
            usage.push(result.usage);
            vector = result.vectors[0];
            const dimension = Object.values(state.index.vectors)[0]?.vector.length;
            if (dimension && vector.length !== dimension) { vector = null; fail('Embedding dimensions changed. Rebuild the search index.', 502); }
        } catch (failure) { error = failure.message; }
    }
    const current = await loadCurrentState(directories, locator);
    if (assemblyFingerprint(current, readConfig(directories)) !== fingerprint) fail('The archive or retrieval settings changed during this search. Search again.', 409);
    if (usage.length) mutateState(directories, locator, state => { addUsage(state, usage); }, current.revision);
    return { matches: hybridCandidates(documents, query, vector, state.index.vectors, 40, { ...config.retrieval, mode }),
        retrieval: { requestedMode: mode, usedMode: vector ? mode : 'keyword', keywordFallback: mode !== 'keyword' && !vector,
            documents: documents.length, error }, usage };
});

route('/recall', (directories, body, signal, owner) => body.background === true
    ? startOperation(directories, owner, 'recall', body)
    : recall(directories, normalizeLocator(body.locator), { query: body.query || '', tokenizer: body.tokenizer || {}, signal }));

route('/validate', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    if (body.fingerprint !== generationFingerprint(state, readConfig(directories))) {
        fail('The chat or its memories changed while the reply was being prepared. Send or regenerate again.', 409);
    }
    return { ok: true };
});

route('/tokens', async (directories, body) => {
    const config = readConfig(directories);
    const counter = await getCounter(config.writerTokenizer, body.tokenizer || {});
    return { tokenizer: counter.name, counts: list(body.texts, 'Token inputs', 100000)
        .map(value => counter.count(text(value, 'Token input', 2000000, true))) };
});

route('/index', async (directories, body, signal, owner) => {
    if (body.background === true) return startOperation(directories, owner, 'index', body);
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    if (!state.enabled) fail('Turn on Mewmory for this chat first.', 409);
    if (body.reset === true) state.index = { version: '', vectors: {}, pending: true };
    const result = await updateIndex(state, directories, readConfig(directories), { signal });
    mutateState(directories, locator, () => { addUsage(state, result.usage); return state; }, state.revision);
    return { remaining: result.remaining };
});

route('/export', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    return { format: 'mewmory-export-1', exportedAt: new Date().toISOString(), state };
});

route('/associate', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const parentLocator = normalizeLocator(body.parent);
    if (hash(locator) === hash(parentLocator)) fail('A chat cannot continue from itself. Choose a different chat.');
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    if (current.records.length || current.parent) fail('This chat already has memories, so it cannot be linked as a continuation. Start from a chat with no memories yet.');
    const parent = await loadCurrentState(directories, parentLocator);
    const state = mutateState(directories, locator, () => continueState(parent, locator, readChat(directories, locator).messages), current.revision);
    return inspectState(state, readConfig(directories));
});

route('/prepare', prepareMewmoryPrompt);

export function restoreRecords(state, backup) {
    if (backup?.format !== 'mewmory-export-1' || backup.state?.storyId !== state.storyId || backup.state?.branchId !== state.branchId) {
        fail('This export belongs to another story or chat branch, so it cannot be restored here.');
    }
    const current = list(backup.state.records, 'Export records', 100000);
    if (!Array.isArray(backup.state.audit) || current.some(record => !Number.isSafeInteger(record.version) || record.version < 1)) fail('This export file is damaged: some memory versions are not valid.');
    if (new Set(current.map(record => record.id)).size !== current.length) fail('This export file is damaged: the same memory appears more than once.');
    const versionKey = record => record.id + '@' + record.version;
    const revisions = new Map(current.map(record => [versionKey(record), record]));
    for (const record of revisions.values()) {
        for (const dependency of record.dependencies || []) {
            const key = versionKey(dependency);
            if (revisions.has(key)) continue;
            const historical = recordRevision(backup.state, dependency.id, dependency.version);
            if (historical) revisions.set(key, historical);
        }
        if (revisions.size > 100000) fail('This export has too many saved memory versions to restore.');
    }
    const targets = new Map([...revisions].map(([key, record]) => [key, current.some(item => item.id === record.id && item.version === record.version)
        ? record.id : 'restored:' + hash(key).slice(0, 32)]));
    const pending = [...revisions.values()].sort((a, b) => a.asOf - b.asOf);
    const imported = new Map();
    const skipped = [];
    let progress = true;
    while (pending.length && progress) {
        progress = false;
        for (let index = 0; index < pending.length;) {
            const item = pending[index];
            const previous = item.previousId && current.find(record => record.id === item.previousId);
            if ((previous && !imported.has(versionKey(previous)))
                || (item.dependencies || []).some(dependency => revisions.has(versionKey(dependency)) && !imported.has(versionKey(dependency)))) {
                index++;
                continue;
            }
            pending.splice(index, 1);
            progress = true;
            try {
                if (!Number.isInteger(item.asOf) || item.asOf < -1 || item.asOf >= state.timeline.length
                    || (item.inputRefs || []).some(ref => !sourceEligible(state, ref))) {
                    fail('A memory in this export is based on messages that no longer exist in this chat.');
                }
                const dependencies = (item.dependencies || []).map(dependency => {
                    const restored = imported.get(versionKey(dependency));
                    if (!restored) fail('An older memory that others depend on could not be restored from this export.');
                    return { id: restored.id, version: restored.version };
                });
                const target = targets.get(versionKey(item));
                const record = validateRecord(state, { ...item, id: target, dependencies }, { asOf: item.asOf, origin: 'author' });
                record.inputRefs = item.inputRefs || [];
                record.restoredOrigin = item.origin;
                if (item.historicalOnly === true && item.restoredFrom) {
                    record.historicalOnly = true;
                    record.restoredFrom = { id: strings([item.restoredFrom.id])[0], version: item.restoredFrom.version };
                }
                if (target !== item.id) {
                    record.historicalOnly = true;
                    record.restoredFrom = { id: item.id, version: item.version };
                }
                imported.set(versionKey(item), putRecord(state, record));
            } catch (error) {
                skipped.push({ id: item.id, reason: error.message });
            }
        }
    }
    skipped.push(...pending.map(item => ({ id: item.id, reason: 'A required linked memory could not be restored.' })));
    state.coverage = {};
    state.checkpoints = {};
    state.preview = null;
    return { restored: [...imported.values()].map(record => record.id), skipped };
}

route('/restore', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    if (body.recover === true) {
        const { state, token } = recoveryState(directories, locator, body.backup?.state);
        const source = readChat(directories, locator);
        const context = await readContextSources(directories, locator, state);
        syncSources(state, source.messages, context);
        purgeMissingContextSources(directories, state);
        const recoveryToken = hash([token, source.metadata, source.messages, context]);
        const result = restoreRecords(state, body.backup);
        if (body.apply === true) {
            if (body.recoveryToken !== recoveryToken) fail('The chat or its memories changed after you reviewed the restore. Review it again before restoring.', 409);
            commitRecovery(directories, locator, body.backup.state, state, token, hash([source.metadata, source.messages]));
        }
        return { ...result, recoveryToken, revision: state.revision, applied: body.apply === true };
    }
    const state = await loadCurrentState(directories, locator);
    expectedRevision(body, state);
    const proposed = structuredClone(state);
    const result = restoreRecords(proposed, body.backup);
    const saved = body.apply === true ? mutateState(directories, locator, () => proposed, state.revision) : state;
    return { ...result, revision: saved.revision, applied: body.apply === true };
});
