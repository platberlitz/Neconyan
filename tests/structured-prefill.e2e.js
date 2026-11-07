/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-conditional-in-test -- Exercise the same contract across reply locations and viewports. */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';
import { compileStructuredPrefill } from '../public/scripts/structured-prefill.js';
import { decodePrefillStream } from '../src/structured-prefill.js';

test.setTimeout(180000);
const screenshots = process.env.NECONYAN_PREFILL_SCREENSHOTS;
const prefix = 'Private starter. ';
const prose = 'Nova opens the window. The rain has stopped.';

async function openControls(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'advanced-formatting'));
    const later = page.getByRole('button', { name: 'Not now', exact: true });
    if (await later.isVisible()) await later.click();
    const header = page.locator('#sb-af-prefill > .inline-drawer-header');
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
    await expect(page.locator('#structured-prefill-settings')).toBeVisible();
}

async function capture(page, filename) {
    const dismiss = page.locator('#neconyan-crash-notice [data-crash-action="dismiss"]');
    if (await dismiss.isVisible()) await dismiss.click();
    await settleCssTransitions(page);
    await page.screenshot({ path: path.join(screenshots, filename) });
}

for (const [location, stream, phone] of [['browser', false, false], ['browser', true, true], ['server', false, true]]) {
    test(`${location} ${stream ? 'streamed' : 'buffered'} prefill keeps full history and hides only its saved prefix`, async ({ app }, info) => {
        let sent;
        const account = await app.account({ phone, activeConnection: true, configureSettings: saved => {
            saved.power_user.reply_generation_location = location;
            saved.power_user.user_prompt_bias = prefix;
            saved.power_user.structured_prefill = { enabled: true, min_chars_after_prefix: 0 };
            saved.oai_settings.stream_openai = stream;
        } });
        account.context.on('page', page => page.on('pageerror', error => info.attach('page-error', { body: error.stack, contentType: 'text/plain' })));
        const encoded = JSON.stringify({ response: prefix + prose });
        app.provider.mode.reply = body => {
            sent = body;
            return { choices: [{ message: { content: encoded }, finish_reason: 'stop' }] };
        };
        if (stream) app.provider.mode.streamReply = body => {
            sent = body;
            return { first: encoded.slice(0, -2), rest: '"}' };
        };
        const page = await account.open({ workspace: false });
        page.setDefaultTimeout(15000);
        if (screenshots && location === 'browser') {
            const beforeHtml = execFileSync('git', ['show', 'origin/staging:public/index.html'], { encoding: 'utf8' });
            await page.route(app.url + '/', route => route.fulfill({ contentType: 'text/html', body: beforeHtml }));
            await page.reload();
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
            await openControls(page);
            await page.locator('#sb-af-prefill').scrollIntoViewIfNeeded();
            await capture(page, `prefill-${phone ? 'phone' : 'desktop'}-before.png`);
            await page.unroute(app.url + '/');
            await page.reload();
            await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        }
        await openControls(page);
        const controls = page.locator('#structured-prefill-settings');
        await expect(controls.locator('[data-sp="enabled"]')).toBeChecked();
        await controls.locator('[data-sp="output_method"]').selectOption('instructions');
        await expect(controls.locator('[data-sp="output_method"]')).toHaveValue('instructions');
        await controls.locator('[data-sp="output_method"]').selectOption('schema');
        await controls.locator('[data-sp="override_prefill_enabled"]').check();
        await controls.locator('[data-sp="override_prefill_text"]').fill(prefix + '[[keep]]');
        if (screenshots && location === 'browser') {
            await page.locator('#sb-af-prefill').evaluate(element => element.scrollIntoView({ block: 'start' }));
            await capture(page, `prefill-${phone ? 'phone' : 'desktop'}-after.png`);
        }
        const bounds = await page.locator('#sb-af-prefill').evaluate(card => {
            const outer = card.getBoundingClientRect();
            const text = card.querySelector('#structured-prefill-settings > div > p.description').getBoundingClientRect();
            return { width: outer.width, overflow: card.scrollWidth - card.clientWidth, leftInset: text.left - outer.left, rightInset: outer.right - text.right };
        });
        expect(bounds.width).toBeGreaterThan(200);
        expect(bounds.overflow).toBeLessThanOrEqual(2);
        expect(bounds.leftInset).toBeGreaterThanOrEqual(12);
        expect(bounds.rightInset).toBeGreaterThanOrEqual(12);
        await controls.getByText('Prefill presets', { exact: true }).click();
        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
            await settleCssTransitions(page);
            const measurement = await controls.locator('[data-sp-action="save"]').evaluate(async element => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                const canvas = document.createElement('canvas').getContext('2d');
                const rgb = colour => {
                    canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = colour; canvas.fillRect(0, 0, 1, 1);
                    return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                const style = getComputedStyle(element);
                return { contrast: contrastRatio(rgb(style.color), rgb(style.backgroundColor)), height: element.getBoundingClientRect().height };
            });
            expect(measurement.contrast, String(accent)).toBeGreaterThanOrEqual(4.5);
            expect(measurement.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        }
        await controls.locator('[data-sp-name]').fill('My starter');
        await controls.locator('[data-sp-action="save"]').click();
        await controls.locator('[data-sp="override_prefill_text"]').fill('Changed');
        await controls.locator('[data-sp-presets]').selectOption('');
        await controls.locator('[data-sp-presets]').selectOption('My starter');
        await expect(controls.locator('[data-sp="override_prefill_text"]')).toHaveValue(prefix + '[[keep]]');
        const commandResult = await page.evaluate(async () => {
            const { executeSlashCommandsWithOptions } = await import('/scripts/slash-commands.js');
            const selected = await executeSlashCommandsWithOptions('/sp-preset My starter');
            const listed = await executeSlashCommandsWithOptions('/sp-preset-list');
            return { selected: selected.pipe, listed: JSON.parse(listed.pipe) };
        });
        expect(commandResult).toEqual({ selected: 'My starter', listed: ['My starter'] });
        await controls.locator('[data-sp-import]').setInputFiles({ name: 'upstream.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: 'Imported', min_chars_after_prefix: 12 })) });
        await expect(controls.locator('[data-sp-presets] option[value="Imported"]')).toHaveCount(1);
        await page.evaluate(async avatar => {
            window.NeconyanShell.closeWorkspace();
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await acknowledgeActiveSettings(page);
        await page.locator('#send_textarea').fill('Open the window.');
        await page.locator('#send_but').click();
        if (stream) {
            await expect.poll(() => Boolean(app.provider.mode.finishStream)).toBe(true);
            // Text appears before the JSON envelope closes.
            await expect(page.locator('#chat .mes').last().locator('.mes_text')).toContainText(prose);
            app.provider.mode.finishStream();
        }
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(prose, { timeout: 60000 });
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).chat.at(-1)?.mes)).toBe(prefix + prose);
        expect(sent.response_format.json_schema.schema.properties.response.pattern).toContain('Private starter');
        expect(sent.messages.some(item => item.role === 'assistant' && item.content === prefix)).toBe(false);
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).chat.at(-1)?.extra?.structured_prefill?.hidden_prefix)).toBe(prefix);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.structured_prefill.enabled = false;
            power_user.structured_prefill.hide_prefill_in_display = false;
            await (await import('/script.js')).saveSettings(0);
        });
        await page.reload();
        await expect(page.locator('body')).toHaveClass(/neconyan-rail-ready/, { timeout: 60000 });
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText(prose, { timeout: 30000 });
        await page.close();
    });
}

test('the browser reads native Claude, Gemini, Cohere and Responses streams with reasoning intact', async ({ app }) => {
    const account = await app.account();
    const page = await account.open({ workspace: false });
    const encoded = JSON.stringify({ response: prefix + prose });
    const replies = {
        claude: [{ type: 'content_block_delta', delta: { thinking: 'Thinking' } }, { type: 'content_block_delta', delta: { text: encoded } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
        makersuite: [{ candidates: [{ content: { parts: [{ thought: true, text: 'Thinking' }, { text: encoded }] }, finishReason: 'STOP' }] }],
        cohere: [{ type: 'content-delta', delta: { message: { tool_plan: 'Thinking' } } }, { type: 'content-delta', delta: { message: { content: { text: encoded } } } },
            { type: 'message-end', delta: { finish_reason: 'COMPLETE' } }],
        openai_responses: [{ type: 'response.reasoning_summary_text.delta', delta: 'Thinking' }, { type: 'response.output_text.delta', delta: encoded },
            { type: 'response.completed', response: { status: 'completed' } }],
    };
    for (const [source, events] of Object.entries(replies)) {
        let sse = '';
        const upstream = Readable.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`));
        for await (const chunk of decodePrefillStream(upstream, compileStructuredPrefill(prefix, { min_chars_after_prefix: 0 }))) sse += chunk;
        const result = await page.evaluate(async ({ source, sse }) => {
            const { readChatCompletionStream } = await import('/scripts/openai.js');
            let last;
            for await (const frame of readChatCompletionStream(new window.Response(sse), { chatCompletionSource: source, overrideShowThoughts: true })()) last = frame;
            return { text: last.text, reasoning: last.state.reasoning, metadata: last.state.structuredPrefill, outcome: last.state.outcome };
        }, { source, sse });
        expect(result.text, source).toBe(prefix + prose);
        expect(result.reasoning, source).toBe('Thinking');
        expect(result.metadata.hidden_prefix, source).toBe(prefix);
        expect(result.outcome, source).toBeNull();
    }
    await page.close();
});
