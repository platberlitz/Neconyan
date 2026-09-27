/* global window, document, getComputedStyle */
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test as baseTest } from './neconyan-conversation-durable-fixture.js';
import { setConfigFilePath } from '../src/util.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAccountStamp, withRoleplayAccount } = await import('../src/roleplay-store.js');
const { captureRoleplaySource, readRoleplayChat } = await import('../src/generation/roleplay-source.js');
const { captureRoleplayWorldInfo } = await import('../src/generation/world-info.js');
const { captureGenerationBinding, getChatProfileContextLimit } = await import('../src/generation/profiles.js');
const { getSettingsRevision } = await import('../src/settings-version.js');
const { admitRoleplayJob } = await import('../src/roleplay-jobs.js');
const { releaseJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const { writeSecret, SECRET_KEYS } = await import('../src/endpoints/secrets.js');
const { encodeServerImage } = await import('../src/media-codecs.js');
const { captureQuickImageRequest } = await import('../src/generation/quick-image-gen-request.js');
const { admitQuickImageJob } = await import('../src/generation/quick-image-gen-workflow.js');
const { captureSpriteRequest, admitSpriteJob } = await import('../src/generation/sprite-jobs.js');
const { captureCaptionRequest, admitCaptionJob } = await import('../src/generation/caption-jobs.js');
const { captureSpeechRequest, admitSpeechJob } = await import('../src/generation/speech-jobs.js');

const test = baseTest.extend({
    media: async ({}, use, info) => {
        const rgba = new Uint8Array(64 * 64 * 4);
        for (let index = 0; index < rgba.length; index += 4) rgba.set([220, 30, 50, 255], index);
        const image = await encodeServerImage({ width: 64, height: 64, data: rgba });
        const calls = [];
        const held = new Set();
        const media = { calls, image, holdHistoryAfter: 0, release() { media.holdHistoryAfter = 0; for (const release of held) release(); held.clear(); } };
        const server = createServer(async (request, response) => {
            const url = new URL(request.url, 'http://localhost');
            let text = '';
            for await (const chunk of request) text += chunk;
            const body = text ? JSON.parse(text) : null;
            const call = { path: url.pathname, method: request.method, body, at: Date.now() };
            calls.push(call);
            let result;
            if (url.pathname === '/translate') result = { translatedText: `${body.target === 'en' ? 'EN' : 'FR'}(${body.q})` };
            else if (url.pathname === '/prompt') result = { prompt_id: String(calls.filter(item => item.path === '/prompt').length) };
            else if (url.pathname.startsWith('/history/')) {
                const id = url.pathname.split('/').at(-1);
                if (media.holdHistoryAfter && Number(id) >= media.holdHistoryAfter) {
                    await new Promise(resolve => { held.add(resolve); response.once('close', resolve); });
                }
                result = { [id]: { status: { status_str: 'success', completed: true }, outputs: {
                    9: { images: [{ filename: `fixture-${id}.png`, subfolder: '', type: 'output' }] },
                } } };
            } else if (url.pathname === '/view') {
                response.writeHead(200, { 'Content-Type': 'image/png' });
                response.end(image);
                return;
            } else {
                response.writeHead(404);
                response.end();
                return;
            }
            if (!response.destroyed) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(result));
            }
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        media.url = `http://127.0.0.1:${server.address().port}`;
        try { await use(media); }
        finally {
            media.release();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await info.attach('media-requests', { contentType: 'application/json', body: JSON.stringify(calls.map(call => ({ ...call,
                body: call.body && Object.fromEntries(Object.entries(call.body).filter(([key]) => key !== 'api_key')) })), null, 2) });
        }
    },
});

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires an owned disposable server.');
test.setTimeout(240000);

function completion(text) { return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }; }
function privateAccount(app) {
    const owner = 'default-user';
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(app.directory, 'data', owner, relative)]));
    const base = { owner, directories };
    const { accountId, dataEpoch } = roleplayAccountStamp(base);
    return { base, stamp: { accountId, dataEpoch }, scope: { ...base, accountId, dataEpoch }, directories };
}

async function seedChat(account, name, image = true) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const response = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(response.ok(), await response.text()).toBe(true);
    const vacancy = JSON.parse(response.headers()['x-neconyan-roleplay']);
    const records = [{ user_name: 'User', character_name: 'Durable Nova', chat_metadata: { stage6: true } },
        { name: 'Durable Nova', is_user: false, mes: 'Original answer.', extra: {}, swipes: ['Original answer.', 'Keep this alternative.'], swipe_id: 0 },
        { name: 'User', is_user: true, mes: 'Bonjour', extra: image ? { media_display: 'gallery', media_index: 0,
            media: [{ url: '/user/images/stage6.png', type: 'image', source: 'upload' }] } : {} }];
    await account.post('/api/chats/save', { ...fields, chat: records,
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { group: false, avatar: account.avatar, chat: name };
}

async function closePages(browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) await page.close();
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
}

async function reopen(account, name, info) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, name }) => {
        const context = window.SillyTavern.getContext();
        const core = await import('/script.js');
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(name);
    }, { avatar: account.avatar, name });
    await expect(page.locator('#send_textarea')).toBeVisible();
    const geometry = await page.locator('#send_textarea').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width, viewport: window.innerWidth,
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize), overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
    expect(geometry.width).toBeGreaterThan(100);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.fontSize).toBeGreaterThanOrEqual(14);
    expect(geometry.overflow).toBe(false);
    await page.screenshot({ path: info.outputPath('retained-media.png') });
    return page;
}

function acceptReply(native, avatar, locator, operationKey) {
    const { base, stamp, scope, directories } = native;
    const source = captureRoleplaySource(scope, { locator });
    const settings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
    const binding = captureGenerationBinding(directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(settings) });
    const intent = { operationKey, effect: 'append', source, request: { binding, maxTokens: 128, characterName: 'Durable Nova',
        messages: [], serverPrompt: true, worldInfo: captureRoleplayWorldInfo(base, stamp, source, { avatar,
            maxContext: getChatProfileContextLimit(directories, binding) - 128, serverPrompt: true }) } };
    const { jobId } = admitRoleplayJob(base, stamp, intent);
    releaseJob(directories, jobId);
    return { jobId, intent };
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} saved caption, input translation, Pathfinder and speech finish with every page closed`, async ({ app, media, browser }, info) => {
        app.provider.mode.reply = body => {
            const instructions = JSON.stringify(body.messages);
            if (body.model === 'caption-fixture') return completion('scarlet bird');
            if (instructions.includes('predictive lorebook')) return completion(JSON.stringify({ candidates: ['["Manual",12] Location: Observatory'] }));
            if (instructions.includes('relevance filter')) return completion(JSON.stringify({ selected: ['["Manual",12] Location: Observatory'] }));
            return completion('Native media reply.');
        };
        const account = await app.account({ phone, activeConnection: true, tts: true, configureSettings: settings => {
            // This case enables Pathfinder's native tools as well as its lorebook passes.
            Object.assign(settings.oai_settings, { function_calling: true, custom_prompt_post_processing: '' });
            settings.extension_settings.caption = { source: 'multimodal', multimodal_api: 'custom', multimodal_model: 'caption-fixture', auto_mode: true };
            settings.extension_settings.translate = { auto_mode: 'both', provider: 'libre', target_language: 'fr', internal_language: 'en' };
            settings.extension_settings.inChatAgents = { globalSettings: { enabled: true, pathfinderEnabled: true } };
            settings.world_info_settings = { world_info: { globalSelect: ['Bird'] }, world_info_budget: 50, world_info_depth: 4 };
        } });
        await account.open({ workspace: false });
        await closePages(browser);
        const native = privateAccount(app);
        withRoleplayAccount(native.base, native.stamp, () => {
            fs.mkdirSync(native.directories.userImages, { recursive: true });
            fs.writeFileSync(path.join(native.directories.userImages, 'stage6.png'), media.image);
            fs.writeFileSync(path.join(native.directories.worlds, 'Bird.json'), JSON.stringify({ entries: { 1: {
                uid: 1, key: ['scarlet bird'], keysecondary: [], content: 'A scarlet bird guards the garden.', comment: 'Bird', order: 10, position: 0,
            } } }));
            fs.writeFileSync(path.join(native.directories.worlds, 'Manual.json'), JSON.stringify({ entries: { 12: {
                uid: 12, key: ['never-activated'], keysecondary: [], content: 'The telescope is broken.', comment: 'Location: Observatory', order: 1, position: 0,
            } } }));
            fs.mkdirSync(native.directories.inChatAgents, { recursive: true });
            fs.writeFileSync(path.join(native.directories.inChatAgents, 'pathfinder.json'), JSON.stringify({ id: 'pathfinder', category: 'tool', name: 'Pathfinder', enabled: true,
                settings: { pipelineEnabled: true, sidecarEnabled: false, skipSecondPass: false, enabledLorebooks: ['Manual'], includeContextualLorebooks: false, connectionProfile: 'durable' } }));
            writeSecret(native.directories, SECRET_KEYS.LIBRE, 'private-fixture-libre-key');
            writeSecret(native.directories, SECRET_KEYS.LIBRE_URL, media.url + '/translate');
        });
        const locator = await seedChat(account, 'Stage6 contributors');
        const { jobId, intent } = acceptReply(native, account.avatar, locator, 'stage6-contributors');
        await account.settled(jobId);
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const saved = readRoleplayChat(native.scope, locator).records;
        expect(saved[1].swipes).toEqual(['Original answer.', 'Keep this alternative.']);
        expect(saved[2].mes).toBe('EN(Bonjour)');
        expect(saved[2].extra.display_text).toBe('Bonjour');
        expect(saved[2].extra.media[0].captioned).toBe(true);
        expect(saved.at(-1).mes).toBe('Native media reply.');
        expect(saved.at(-1).extra.display_text).toBe('FR(Native media reply.)');
        const prompt = readArtifact(native.directories, jobId, 'roleplay-prompt');
        expect(JSON.stringify(prompt.messages)).toContain('A scarlet bird guards the garden.');
        expect(JSON.stringify(prompt.messages)).toContain('The telescope is broken.');
        const narration = saved.at(-1).extra.server_narration;
        expect(narration.status).toBe('ready');
        const audio = await account.context.request.get(`/api/jobs/${encodeURIComponent(jobId)}/audio/${encodeURIComponent(narration.artifact)}`);
        expect(audio.ok()).toBe(true);
        expect((await audio.body()).subarray(0, 4).toString()).toBe('RIFF');
        const paid = app.provider.calls.length;
        expect(admitRoleplayJob(native.base, native.stamp, intent).jobId).toBe(jobId);
        await app.restart();
        const page = await reopen(account, locator.chat, info);
        await expect(page.locator('#chat .mes').last()).toContainText('FR(Native media reply.)');
        expect(app.processes.length).toBe(2);
        expect(app.processes[0].signal).toBe('SIGKILL');
        expect(app.provider.calls).toHaveLength(paid);
        await page.close();
    });

    test(`${viewport} saved image passes and batch survive the serving process dying during read-only polling`, async ({ app, media, browser }, info) => {
        app.provider.mode.reply = body => completion(JSON.stringify(body.messages).includes('STANDALONE VISUAL SCENE')
            ? 'Nova watches a scarlet bird in the garden.' : body.model === 'caption-fixture' ? 'scarlet bird' : 'nova, scarlet bird, clear sky');
        const account = await app.account({ phone, tts: true, configureSettings: settings => {
            settings.extension_settings.caption = { source: 'multimodal', multimodal_api: 'custom', multimodal_model: 'caption-fixture', auto_mode: false };
            settings.extension_settings['quick-image-gen'] = { provider: 'local', localType: 'comfyui', localUrl: media.url, localModel: 'fixture-model',
                useLLMPrompt: true, twoStepPrompt: true, useWorldInfo: false, useLastMessage: true, appendQuality: false, useSTStyle: false,
                batchCount: 2, sequentialSeeds: true, seed: 31, messageRange: '-1' };
        } });
        await account.open({ workspace: false });
        await closePages(browser);
        const native = privateAccount(app);
        withRoleplayAccount(native.base, native.stamp, () => {
            fs.mkdirSync(native.directories.userImages, { recursive: true });
            fs.writeFileSync(path.join(native.directories.userImages, 'stage6.png'), media.image);
        });
        const locator = await seedChat(account, 'Stage6 media');
        const source = captureRoleplaySource(native.scope, { locator });
        const request = captureQuickImageRequest(native.base, native.stamp, source, { avatar: account.avatar, mode: 'scene', connection: { kind: 'profile', profileId: 'durable' } });
        const intent = { operationKey: 'stage6-images', source, request };
        media.holdHistoryAfter = 2;
        const { jobId } = admitQuickImageJob(native.base, native.stamp, intent);
        releaseJob(native.directories, jobId);
        await expect.poll(() => media.calls.filter(call => call.path === '/history/2').length, { timeout: 60000 }).toBeGreaterThan(0);
        expect(media.calls.filter(call => call.path === '/prompt')).toHaveLength(2);
        expect(app.provider.calls.filter(call => call.messages)).toHaveLength(2);
        const plan = readArtifact(native.directories, jobId, 'image:batch');
        expect(plan.items.map(item => item.seed)).toEqual([31, 32]);
        expect(fs.readdirSync(native.directories.userImages).filter(name => name.startsWith('qig-'))).toHaveLength(1);
        await app.stop('SIGKILL');
        media.release();
        await app.start();
        const completed = await account.settled(jobId);
        expect(completed.result.result.outputs).toHaveLength(2);
        expect(media.calls.filter(call => call.path === '/prompt')).toHaveLength(2);
        expect(app.provider.calls.filter(call => call.messages)).toHaveLength(2);
        expect(readArtifact(native.directories, jobId, 'image:batch')).toEqual(plan);
        for (const output of completed.result.result.outputs) expect((await account.context.request.get(output.url)).ok()).toBe(true);
        expect(admitQuickImageJob(native.base, native.stamp, intent).jobId).toBe(jobId);
        const spriteSource = captureRoleplaySource(native.scope, { locator });
        const spriteRequest = captureSpriteRequest(native.base, native.stamp, spriteSource, { avatar: account.avatar, labels: ['smile'], folder: 'Stage6 sprites', mode: 'individual' });
        const sprite = admitSpriteJob(native.base, native.stamp, { operationKey: 'stage6-sprite', source: spriteSource, request: spriteRequest });
        releaseJob(native.directories, sprite.jobId);
        await account.settled(sprite.jobId);
        expect((await account.context.request.get('/characters/Stage6%20sprites/smile.png')).ok()).toBe(true);
        const captionSource = captureRoleplaySource(native.scope, { locator, message: 1 });
        const captionRequest = captureCaptionRequest(native.base, native.stamp, captionSource, { avatar: account.avatar, mediaIndex: 0 });
        const caption = admitCaptionJob(native.base, native.stamp, { operationKey: 'stage6-caption', source: captionSource, request: captionRequest });
        releaseJob(native.directories, caption.jobId);
        await account.settled(caption.jobId);
        const speechSource = captureRoleplaySource(native.scope, { locator, message: 1 });
        const speechRequest = captureSpeechRequest(native.base, native.stamp, speechSource, { avatar: account.avatar });
        const speech = admitSpeechJob(native.base, native.stamp, { operationKey: 'stage6-speech', source: speechSource, request: speechRequest });
        releaseJob(native.directories, speech.jobId);
        await account.settled(speech.jobId);
        expect(fs.readdirSync(path.join(native.directories.files, 'speech')).length).toBeGreaterThan(0);
        expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(0);
        const paid = app.provider.calls.length;
        const page = await reopen(account, locator.chat, info);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('Bonjour');
        await expect(page.locator('#chat .mes').last().locator('.mes_img')).toHaveAttribute('title', /scarlet bird/);
        expect(app.provider.calls).toHaveLength(paid);
        expect(app.processes[0].signal).toBe('SIGKILL');
        await page.close();
    });

    test(`${viewport} an unknown paid caption remains interrupted after a real server restart and reopening`, async ({ app, media, browser }, info) => {
        app.provider.mode.hold = 'caption-fixture';
        app.provider.mode.reply = body => completion(body.model === 'caption-fixture' ? 'scarlet bird' : 'A reply that must not run.');
        const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
            settings.extension_settings.caption = { source: 'multimodal', multimodal_api: 'custom', multimodal_model: 'caption-fixture', auto_mode: true };
        } });
        await account.open({ workspace: false });
        await closePages(browser);
        const native = privateAccount(app);
        withRoleplayAccount(native.base, native.stamp, () => {
            fs.mkdirSync(native.directories.userImages, { recursive: true });
            fs.writeFileSync(path.join(native.directories.userImages, 'stage6.png'), media.image);
        });
        const locator = await seedChat(account, 'Stage6 unknown');
        const before = readRoleplayChat(native.scope, locator).records;
        const { jobId, intent } = acceptReply(native, account.avatar, locator, 'stage6-unknown');
        await expect.poll(() => app.provider.calls.filter(call => call.model === 'caption-fixture').length, { timeout: 60000 }).toBe(1);
        await app.stop('SIGKILL');
        await app.release();
        await app.start();
        await account.settled(jobId, 'interrupted');
        expect(admitRoleplayJob(native.base, native.stamp, intent).jobId).toBe(jobId);
        expect(readRoleplayChat(native.scope, locator).records).toEqual(before);
        expect(app.provider.calls.filter(call => call.model === 'caption-fixture')).toHaveLength(1);
        expect(app.provider.calls.filter(call => call.model !== 'caption-fixture')).toHaveLength(0);
        const page = await reopen(account, locator.chat, info);
        await expect(page.locator('#chat .mes').last()).toContainText('Bonjour');
        expect(app.provider.calls.filter(call => call.model === 'caption-fixture')).toHaveLength(1);
        expect(app.processes[0].signal).toBe('SIGKILL');
        await page.close();
    });
}
