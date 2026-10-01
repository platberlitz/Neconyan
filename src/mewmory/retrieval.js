import {
    eligibleRecords, fail, hash, list, object, refKey, sourceAt, sourceEligible, text,
} from './core.js';
import { SELECTION_CONTRACT } from './contracts.js';
import { assemblyFingerprint, assembleContext, currentOverviews, generationFingerprint } from './context.js';
import { callJsonRole, embed, readConfig, roleVersion } from './models.js';
import { addUsage } from './processing.js';
import { expandNeighbours, hybridCandidates, searchDocuments, terms, updateIndex } from './search.js';
import { RAG_DEFAULTS } from '../../public/scripts/mewmory/rag-settings.js';
import { loadCurrentState } from './sources.js';
import { mutateState, statePath } from './store.js';
import { getCounter } from './tokens.js';
import { listJobs } from '../jobs/store.js';

const running = new Map();

/** One recall per user/story; a slow provider must not accumulate work on every send. */
export function recallInBackground(directories, locator, options = {}, dependencies = {}) {
    const key = statePath(directories, locator);
    if (running.has(key)) return running.get(key);
    const job = recall(directories, locator, { ...options, local: false, background: true, signal: undefined }, dependencies)
        .finally(() => running.delete(key));
    running.set(key, job);
    job.catch(error => console.warn('Mewmory background recall:', error.message));
    return job;
}

export function recallFingerprint(state, config, sourceCount) {
    return generationFingerprint({ ...state, timeline: state.timeline.slice(0, sourceCount) }, config);
}

function onlyKeys(value, keys, label) {
    object(value, label);
    if (Object.keys(value).some(key => !keys.includes(key))) fail('Unexpected fields in ' + label + ' from the Recall selector.');
}

export function validateSelection(output, candidates, scene) {
    onlyKeys(output, ['status', 'selections', 'rejections', 'needsEvidence'], 'selector output');
    if (!['complete', 'needs_evidence', 'uncertain'].includes(output.status)) fail('The Recall selector sent back a status Mewmory does not recognise.');
    const allowed = new Map(candidates.map(candidate => [candidate.recordId, candidate]));
    const cueIds = new Set(scene.map(cue => cue.id));
    const selected = new Set();
    const selections = list(output.selections, 'Selections', candidates.length).map(selection => {
        onlyKeys(selection, ['recordId', 'relevanceType', 'currentCueRefs', 'memoryEvidenceRefs', 'justification'], 'selection');
        const candidate = allowed.get(selection.recordId);
        if (!candidate || selected.has(selection.recordId)) fail('The Recall selector picked a memory that was not on offer, or the same one twice (invalid or duplicate ID).');
        selected.add(selection.recordId);
        if (!['direct', 'associative'].includes(selection.relevanceType)) fail('The Recall selector marked a memory with a relevance type Mewmory does not recognise.');
        const currentCueRefs = list(selection.currentCueRefs, 'Current cues', 12);
        const memoryEvidenceRefs = list(selection.memoryEvidenceRefs, 'Memory evidence', 24);
        const evidence = new Set([...candidate.sourceRefs, ...candidate.linkedRecordIds, candidate.recordId]);
        if (!currentCueRefs.length || currentCueRefs.some(cue => !cueIds.has(cue))
            || !memoryEvidenceRefs.length || memoryEvidenceRefs.some(ref => !evidence.has(ref))) {
            fail('The Recall selector backed a pick with messages it was not shown (unsupported evidence reference).');
        }
        return {
            recordId: candidate.recordId, relevanceType: selection.relevanceType,
            currentCueRefs, memoryEvidenceRefs, justification: text(selection.justification, 'Justification', 1600),
        };
    });
    const rejected = new Set();
    const rejections = list(output.rejections, 'Rejections', candidates.length).map(rejection => {
        onlyKeys(rejection, ['recordId', 'justification'], 'rejection');
        if (!allowed.has(rejection.recordId) || selected.has(rejection.recordId) || rejected.has(rejection.recordId)) fail('The Recall selector turned down a memory that was not on offer, or listed it twice.');
        rejected.add(rejection.recordId);
        return { recordId: rejection.recordId, justification: text(rejection.justification, 'Rejection', 1600) };
    });
    const needsEvidence = list(output.needsEvidence, 'Evidence requests', 6);
    if (needsEvidence.some(key => !allowed.has(key)) || (output.status === 'complete' && needsEvidence.length)) fail('The Recall selector asked for more detail on a memory that was not on offer.');
    return { status: output.status, selections, rejections, needsEvidence };
}

function candidateInput(state, documents, asOf) {
    const overviews = currentOverviews(state, asOf);
    return documents.map(document => {
        return {
            recordId: document.id, kind: document.kind, asOf: document.asOf, status: document.status,
            significance: document.significance || 'low',
            significanceEvidence: (document.evidenceRefs || []).map(refKey),
            ownerId: document.ownerId, subjectIds: document.subjectIds,
            searchDescription: document.searchText, excerpt: document.text,
            sourceRefs: document.refs.map(refKey),
            linkedRecordIds: document.linkedRecordIds || [],
            currentOverviews: overviews.filter(item => item.ownerId === document.ownerId
                && item.subjectIds.some(subject => document.subjectIds.includes(subject)))
                .map(item => ({ id: item.id, text: item.text, asOf: item.asOf, status: item.status })),
        };
    });
}

export function forcedMatches(state, documents, query, asOf) {
    const queryTerms = new Set(terms(query));
    const records = eligibleRecords(state, { asOf }).filter(record => record.pinned
        || (record.kind === 'commitment' && record.status === 'active'
            && record.triggerTerms.some(trigger => {
                const words = terms(trigger);
                return words.length > 0 && words.every(term => queryTerms.has(term));
            })));
    const ids = new Set(records.map(record => record.id));
    return documents.filter(document => ids.has(document.recordId));
}

async function selectMemories(state, directories, config, documents, scene, allDocuments, asOf, signal, call) {
    const usage = [];
    let candidates = candidateInput(state, documents, asOf);
    let status = { status: 'uncertain', selections: [], rejections: [], needsEvidence: [] };
    let error = '';
    let fallbackUsed = false;
    const select = async (role, repair = false) => {
        const dataTypes = [...new Set(['chat', ...documents.map(document => document.dataType),
            ...(candidates.some(candidate => candidate.currentOverviews.length) ? ['memory'] : [])])];
        const result = await call(directories, config, role,
            SELECTION_CONTRACT + (repair ? '\nThe previous attempt failed validation. Follow the exact schema and supplied IDs.' : ''),
            { scene, candidates }, { dataTypes, signal });
        usage.push(result.usage);
        return validateSelection(result.value, candidates, scene);
    };
    if (!documents.length) return { status: { ...status, status: 'complete' }, documents, usage, fallbackUsed, error };
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            status = await select('selector', attempt > 0);
            error = '';
            break;
        } catch (failure) {
            error = failure.message;
            if ([403, 409].includes(failure.status)) break;
        }
    }
    if (!error && status.status === 'needs_evidence') {
        const requested = documents.filter(document => status.needsEvidence.includes(document.id));
        const refs = new Set(requested.flatMap(document => document.refs.map(refKey)));
        const linkedIds = new Set(candidates.filter(candidate => status.needsEvidence.includes(candidate.recordId)).flatMap(candidate => candidate.linkedRecordIds));
        const supplied = new Set(documents.map(document => document.id));
        const expansion = allDocuments.filter(document => !supplied.has(document.id) && (document.refs.some(ref => refs.has(refKey(ref)))
            || linkedIds.has(document.recordId))).sort((a, b) => Number(b.kind === 'source') - Number(a.kind === 'source')).slice(0, 12);
        documents = [...new Map([...documents, ...expansion].map(document => [document.id, document])).values()];
        candidates = candidateInput(state, documents, asOf);
        try { status = await select('selector'); } catch (failure) { error = failure.message; }
    }
    if ((error || status.status !== 'complete') && config.roles.fallback.enabled) {
        fallbackUsed = true;
        try {
            status = await select('fallback');
            error = '';
        } catch (failure) {
            error = failure.message;
        }
    }
    if (error || status.status !== 'complete') status = { ...status, selections: [], status: 'degraded' };
    return { status, documents, usage, fallbackUsed, error };
}

export async function recall(directories, locator, {
    asOf = Infinity, query: manualQuery = '', tokenizer = {}, signal, local = false, background = false, operationId,
} = {}, { call = callJsonRole, embedFn = embed, loadState = loadCurrentState, mutate = mutateState,
    scheduleBackground = true, readConfiguration = readConfig } = {}) {
    const config = readConfiguration(directories);
    const retrieval = { ...RAG_DEFAULTS, ...config.retrieval };
    const state = await loadState(directories, locator);
    if (!state.enabled) return { enabled: false, npcText: '', memoryText: '', tokens: { npc: 0, memory: 0 } };
    const fingerprint = assemblyFingerprint(state, config);
    const validationFingerprint = generationFingerprint(state, config);
    const sourceCount = state.timeline.length;
    const indexSnapshot = hash(state.index);
    const counter = await getCounter(config.writerTokenizer, tokenizer);
    const usage = [];
    let indexError = '';
    if (!local) try {
        const indexed = await updateIndex(state, directories, config, { signal, embedFn });
        usage.push(...indexed.usage);
    } catch (error) {
        indexError = error.message;
    }
    const scene = state.timeline.filter(ref => sourceEligible(state, ref, asOf)).slice(-retrieval.queryMessages).map(ref => {
        const source = sourceAt(state, ref);
        return { id: refKey(ref), speaker: source.speaker, text: source.text.slice(-6000) };
    });
    if (manualQuery) scene.push({ id: 'inspection-query', speaker: 'Author search', text: text(manualQuery, 'Search', 6000) });
    const query = scene.map(cue => cue.speaker + ': ' + cue.text).join('\n');
    const allDocuments = searchDocuments(state, asOf, config);
    let vector = null;
    if (!local && retrieval.mode !== 'keyword' && query.trim() && config.roles.embedding.enabled && state.index.version === roleVersion(config, 'embedding')) {
        try {
            const result = await embedFn(directories, config, [query], { query: true, signal, dataTypes: ['chat'] });
            usage.push(result.usage);
            vector = result.vectors[0];
            const indexedDimension = Object.values(state.index.vectors)[0]?.vector.length;
            if (indexedDimension && vector.length !== indexedDimension) {
                vector = null;
                fail('The query vector has a different size from the index. Set a new model revision and rebuild the index.', 502);
            }
        } catch (error) {
            indexError = error.message;
        }
    }
    const forced = forcedMatches(state, allDocuments, query, asOf);
    const candidates = [...new Map([...forced, ...hybridCandidates(allDocuments, query, vector,
        state.index.vectors, config.candidateLimit, retrieval)].map(document => [document.id, document])).values()];
    const cached = local && state.recalls.findLast(item => item.status === 'complete' && item.asOf <= asOf
        && item.sourceCount <= sourceCount && item.validationFingerprint === recallFingerprint(state, config, item.sourceCount));
    const selection = local ? {
        status: { status: 'local', selections: cached?.selections || [], rejections: [], needsEvidence: [] },
        documents: candidates, usage: [], fallbackUsed: false, error: '',
    } : !config.roles.selector.enabled ? {
        status: { status: 'complete', selections: candidates.slice(0, retrieval.resultLimit).map(document => ({ recordId: document.id,
            relevanceType: 'direct', currentCueRefs: scene.map(cue => cue.id), memoryEvidenceRefs: document.refs.map(refKey),
            justification: 'Selected by ranked retrieval; AI selection is switched off.' })), rejections: [], needsEvidence: [] },
        documents: candidates, usage: [], fallbackUsed: false, error: '',
    } : await selectMemories(state, directories, config, candidates, scene, allDocuments, asOf, signal, call);
    usage.push(...selection.usage);
    await loadState(directories, locator);
    const rankedIds = [...new Set([...selection.status.selections.map(item => item.recordId), ...(local ? candidates.map(document => document.id) : [])])];
    const selectedIds = new Set([...forced.map(document => document.id), ...rankedIds.slice(0, retrieval.resultLimit)]);
    // Use one coherent completed snapshot; the model never supplies assembled memory text.
    const currentById = new Map(allDocuments.map(document => [document.id, document]));
    const currentDocuments = expandNeighbours([...selectedIds].map(id => currentById.get(id)).filter(Boolean), allDocuments, retrieval.neighbourChunks);
    const assembly = assembleContext(state, currentDocuments, {
        asOf, counter, memoryTokens: config.memoryTokens, forcedIds: forced.map(document => document.id),
    });
    const inspection = {
        id: operationId || hash([Date.now(), fingerprint, scene]), at: Date.now(), asOf: Number.isFinite(asOf) ? asOf : state.timeline.length - 1,
        status: selection.status.status, fallbackUsed: selection.fallbackUsed,
        error: selection.error, indexError, ...selection.status,
        candidates: selection.documents.map(document => ({ id: document.id, kind: document.kind, refs: document.refs,
            dataType: document.dataType, ...(document.kind === 'source' ? { sourceName: document.sourceName, start: document.start, end: document.end } : {}),
            ...document.retrieval })),
        retrieval: { requestedMode: retrieval.mode, usedMode: vector ? retrieval.mode : 'keyword',
            keywordFallback: retrieval.mode !== 'keyword' && !vector, aiSelection: !local && config.roles.selector.enabled,
            documents: allDocuments.length, indexed: Object.keys(state.index.vectors).length, selected: assembly.selected,
            expanded: currentDocuments.filter(document => !selectedIds.has(document.id)).map(document => document.id),
            limited: rankedIds.slice(retrieval.resultLimit) },
        forcedIds: forced.map(document => document.id), omitted: assembly.omitted, usage,
        sourceCount, validationFingerprint, background,
    };
    const retainedJobs = operationId ? new Set(listJobs(directories, { includeDismissed: true }).map(job => job.id)) : null;
    mutate(directories, locator, current => {
        signal?.throwIfAborted();
        const currentConfig = readConfiguration(directories);
        if ((background ? recallFingerprint(current, currentConfig, sourceCount) : generationFingerprint(current, currentConfig)) !== validationFingerprint) {
            fail('The chat, Mewmory settings, or a memory you edited changed while memories were being picked. Send or regenerate again.', 409);
        }
        const indexState = background ? { ...current, timeline: current.timeline.slice(0, sourceCount) } : current;
        if (!local && assemblyFingerprint(indexState, config) === fingerprint && hash(current.index) === indexSnapshot) {
            current.index = { ...state.index, pending: state.index.pending || current.timeline.length > sourceCount };
        }
        if (operationId && current.recallReceipts?.includes(operationId)) return;
        if (operationId) current.recallReceipts = [...(current.recallReceipts || []).filter(id => retainedJobs.has(id)), operationId];
        current.recalls = [...current.recalls.slice(-9), inspection];
        if (!background) current.preview = { ...assembly, fingerprint };
        addUsage(current, usage);
    });
    if (local && scheduleBackground) recallInBackground(directories, locator, { asOf: Math.min(asOf, sourceCount - 1), query: manualQuery, tokenizer }, { call, embedFn });
    return { enabled: true, ...assembly, inspection, fingerprint, validationFingerprint };
}
