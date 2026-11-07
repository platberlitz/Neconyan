/* eslint playwright/expect-expect: off -- Native Node tests use strict assertions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';
import { entryDecisionCandidates, waypointDecisionCandidates } from '../public/scripts/extensions/in-chat-agents/pathfinder/decision-input.js';
const { buildPathfinderDecisions, parsePathfinderDecisions, pathfinderKey, resolvePathfinderModel, requestPathfinderModel } = await import('../src/generation/pathfinder-model.js');

const candidates = [{ id: '["Book A",1] Same name', text: 'A lighthouse' }, { id: '["Book B",1] Same name', text: 'A forest' }];
const messages = [{ role: 'user', content: 'We enter the lighthouse.' }];

test('TypeSafe rejects OpenRouter model names with an actionable error before dispatch', async () => {
    for (const model of ['typesafe/jev-1.14', '~typesafe/jev-latest']) {
        await assert.rejects(requestPathfinderModel({ url: 'https://api.typesafe.ai/v1/systemone', model, protocol: 'decision' },
            { messages, candidates }), error => error.status === 400 && /TypeSafe direct.*jev-latest/.test(error.message));
    }
});

test('decisions preserve book identity, sort scores and accept an inclusive zero threshold', () => {
    const payload = buildPathfinderDecisions(messages, candidates);
    assert.deepEqual(Object.keys(payload.questions), ['q_0', 'q_1']);
    assert.match(payload.state, /lighthouse/);
    const result = parsePathfinderDecisions({ decisions: { q_0: { noul: 0.5 }, q_1: { probabilities: { true: 0.9 } } } }, candidates, 0.5);
    assert.deepEqual(result.selected, [candidates[1].id, candidates[0].id]);
    assert.deepEqual(result.scores.map(item => item.score), [0.5, 0.9]);
    assert.deepEqual(parsePathfinderDecisions([0, 0], candidates, 0).selected, candidates.map(item => item.id));
    assert.deepEqual(parsePathfinderDecisions([0, 0.1], candidates, 0.5).selected, []);
    assert.deepEqual(parsePathfinderDecisions({}, [], 0.5).selected, []);
});

test('missing, non-finite and out-of-range scores fail rather than becoming empty successful retrievals', () => {
    for (const scores of [[1], [1, '0.9'], [1, 2], [1, NaN], [1, -0.1]]) {
        assert.throws(() => parsePathfinderDecisions(scores, candidates, 0.5), /invalid.*score/);
    }
    assert.throws(() => buildPathfinderDecisions(messages, [candidates[0], candidates[0]]), /Invalid.*input/);
    const wrapped = { choices: [{ message: { content: '```json\n{"results":{"q_0":true,"q_1":false}}\n```' } }] };
    assert.deepEqual(parsePathfinderDecisions(wrapped, candidates, 0.5).selected, [candidates[0].id]);
});

test('candidate text respects content truncation and waypoint IDs stay distinct', () => {
    const entries = new Map(candidates.map(item => [item.id, { key: ['keyword'], content: 'abcdefghijk' }]));
    assert.ok(entryDecisionCandidates(entries, { entryContentMode: 'truncated', truncateLength: 3 }, true).every(item => item.text.endsWith('abc')));
    assert.ok(entryDecisionCandidates(entries, {}, false).every(item => !item.text.includes('abcdefghijk')));
    const nodes = waypointDecisionCandidates([['A', { id: 'root', name: 'Root', entries: [], children: [
        { id: 'node_a', name: 'Place', entries: [1] }, { id: 'node_b', name: 'Place', entries: [2] },
    ] }]]);
    assert.deepEqual(nodes.map(item => item.id), ['node_a', 'node_b']);
});

test('manual keys are scoped to agent and endpoint, kept out of settings and removable', t => {
    const { scope: { directories } } = fixture(t);
    const settings = { modelConnection: 'manual', modelEndpoint: 'http://127.0.0.1:8080/v1', modelOverride: 'open-jev-9b' };
    const reference = { agentId: 'agent-a', endpoint: settings.modelEndpoint };
    assert.deepEqual(pathfinderKey(directories, { ...reference, key: 'test-secret' }), { hasKey: true });
    const resolved = resolvePathfinderModel(directories, settings, { agentId: 'agent-a' });
    assert.deepEqual(resolved.cacheScope, [directories.root, 'agent-a']);
    assert.equal(resolved.threshold, 0.1);
    assert.equal(resolved.key, 'test-secret');
    assert.equal(resolved.url, 'http://127.0.0.1:8080/v1/systemone');
    assert.ok(!resolvePathfinderModel(directories, settings, { agentId: 'agent-b' }).key);
    assert.ok(!resolvePathfinderModel(directories, { ...settings, modelEndpoint: 'http://127.0.0.1:8081/v1' }, { agentId: 'agent-a' }).key);
    assert.equal(JSON.stringify(settings).includes('test-secret'), false);
    assert.deepEqual(pathfinderKey(directories, { ...reference, key: '' }), { hasKey: false });
    assert.throws(() => pathfinderKey(directories, { ...reference, endpoint: 'https://user:pass@example.com' }), /credential/i);
});

test('saved chat profiles keep chat behaviour and explicit stage profiles override the default Jev model', t => {
    const { scope: { directories } } = fixture(t);
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ oai_settings: {},
        extension_settings: { connectionManager: { profiles: [{ id: 'chat', api: 'custom', model: 'chat-model', 'api-url': 'http://127.0.0.1:8080/v1' }] } } }));
    assert.equal(resolvePathfinderModel(directories, { connectionProfile: 'chat' }), null);
    assert.equal(resolvePathfinderModel(directories, { modelConnection: 'manual', modelOverride: 'open-jev-9b', decisionMode: 'decision' }, { profileId: 'chat' }), null);
    const resolved = resolvePathfinderModel(directories, { connectionProfile: 'chat', modelOverride: 'open-jev-2b', decisionThreshold: 0 });
    assert.equal(resolved.model, 'open-jev-2b');
    assert.equal(resolved.threshold, 0);
    assert.equal(resolved.url, 'http://127.0.0.1:8080/v1/systemone');
});

test('real HTTP requests use decision payloads, propagate cancellation and never follow redirects', async t => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/other' }); res.end(); return; }
        if (req.url === '/wait') return;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ answers: { q_0: { type: 'noul', noul: 0.9 }, q_1: { type: 'noul', noul: 0.2 } } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const model = { url: url + '/decisions', model: 'typesafe/jev-1.14', protocol: 'decision', key: 'test-only', threshold: 0.5 };
    const result = await requestPathfinderModel(model, { messages, candidates });
    assert.deepEqual(result.selected, [candidates[0].id]);
    assert.equal(requests[0].auth, 'Bearer test-only');
    assert.equal(requests[0].body.model, model.model);
    assert.equal(requests[0].body.messages, undefined);
    assert.equal(requests[0].body.questions.q_0.type, 'noul');
    await assert.rejects(requestPathfinderModel({ ...model, url: url + '/redirect' }, { messages, candidates }), /redirect/i);
    assert.equal(requests.some(item => item.url === '/other'), false);
    await assert.rejects(requestPathfinderModel({ ...model, url: url + '/wait' }, { messages, candidates, signal: AbortSignal.timeout(50) }), /abort/i);
    const count = requests.length;
    assert.deepEqual((await requestPathfinderModel(model, { messages, candidates: [] })).selected, []);
    assert.equal(requests.length, count);
});

test('Pawthfinder caches valid decisions across raw and parsed callers with account and connection isolation', async t => {
    let calls = 0;
    let response = { answers: { q_0: 0.9, q_1: 0.2 } };
    let status = 200;
    const server = http.createServer(async (req, res) => {
        for await (const chunk of req) { void chunk; }
        calls++;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const model = { url: `http://127.0.0.1:${server.address().port}/decisions`, model: 'jev-latest',
        protocol: 'decision', threshold: 0.5, key: 'test-key', cacheScope: ['account-a', 'agent-a'] };
    const call = (overrides = {}, input = {}) => requestPathfinderModel({ ...model, ...overrides }, { messages, candidates, ...input });
    const first = await call({}, { raw: true });
    first.data.answers.q_0 = 0;
    assert.deepEqual((await call()).selected, [candidates[0].id]);
    assert.deepEqual((await call({ threshold: 0.95 })).selected, []);
    assert.equal(calls, 1);
    for (const override of [
        { cacheScope: ['account-b', 'agent-a'] }, { cacheScope: ['account-a', 'agent-b'] },
        { key: 'new-key' }, { model: 'other-jev' }, { url: model.url + '/other' },
    ]) await call(override);
    assert.equal(calls, 6);
    await call({}, { messages: [{ role: 'user', content: 'We enter the forest.' }] });
    await call({}, { candidates: [{ ...candidates[0], text: 'A ruined lighthouse' }, candidates[1]] });
    assert.equal(calls, 8);
    await assert.rejects(call({}, { signal: AbortSignal.abort() }), /abort/i);
    assert.equal(calls, 8);
    response = { answers: { q_0: 0.9 } };
    const malformed = await call({ model: 'malformed' }, { raw: true });
    assert.throws(() => parsePathfinderDecisions(malformed.data, candidates, 0.5), /invalid.*score/i);
    response = { answers: { q_0: 0.9, q_1: 0.2 } };
    await call({ model: 'malformed' });
    await call({ model: 'malformed' });
    assert.equal(calls, 10);
    status = 503;
    await assert.rejects(call({ model: 'failed' }), /503/);
    status = 200;
    await call({ model: 'failed' });
    assert.equal(calls, 12);
    response = { choices: [{ message: { content: 'A chat reply' } }] };
    await call({ protocol: 'chat' });
    await call({ protocol: 'chat' });
    assert.equal(calls, 14, 'ordinary chat generation is never cached');
});
