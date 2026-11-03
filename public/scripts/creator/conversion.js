import { buildDossierRequest } from './dossier.js';
import { creatorProposal, creatorTextValue, validCreatorProposalValue } from './model.js';
import { creatorTargetsSignature, creatorTargetValue } from './formats.js';
import { creatorGuidance } from './guidance.js';

export function creatorWritingSteps(draft, fields, alternateCount = Number(creatorTargetValue(draft.writing?.targets, 'greetingCount')) - 1) {
    const steps = [];
    const labels = { name: 'Display name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First greeting', mes_example: 'Interviewer examples', depth_prompt: 'Character’s Note' };
    for (const field of fields) {
        if (field === 'alternate_greetings') {
            for (let start = 0; start < Math.max(1, alternateCount); start += 3) steps.push({ fields: [field], label: `Alternate greetings ${start + 1}–${Math.min(start + 3, Math.max(1, alternateCount))}`, start, count: Math.min(3, Math.max(1, alternateCount) - start) });
        } else steps.push({ fields: [field], label: labels[field] ?? field.replaceAll('_', ' ') });
    }
    return steps;
}

export function startCreatorConversion(draft, fields) {
    const request = buildDossierRequest(draft, fields);
    return { ...startCreatorWriting(draft, request, 'Dossier conversion'), dossierBefore: draft.dossier ?? '' };
}

export function startCreatorWriting(draft, request, label) {
    const before = Object.fromEntries(request.fields.map(field => [field, structuredClone(field === 'alternate_greetings' ? draft.card.data[field] ?? [] : creatorTextValue(draft, field))]));
    return { ...creatorProposal(draft, {}, label), formatBefore: draft.style, targetsBefore: creatorTargetsSignature(draft), questions: [], coverage: [], answers: {}, plan: { before, steps: creatorWritingSteps(draft, request.fields), next: 0, system: request.messages[0].content, source: JSON.parse(request.messages[1].content) } };
}

export function reviseCreatorConversion(draft, proposal) {
    const answered = Object.entries(proposal.answers ?? {}).filter(([, value]) => value.trim());
    if (!answered.length && !proposal.note?.trim()) throw new Error('Answer a question or describe a change first.');
    const next = structuredClone(proposal);
    next.resolved = [...(next.resolved ?? []), ...answered.map(([question, answer]) => ({ question, answer }))];
    next.questions = (next.questions ?? []).filter(question => !answered.some(([key]) => key === question));
    next.answers = {};
    const fields = next.changes.length ? next.changes.map(change => change.field) : [...new Set(next.plan?.steps.flatMap(step => step.fields) ?? [])];
    next.plan = { before: next.plan?.before, source: next.plan?.source, steps: creatorWritingSteps(draft, fields, next.changes.find(change => change.field === 'alternate_greetings')?.after.length), next: 0, system: `Revise the proposed character fields using the author's answers and revision note. Preserve unaffected facts and prose. Answers settle earlier questions; do not ask them again. Return JSON with fields, questions and coverage. Only write requested fields.\n${creatorGuidance(draft)}` };
    if (!next.plan.steps.length) throw new Error('There are no proposed fields left to revise.');
    return next;
}

export function creatorStepMessages(draft, proposal) {
    const step = proposal.plan.steps[proposal.plan.next];
    const existingFields = Object.fromEntries(step.fields.map(field => [field, field === 'alternate_greetings' ? draft.card.data[field] ?? [] : creatorTextValue(draft, field)]));
    return [
        { role: 'system', content: `${proposal.plan.system}\nWrite only this small step: ${step.label}. Other fields are written separately. Return a JSON object with fields, questions and coverage. Leave unsupported fields absent. Do not repeat questions already asked or answered.${step.count ? ` Return at most ${step.count} alternate greetings, starting at alternative ${step.start + 1}.` : ''}` },
        { role: 'user', content: JSON.stringify({ ...proposal.plan.source, requestedFields: step.fields, dossier: proposal.dossierBefore, existingFields, writtenFields: Object.fromEntries(proposal.changes.map(change => [change.field, change.after])), alreadyAsked: proposal.questions, answers: [...(proposal.resolved ?? []), ...Object.entries(proposal.answers ?? {}).map(([question, answer]) => ({ question, answer }))], revisionNote: proposal.note ?? '', step }) },
    ];
}

export function mergeCreatorStep(draft, proposal, output) {
    let result;
    try { result = JSON.parse(String(output).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')); } catch { throw new Error('This step returned incomplete text. Continue writing to retry it; finished steps are saved.'); }
    if (!result?.fields || typeof result.fields !== 'object' || Array.isArray(result.fields)) throw new Error('This step returned no fields. Continue writing to retry it.');
    const next = structuredClone(proposal);
    const step = next.plan.steps[next.plan.next];
    for (const field of step.fields) {
        if (!Object.hasOwn(result.fields, field)) continue;
        const value = result.fields[field];
        if (draft.locks.includes(field) || !validCreatorProposalValue(field, value)) throw new Error('This step returned a locked or invalid field. Finished steps are saved.');
        let change = next.changes.find(change => change.field === field);
        if (!change) {
            change = creatorProposal(draft, { [field]: field === 'alternate_greetings' ? [] : value }, '').changes[0];
            if (Object.hasOwn(next.plan.before ?? {}, field)) change.before = structuredClone(next.plan.before[field]);
            next.changes.push(change);
        }
        if (field === 'alternate_greetings') change.after.splice(step.start, step.count, ...value.slice(0, step.count));
        else change.after = value;
    }
    for (const key of ['questions', 'coverage']) {
        const items = result[key] ?? [];
        if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== 'string' || item.length > 10000)) throw new Error('This step returned invalid questions or coverage. Retry this step.');
        next[key] = [...new Set([...(next[key] ?? []), ...items])].filter(item => key !== 'questions' || !next.resolved?.some(answer => answer.question === item));
    }
    next.plan.next++;
    return next;
}
