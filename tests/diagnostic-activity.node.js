import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscribeJobsChanged } from '../src/jobs/notifications.js';
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

test('diagnostic hints are separate, throttled and retain the trailing end', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
    const changes = [];
    const unsubscribe = subscribeJobsChanged(change => { if (change.owner === 'hint-owner') changes.push(change); });
    t.after(unsubscribe);
    const context = { owner: 'hint-owner', job: { id: 'hint-root', intent: {} } };
    const first = beginDiagnosticAgent(context, { id: 'builtin', sourceTemplateId: 'tpl-proofreader', phase: 'post' });
    t.mock.timers.tick(25);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].diagnosticOnly, true);
    endDiagnosticAgent(first);
    t.mock.timers.tick(999);
    assert.equal(changes.length, 1);
    t.mock.timers.tick(1);
    assert.equal(changes.length, 2);
    assert.equal(getDiagnosticJobActivity('hint-owner', 'hint-root').agents.running.length, 0);
    const regex = beginDiagnosticAgent(context, { id: 'regex', phase: 'regex' }); endDiagnosticAgent(regex);
    t.mock.timers.tick(1000);
    assert.equal(changes.length, 2);
});

test('reviewed built-ins and synthesis do not consume anonymous Agent numbers', () => {
    const context = { owner: 'number-owner', job: { id: 'number-root', intent: {} } };
    const a = beginDiagnosticAgent(context, { id: 'builtin', sourceTemplateId: 'tpl-format-fixer', phase: 'post' });
    const b = beginDiagnosticAgent(context, { id: 'combined', synthesis: true, phase: 'synthesis' });
    const c = beginDiagnosticAgent(context, { id: 'custom-private', phase: 'post' });
    assert.equal(getDiagnosticJobActivity('number-owner', 'number-root').agents.running.at(-1).label, 'Custom agent 1');
    for (const handle of [a, b, c]) endDiagnosticAgent(handle);
});
