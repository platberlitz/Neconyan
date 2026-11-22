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

const pickedNote = {
    status: 'done',
    content: '**Possible developments:**\n1. A storm traps everyone inside.\n2. The host confesses.\n**Next move:** 2. Let the host break first.',
    plotCompassChoice: { number: 1, text: 'A storm traps everyone inside.' },
};

test('server feedback tells the next reply to follow the direction the user picked', () => {
    const host = { is_user: true, mes: 'I wait.', extra: { inChatAgentCompanionResults: { plot: pickedNote } } };
    const content = feedback([{ chat_metadata: {} }, host])[0].content;
    assert.match(content, /\[User's chosen direction\]\n1\. A storm traps everyone inside\.\nThe user picked this direction for the next response\./);

    const unpicked = { ...host, extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, plotCompassChoice: undefined } } } };
    assert.doesNotMatch(feedback([{ chat_metadata: {} }, unpicked])[0].content, /User's chosen direction/);
});

test('a pick on an opening plan reaches the first reply and the next Plot Compass run', () => {
    const records = [{ chat_metadata: { inChatAgentPlotCompassOpeningNotes: { plot: pickedNote } } }];
    assert.match(feedback([...records, { is_user: true, mes: 'I enter.' }])[0].content, /User's chosen direction\]\n1\. A storm/);

    const options = { messages: [{ name: 'Traveller', is_user: true, mes: 'I enter.' }, { name: 'Mira', mes: 'A reply.' }],
        records, assistantName: 'Mira', macros: { names: { user: 'Traveller', char: 'Mira' }, variables: { local: {}, global: {} } },
        agents: [], generationType: 'normal', snapshot: { experimentalMacroEngine: false } };
    const [previous] = previousCompanionNotes(options, { ...agent, companion: { historyDepth: 1 } });
    assert.match(previous.content, /\[User's chosen direction\]\n1\. A storm traps everyone inside\.$/);
});

test('a stale pick is dropped once the note no longer lists it', () => {
    const rewritten = { ...pickedNote, content: pickedNote.content.replace('A storm', 'A flood') };
    const host = { is_user: true, mes: 'I wait.', extra: { inChatAgentCompanionResults: { plot: rewritten } } };
    assert.doesNotMatch(feedback([{ chat_metadata: {} }, host])[0].content, /User's chosen direction/);
});

test('a newer kept note supplies the current pick, not an older opening pick', () => {
    const old = { ...pickedNote, plotCompassChoice: { number: 2, text: 'The host confesses.' } };
    const metadata = { chat_metadata: { inChatAgentPlotCompassOpeningNotes: { plot: old } } };
    const host = { mes: 'A reply.', extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: true } } } };
    const content = feedback([metadata, host])[0].content;
    assert.match(content, /\[User's chosen direction\]\n1\. A storm traps everyone inside\.\nThe user picked this direction for the next response\./);
    assert.doesNotMatch(content, /2\. The host confesses\.\nThe user picked this direction for the next response/);

    const unpickedHost = { ...host, extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: true, plotCompassChoice: undefined } } } };
    const unpicked = feedback([metadata, unpickedHost]).map(entry => entry.content).join('\n');
    assert.doesNotMatch(unpicked, /The user picked this direction for the next response/);
});

test('a current pick reaches the reply even when feedback is disabled', () => {
    const noFeedback = { ...agent, companion: { feedback: { enabled: false, depth: 1 } } };
    for (const retained of [false, true]) {
        const host = { mes: 'A reply.', extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: retained } } } };
        const result = prepareCompanionFeedback([noFeedback], [], [{ chat_metadata: {} }, host], snapshot, environment, [], 'normal');
        assert.match(result.extensions[0].content, /\[User's chosen direction\]\n1\. A storm traps everyone inside\.\nThe user picked this direction for the next response\./);
        assert.doesNotMatch(result.extensions[0].content, /The host confesses/);
    }
});

test('an older feedback note is historical when a newer retained note exists', () => {
    const deepAgent = { ...agent, companion: { feedback: { enabled: true, depth: 2 } } };
    const old = { is_user: true, mes: 'Earlier.', extra: { inChatAgentCompanionResults: { plot: pickedNote } } };
    const newer = { mes: 'Later.', extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: true, plotCompassChoice: undefined } } } };
    const result = prepareCompanionFeedback([deepAgent], [], [{ chat_metadata: {} }, old, newer], snapshot, environment, [], 'normal');
    assert.match(result.extensions[0].content, /\[User's chosen direction at the time\]/);
    assert.doesNotMatch(result.extensions[0].content, /The user picked this direction for the next response/);
});

test('hidden agents and stale picks do not issue a current directive', () => {
    const host = { mes: 'A reply.', extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: true } } } };
    const hidden = { ...snapshot, agents: { hiddenIds: ['plot'] } };
    const result = prepareCompanionFeedback([agent], [], [{ chat_metadata: {} }, host], hidden, environment, [], 'normal');
    assert.equal(result.extensions.length, 0);
    const stale = { ...host, extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, includeInChatHistory: true, plotCompassChoice: { number: 1, text: 'No longer listed.' } } } } };
    assert.equal(feedback([{ chat_metadata: {} }, stale]).length, 0);
});

test('the active swipe and continue boundary determine the current pick', () => {
    const old = { mes: 'Earlier.', extra: { inChatAgentCompanionResults: { plot: pickedNote } } };
    const swipe = { mes: 'Later.', swipe_id: 1, swipe_info: [
        { extra: { inChatAgentCompanionResults: { plot: pickedNote } } },
        { extra: { inChatAgentCompanionResults: { plot: { ...pickedNote, plotCompassChoice: { number: 2, text: 'The host confesses.' } } } } },
    ] };
    const records = [{ chat_metadata: {} }, old, swipe];
    assert.match(feedback(records)[0].content, /\[User's chosen direction\]\n2\. The host confesses/);
    const continued = prepareCompanionFeedback([agent], [], records, snapshot, environment, [], 'continue');
    assert.match(continued.extensions[0].content, /\[User's chosen direction\]\n1\. A storm/);
});
