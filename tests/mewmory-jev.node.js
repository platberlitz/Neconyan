/* eslint playwright/expect-expect: off -- These checks use node:assert, not Playwright assertions. */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    buildDecisionPayload,
    callJsonRole,
    defaultConfig,
    legacyRoleVersion,
    parseDecisionOutput,
    publicConfig,
    readConfig,
    resolveDecisionUrl,
    roleVersion,
    saveConfig,
} = await import('../src/mewmory/models.js');
const { EXTRACTION_CONTRACT, SELECTION_CONTRACT, extractionContract } = await import('../src/mewmory/contracts.js');
const { processingVersion } = await import('../src/mewmory/processing.js');
const { validateSelection } = await import('../src/mewmory/retrieval.js');
const {
    JEV_DECISION_PRESETS,
    MESSAGE_WINDOW_PRESETS,
    defaultDecisionThreshold,
    detectMessageWindowPreset,
    effectiveDecisionMode,
    findDecisionPreset,
    isDecisionModel,
} = await import('../public/scripts/mewmory/jev-presets.js');

test('Jev and System One presets detect decision models and default thresholds', () => {
    assert.ok(JEV_DECISION_PRESETS.length >= 10);
    assert.equal(findDecisionPreset('typesafe/jev-1.14')?.id, 'jev-1.14');
    assert.equal(findDecisionPreset('jev-1.14')?.model, 'typesafe/jev-1.14');
    assert.equal(findDecisionPreset('ZefanCai/Open-Jev-9B')?.threshold, 0.1);
    assert.equal(defaultDecisionThreshold('ZefanCai/Open-Jev-2B'), 0.1);
    assert.equal(defaultDecisionThreshold('typesafe/jev-1.14'), 0.5);
    assert.equal(isDecisionModel('typesafe/jev-1.14'), true);
    assert.equal(isDecisionModel('perplexity/pplx-decider-v1.2'), true);
    assert.equal(isDecisionModel('cloudflare/clef-flash'), true);
    assert.equal(isDecisionModel('custom-model', 'http://127.0.0.1:8000/v1/systemone'), true);
    assert.equal(isDecisionModel('gpt-4o-mini', 'http://127.0.0.1:8000/v1'), false);
    assert.equal(effectiveDecisionMode({ decisionMode: 'auto', model: 'typesafe/jev-1.14' }), 'decision');
    assert.equal(effectiveDecisionMode({ decisionMode: 'chat', model: 'typesafe/jev-1.14' }), 'chat');
    assert.equal(effectiveDecisionMode({ decisionMode: 'decision', model: 'gpt-4o-mini' }), 'decision');
});

test('message-window presets detect recommended, tight, deep, token and custom windows', () => {
    assert.equal(MESSAGE_WINDOW_PRESETS[0].id, 'jev-recommended');
    assert.equal(detectMessageWindowPreset({
        historyMode: 'messages',
        recentMessages: 10,
        historyBatchMessages: 5,
        batchMessages: 5,
    }), 'jev-recommended');
    assert.equal(detectMessageWindowPreset({
        historyMode: 'messages',
        recentMessages: 6,
        historyBatchMessages: 3,
        batchMessages: 3,
    }), 'jev-tight');
    assert.equal(detectMessageWindowPreset({
        historyMode: 'tokens',
        historyWindow: 30000,
    }), 'token-window');
    assert.equal(detectMessageWindowPreset({
        historyMode: 'messages',
        recentMessages: 14,
        historyBatchMessages: 7,
        batchMessages: 12,
    }), 'custom');
});

test('extractionContract preserves base contract and appends focus and custom instructions', () => {
    assert.equal(extractionContract({ extractionFocus: 'balanced', extractionInstructions: '' }), EXTRACTION_CONTRACT);
    const every = extractionContract({
        extractionFocus: 'every',
        extractionInstructions: 'Always record exact coin counts and promised meetings.',
    });
    assert.ok(every.startsWith(EXTRACTION_CONTRACT));
    assert.match(every, /Extraction focus: EVERY MEMORY\./);
    assert.match(every, /Always record exact coin counts and promised meetings\./);
    const compact = extractionContract({ extractionFocus: 'compact', extractionInstructions: '' });
    assert.match(compact, /Extraction focus: KEY MILESTONES ONLY\./);
});

test('resolveDecisionUrl maps OpenRouter, System One and custom endpoints cleanly', () => {
    assert.equal(resolveDecisionUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(resolveDecisionUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(resolveDecisionUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(resolveDecisionUrl('http://127.0.0.1:8000/v1/systemone'), 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(resolveDecisionUrl('https://api.example.com/v1/decisions'), 'https://api.example.com/v1/decisions');
    assert.equal(resolveDecisionUrl('https://proxy.example.com/custom/jev-decide'), 'https://proxy.example.com/custom/jev-decide');
    assert.equal(resolveDecisionUrl('https://proxy.example.com/v1?route=jev'), 'https://proxy.example.com/v1/systemone?route=jev');
    assert.equal(resolveDecisionUrl('https://proxy.example.com/custom/decide?route=jev'), 'https://proxy.example.com/custom/decide?route=jev');
    assert.equal(resolveDecisionUrl('https://openrouter.ai/api'), 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(resolveDecisionUrl('', { api: 'openrouter' }), 'https://openrouter.ai/api/alpha/decisions');
});

const decisionInput = {
    scene: [{ id: 'chat:2', speaker: 'Mara', text: 'Where is the compass?' }],
    candidates: [
        { recordId: 'rec-a', kind: 'event', excerpt: 'Mara hid the compass.', sourceRefs: ['chat:0'], linkedRecordIds: [] },
        { recordId: 'rec-b', kind: 'state', excerpt: 'The market is closed.', sourceRefs: ['chat:1'], linkedRecordIds: [] },
    ],
};

test('decision answers require a valid probability for every candidate', () => {
    for (const answers of [
        { q_0: { noul: 0.9 } },
        { q_0: { noul: 0.9 }, q_1: { noul: null } },
        { q_0: { noul: 0.9 }, q_1: { probability: -0.1 } },
        { q_0: { noul: 0.9 }, q_1: { score: 2 } },
        { q_0: { noul: 0.9 }, q_1: { answer: true, confidence: 1.1 } },
        [{ noul: 0.9 }],
    ]) {
        assert.throws(() => parseDecisionOutput({ answers }, decisionInput), /Missing or invalid decision score/);
    }
    for (const response of [
        [{ noul: 0.9 }, { noul: 0.1 }],
        { answers: [{ noul: 0.9 }, { noul: 0.1 }] },
        { answers: { q_0: { noul: 0.9 }, q_1: { noul: 0.1 } } },
    ]) {
        const output = parseDecisionOutput(response, decisionInput);
        assert.deepEqual(validateSelection(output, decisionInput.candidates, decisionInput.scene).selections.map(item => item.recordId), ['rec-a']);
    }
});

async function decisionFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-jev-review-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = { calls: [], response: { answers: { q_0: { noul: 0.9 }, q_1: { noul: 0.2 } } } };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            const call = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) };
            state.calls.push(call);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(typeof state.response === 'function' ? state.response(call) : state.response));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const directories = { root };
    const config = defaultConfig();
    Object.assign(config.roles.selector, { enabled: true, endpoint, model: 'typesafe/jev-1.14', decisionMode: 'decision' });
    return { directories, config, endpoint, state };
}

test('decision requests budget their actual payload without a generated reply reserve', async t => {
    const { directories, config, state } = await decisionFixture(t);
    config.roles.selector.contextTokens = 1024;
    assert.equal(config.roles.selector.maxOutputTokens, 32000);
    saveConfig(directories, config);
    const result = await callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput);
    assert.equal(result.usage.decision, true);
    assert.equal(state.calls.length, 1);
    const oversized = structuredClone(decisionInput);
    oversized.candidates[0].excerpt = 'A distinct memory of the compass. '.repeat(2000);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, oversized), /context limit/);
    assert.equal(state.calls.length, 1, 'oversized decision input is rejected before sending');
    const chat = publicConfig(directories);
    chat.roles.selector.decisionMode = 'chat';
    assert.throws(() => saveConfig(directories, chat), /must be lower than Model context/);
    chat.roles.selector.contextTokens = 32001;
    saveConfig(directories, chat);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput), /reserves 32,000/);
    assert.equal(state.calls.length, 1, 'chat requests still reserve reply space');
});

test('incomplete decision output falls back using each connection model and threshold', async t => {
    const { directories, config, endpoint, state } = await decisionFixture(t);
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: { connectionManager: { profiles: [
        { id: 'chat', name: 'Chat', api: 'custom', 'api-url': endpoint, model: 'ordinary-chat-model' },
        { id: 'decision', name: 'Decision', api: 'custom', 'api-url': endpoint, model: 'ZefanCai/Open-Jev-9B' },
    ] } } }));
    state.response = call => call.body.model === 'typesafe/jev-1.14'
        ? { answers: { q_0: { noul: 0.9 } } }
        : call.body.model === 'ordinary-chat-model'
            ? { choices: [{ message: { content: JSON.stringify({ status: 'complete', selections: [], rejections: [], needsEvidence: [] }) } }] }
            : { answers: { q_0: { noul: 0.2 }, q_1: { noul: 0.05 } } };
    config.fallbackProfileIds = ['chat'];
    saveConfig(directories, config);
    const result = await callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput);
    assert.equal(result.usage.fallbackProfileId, 'chat');
    assert.deepEqual(state.calls.map(call => call.url), ['/v1/systemone', '/v1/chat/completions']);
    assert.ok(Array.isArray(state.calls[1].body.messages));
    assert.equal(state.calls[1].body.questions, undefined);

    const next = publicConfig(directories);
    next.fallbackProfileIds = ['decision'];
    saveConfig(directories, next);
    const decision = await callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput);
    assert.equal(decision.usage.fallbackProfileId, 'decision');
    assert.equal(state.calls.at(-1).url, '/v1/systemone');
    assert.deepEqual(decision.value.selections.map(item => item.recordId), ['rec-a'], 'Open-Jev fallback uses its own 0.1 threshold');

    const noFallback = publicConfig(directories);
    noFallback.fallbackProfileIds = [];
    saveConfig(directories, noFallback);
    await assert.rejects(callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput), error => error.status === 502);
});

test('manual decision keys stay with their saved endpoint unless explicitly replaced', async t => {
    const { directories, config, endpoint, state } = await decisionFixture(t);
    config.roles.selector.apiKey = 'old-destination-key';
    saveConfig(directories, config);
    const unchanged = publicConfig(directories);
    unchanged.roles.selector.decisionThreshold = 0.6;
    assert.equal(saveConfig(directories, unchanged).roles.selector.hasKey, true);
    const changed = publicConfig(directories);
    changed.roles.selector.endpoint = endpoint + '/other/decide';
    assert.equal(saveConfig(directories, changed).roles.selector.hasKey, false);
    await callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput);
    assert.equal(state.calls.at(-1).authorization, undefined);
    assert.equal(state.calls.at(-1).url, '/v1/other/decide');
    const replaced = publicConfig(directories);
    replaced.roles.selector.endpoint = endpoint + '/new/decide';
    replaced.roles.selector.apiKey = 'new-destination-key';
    assert.equal(saveConfig(directories, replaced).roles.selector.hasKey, true);
    await callJsonRole(directories, readConfig(directories), 'selector', SELECTION_CONTRACT, decisionInput);
    assert.equal(state.calls.at(-1).authorization, 'Bearer new-destination-key');
});

test('buildDecisionPayload and parseDecisionOutput produce valid SELECTION_CONTRACT selections', () => {
    const candidates = [
        { recordId: 'mem-1', kind: 'event', status: ['active'], significance: ['high'], excerpt: 'Alice gave Bob the brass observatory key.', sourceRefs: ['chat:0'], linkedRecordIds: [] },
        { recordId: 'mem-2', kind: 'state', status: ['active'], significance: ['low'], excerpt: 'The tavern fireplace is lit.', sourceRefs: ['chat:1'], linkedRecordIds: [] },
        { recordId: 'mem-3', kind: 'commitment', status: ['active'], significance: ['medium'], excerpt: 'Bob promised to meet Alice at midnight by the observatory.', sourceRefs: ['chat:2'], linkedRecordIds: [] },
    ];
    const scene = [{ id: 'chat:3', speaker: 'Alice', text: 'Did you bring the key to the observatory?' }];
    const payload = buildDecisionPayload({ scene, candidates });
    assert.match(payload.state, /Alice: Did you bring the key to the observatory\?/);
    assert.equal(Object.keys(payload.questions).length, 3);
    assert.equal(payload.questions.q_0.type, 'noul');

    const parsed = parseDecisionOutput({
        decisions: {
            q_0: { type: 'noul', noul: 0.91 },
            q_1: { type: 'noul', noul: 0.12 },
            q_2: { type: 'noul', noul: 0.74 },
        },
    }, { scene, candidates }, 0.5);
    assert.deepEqual(parsed.selections.map(item => item.recordId), ['mem-1', 'mem-3']);
    assert.equal(parsed.rejections.length, 1);
    assert.equal(parsed.rejections[0].recordId, 'mem-2');

    const validated = validateSelection(parsed, candidates, scene);
    assert.deepEqual(validated.selections.map(item => item.recordId), ['mem-1', 'mem-3']);
});

test('callJsonRole uses the System One decision endpoint for Jev selector roles and preserves extractor hashes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-jev-'));
    const directories = { root };
    let receivedUrl = '';
    let receivedAuth = '';
    let receivedBody = null;
    const server = http.createServer((req, res) => {
        receivedUrl = req.url;
        receivedAuth = req.headers.authorization || '';
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            receivedBody = JSON.parse(raw);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                decisions: {
                    q_0: { type: 'noul', noul: 0.88 },
                    q_1: { type: 'noul', noul: 0.05 },
                },
            }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const baseConfig = defaultConfig();
        const beforeExtractorVersion = roleVersion(baseConfig, 'extractor');
        const beforeProcessingVersion = processingVersion(baseConfig);
        const beforeLegacySelector = legacyRoleVersion(baseConfig, 'selector');

        const nextConfig = structuredClone(baseConfig);
        nextConfig.extractionFocus = 'every';
        nextConfig.extractionInstructions = 'Record every inventory item.';
        nextConfig.roles.selector.enabled = true;
        nextConfig.roles.selector.endpoint = `http://127.0.0.1:${port}/v1`;
        nextConfig.roles.selector.model = 'typesafe/jev-1.14';
        nextConfig.roles.selector.apiKey = 'sk-jev-test-secret';
        nextConfig.roles.selector.decisionMode = 'decision';
        nextConfig.roles.selector.decisionThreshold = 0.5;

        const saved = saveConfig(directories, nextConfig);
        assert.equal(saved.extractionFocus, 'every');
        assert.equal(saved.extractionInstructions, 'Record every inventory item.');
        assert.equal(saved.roles.selector.decisionMode, 'decision');
        assert.equal(saved.roles.selector.decisionThreshold, 0.5);
        assert.equal(saved.roles.selector.hasKey, true);

        const loaded = readConfig(directories);
        assert.equal(loaded.extractionFocus, 'every');
        assert.equal(loaded.roles.selector.model, 'typesafe/jev-1.14');
        assert.equal(publicConfig(directories, loaded).roles.selector.hasKey, true);
        assert.equal(roleVersion(loaded, 'extractor'), beforeExtractorVersion);
        assert.equal(processingVersion(loaded), beforeProcessingVersion);

        const selectorWithSameModel = structuredClone(baseConfig);
        selectorWithSameModel.roles.selector.enabled = true;
        selectorWithSameModel.roles.selector.endpoint = `http://127.0.0.1:${port}/v1`;
        selectorWithSameModel.roles.selector.model = 'typesafe/jev-1.14';
        assert.equal(legacyRoleVersion(loaded, 'selector'), legacyRoleVersion(selectorWithSameModel, 'selector'));
        assert.notEqual(beforeLegacySelector, legacyRoleVersion(loaded, 'selector'));

        const candidates = [
            { recordId: 'rec-a', kind: 'event', status: 'active', significance: 'high', excerpt: 'Mara hid the silver compass under the floorboard.', refs: [] },
            { recordId: 'rec-b', kind: 'state', status: 'active', significance: 'low', excerpt: 'The market stalls are closed for rain.', refs: [] },
        ];
        const result = await callJsonRole(directories, loaded, 'selector', SELECTION_CONTRACT, {
            scene: [{ id: 'chat:1', speaker: 'Mara', text: 'Check under the floorboard for the compass.' }],
            candidates,
        });
        assert.equal(receivedUrl, '/v1/systemone');
        assert.equal(receivedAuth, 'Bearer sk-jev-test-secret');
        assert.equal(receivedBody.model, 'typesafe/jev-1.14');
        assert.equal(typeof receivedBody.questions?.q_0?.instructions, 'string');
        assert.deepEqual(result.value.selections.map(item => item.recordId), ['rec-a']);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
