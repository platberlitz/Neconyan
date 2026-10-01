import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureGenerationBinding } = await import('../src/generation/profiles.js');
const { workflowTokenLimit, normalizeRoleplayWorkflowSubmission, normalizeRoleplayGroupSubmission,
    acceptRoleplayNamedWorkflow, acceptRoleplayGroupTurn } = await import('../src/generation/roleplay-acceptance.js');
const { MAX_WORKFLOW_TOKENS } = await import('../src/generation/roleplay-workflow.js');
const { getJob } = await import('../src/jobs/store.js');
const { getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');

const UUID = '00000000-0000-4000-8000-000000000000';
const NOVEL_CONTROLS = {
    model_novel: 'fixture-model', preset_settings_novel: 'gui', temperature: 1, min_length: 1,
    tail_free_sampling: 0.975, repetition_penalty: 2.25, repetition_penalty_range: 2048,
    repetition_penalty_slope: 0.09, repetition_penalty_frequency: 0, repetition_penalty_presence: 0.005,
    top_a: 0.08, top_p: 0.75, top_k: 10, min_p: 0, math1_temp: 1, math1_quad: 0,
    math1_quad_entropy_scale: 0, typical_p: 0.975, banned_tokens: '', logit_bias: [], order: [1, 5, 0, 2, 3, 4],
};

function save(f, settings) {
    fs.writeFileSync(path.join(f.scope.directories.root, 'settings.json'), JSON.stringify(settings));
}

/** Mirror the named workflow fixture: the attachment reference is not part of these cases. */
function prepare(f) {
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    return f;
}

function chatSettings({ revision = 7, oai = {} } = {}) {
    return {
        _settingsRevision: revision,
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1',
            openai_max_context: 4096, ...oai },
    };
}

/** A saved active chat connection whose fingerprint the resolver can still verify. */
function chatFixture(t, { revision = 7, oai = {} } = {}) {
    const f = prepare(fixture(t));
    save(f, chatSettings({ revision, oai }));
    const dirs = f.scope.directories;
    const binding = captureGenerationBinding(dirs, { kind: 'active' }, { settingsRevision: revision });
    return { f, dirs, binding };
}

/** A saved active text connection. Its reply length lives at the settings root. */
function textFixture(t, { revision = 7, amountGen = 222 } = {}) {
    const f = prepare(fixture(t));
    save(f, {
        _settingsRevision: revision,
        max_context: 4096,
        main_api: 'textgenerationwebui',
        active_generation: { api: 'textgenerationwebui', source: 'llamacpp', model: 'fixture', serverUrl: 'http://127.0.0.1:18000' },
        textgenerationwebui_settings: { type: 'llamacpp' },
        power_user: { custom_stopping_strings: '[]' },
        oai_settings: { openai_max_tokens: 999 },
        world_info_settings: { world_info: { globalSelect: [] } },
        ...(amountGen === undefined ? {} : { amount_gen: amountGen }),
    });
    const dirs = f.scope.directories;
    const binding = captureGenerationBinding(dirs, { kind: 'active' }, { settingsRevision: revision });
    return { f, dirs, binding };
}

/** A legacy active backend, with a decoy chat completion field that must never be read. */
function legacyFixture(t, api, { revision = 7, amountGen = 333, configured = true } = {}) {
    const f = prepare(fixture(t));
    const settings = {
        _settingsRevision: revision,
        max_context: 4096,
        main_api: api,
        active_generation: { api },
        oai_settings: { openai_max_tokens: 999, openai_max_context: 256000 },
        world_info_settings: { world_info: { globalSelect: [] } },
        ...(configured ? { amount_gen: amountGen } : {}),
    };
    if (api === 'kobold') settings.kai_settings = { api_server: 'http://127.0.0.1:18000' };
    if (api === 'koboldhorde') {
        settings.kai_settings = { preset_settings: 'gui' };
        settings.horde_settings = { models: ['worker'] };
    }
    if (api === 'novel') {
        settings.nai_settings = { ...NOVEL_CONTROLS };
        fs.writeFileSync(path.join(f.scope.directories.root, 'secrets.json'),
            JSON.stringify({ api_key_novel: [{ id: 'selected', value: 'private-token', active: true }] }));
    }
    save(f, settings);
    const dirs = f.scope.directories;
    const binding = captureGenerationBinding(dirs, { kind: 'active' }, { settingsRevision: revision });
    return { f, dirs, settings, binding };
}

function namedRequest(f) {
    return { user: { profile: { handle: f.scope.owner }, directories: f.scope.directories } };
}

function namedBody(f, { key = 'token-limit', maxTokens } = {}) {
    const messages = f.records.slice(1);
    const anchor = { messageIndex: messages.length - 1, chosen: false };
    return {
        key, name: 'roleplay.reply', intent: {},
        source: { locator: f.locator },
        anchor,
        messageRevision: getRoleplaySourceMessageRevision(messages[anchor.messageIndex]),
        maxTokens,
        account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        acknowledgement: { account: f.scope.owner, settingsRevision: 7 },
    };
}

function groupFixture(t, { revision = 7, oai = {} } = {}) {
    const f = prepare(fixture(t, true));
    save(f, {
        _settingsRevision: revision,
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1',
            openai_max_context: 4096, ...oai },
    });
    return { f, dirs: f.scope.directories };
}

function groupRequest(f) {
    return { user: { profile: { handle: f.scope.owner }, directories: f.scope.directories } };
}

function groupBody(f, { key = 'token-limit-group', maxTokens } = {}) {
    return {
        key, name: 'group.reply',
        source: { locator: { chat: f.locator.chat, group: true, groupId: 'group' } },
        messageCount: f.records.length - 1,
        forcedAvatars: ['Nova.png'],
        generationId: 99,
        maxTokens,
        account: { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch },
        acknowledgement: { account: f.scope.owner, settingsRevision: 7 },
    };
}

test('the accepted ceiling matches the execution guard', () => {
    assert.equal(MAX_WORKFLOW_TOKENS, 64000);
});

test('a caller-stated token limit is returned unchanged without reading the connection', t => {
    // No configured reply length exists here: the short-circuit must not reach the refusal.
    const { dirs, binding } = chatFixture(t);
    assert.equal(workflowTokenLimit(dirs, binding, 2048), 2048);
});

test('a configured 50000 is accepted and stored instead of being hard-rejected', async t => {
    const { f, dirs } = chatFixture(t, { oai: { openai_max_tokens: 50000, openai_max_context: 256000 } });
    const accepted = await acceptRoleplayNamedWorkflow(namedRequest(f), namedBody(f, { key: 'configured-50000' }));
    // min(50000, 64000) = 50000, and 256000 > 50128 passes the fit check.
    assert.equal(accepted.created, true);
    assert.equal(getJob(dirs, accepted.jobId).intent.request.maxTokens, 50000);
});

test('a configured 50000 at context 65536 is kept whole instead of cut to half the window', t => {
    const { dirs, binding } = chatFixture(t, { oai: { openai_max_tokens: 50000, openai_max_context: 65536 } });
    // min(50000, 64000) = 50000: no floor((65536 - 128) / 2) = 32704.
    assert.equal(workflowTokenLimit(dirs, binding, null), 50000);
});

test('a configured 16 is kept whole instead of being raised to a floor', t => {
    const { dirs, binding } = chatFixture(t, { oai: { openai_max_tokens: 16, openai_max_context: 8192 } });
    // No max(64, ...): the caller's own 16 stands; 8192 > 144 passes the fit check.
    assert.equal(workflowTokenLimit(dirs, binding, null), 16);
});

test('a configured length with no context room is refused by the acceptance check instead of being clamped', async t => {
    const { f, dirs, binding } = chatFixture(t, { oai: { openai_max_tokens: 50000, openai_max_context: 400 } });
    // The resolver hands over the configured value as it is; 400 <= 50128 fails the fit check.
    assert.equal(workflowTokenLimit(dirs, binding, null), 50000);
    await assert.rejects(acceptRoleplayNamedWorkflow(namedRequest(f), namedBody(f, { key: 'configured-no-room' })),
        error => error.status === 409 && error.code === 'ROLEPLAY_WORKFLOW_INVALID'
            && error.message === 'The saved workflow model needs a bound context limit.');
});

test('a connection with no reply length refuses with the named 400 instead of inventing a budget', t => {
    const { dirs, binding } = chatFixture(t, { oai: { openai_max_context: 4096 } });
    assert.throws(() => workflowTokenLimit(dirs, binding, null), error =>
        error.status === 400 && error.apiError === 'roleplay_workflow_budget_unset'
        && error.message === 'This chat\'s connection has no reply length set. Set a reply length in the connection settings before using Roleplay workflows.');
});

test('a quoted configured value is read, and unusable values refuse without clamping', t => {
    const quoted = chatFixture(t, { oai: { openai_max_tokens: '2048', openai_max_context: 8192 } });
    assert.equal(workflowTokenLimit(quoted.dirs, quoted.binding, null), 2048);
    // JSON cannot carry NaN; null reaches Number(...) as 0 and a non-numeric string as NaN.
    for (const value of [0, null, 'not a number', 1e16]) {
        const { dirs, binding } = chatFixture(t, { oai: { openai_max_tokens: value, openai_max_context: 256000 } });
        assert.throws(() => workflowTokenLimit(dirs, binding, null),
            error => error.status === 400 && error.apiError === 'roleplay_workflow_budget_unset', String(value));
    }
});

test('the normalisers still refuse a caller-stated limit outside the accepted range', () => {
    const named = maxTokens => ({
        key: 'normaliser', name: 'roleplay.reply', intent: {},
        source: { locator: { chat: 'Source', avatar: 'Nova.png', group: false } },
        anchor: { messageIndex: 0, chosen: false }, messageRevision: 'revision', maxTokens,
        account: { accountId: UUID, dataEpoch: 1 }, acknowledgement: { account: 'fixture', settingsRevision: 7 },
    });
    const group = maxTokens => ({
        key: 'normaliser', name: 'group.reply',
        source: { locator: { chat: 'Source', group: true, groupId: 'group' } },
        messageCount: 0, forcedAvatars: ['Nova.png'], generationId: 0, maxTokens,
        account: { accountId: UUID, dataEpoch: 1 }, acknowledgement: { account: 'fixture', settingsRevision: 7 },
    });
    for (const value of ['2048', 0, NaN, 64001]) {
        assert.throws(() => normalizeRoleplayWorkflowSubmission(named(value)), error => error.status === 400, String(value));
        assert.throws(() => normalizeRoleplayGroupSubmission(group(value)), error => error.status === 400, String(value));
    }
    assert.equal(normalizeRoleplayWorkflowSubmission(named(64000)).maxTokens, 64000);
    assert.equal(normalizeRoleplayWorkflowSubmission(named(null)).maxTokens, null);
});

test('a context with no room keeps the existing 409 and a non-integer context still refuses', t => {
    const cramped = chatFixture(t, { oai: { openai_max_tokens: 512, openai_max_context: 128 } });
    assert.throws(() => workflowTokenLimit(cramped.dirs, cramped.binding, null), error =>
        error.status === 409 && error.apiError === 'roleplay_workflow_context');
    const unknown = chatFixture(t, { oai: { openai_max_tokens: 512, openai_max_context: 'unbounded' } });
    assert.throws(() => workflowTokenLimit(unknown.dirs, unknown.binding, null), error =>
        error.status === 409 && error.apiError === 'roleplay_workflow_context');
});

test('legacy active backends read amount_gen and never the chat completion field', t => {
    for (const [api, backend] of [['kobold', 'kobold'], ['novel', 'novel'], ['koboldhorde', 'horde']]) {
        const configured = legacyFixture(t, api);
        assert.equal(configured.binding.backend, backend);
        assert.equal(workflowTokenLimit(configured.dirs, configured.binding, null), 333, backend);
        const missing = legacyFixture(t, api, { configured: false });
        assert.throws(() => workflowTokenLimit(missing.dirs, missing.binding, null),
            error => error.status === 400 && error.apiError === 'roleplay_workflow_budget_unset', backend);
    }
});

test('a legacy active binding is accepted with its amount_gen reply length', async t => {
    const { f, dirs } = legacyFixture(t, 'kobold');
    const accepted = await acceptRoleplayNamedWorkflow(namedRequest(f), namedBody(f, { key: 'legacy-accepted' }));
    assert.equal(accepted.created, true);
    assert.equal(getJob(dirs, accepted.jobId).intent.request.maxTokens, 333);
});

test('a workflow-routed send stores the effective budget as the payload max_tokens', async t => {
    const named = chatFixture(t, { oai: { openai_max_tokens: 5000, openai_max_context: 8192 } });
    const accepted = await acceptRoleplayNamedWorkflow(namedRequest(named.f), namedBody(named.f, { key: 'named-budget' }));
    // min(5000, 64000) = 5000, the effective budget for the accepted named send; 8192 > 5128 fits.
    assert.equal(getJob(named.dirs, accepted.jobId).intent.request.maxTokens, 5000);

    const group = groupFixture(t, { oai: { openai_max_tokens: 555 } });
    const turn = await acceptRoleplayGroupTurn(groupRequest(group.f), groupBody(group.f, { key: 'group-budget' }));
    assert.equal(getJob(group.dirs, turn.jobId).intent.request.maxTokens, 555);
});

test('a resolved budget logs once at INFO with its value and source label', t => {
    const info = t.mock.method(console, 'info', () => {});
    const chat = chatFixture(t, { oai: { openai_max_tokens: 512 } });
    assert.equal(workflowTokenLimit(chat.dirs, chat.binding, null), 512);
    assert.deepEqual(info.mock.calls[0].arguments, ['Roleplay workflow reply length', { maxTokens: 512, source: 'connection' }]);
    info.mock.resetCalls();
    // A caller-stated value substitutes nothing, so it logs nothing.
    assert.equal(workflowTokenLimit(chat.dirs, chat.binding, 2048), 2048);
    assert.equal(info.mock.calls.length, 0);
    const text = textFixture(t, { amountGen: 222 });
    assert.equal(workflowTokenLimit(text.dirs, text.binding, null), 222);
    assert.deepEqual(info.mock.calls[0].arguments, ['Roleplay workflow reply length', { maxTokens: 222, source: 'text-connection' }]);
    info.mock.resetCalls();
    const legacy = legacyFixture(t, 'kobold');
    assert.equal(workflowTokenLimit(legacy.dirs, legacy.binding, null), 333);
    assert.deepEqual(info.mock.calls[0].arguments, ['Roleplay workflow reply length', { maxTokens: 333, source: 'legacy' }]);
});
