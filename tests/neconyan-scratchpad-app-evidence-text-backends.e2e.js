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

            // What the assistant is given: the evidence section of Scratchpad, with the switch on.
            await openScratchpad(page);
            await page.getByRole('tab', { name: 'Context', exact: true }).click();
            if (phone) await applyIOSOnlyCss(page);
            const toggle = page.getByRole('checkbox', { name: /^App diagnostics/ });
            await toggle.check();
            await page.getByRole('button', { name: 'Show preview', exact: true }).click();
            const preview = page.locator('pre.scratchpad-preview-text');
            await expect(preview).toContainText('### Failed model requests');
            const section = evidenceOnly(await preview.innerText());
            const lines = failureLines(section);
            fs.writeFileSync(path.join(output, `${size}-${kind}-lines.txt`), lines.join('\n') + '\n');
            fs.writeFileSync(path.join(output, `${size}-${kind}-log.txt`), log.join('\n') + '\n');
            expect(lines).toHaveLength(core.length);
            noPlanted('preview evidence', section);

            // The real request to the model carries the same lines.
            await page.getByRole('tab', { name: 'Context', exact: true }).click();
            await page.locator('#scratchpad-connection-miso').selectOption('durable');
            await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            app.provider.mode.reply = { choices: [{ message: { content: 'The evidence lists the failures.' } }] };
            const question = `What went wrong in Neconyan? (${size} ${kind})`;
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
            noPlanted('request to the model', sent);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
            // A failed send ends as an unhandled rejection in the app today (staging does too); a broken module or boot is what must not show up.
            expect(app.navigationErrors.filter(error => /ReferenceError|SyntaxError|does not provide an export|is not defined|Cannot read|text-backend-failures/.test(String(error).replace(/\n\s+at .*text-backend-failures\.js[^\n]*/g, '')))).toEqual([]);
        });
    }
}

// Chat completion already records its failures. Run this file against another checkout (NECONYAN_TEST_CHECKOUT_ROOT)
// and the files it writes hold the same entries, which is how 'unchanged' is shown.
for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} chat completion entries stay as they were, one per failed request`, async ({ app }) => {
        test.setTimeout(240000);
        const size = phone ? 'phone' : 'desktop';
        fs.mkdirSync(output, { recursive: true });
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true, configureSettings: saved => { saved.power_user.auto_label_chat = false; } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await selectCharacter(page, account.avatar);
        const seen = [];
        for (const stream of [false, true]) {
            await page.evaluate(async stream => { (await import('/scripts/openai.js')).oai_settings.stream_openai = stream; }, stream);
            for (const [status, message] of [[429, `Quota exceeded for the plan. ${PROMPT_SENTENCE}`], [500, 'The upstream model fell over.']]) {
                await clearFailures(page);
                app.provider.mode.httpError = { status, body: { error: { message } } };
                const before = app.provider.calls.length;
                await WAYS.send(page, `Chat completion ${stream ? 'stream' : 'plain'} ${status}`);
                await expect.poll(() => app.provider.calls.length).toBeGreaterThan(before);
                await idle(page);
                const entries = await failures(page);
                expect(entries, `${stream ? 'streamed' : 'plain'} ${status} is one entry`).toHaveLength(1);
                seen.push({ stream, entry: { ...entries[0] } });
            }
        }
        app.provider.mode.httpError = null;
        fs.writeFileSync(path.join(output, `chat-${size}-entries${baseline ? '-staging' : ''}.json`), JSON.stringify(seen, null, 2) + '\n');
        expect(seen.map(item => item.entry.status)).toEqual([429, 500, 429, 500]);
        for (const { entry } of seen) expect(entry.provider).toBe('custom');
    });
}
