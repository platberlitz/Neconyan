import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { write: writeCard } = await import('../src/character-card-parser.js');
const { acceptRoleplayGroupTurn } = await import('../src/generation/roleplay-acceptance.js');
const { getJob } = await import('../src/jobs/store.js');

function saved(t, { disabled = [] } = {}) {
    const f = fixture(t, true);
    const dirs = f.scope.directories;
    f.records[1].extra = {};
    f.records.push({ name: 'User', is_user: true, mes: 'Hello, both of you.', extra: {} });
    fs.writeFileSync(f.filename, f.records.map(record => JSON.stringify(record)).join('\n'));
    fs.writeFileSync(path.join(dirs.characters, 'Other.png'), writeCard(png,
        JSON.stringify({ name: 'Other', description: 'Second member', data: { name: 'Other', description: 'Second member' } })));
    fs.writeFileSync(path.join(dirs.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png', 'Other.png'],
        disabled_members: disabled, chats: ['Source', 'New'], activation_strategy: 0, generation_mode: 0 }));
    dirs.openAI_Settings = path.join(dirs.root, 'openai-presets');
    fs.mkdirSync(dirs.openAI_Settings);
    fs.writeFileSync(path.join(dirs.openAI_Settings, 'Main.json'), JSON.stringify({ openai_max_context: 4096 }));
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify({
        _settingsRevision: 7,
        world_info_settings: { world_info: { globalSelect: [] } },
        main_api: 'openai',
        active_generation: { api: 'openai', source: 'custom', model: 'fixture' },
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:18000/v1', openai_max_context: 4096 },
    }));
    const account = { accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch };
    const request = () => ({ user: { profile: { handle: f.scope.owner }, directories: dirs } });
    const body = (rest = {}) => ({ key: 'group-turn', name: 'group.reply',
        source: { locator: { chat: f.locator.chat, group: true, groupId: 'group' } },
        messageCount: f.records.length - 1, forcedAvatars: ['Other.png', 'Nova.png'], generationId: 99, account,
        acknowledgement: { account: f.scope.owner, settingsRevision: 7 }, ...rest });
    return { f, dirs, request, body };
}

test('a whole group turn is accepted once with the speakers the page chose, in order', async t => {
    const s = saved(t);
    const first = await acceptRoleplayGroupTurn(s.request(), s.body());
    assert.equal(first.created, true);
    const job = getJob(s.dirs, first.jobId);
    assert.deepEqual(job.intent.request.group.speakers.map(speaker => speaker.avatar), ['Other.png', 'Nova.png']);
    assert.equal(job.intent.request.group.generationId, 99);
    const second = await acceptRoleplayGroupTurn(s.request(), s.body());
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.created, false);
});

test('a group turn is refused when the chat moved on or a chosen speaker is disabled', async t => {
    const s = saved(t, { disabled: ['Other.png'] });
    await assert.rejects(acceptRoleplayGroupTurn(s.request(), s.body({ key: 'moved', messageCount: 1 })),
        error => error.status === 409 && error.apiError === 'roleplay_workflow_anchor');
    await assert.rejects(acceptRoleplayGroupTurn(s.request(), s.body({ key: 'disabled' })), error => error.status >= 400);
    await assert.rejects(acceptRoleplayGroupTurn(s.request(), s.body({ key: 'empty', forcedAvatars: [] })), error => error.status === 400);
    await assert.rejects(acceptRoleplayGroupTurn(s.request(), s.body({ key: 'stale', acknowledgement: { account: s.f.scope.owner, settingsRevision: 3 } })),
        error => error.status === 409);
});
