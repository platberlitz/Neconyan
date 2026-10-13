import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginDiagnosticAgent, endDiagnosticAgent, getDiagnosticJobActivity, getDiagnosticServerActivity } from '../src/diagnostic-activity.js';

test('server Agent observations merge parallel children without exposing identities', () => {
    const context = id => ({ owner: 'private-account', job: { id, intent: { request: { workflowCandidate: { parentJobId: 'private-root' } } } } });
    const a = beginDiagnosticAgent(context('private-leaf-a'), { id: 'private-agent-a', sourceTemplateId: 'tpl-format-fixer', phase: 'post' });
    const b = beginDiagnosticAgent(context('private-leaf-b'), { id: 'private-agent-b', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
    assert.equal(getDiagnosticJobActivity('private-account', 'private-root').agents.running.length, 2);
    assert.equal(getDiagnosticJobActivity('other-owner', 'private-root'), null);
    assert.doesNotMatch(JSON.stringify(getDiagnosticServerActivity()), /private/);
    endDiagnosticAgent(a, 'error');
    assert.equal(getDiagnosticJobActivity('private-account', 'private-root').agents.running[0].label, 'Proofreader');
    endDiagnosticAgent(b, 'cancel');
    assert.equal(getDiagnosticJobActivity('private-account', 'private-root').agents.running.length, 0);
    assert.equal(getDiagnosticJobActivity('private-account', 'private-root').events.at(-1).type, 'agent-cancel');
});

test('synthesis has a reviewed label and malformed contexts cannot throw', () => {
    assert.equal(beginDiagnosticAgent(null), null);
    assert.doesNotThrow(() => endDiagnosticAgent(null));
    const context = { owner: 'owner', job: { id: 'root', intent: {} } };
    const handle = beginDiagnosticAgent(context, { synthesis: true, phase: 'synthesis' });
    assert.equal(getDiagnosticJobActivity('owner', 'root').agents.running[0].label, 'Combined reply');
    endDiagnosticAgent(handle);
});
