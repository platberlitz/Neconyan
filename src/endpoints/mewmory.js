import express from 'express';
import { abortOnRequestClose } from '../util.js';
import {
    continueState, eligibleRecords, fail, hash, list, object, putRecord, recordEligible, recordRevision,
    refKey, sourceAt, sourceEligible, strings, syncSources, text, undoRecord, validateRecord,
} from '../mewmory/core.js';
import { activeReferences, assemblyFingerprint, currentOverviews, generationFingerprint } from '../mewmory/context.js';
import { publicConfig, readConfig, roleVersion, saveConfig } from '../mewmory/models.js';
import { addUsage, pendingSources, processingVersion } from '../mewmory/processing.js';
import { cancelProcessing, startProcessing, waitForProcessing } from '../mewmory/worker.js';
import { recall } from '../mewmory/retrieval.js';
import { lexicalSearch, searchDocuments, updateIndex } from '../mewmory/search.js';
import { loadCurrentState, purgeMissingContextSources, readContextSources } from '../mewmory/sources.js';
import { commitRecovery, listStories, MAX_ARCHIVE_BYTES, mutateState, normalizeLocator, readChat, recoveryState } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { startOperation } from '../mewmory/operations.js';
import { listJobs } from '../jobs/store.js';

export const router = express.Router();

function route(url, handler) {
    router.post(url, async (request, response) => {
        const controller = new AbortController();
        const cancellation = abortOnRequestClose(request, controller, response);
        try {
            if (!request.user?.directories?.root) return response.sendStatus(401);
            if (Buffer.byteLength(JSON.stringify(request.body || {})) > MAX_ARCHIVE_BYTES + 1024 * 1024) fail('Mewmory request is too large.', 413);
            const result = await handler(request.user.directories, request.body || {}, controller.signal, request.user.profile?.handle);
            if (!response.destroyed) response.json(result);
        } catch (error) {
            if (!response.destroyed) response.status(error.status || 500).json({
                error: error.status ? error.message : 'Mewmory could not complete this operation. Its previous saved state has been kept.',
            });
            if (!error.status) console.error('[Mewmory]', error);
        } finally {
            cancellation.cleanup();
        }
    });
}

function expectedRevision(body, state) {
    if (!Number.isSafeInteger(body.revision) || body.revision !== state.revision) {
        fail('Mewmory changed in another operation. Refresh before applying this change.', 409);
    }
}

export function inspectState(state, config, { query = '', kind = '', ownerId = '', subjectId = '', significance = '', status = '', offset = 0 } = {}) {
    const search = String(query).toLocaleLowerCase();
    const filtered = state.records.filter(record => (!kind || (kind === 'objective'
        ? !['interview', 'overview'].includes(record.kind) : record.kind === kind))
        && (!ownerId || record.ownerId === ownerId) && (!subjectId || record.subjectIds.includes(subjectId))
        && (!significance || record.significance === significance) && (!status || record.status === status)
        && (!search || JSON.stringify(record).toLocaleLowerCase().includes(search)))
        .sort((a, b) => b.asOf - a.asOf || b.createdAt - a.createdAt);
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
        activeReferences: activeReferences(state), overviews: currentOverviews(state),
        entities: eligibleRecords(state).filter(record => record.kind === 'entity'),
        records: filtered.slice(page, page + 80).map(record => ({
            ...record, eligible: recordEligible(state, record),
            unavailableSources: record.refs.filter(ref => !sourceEligible(state, ref)).map(refKey),
        })),
        total: filtered.length, recordCount: state.records.length, offset: page,
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

route('/config/get', directories => ({ config: publicConfig(directories), stories: listStories(directories) }));
route('/config/save', (directories, body) => ({ config: saveConfig(directories, body.config) }));

route('/inspect', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    const inspection = { ...inspectState(state, readConfig(directories), body), operations: [] };
    try {
        inspection.operations = listJobs(directories)
            .filter(job => job.type.startsWith('mewmory.') && job.intent?.locator && hash(job.intent.locator) === hash(locator))
            .slice(0, 5).map(job => ({ id: job.id, label: job.label, state: job.state, error: job.error, warning: job.result?.warning, progress: job.progress }));
    } catch {
        inspection.operationsError = 'Saved job history is unavailable. Memory remains readable; the job ledger needs recovery before more jobs can run.';
    }
    return inspection;
});

route('/enabled', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    const state = mutateState(directories, locator, state => {
        state.enabled = body.enabled === true;
        state.preview = null;
    }, current.revision);
    return inspectState(state, readConfig(directories));
});

route('/scene', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    const active = body.activeNpcIds === null ? null : strings(body.activeNpcIds);
    if (active?.some(entityId => !current.records.some(record => record.kind === 'entity' && record.isCharacter
        && record.entityId === entityId && recordEligible(current, record)))) fail('Choose eligible AI-controlled characters.');
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
    return inspectState(saved, readConfig(directories));
});

route('/record/action', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const state = await loadCurrentState(directories, locator);
    expectedRevision(body, state);
    const saved = mutateState(directories, locator, state => {
        const record = state.records.find(item => item.id === body.id);
        if (!record) fail('Memory not found.', 404);
        if (body.action === 'undo') return void undoRecord(state, record.id);
        const changes = {
            suspicion: { status: 'uncertain', ...(['event', 'relationship'].includes(record.kind) ? { evidenceStatus: 'reported' } : {}) },
            never_learned: { status: 'invalidated' },
            unsupported: { status: 'invalidated' },
            resolved: { status: 'resolved' }, background: { status: 'background' }, active: { status: 'active' },
            pin: { pinned: !record.pinned }, exclude: { excluded: !record.excluded },
        }[body.action];
        if (!changes) fail('Unknown correction.');
        putRecord(state, { ...record, ...changes, origin: 'author', authorOverride: true, createdAt: Date.now() });
    }, state.revision);
    return inspectState(saved, readConfig(directories));
});

route('/source/get', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    object(body.ref, 'Source reference');
    const source = sourceAt(state, body.ref);
    if (!source) fail('That source revision is no longer available.', 404);
    return { ...source, id: body.ref.id, type: state.sources[body.ref.id].type, eligible: sourceEligible(state, body.ref) };
});

route('/source/exclude', async (directories, body) => {
    const locator = normalizeLocator(body.locator);
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    if (!current.sources[body.id]) fail('Source not found.', 404);
    const state = mutateState(directories, locator, state => {
        state.excludedSources = state.excludedSources.filter(id => id !== body.id);
        if (body.exclude === true) state.excludedSources.push(body.id);
        state.coverage = {};
        state.checkpoints = {};
        state.preview = null;
        state.index.pending = true;
    }, current.revision);
    return inspectState(state, readConfig(directories));
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

route('/search', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    const query = text(body.query, 'Search query', 6000);
    return { matches: lexicalSearch(searchDocuments(state), query, 40).map(({ document }) => document) };
});

route('/recall', (directories, body, signal, owner) => body.background === true
    ? startOperation(directories, owner, 'recall', body)
    : recall(directories, normalizeLocator(body.locator), { query: body.query || '', tokenizer: body.tokenizer || {}, signal }));

route('/validate', async (directories, body) => {
    const state = await loadCurrentState(directories, normalizeLocator(body.locator));
    if (body.fingerprint !== generationFingerprint(state, readConfig(directories))) {
        fail('The story or Mewmory changed while the prompt was being built. Generate again.', 409);
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
    if (hash(locator) === hash(parentLocator)) fail('Choose another chat.');
    const current = await loadCurrentState(directories, locator);
    expectedRevision(body, current);
    if (current.records.length || current.parent) fail('Start with a chat that has no Mewmory records before linking a continuation.');
    const parent = await loadCurrentState(directories, parentLocator);
    const state = mutateState(directories, locator, () => continueState(parent, locator, readChat(directories, locator).messages), current.revision);
    return inspectState(state, readConfig(directories));
});

route('/prepare', async (directories, body, signal) => {
    const locator = normalizeLocator(body.locator);
    const config = readConfig(directories);
    const state = await loadCurrentState(directories, locator);
    if (!state.enabled) return { enabled: false, excludedIndices: [], npcText: '', memoryText: '' };
    const snapshot = generationFingerprint(state, config);
    const source = readChat(directories, locator);
    if (body.integrity && source.metadata.integrity !== body.integrity) {
        fail('This chat changed in another tab. Reload before generating.', 409);
    }
    const offset = state.inheritedTimeline?.length || 0;
    const counter = await getCounter(config.writerTokenizer, body.tokenizer || {});
    let previous = -1;
    const history = list(body.history, 'Prompt history', 100000).map(item => {
        if (!Number.isInteger(item.index) || item.index <= previous || item.index >= source.messages.length) fail('Invalid prompt history order.');
        previous = item.index;
        return { index: item.index, tokens: counter.count(text(item.text, 'History text', 2000000, true)) + 4 };
    });
    const asOf = history.length ? history.at(-1).index + offset : offset - 1;
    const startForWindow = target => {
        let tokens = 0;
        let index = history.length;
        while (index > 0) {
            const next = history[index - 1].tokens;
            if (index < history.length && tokens + next > target) break;
            tokens += next;
            index--;
        }
        return index;
    };
    const desiredStart = config.excludeHistory ? startForWindow(config.historyWindow) : 0;
    const policy = processingVersion(config);
    const excludedIndices = [];
    for (const item of history.slice(0, desiredStart)) {
        const ref = state.timeline[item.index + offset];
        if (!ref || (sourceEligible(state, ref) && state.checkpoints[refKey(ref)] !== policy)) break;
        excludedIndices.push(item.index);
    }
    const context = await recall(directories, locator, { asOf, tokenizer: body.tokenizer || {}, signal, local: true });
    if (generationFingerprint(await loadCurrentState(directories, locator), readConfig(directories)) !== snapshot) {
        fail('The accepted sources, settings or author corrections changed during preparation. Reload and generate again.', 409);
    }
    const excluded = new Set(excludedIndices);
    const historyUsage = {
        originalTokens: history.reduce((sum, item) => sum + item.tokens, 0),
        retainedTokens: history.filter(item => !excluded.has(item.index)).reduce((sum, item) => sum + item.tokens, 0),
        target: config.historyWindow, excludedMessages: excluded.size, waitingForPreservation: excluded.size < desiredStart,
    };
    mutateState(directories, locator, current => {
        if (current.preview?.fingerprint === context.fingerprint) current.preview.history = historyUsage;
    });
    return {
        ...context, excludedIndices,
        history: historyUsage,
    };
});

export function restoreRecords(state, backup) {
    if (backup?.format !== 'mewmory-export-1' || backup.state?.storyId !== state.storyId || backup.state?.branchId !== state.branchId) {
        fail('This export belongs to another story or branch.');
    }
    const current = list(backup.state.records, 'Export records', 100000);
    if (!Array.isArray(backup.state.audit) || current.some(record => !Number.isSafeInteger(record.version) || record.version < 1)) fail('The export has invalid record versions.');
    if (new Set(current.map(record => record.id)).size !== current.length) fail('The export contains duplicate record IDs.');
    const versionKey = record => record.id + '@' + record.version;
    const revisions = new Map(current.map(record => [versionKey(record), record]));
    for (const record of revisions.values()) {
        for (const dependency of record.dependencies || []) {
            const key = versionKey(dependency);
            if (revisions.has(key)) continue;
            const historical = recordRevision(backup.state, dependency.id, dependency.version);
            if (historical) revisions.set(key, historical);
        }
        if (revisions.size > 100000) fail('Too many exported record revisions.');
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
                    fail('The record’s source boundary is no longer available.');
                }
                const dependencies = (item.dependencies || []).map(dependency => {
                    const restored = imported.get(versionKey(dependency));
                    if (!restored) fail('A required historical memory could not be restored.');
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
            if (body.recoveryToken !== recoveryToken) fail('The chat or its memory changed. Review recovery again.', 409);
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
