import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, acceptCreatorProposal, acceptCreatorGreeting } from '../public/scripts/creator/model.js';
import { startCreatorConversion, mergeCreatorStep, creatorStepMessages, reviseCreatorConversion } from '../public/scripts/creator/conversion.js';
import { creatorQuestionMessages, mergeCreatorQuestions, generateCreatorProposal } from '../public/scripts/creator/questions.js';

test('a plain-text coverage summary preserves finished interviewer examples for review', () => {
    let draft = createCreatorDraft({ id: 'coverage-string', card: { data: {} } });
    draft.dossier = 'Mira repairs ships.';
    let proposal = startCreatorConversion(draft, ['name', 'mes_example']);
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { name: 'Mira' }, coverage: ['Kept her name.'] }));
    const before = structuredClone(proposal);
    const mes_example = 'Interviewer: What do you want {{user}} to understand?\n\nMira: "I repair ships."';
    const coverage = 'Updated mes_example: an interviewer exchange about her work and the {{user}} dynamic.';
    const finished = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { mes_example }, questions: [], coverage }));
    assert.deepEqual(proposal, before);
    assert.equal(finished.plan.next, finished.plan.steps.length);
    assert.deepEqual(finished.coverage, ['Kept her name.', coverage]);
    assert.deepEqual(finished.questions, []);
    assert.equal(finished.changes.find(change => change.field === 'mes_example').after, mes_example);
    draft.proposals = [finished];
    draft = acceptCreatorProposal(draft, finished);
    assert.equal(draft.card.data.mes_example, mes_example);
    assert.equal(draft.card.data.name, 'Mira');
});

test('coverage strings retain metadata limits and failed steps remain untouched', () => {
    const draft = createCreatorDraft({ id: 'coverage-validation', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    const proposal = startCreatorConversion(draft, ['mes_example']);
    const before = structuredClone(proposal);
    for (const coverage of [{ summary: 'Wrong shape' }, 42, true, ['Valid', 42], Array(101).fill('Summary'), 'x'.repeat(10001), ['x'.repeat(10001)]]) {
        assert.throws(() => mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { mes_example: 'Interview' }, coverage })), /invalid questions or coverage/);
        assert.deepEqual(proposal, before);
    }
    assert.throws(() => mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { mes_example: 'Interview' }, questions: 'Where?', coverage: 'Summary' })), /invalid questions or coverage/);
    for (const coverage of ['Summary', ['Summary'], 'x'.repeat(10000), '', [], null, undefined]) {
        const finished = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { mes_example: 'Interview' }, coverage }));
        assert.equal(finished.plan.next, 1);
        assert.ok(Array.isArray(finished.coverage));
    }
    const messages = creatorStepMessages(draft, proposal);
    assert.match(messages[0].content, /questions and coverage must be arrays of strings/);
});

test('conversion keeps completed fields and resumes exactly the failed step', () => {
    const draft = createCreatorDraft({ id: 'steps', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    let proposal = startCreatorConversion(draft, ['name', 'description']);
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { name: 'Mira', description: 'Ignore premature field' }, questions: ['Where does she work?'] }));
    assert.deepEqual(proposal.changes.map(change => change.field), ['name']);
    assert.equal(proposal.plan.next, 1);
    assert.throws(() => mergeCreatorStep(draft, proposal, 'incomplete'), /finished steps are saved/);
    assert.equal(proposal.plan.next, 1);
    const request = JSON.parse(creatorStepMessages(draft, proposal)[1].content);
    assert.deepEqual(request.requestedFields, ['description']);
    assert.equal(request.writtenFields.name, 'Mira');
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { description: 'A shipwright.' } }));
    proposal.answers = { 'Where does she work?': 'At the northern docks.' };
    const revised = reviseCreatorConversion(draft, proposal);
    assert.equal(revised.plan.next, 0);
    assert.deepEqual(revised.questions, []);
    assert.equal(JSON.parse(creatorStepMessages(draft, revised)[1].content).answers[0].answer, 'At the northern docks.');
    assert.equal(revised.changes[0].before, proposal.changes[0].before);
});

test('accepting every available field retains unfinished writing and rebases later greetings', () => {
    let draft = createCreatorDraft({ id: 'accept-partial', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    draft.writing = { targets: { greetingCount: '3' } };
    let proposal = startCreatorConversion(draft, ['first_mes']);
    proposal = mergeCreatorStep(draft, proposal, '{"fields":{"first_mes":"First"}}');
    draft.proposals = [proposal];
    draft = acceptCreatorProposal(draft, proposal);
    assert.equal(draft.card.data.first_mes, 'First');
    assert.equal(draft.proposals[0].plan.next, 1);
    assert.equal(JSON.parse(creatorStepMessages(draft, draft.proposals[0])[1].content).writtenFields.first_mes, 'First');
    proposal = mergeCreatorStep(draft, draft.proposals[0], '{"fields":{"alternate_greetings":["A"]}}');
    draft.proposals = [proposal];
    draft = acceptCreatorProposal(draft, proposal);
    assert.deepEqual(draft.card.data.alternate_greetings, ['A']);
    proposal = mergeCreatorStep(draft, draft.proposals[0], '{"fields":{"alternate_greetings":["B"]}}');
    assert.deepEqual(proposal.changes[0].before, ['A']);
    assert.deepEqual(proposal.changes[0].after, ['A', 'B']);
    draft.proposals = [proposal];
    draft = acceptCreatorProposal(draft, proposal);
    assert.deepEqual(draft.card.data.alternate_greetings, ['A', 'B']);
    assert.deepEqual(draft.proposals, []);
});

test('individual greetings can be accepted out of order without applying their siblings', () => {
    let draft = createCreatorDraft({ id: 'individual-greetings', card: { data: { alternate_greetings: ['Old'] } } });
    draft.dossier = 'A shipwright.';
    draft.writing = { targets: { greetingCount: '4' } };
    let proposal = startCreatorConversion(draft, ['alternate_greetings']);
    for (const greeting of ['A', 'B', 'C']) proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: [greeting] } }));
    draft.proposals = [proposal];
    draft = acceptCreatorGreeting(draft, proposal, 2);
    assert.deepEqual(draft.card.data.alternate_greetings, ['Old', 'C']);
    assert.deepEqual(draft.proposals[0].changes[0].acceptedGreetings, [2]);
    draft = acceptCreatorGreeting(draft, draft.proposals[0], 0);
    assert.deepEqual(draft.card.data.alternate_greetings, ['A', 'C']);
    draft = acceptCreatorGreeting(draft, draft.proposals[0], 1);
    assert.deepEqual(draft.card.data.alternate_greetings, ['A', 'B', 'C']);
    assert.deepEqual(draft.proposals, []);
});

test('individual greeting acceptance preserves stale-edit and lock checks', () => {
    const draft = createCreatorDraft({ id: 'greeting-guard', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    let proposal = startCreatorConversion(draft, ['alternate_greetings']);
    proposal = mergeCreatorStep(draft, proposal, '{"fields":{"alternate_greetings":["A"]}}');
    draft.proposals = [proposal];
    draft.locks = ['alternate_greetings'];
    assert.throws(() => acceptCreatorGreeting(draft, proposal, 0), /locked/);
    draft.locks = [];
    draft.card.data.alternate_greetings = ['My edit'];
    assert.throws(() => acceptCreatorGreeting(draft, proposal, 0), /field changed/);
});

test('field regeneration requests only that field and optional notes, preserving unfinished work', () => {
    const draft = createCreatorDraft({ id: 'regenerate-field', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    let proposal = startCreatorConversion(draft, ['name', 'description']);
    proposal = mergeCreatorStep(draft, proposal, '{"fields":{"name":"Mira"}}');
    const regenerated = reviseCreatorConversion(draft, proposal, { field: 'name', regenerate: true, note: 'Use a longer name.' });
    assert.deepEqual(regenerated.plan.steps.map(step => step.fields), [['name']]);
    assert.equal(JSON.parse(creatorStepMessages(draft, regenerated)[1].content).revisionNote, 'Use a longer name.');
    assert.equal(JSON.parse(creatorStepMessages(draft, reviseCreatorConversion(draft, proposal, { field: 'name', regenerate: true }))[1].content).revisionNote, '');
    assert.equal(proposal.plan.next, 1);
    assert.equal(proposal.changes[0].after, 'Mira');
    proposal.note = 'Make her stern.';
    const revised = reviseCreatorConversion(draft, proposal);
    assert.deepEqual(revised.plan.steps.map(step => step.fields), [['name'], ['description']]);
});

test('a late step cannot replace an edit made while it was pending', () => {
    const draft = createCreatorDraft({ id: 'edited', card: { data: { description: 'Original' } } });
    draft.dossier = 'A shipwright.';
    const proposal = startCreatorConversion(draft, ['description']);
    draft.card.data.extensions = { private: 'Do not send this' };
    assert.doesNotMatch(JSON.stringify(creatorStepMessages(draft, proposal)), /Do not send this/);
    draft.card.data.description = 'My newer text';
    const finished = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { description: 'Generated' } }));
    assert.equal(finished.changes[0].before, 'Original');
    assert.throws(() => acceptCreatorProposal(draft, finished), /field changed/);
});

test('greetings are written one per request and keep earlier greetings', () => {
    const draft = createCreatorDraft({ id: 'greetings', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    draft.writing = { targets: { greetingCount: '5' } };
    let proposal = startCreatorConversion(draft, ['first_mes']);
    assert.deepEqual(proposal.plan.steps.map(step => step.label), ['First greeting', 'Alternate greeting 1', 'Alternate greeting 2', 'Alternate greeting 3', 'Alternate greeting 4']);
    assert.ok(proposal.plan.steps.slice(1).every(step => step.count === 1));
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { first_mes: 'First' } }));
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: ['A', 'Extra'] } }));
    assert.match(creatorStepMessages(draft, proposal)[0].content, /exactly one new greeting: alternative 2/);
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: ['B'] } }));
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: ['X', 'Y', 'C'] } }));
    proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { alternate_greetings: ['D'] } }));
    assert.deepEqual(proposal.changes[1].after, ['A', 'B', 'C', 'D']);
    assert.equal(proposal.plan.next, 5);
});

test('questions first waits for Generate, carries answers into every step and supports follow-up revision', () => {
    const draft = createCreatorDraft({ id: 'questions', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    draft.writing = { askQuestionsFirst: true };
    let proposal = startCreatorConversion(draft, ['name', 'description']);
    assert.equal(proposal.plan.phase, 'questions');
    assert.deepEqual(JSON.parse(creatorQuestionMessages(proposal)[1].content).requestedFields, ['name', 'description']);
    assert.throws(() => creatorStepMessages(draft, proposal), /Generate/);
    assert.throws(() => generateCreatorProposal(proposal), /questions/);
    proposal = mergeCreatorQuestions(proposal, JSON.stringify({ questions: ['Where does she work?', 'Where does she work?'], fields: { name: 'Ignore premature writing' } }));
    assert.equal(proposal.plan.phase, 'answers');
    assert.equal(proposal.plan.next, 0);
    assert.deepEqual(proposal.changes, []);
    assert.deepEqual(proposal.questions, ['Where does she work?']);
    assert.throws(() => mergeCreatorStep(draft, proposal, '{"fields":{"name":"Too early"}}'), /Generate/);
    proposal = JSON.parse(JSON.stringify(proposal));
    proposal.answers = { 'Where does she work?': 'Northern docks' };
    proposal = generateCreatorProposal(proposal);
    assert.deepEqual(proposal.questions, []);
    assert.deepEqual(proposal.answers, {});
    for (const field of ['name', 'description']) {
        assert.equal(JSON.parse(creatorStepMessages(draft, proposal)[1].content).answers[0].answer, 'Northern docks');
        proposal = mergeCreatorStep(draft, proposal, JSON.stringify({ fields: { [field]: 'Mira' }, questions: ['Where does she work?', 'Who taught her?'] }));
    }
    assert.deepEqual(proposal.questions, ['Who taught her?']);
    proposal.answers = { 'Who taught her?': 'Her aunt' };
    const revised = reviseCreatorConversion(draft, proposal);
    assert.equal(JSON.parse(creatorStepMessages(draft, revised)[1].content).answers[1].answer, 'Her aunt');
});

test('questions first can retry malformed replies and generate without answers', () => {
    const draft = createCreatorDraft({ id: 'retry-questions', card: { data: {} } });
    draft.dossier = 'A shipwright.';
    draft.writing = { askQuestionsFirst: true };
    const pending = startCreatorConversion(draft, ['description']);
    for (const output of ['broken', '{}', '{"questions":[42]}', '{"questions":"Where?"}', JSON.stringify({ questions: ['x'.repeat(10001)] })]) {
        assert.throws(() => mergeCreatorQuestions(pending, output), /questions/i);
        assert.equal(pending.plan.phase, 'questions');
    }
    for (const questions of [[], ['Where does she work?']]) {
        const ready = mergeCreatorQuestions(pending, JSON.stringify({ questions }));
        assert.throws(() => creatorStepMessages(draft, ready), /Generate/);
        const writing = generateCreatorProposal(ready);
        assert.equal(writing.plan.phase, 'writing');
        assert.deepEqual(writing.questions, questions);
        assert.equal(JSON.parse(creatorStepMessages(draft, writing)[1].content).answers.length, 0);
    }
});
