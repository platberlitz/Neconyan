/* global document, window */
/* eslint-disable playwright/no-standalone-expect -- Assertions in test-owned fixture helpers. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test as base } from '@playwright/test';
import YAML from 'yaml';
import { createMewmoryProvider } from './mewmory-provider.js';
import { trackNavigationErrors } from './chat-scroll-regression-helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const STORE = 'neconyan_conversation';
export const MODEL = 'conversation-fixture';
export const REPLY = 'Durable first reply. [reminder: 1h | Durable reminder]\n\nDurable second reply. [schedule_update: status="dnd" activity="fixture rest" duration="1h"]';
const terminal = ['completed', 'cancelled', 'failed', 'interrupted', 'conflict'];

export async function acknowledgeActiveSettings(page) {
    let acknowledgement;
    // Startup listeners may queue another save after the one this helper awaits.
    // Wait for the real proof; tests of pending or edited controls still read it immediately.
    await expect.poll(async () => {
        acknowledgement = await page.evaluate(async () => {
            const core = await import('/script.js');
            if (!await core.saveSettings(0, { returnResult: true })) throw new Error('The fixture settings save failed.');
            try { return core.getActiveGenerationAcknowledgement(); }
            catch (error) {
                if (error.message === 'Save the active connection settings before generating a reply.') return null;
                throw error;
            }
        });
        return acknowledgement !== null;
    }, { timeout: 20000, message: 'Active settings have a settled server acknowledgement' }).toBe(true);
    return acknowledgement;
}

export const test = base.extend({
    libraryCache: [async ({}, use) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-libraries-'));
        try {
            // Seed a previously compiled bundle on slow hosts; the server still checks its input-derived cache key.
            if (process.env.NECONYAN_TEST_LIBRARY_CACHE) await fs.cp(process.env.NECONYAN_TEST_LIBRARY_CACHE, directory, { recursive: true });
            await use(directory);
        }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
    }, { scope: 'worker' }],
    app: [async ({ browser, libraryCache }, use, info) => {
        if (process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1') {
            throw new Error('Set NECONYAN_CONVERSATION_TEST_DISPOSABLE=1 to run this owned, disposable fixture.');
        }
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-durable-'));
        const provider = await createMewmoryProvider();
        provider.mode.reply = { choices: [{ message: { role: 'assistant', content: REPLY } }] };
        const reservation = createServer();
        reservation.listen(0, '127.0.0.1');
        await once(reservation, 'listening');
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const config = YAML.parse(await fs.readFile(path.join(root, 'default/config.yaml'), 'utf8'));
        Object.assign(config, {
            dataRoot: path.join(directory, 'data'), port, listen: false,
            enableUserAccounts: true, enableDownloadableTokenizers: false,
            enableServerPlugins: false, enableServerPluginsAutoUpdate: false,
        });
        config.browserLaunch.enabled = false;
        config.extensions.autoUpdate = false;
        config.extensions.models.autoDownload = false;
        config.performance.frontendBuild.enabled = process.env.NECONYAN_TEST_FRONTEND_BUILD === '1';
        config.rateLimiting.conversationMessageSendPoints = 0;
        await fs.mkdir(config.dataRoot);
        await fs.symlink(libraryCache, path.join(config.dataRoot, '_webpack'), 'dir');
        const configPath = path.join(directory, 'config.yaml');
        await fs.writeFile(configPath, YAML.stringify(config));
        const contexts = [];
        const navigationErrors = [];
        const processes = [];
        let child;
        let imageProvider;
        let output = '';
        const app = {
            url: `http://127.0.0.1:${port}`, provider, directory, processes,
            get serverOutput() { return output; },
            async images() {
                imageProvider = await createMewmoryProvider();
                imageProvider.mode.reply = { images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'] };
                return imageProvider;
            },
            async start({ useConfigDataRoot = false } = {}) {
                child = spawn(process.execPath, ['server.js', '--configPath', configPath,
                    ...(useConfigDataRoot ? [] : ['--dataRoot', config.dataRoot]),
                    '--port', String(port), '--browserLaunchEnabled', 'false'], {
                    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NECONYAN_SUPERVISED: '1' },
                });
                const record = { pid: child.pid, startedAt: Date.now() };
                processes.push(record);
                child.stdout.on('data', data => { output += data; });
                child.stderr.on('data', data => { output += data; });
                child.once('exit', (code, signal) => Object.assign(record, { code, signal, stoppedAt: Date.now() }));
                await expect.poll(async () => {
                    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Disposable server exited: ${output}`);
                    return fetch(app.url + '/csrf-token').then(response => response.ok).catch(() => false);
                }, { timeout: 60000, message: 'Owned server becomes ready' }).toBe(true);
                record.readyAt = Date.now();
            },
            async stop(signal = 'SIGTERM') {
                if (!child || child.exitCode !== null || child.signalCode !== null) return;
                const exited = once(child, 'exit');
                child.kill(signal);
                const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
                try { await exited; } finally { clearTimeout(timer); }
            },
            async restart(options) { await app.stop('SIGKILL'); await app.start(options); },
            async release() {
                await fetch(provider.url.replace(/\/v1$/, '') + '/fixture/release', { method: 'POST', body: '{}' });
            },
            async account({ handle = 'default-user', phone = false, textProfile = false, activeConnection = false, tts = false, settings = {}, configureSettings = () => {} } = {}) {
                const context = await browser.newContext({ baseURL: app.url, serviceWorkers: 'block', reducedMotion: 'reduce',
                    viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, hasTouch: phone, isMobile: phone });
                contexts.push(context);
                const csrf = await (await context.request.get('/csrf-token')).json();
                const headers = { 'X-CSRF-Token': csrf.token };
                const post = async (route, data = {}) => {
                    const response = await context.request.post(route, { headers, data });
                    expect(response.ok(), route + ': ' + await response.text()).toBe(true);
                    return response.json();
                };
                await post('/api/users/login', { handle, password: '' });
                const saved = JSON.parse((await post('/api/settings/get')).settings);
                // Keep unrelated startup preset backups from changing the settings acknowledgement mid-test.
                saved.extension_settings.disabledExtensions = [...new Set([...(saved.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                saved.power_user.send_on_enter = 1;
                saved.extension_settings.connectionManager = { profiles: [{ id: 'durable', name: 'Durable fixture',
                    api: 'custom', mode: 'cc', model: MODEL, 'api-url': provider.url }] };
                saved.oai_settings = { ...saved.oai_settings, chat_completion_source: 'custom', custom_url: provider.url, custom_model: 'decoy', stream_openai: false };
                if (textProfile) {
                    Object.assign(saved.extension_settings.connectionManager.profiles[0], { api: 'llamacpp', mode: 'tc', preset: 'Durable', instruct: 'Durable', 'instruct-state': 'true' });
                    saved.textgenerationwebui_settings = { ...saved.textgenerationwebui_settings, type: 'ooba', api_server: 'https://unused.invalid',
                        banned_tokens: '', global_banned_tokens: '', logit_bias: [], dry_sequence_breakers: '[]', negative_prompt: '' };
                    saved.max_context = 8192;
                    saved.power_user.custom_stopping_strings = '[]';
                    await fs.writeFile(path.join(config.dataRoot, handle, 'TextGen Settings', 'Durable.json'), JSON.stringify({ temp: 0.25, genamt: 73, max_length: 8192 }));
                    await fs.writeFile(path.join(config.dataRoot, handle, 'instruct', 'Durable.json'), JSON.stringify({ enabled: true, wrap: true, names_behavior: 'none',
                        system_sequence: '<system>', input_sequence: '<user>', output_sequence: '<assistant>', stop_sequence: '</assistant>' }));
                }
                if (activeConnection) {
                    saved.main_api = textProfile ? 'textgenerationwebui' : 'openai';
                    saved.oai_settings.custom_model = MODEL;
                    if (textProfile) {
                        Object.assign(saved.textgenerationwebui_settings, { type: 'llamacpp', api_server: provider.url,
                            server_urls: { ...saved.textgenerationwebui_settings.server_urls, llamacpp: provider.url } });
                        saved.power_user.instruct = JSON.parse(await fs.readFile(path.join(config.dataRoot, handle, 'instruct', 'Durable.json'), 'utf8'));
                    }
                    saved.extension_settings.connectionManager.selectedProfile = 'durable';
                    saved.extension_settings.connectionManager.profiles[0].model = 'unused-named-model';
                    settings = { ...settings, connection_profile: '' };
                }
                if (tts) {
                    saved.extension_settings.tts = { enabled: true, auto_generation: true, currentProvider: 'OpenAI Compatible', playback_rate: 1,
                        'OpenAI Compatible': { provider_endpoint: provider.url + '/audio/speech', model: 'tts-1', response_format: 'wav',
                            voiceMap: { 'Durable Nova': 'nova', 'Durable Kit': 'nova', '[Default Voice]': 'nova' } } };
                    await context.addInitScript(() => {
                        window.fixtureAudioPlays = [];
                        const play = window.HTMLMediaElement.prototype.play;
                        window.HTMLMediaElement.prototype.play = async function () {
                            await play.call(this);
                            if (this.src.startsWith('data:audio/')) window.fixtureAudioPlays.push({ src: this.src, at: Date.now() });
                        };
                    });
                }
                configureSettings(saved);
                await post('/api/settings/save', saved);
                const created = await context.request.post('/api/characters/create', { headers, data: {
                    ch_name: 'Durable Nova', description: 'Nova belongs to account ' + handle + '.', first_mes: 'Hello.', mes_example: 'Nova: Hello.',
                } });
                expect(created.ok()).toBe(true);
                const avatar = await created.text();
                const personaId = saved.user_avatar || '';
                const initial = await post('/api/neconyan-conversation/store/get');
                const store = initial.store;
                Object.assign(store.settings, { connection_profile: 'durable', idle_action: 'disabled', idle_followup: false,
                    idle_spontaneous: false, ...settings });
                await post('/api/neconyan-conversation/store/save', { store, version: initial.version });
                const current = await post('/api/neconyan-conversation/store/get');
                const thread = await post('/api/neconyan-conversation/thread/save', { avatar, personaId, version: current.version,
                    messages: [{ id: 'seed-user', role: 'user', name: 'User', mes: 'Original question.', timestamp: 1700000000000 }] });
                const latest = await post('/api/neconyan-conversation/store/get');
                Object.assign(latest.store.characters[thread.threadKey].settings, { enabled: true, availability: 'online', reply_delay_multiplier: 0,
                    connection_profile: activeConnection ? '' : 'durable',
                    auto_message: false, proactive_messaging: false, auto_character_chat: false,
                    roleplay_reactions: false, multi_char: false, image_gen_enabled: false, ...settings });
                await post('/api/neconyan-conversation/store/save', latest);
                const account = {
                    context, post, headers, avatar, personaId, threadKey: thread.threadKey,
                    async store() { return (await post('/api/neconyan-conversation/store/get')).store; },
                    async effects() {
                        const store = await account.store();
                        const branch = store.characters[thread.threadKey]?.branches.main;
                        // Opening a thread legitimately refreshes its preview and display timestamp.
                        if (branch) { delete branch.preview; delete branch.updatedAt; delete branch.unread; delete branch.readThrough; delete branch.pendingPresentations; }
                        return { branch, reminders: store.reminders,
                            runtimeStatusOverrides: store.runtimeStatusOverrides };
                    },
                    async changeStore(change) {
                        const saved = await post('/api/neconyan-conversation/store/get');
                        change(saved.store);
                        return post('/api/neconyan-conversation/store/save', saved);
                    },
                    async branch(id) {
                        const slot = (await account.store()).characters[thread.threadKey];
                        return slot?.branches[id || slot.activeBranchId];
                    },
                    async job(id) { return (await (await context.request.get('/api/jobs/' + id)).json()).job; },
                    async settled(id, state = 'completed') {
                        await expect.poll(async () => terminal.includes((await account.job(id)).state), { timeout: 60000 }).toBe(true);
                        const job = await account.job(id);
                        const children = await Promise.all((job.children || []).map(childId => account.job(childId)));
                        expect(job.state, JSON.stringify({ id, error: job.error, children: children.map(child => ({ id: child.id, state: child.state, error: child.error })) })).toBe(state);
                        for (const childId of job.children || []) {
                            await expect.poll(async () => terminal.includes((await account.job(childId)).state)).toBe(true);
                        }
                        return job;
                    },
                    async open({ workspace = true, timeout = 20000, readyTimeout = 60000, skipTour = true } = {}) {
                        const page = await context.newPage();
                        // Update notices depend on the checkout's remote, not this disposable account.
                        await page.route('**/api/server-admin/status', route => route.fulfill({ status: 403, json: { error: 'Update checks are outside this fixture.' } }));
                        navigationErrors.push(trackNavigationErrors(page).errors);
                        page.setDefaultTimeout(timeout);
                        await page.goto('/', { waitUntil: 'domcontentloaded' });
                        await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: readyTimeout });
                        const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
                        if (skipTour && await skip.isVisible()) await skip.click();
                        if (!workspace) return page;
                        await page.evaluate(async avatar => {
                            await window.SillyTavern.getContext().getCharacters();
                            await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
                        }, avatar);
                        await expect(page.locator('#sb_conversation_input')).toBeVisible();
                        await page.evaluate(async () => {
                            const sync = await import('/scripts/neconyan-conversation/store-sync.js');
                            if (!await sync.flushConversationStore()) throw new Error('Initial Conversation save failed');
                        });
                        return page;
                    },
                };
                return account;
            },
        };
        try { await app.start(); await use(app); }
        finally {
            await app.release();
            for (const context of contexts) await context.close();
            await app.stop();
            provider.server.closeAllConnections();
            await new Promise(resolve => provider.server.close(resolve));
            if (imageProvider) {
                imageProvider.server.closeAllConnections();
                await new Promise(resolve => imageProvider.server.close(resolve));
                await info.attach('image-calls', { body: JSON.stringify(imageProvider.calls.map(({ headers, ...call }) => call)), contentType: 'application/json' });
            }
            await info.attach('owned-processes', { body: JSON.stringify(processes, null, 2), contentType: 'application/json' });
            await info.attach('library-cache', { body: output.split('\n').filter(line => /frontend libraries/.test(line)).join('\n'), contentType: 'text/plain' });
            await info.attach('provider-calls', { body: JSON.stringify(provider.calls.map(({ headers, ...call }) => call), null, 2), contentType: 'application/json' });
            await info.attach('page-errors', { body: JSON.stringify(navigationErrors.flat()), contentType: 'application/json' });
            if (info.status !== info.expectedStatus) await info.attach('server-output', { body: output, contentType: 'text/plain' });
            await fs.rm(directory, { recursive: true, force: true });
        }
    }, { timeout: 120000 }],
});

export async function send(page, text = 'Durable question.') {
    await page.locator('#sb_conversation_input').fill(text);
    const response = page.waitForResponse(response => response.url().endsWith('/reply/submit'));
    await page.locator('#sb_conversation_send').click();
    const accepted = await response;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    return accepted.json();
}

export async function noLateEffects(account, before) {
    // Cross the normal five-second preparation window and two native scans.
    await delay(7200);
    expect(await account.effects()).toEqual(before);
}
