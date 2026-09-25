import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { normaliseRoleplayToolCalls } = await import('../src/generation/roleplay-tool-calls.js');

test('provider tool calls retain explicit IDs and bounded arguments without trusting model approval flags', t => {
    fixture(t);
    const result = { response: { choices: [{ message: { tool_calls: [
        { id: 'call_A', type: 'function', function: { name: 'Pathfinder_Remember',
            arguments: '{"title":"North gate","content":"Closed.","userConfirmed":true}' } },
        { id: 'call_B', type: 'function', function: { name: 'Neconyan_Assistant_ListAgents', arguments: '{}' } },
    ] } }] } };
    assert.deepEqual(normaliseRoleplayToolCalls(result, ['Pathfinder_Remember', 'Neconyan_Assistant_ListAgents']), [
        { id: 'call_A', name: 'Pathfinder_Remember', arguments: { title: 'North gate', content: 'Closed.', userConfirmed: true } },
        { id: 'call_B', name: 'Neconyan_Assistant_ListAgents', arguments: {} },
    ]);
    assert.deepEqual(normaliseRoleplayToolCalls({ response: { content: [
        { type: 'tool_use', id: 'claude_1', name: 'Pathfinder_Search', input: { node_id: 'node_abc' } },
    ] } }, ['Pathfinder_Search']), [{ id: 'claude_1', name: 'Pathfinder_Search', arguments: { node_id: 'node_abc' } }]);
});

test('Gemini calls without IDs use stable response-bound identities and malformed calls refuse', t => {
    fixture(t);
    const response = { candidates: [{ content: { parts: [{ functionCall: { name: 'Pathfinder_Search', args: { book: 'Manual' } } }] } }] };
    const first = normaliseRoleplayToolCalls({ response }, ['Pathfinder_Search']);
    assert.match(first[0].id, /^call_[a-f0-9]{32}$/);
    assert.deepEqual(first, normaliseRoleplayToolCalls({ response: structuredClone(response) }, ['Pathfinder_Search']));
    for (const result of [
        { response: { choices: [{ message: { tool_calls: [{ id: 'unsafe', type: 'function', function: { name: 'Unregistered', arguments: '{}' } }] } }] } },
        { response: { choices: [{ message: { tool_calls: [{ id: 'duplicate', type: 'function', function: { name: 'Pathfinder_Search', arguments: '{}' } },
            { id: 'duplicate', type: 'function', function: { name: 'Pathfinder_Search', arguments: '{}' } }] } }] } },
        { response: { choices: [{ message: { tool_calls: [{ id: 'bad', type: 'function', function: { name: 'Pathfinder_Search', arguments: '{invalid' } }] } }] } },
    ]) assert.throws(() => normaliseRoleplayToolCalls(result, ['Pathfinder_Search']), { code: 'ROLEPLAY_TOOL_INVALID' });
});
