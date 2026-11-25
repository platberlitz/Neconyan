/* global window, document, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- One script drives three kinds of connection with different expectations. */
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { openScratchpadContext } from './neconyan-scratchpad-context-helpers.js';

const output = '/tmp/opencode/app-evidence-text-backends';
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'novelai-redirect-preload.mjs');

const PROMPT_SENTENCE = 'The lantern keeper whispered PLANTEDPROMPTSENTENCE to nobody at all.';
const REPLY_SENTENCE = 'Moonlight settled on PLANTEDREPLYSENTENCE like quiet dust.';
const SECRETS = {
    apiKey: 'sk-PLANTEDAPIKEY1234567890abcdef',
    bearer: 'PLANTEDBEARERTOKEN9876543210',
    password: 'PLANTEDSERVERPASSWORD',
    query: 'PLANTEDQUERYKEY123',
    novelToken: 'PLANTEDNOVELAITOKEN4567890',
};
const SERVER_URL = `http://admin:${SECRETS.password}@selfhosted.lan:5001/v1/completions?api_key=${SECRETS.query}`;
const PLANTED = [
    'PLANTEDPROMPTSENTENCE', 'lantern keeper whispered', 'PLANTEDREPLYSENTENCE', 'Moonlight settled', ...Object.values(SECRETS),
    'selfhosted.lan', 'admin:', ':5001',
];
// What a backend might send back: it quotes the prompt, a server address with a login and a key.
const ERROR_TEXT = `Context size exceeded. Input began with: "${PROMPT_SENTENCE}" while calling ${SERVER_URL} using Authorization: Bearer ${SECRETS.bearer} and key ${SECRETS.apiKey}.`;
const REPLY_OK = 'The mock reply is fine.';
const OOM_TEXT = 'Not enough memory to load the model.';
const NOT_REACHED = 'The app server got no reply from the backend (no error message was sent).';
const MODELS = { kobold: 'mock-kobold-model', novel: 'clio-v1', text: 'mock-text-model' };

const baseline = process.env.NECONYAN_TEST_CHECKOUT_ROOT;
const backends = await createBackends();
test.use({ initialServerOptions: {
    env: { NODE_OPTIONS: `--import ${PRELOAD}`, NECONYAN_TEST_NOVELAI_MOCK: `${backends.url}/novel` },
    ...(baseline ? { checkoutRoot: baseline } : {}),
} });

/** Mock KoboldAI, NovelAI and text completion backends on one local port. Each kind has a mode that the test changes. */
async function createBackends() {
    const state = { text: 'ok', kobold: 'ok', novel: 'ok' };
    const calls = [];
    const server = createServer(async (request, response) => {
        const kind = request.url.startsWith('/kobold') ? 'kobold' : request.url.startsWith('/novel') ? 'novel' : 'text';
        const route = request.url.replace(/^\/(kobold\/api|novel|text)/, '').split('?')[0];
        if (request.method === 'GET' || route === '/user/subscription') {
            response.setHeader('Content-Type', 'application/json');
            const body = {
                '/v1/info/version': { result: '1.2.5' },
                '/extra/version': { result: '1.60', version: '1.60' },
                '/v1/model': { result: MODELS.kobold },
                '/user/subscription': { tier: 3, active: true, perks: {}, trainingStepsLeft: { fixedTrainingStepsLeft: 0 } },
                '/v1/models': { object: 'list', data: [{ id: MODELS.text, object: 'model' }] },
                '/props': {},
            }[route] ?? {};
            return response.end(JSON.stringify(body));
        }
        let raw = '';
        for await (const chunk of request) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw); } catch { /* not JSON */ }
        if (!/(generate|completion)/.test(route)) return response.end('{}');
        const stream = kind === 'text' ? body.stream === true : /stream/.test(route);
        const mode = state[kind];
        const call = { kind, stream, mode, route, prompt: String(body.prompt ?? body.input ?? ''), closed: false, headers: request.headers };
        calls.push(call);
        response.on('close', () => { call.closed = true; });
        const send = token => {
            if (kind === 'kobold') return `event: message\ndata: ${JSON.stringify({ token })}\n\n`;
            if (kind === 'novel') return `event: newToken\ndata: ${JSON.stringify({ token, final: false })}\n\n`;
            return `data: ${JSON.stringify({ content: token, stop: false })}\n\n`;
        };
        const finish = () => kind === 'novel' ? `event: newToken\ndata: ${JSON.stringify({ token: '', final: true })}\n\n`
            : kind === 'text' ? `data: ${JSON.stringify({ content: '', stop: true, stop_type: 'eos' })}\n\n` : '';
        if (mode === 'drop') return request.socket.destroy();
        if (mode === 'oom' || mode === 'bare') {
            response.statusCode = 500;
            if (mode === 'bare') return response.end();
            response.setHeader('Content-Type', 'application/json');
            return response.end(JSON.stringify({ error: { code: 500, message: OOM_TEXT, type: 'server_error' } }));
        }
        if (mode === 'error') {
            response.statusCode = 400;
            response.setHeader('Content-Type', 'application/json');
            const bodies = {
                kobold: { detail: { msg: ERROR_TEXT, type: 'value_error' } },
                novel: { statusCode: 400, message: ERROR_TEXT },
                text: { error: { code: 400, message: ERROR_TEXT, type: 'exceed_context_size_error' } },
            };
            return response.end(JSON.stringify(bodies[kind]));
        }
        if (mode === 'slow' && !stream) return; // Waits until the app gives up on it.
        if (stream) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            if (mode === 'partial-drop') {
                response.write(send(`Here is ${REPLY_SENTENCE} and then `));
                return setTimeout(() => response.destroy(), 150);
            }
            if (mode === 'slow') {
                const timer = setInterval(() => response.write(send('slow ')), 200);
                return response.on('close', () => clearInterval(timer));
            }
            for (const token of ['The ', 'mock ', 'reply ', 'is ', 'fine.']) response.write(send(token));
            return response.end(finish() + (kind === 'text' ? '' : ''));
        }
        response.setHeader('Content-Type', 'application/json');
        if (mode === 'partial-drop') return request.socket.destroy();
        const ok = { kobold: { results: [{ text: REPLY_OK }] }, novel: { output: REPLY_OK }, text: { content: REPLY_OK, stop: true, stop_type: 'eos', model: MODELS.text } };
        return response.end(JSON.stringify(ok[kind]));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        calls: kind => calls.filter(call => call.kind === kind),
        mode(kind, mode) { state[kind] = mode; },
    };
}

// The chat itself is shared as ordinary context, so chat text is checked only inside the evidence section.
const evidenceOnly = text => {
    const start = text.search(/^## App evidence$/m);
    return start < 0 ? '' : text.slice(start).split(/\n## (?!#)/)[0];
};
const failureLines = text => (text.split('### Failed model requests')[1] ?? '').split(/\n### /)[0].split('\n').filter(line => line.startsWith('- '));
const withoutTime = line => line.replace(/^- \S+ /, '- ');

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

const failures = page => page.evaluate(async () => (await import('/scripts/app-evidence-log.js')).getProviderFailures()
    .map(({ provider, model, status, message }) => ({ provider, model, status, message })));
const clearFailures = page => page.evaluate(async () => (await import('/scripts/app-evidence-log.js')).clearAppEvidenceLog());

async function selectCharacter(page, avatar) {
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
}

async function idle(page) {
    await expect.poll(() => page.evaluate(async () => {
        const core = await import('/script.js');
        return !core.is_send_press && !document.body.dataset.generating && getComputedStyle(document.getElementById('mes_stop')).display === 'none';
    }), { timeout: 60000 }).toBe(true);
    await page.evaluate(() => window.toastr.clear());
}

async function setStreaming(page, kind, stream) {
    await page.evaluate(async ({ kind, stream }) => {
        if (kind === 'kobold') (await import('/scripts/kai-settings.js')).kai_settings.streaming_kobold = stream;
        if (kind === 'novel') (await import('/scripts/nai-settings.js')).nai_settings.streaming_novel = stream;
        if (kind === 'text') (await import('/scripts/textgen-settings.js')).textgenerationwebui_settings.streaming = stream;
    }, { kind, stream });
}

/** One way of asking for a reply. Each of them must record a failure the same way. */
const WAYS = {
    async send(page, text) {
        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_textarea').press('Enter');
    },
    regenerate: page => page.evaluate(() => import('/script.js').then(core => core.Generate('regenerate')).catch(error => { window.__lastError = String(error?.stack ?? error).slice(0, 600); })),
    swipe: page => page.evaluate(() => import('/script.js').then(core => core.Generate('swipe')).catch(error => { window.__lastError = String(error?.stack ?? error).slice(0, 600); })),
    continue: page => page.evaluate(() => import('/script.js').then(core => core.Generate('continue')).catch(error => { window.__lastError = String(error?.stack ?? error).slice(0, 600); })),
    // A plain background prompt in a saved chat runs as a server job; skipWIAN keeps it on the page generator that is being tested.
    quiet: page => page.evaluate(() => import('/script.js').then(core => core.generateQuietPrompt({ quietPrompt: 'Summarise the scene.', skipWIAN: true })).catch(error => { window.__lastError = String(error?.stack ?? error).slice(0, 600); })),
    // KoboldAI and NovelAI are not reply formats any more, so only code that names them (an extension) reaches them.
    raw: (page, text, kind) => page.evaluate(({ prompt, api }) => import('/script.js').then(core => core.generateRawData({ prompt, api, signal: window.__stopper?.signal })).catch(error => { window.__lastError = String(error?.stack ?? error).slice(0, 600); }), { prompt: text, api: kind === 'text' ? null : kind }),
    direct: (page, text, kind) => page.evaluate(async ({ prompt, kind }) => {
        const signal = window.__stopper?.signal;
        const kai = await import('/scripts/kai-settings.js');
        const nai = await import('/scripts/nai-settings.js');
        try {
            const stream = kind === 'kobold'
                ? await kai.generateKoboldWithStreaming({ prompt, api_server: kai.kai_settings.api_server, streaming: true, max_length: 50, max_context_length: 2048 }, signal)
                : await nai.generateNovelWithStreaming({ input: prompt, model: nai.nai_settings.model_novel, max_length: 50, temperature: 1 }, signal);
            for await (const chunk of stream()) void chunk;
        } catch (error) { window.__lastError = String(error?.stack ?? error).slice(0, 600); }
    }, { prompt: text, kind }),
};

async function attempt(page, kind, way, { mode, stream, text = `Please go on: ${PROMPT_SENTENCE}` }) {
    backends.mode(kind, mode);
    await setStreaming(page, kind, stream);
    const before = backends.calls(kind).length;
    await WAYS[way](page, text, kind);
    const state = async () => JSON.stringify(await page.evaluate(async () => {
        const core = await import('/script.js');
        return { main_api: core.main_api, online_status: core.online_status, toasts: [...document.querySelectorAll('#toast-container .toast')].map(toast => toast.textContent.slice(0, 200)), lastError: window.__lastError ?? '' };
    }));
    try {
        await expect.poll(() => backends.calls(kind).length, { timeout: 30000, message: `${way} reaches the ${kind} backend` }).toBeGreaterThan(before);
    } catch (error) {
        throw new Error(`${error.message}\napp state: ${await state()}`);
    }
    await idle(page);
    return backends.calls(kind).slice(before);
}

function configure(kind) {
    return saved => {
        const url = backends.url;
        saved.power_user.auto_label_chat = false;
        if (kind === 'kobold') {
            saved.kai_settings = { ...saved.kai_settings, api_server: `${url}/kobold/api`, streaming_kobold: false };
        }
        if (kind === 'novel') {
            saved.nai_settings = { ...saved.nai_settings, model_novel: MODELS.novel, streaming_novel: false };
        }
        if (kind === 'text') {
            saved.main_api = 'textgenerationwebui';
            saved.textgenerationwebui_settings = { ...saved.textgenerationwebui_settings, type: 'llamacpp', api_server: `${url}/text`, streaming: false,
                server_urls: { ...saved.textgenerationwebui_settings.server_urls, llamacpp: `${url}/text` },
                banned_tokens: '', global_banned_tokens: '', logit_bias: [], dry_sequence_breakers: '[]', negative_prompt: '' };
            saved.max_context = 8192;
            saved.power_user.custom_stopping_strings = '[]';
        }
    };
}

function noPlanted(label, text) {
    for (const value of PLANTED) expect(text.toLowerCase(), `${label} leaks ${value}`).not.toContain(value.toLowerCase());
}

/** Shows the evidence the way Scratchpad does with the switch on, then sends a real question and returns what the model received. */
async function shareEvidence({ page, app, account, phone, size, label, expectedLines }) {
    await openScratchpad(page);
    await openScratchpadContext(page, 'sharing');
    if (phone) await applyIOSOnlyCss(page);
    const toggle = page.getByRole('checkbox', { name: /^App diagnostics/ });
    await toggle.check();
    await page.getByRole('button', { name: 'Show preview', exact: true }).click();
    const preview = page.locator('pre.scratchpad-preview-text');
    await expect(preview).toContainText('### Failed model requests');
    const section = evidenceOnly(await preview.innerText());
    const lines = failureLines(section);
    expect(lines).toHaveLength(expectedLines);
    if (!baseline) noPlanted('preview evidence', section);
    // A failed request leaves nothing extra in the browser errors.
    expect(section).not.toContain('### Browser errors and crash reports');

    await openScratchpadContext(page, 'replies');
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    app.provider.mode.httpError = null;
    app.provider.mode.reply = { choices: [{ message: { content: 'The evidence lists the failures.' } }] };
    const question = `What went wrong in Neconyan? (${size} ${label})`;
    await page.locator('.scratchpad-composer').fill(question);
    const [response] = await Promise.all([
        page.waitForResponse('**/api/scratchpad/send'),
        page.locator('.scratchpad-send').click(),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
    const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
    expect(calls).toHaveLength(1);
    const sent = evidenceOnly(calls[0].messages.map(message => String(message.content)).join('\n'));
    expect(sent).toContain('### Failed model requests');
    expect(failureLines(sent).map(withoutTime)).toEqual(lines.map(withoutTime));
    if (!baseline) noPlanted('request to the model', sent);
    return { lines, section, sent };
}

for (const phone of [false, true]) {
    for (const kind of ['kobold', 'novel', 'text']) {
        test(`${phone ? 'phone' : 'desktop'} ${kind} failures reach App diagnostics once, privately`, async ({ app }) => {
            test.setTimeout(420000);
            const size = phone ? 'phone' : 'desktop';
            fs.mkdirSync(output, { recursive: true });
            backends.mode(kind, 'ok');
            const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: configure(kind) });
            if (kind === 'novel') await account.post('/api/secrets/write', { key: 'api_key_novel', value: SECRETS.novelToken });
            if (phone) await installIPhoneSafari(account.context, { standalone: true });
            const page = await account.open({ workspace: false });
            await acknowledgeActiveSettings(page);
            if (phone) await applyIOSOnlyCss(page);
            await selectCharacter(page, account.avatar);
            if (kind === 'text') await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status), { timeout: 30000 }).not.toBe('no_connection');
            const provider = { kobold: 'koboldai', novel: 'novelai', text: 'text completion (llamacpp)' }[kind];
            const log = [];
            const note = (label, value) => log.push(`${label}: ${JSON.stringify(value)}`);

            // Text completion is reached by every ordinary way; KoboldAI and NovelAI only by code that names them.
            const ui = kind === 'text';
            const via = stream => ui ? 'send' : stream ? 'direct' : 'raw';

            // A reply that works records nothing, streaming or not, and gives later paths something to regenerate.
            for (const stream of [false, true]) {
                const [call] = await attempt(page, kind, via(stream), { mode: 'ok', stream, text: `Hello ${stream ? 'streaming' : 'plain'} world` });
                expect(call.stream).toBe(stream);
                if (ui) await expect(page.locator('#chat .mes_text').last()).toContainText(REPLY_OK.slice(0, 8));
                expect(await failures(page), `a working ${stream ? 'streamed' : 'plain'} reply records nothing`).toEqual([]);
            }

            // Every way of asking for a reply records exactly one entry, on every kind of failure.
            const ways = ui ? ['send', 'regenerate', 'swipe', 'continue', 'quiet', 'raw'] : ['raw', 'direct'];
            for (const way of ways) {
                for (const stream of [false, true]) {
                    if (stream && ['quiet', 'raw'].includes(way)) continue; // Quiet and raw replies never stream.
                    if (!ui && stream !== (way === 'direct')) continue;
                    await clearFailures(page);
                    const calls = await attempt(page, kind, way, { mode: 'error', stream });
                    expect(calls, `${way} sends one request`).toHaveLength(1);
                    const entries = await failures(page);
                    note(`${way} ${stream ? 'stream' : 'plain'}`, entries);
                    expect(entries, `${way} ${stream ? 'streamed' : 'plain'} failure is one entry`).toHaveLength(1);
                    expect(entries[0].provider).toBe(provider);
                    noPlanted(`${way} entry`, JSON.stringify(entries));
                }
            }

            // The failures the assistant is shown: an HTTP error and a dropped connection, streaming and not.
            await clearFailures(page);
            // KoboldAI and NovelAI streams carry no end marker, so a stream cut after some words looks like a finished reply to the app; only text completion can tell.
            const core = [['error', false], ['error', true], ['drop', false], ['drop', true], ...(ui ? [['partial-drop', true]] : [])];
            for (const [mode, stream] of core) {
                await attempt(page, kind, via(stream), { mode, stream, text: `Tell me ${PROMPT_SENTENCE}` });
            }
            const entries = await failures(page);
            note('shown entries', entries);
            // The list keeps the newest five and every one of the five requests failed, so none may be missing or doubled.
            expect(entries).toHaveLength(core.length);
            for (const entry of entries) expect(entry.provider).toBe(provider);
            noPlanted('recorded entries', JSON.stringify(entries));

            // A request the person stops is not a failure.
            for (const stream of [false, true]) {
                const before = (await failures(page)).length;
                backends.mode(kind, 'slow');
                await setStreaming(page, kind, stream);
                const seen = backends.calls(kind).length;
                await page.evaluate(() => { window.__stopper = new AbortController(); });
                const running = WAYS[via(stream)](page, `Stop this one ${stream ? 'streaming' : 'plain'}`, kind);
                await expect.poll(() => backends.calls(kind).length).toBeGreaterThan(seen);
                if (ui) {
                    if (stream) await expect(page.locator('#chat .mes_text').last()).toContainText('slow');
                    await page.evaluate(async () => (await import('/script.js')).stopGeneration());
                } else {
                    if (stream) await expect.poll(() => backends.calls(kind).at(-1).closed === false).toBe(true);
                    await page.evaluate(() => window.__stopper.abort());
                }
                await running;
                await page.evaluate(() => { window.__stopper = null; });
                await idle(page);
                const stopped = backends.calls(kind).at(-1);
                await expect.poll(() => stopped.closed, { message: 'the stopped request is cut at the backend too' }).toBe(true);
                expect((await failures(page)).length, `stopping a ${stream ? 'streamed' : 'plain'} reply records nothing`).toBe(before);
            }

            // Working replies after all of that still add nothing.
            const total = (await failures(page)).length;
            for (const stream of [false, true]) await attempt(page, kind, via(stream), { mode: 'ok', stream, text: 'Fine again' });
            expect(await failures(page)).toHaveLength(total);

            const shared = await shareEvidence({ page, app, account, phone, size, label: kind, expectedLines: core.length });
            fs.writeFileSync(path.join(output, `${size}-${kind}-lines.txt`), shared.lines.join('\n') + '\n');
            fs.writeFileSync(path.join(output, `${size}-${kind}-log.txt`), log.join('\n') + '\n');
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
            // A failed request ends in a toast and one log entry, not in an unhandled rejection or a broken module.
            expect(app.navigationErrors).toEqual([]);
        });
    }
}

// Chat completion records its failures too. Run this file against another checkout (NECONYAN_TEST_CHECKOUT_ROOT) and the
// entries it writes show that the provider, model and status read the same there; only the message is cleaned here.
for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} chat completion entries keep their fields and lose the prompt, one per failed request`, async ({ app }) => {
        test.setTimeout(300000);
        const size = phone ? 'phone' : 'desktop';
        fs.mkdirSync(output, { recursive: true });
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true, configureSettings: saved => { saved.power_user.auto_label_chat = false; } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        const quoting = `Quota exceeded for the plan. Input began with: "Tell me ${PROMPT_SENTENCE}" while calling ${SERVER_URL} using Authorization: Bearer ${SECRETS.bearer} and key ${SECRETS.apiKey}.`;
        const cases = [
            { name: 'plain HTTP 429', stream: false, status: 429, httpError: { status: 429, body: { error: { message: quoting } } } },
            { name: 'plain HTTP 500', stream: false, status: 500, httpError: { status: 500, body: { error: { message: 'The upstream model fell over.' } } } },
            { name: 'plain error in an answer', stream: false, status: 0, reply: { error: { message: quoting } } },
            { name: 'stream HTTP 429', stream: true, status: 429, httpError: { status: 429, body: { error: { message: quoting } } } },
            { name: 'stream HTTP 500', stream: true, status: 500, httpError: { status: 500, body: { error: { message: 'The upstream model fell over.' } } } },
            { name: 'stream error after a reply', stream: true, status: 0, streamEvents: [{ choices: [{ delta: { content: `Here is ${REPLY_SENTENCE} and then ` } }] }, { error: { message: `The stream broke after "${REPLY_SENTENCE}". ${quoting}` } }] },
        ];
        const seen = [];
        const toasts = [];
        await clearFailures(page);
        for (const item of cases) {
            await page.evaluate(async stream => { (await import('/scripts/openai.js')).oai_settings.stream_openai = stream; }, item.stream);
            Object.assign(app.provider.mode, { httpError: item.httpError ?? null, reply: item.reply ?? null, streamEvents: item.streamEvents ?? null });
            const before = app.provider.calls.length;
            await WAYS.send(page, `Tell me ${PROMPT_SENTENCE} (${item.name})`);
            await expect.poll(() => app.provider.calls.length, { timeout: 30000 }).toBeGreaterThan(before);
            await expect.poll(() => page.evaluate(async () => !(await import('/script.js')).is_send_press), { timeout: 60000 }).toBe(true);
            toasts.push({ name: item.name, toasts: await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(toast => toast.textContent.trim())) });
            await page.evaluate(() => window.toastr.clear());
            const entries = await failures(page);
            expect(entries, `${item.name} adds one entry`).toHaveLength(Math.min(seen.length + 1, 5));
            expect(entries[0]).toMatchObject({ provider: 'custom', model: 'conversation-fixture' });
            if (item.status) expect(entries[0].status).toBe(item.status);
            seen.push({ name: item.name, entry: { ...entries[0] } });
            if (!baseline) noPlanted(`${item.name} entry`, JSON.stringify(entries));
        }
        Object.assign(app.provider.mode, { httpError: null, reply: null, streamEvents: null });
        const fields = seen.map(({ name, entry }) => ({ name, provider: entry.provider, model: entry.model, status: entry.status }));
        fs.writeFileSync(path.join(output, `chat-${size}-fields${baseline ? '-staging' : ''}.json`), JSON.stringify(fields, null, 2) + '\n');
        fs.writeFileSync(path.join(output, `chat-${size}-entries${baseline ? '-staging' : ''}.json`), JSON.stringify(seen, null, 2) + '\n');
        fs.writeFileSync(path.join(output, `chat-${size}-toasts${baseline ? '-staging' : ''}.json`), JSON.stringify(toasts, null, 2) + '\n');

        // The last five failures are what the assistant is shown; the prompt, the reply, the keys and the server address are not in them.
        const shared = await shareEvidence({ page, app, account, phone, size, label: 'chat completion', expectedLines: 5 });
        fs.writeFileSync(path.join(output, `chat-${size}-lines${baseline ? '-staging' : ''}.txt`), shared.lines.join('\n') + '\n');
        expect(app.navigationErrors).toEqual([]);
    });
}

// The app server answers { error: true, status, response } when a text backend fails. The toast used to read 'true'
// and the toast code threw a TypeError. Screenshots of it go to ../screenshots/error-true-toast when asked for.
for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} a text backend error reads as a sentence in the toast`, async ({ app }) => {
        test.setTimeout(240000);
        const size = phone ? 'phone' : 'desktop';
        const phase = baseline ? 'before' : 'after';
        const shots = path.join('..', 'screenshots', 'error-true-toast');
        fs.mkdirSync(shots, { recursive: true });
        fs.mkdirSync(output, { recursive: true });
        backends.mode('text', 'ok');
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings: configure('text') });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        if (phone) await applyIOSOnlyCss(page);
        await selectCharacter(page, account.avatar);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status), { timeout: 30000 }).not.toBe('no_connection');
        const shown = [];
        // 'drop' and 'bare' make the app server answer { error: true, status, response }, which a streamed reply reads as well.
        const matrix = [
            { mode: 'drop', stream: true, expected: 'socket hang up', shot: true },
            { mode: 'drop', stream: false, expected: 'socket hang up' },
            { mode: 'bare', stream: false, expected: NOT_REACHED, shot: true },
            { mode: 'oom', stream: false, expected: OOM_TEXT },
            { mode: 'oom', stream: true, expected: OOM_TEXT },
        ];
        for (const { mode, stream, expected, shot } of matrix) {
            await setStreaming(page, 'text', stream);
            backends.mode('text', mode);
            const before = backends.calls('text').length;
            await WAYS.send(page, `Please go on (${mode} ${stream ? 'stream' : 'plain'})`);
            await expect.poll(() => backends.calls('text').length, { timeout: 30000 }).toBeGreaterThan(before);
            await expect.poll(() => page.evaluate(async () => !(await import('/script.js')).is_send_press), { timeout: 60000 }).toBe(true);
            // Before this change some of these had no toast at all, so give a late one a moment to show.
            await page.locator('#toast-container .toast').first().waitFor({ timeout: 3000 }).catch(() => undefined);
            const texts = await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(toast => toast.textContent.trim()));
            shown.push({ mode, stream, texts });
            if (shot) await page.screenshot({ path: path.join(shots, `${size}-${mode}-${stream ? 'stream' : 'plain'}-${phase}.png`) });
            await page.evaluate(() => window.toastr.clear());
            if (!baseline) {
                expect(texts.join(' | '), `${mode} ${stream ? 'streamed' : 'plain'} toast`).toContain(expected);
                expect(texts.some(text => /^(Text Completion API|Text generation error)?\s*true$/.test(text)), 'no toast reads just true').toBe(false);
            }
        }
        // A streamed request that the app server turns down with no message at all, such as a bare 'Bad Request', still gets a toast.
        if (!baseline) {
            const route = '**/api/backends/text-completions/generate';
            await setStreaming(page, 'text', true);
            await page.route(route, request => request.fulfill({ status: 400, contentType: 'text/plain', body: 'Bad Request' }));
            await WAYS.send(page, 'Please go on (bare 400 stream)');
            await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map(toast => toast.textContent.trim()).join(' | ')), { timeout: 30000 }).toContain('HTTP 400: Bad Request');
            await expect.poll(() => page.evaluate(async () => !(await import('/script.js')).is_send_press), { timeout: 60000 }).toBe(true);
            await page.unroute(route);
            await page.evaluate(() => window.toastr.clear());
        }
        fs.writeFileSync(path.join(output, `${size}-error-true-toast-${phase}.json`), JSON.stringify(shown, null, 2) + '\n');
        expect(app.navigationErrors).toEqual([]);
    });
}
