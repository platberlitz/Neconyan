import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { createConversationImageGenerator } = await import('../src/generation/conversation-images.js');
const { buildConversationParticipantSnapshot } = await import('../src/generation/conversation-participants.js');
const { captureConversationTarget, readConversationTarget } = await import('../src/generation/conversation-effects.js');
const { captureChatProfile } = await import('../src/generation/profiles.js');
const { acceptJob, getJob } = await import('../src/jobs/store.js');
const { readArtifact, writeArtifact } = await import('../src/jobs/artifacts.js');
const { resetRoleplayAccount } = await import('../src/roleplay-store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');

async function prepared(t, { group = false } = {}) {
    const f = fixture(t);
    t.after(cancelAutoSaves);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images');
    fs.mkdirSync(directories.userImages, { recursive: true });
    if (group) fs.copyFileSync(path.join(directories.characters, 'Nova.png'), path.join(directories.characters, 'Kit.png'));
    const groupId = group ? 'images-group' : '';
    const thread = group ? 'group:images-group:Nova.png' : 'Nova.png';
    const branch = { id: 'main', name: 'Main', createdAt: 1, updatedAt: 1,
        messages: [{ id: 'message-1', role: 'user', name: 'User', mes: 'Hello.', timestamp: 1 }] };
    const settings = { _version: 0, name1: 'User', power_user: {},
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:5000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:5000/v1' }] },
            'quick-image-gen': { provider: 'together', togetherKey: 'private-key', togetherModel: 'image-fixture', seed: 4,
                style: 'none', appendQuality: false, useSTStyle: false },
            neconyan_conversation: { version: 1, settings: { connection_profile: 'main', image_gen_enabled: true, image_gen_cooldown: 0 },
                groups: group ? [{ id: groupId, personaId: '', members: ['Nova.png', 'Kit.png'], disabled_members: [],
                    conversation_settings: {}, createdAt: 1, updatedAt: 1 }] : [], reminders: [],
                characters: { [thread]: { settings: {}, activeBranchId: 'main', branches: { main: branch } } } } } };
    const filename = path.join(directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify(settings));
    const request = { user: { directories, profile: { handle: f.scope.owner } } };
    const target = captureConversationTarget(request, { avatar: 'Nova.png', groupId, personaId: '', branchId: 'main' });
    const current = readConversationTarget(request, target);
    const binding = { kind: 'profile', ...captureChatProfile(directories, 'main') };
    const snapshot = await buildConversationParticipantSnapshot(request, current, target, { avatar: group ? 'Kit.png' : 'Nova.png' },
        { binding, directive: '', timeZone: 'UTC' });
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'conversation.reply', submissionKey: 'image-source-fixture', intent: { target } });
    writeArtifact(directories, job.id, 'request', snapshot);
    return { ...f, directories, filename, thread, settings, snapshot, job,
        context: () => ({ owner: f.scope.owner, directories, job: getJob(directories, job.id), signal: new AbortController().signal }) };
}

test('new Conversation images bind the accepted account and checkpoint before paying and publish once', async t => {
    const f = await prepared(t);
    assert.equal(f.snapshot.quickImageGenAccount.accountId, f.scope.accountId);
    let paid = 0;
    const generate = createConversationImageGenerator({ fetchImpl: async () => {
        paid++;
        return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
    assert.equal(await generate(f.context(), f.snapshot, 'A selfie in a coat', f.snapshot.speaker), true);
    const stored = JSON.parse(fs.readFileSync(f.filename, 'utf8')).extension_settings.neconyan_conversation;
    assert.equal(stored.characters[f.thread].branches.main.messages.length, 2);
    assert.ok(stored.characters[f.thread].branches.main.messages[1].extra.image_url.startsWith('/user/images/'));
    assert.equal(await generate(f.context(), f.snapshot, 'A selfie in a coat', f.snapshot.speaker), true);
    assert.equal(paid, 1);
});

test('a Conversation history edit or disabled selected group speaker prevents paid image work', async t => {
    for (const legacy of [false, true]) {
        for (const group of [false, true]) {
            const f = await prepared(t, { group });
            if (legacy) delete f.snapshot.quickImageGenAccount;
            if (group) f.settings.extension_settings.neconyan_conversation.groups[0].disabled_members = ['Kit.png'];
            else f.settings.extension_settings.neconyan_conversation.characters[f.thread].branches.main.messages[0].mes = 'Edited after acceptance.';
            fs.writeFileSync(f.filename, JSON.stringify(f.settings));
            const generate = createConversationImageGenerator({ fetchImpl: () => assert.fail('changed image source reached its provider') });
            await assert.rejects(generate(f.context(), f.snapshot, 'A selfie', f.snapshot.speaker), error => error.status === 409);
            assert.equal(readArtifact(f.directories, f.job.id, 'provider:quick-image:image:0:0'), undefined);
        }
    }
});

test('an account data reset cannot redirect an accepted Conversation image request', async t => {
    const f = await prepared(t);
    const context = f.context();
    resetRoleplayAccount(f.scope, f.snapshot.quickImageGenAccount, 'reset');
    const generate = createConversationImageGenerator({ fetchImpl: () => assert.fail('replaced account reached image provider') });
    await assert.rejects(generate(context, f.snapshot, 'A selfie', f.snapshot.speaker), { code: 'ROLEPLAY_ACCOUNT_CHANGED' });
});
