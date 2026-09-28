import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { acceptConversationSelfie, registerConversationSelfieJobs } = await import('../src/generation/conversation-selfie.js');
const { preflightConversationBindings } = await import('../src/generation/conversation-jobs.js');
const { explicitRetryRecovery, getJob, listJobs, updateJob } = await import('../src/jobs/store.js');
const { providerStep, readArtifact } = await import('../src/jobs/artifacts.js');
const { testExports: { runJob }, setDirectoriesResolver } = await import('../src/jobs/runner.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { getConversationMessageRevision } = await import('../public/scripts/neconyan-conversation/message-identity-utils.js');

function imageResponse() {
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'Content-Type': 'application/json' } });
}

function prepared(t, { group = false } = {}) {
    const f = fixture(t);
    t.after(cancelAutoSaves);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user/images');
    fs.mkdirSync(directories.userImages, { recursive: true });
    if (group) fs.copyFileSync(path.join(directories.characters, 'Nova.png'), path.join(directories.characters, 'Kit.png'));
    const groupId = group ? 'selfie-group' : '';
    const thread = group ? 'group:selfie-group:Nova.png' : 'Nova.png';
    const branch = { id: 'main', name: 'Main', createdAt: 1, updatedAt: 1, messages: [
        { id: 'm1', role: 'user', name: 'User', mes: 'Send a picture?', timestamp: 1 },
        { id: 'm2', role: 'character', name: 'Nova', mes: 'Sure.', timestamp: 2 },
    ] };
    const settings = { _version: 0, name1: 'User', power_user: {},
        oai_settings: { chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:5000/v1' },
        extension_settings: { connectionManager: { profiles: [{ id: 'main', api: 'custom', model: 'fixture', 'api-url': 'http://127.0.0.1:5000/v1' }] },
            'quick-image-gen': { provider: 'together', togetherKey: 'private-key', togetherModel: 'image-fixture', seed: 4,
                style: 'none', appendQuality: false, useSTStyle: false },
            neconyan_conversation: { version: 1, settings: { connection_profile: 'main', image_gen_enabled: false, image_gen_cooldown: 0 },
                groups: group ? [{ id: groupId, personaId: '', members: ['Nova.png', 'Kit.png'], disabled_members: [],
                    conversation_settings: {}, createdAt: 1, updatedAt: 1 }] : [], reminders: [],
                characters: { [thread]: { settings: {}, activeBranchId: 'main', branches: { main: branch } } } } } };
    const filename = path.join(directories.root, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify(settings));
    setDirectoriesResolver(() => directories);
    const request = { user: { directories, profile: { handle: f.scope.owner } } };
    const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'));
    const messages = () => read().extension_settings.neconyan_conversation.characters[thread].branches.main.messages;
    const write = mutate => {
        const data = read();
        mutate(data.extension_settings.neconyan_conversation, data);
        fs.writeFileSync(filename, JSON.stringify(data));
    };
    async function submission({ key = 'selfie-1', speakerAvatar = group ? 'Kit.png' : 'Nova.png', extra = {} } = {}) {
        const body = {
            submissionKey: key,
            target: { avatar: 'Nova.png', groupId, personaId: '', branchId: 'main' },
            branchCreatedAt: '1', speakerAvatar, context: 'on a rainy balcony',
            triggers: messages().map(message => ({ messageId: message.id, revision: getConversationMessageRevision(message) })),
            ...extra,
        };
        body.bindingRequest = await preflightConversationBindings(request, { ...body, bindingOnly: true });
        return body;
    }
    return { ...f, directories, request, thread, read, messages, write, submission };
}

function textModel(calls) {
    return async options => {
        const system = options.messages.find(message => message.role === 'system')?.content || options.rawOptions?.systemPrompt || '';
        calls.push(system);
        if (system.includes('image generation prompt')) return { text: 'Nova smiling under a rainy balcony light' };
        return { text: 'Nova: Rain suits me, right?' };
    };
}

test('a manual selfie renders, captions and posts once without the page, even after another message arrives', async t => {
    const f = prepared(t);
    const calls = [];
    let paid = 0;
    const narrated = [];
    const narrate = async (context, snapshot, text, speaker, delivery) => {
        assert.equal(typeof delivery.verify, 'function');
        narrated.push({ text, speaker: speaker.avatar, effectId: delivery.effectId });
        return { status: 'ready', job: context.job.id, artifact: 'provider:narration:selfie', mimeType: 'audio/mpeg' };
    };
    registerConversationSelfieJobs({ generate: textModel(calls), fetchImpl: async () => { paid++; return imageResponse(); }, narrate });
    const body = await f.submission();
    const accepted = await acceptConversationSelfie(f.request, body);
    assert.equal(accepted.created, true);
    assert.equal((await acceptConversationSelfie(f.request, body)).job.id, accepted.job.id);
    f.write(store => store.characters[f.thread].branches.main.messages.push({ id: 'm3', role: 'user', name: 'User', mes: 'Waiting!', timestamp: 3 }));

    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(getJob(f.directories, accepted.job.id).state, 'completed');
    const messages = f.messages();
    assert.equal(messages.length, 4);
    const posted = messages[3];
    assert.equal(posted.role, 'character');
    assert.equal(posted.mes, 'Rain suits me, right?');
    assert.equal(posted.extra.conversation_mode_image, true);
    assert.ok(posted.extra.image_url.startsWith('/user/images/'));
    assert.match(posted.extra.image_prompt, /rainy balcony/);
    assert.equal(messages[2].mes, 'Waiting!');
    assert.equal(paid, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(narrated, [{ text: 'Rain suits me, right?', speaker: 'Nova.png', effectId: 'selfie' }]);
    const branch = f.read().extension_settings.neconyan_conversation.characters[f.thread].branches.main;
    assert.equal(branch.pendingPresentations[posted.id].narration.status, 'ready');
    assert.equal(branch.unread, 1);

    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(f.messages().length, 4);
    assert.equal(paid, 1);
    assert.equal(calls.length, 2);
});

test('a group partner selfie is posted as the partner and stops if the partner is disabled before paying', async t => {
    const f = prepared(t, { group: true });
    let paid = 0;
    registerConversationSelfieJobs({ generate: textModel([]), fetchImpl: async () => { paid++; return imageResponse(); } });
    const first = await acceptConversationSelfie(f.request, await f.submission());
    await runJob(getJob(f.directories, first.job.id));
    const posted = f.messages().at(-1);
    assert.equal(posted.role, 'partner');
    assert.equal(posted.extra.partner_avatar, 'Kit.png');
    assert.equal(paid, 1);

    const second = await acceptConversationSelfie(f.request, await f.submission({ key: 'selfie-2' }));
    f.write(store => { store.groups[0].disabled_members = ['Kit.png']; });
    await runJob(getJob(f.directories, second.job.id));
    assert.notEqual(getJob(f.directories, second.job.id).state, 'completed');
    assert.equal(paid, 1);
    assert.equal(readArtifact(f.directories, second.job.id, 'selfie-image'), undefined);
});

test('a replaced branch stops the selfie before any provider request', async t => {
    const f = prepared(t);
    const calls = [];
    registerConversationSelfieJobs({ generate: textModel(calls), fetchImpl: () => assert.fail('replaced branch reached the image provider') });
    const accepted = await acceptConversationSelfie(f.request, await f.submission());
    f.write(store => { store.characters[f.thread].branches.main.createdAt = 99; });
    await runJob(getJob(f.directories, accepted.job.id));
    assert.notEqual(getJob(f.directories, accepted.job.id).state, 'completed');
    assert.equal(calls.length, 0);
    assert.equal(f.messages().length, 2);
});

test('a failed caption keeps the paid picture with the stock caption', async t => {
    const f = prepared(t);
    registerConversationSelfieJobs({
        generate: async options => {
            const system = options.messages.find(message => message.role === 'system')?.content || '';
            if (system.includes('image generation prompt')) return { text: 'Nova in the rain' };
            throw Object.assign(new Error('Caption provider refused.'), { status: 502 });
        },
        fetchImpl: async () => imageResponse(),
    });
    const accepted = await acceptConversationSelfie(f.request, await f.submission());
    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(getJob(f.directories, accepted.job.id).state, 'completed');
    assert.equal(f.messages().at(-1).mes, 'Here, I took this for you.');
    assert.equal(readArtifact(f.directories, accepted.job.id, 'caption-reply').error, 'Caption provider refused.');
});

test('an unknown caption outcome keeps the picture and waits for an explicit retry', async t => {
    const f = prepared(t);
    let paid = 0;
    let captionCalls = 0;
    registerConversationSelfieJobs({
        generate: async options => {
            const system = options.messages.find(message => message.role === 'system')?.content || '';
            if (system.includes('image generation prompt')) return { text: 'Nova in the rain' };
            return providerStep(options.jobContext, 'caption', async () => {
                if (++captionCalls === 1) throw new Error('socket hang up');
                return { text: 'Back again.' };
            });
        },
        fetchImpl: async () => { paid++; return imageResponse(); },
    });
    const accepted = await acceptConversationSelfie(f.request, await f.submission());
    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(getJob(f.directories, accepted.job.id).state, 'interrupted');
    assert.ok(readArtifact(f.directories, accepted.job.id, 'selfie-image').url);
    assert.equal(readArtifact(f.directories, accepted.job.id, 'caption-reply'), undefined);
    assert.equal(f.messages().length, 2);

    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(captionCalls, 1);
    assert.equal(f.messages().length, 2);

    updateJob(f.directories, accepted.job.id, current => ({ state: 'queued', finishedAt: null, error: null, ...explicitRetryRecovery(current) }));
    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(getJob(f.directories, accepted.job.id).state, 'completed');
    assert.equal(f.messages().at(-1).mes, 'Back again.');
    assert.equal(captionCalls, 2);
    assert.equal(paid, 1);
});

test('a rendered picture is reused after an interruption instead of paying again', async t => {
    const f = prepared(t);
    let paid = 0;
    let captionCalls = 0;
    registerConversationSelfieJobs({
        generate: async options => {
            const system = options.messages.find(message => message.role === 'system')?.content || '';
            if (system.includes('image generation prompt')) return { text: 'Nova in the rain' };
            captionCalls++;
            if (captionCalls === 1) throw Object.assign(new Error('The connection dropped.'), { name: 'AbortError' });
            return { text: 'Still here.' };
        },
        fetchImpl: async () => { paid++; return imageResponse(); },
    });
    const accepted = await acceptConversationSelfie(f.request, await f.submission());
    await runJob(getJob(f.directories, accepted.job.id));
    assert.notEqual(getJob(f.directories, accepted.job.id).state, 'completed');
    assert.ok(readArtifact(f.directories, accepted.job.id, 'selfie-image').url);
    assert.equal(f.messages().length, 2);

    await runJob(getJob(f.directories, accepted.job.id));
    assert.equal(getJob(f.directories, accepted.job.id).state, 'completed');
    assert.equal(f.messages().at(-1).mes, 'Still here.');
    assert.equal(paid, 1);
});

test('selfie submissions refuse bad input before accepting a job', async t => {
    const f = prepared(t);
    registerConversationSelfieJobs({ generate: textModel([]), fetchImpl: () => assert.fail('refused selfie reached a provider') });
    await assert.rejects(acceptConversationSelfie(f.request, await f.submission({ extra: { context: 'x'.repeat(1001) } })), /too long/);
    await assert.rejects(acceptConversationSelfie(f.request, await f.submission({ extra: { sourceMessageId: 'missing' } })), /captured context/);
    await assert.rejects(acceptConversationSelfie(f.request, { ...(await f.submission()), bindingRequest: undefined }), /captured connection/);
    assert.equal(listJobs(f.directories, { owner: f.scope.owner, includeDismissed: true }).length, 0);

    const body = await f.submission();
    await acceptConversationSelfie(f.request, body);
    await assert.rejects(acceptConversationSelfie(f.request, { ...body, context: 'somewhere else' }), /another operation/);
});
