/* global window */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

// Mewmory must not refuse a reply because hidden data (signatures, tool-call signatures, inlined pictures)
// was priced as text. Every provider route the page uses, its start-up catalogue calls included, is answered in the browser, so the
// server never contacts a provider.
test.setTimeout(240000);

const ROLE = process.env.NECONYAN_SIZE_ROLE || 'candidate';
if (!['base', 'candidate'].includes(ROLE)) throw new Error('NECONYAN_SIZE_ROLE must be base or candidate.');
const EVIDENCE = process.env.NECONYAN_SIZE_EVIDENCE || '';
const SCREENSHOTS = process.env.NECONYAN_SCREENSHOT_DIRECTORY || '';
const CONNECTION = 'google/gemini-4-neon';
const SENTENCE = 'Ilsa gave Perrin the lantern key.';
const REPLY = 'The lantern key rests safely with Perrin.';
const QUESTION = 'Where is the lantern key now?';
const HISTORY_REFUSAL = 'Mewmory\'s required text is too long for one reply. Increase the context size (how much text the model can read at once), reduce saved memories, or finish filling in memories for older messages.';
const COUNTED = /^Mewmory counted ([\d,]+) tokens in the prepared prompt, but only ([\d,]+) fit before the reply/;
const TEXT_LIMIT = 'Mewmory: retained history exceeds the model limit. Increase context or finish preservation in Mewmory.';

// ---- Seeded invented text ---------------------------------------------------------------------------------

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const WORDS = ('lantern harbour quay gull rope tide ledger brass kettle shutter ferry anchor salt weather cellar stair chart '
    + 'compass thread candle bridge market ribbon window garden harbour whistle bucket barrel signal mist lamp pier cabin '
    + 'locket letter bell cart gate lantern orchard river stone tower trunk vessel wharf yard quiet careful hungry slow '
    + 'bright tired steady narrow golden crooked patient weary ready sudden gentle brisk heavy faded counted carried '
    + 'folded measured mended opened sealed waited watched wound answered').split(' ');
const NAMES = ['Ilsa', 'Perrin', 'Corwen', 'Maribel', 'Tobiah', 'Ysolde'];

/** Base64-looking data for a signature or picture, identical on every run. */
function signature(seed, length) {
    const next = seeded(seed);
    const out = new Array(length);
    for (let index = 0; index < length; index++) out[index] = BASE64[Math.floor(next() * 64)];
    return out.join('');
}

function prose(seed, chars) {
    const next = seeded(seed);
    const pick = list => list[Math.floor(next() * list.length)];
    let text = '';
    while (text.length < chars) {
        const words = Array.from({ length: 7 + Math.floor(next() * 9) }, () => (next() < 0.12 ? pick(NAMES) : pick(WORDS)));
        words[0] = words[0][0].toUpperCase() + words[0].slice(1);
        text += words.join(' ') + (next() < 0.15 ? '? ' : '. ') + (next() < 0.2 ? '\n\n' : '');
    }
    return text.slice(0, chars).trimEnd();
}

/** A tracker note: JSON lines whose quotes are escaped inside the scene name. */
function tracker(seed, chars) {
    const next = seeded(seed);
    const pick = list => list[Math.floor(next() * list.length)];
    let text = '';
    while (text.length < chars) {
        text += `{"t": "0${Math.floor(next() * 10)}:${10 + Math.floor(next() * 50)}", "mood": "${pick(WORDS)}", "who": ["${pick(NAMES)}", "${pick(NAMES)}"], `
            + `"scene": "The \\"${pick(WORDS)}\\" ${pick(WORDS)}", "note": "${pick(WORDS)} ${pick(WORDS)}"}\n`;
    }
    return text.slice(0, chars).trimEnd();
}

/** Dialogue with blank lines between the speeches. */
function dialogue(seed, chars) {
    const next = seeded(seed);
    const pick = list => list[Math.floor(next() * list.length)];
    let text = '';
    while (text.length < chars) {
        text += `"${pick(NAMES)}," he said. "${pick(NAMES)}," she said.\n\n"${pick(WORDS)}?"\n\n"${pick(WORDS)}."\n\n`;
    }
    return text.slice(0, chars).trimEnd();
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, check]);
}

/** A valid noise picture, 150 rows of 160 random pixels, that does not compress. */
function noisePng() {
    const width = 160;
    const height = 150;
    const next = seeded(4242);
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let index = 0; index < raw.length; index++) raw[index] = index % (1 + width * 3) === 0 ? 0 : Math.floor(next() * 256);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 0 })), pngChunk('IEND', Buffer.alloc(0))]);
    expect(png.length).toBeGreaterThanOrEqual(70000);
    return png;
}

// ---- Evidence ---------------------------------------------------------------------------------------------

async function record(name, data) {
    if (!EVIDENCE) return;
    const directory = path.join(EVIDENCE, ROLE);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, name.replace(/[^a-z0-9-]+/gi, '-') + '.json'), JSON.stringify(data, null, 2));
}

// ---- Network guards (installed before the app loads, because loading starts the status check) -------------

/**
 * Registered in this order, so the last runs first: (1) any host but the app's is recorded and aborted, (2) every
 * provider route the specific answers do not cover is recorded and aborted, (3) the answers themselves, the start-up catalogue calls of NanoGPT and OpenRouter among them.
 */
async function guardNetwork(context, app) {
    const origin = new URL(app.url).origin;
    const net = { foreign: [], blocked: [], status: 0, generate: 0, generates: [] };
    const own = route => new URL(route.request().url()).origin === origin;
    await context.route('**/*', route => {
        if (own(route)) return route.fallback();
        net.foreign.push(route.request().method() + ' ' + route.request().url());
        return route.abort();
    });
    for (const pattern of ['**/api/openrouter/**', '**/api/backends/chat-completions/**']) {
        await context.route(pattern, route => {
            if (!own(route)) return route.fallback();
            net.blocked.push(route.request().method() + ' ' + route.request().url());
            return route.abort();
        });
    }
    const answer = (pattern, handler) => context.route(pattern, route => (own(route) ? handler(route) : route.fallback()));
    await answer('**/api/nanogpt/**', route => route.fulfill({ json: [] }));
    await answer('**/api/openrouter/providers', route => route.fulfill({ json: ['fixture-provider'] }));
    await answer('**/api/openrouter/models/providers', route => route.fulfill({ json: { providers: ['fixture-provider'] } }));
    await answer('**/api/backends/chat-completions/status', route => {
        net.status++;
        return route.fulfill({ json: { data: [{ id: CONNECTION, name: 'Neon', context_length: 2000000, pricing: { prompt: '0', completion: '0' },
            architecture: { tokenizer: 'Gemini', input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] }] } });
    });
    await answer('**/api/backends/chat-completions/generate', route => {
        net.generate++;
        net.generates.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] } });
    });
    return net;
}

let current = null;
test.afterEach(() => {
    if (!current) return;
    const { foreign, blocked } = current;
    current = null;
    expect({ foreign, blocked }).toEqual({ foreign: [], blocked: [] });
});

// ---- Chats, memory and the page ---------------------------------------------------------------------------

function saved(row, index) {
    return { name: row.is_user ? 'Robin' : row.is_system ? 'System' : 'Durable Nova', is_user: Boolean(row.is_user), is_system: Boolean(row.is_system),
        send_date: `fixture-${String(index).padStart(3, '0')}`, ...row };
}

async function seedChat(account, name, rows) {
    const fields = { avatar_url: account.avatar, file_name: name };
    const vacant = await account.context.request.post('/api/chats/get', { headers: account.headers, data: { ...fields, allow_create: true } });
    expect(vacant.ok()).toBe(true);
    const vacancy = JSON.parse(vacant.headers()['x-neconyan-roleplay']);
    await account.post('/api/chats/save', { ...fields, chat: [{ chat_metadata: {} }, ...rows.map(saved)],
        roleplay: { account: vacancy.account, vacancy: vacancy.vacancy, operationKey: randomUUID() } });
    return { avatar: account.avatar, chat: name, group: false };
}

/** The app's own per-message count for the writer's tokenizer. */
async function appCounts(account, rows) {
    const messages = rows.filter(row => !row.is_system).map(row => ({ role: row.is_user ? 'user' : 'assistant', content: row.mes }));
    return (await account.post('/api/tokenizers/openai/count?model=gemma&per_message=1', messages)).token_counts;
}

const sum = values => values.reduce((total, value) => total + value, 0);

/** Sizes the visible text so the app's per-message sum lands in the range. */
async function fitRows(account, make, [low, high]) {
    let scale = 1;
    for (let attempt = 0; attempt < 5; attempt++) {
        const rows = make(scale);
        const total = sum(await appCounts(account, rows));
        if (total >= low && total <= high) return { rows, total };
        scale *= (low + high) / 2 / total;
    }
    throw new Error(`The seeded text could not be sized into ${low} to ${high} tokens.`);
}

async function addMemory(app, account, locator) {
    app.provider.mode.reply = body => {
        const input = JSON.parse(body.messages.at(-1).content);
        const refs = input.sources.filter(source => source.type === 'chat').map(({ id, revision }) => ({ id, revision }));
        return { choices: [{ message: { role: 'assistant', content: JSON.stringify({
            records: [{ id: 'state:player', kind: 'state', entityId: 'player', text: SENTENCE, refs }], activeNpcIds: [], interviews: [],
        }) } }] };
    };
    const { config } = await account.post('/api/mewmory/config/get');
    Object.assign(config, { autoUpdate: false, excludeHistory: false });
    for (const role of Object.values(config.roles)) role.enabled = false;
    Object.assign(config.roles.extractor, { enabled: true, useShared: false, endpoint: app.provider.url, model: 'extractor' });
    await account.post('/api/mewmory/config/save', { config });
    const initial = await account.post('/api/mewmory/inspect', { locator });
    await account.post('/api/mewmory/enabled', { locator, revision: initial.revision, enabled: true });
    const processed = await account.post('/api/mewmory/process', { locator, all: true });
    expect(processed.playerReferences.records.length).toBeGreaterThan(0);
    expect(app.provider.calls.filter(call => call.model === 'extractor').length).toBeGreaterThan(0);
}

function connection(settings, flags) {
    return saved => {
        saved.username = 'Robin';
        saved.power_user.default_persona = saved.user_avatar;
        saved.power_user.persona_description = 'Robin keeps the harbour ledger.';
        saved.power_user.personas[saved.user_avatar] = 'Robin';
        saved.power_user.persona_descriptions[saved.user_avatar] = {
            description: saved.power_user.persona_description, position: 0, depth: 2, role: 0,
            lorebook: '', connections: [], title: '', appendices: [], activeAppendices: {},
        };
        Object.assign(saved.extension_settings.connectionManager.profiles[0], { api: 'openrouter', mode: 'cc', model: CONNECTION });
        delete saved.extension_settings.connectionManager.profiles[0]['api-url'];
        Object.assign(saved.oai_settings, { chat_completion_source: 'openrouter', openrouter_model: CONNECTION, stream_openai: false,
            max_context_unlocked: true, bind_preset_to_connection: false, reverse_proxy: '', ...settings, ...flags });
    };
}

/** An account on the routed OpenRouter connection with a key that exists nowhere. */
async function startAccount(app, { phone = false, context = 128000, reply = 50000, flags = {} } = {}) {
    const account = await app.account({ phone, activeConnection: true, configureSettings: connection({ openai_max_context: context, openai_max_tokens: reply }, flags) });
    current = await guardNetwork(account.context, app);
    await account.post('/api/secrets/write', { key: 'api_key_openrouter', value: 'fixture-key-not-real' });
    return { account, net: current };
}

async function openChat(account, locator, expectation) {
    const page = await account.open({ workspace: false });
    await page.evaluate(async ({ avatar, chat }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(chat);
        window.sizeErrors = [];
        const original = window.toastr.error.bind(window.toastr);
        window.toastr.error = (...args) => { window.sizeErrors.push(String(args[0])); return original(...args); };
    }, { avatar: locator.avatar, chat: locator.chat });
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status), { timeout: 30000 }).not.toBe('no_connection');
    const live = await page.evaluate(async () => {
        const { oai_settings } = await import('/scripts/openai.js');
        return { source: oai_settings.chat_completion_source, model: oai_settings.openrouter_model, context: oai_settings.openai_max_context,
            reply: oai_settings.openai_max_tokens, tools: oai_settings.function_calling, media: oai_settings.media_inlining };
    });
    expect(live).toMatchObject({ source: 'openrouter', model: CONNECTION, ...expectation });
    return page;
}

const errorsOf = page => page.evaluate(() => window.sizeErrors);

/** Presses Send and waits until a writer request or an error exists (and the reply, when a request went out). */
async function sendAndSettle(page, net, text = QUESTION) {
    const before = net.generates.length;
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
    await expect.poll(async () => net.generates.length - before + (await errorsOf(page)).length, { timeout: 90000 }).toBeGreaterThan(0);
    const writer = () => net.generates.slice(before).filter(body => JSON.stringify(body.messages).includes(text));
    if (writer().length) await expect(page.locator('#chat .mes[mesid]').last().locator('.mes_text')).toContainText(REPLY, { timeout: 30000 });
    return { writer, errors: () => errorsOf(page) };
}

async function screenshot(page, name, phone) {
    if (!SCREENSHOTS) return;
    await fs.mkdir(SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOTS, `${name}-${phone ? 'phone' : 'desktop'}-${ROLE === 'base' ? 'before' : 'after'}.png`) });
}

/** Sizes of the prompt the writer was sent. */
function parts(body) {
    const messages = body.messages ?? [];
    const calls = messages.filter(message => Array.isArray(message.tool_calls) && message.tool_calls.length);
    return { messages, signatures: messages.filter(message => message.signature).map(message => message.signature),
        toolGroups: calls.length, text: JSON.stringify(messages) };
}

function reportBase(errors, expectedBudget) {
    const [message] = errors;
    const match = COUNTED.exec(message ?? '');
    return { message, counted: match ? Number(match[1].replace(/,/g, '')) : null, budget: match ? Number(match[2].replace(/,/g, '')) : null, expectedBudget };
}

// ---- Case 1: six reply signatures ---------------------------------------------------------------------------

const CASE1_LENGTHS = [12000, 14000, 16000, 17300, 18000, 22000];

async function case1Chat(account) {
    const signatures = CASE1_LENGTHS.map((length, index) => signature(100 + index, length));
    expect(sum(signatures.map(item => item.length))).toBe(99300);
    const { rows, total } = await fitRows(account, scale => Array.from({ length: 14 }, (_, index) => {
        const user = index % 2 === 0;
        const reply = (index - 1) / 2;
        return { is_user: user, mes: prose(200 + index, Math.round(5200 * scale)),
            ...(!user && reply < 6 ? { extra: { api: 'openrouter', model: CONNECTION, reasoning_signature: signatures[reply] } } : {}) };
    }), [16000, 18000]);
    return { rows, total, signatures };
}

test('case 1 chat with Mewmory off is sent', async ({ app }) => {
    const { account, net } = await startAccount(app);
    const { rows, total } = await case1Chat(account);
    const locator = await seedChat(account, 'Size case one off', rows);
    const page = await openChat(account, locator, { context: 128000, reply: 50000 });
    const result = await sendAndSettle(page, net);
    expect({ requests: result.writer().length, errors: await result.errors() }).toEqual({ requests: 1, errors: [] });
    await record('case1-mewmory-off', { visibleTokens: total, signatureCharacters: sum(CASE1_LENGTHS), promptMessages: result.writer()[0].messages.length });
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(1);
});

for (const phone of [false, true]) {
    test(`case 1 ${phone ? 'phone' : 'desktop'}: six reply signatures are not counted as text`, async ({ app }) => {
        const { account, net } = await startAccount(app, { phone });
        const { rows, total, signatures } = await case1Chat(account);
        const locator = await seedChat(account, 'Size case one', rows);
        await addMemory(app, account, locator);
        const page = await openChat(account, locator, { context: 128000, reply: 50000 });
        const result = await sendAndSettle(page, net);
        await screenshot(page, 'case1', phone);
        const errors = await result.errors();
        await record(`case1-${phone ? 'phone' : 'desktop'}`, { visibleTokens: total, requests: result.writer().length, errors, ...reportBase(errors, 78000) });
        expect({ requests: result.writer().length, errors }).toEqual({ requests: 1, errors: [] });
        const body = parts(result.writer()[0]);
        expect(body.signatures).toEqual(signatures);
        expect(body.text).toContain(SENTENCE);
        expect(net.status).toBeGreaterThan(0);
        expect(net.generate).toBe(1);
    });
}

// ---- Case 2: one inlined picture ----------------------------------------------------------------------------

test('case 2: an inlined picture is not counted as text', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 32000, reply: 2000, flags: { media_inlining: true } });
    const png = noisePng();
    const url = 'data:image/png;base64,' + png.toString('base64');
    const { rows, total } = await fitRows(account, scale => Array.from({ length: 8 }, (_, index) => ({
        is_user: index % 2 === 0, mes: prose(300 + index, Math.round(1300 * scale)),
        ...(index === 2 ? { extra: { media: [{ type: 'image', url }] } } : {}),
    })), [2000, 3000]);
    const locator = await seedChat(account, 'Size case two', rows);
    await addMemory(app, account, locator);
    const page = await openChat(account, locator, { context: 32000, reply: 2000, media: true });
    const result = await sendAndSettle(page, net);
    const errors = await result.errors();
    await record('case2', { pictureBytes: png.length, visibleTokens: total, requests: result.writer().length, errors, ...reportBase(errors, 30000) });
    expect({ requests: result.writer().length, errors }).toEqual({ requests: 1, errors: [] });
    const body = parts(result.writer()[0]);
    const pictures = body.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))
        .filter(part => part.type === 'image_url').map(part => part.image_url.url);
    expect(pictures).toEqual([url]);
    expect(body.text).toContain(SENTENCE);
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(1);
});

// ---- Case 3: JSON quoting and blank lines -------------------------------------------------------------------

async function case3Rows(account) {
    return fitRows(account, scale => Array.from({ length: 14 }, (_, index) => ({
        is_user: Math.floor(index / 2) % 2 === 0,
        mes: (index % 2 === 0 ? tracker : dialogue)(500 + index, Math.round(4200 * scale)),
    })), [19000, 21000]);
}

const setBudget = (page, context, reply) => page.evaluate(async ({ context, reply }) => {
    const { oai_settings } = await import('/scripts/openai.js');
    oai_settings.openai_max_context = context;
    oai_settings.openai_max_tokens = reply;
}, { context, reply });

const openStored = (page, chat) => page.evaluate(async chat => (await import('/script.js')).openCharacterChat(chat), chat);
const regenerate = page => page.evaluate(async () => { await (await import('/script.js')).Generate('regenerate'); });
const bodyCount = async (account, body) => sum((await account.post('/api/tokenizers/openai/count?model=gemma&per_message=1', body.messages.map(message => ({
    role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}) })))).token_counts);
const quoted = text => JSON.stringify(text.slice(0, 60)).slice(1, -1);

/** Sends case 3's chat with Mewmory off at a huge budget and returns the total of what went out, and B. */
async function case3Calibrate(account, net, rows) {
    const locator = await seedChat(account, 'Size case three calibration', rows);
    const page = await openChat(account, locator, { context: 300000, reply: 1000 });
    const first = await sendAndSettle(page, net);
    expect(first.writer()).toHaveLength(1);
    expect(await first.errors()).toEqual([]);
    const total = await bodyCount(account, first.writer()[0]);
    return { page, total, budget: Math.ceil(total * 1.03), first };
}

test('case 3 calibration: with Mewmory off the app sends everything at B less 100 and at T, and drops the oldest at 0.99 T', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 300000, reply: 1000 });
    const { rows, total: visible } = await case3Rows(account);
    const { page, total, budget } = await case3Calibrate(account, net, rows);
    const size = {};
    for (const [name, value] of [['full', budget - 100], ['exact', total], ['trimmed', Math.floor(total * 0.99)]]) {
        await setBudget(page, value + 1000, 1000);
        const before = net.generates.length;
        await regenerate(page);
        await expect.poll(() => net.generates.length).toBe(before + 1);
        size[name] = parts(net.generates.at(-1)).text;
    }
    await record('case3-calibration', { visibleTokens: visible, total, budget });
    for (const row of rows) expect(size.full).toContain(quoted(row.mes));
    for (const row of rows) expect(size.exact).toContain(quoted(row.mes));
    expect(size.trimmed).not.toContain(quoted(rows[0].mes));
    expect(size.trimmed).toContain(quoted(rows.at(-1).mes));
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(4);
});

test('case 3: quoting and blank lines in the prompt are not counted as extra text', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 300000, reply: 1000 });
    const { rows, total: visible } = await case3Rows(account);
    const { page, total, budget } = await case3Calibrate(account, net, rows);
    const locator = await seedChat(account, 'Size case three', rows);
    await addMemory(app, account, locator);
    await setBudget(page, budget + 1000, 1000);
    await openStored(page, locator.chat);
    const result = await sendAndSettle(page, net);
    const errors = await result.errors();
    const base = reportBase(errors, budget);
    await record('case3', { visibleTokens: visible, total, budget, requests: result.writer().length, errors, ...base, ratio: base.counted && base.counted / budget });
    expect({ requests: result.writer().length, errors }).toEqual({ requests: 1, errors: [] });
    const body = parts(result.writer()[0]);
    for (const row of rows) expect(body.text).toContain(quoted(row.mes));
    expect(body.text).toContain(SENTENCE);
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(2);
});

// ---- Case 7: tool-call signatures ---------------------------------------------------------------------------

const TOOL_SIGNATURES = [0, 1, 2, 3].map(index => signature(700 + index, 12000));

function case7Rows() {
    return [0, 1, 2, 3].flatMap(index => [
        { is_user: true, mes: prose(800 + index * 3, 240) },
        { is_user: false, mes: prose(801 + index * 3, 240) },
        { is_system: true, mes: `Tool call ${index}: lookup`, extra: { isSmallSys: true, api: 'openrouter', model: CONNECTION, tool_invocations: [{
            id: `call-${index}`, displayName: 'Lookup', name: 'lookup', parameters: JSON.stringify({ query: 'lantern key ' + index }),
            result: 'The lantern key hangs by the ferry gate.', signature: TOOL_SIGNATURES[index] }] } },
    ]);
}
const toolFlags = { function_calling: true, custom_prompt_post_processing: '' };
const expectToolOrder = messages => messages.forEach((message, index) => {
    if (!message.tool_calls?.length) return;
    expect(messages[index + 1]).toMatchObject({ role: 'tool', tool_call_id: message.tool_calls[0].id });
});

test('case 7 chat with Mewmory off keeps fewer tool groups before the fix than after', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 32000, reply: 2000, flags: toolFlags });
    const locator = await seedChat(account, 'Size case seven off', case7Rows());
    const page = await openChat(account, locator, { context: 32000, reply: 2000, tools: true });
    const result = await sendAndSettle(page, net);
    expect({ requests: result.writer().length, errors: await result.errors() }).toEqual({ requests: 1, errors: [] });
    const body = parts(result.writer()[0]);
    await record('case7-mewmory-off', { toolGroups: body.toolGroups, signatures: body.signatures.length });
    // Before the fix the signatures are priced, so the oldest group no longer fits; after it all four do.
    expect(body.toolGroups).toBeGreaterThanOrEqual(ROLE === 'base' ? 1 : 4);
    expect(body.toolGroups).toBeLessThanOrEqual(ROLE === 'base' ? 3 : 4);
    expectToolOrder(body.messages);
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(1);
});

test('case 7: tool-call signatures are not counted as text', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 32000, reply: 2000, flags: toolFlags });
    const locator = await seedChat(account, 'Size case seven', case7Rows());
    await addMemory(app, account, locator);
    const page = await openChat(account, locator, { context: 32000, reply: 2000, tools: true });
    const result = await sendAndSettle(page, net);
    const errors = await result.errors();
    await record('case7', { requests: result.writer().length, errors });
    expect({ requests: result.writer().length, errors }).toEqual({ requests: 1, errors: [] });
    const body = parts(result.writer()[0]);
    expect(body.toolGroups).toBe(4);
    expect(body.messages.filter(message => message.tool_calls?.length).map(message => message.tool_calls[0].signature)).toEqual(TOOL_SIGNATURES);
    expectToolOrder(body.messages);
    expect(body.text).toContain(SENTENCE);
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(1);
});

// ---- L1: a genuine limit -------------------------------------------------------------------------------------

test('L1: a chat that really does not fit still gets the history refusal and never the recount text', async ({ app }) => {
    const { account, net } = await startAccount(app, { context: 14000, reply: 2000 });
    const { rows } = await case1Chat(account);
    const locator = await seedChat(account, 'Size limit one', rows);
    await addMemory(app, account, locator);
    const page = await openChat(account, locator, { context: 14000, reply: 2000 });
    const result = await sendAndSettle(page, net);
    const errors = await result.errors();
    await record('L1', { requests: result.writer().length, errors });
    expect(result.writer()).toHaveLength(0);
    expect(errors).toEqual([HISTORY_REFUSAL]);
    expect(errors.join('\n')).not.toMatch(/Mewmory counted/);
    expect(net.status).toBeGreaterThan(0);
    expect(net.generate).toBe(0);
});

// ---- T1: Text Completion --------------------------------------------------------------------------------------

/** About 12,000 llama tokens of history in 14 messages. */
async function fitLlama(account) {
    const llama = async text => (await account.post('/api/tokenizers/llama/encode', { text })).count;
    let scale = 1;
    for (let attempt = 0; attempt < 5; attempt++) {
        const rows = Array.from({ length: 14 }, (_, index) => ({ is_user: index % 2 === 0, mes: prose(900 + index, Math.round(3560 * scale)) }));
        const total = sum(await Promise.all(rows.map(row => llama(row.mes))));
        if (total >= 11500 && total <= 12500) return { rows, total };
        scale *= 12000 / total;
    }
    throw new Error('The seeded text could not be sized to about 12,000 llama tokens.');
}

test('T1: a Text Completion prompt too long by the app\'s own count is refused', async ({ app }) => {
    const account = await app.account({ textProfile: true, activeConnection: true, configureSettings: saved => {
        connection({}, {})(saved);
        saved.main_api = 'textgenerationwebui';
        saved.power_user.tokenizer = 3;
    } });
    const net = current = await guardNetwork(account.context, app);
    const { rows, total } = await fitLlama(account);
    const locator = await seedChat(account, 'Size text limit', rows);
    await addMemory(app, account, locator);
    const page = await account.open({ workspace: false });
    const generates = [];
    page.on('request', request => { if (/\/api\/backends\/(text-completions|kobold)\/generate/.test(request.url())) generates.push(request.url()); });
    await page.evaluate(async ({ avatar, chat }) => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        await core.openCharacterChat(chat);
    }, { avatar: locator.avatar, chat: locator.chat });
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).online_status), { timeout: 30000 }).not.toBe('no_connection');
    const rejection = await page.evaluate(async text => {
        window.document.getElementById('send_textarea').value = text;
        try { await (await import('/script.js')).Generate('normal'); return null; } catch (error) { return error?.message ?? String(error); }
    }, QUESTION);
    await record('T1', { llamaTokens: total, rejection, generates });
    expect(generates).toEqual([]);
    expect(rejection).toBe(TEXT_LIMIT);
    expect(net.foreign).toEqual([]);
});
