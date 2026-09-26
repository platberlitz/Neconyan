import { createHash, randomUUID } from 'node:crypto';
import { getActiveCompanionResults, isEmptyOutputSentinel } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

export const POLICY_VERSION = 'mewmory-2';
export const RECORD_KINDS = ['entity', 'state', 'event', 'relationship', 'knowledge', 'commitment', 'interview', 'overview'];
export const ROLE_NAMES = ['extractor', 'pawspective', 'embedding', 'selector', 'fallback'];
export const SOURCE_TYPES = ['chat', 'character', 'lore', 'memory'];
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const refKey = ref => ref.id + '@' + ref.revision;
export const uniqueRefs = refs => [...new Map(refs.map(ref => [refKey(ref), ref])).values()];

export function fail(message, status = 400) {
    throw Object.assign(new Error(message), { status });
}

export function object(value, label = 'Value') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' is in the wrong format.');
    return value;
}

export function text(value, label, max = 32000, optional = false) {
    if (optional && (value === undefined || value === '')) return '';
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' is empty or too long.');
    return value.trim();
}

/** Folds case, spacing, dash styles and quote or emphasis marks so a copied quote still matches its message. */
function looseText(value) {
    const source = String(value);
    const chars = [];
    const map = [];
    for (let index = 0; index < source.length; index++) {
        for (let char of source[index].normalize('NFKC').toLocaleLowerCase()) {
            if (/\s/u.test(char)) {
                if (chars.length && chars.at(-1) !== ' ') {
                    chars.push(' ');
                    map.push(index);
                }
                continue;
            }
            if (/[*_~`"'\u2018\u2019\u201c\u201d\u00ab\u00bb\u201e]/u.test(char)) continue;
            if (/[\u2010-\u2015\u2212]/u.test(char)) char = '-';
            chars.push(char);
            map.push(index);
        }
    }
    return { text: chars.join(''), map };
}

/** Returns the exact passage of sourceText that quote copies, allowing '...' gaps, or '' when it is not there. */
export function findQuote(sourceText, quote) {
    const source = looseText(sourceText);
    const parts = looseText(quote).text.split('...')
        .map(part => part.replace(/^[\s.,;:!?-]+|[\s.,;:!?-]+$/gu, '')).filter(Boolean);
    if (parts.join('').length < 3) return '';
    let start = -1;
    let end = 0;
    for (const part of parts) {
        const found = source.text.indexOf(part, end);
        if (found < 0) return '';
        if (start < 0) start = found;
        end = found + part.length;
    }
    return String(sourceText).slice(source.map[start], source.map[end - 1] + 1);
}

export function list(value, label, max = 100) {
    if (!Array.isArray(value) || value.length > max) fail(label + ' is not a list, or has too many items.');
    return value;
}

export function id(value, label = 'ID') {
    const result = text(value, label, 160);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(result)) fail(label + ' may only use letters, numbers, and the symbols _ . : -');
    return result;
}

export function strings(value = [], label = 'IDs', max = 32) {
    return [...new Set(list(value, label, max).map(item => id(item, label)))];
}

export function newState(locator) {
    const branchId = randomUUID();
    return {
        format: 1, revision: 0, storyId: branchId, branchId, sourceNamespace: branchId, locator, parent: null,
        enabled: false, activeNpcIds: null, sceneNpcIds: null, castHistory: [],
        sources: {}, timeline: [], inheritedTimeline: [], contextSources: [], records: [], overrides: [],
        coverage: {}, checkpoints: {}, jobs: [], audit: [], recalls: [],
        index: { version: '', vectors: {}, pending: true },
        excludedSources: [], updatedAt: Date.now(),
    };
}

export function sourceAt(state, ref) {
    const source = Object.hasOwn(state.sources, ref?.id) ? state.sources[ref.id] : null;
    return source?.revisions.find(revision => revision.revision === ref.revision);
}

export function sourceEligible(state, ref, asOf = Infinity) {
    const source = state.sources[ref?.id];
    const revision = source && sourceAt(state, ref);
    return Boolean(source?.active && source.current === ref.revision && revision?.enabled
        && !state.excludedSources.includes(ref.id)
        && (source.type !== 'chat' || revision.sequence <= asOf));
}

function recordContent(record) {
    const content = { ...record };
    for (const key of ['version', 'createdAt', 'provenance', 'inputRefs', 'origin', 'authorOverride', 'pinned', 'excluded',
        'status', 'significance', 'evidenceRefs', 'restoredOrigin']) delete content[key];
    return hash(content);
}

/** A development preserves history; a correction invalidates the superseded interpretation. */
export function recordRevision(state, id, version) {
    const current = state.records.find(record => record.id === id);
    if (!current || current.version === version) return current;
    if (current.excluded || ['invalidated', 'deleted'].includes(current.status)) return null;
    const changes = state.audit.filter(entry => entry.recordId === id && entry.afterVersion > version);
    const previous = changes.find(entry => entry.before?.version === version)?.before;
    if (!previous) return null;
    return recordContent(previous) === recordContent(current) || changes.every(entry => entry.historical)
        ? previous : null;
}

export function recordEligible(state, record, { asOf = Infinity, includeExcluded = false } = {}, seen = new Set()) {
    if (!record || record.storyId !== state.storyId || record.branchId !== state.branchId
        || record.asOf > asOf || ['invalidated', 'deleted'].includes(record.status)
        || (!includeExcluded && record.excluded) || seen.has(record.id + '@' + record.version)) return false;
    if (!record.refs.length || ![...record.refs, ...(record.evidenceRefs || [])]
        .every(ref => sourceEligible(state, ref, asOf))) return false;
    // A curator may inspect a whole batch; character knowledge is bounded by the cited evidence.
    if (!(record.inputRefs || []).every(ref => sourceEligible(state, ref))) return false;
    const next = new Set(seen).add(record.id + '@' + record.version);
    if (['knowledge', 'interview', 'overview'].includes(record.kind)) {
        const owners = state.records.filter(owner => owner.kind === 'entity' && owner.entityId === record.ownerId)
            .flatMap(owner => owner.asOf <= asOf ? [owner] : state.audit
                .filter(entry => entry.recordId === owner.id && entry.before?.asOf <= asOf)
                .map(entry => recordRevision(state, owner.id, entry.before.version)));
        const owner = currentRecords(owners.filter(owner => recordEligible(state, owner, { asOf }, next)), owner => owner.entityId)[0];
        if (record.ownerId === 'player' || !owner?.isCharacter) return false;
    }
    return (record.dependencies || []).every(dependency => {
        const parent = recordRevision(state, dependency.id, dependency.version);
        return recordEligible(state, parent, { asOf, includeExcluded }, next);
    });
}

export function eligibleRecords(state, options) {
    return state.records.flatMap(record => {
        if (recordEligible(state, record, options)) return [record];
        if (!Number.isFinite(options?.asOf) || record.asOf <= options.asOf) return [];
        const historical = state.audit.filter(entry => entry.recordId === record.id && entry.before?.asOf <= options.asOf)
            .map(entry => recordRevision(state, record.id, entry.before.version))
            .filter(candidate => recordEligible(state, candidate, options))
            .sort((a, b) => b.asOf - a.asOf || b.version - a.version);
        return historical.slice(0, 1);
    });
}

export function currentRecords(records, key) {
    const current = new Map();
    for (const record of records) {
        const name = key(record);
        const previous = current.get(name);
        if (!previous || record.asOf > previous.asOf || (record.asOf === previous.asOf && record.createdAt >= previous.createdAt)) {
            current.set(name, record);
        }
    }
    return [...current.values()];
}

function appendSource(state, sourceId, type, value) {
    const source = state.sources[sourceId] ??= { id: sourceId, type, current: 0, active: true, revisions: [] };
    const fingerprint = hash(value);
    const previous = source.revisions.at(-1);
    if (previous?.hash !== fingerprint || !source.active) {
        source.current++;
        source.revisions.push({ ...value, revision: source.current, hash: fingerprint });
        state.index.pending = true;
    }
    source.active = true;
    return { id: sourceId, revision: source.current };
}

/** Read completed tracker notes from the accepted alternative, independently of display/history settings. */
function trackerSource(message, previous, trackerAgentIds) {
    const known = new Set([...(previous?.revisions || []).flatMap(revision =>
        (revision.trackerOutputs || []).map(output => output.agentId)), ...trackerAgentIds]);
    const trackerOutputs = Object.entries(getActiveCompanionResults(message))
        .filter(([agentId, result]) => result?.status === 'done' && typeof result.content === 'string'
            && result.content.trim() && !isEmptyOutputSentinel(result.content)
            && (result.agentCategory ? result.agentCategory === 'tracker' : known.has(agentId)))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([agentId, result]) => ({ agentId, name: String(result.agentName || agentId), text: result.content.trim() }));
    if (!trackerOutputs.length) return {};
    const storyText = String(message.mes ?? '');
    return { storyText, trackerOutputs, text: [storyText, ...trackerOutputs.map(output =>
        '[Tracker output: ' + output.name + '; supplementary state, not dialogue]\n' + output.text)].join('\n\n') };
}

/** Reconcile only accepted, persisted messages and their completed trackers. Rejected alternatives never enter. */
export function syncSources(state, messages, context = [], { trackerAgentIds = [] } = {}) {
    const previousTimeline = state.timeline;
    const previousContext = state.contextSources.map(refKey).join(',');
    const occurrences = new Map();
    const inherited = state.inheritedTimeline || [];
    const previousLocal = previousTimeline.slice(inherited.length);
    {
        const previousGroups = new Map();
        for (const ref of previousLocal) {
            if (state.sources[ref.id]?.messageId) continue;
            const identity = state.sources[ref.id]?.identity ?? 'legacy';
            const group = previousGroups.get(identity) || [];
            group.push(ref);
            previousGroups.set(identity, group);
        }
        const currentCounts = new Map();
        for (const message of messages) {
            for (const identity of new Set([message.send_date, ...(message.swipe_info || []).map(swipe => swipe?.send_date)]
                .map(date => String(date ?? 'undated')))) {
                currentCounts.set(identity, (currentCounts.get(identity) || 0) + 1);
            }
        }
        for (const [identity, refs] of previousGroups) {
            if ((refs.length > 1 || ['undated', 'legacy'].includes(identity)) && refs.length > (currentCounts.get(identity) || 0)) {
                // Duplicate/missing dates cannot identify which occurrence was removed. Rebuild the affected group.
                purgeSources(state, refs.map(ref => ref.id));
            }
        }
    }
    const identities = new Map(Object.values(state.sources).filter(source => source.messageId).map(source => [source.messageId, source.id]));
    const assigned = new Set();
    const local = messages.map((message, index) => {
        const sequence = inherited.length + index;
        const identity = String(message.send_date ?? 'position:' + index);
        const occurrence = occurrences.get(identity) || 0;
        occurrences.set(identity, occurrence + 1);
        let sourceId = identities.get(message.mewmory_id);
        if (!sourceId && message.mewmory_id) {
            const dates = new Set([message.send_date, ...(message.swipe_info || []).map(swipe => swipe?.send_date)]
                .map(date => String(date ?? 'undated')));
            // Migrate accepted legacy sources in place so existing corrections keep their references.
            sourceId = previousLocal.find(ref => !assigned.has(ref.id) && !state.sources[ref.id]?.messageId
                && state.sources[ref.id]?.active && dates.has(state.sources[ref.id]?.identity))?.id;
        }
        sourceId ||= 'chat:' + hash([message.mewmory_id || identity, occurrence, ...(inherited.length ? [state.sourceNamespace] : [])]).slice(0, 32);
        if (assigned.has(sourceId)) fail('Some messages in this chat share the same ID, so Mewmory cannot tell them apart. Reload the page and save the chat, then try again.', 409);
        assigned.add(sourceId);
        const attachments = (message.extra?.media || []).map(item => item.title).filter(item => typeof item === 'string');
        const ref = appendSource(state, sourceId, 'chat', {
            text: String(message.mes ?? ''), speaker: String(message.name ?? ''),
            isPlayer: Boolean(message.is_user), sequence,
            // Messages hidden only to fit the context size stay readable, so their memories survive.
            enabled: (!message.is_system || message.extra?.mewmoryKeepHidden === true) && !message.extra?.mewmoryExclude,
            // Selection identity matters even if two swipes happen to contain the same words.
            acceptedAlternative: Number.isInteger(message.swipe_id) ? message.swipe_id : 0,
            attachments, storyTime: null,
            ...trackerSource(message, state.sources[sourceId], trackerAgentIds),
        });
        state.sources[sourceId].identity = String(message.send_date ?? 'undated');
        if (message.mewmory_id) state.sources[sourceId].messageId = message.mewmory_id;
        return ref;
    });
    const timeline = [...inherited, ...local];
    const remaining = new Set(timeline.map(ref => ref.id));
    const deleted = previousTimeline.filter(ref => !remaining.has(ref.id)).map(ref => ref.id);
    if (deleted.length) purgeSources(state, deleted);
    state.timeline = timeline;
    const contextSources = context.map(source => appendSource(state, source.id, source.type, {
        text: source.text, speaker: source.name, sequence: -1, enabled: source.enabled !== false,
        entityId: source.entityId || '', meta: source.meta || {},
    }));
    const activeContext = new Set(contextSources.map(ref => ref.id));
    for (const sourceId of state.contextSources.map(ref => ref.id)) {
        if (!activeContext.has(sourceId) && state.sources[sourceId]) state.sources[sourceId].active = false;
    }
    state.contextSources = contextSources;
    const changedAt = timeline.findIndex((ref, index) => previousTimeline[index] && refKey(ref) !== refKey(previousTimeline[index]));
    if (previousContext !== contextSources.map(refKey).join(',')) {
        state.coverage = {};
        state.checkpoints = {};
    } else if (changedAt >= 0) {
        const changedIds = new Set(timeline.filter((ref, index) => previousTimeline[index]
            && refKey(ref) !== refKey(previousTimeline[index])).map(ref => ref.id));
        const affectedInputs = state.records.filter(record => record.inputRefs?.some(ref => changedIds.has(ref.id)))
            .flatMap(record => record.inputRefs).map(ref => sourceAt(state, ref)?.sequence).filter(sequence => sequence >= 0);
        const restartAt = Math.min(changedAt, ...affectedInputs);
        for (const ref of [...previousTimeline.slice(restartAt), ...timeline.slice(restartAt)]) {
            delete state.coverage[refKey(ref)];
            delete state.checkpoints[refKey(ref)];
        }
    }
    return state;
}

/** Deleting a message purges its copies, dependent prose, undo copies, and search vectors. */
export function purgeSources(state, sourceIds) {
    const removedSources = new Set(sourceIds);
    const removedVersions = new Set();
    const revisions = [...state.records, ...state.audit.map(entry => entry.before).filter(Boolean)];
    let changed = true;
    while (changed) {
        changed = false;
        for (const record of revisions) {
            const key = record.id + '@' + record.version;
            if (removedVersions.has(key)) continue;
            if ([...record.refs, ...(record.inputRefs || []), ...(record.evidenceRefs || [])].some(ref => removedSources.has(ref.id))
                || record.dependencies.some(ref => removedVersions.has(ref.id + '@' + ref.version))) {
                removedVersions.add(key);
                changed = true;
            }
        }
    }
    const removedRecords = new Set(state.records.filter(record => removedVersions.has(record.id + '@' + record.version)).map(record => record.id));
    for (const sourceId of removedSources) {
        const source = state.sources[sourceId];
        if (source) state.sources[sourceId] = { id: sourceId, type: source.type, current: source.current,
            messageId: source.messageId, active: false, revisions: [] };
    }
    state.timeline = state.timeline.filter(ref => !removedSources.has(ref.id));
    state.inheritedTimeline = (state.inheritedTimeline || []).filter(ref => !removedSources.has(ref.id));
    state.contextSources = state.contextSources.filter(ref => !removedSources.has(ref.id));
    state.excludedSources = state.excludedSources.filter(id => !removedSources.has(id));
    state.records = state.records.filter(record => !removedRecords.has(record.id));
    state.audit = state.audit.filter(entry => !removedRecords.has(entry.recordId)
        && (!entry.before || !removedVersions.has(entry.before.id + '@' + entry.before.version)));
    state.overrides = state.overrides.filter(entry => !removedRecords.has(entry.id));
    state.castHistory = (state.castHistory || []).filter(entry => entry.refs.every(ref => !removedSources.has(ref.id)));
    state.sceneNpcIds = null;
    state.recalls = [];
    state.preview = null;
    state.index = { version: '', vectors: {}, pending: true };
    state.coverage = {};
    state.checkpoints = {};
}

export function sourceFingerprint(state) {
    return hash([state.storyId, state.branchId,
        [...state.timeline, ...state.contextSources].map(ref => [ref, sourceAt(state, ref)?.hash]), state.excludedSources]);
}

export function forkState(parent, locator, through, messages) {
    through = Math.max(through, (parent.inheritedTimeline?.length || 0) - 1);
    const state = structuredClone(parent);
    state.branchId = randomUUID();
    state.locator = locator;
    state.parent = { branchId: parent.branchId, locator: parent.locator, through };
    state.revision = 0;
    const projected = eligibleRecords(parent, { asOf: through, includeExcluded: true });
    state.records = [...new Map([...state.records.filter(record => record.asOf <= through), ...projected]
        .map(record => [record.id, record])).values()];
    state.timeline = state.timeline.filter(ref => sourceAt(state, ref)?.sequence <= through);
    const visible = new Set([...state.timeline, ...state.contextSources].map(ref => ref.id));
    state.sources = Object.fromEntries(Object.entries(state.sources).filter(([key]) => visible.has(key)));
    state.records = state.records.map(record => ({ ...record, branchId: state.branchId }));
    copyRecordHistory(state);
    for (const record of [...state.records, ...state.audit.map(entry => entry.before).filter(Boolean)]) {
        // Curator input outside the copied prefix is not evidence for the character's earlier view.
        if (record.inputRefs) record.inputRefs = record.inputRefs.filter(ref => visible.has(ref.id));
    }
    state.recalls = [];
    state.preview = null;
    state.jobs = [];
    state.processing = null;
    state.coverage = {};
    state.checkpoints = {};
    state.activeNpcIds = null;
    state.sceneNpcIds = null;
    state.castHistory = (state.castHistory || []).filter(entry => entry.asOf <= through);
    state.index = { version: '', vectors: {}, pending: true };
    // The child owns its copied history. Later edits and future records in the parent cannot enter.
    syncSources(state, messages, state.contextSources.map(ref => {
        const source = state.sources[ref.id];
        return { id: ref.id, type: source.type, name: sourceAt(state, ref).speaker, ...sourceAt(state, ref) };
    }));
    return state;
}

export function continueState(parent, locator, messages) {
    const state = structuredClone(parent);
    state.locator = locator;
    state.branchId = randomUUID();
    state.sourceNamespace = state.branchId;
    state.parent = { branchId: parent.branchId, locator: parent.locator, through: parent.timeline.length - 1, continuation: true };
    state.inheritedTimeline = structuredClone(parent.timeline);
    state.records = state.records.map(record => ({ ...record, branchId: state.branchId }));
    copyRecordHistory(state);
    state.recalls = [];
    state.preview = null;
    state.jobs = [];
    state.processing = null;
    state.activeNpcIds = null;
    state.revision = 0;
    const context = state.contextSources.map(ref => ({
        id: ref.id, type: state.sources[ref.id].type, name: sourceAt(state, ref).speaker, ...sourceAt(state, ref),
    }));
    return syncSources(state, messages, context);
}

function copyRecordHistory(state) {
    const records = new Map(state.records.map(record => [record.id, record]));
    state.audit = state.audit.filter(entry => records.has(entry.recordId) && entry.afterVersion <= records.get(entry.recordId).version)
        .map(entry => ({ ...entry, before: entry.before ? { ...entry.before, branchId: state.branchId } : null }));
    state.overrides = state.overrides.filter(entry => records.has(entry.id));
}

export function validateRefs(state, refs, { asOf = Infinity, allowedRefs = null } = {}) {
    const result = uniqueRefs(list(refs, 'Source references', 100).map(ref => {
        object(ref, 'Source reference');
        const normalized = { id: id(ref.id), revision: ref.revision };
        if (!Number.isSafeInteger(ref.revision) || ref.revision < 1 || !sourceEligible(state, normalized, asOf)
            || (allowedRefs && !allowedRefs.has(refKey(normalized)))) fail('A message or lore entry this memory is based on was edited, deleted, or switched off, so it can no longer be used. Reload Mewmory and try again.', 409);
        return normalized;
    }));
    if (!result.length) fail('A memory must be based on at least one chat message or lore entry. Tick one under the sources it is based on.');
    return result;
}

export function recordSignature(record) {
    // ponytail: match saved claim content; stable record IDs protect paraphrased retries.
    return hash([record.kind, record.ownerId, record.entityId, [...record.subjectIds].sort(), record.refs.map(refKey).sort(),
        (record.text || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim(), record.interview, record.appearance, record.speech]);
}

function correctionSignatures(state, recordId) {
    return [...state.records.filter(record => record.id === recordId), ...state.audit
        .filter(entry => entry.recordId === recordId && entry.action === 'corrected' && entry.before).map(entry => entry.before)].map(recordSignature);
}

export function validateRecord(state, input, { asOf, origin = 'author', allowedRefs = null, allowedDependencies = null } = {}) {
    object(input, 'Memory');
    if (!RECORD_KINDS.includes(input.kind)) fail('Choose a memory type from the list.');
    const previousRecord = state.records.find(record => record.id === input.id);
    if (previousRecord && previousRecord.kind !== input.kind) fail('An existing memory cannot be switched to a different type. Make a new memory instead.');
    const record = {
        id: id(input.id), kind: input.kind, storyId: state.storyId, branchId: state.branchId,
        version: 1, createdAt: Date.now(), asOf: asOf ?? Math.max(0, state.timeline.length - 1),
        origin, authorOverride: origin === 'author', status: input.status || 'active',
        ownerId: input.ownerId ? id(input.ownerId) : '',
        subjectIds: strings(input.subjectIds),
        text: text(input.text, 'Memory text', 32000, input.kind === 'interview'),
        refs: validateRefs(state, input.refs, { asOf, allowedRefs }),
        dependencies: list(input.dependencies || [], 'Dependencies', 100).map(dependency => {
            const parent = recordRevision(state, dependency.id, dependency.version);
            if (!recordEligible(state, parent, { asOf })
                || (allowedDependencies && !allowedDependencies.has(dependency.id))) fail('A memory this one builds on was changed, rejected, or switched off. Reload Mewmory and try again.', 409);
            return { id: parent.id, version: parent.version };
        }),
        significance: input.significance || 'low',
        evidenceRefs: input.evidenceRefs?.length ? validateRefs(state, input.evidenceRefs, { asOf, allowedRefs }) : [],
        pinned: origin === 'author' && input.pinned === true,
        excluded: origin === 'author' && input.excluded === true,
    };
    record.subjectNames = Object.fromEntries(record.subjectIds.filter(subject => input.subjectNames?.[subject])
        .map(subject => [subject, text(input.subjectNames[subject], 'Subject name', 200)]));
    if (!['active', 'background', 'resolved', 'uncertain', 'invalidated'].includes(record.status)) fail('Choose a status from the list.');
    if (!['low', 'medium', 'high'].includes(record.significance)) fail('Choose low, medium, or high importance.');
    if (record.significance !== 'low' && !record.evidenceRefs.some(ref => state.sources[ref.id]?.type === 'chat')) {
        fail('Medium or high importance needs at least one chat message that shows why it matters. Tick a chat message under the sources it is based on, or set importance to low.');
    }
    if (['interview', 'overview', 'knowledge'].includes(record.kind)) {
        const owner = state.records.find(item => item.kind === 'entity' && item.entityId === record.ownerId
            && item.isCharacter && recordEligible(state, item, { asOf }));
        if (!owner || record.ownerId === 'player') fail('Pawspective and \'what a character knows\' memories must belong to a character played by the AI, not to you.');
        if (!record.subjectIds.length) fail('Choose who or what this memory is about.');
    }
    if (['entity', 'state'].includes(record.kind)) {
        record.entityId = id(input.entityId, 'Entity ID');
    }
    if (record.kind === 'entity') {
        record.name = text(input.name, 'Name', 200);
        record.aliases = list(input.aliases || [], 'Aliases', 20).map(value => text(value, 'Alias', 200));
        record.isCharacter = input.isCharacter === true && record.entityId !== 'player';
        record.appearance = text(input.appearance, 'Appearance', 12000, true);
        record.speech = text(input.speech, 'Speech notes', 12000, true);
    }
    if (['event', 'relationship'].includes(record.kind)) {
        record.evidenceStatus = input.evidenceStatus || 'uncertain';
        if (!['established', 'reported', 'disputed', 'uncertain'].includes(record.evidenceStatus)) fail('Choose how certain this is from the list.');
    }
    if (record.kind === 'knowledge') {
        record.method = input.method;
        if (!['witnessed', 'told', 'read', 'inferred', 'author'].includes(record.method)) fail('Choose how the character found this out: saw it, was told, read it, worked it out, or author note.');
        const quote = text(input.evidenceText, 'Knowledge evidence', 4000);
        record.evidenceText = record.refs.map(ref => findQuote(sourceAt(state, ref).text, quote)).find(Boolean);
        if (!record.evidenceText) {
            fail('The quote showing how the character learned this must be copied word for word from one of the chosen messages or lore entries.');
        }
    }
    if (record.kind === 'commitment') {
        record.triggerTerms = list(input.triggerTerms || [], 'Commitment cues', 12).map(value => text(value, 'Cue', 160));
    }
    if (record.kind === 'interview') {
        record.interview = list(input.interview, 'Interview', 8).map(turn => ({
            question: text(turn.question, 'Question', 2000), answer: text(turn.answer, 'Answer', 8000),
        }));
        if (!record.interview.length) fail('The Pawspective interview has no questions and answers.');
        record.searchDescription = text(input.searchDescription, 'Search description', 1500);
        record.previousId = input.previousId ? id(input.previousId) : '';
        record.changeExplanation = text(input.changeExplanation, 'Change explanation', 4000, true);
        record.isInWorldEvent = false;
        if (record.previousId && !state.records.some(item => item.id === record.previousId && item.kind === 'interview'
            && item.ownerId === record.ownerId && item.subjectIds.some(subject => record.subjectIds.includes(subject))
            && recordEligible(state, item, { asOf }))) fail('The earlier Pawspective interview this one replaces was changed or removed. Reload Mewmory and try again.');
    }
    if (origin !== 'author' && !['interview', 'overview'].includes(record.kind)
        && record.dependencies.some(dependency => ['interview', 'overview'].includes(state.records.find(item => item.id === dependency.id)?.kind))) {
        fail('A fact cannot be based only on a character\'s own opinion from a Pawspective interview. Base it on a chat message or lore entry instead.');
    }
    return record;
}

export function putRecord(state, record, { automatic = false, force = false } = {}) {
    const previous = state.records.find(item => item.id === record.id);
    if (automatic && previous?.asOf > record.asOf && recordEligible(state, previous)) return previous;
    if (automatic && previous?.authorOverride) return previous;
    const signature = recordSignature(record);
    const override = automatic && state.overrides.find(override => (override.signatures || correctionSignatures(state, override.id)).includes(signature));
    if (override) return state.records.find(record => record.id === override.id);
    if (!force && previous && hash({ ...previous, version: 0, createdAt: 0, provenance: null, inputRefs: null })
        === hash({ ...record, version: 0, createdAt: 0, provenance: null, inputRefs: null })) {
        Object.assign(previous, { inputRefs: record.inputRefs, provenance: record.provenance });
        return previous;
    }
    record.version = (previous?.version || 0) + 1;
    state.audit.push({ id: hash([record.id, record.version, Date.now()]), recordId: record.id,
        before: previous ? structuredClone(previous) : null, afterVersion: record.version,
        historical: Boolean(previous && (recordContent(previous) === recordContent(record)
            || (automatic && record.asOf > previous.asOf && record.refs.some(ref => sourceAt(state, ref)?.sequence > previous.asOf)))),
        action: automatic ? 'generated' : 'corrected', at: Date.now() });
    state.records = state.records.filter(item => item.id !== record.id);
    state.records.push(record);
    if (record.authorOverride) {
        const signatures = [...new Set([...(state.overrides.find(override => override.id === record.id)?.signatures || []), ...correctionSignatures(state, record.id)])];
        state.overrides = state.overrides.filter(override => override.id !== record.id);
        state.overrides.push({ id: record.id, signatures });
        state.coverage = {};
        state.checkpoints = {};
    }
    state.index.pending = true;
    state.recalls = [];
    return record;
}

export function undoRecord(state, recordId) {
    const record = state.records.find(item => item.id === recordId);
    const last = state.audit.findLast(item => item.recordId === recordId && item.afterVersion === record?.version);
    const targetVersion = last?.action === 'undo' ? last.restoredFromVersion : record?.version;
    const entry = state.audit.findLast(item => item.recordId === recordId && item.afterVersion === targetVersion && item.action !== 'undo');
    if (!entry) fail('There is no earlier version of this memory to go back to.');
    if (entry.before && !recordEligible(state, entry.before, { includeExcluded: true })) {
        fail('The earlier version cannot be restored because a message it was based on has since been edited, rejected, or left out of memory.', 409);
    }
    if (entry.before) putRecord(state, { ...entry.before, authorOverride: true, origin: 'author', createdAt: Date.now() }, { force: true });
    else putRecord(state, { ...record, status: 'invalidated', authorOverride: true, origin: 'author' }, { force: true });
    state.audit.at(-1).action = 'undo';
    state.audit.at(-1).restoredFromVersion = entry.before?.version ?? 0;
}
