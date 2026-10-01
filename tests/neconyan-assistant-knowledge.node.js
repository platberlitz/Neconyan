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
        ['I closed the tab while the reply was still generating', 'chat.server-replies'],
        ['Why does the send paw say nya?', 'chat.paw-send'],
        ['What happens when I pet the sleeping cat?', 'chat.sleepers'],
        ['How do I import a persona card?', 'personas.cards'],
        ['How do I set the reasoning effort?', 'generation.reasoning-effort'],
        ['Can the model rotate randomly between models?', 'connections.model-rotation'],
        ['Why did Mewmory hide messages that overflow the context?', 'mewmory.hide-overflow'],
        ['How do Mewmory trackers work?', 'mewmory.trackers'],
        ['Search JanitorAI with BotSearcher', 'tools.botsearcher-janny'],
        ['Where do I find saved Labs work?', 'tools.labs-saved-work'],
        ['How do I use the Clean-Up Data Maid?', 'recovery.clean-up'],
        ['Is my backup still running after I closed the page?', 'recovery.account-jobs'],
        ['Why did the clouds disappear after I picked a background?', 'appearance.background-visibility'],
        ['Can characters react to the current roleplay in Conversation?', 'conversation.roleplay-asides'],
        ['Does Meower keep refreshing after I close it?', 'meower.server-jobs'],
        ['Why are there fewer sleeping cats in the Story Mode manuscript?', 'story.manuscript'],
        ['Where is the Story Mode edit button on my phone?', 'story.manuscript'],
        ['Why are the story swipe arrows hidden on older passages?', 'story.manuscript'],
        ['How do I change Shell Style to Windows Aero?', 'appearance.shell-style'],
        ['Where do I save an accent profile?', 'appearance.accent'],
        ['How do I start the Nori lorebook tour?', 'lorebooks.tour'],
        ['Where is the ICA glossary with Taro?', 'agents.glossary'],
        ['Why were damaged files skipped during my import?', 'recovery.damaged-import'],
        ['What is the Current Model label in the top bar?', 'connections.current-model'],
        ['Can I use DM assistant tools with Miso?', 'conversation.assistants'],
        ['Why do Square and Rounded avatars look the same?', 'appearance.avatar-style'],
        ['What does the Storybook chat style look like?', 'appearance.chat-style'],
        ['The Page Width slider does nothing', 'appearance.page-size'],
        ['Windows 98 header is unreadable with bright text', 'appearance.windows-98'],
        ['Does a Regex Agent Themes change restyle companion note cards?', 'tools.tracker-themes'],
        ['Is there a Pawthfinder tour with Taro?', 'pathfinder.setup'],
        ['How do I open Quick Image Gen?', 'images.quick'],
        ['How do I add sprites in Character Expressions?', 'images.expressions'],
        ['Can the regex editor explain what this pattern does?', 'tools.regex-helpers'],
        ['How do I find a script in Regexes?', 'tools.regex'],
        ['Who leads the Sampling tour?', 'navigation.page-tours'],
        ['Is there a walkthrough for the Persona page?', 'navigation.page-tours'],
    ]) assert.ok(ids(question).includes(expected), `${question}: ${ids(question)}`);
});

test('every best-matching reference section fits the default allowance intact', async () => {
    for (const topic of topics) {
        const messages = [user(topic.title)];
        const best = selectAssistantKnowledge(topics, messages)[0];
        const result = await buildAssistantKnowledge({ character: marked('nori-neutral'), messages });
        assert.ok(result.topicIds.includes(best.id), `${topic.id}: ${best.id} did not fit`);
        assert.ok(result.text.includes(best.content));
        assert.ok(estimateKnowledgeTokens(result.text) <= 2048);
    }
});

test('tracker activation starts with template installation, including the logged Discord queries', async () => {
    const questions = [
        'beau can you tell rid how to activate the relationship tracker?',
        'relationship tracker enable activate',
        'install add relationship tracker agent import template',
        'How do I turn on the relationship tracker?',
        'How do I install a tracker from templates?',
    ];
    for (const question of questions) {
        assert.equal(ids(question)[0], 'agents.install-trackers', `${question}: ${ids(question)}`);
        const result = await buildAssistantKnowledge({ character: marked('nori-neutral'), messages: [user(question)] });
        assert.equal(result.topicIds[0], 'agents.install-trackers', question);
        assert.match(result.text, /Agents → Manage agents → Browse library/);
        assert.match(result.text, /Relationship Tracker/);
        assert.match(result.text, /Add agent/);
        assert.match(result.text, /disabled/);
        assert.match(result.text, /Agents On/);
        assert.match(result.text, /model requests/);
    }
    const messages = [user(questions[0]), { role: 'assistant', content: 'You need Import agents or Reset bundled agents.' },
        user('jeez i meant the steps to installing it you dork')];
    assert.equal(selectAssistantKnowledge(topics, messages)[0]?.id, 'agents.install-trackers');
    assert.equal(ids('How do Mewmory trackers work?')[0], 'mewmory.trackers');
});

test('current feature questions supply complete, actionable references to older assistant copies', async () => {
    const questions = [
        ['How do I install Neconyan on Windows?', 'start.desktop-install', 'Start.bat'],
        ['How do I update my source ZIP installation?', 'start.updates', 'copy your data folder'],
        ['Does the Android APK need Termux?', 'start.android', 'without Termux or a computer'],
        ['Why does the Android app ask me to update WebView?', 'start.android', '124 or newer'],
        ['How do I install through Termux?', 'start.termux', 'Acquire wakelock'],
        ['Can I install this on my iPhone?', 'start.iphone', 'server running on a computer'],
        ['How do I import a SillyBunny persona backup JSON?', 'personas.backup-import', 'no picture bytes'],
        ['Can I import only chats without replacing my settings?', 'recovery.selective-import', 'other preferences, API keys, presets and themes stay unchanged'],
        ['Can I import only lorebooks from a backup ZIP?', 'recovery.selective-import', 'native books from the worlds folder and their saved history'],
        ['How do I batch import JSON lorebooks?', 'lorebooks.batch-import', 'refusing replacement keeps the existing book'],
        ['How do I retry failed companions?', 'agents.companion-runs', 'Successful companions are not rerun'],
        ['What does Run automatic companions do?', 'agents.companion-runs', 'manual companions'],
        ['Can I batch companions together?', 'agents.companion-batch', 'connection, model and context settings match'],
        ['How do I reorder companions?', 'agents.companion-batch', 'Up and Down'],
        ['How do I clean up old companion notes?', 'agents.companion-cleanup', 'Old notes to retain'],
        ['Can I try a Vectorization search without a reply?', 'memory.vector-search', 'one embedding query'],
        ['How do I rebuild my chat index?', 'memory.vector-indexes', 'previous index stays'],
        ['Does Clear file indexes delete my files?', 'memory.vector-indexes', 'not original messages or files'],
        ['How do I hide the cats with Kittyless?', 'appearance.kittyless', 'Show assistants'],
        ['What does the Hide cats switch do?', 'appearance.kittyless', 'Hide cats (Kittyless)'],
        ['Does Windows 98 change my character portraits?', 'appearance.windows-98', 'characters you made or imported are unchanged'],
    ];
    for (const assistant of ['miso-male', 'miso-female', 'miso-neutral', 'taro-male', 'taro-female', 'taro-neutral', 'nori-male', 'nori-female', 'nori-neutral']) {
        for (const [question, expected, fact] of questions) {
            const result = await buildAssistantKnowledge({ character: marked(assistant), messages: [user(question)] });
            assert.ok(result.topicIds.includes(expected), `${assistant}: ${question}: ${result.topicIds}`);
            assert.ok(result.text.includes(topics.find(topic => topic.id === expected).content), `${question}: incomplete reference`);
            assert.ok(result.text.includes(fact), question);
            assert.ok(estimateKnowledgeTokens(result.text) <= 2048);
        }
    }
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

test('browser Conversation adds request-local help after capturing the binding', async () => {
    const source = readFileSync(new URL('public/scripts/neconyan-conversation/generation.js', root), 'utf8');
    const helper = source.match(/^(async function addAssistantKnowledge\([\s\S]*?^})/m)[1];
    const rewrite = source.match(/export async function submitConversationRewrite\([\s\S]*?^}/m)[0];
    assert.ok(rewrite.indexOf('captureConversationTextBinding') < rewrite.indexOf('addAssistantKnowledge'));
    assert.doesNotMatch(source, /generateConversationRaw/);
    const runtime = vm.createContext({ buildAssistantKnowledge, getAssistantKnowledgeBudget, isNeconyanAssistant });
    vm.runInContext(helper, runtime);
    const scope = { target: { avatar: 'char.png' } };
    const bindingRequest = { contextLimits: { 'char.png': 16000 } };
    const base = { systemPrompt: 'Character personality', responseLength: 128 };
    const colour = { character: marked('miso-female'), messages: [user('Dialogue colours')] };
    const voice = { character: marked('taro-male'), messages: [user('TTS voice')] };
    const colourRequest = { ...base };
    const voiceRequest = { ...base };
    await Promise.all([
        runtime.addAssistantKnowledge(colourRequest, scope, bindingRequest, colour),
        runtime.addAssistantKnowledge(voiceRequest, scope, bindingRequest, voice),
    ]);
    assert.match(colourRequest.systemPrompt, /appearance.dialogue/);
    assert.match(voiceRequest.systemPrompt, /audio.tts/);
    assert.doesNotMatch(colourRequest.systemPrompt, /audio.tts/);
    assert.doesNotMatch(voiceRequest.systemPrompt, /appearance.dialogue/);
    assert.equal(base.systemPrompt, 'Character personality');
    const plain = { ...base };
    await runtime.addAssistantKnowledge(plain, scope, bindingRequest, { character: { name: 'Miso' }, messages: colour.messages });
    await runtime.addAssistantKnowledge(plain, scope, bindingRequest, null);
    assert.equal(plain.systemPrompt, base.systemPrompt);
    const partner = { ...base };
    await runtime.addAssistantKnowledge(partner, { ...scope, speakerAvatar: 'partner.png' },
        { contextLimits: { 'char.png': 256, 'partner.png': 16000 } }, colour);
    assert.match(partner.systemPrompt, /appearance.dialogue/);
});
