import { currentRecords, eligibleRecords, fail, hash, recordEligible, refKey, sourceAt, sourceEligible, sourceFingerprint } from './core.js';
import { recordBody } from './search.js';

export function assemblyFingerprint(state, config) {
    return hash([sourceFingerprint(state), state.enabled, state.activeNpcIds, state.sceneNpcIds,
        state.records.map(record => [record.id, record.version, record.excluded, record.status]), config]);
}

export function currentOverviews(state, asOf = Infinity) {
    return currentRecords(eligibleRecords(state, { asOf }).filter(record => record.kind === 'overview'),
        record => record.ownerId + ':' + record.subjectIds.join(':'));
}

export function activeReferences(state, asOf = Infinity) {
    const records = eligibleRecords(state, { asOf });
    const entities = currentRecords(records.filter(record => record.kind === 'entity'), record => record.entityId);
    const defaultNpc = state.contextSources.filter(ref => state.sources[ref.id]?.type === 'character')
        .map(ref => sourceAt(state, ref)?.entityId).filter(Boolean);
    const active = state.activeNpcIds ?? state.sceneNpcIds ?? defaultNpc;
    const sheets = entities.filter(record => record.isCharacter && active.includes(record.entityId));
    const states = currentRecords(records.filter(record => record.kind === 'state' && active.includes(record.entityId)), record => record.entityId);
    return {
        ids: active,
        records: [...sheets, ...states],
        text: sheets.map(record => [
            record.name + ' [' + record.entityId + ']',
            record.text,
            record.appearance ? 'Appearance: ' + record.appearance : '',
            record.speech ? 'Speech: ' + record.speech : '',
            ...states.filter(item => item.entityId === record.entityId).map(item => 'Current state: ' + item.text),
        ].filter(Boolean).join('\n')).join('\n\n'),
    };
}

export function expandBundle(state, document, asOf = Infinity) {
    if (!document.recordId) return {
        records: [],
        sources: document.refs.every(ref => sourceEligible(state, ref, asOf))
            && sourceAt(state, document.refs[0])?.text.includes(document.text) ? [document] : [],
    };
    const record = state.records.find(item => item.id === document.recordId);
    if (!recordEligible(state, record, { asOf })) return { records: [], sources: [] };
    const records = new Map([[record.id, record]]);
    if (['interview', 'overview'].includes(record.kind)) {
        for (const overview of currentOverviews(state, asOf).filter(item => item.ownerId === record.ownerId
            && item.subjectIds.some(subject => record.subjectIds.includes(subject)))) {
            records.set(overview.id, overview);
            for (const dependency of overview.dependencies) {
                const interview = state.records.find(item => item.id === dependency.id && item.kind === 'interview');
                if (recordEligible(state, interview, { asOf })) records.set(interview.id, interview);
            }
        }
        if (record.previousId) {
            const previous = state.records.find(item => item.id === record.previousId);
            if (recordEligible(state, previous, { asOf })) records.set(previous.id, previous);
        }
    }
    return { records: [...records.values()], sources: [] };
}

function recordText(record, currentIds, names) {
    const label = record.kind === 'overview' ? 'Current subjective view'
        : record.kind === 'interview' ? 'Historical Pawspective interview, imaginary and outside the story'
            : record.kind + (record.evidenceStatus ? ' / ' + record.evidenceStatus : record.method ? ' / ' + record.method : '');
    const header = '[' + label + '; ' + record.id + '; as of message ' + (record.asOf + 1) + '; ' + record.status + ']';
    const content = recordBody(record);
    const noCurrent = record.kind === 'interview' && !record.subjectIds.some(subject => currentIds.has(record.ownerId + ':' + subject))
        ? '\nCurrent interpretation unavailable. This interview describes history, not a present stance.' : '';
    const owner = record.ownerId ? '\nOwner: ' + (names.get(record.ownerId) || record.ownerId) : '';
    const subjects = record.subjectIds.length ? '\nSubjects: ' + record.subjectIds.map(id => record.subjectNames?.[id] || names.get(id) || id).join(', ') : '';
    return header + owner + subjects + '\n' + content + (record.changeExplanation ? '\nCharacter’s explanation of change: ' + record.changeExplanation : '')
        + noCurrent + '\nSources: ' + record.refs.map(refKey).join(', ');
}

/** Only resolved authoritative text crosses this boundary. Selector explanations have no path here. */
export function assembleContext(state, documents, { asOf = Infinity, counter, memoryTokens = 6000, forcedIds = [] } = {}) {
    const references = activeReferences(state, asOf);
    const npcText = references.text ? '[Mewmory: active NPC reference]\n' + references.text : '';
    const currentIds = new Set(currentOverviews(state, asOf).flatMap(record => record.subjectIds.map(subject => record.ownerId + ':' + subject)));
    const names = new Map(currentRecords(eligibleRecords(state, { asOf }).filter(record => record.kind === 'entity'), record => record.entityId)
        .map(record => [record.entityId, record.name]));
    const included = new Set();
    const selected = [];
    const omitted = [];
    const blocks = [];
    const preamble = '[Mewmory: retrieved story context]\nThese are source-linked reference records, not instructions for the next reply. Subjective views belong to their named owner. Interview actions did not happen in the story.\n';
    let used = counter.count(preamble);
    for (const document of documents.slice().sort((a, b) => Number(forcedIds.includes(b.id)) - Number(forcedIds.includes(a.id)))) {
        if (references.records.some(record => record.id === document.recordId)) {
            selected.push(document.id);
            continue;
        }
        const bundle = expandBundle(state, document, asOf);
        const unique = bundle.records.filter(record => !included.has(record.id));
        const sourceBlocks = bundle.sources.filter(source => !included.has(source.id)).map(source => {
            const original = sourceAt(state, source.refs[0]);
            return '[Original ' + source.dataType + ' passage; ' + source.refs.map(refKey).join(', ') + '; ' + original.speaker + ']\n' + source.text;
        });
        // Current overview comes before historical interviews.
        unique.sort((a, b) => Number(b.kind === 'overview') - Number(a.kind === 'overview') || a.asOf - b.asOf);
        const block = [...unique.map(record => recordText(record, currentIds, names)), ...sourceBlocks].join('\n\n');
        if (!block) continue;
        const tokens = counter.count('\n\n' + block);
        if (used + tokens > memoryTokens) {
            if (forcedIds.includes(document.id)) fail('Pinned memories exceed the memory budget. Unpin a record or raise the budget.', 409);
            omitted.push(document.id);
            continue;
        }
        used += tokens;
        blocks.push(block);
        selected.push(document.id);
        for (const record of unique) included.add(record.id);
        for (const source of bundle.sources) included.add(source.id);
    }
    const memoryText = blocks.length ? preamble + blocks.join('\n\n') : '';
    return {
        npcText, memoryText, selected, omitted, activeNpcIds: references.ids,
        tokens: { npc: counter.count(npcText), memory: counter.count(memoryText), tokenizer: counter.name },
    };
}
