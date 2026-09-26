import {
    currentRecords, eligibleRecords, fail, findQuote, hash, id, list, object, POLICY_VERSION,
    putRecord, recordEligible, recordRevision, refKey, sourceAt, sourceEligible, sourceFingerprint,
    strings, uniqueRefs, validateRecord, validateRefs,
} from './core.js';
import { EXTRACTION_CONTRACT, PAWSPECTIVE_CONTRACT } from './contracts.js';
import { callJsonRole, readConfig, ROLE_LABELS, roleVersion } from './models.js';
import { loadCurrentState } from './sources.js';
import { mutateState, statePath } from './store.js';

const running = new Map();
const objectiveKinds = ['entity', 'state', 'event', 'relationship', 'knowledge', 'commitment'];
export const processingVersion = config => hash([POLICY_VERSION, roleVersion(config, 'extractor'), roleVersion(config, 'pawspective')]);

function processingFingerprint(state, sourceCount) {
    return hash([sourceFingerprint({ ...state, timeline: state.timeline.slice(0, sourceCount) }),
        state.enabled, state.activeNpcIds, state.sceneNpcIds, state.castHistory, state.records, state.audit, state.overrides]);
}

export function pendingSources(state, config, { checkpoint = false, through = Infinity } = {}) {
    const policy = processingVersion(config);
    const coverage = checkpoint ? state.checkpoints : state.coverage;
    return state.timeline.filter(ref => sourceEligible(state, ref, through) && coverage[refKey(ref)] !== policy);
}

export function addUsage(state, entries) {
    state.usage ??= {};
    for (const entry of entries) {
        const total = state.usage[entry.role] ??= { requests: 0, input: 0, output: 0, milliseconds: 0 };
        total.requests++;
        for (const key of ['input', 'output', 'milliseconds']) total[key] += entry[key] || 0;
    }
}

function seedCharacters(state) {
    for (const ref of state.contextSources) {
        const source = state.sources[ref.id];
        const revision = sourceAt(state, ref);
        if (source.type !== 'character' || !sourceEligible(state, ref)) continue;
        if (state.records.some(record => record.kind === 'entity' && record.entityId === revision.entityId && recordEligible(state, record))) continue;
        const record = validateRecord(state, {
            id: 'entity:' + revision.entityId, kind: 'entity', entityId: revision.entityId,
            name: revision.speaker, text: revision.speaker, isCharacter: true,
            refs: [ref], subjectIds: [revision.entityId],
        }, { asOf: -1, origin: 'character_card' });
        putRecord(state, record, { automatic: true });
    }
}

function knowledgeForTime(state, id, asOf) {
    return eligibleRecords(state, { asOf }).filter(record => record.kind === 'knowledge'
        && (record.id === id || record.restoredFrom?.id === id))
        .sort((a, b) => b.asOf - a.asOf || b.createdAt - a.createdAt)[0];
}

function matchScore(text, query) {
    const terms = new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []);
    return (String(text).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).reduce((sum, term) => sum + Number(terms.has(term)), 0);
}

export function extractionInput(state, refs, asOf, checkpoint) {
    const scene = refs.map(ref => ({ ...ref, type: 'chat', ...sourceAt(state, ref) }));
    const query = scene.map(source => source.text).join('\n');
    const context = state.contextSources.filter(ref => sourceEligible(state, ref))
        .map(ref => ({ ...ref, type: state.sources[ref.id].type, ...sourceAt(state, ref) }));
    const lore = context.filter(source => source.type === 'lore')
        .map(source => ({ source, score: matchScore(source.text, query) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 16).map(item => item.source);
    const sources = [...scene, ...context.filter(source => source.type === 'character'), ...lore];
    const records = eligibleRecords(state, { asOf }).filter(record => objectiveKinds.includes(record.kind));
    const reference = currentRecords(records.filter(record => ['entity', 'state'].includes(record.kind)), record => record.kind + ':' + record.entityId);
    const relevant = records.filter(record => !['entity', 'state'].includes(record.kind))
        .map(record => ({ record, score: matchScore(record.text, query) }))
        .sort((a, b) => b.score - a.score || b.record.asOf - a.record.asOf).slice(0, 40).map(item => item.record);
    return {
        policy: POLICY_VERSION, mode: checkpoint ? 'preservation_checkpoint' : 'live_update', asOf,
        sources, existing: [...reference, ...relevant],
        authorOverrides: state.records.filter(record => record.authorOverride && record.asOf <= asOf)
            .map(record => objectiveKinds.includes(record.kind) && recordEligible(state, record, { asOf }) ? record
                : { id: record.id, kind: record.kind, excluded: record.excluded, status: record.status }),
    };
}

/** Model-proposed importance stands only on a cited chat message from this batch; otherwise it quietly becomes low. */
function settleSignificance(state, proposed, refs) {
    const evidenceRefs = (Array.isArray(proposed.evidenceRefs) ? proposed.evidenceRefs : [])
        .filter(ref => ref && typeof ref === 'object' && refs.has(refKey(ref)) && state.sources[ref.id]?.type === 'chat');
    if (!['medium', 'high'].includes(proposed.significance) || !evidenceRefs.length) return { significance: 'low', evidenceRefs: [] };
    return { significance: proposed.significance, evidenceRefs };
}

/** Small models often slip on IDs; spaces become dashes and other characters are dropped, with a hash so names stay distinct. */
function cleanId(value) {
    if (typeof value !== 'string') return value;
    const dashed = value.trim().replace(/\s+/g, '-');
    if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(dashed)) return dashed;
    const kept = dashed.replace(/[^a-zA-Z0-9_.:-]/g, '').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 140);
    return (kept ? kept + '-' : 'id-') + hash(value).slice(0, 8);
}

const cleanIds = value => Array.isArray(value) ? value.map(cleanId) : [];

/** Points model-cited sources at this batch's current revisions, whatever revision or format the model wrote. */
function batchRefs(value, batch) {
    return uniqueRefs((Array.isArray(value) ? value : [value])
        .map(ref => batch.get(typeof ref === 'string' ? ref.split('@')[0] : ref?.id)).filter(Boolean));
}

/** Repairs the slips cheap models make, so one wrong detail does not sink an otherwise good reply. */
function tidyProposal(state, proposed, batch, asOf) {
    const tidy = { ...proposed, id: cleanId(proposed.id), subjectIds: cleanIds(proposed.subjectIds) };
    for (const key of ['entityId', 'ownerId']) if (key in tidy) tidy[key] = cleanId(tidy[key]);
    tidy.refs = batchRefs(proposed.refs, batch);
    tidy.evidenceRefs = batchRefs(proposed.evidenceRefs || [], batch);
    const usable = eligibleRecords(state, { asOf }).filter(record => objectiveKinds.includes(record.kind));
    tidy.dependencies = (Array.isArray(proposed.dependencies) ? proposed.dependencies : [])
        .map(dependency => usable.find(record => record.id === (typeof dependency === 'string' ? dependency : dependency?.id)))
        .filter(Boolean).map(record => ({ id: record.id, version: record.version }));
    if (tidy.kind === 'knowledge' && typeof tidy.evidenceText === 'string') {
        const sources = [...tidy.refs, ...batch.values()];
        const found = sources.map(ref => ({ ref, quote: findQuote(sourceAt(state, ref)?.text || '', tidy.evidenceText) }))
            .find(item => item.quote);
        if (found) {
            tidy.evidenceText = found.quote;
            tidy.refs = uniqueRefs([...tidy.refs, found.ref]);
        }
    }
    return tidy;
}

function modelOutput(name, action) {
    try {
        return action();
    } catch (error) {
        if (error.status && error.status !== 400) throw error;
        fail('The ' + ROLE_LABELS[name] + ' model sent back something Mewmory could not save: ' + error.message
            + ' Nothing from these messages was kept. Try again, or choose a different model for ' + ROLE_LABELS[name] + ' in Mewmory settings.', 502);
    }
}

/** A wrong detail from the model is left out and noted in skipped; only a reply Mewmory cannot read at all fails the batch. */
export function applyExtraction(state, output, input, skipped = []) {
    object(output, 'Extraction');
    const refs = new Set(input.sources.map(refKey));
    const batch = new Map(input.sources.map(source => [source.id, { id: source.id, revision: source.revision }]));
    const records = list(output.records ?? [], 'Extracted records', Infinity).slice(0, 80)
        .filter(proposed => proposed && typeof proposed === 'object').map(proposed => tidyProposal(state, proposed, batch, input.asOf));
    const order = { entity: 0, state: 1, event: 2, relationship: 3, knowledge: 4, commitment: 5 };
    const seen = new Set();
    for (const proposed of records.slice().sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))) try {
        if (!objectiveKinds.includes(proposed.kind) || seen.has(proposed.id)) fail('The reply listed a memory of an unknown type, or the same memory twice.');
        seen.add(proposed.id);
        let candidate = { ...proposed, ...settleSignificance(state, proposed, refs) };
        if (candidate.kind === 'entity') {
            const previous = state.records.find(record => record.id === candidate.id && recordEligible(state, record, { asOf: input.asOf }));
            if (previous) {
                candidate = {
                    ...candidate,
                    appearance: candidate.appearance || previous.appearance,
                    speech: candidate.speech || previous.speech,
                    refs: uniqueRefs([...(candidate.refs || []), ...previous.refs]),
                };
                for (const ref of previous.refs) refs.add(refKey(ref));
            }
        }
        const record = validateRecord(state, candidate, { asOf: input.asOf, origin: 'objective_extractor', allowedRefs: refs });
        record.asOf = Math.max(-1, ...record.refs.map(ref => sourceAt(state, ref).sequence),
            ...record.dependencies.map(dependency => recordRevision(state, dependency.id, dependency.version).asOf));
        record.provenance = input.provenance;
        record.inputRefs = input.sources.filter(source => source.type === 'chat').map(({ id, revision }) => ({ id, revision }));
        putRecord(state, record, { automatic: true });
    } catch (error) {
        if (![400, 409].includes(error.status)) throw error;
        skipped.push(error.message);
    }
    const active = [...new Set(cleanIds(output.activeNpcIds))].filter(entityId => state.records.some(record => record.kind === 'entity'
        && record.entityId === entityId && record.isCharacter && recordEligible(state, record, { asOf: input.asOf })));
    state.castHistory = [...(state.castHistory || []).filter(entry => entry.asOf !== input.asOf), {
        asOf: input.asOf, ids: active, refs: input.sources.map(({ id, revision }) => ({ id, revision })),
    }].sort((a, b) => a.asOf - b.asOf);
    state.sceneNpcIds = state.castHistory.at(-1).ids;
    return (Array.isArray(output.interviews) ? output.interviews : []).slice(0, 4).flatMap(request => {
        try {
            object(request, 'Interview request');
            const tidy = { ...request, refs: batchRefs(request.refs, batch), evidenceRefs: batchRefs(request.evidenceRefs || [], batch) };
            return [{
                ownerId: id(cleanId(request.ownerId)), subjectIds: strings(cleanIds(request.subjectIds)),
                knowledgeIds: strings(cleanIds(request.knowledgeIds), 'Knowledge IDs', 24),
                refs: validateRefs(state, tidy.refs, { asOf: input.asOf, allowedRefs: refs }),
                ...settleSignificance(state, tidy, refs), reason: String(request.reason || '').slice(0, 2000),
            }];
        } catch (error) {
            if (![400, 409].includes(error.status)) throw error;
            skipped.push(error.message);
            return [];
        }
    });
}

/** Only acquired knowledge enters an interview, never an omniscient scene or a whole lore entry. */
export function interviewInput(state, request, asOf) {
    const eligible = eligibleRecords(state, { asOf });
    const owner = eligible.find(record => record.kind === 'entity' && record.entityId === request.ownerId && record.isCharacter);
    if (!owner || request.ownerId === 'player' || !request.subjectIds.length) fail('A Pawspective interview was requested for someone who is not a known AI character, or without saying who it is about.');
    const knowledge = request.knowledgeIds.map(key => knowledgeForTime(state, key, asOf))
        .map(record => record?.ownerId === request.ownerId ? record : null);
    if (!knowledge.length || knowledge.some(record => !record)) fail('A Pawspective interview can only use things this character actually learned in the story, and none were given.');
    const history = eligible.filter(record => record.kind === 'interview' && record.ownerId === request.ownerId
        && record.subjectIds.some(subject => request.subjectIds.includes(subject)))
        .sort((a, b) => b.asOf - a.asOf || b.createdAt - a.createdAt).slice(0, 3).reverse();
    const overviews = currentRecords(eligible.filter(record => record.kind === 'overview' && record.ownerId === request.ownerId
        && record.subjectIds.some(subject => request.subjectIds.includes(subject))), record => record.subjectIds.join(':'));
    return {
        policy: POLICY_VERSION, asOf,
        owner: { id: owner.entityId, recordId: owner.id, version: owner.version, name: owner.name, appearance: owner.appearance, speech: owner.speech },
        subjectIds: request.subjectIds,
        knownFacts: knowledge.map(record => ({ id: record.id, text: record.text, method: record.method, refs: record.refs })),
        priorInterviews: history.map(record => ({ id: record.id, version: record.version, asOf: record.asOf, interview: record.interview, changeExplanation: record.changeExplanation })),
        currentOverviews: overviews.map(record => ({ id: record.id, version: record.version, subjectIds: record.subjectIds, text: record.text })),
    };
}

export function interviewEvidenceKey(state, request, asOf = Infinity) {
    return hash([request.ownerId, request.subjectIds, request.refs,
        request.knowledgeIds.map(id => {
            const record = knowledgeForTime(state, id, asOf);
            return record && [record.id, record.text, record.refs];
        })]);
}

export function applyInterview(state, request, output, input, jobId) {
    object(output, 'Pawspective');
    if (output.changed === 'false' || output.changed === 'true') output = { ...output, changed: output.changed === 'true' };
    if (output.changed === undefined && Array.isArray(output.interview)) output = { ...output, changed: true };
    if (output.changed === false) {
        if (Array.isArray(output.interview) && output.interview.length) fail('The reply said nothing changed but still included new interview content.');
        return;
    }
    if (output.changed !== true) {
        fail('The reply was not a Pawspective interview in the expected format.');
    }
    const knowledge = request.knowledgeIds.map(key => knowledgeForTime(state, key, input.asOf));
    const evidenceKey = interviewEvidenceKey(state, request, input.asOf);
    const snapshotId = 'interview:' + hash([jobId, evidenceKey, input.asOf]).slice(0, 32);
    const dependencies = [
        ...knowledge.map(record => ({ id: record.id, version: record.version })),
        { id: input.owner.recordId, version: input.owner.version },
        ...input.priorInterviews.map(record => ({ id: record.id, version: record.version })),
        ...input.currentOverviews.map(record => ({ id: record.id, version: record.version })),
    ].filter(record => record.id !== snapshotId);
    const refs = uniqueRefs([...request.refs, ...knowledge.flatMap(record => record.refs)]);
    const record = validateRecord(state, {
        id: snapshotId,
        kind: 'interview', ownerId: request.ownerId, subjectIds: request.subjectIds,
        refs, dependencies, interview: output.interview, searchDescription: output.searchDescription,
        previousId: input.priorInterviews.at(-1)?.id || '', changeExplanation: output.changeExplanation,
        significance: request.significance, evidenceRefs: request.evidenceRefs,
    }, { asOf: input.asOf, origin: 'generated_interview' });
    record.provenance = input.provenance;
    record.evidenceKey = evidenceKey;
    const saved = putRecord(state, record, { automatic: true });
    if (saved.authorOverride) return;
    if (!recordEligible(state, saved, { asOf: input.asOf })) fail('The new Pawspective interview could not be saved because something it relies on changed. These messages will be tried again.', 409);
    const overviews = list(output.overviews, 'Subject overviews', request.subjectIds.length);
    if (overviews.length !== request.subjectIds.length || new Set(overviews.map(item => item.subjectId)).size !== request.subjectIds.length) {
        fail('The reply must include one short summary for each person or thing the interview is about.');
    }
    for (const overview of overviews) {
        if (!request.subjectIds.includes(overview.subjectId)) fail('The reply summarised someone or something the interview was not about.');
        const current = validateRecord(state, {
            id: 'overview:' + hash([record.id, overview.subjectId]).slice(0, 32),
            kind: 'overview', ownerId: request.ownerId, subjectIds: [overview.subjectId],
            text: overview.text, status: overview.status, refs,
            dependencies: [{ id: saved.id, version: saved.version }],
            significance: request.significance, evidenceRefs: request.evidenceRefs,
        }, { asOf: input.asOf, origin: 'generated_overview' });
        current.provenance = input.provenance;
        putRecord(state, current, { automatic: true });
    }
}

async function runBatch(directories, locator, options, call) {
    const config = readConfig(directories);
    let state = await loadCurrentState(directories, locator);
    if (!state.enabled) return state;
    const refs = pendingSources(state, config, options).slice(0, config.batchMessages);
    if (!refs.length) return state;
    const asOf = Math.max(...refs.map(ref => sourceAt(state, ref).sequence));
    const snapshot = sourceFingerprint(state);
    const policy = processingVersion(config);
    const jobId = hash([policy, snapshot, refs, Boolean(options.checkpoint)]);
    state = mutateState(directories, locator, current => {
        seedCharacters(current);
        current.jobs = current.jobs.filter(job => job.id !== jobId).slice(-39);
        current.jobs.push({ id: jobId, status: 'processing', checkpoint: Boolean(options.checkpoint),
            from: sourceAt(current, refs[0]).sequence, through: asOf, startedAt: Date.now(), policy });
    }, state.revision);
    const sourceCount = state.timeline.length;
    const snapshotFingerprint = processingFingerprint(state, sourceCount);
    const auditLength = state.audit.length;
    const usage = [];
    const skipped = [];
    try {
        const input = extractionInput(state, refs, asOf, options.checkpoint);
        input.provenance = { policy: POLICY_VERSION, jobId, role: 'extractor', model: config.roles.extractor.model, modelRevision: config.roles.extractor.modelRevision };
        const dataTypes = [...new Set([...input.sources.map(source => source.type), ...(input.existing.length || input.authorOverrides.length ? ['memory'] : [])])];
        const extraction = await call(directories, config, 'extractor', EXTRACTION_CONTRACT, input, { dataTypes, signal: options.signal });
        usage.push(extraction.usage);
        const requestAsOf = request => Math.max(-1, ...request.refs.map(ref => sourceAt(state, ref).sequence));
        const requests = modelOutput('extractor', () => applyExtraction(state, extraction.value, input, skipped)).sort((a, b) => requestAsOf(a) - requestAsOf(b));
        for (const request of requests) {
            const interviewAsOf = requestAsOf(request);
            let interview;
            try {
                interview = interviewInput(state, request, interviewAsOf);
            } catch (error) {
                if (error.status !== 400) throw error;
                skipped.push(error.message);
                continue;
            }
            const evidenceKey = interviewEvidenceKey(state, request, interviewAsOf);
            if (state.records.some(record => record.kind === 'interview' && record.evidenceKey === evidenceKey && recordEligible(state, record, { asOf: interviewAsOf }))) continue;
            interview.provenance = { policy: POLICY_VERSION, jobId, role: 'pawspective',
                model: config.roles.pawspective.model, modelRevision: config.roles.pawspective.modelRevision };
            const generated = await call(directories, config, 'pawspective', PAWSPECTIVE_CONTRACT, interview, { dataTypes: ['memory'], signal: options.signal });
            usage.push(generated.usage);
            const records = state.records;
            const interviewAudit = state.audit.length;
            try {
                applyInterview(state, request, generated.value, interview, jobId);
            } catch (error) {
                if (error.status !== 400) throw error;
                // A half-written interview must not stay behind without its overviews.
                state.records = records;
                state.audit.length = interviewAudit;
                skipped.push(error.message);
            }
        }
        await loadCurrentState(directories, locator);
        if (options.signal?.aborted) fail('Mewmory request cancelled.', 499);
        return mutateState(directories, locator, current => {
            if (processingFingerprint(current, sourceCount) !== snapshotFingerprint || processingVersion(readConfig(directories)) !== policy) {
                fail('The chat, Mewmory settings, or a memory you edited changed while this was running, so this result was discarded. It will be tried again.', 409);
            }
            // Keep appended sources, concurrent recall, indexing and usage; this batch owns only its memory changes.
            current.records = state.records;
            current.audit = state.audit;
            current.sceneNpcIds = state.sceneNpcIds;
            current.castHistory = state.castHistory;
            current.index.pending ||= state.audit.length > auditLength;
            for (const ref of refs) {
                current.coverage[refKey(ref)] = policy;
                if (options.checkpoint) current.checkpoints[refKey(ref)] = policy;
            }
            Object.assign(current.jobs.find(job => job.id === jobId), { status: 'complete', finishedAt: Date.now(), usage,
                skipped: skipped.length, skippedReasons: [...new Set(skipped)].slice(0, 3) });
            addUsage(current, usage);
        });
    } catch (error) {
        mutateState(directories, locator, current => {
            const job = current.jobs.find(item => item.id === jobId);
            if (!job || current.branchId !== state.branchId) return;
            Object.assign(job, { status: 'failed', error: error.message, finishedAt: Date.now(), usage });
            addUsage(current, usage);
        }, undefined, { existingOnly: true });
        throw error;
    }
}

export async function processBatch(directories, locator, options = {}, call = callJsonRole) {
    const key = statePath(directories, locator);
    if (running.has(key)) {
        await running.get(key);
        return loadCurrentState(directories, locator);
    }
    const job = runBatch(directories, locator, options, call);
    running.set(key, job);
    try {
        return await job;
    } finally {
        running.delete(key);
    }
}
