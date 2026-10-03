import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { captureGenerationBinding, getChatProfileContextLimit } = await import('../src/generation/profiles.js');
const { acceptRoleplayNamedWorkflow } = await import('../src/generation/roleplay-acceptance.js');
const { ROLEPLAY_WORKFLOW_NAMES } = await import('../src/generation/roleplay-workflow-named.js');
const { getJob } = await import('../src/jobs/store.js');
const { getRoleplaySourceMessageRevision } = await import('../public/scripts/neconyan-conversation/roleplay-source.js');

const SETTINGS_REVISION = 7;
const OMIT = Symbol('omit');
const MISSING_MESSAGE = 'The saved context size is missing or not a usable number. Save a context size in the connection settings before using Roleplay workflows.';
const SMALL_MESSAGE = limit => `The saved context size (${limit}) is too small for a Roleplay workflow.`;

/**
 * The named-workflow fixture with the saved active context under test. The
 * binding is captured the way the browser acknowledges the active connection.
 */
function saved(t, contextValue = 4096) {
    const f = fixture(t);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    const controls = { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', function_calling: true, openai_max_tokens: 2048 };
    if (contextValue !== OMIT) controls.openai_max_context = contextValue;
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        _settingsRevision: SETTINGS_REVISION,
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: controls,
        extension_settings: { connectionManager: { profiles: [{ id: 'active', api: 'custom', model: 'fixture',
            preset: 'Main', 'api-url': 'http://127.0.0.1:18000/v1' }] } },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const binding = () => captureGenerationBinding(dirs, { kind: 'active' }, { settingsRevision: SETTINGS_REVISION });
    const messages = () => fs.readFileSync(f.filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(1);
    const anchorFor = (name, anchor = {}) => {
        const list = messages();
        const kind = ROLEPLAY_WORKFLOW_NAMES[name].anchor;
        const index = anchor.messageIndex ?? (kind === 'end' ? list.length - 1
            : kind === 'block' ? list.findLastIndex(message => message.is_system !== true)
                : list.findLastIndex(message => message.is_user !== true && message.is_system !== true));
        return { messageIndex: index, chosen: anchor.chosen ?? kind === 'chosen' };
    };
    const revision = (name, anchor = {}) => getRoleplaySourceMessageRevision(messages()[anchorFor(name, anchor).messageIndex]);
    const request = () => ({ user: { profile: { handle: f.scope.owner }, directories: dirs } });
    const body = (name, { intent = {}, anchor = anchorFor(name), key = `named-${name}`, messageRevision = revision(name, anchor), ...rest } = {}) =>
        ({ key, name, intent, source: { locator: f.locator }, anchor, messageRevision, account,
            acknowledgement: { account: f.scope.owner, settingsRevision: SETTINGS_REVISION }, ...rest });
    const refuse = key => acceptRoleplayNamedWorkflow(request(), body('roleplay.reply', { key }))
        .then(() => assert.fail('expected the submission to be refused'), error => error);
    return { f, dirs, binding, limit: () => getChatProfileContextLimit(dirs, binding()), request, body, refuse };
}

test('a quoted context size resolves instead of being treated as missing', t => {
    assert.equal(saved(t, '128000').limit(), 128000);
});

test('a quoted fractional context size floors, and unusable values stay absent', t => {
    assert.equal(saved(t, '128000.5').limit(), 128000);
    for (const value of ['abc', 0, -5, null, OMIT]) {
        assert.equal(saved(t, value).limit(), null, `context ${String(value)}`);
    }
});

test('a workflow submission with a quoted context preserves the configured reply length', async t => {
    const s = saved(t, '128000');
    const accepted = await acceptRoleplayNamedWorkflow(s.request(), s.body('roleplay.reply', { key: 'quoted-context' }));
    assert.equal(accepted.created, true);
    const stored = getJob(s.dirs, accepted.jobId).intent.request;
    assert.equal(stored.named.name, 'roleplay.reply');
    assert.equal(stored.binding.kind, 'active');
    assert.equal(stored.avatar, 'Nova.png');
    assert.equal(stored.effect, 'append');
    assert.equal(stored.maxTokens, 2048);
});

test('an unusable context refuses with the context message and its code', async t => {
    for (const value of ['abc', OMIT]) {
        const error = await saved(t, value).refuse('unusable-context');
        assert.equal(error.status, 409);
        assert.equal(error.apiError, 'roleplay_workflow_context');
        assert.equal(error.message, MISSING_MESSAGE);
    }
});

test('a context of 128 or less refuses with the value interpolated', async t => {
    for (const value of [128, 64]) {
        const error = await saved(t, value).refuse('small-context');
        assert.equal(error.status, 409);
        assert.equal(error.apiError, 'roleplay_workflow_context');
        assert.equal(error.message, SMALL_MESSAGE(value));
    }
});

test('neither refusal names room or capacity', async t => {
    const missing = await saved(t, 'abc').refuse('no-room-wording');
    const small = await saved(t, 128).refuse('no-capacity-wording');
    assert.doesNotMatch(missing.message, /room|capacity/i);
    assert.doesNotMatch(small.message, /room|capacity/i);
});
