import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCompanionFeedback } from '../src/generation/companion-feedback.js';
import { previousCompanionNotes } from '../src/generation/companion-context.js';

const agent = { id: 'plot', name: 'Plot Compass', sourceTemplateId: 'tpl-plot-compass-companion',
    execution: 'companion', injection: { position: 0, depth: 4, role: 0, scan: false },
    companion: { feedback: { enabled: true, depth: 1 } } };
const snapshot = { agents: { hiddenIds: [] }, experimentalMacroEngine: false };
const environment = { names: { char: 'Mira' }, evaluate: text => text };
const feedback = records => prepareCompanionFeedback([agent], [], records, snapshot, environment, [], 'normal').extensions;

test('server feedback includes an opening plan until a newer note replaces it', () => {
    const opening = { status: 'done', content: 'Open with a mystery.' };
    const metadata = { chat_metadata: { inChatAgentPlotCompassOpeningNotes: { plot: opening } } };
    assert.match(feedback([metadata, { is_user: true, mes: 'I enter.' }])[0].content, /Open with a mystery/);
    const user = { is_user: true, mes: 'I enter.', extra: { inChatAgentCompanionResults: { plot: { status: 'done', content: 'A door opens.', includeInChatHistory: true } } } };
    const result = feedback([metadata, user]);
    assert.match(result[0].content, /A door opens/);
    assert.doesNotMatch(result[0].content, /Open with a mystery/);
});

test('user-hosted notes resolve the character name without replacing it with the user name', () => {
    const host = { name: 'Traveller', is_user: true, mes: 'I enter.', extra: { inChatAgentCompanionResults: {
        plot: { status: 'done', content: '{{char}} sees {{original}}' },
    } } };
    const macros = { names: { user: 'Traveller', char: 'Mira' }, variables: { local: {}, global: {} } };
    const options = { messages: [host, { name: 'Mira', mes: 'A reply.' }], records: [{ chat_metadata: {} }],
        assistantName: 'Mira', macros, agents: [], generationType: 'normal', snapshot: { experimentalMacroEngine: false } };
    const resolved = previousCompanionNotes(options, { ...agent, companion: { historyDepth: 1 } });
    assert.equal(resolved[0].content, 'Mira sees I enter.');

    const env = { names: { char: 'Mira' }, evaluate: (_text, { original }) => `${env.names.char} sees ${original}` };
    const result = prepareCompanionFeedback([agent], [], [{ chat_metadata: {} }, host], snapshot, env, [], 'normal');
    assert.match(result.extensions[0].content, /Mira sees I enter\./);
    assert.equal(env.names.char, 'Mira');
});

test('an opening note does not borrow the first message as its original text', () => {
    const opening = { status: 'done', content: 'Plan for {{char}}: {{original}}' };
    const options = { messages: [{ name: 'Traveller', is_user: true, mes: 'I enter.' }, { name: 'Mira', mes: 'A reply.' }],
        records: [{ chat_metadata: { inChatAgentPlotCompassOpeningNotes: { plot: opening } } }], assistantName: 'Mira',
        macros: { names: { user: 'Traveller', char: 'Mira' }, variables: { local: {}, global: {} } },
        agents: [], generationType: 'normal', snapshot: { experimentalMacroEngine: false } };
    const resolved = previousCompanionNotes(options, { ...agent, companion: { historyDepth: 1 } });
    assert.equal(resolved[0].content, 'Plan for Mira:');
});
