import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { readArtifact } from '../jobs/artifacts.js';

const fail = () => roleplayError('ROLEPLAY_WORKFLOW_RECOVERY', 'The saved automatic alternatives need recovery.', 409);

/** Replay saved decisions, including continued chunks, without generating another reply. */
export function collectWorkflowAlternatives(context, job, { start, end, effect, speakerIndex, candidateAt }) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= 16) throw fail();
    const alternatives = [];
    let progressive = null;
    for (let turn = start; turn < end; turn++) {
        const candidate = candidateAt(turn);
        const decision = readArtifact(context.directories, job.id, `roleplay-workflow-decision:${turn}`);
        if (candidate.child.intent.request.workflowCandidate?.speakerIndex !== (speakerIndex ?? undefined)) throw fail();
        if (candidate.candidate.kind === 'tool-turn') {
            if (decision !== undefined) throw fail();
            continue;
        }
        if (!decision || decision.hash !== roleplayHash(Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'hash')))
            || decision.parentIntentHash !== roleplayHash(job.intent) || decision.childJobId !== candidate.child.id
            || decision.candidateHash !== candidate.candidate.hash || decision.turn !== turn) throw fail();
        const output = candidate.candidate.output;
        const text = output.message?.mes ?? output.messages?.[0]?.mes ?? output.continuedText ?? output.text;
        if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024) throw fail();
        const combined = progressive === null ? output : combine(progressive, output, effect);
        const selected = combined.message ?? combined.messages?.[0] ?? combined;
        const selectedText = selected.mes ?? selected.continuedText ?? selected.text;
        if (decision.outputHash !== roleplayHash(combined) || decision.decision?.textHash !== roleplayHash(selectedText)) throw fail();
        if (decision.decision.kind === 'continue') progressive = combined;
        else if (decision.decision.kind === 'swipe') {
            alternatives.push({ text: selectedText, continued: output.continuedText !== undefined,
                extra: structuredClone(selected.extra ?? {}),
                childJobId: candidate.child.id, candidateHash: candidate.candidate.hash, decisionHash: decision.hash });
            progressive = null;
        } else throw fail();
    }
    return alternatives;
}

function combine(previous, current, effect) {
    const first = previous.message?.mes ?? previous.messages?.[0]?.mes ?? previous.text;
    const second = current.message?.mes ?? current.messages?.[0]?.mes ?? current.text;
    if (typeof first !== 'string' || typeof second !== 'string' || Buffer.byteLength(first + second) > 256 * 1024) throw fail();
    const result = structuredClone(current);
    if (effect === 'append') result.message.mes = first + second;
    else if (effect === 'replace') result.messages[0].mes = first + second;
    else {
        result.text = first + second;
        if (effect === 'continue' && previous.continuedText !== undefined) result.continuedText = previous.continuedText + second;
    }
    return result;
}

/** Include rejected, paid alternatives only in the single protected final chat write. */
export function addWorkflowAlternatives(records, source, effect, output, originalRecords, alternatives) {
    if (!alternatives.length) return records;
    const index = effect === 'append' ? records.length - 1 : effect === 'replace' ? source.range.start + 1 : source.message.index + 1;
    const message = records[index];
    const selected = output.message ?? output.messages?.[0] ?? output;
    const previous = effect === 'continue' ? originalRecords[index] : null;
    const text = selected.mes ?? selected.continuedText ?? (previous ? previous.mes + selected.text : selected.text);
    if (!message || message.is_user || typeof text !== 'string' || message.mes !== text) throw fail();
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? [...message.swipes] : [message.mes];
    const info = Array.isArray(message.swipe_info) ? structuredClone(message.swipe_info.slice(0, swipes.length)) : [];
    while (info.length < swipes.length) info.push({});
    if (previous) {
        const priorIndex = Number(previous.swipe_id ?? 0);
        if (!Number.isInteger(priorIndex) || priorIndex < 0 || priorIndex >= swipes.length) throw fail();
        swipes[priorIndex] = previous.mes;
        info[priorIndex] = structuredClone(previous.swipe_info?.[priorIndex] ?? { extra: previous.extra ?? {} });
        swipes.push(message.mes);
        info.push({ extra: structuredClone(message.extra ?? {}) });
    }
    const chosen = swipes.pop();
    const chosenInfo = effect === 'append' || effect === 'replace'
        ? { extra: structuredClone(message.extra ?? {}) }
        : info.pop() ?? { extra: structuredClone(message.extra ?? {}) };
    if (effect === 'append' || effect === 'replace') info.pop();
    for (const candidate of alternatives) {
        const alternativeText = previous && !candidate.continued ? previous.mes + candidate.text : candidate.text;
        if (typeof alternativeText !== 'string' || !alternativeText || Buffer.byteLength(alternativeText) > 256 * 1024
            || !candidate.childJobId || !candidate.decisionHash || !candidate.candidateHash) throw fail();
        swipes.push(alternativeText);
        info.push({ extra: structuredClone(candidate.extra) });
    }
    swipes.push(chosen);
    info.push(chosenInfo);
    message.swipes = swipes;
    message.swipe_info = info;
    message.swipe_id = swipes.length - 1;
    return records;
}
