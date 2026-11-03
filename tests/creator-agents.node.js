import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorDraft, acceptCreatorProposal } from '../public/scripts/creator/model.js';
import { startCreatorAgentProcessing, creatorAgentMessages, finishCreatorAgentStep } from '../public/scripts/creator/agent-processing.js';
import { mergeCreatorStep } from '../public/scripts/creator/conversion.js';

test('ordered agents revise only selected fields and individual greetings with review and stale guards', () => {
    const draft = createCreatorDraft({ id: 'agents', card: { data: { name: 'Mira', description: 'Old description', alternate_greetings: ['First alternative', 'Second alternative'] } } });
    draft.dossier = 'Private dossier';
    const agents = [{ id: 'one', name: 'First agent', prompt: 'Make it concrete.' }, { id: 'two', name: 'Second agent', prompt: '', regexScripts: [{ findRegex: '/concrete/g', replaceString: 'precise' }] }];
    let proposal = startCreatorAgentProcessing(draft, agents, ['description', 'alternate_greetings:1']);
    assert.equal(proposal.plan.steps.length, 4);
    assert.equal(proposal.plan.steps[0].agent.id, 'one');
    assert.equal(proposal.plan.steps[2].agent.id, 'two');
    assert.ok(!JSON.stringify(creatorAgentMessages(proposal)).includes('Private dossier'));
    proposal = mergeCreatorStep(draft, proposal, finishCreatorAgentStep(proposal, 'A concrete description'));
    proposal = mergeCreatorStep(draft, proposal, finishCreatorAgentStep(proposal, 'A concrete greeting'));
    assert.match(creatorAgentMessages(proposal)[1].content, /A concrete description/);
    proposal = mergeCreatorStep(draft, proposal, finishCreatorAgentStep(proposal, 'A concrete description'));
    proposal = mergeCreatorStep(draft, proposal, finishCreatorAgentStep(proposal, 'A concrete greeting'));
    assert.equal(draft.card.data.description, 'Old description');
    assert.equal(proposal.changes.find(change => change.field === 'description').after, 'A precise description');
    assert.deepEqual(proposal.changes.find(change => change.field === 'alternate_greetings').after, ['First alternative', 'A precise greeting']);
    draft.card.data.description = 'Edited while waiting';
    assert.throws(() => acceptCreatorProposal(draft, proposal), /changed/);
    draft.locks.push('description');
    assert.throws(() => startCreatorAgentProcessing(draft, agents, ['description']), /Unlock/);
});
