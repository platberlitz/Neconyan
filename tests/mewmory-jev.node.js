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

test('resolveDecisionUrl maps OpenRouter and System One endpoints cleanly', () => {
    assert.equal(resolveDecisionUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(resolveDecisionUrl('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(resolveDecisionUrl('http://127.0.0.1:8000/v1/systemone'), 'http://127.0.0.1:8000/v1/systemone');
    assert.equal(resolveDecisionUrl('https://api.example.com/v1/decisions'), 'https://api.example.com/v1/decisions');
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
    let receivedBody = null;
    const server = http.createServer((req, res) => {
        receivedUrl = req.url;
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
        nextConfig.roles.selector.decisionMode = 'decision';
        nextConfig.roles.selector.decisionThreshold = 0.5;

        const saved = saveConfig(directories, nextConfig);
        assert.equal(saved.extractionFocus, 'every');
        assert.equal(saved.extractionInstructions, 'Record every inventory item.');
        assert.equal(saved.roles.selector.decisionMode, 'decision');
        assert.equal(saved.roles.selector.decisionThreshold, 0.5);

        const loaded = readConfig(directories);
        assert.equal(loaded.extractionFocus, 'every');
        assert.equal(loaded.roles.selector.model, 'typesafe/jev-1.14');
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
        assert.equal(receivedBody.model, 'typesafe/jev-1.14');
        assert.equal(typeof receivedBody.questions?.q_0?.instructions, 'string');
        assert.deepEqual(result.value.selections.map(item => item.recordId), ['rec-a']);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
