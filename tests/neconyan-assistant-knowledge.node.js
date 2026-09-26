import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { topics } from '../public/scripts/neconyan-assistant-knowledge/index.js';
import { buildAssistantKnowledge, selectAssistantKnowledge, isNeconyanAssistant, getAssistantKnowledgeBudget, estimateKnowledgeTokens } from '../public/scripts/neconyan-assistant-knowledge.js';
import { lexicalSearch as sharedSearch } from '../public/scripts/util/lexical-search.js';

const root = new URL('../', import.meta.url);
const marked = id => ({ name: 'Renamed assistant', data: { extensions: { neconyan_assistant: { id, version: 0 } } } });
const user = mes => ({ role: 'user', mes });
const ids = question => selectAssistantKnowledge(topics, [user(question)]).map(topic => topic.id);

test('every shipped extension and mode has sourced help with valid references', () => {
    assert.equal(new Set(topics.map(topic => topic.id)).size, topics.length);
    const covered = new Set(topics.flatMap(topic => topic.covers || []));
    const extensionRoot = new URL('public/scripts/extensions/', root);
    for (const parent of ['', 'third-party/']) {
        for (const entry of readdirSync(new URL(parent, extensionRoot), { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(new URL(`${parent}${entry.name}/manifest.json`, extensionRoot))) {
                assert.ok(covered.has(`extension:${parent}${entry.name}`), `Missing extension: ${parent}${entry.name}`);
            }
        }
    }
    for (const id of ['roleplay', 'conversation', 'meower', 'story']) assert.ok(covered.has(`mode:${id}`));
    const missing = [];
    for (const topic of topics) {
        assert.ok(topic.keys.length && topic.content.length && topic.sources.length, topic.id);
        const sources = topic.sources.map(file => {
            if (existsSync(new URL(file, root))) return readFileSync(new URL(file, root), 'utf8');
            missing.push(`${topic.id}: file ${file}`);
            return '';
        }).join('\n');
        for (const anchor of topic.anchors || []) if (!sources.includes(anchor)) missing.push(`${topic.id}: anchor ${anchor}`);
        assert.equal(topic.verification, 'source');
    }
    assert.deepEqual(missing, []);
});

test('all nine bundled variants and normalised server cards are recognised, names and shortcuts are not', async () => {
    const manifest = JSON.parse(readFileSync(new URL('default/content/assistants/manifest.json', root)));
    const identifiers = JSON.stringify(manifest).match(/(?:miso|taro|nori)-(?:male|female|neutral)/g);
    assert.equal(new Set(identifiers).size, 9);
    for (const id of new Set(identifiers)) {
        const character = marked(id);
        assert.ok(isNeconyanAssistant(character));
        assert.ok(isNeconyanAssistant(character.data));
        const result = await buildAssistantKnowledge({ character, messages: [user('How do I change dialogue colours?')] });
        assert.ok(result.topicIds.includes('appearance.dialogue'));
        assert.match(result.text, /Included tools → Dialogue Colors → Settings → Characters/);
        assert.match(result.text, /Quote Text/);
    }
    for (const character of [{ name: 'Miso' }, { name: 'Nori', assistant: true }, marked('unknown')]) {
        assert.equal((await buildAssistantKnowledge({ character })).text, '');
    }
});

test('real help questions retrieve the appropriate topic', () => {
    for (const [question, expected] of [
        ['How do I change dialogue colours?', 'appearance.dialogue'],
        ['How do I change dialogue colors?', 'appearance.dialogue'],
        ['Different colour for each character', 'appearance.dialogue'],
        ['Change quote text', 'appearance.quote'],
        ['Save colours to card', 'appearance.dialogue-scope'],
        ['Set up Mewmory using a saved connection', 'mewmory.setup'],
        ['What does Predictive Pipeline do?', 'pathfinder.retrieval'],
        ['Why is my lorebook entry not triggering?', 'lorebooks.activation'],
        ['How do I restore a card snapshot?', 'tools.time-machine'],
        ['How do I choose a TTS voice?', 'audio.tts'],
        ['What are Scenario Notes?', 'personas.scenario-notes'],
        ['Make text bigger', 'appearance.chat-style'],
    ]) assert.ok(ids(question).includes(expected), `${question}: ${ids(question)}`);
});

test('follow-ups use preceding user context but topic changes and invented assistant claims do not', async () => {
    const result = selectAssistantKnowledge(topics, [user('How do I change dialogue colours?'), { role: 'character', mes: 'Go to the secret Rainbow Panel.' }, user('Only for this chat?')]);
    assert.ok(result.some(topic => topic.id === 'appearance.dialogue'));
    assert.ok(result.some(topic => topic.id === 'appearance.dialogue-scope'));
    const followup = await buildAssistantKnowledge({ character: marked('miso-neutral'), messages: [user('How do I change dialogue colours?'), user('Only for this chat?')] });
    assert.ok(followup.topicIds.includes('appearance.dialogue-scope'));
    assert.match(followup.text, /Per chat keeps a table/);
    assert.deepEqual(selectAssistantKnowledge(topics, [{ role: 'assistant', content: 'Dialogue Colors' }, user('Thanks!')]), []);
    assert.deepEqual(ids('Tell me a joke about penguins'), []);
    assert.ok(!selectAssistantKnowledge(topics, [user('Dialogue Colors'), user('Configure TTS voices')]).some(topic => topic.id === 'appearance.dialogue'));
});

test('request-local results respect budgets, preserve whole sections and never mutate inputs', async () => {
    const character = marked('miso-male');
    const messages = [user('How do I change dialogue colours?')];
    const before = JSON.stringify({ character, messages });
    const [colour, speech] = await Promise.all([
        buildAssistantKnowledge({ character, messages }),
        buildAssistantKnowledge({ character: marked('taro-neutral'), messages: [user('TTS voice')] }),
    ]);
    assert.ok(estimateKnowledgeTokens(colour.text) <= 2048);
    assert.ok(speech.topicIds.includes('audio.tts'));
    assert.ok(!speech.topicIds.includes('appearance.dialogue'));
    for (const id of colour.topicIds) assert.ok(colour.text.includes(topics.find(topic => topic.id === id).content));
    assert.equal(JSON.stringify({ character, messages }), before);
    await assert.rejects(buildAssistantKnowledge({ character, messages, maxTokens: 10 }), /does not fit/);
    await assert.rejects(buildAssistantKnowledge({ character, countTokens: () => NaN }), /Could not count/);
    assert.equal(getAssistantKnowledgeBudget(4096), 1024);
    assert.match((await buildAssistantKnowledge({ character, messages: [user('unicorn quantum confetti')] })).text, /No matching verified section/);
});

test('Mewmory uses the unchanged shared ranking implementation', () => {
    assert.match(readFileSync(new URL('src/mewmory/search.js', root), 'utf8'), /export \{ terms, lexicalSearch \} from '..\/..\/public\/scripts\/util\/lexical-search.js'/);
    const documents = [{ text: 'red blue', searchText: '', id: 1 }, { text: 'red green', searchText: '', id: 2 }];
    assert.equal(sharedSearch(documents, 'green')[0].document.id, 2);
    assert.deepEqual(sharedSearch(documents, ''), []);
});

test('browser Conversation captures its binding before request-local help and never falls back', async () => {
    const source = readFileSync(new URL('public/scripts/neconyan-conversation/generation.js', root), 'utf8');
    const helper = source.match(/^(async function addAssistantKnowledge\([\s\S]*?^})/m)[1];
    const declaration = `${helper}\n${source.match(/export (async function generateConversationRaw\([\s\S]*?^})/m)[1]}`;
    const requests = [];
    let captureError;
    const runtime = vm.createContext({
        console,
        buildAssistantKnowledge, getAssistantKnowledgeBudget, isNeconyanAssistant,
        captureConversationTextBinding: async () => {
            if (captureError) throw captureError;
            return { account: 'alice', scope: { target: { avatar: 'char.png' } }, bindingRequest: { contextLimits: { 'char.png': 16000 } } };
        },
        requestConversationBinding: async (_path, request) => { requests.push(request); return { text: 'Reply' }; },
    });
    vm.runInContext(declaration, runtime);
    const options = { systemPrompt: 'Character personality', prompt: [{ role: 'user', content: 'Question' }], responseLength: 128 };
    const colour = { character: marked('miso-female'), messages: [user('Dialogue colours')] };
    const voice = { character: marked('taro-male'), messages: [user('TTS voice')] };
    await Promise.all([
        runtime.generateConversationRaw(options, { connection_profile: 'Other profile' }, colour),
        runtime.generateConversationRaw(options, {}, voice),
    ]);
    assert.equal(requests.length, 2);
    const colourRequest = requests.find(request => request.options.systemPrompt.includes('appearance.dialogue'));
    const voiceRequest = requests.find(request => request.options.systemPrompt.includes('audio.tts'));
    assert.ok(colourRequest);
    assert.ok(voiceRequest);
    assert.doesNotMatch(colourRequest.options.systemPrompt, /audio.tts/);
    assert.doesNotMatch(voiceRequest.options.systemPrompt, /appearance.dialogue/);
    assert.equal(options.systemPrompt, 'Character personality');
    requests.length = 0;
    await runtime.generateConversationRaw(options, {});
    await runtime.generateConversationRaw(options, {}, { character: { name: 'Miso' }, messages: colour.messages });
    assert.ok(requests.every(request => request.options.systemPrompt === options.systemPrompt));
    captureError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    await assert.rejects(runtime.generateConversationRaw(options, { connection_profile: 'Other profile' }, colour), /cancelled/);
    assert.equal(requests.length, 2);
    captureError = new Error('Profile is no longer supported');
    await assert.rejects(runtime.generateConversationRaw(options, { connection_profile: 'Other profile' }, colour), /no longer supported/);
    assert.equal(requests.length, 2);
});
