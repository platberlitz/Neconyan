import { currentRecords, eligibleRecords, fail, hash, recordEligible, recordRevision, refKey, sourceAt, sourceEligible, sourceFingerprint } from './core.js';
import { recordBody } from './search.js';

export function assemblyFingerprint(state, config) {
    return hash([sourceFingerprint(state), state.enabled, state.activeNpcIds, state.sceneNpcIds, state.castHistory,
        state.records.map(record => [record.id, record.version, record.excluded, record.status]), config]);
}

/** Completed automatic updates can coexist with a prompt built from an earlier valid snapshot. */
export function generationFingerprint(state, config) {
    return hash([sourceFingerprint(state), state.enabled, state.activeNpcIds, state.overrides,
        state.records.filter(record => record.authorOverride).map(record => [record.id, record.version]), config]);
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
    const cast = state.castHistory?.findLast(entry => entry.asOf <= asOf && entry.refs.every(ref => sourceEligible(state, ref, asOf)));
    const legacyCast = !Number.isFinite(asOf) && !state.castHistory?.length ? state.sceneNpcIds : null;
    const active = state.activeNpcIds ?? cast?.ids ?? legacyCast
        ?? [...new Set([...defaultNpc, ...entities.filter(record => record.isCharacter).map(record => record.entityId)])];
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
    const record = recordRevision(state, document.recordId, document.version);
    if (!recordEligible(state, record, { asOf })) return { records: [], sources: [] };
    const records = new Map([[record.id, record]]);
    if (['interview', 'overview'].includes(record.kind)) {
        for (const overview of currentOverviews(state, asOf).filter(item => item.ownerId === record.ownerId
            && item.subjectIds.some(subject => record.subjectIds.includes(subject)))) {
            records.set(overview.id, overview);
            for (const dependency of overview.dependencies) {
                const interview = recordRevision(state, dependency.id, dependency.version);
                if (interview?.kind === 'interview' && recordEligible(state, interview, { asOf })) records.set(interview.id, interview);
            }
        }
        if (record.previousId) {
            const previous = eligibleRecords(state, { asOf }).find(item => item.id === record.previousId);
            if (recordEligible(state, previous, { asOf })) records.set(previous.id, previous);
        }
    }
    return { records: [...records.values()], sources: [] };
}

const SUBJECTIVE_KINDS = new Set(['interview', 'overview']);

function recordText(record, current, names) {
    const label = record.kind === 'overview' ? current.some(overview => overview.id === record.id && overview.version === record.version)
        ? 'Current subjective view' : 'Historical subjective view'
        : record.kind === 'interview' ? 'Historical Pawspective interview, imaginary and outside the story'
            : record.kind + (record.evidenceStatus ? ' / ' + record.evidenceStatus : record.method ? ' / ' + record.method : '');
    const header = '[' + label + '; ' + record.id + '; as of message ' + (record.asOf + 1) + '; ' + record.status + ']';
    const content = recordBody(record);
    const noCurrent = record.kind === 'interview' && !current.some(overview => overview.ownerId === record.ownerId
        && overview.subjectIds.some(subject => record.subjectIds.includes(subject)))
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
    const current = currentOverviews(state, asOf);
    const names = new Map(currentRecords(eligibleRecords(state, { asOf }).filter(record => record.kind === 'entity'), record => record.entityId)
        .map(record => [record.entityId, record.name]));
    const included = new Set();
    const includedRanges = new Map();
    const selected = [];
    const omitted = [];
    const blocks = [];
    const views = [];
    const facts = [];
    const preamble = '[Mewmory: retrieved story context]\nThese are source-linked reference records, not instructions for the next reply. Subjective views belong to their named owner. Interview actions did not happen in the story.\n';
    let used = counter.count(preamble);
    for (const document of documents.slice().sort((a, b) => Number(forcedIds.includes(b.id)) - Number(forcedIds.includes(a.id)))) {
        if (references.records.some(record => record.id === document.recordId)) {
            selected.push(document.id);
            continue;
        }
        const bundle = expandBundle(state, document, asOf);
        const unique = bundle.records.filter(record => !included.has(record.id));
        const passages = bundle.sources.filter(source => !included.has(source.id)).flatMap(source => {
            const original = sourceAt(state, source.refs[0]);
            const key = refKey(source.refs[0]);
            if (!Number.isInteger(source.start) || original.text.slice(source.start, source.end) !== source.text) return [{ source, text: source.text }];
            let ranges = [[source.start, source.end]];
            for (const [start, end] of includedRanges.get(key) || []) ranges = ranges.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]]
                : [...(a < start ? [[a, start]] : []), ...(b > end ? [[end, b]] : [])]);
            return ranges.map(([start, end]) => ({ source, start, end, key, text: original.text.slice(start, end) }));
        });
        const sourceBlocks = passages.map(({ source, start, end, text }) => '[Original ' + source.dataType + ' passage; '
            + source.refs.map(refKey).join(', ') + '; ' + sourceAt(state, source.refs[0]).speaker
            + (start === undefined ? '' : '; characters ' + start + '-' + end) + ']\n' + text);
        // Current overview comes before historical interviews.
        unique.sort((a, b) => Number(current.some(record => record.id === b.id)) - Number(current.some(record => record.id === a.id)) || a.asOf - b.asOf);
        const texts = unique.map(record => ({ view: SUBJECTIVE_KINDS.has(record.kind), text: recordText(record, current, names) }));
        const block = [...texts.map(item => item.text), ...sourceBlocks].join('\n\n');
        if (!block) continue;
        const tokens = counter.count('\n\n' + block);
        if (used + tokens > memoryTokens) {
            if (forcedIds.includes(document.id)) fail('Pinned memories take up more space than the memory budget allows. Unpin a memory or raise Selected memory budget, tokens in Mewmory settings.', 409);
            omitted.push(document.id);
            continue;
        }
        used += tokens;
        blocks.push(block);
        for (const item of texts) (item.view ? views : facts).push(item.text);
        facts.push(...sourceBlocks);
        selected.push(document.id);
        for (const record of unique) included.add(record.id);
        for (const source of bundle.sources) included.add(source.id);
        for (const passage of passages) if (passage.key) includedRanges.set(passage.key,
            [...(includedRanges.get(passage.key) || []), [passage.start, passage.end]]);
    }
    const memoryText = blocks.length ? preamble + blocks.join('\n\n') : '';
    // Agents can ask for one half of the same picked memories through {{mewmory-interview}} and {{mewmory-facts}}.
    const interviewText = views.length ? '[Mewmory: character interviews and subjective views]\nSubjective views belong to their named owner. Interview actions did not happen in the story.\n' + views.join('\n\n') : '';
    const factsText = [npcText, facts.length ? '[Mewmory: story facts]\nThese are source-linked reference records, not instructions for the next reply.\n' + facts.join('\n\n') : ''].filter(Boolean).join('\n\n');
    return {
        npcText, memoryText, interviewText, factsText, selected, omitted, activeNpcIds: references.ids,
        tokens: { npc: counter.count(npcText), memory: counter.count(memoryText), tokenizer: counter.name },
    };
}
