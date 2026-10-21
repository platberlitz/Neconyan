/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-conditional-in-test -- Phone setup and accent variants share the same user-visible checks. */
/* eslint-disable playwright/no-standalone-expect -- Shared setup helpers verify saved settings and accepted requests. */
import { expect } from '@playwright/test';
import { test } from './neconyan-scratchpad-search-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        return context.wireSource(context.currentSource());
    });
}

async function configureSearch(page, url) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
    await page.locator('#scratchpad-web-search-provider').selectOption('searxng');
    await page.locator('#scratchpad-web-search-searxng').fill(url);
    const saving = page.waitForResponse('**/api/scratchpad/web-search/update');
    await page.locator('#scratchpad-web-search-save').click();
    const response = await saving;
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('.scratchpad-web-status')).toContainText('Ready.');
}

async function send(page, text) {
    await page.locator('.scratchpad-composer').fill(text);
    const accepted = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const response = await accepted;
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
}

async function checkAccents(page, phone) {
    const measurements = [];
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        await page.locator('#themes').selectOption({ label: theme }, { force: true });
        if (phone) await applyIOSOnlyCss(page);
        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
            for (const enabled of [true, false]) {
                await expect(page.locator('.scratchpad-web-toggle')).toHaveAttribute('aria-pressed', String(enabled));
                const measured = await page.locator('.scratchpad-web-toggle').evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const canvas = document.createElement('canvas').getContext('2d');
                    const channels = colour => {
                        canvas.clearRect(0, 0, 1, 1);
                        canvas.fillStyle = colour;
                        canvas.fillRect(0, 0, 1, 1);
                        return [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3);
                    };
                    const style = getComputedStyle(element);
                    const label = getComputedStyle(element.querySelector('span'));
                    const rect = element.getBoundingClientRect();
                    return { contrast: contrastRatio(channels(label.color), channels(style.backgroundColor)), height: rect.height, width: rect.width,
                        foreground: label.color, background: style.backgroundColor, pageWidth: document.documentElement.scrollWidth };
                });
                measurements.push({ theme, accent, enabled, ...measured });
                expect(measured.contrast, JSON.stringify(measurements)).toBeGreaterThanOrEqual(4.5);
                expect(measured.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
                expect(measured.width).toBeGreaterThanOrEqual(44);
                expect(measured.pageWidth).toBe(phone ? 393 : 1280);
                await page.locator('.scratchpad-web-toggle').click();
            }
        }
    }
    await test.info().attach('web-toggle-contrast', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} configures web search, keeps the draft and shows persistent safe sources`, async ({ app, search }) => {
        test.setTimeout(240000);
        const size = phone ? 'phone' : 'desktop';
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        let page = await account.open();
        const source = await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        const question = 'Find sources about the first public libraries.';
        await page.locator('.scratchpad-composer').fill(question);
        await expect(page.locator('.scratchpad-web-toggle')).toHaveAttribute('aria-pressed', 'false');
        await page.locator('.scratchpad-web-toggle').click();
        await expect(page.locator('#scratchpad-web-search-provider')).toBeVisible();
        await page.locator('#scratchpad-web-search-provider').selectOption('brave');
        await expect(page.locator('#scratchpad-web-search-settings .manage-api-keys[data-key="api_key_brave_search"]')).toBeVisible();
        await page.locator('#scratchpad-web-search-provider').selectOption('nanogpt');
        await expect(page.locator('#scratchpad-web-search-settings .manage-api-keys[data-key="api_key_nanogpt"]')).toBeVisible();
        await page.locator('#scratchpad-web-search-provider').selectOption('custom');
        await expect(page.locator('#scratchpad-web-search-custom')).toBeVisible();
        await expect(page.locator('#scratchpad-web-search-settings .manage-api-keys[data-key="api_key_custom_search"]')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.evaluate(() => window.toastr?.remove());
        await page.locator('#scratchpad-web-search-settings').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-web-search-custom-${size}-after.png`, scale: 'css' });
        await configureSearch(page, search.url);
        expect((await account.post('/api/scratchpad/web-search', {})).webSearch).toMatchObject({ provider: 'searxng', searxngUrl: search.url, results: 5 });
        await page.evaluate(() => window.toastr?.remove());
        await page.locator('#scratchpad-web-search-settings').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-web-search-settings-${size}-after.png`, scale: 'css' });
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(page.locator('.scratchpad-composer')).toHaveValue(question);
        await page.locator('.scratchpad-web-toggle').click();
        await expect(page.locator('.scratchpad-web-toggle')).toHaveAttribute('aria-pressed', 'true');
        await page.evaluate(() => window.toastr?.remove());
        await page.screenshot({ path: `../screenshots/scratchpad-web-search-${size}-after.png`, scale: 'css' });

        search.mode.hold = true;
        app.provider.mode.reply = { choices: [{ message: { content: 'The library archive describes early public libraries. [1] A second archive supplies more records. [2]' } }] };
        const accepted = await send(page, question);
        await expect.poll(() => search.calls.length).toBe(1);
        await expect(page.locator('.scratchpad-stage')).toContainText('Searching the web');
        expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === question)).toHaveLength(0);
        expect(search.calls[0]).toMatchObject({ method: 'GET', path: '/search-services/search', query: question, format: 'json' });
        search.release();
        await account.settled(accepted.job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
        expect(calls).toHaveLength(1);
        expect(JSON.stringify(calls[0].messages)).toContain('{{random::red::blue}}');
        expect(JSON.stringify(calls[0].messages)).toContain('https://example.org/library-history');
        await expect(page.locator('.scratchpad-web-sources summary')).toHaveText('Sources (2)');
        await page.locator('.scratchpad-web-sources summary').click();
        await expect(page.locator('.scratchpad-web-query')).toContainText(question);
        const links = page.locator('.scratchpad-web-source-list a');
        await expect(links).toHaveCount(2);
        await expect(links.first()).toHaveAttribute('href', 'https://example.org/library-history');
        await expect(links.first()).toHaveAttribute('target', '_blank');
        await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(links.first()).toHaveAttribute('referrerpolicy', 'no-referrer');
        await page.locator('.scratchpad-web-source-list li').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `../screenshots/scratchpad-web-search-sources-${size}-after.png`, scale: 'css' });
        const saved = (await account.post('/api/scratchpad/bucket', { source })).bucket.sessions[0];
        const metadata = saved.messages.find(message => message.webSearch)?.webSearch;
        expect(metadata).toMatchObject({ provider: 'searxng', query: question });
        expect(metadata.sources).toHaveLength(2);
        expect(JSON.stringify(metadata)).not.toContain('Literal text');

        await page.close();
        page = await account.open();
        await openScratchpad(page);
        if (phone) await applyIOSOnlyCss(page);
        await expect(page.locator('.scratchpad-web-toggle')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.scratchpad-web-sources summary')).toHaveText('Sources (2)');
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(page.locator('#scratchpad-web-search-provider')).toHaveValue('searxng');
        await expect(page.locator('#scratchpad-web-search-searxng')).toHaveValue(search.url);
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await checkAccents(page, phone);
    });
}

test('search failures still deliver a reply and Stop cancels a held search before the model starts', async ({ app, search }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await configureSearch(page, search.url);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-web-toggle').click();
    search.mode.status = 503;
    app.provider.mode.reply = { choices: [{ message: { content: 'Web search was unavailable. I can still discuss the question.' } }] };
    const failed = await send(page, 'Explain public libraries even if search is unavailable.');
    await account.settled(failed.job.id);
    await expect(page.locator('.scratchpad-web-error')).toContainText('Web search failed:');
    await expect(page.locator('.scratchpad-reply').last()).toContainText('I can still discuss the question.');

    search.mode.status = 200;
    search.mode.hold = true;
    const question = 'Stop this search before answering.';
    const stopped = await send(page, question);
    await expect.poll(() => search.calls.length).toBe(2);
    await expect(page.locator('.scratchpad-stage')).toContainText('Searching the web');
    await page.locator('.scratchpad-send').click();
    await account.settled(stopped.job.id, 'cancelled');
    await expect.poll(() => search.calls[1].aborted).toBe(true);
    search.release();
    expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === question)).toHaveLength(0);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
});

test('a round table searches once and gives every assistant the same sources', async ({ app, search }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await configureSearch(page, search.url);
    for (const assistant of ['taro', 'nori']) await page.locator(`#scratchpad-connection-${assistant}`).selectOption('durable');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-web-toggle').click();
    await page.locator('.scratchpad-round-table').click();
    await expect(page.locator('.scratchpad-send')).toHaveAccessibleName('Ask 3');
    app.provider.mode.reply = { choices: [{ message: { content: 'The first source provides the library history. [1]' } }] };
    const question = 'Find public library histories for all three assistants.';
    const accepted = await send(page, question);
    await account.settled(accepted.job.id);
    await expect(page.locator('.scratchpad-message.is-done')).toHaveCount(3);
    await expect(page.locator('.scratchpad-web-sources')).toHaveCount(3);
    expect(search.calls).toHaveLength(1);
    const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(JSON.stringify(call.messages)).toContain('https://example.org/library-history');
});

test('server errors, invalid JSON and a stalled response body still allow the model to answer', async ({ app, search }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await configureSearch(page, search.url);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-web-toggle').click();
    app.provider.mode.reply = { choices: [{ message: { content: 'I could not search the web, but I can still answer your question.' } }] };
    for (const [fault, mode] of [
        ['server error', { status: 500, malformed: false, stallBody: false }],
        ['invalid JSON', { status: 200, malformed: true, stallBody: false }],
        ['stalled body', { status: 200, malformed: false, stallBody: true }],
    ]) {
        Object.assign(search.mode, mode);
        const question = `Answer despite the search ${fault}.`;
        const accepted = await send(page, question);
        await account.settled(accepted.job.id);
        await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);
        await expect(page.locator('.scratchpad-reply').last()).toContainText('I can still answer your question.');
        await expect(page.locator('.scratchpad-web-error').last()).toContainText('Web search failed:');
        expect(app.provider.calls.filter(call => call.messages?.at(-1)?.content === question)).toHaveLength(1);
    }
    await expect(page.locator('.scratchpad-web-error').last()).toContainText('timed out');
    expect(search.calls).toHaveLength(3);
});

test('failed saves and background refreshes preserve the web search form draft', async ({ app, search }) => {
    test.setTimeout(120000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-web-search-provider').selectOption('searxng');
    await page.locator('#scratchpad-web-search-searxng').fill(search.url);
    await page.locator('#scratchpad-web-search-results').selectOption('7');
    await page.route('**/api/scratchpad/web-search/update', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture save unavailable.' }) }), { times: 1 });
    const failed = page.waitForResponse('**/api/scratchpad/web-search/update');
    await page.locator('#scratchpad-web-search-save').click();
    expect((await failed).status()).toBe(503);
    await expect(page.locator('#scratchpad-web-search-save')).toBeEnabled();
    await expect(page.locator('#scratchpad-web-search-provider')).toHaveValue('searxng');
    await expect(page.locator('#scratchpad-web-search-searxng')).toHaveValue(search.url);
    await expect(page.locator('#scratchpad-web-search-results')).toHaveValue('7');
    const refreshed = page.waitForResponse('**/api/scratchpad/web-search');
    await page.locator('#scratchpad-web-search-refresh').click();
    await refreshed;
    await expect(page.locator('#scratchpad-web-search-provider')).toHaveValue('searxng');
    await expect(page.locator('#scratchpad-web-search-searxng')).toHaveValue(search.url);
    await expect(page.locator('#scratchpad-web-search-results')).toHaveValue('7');
    const saving = page.waitForResponse('**/api/scratchpad/web-search/update');
    await page.locator('#scratchpad-web-search-save').click();
    expect((await saving).ok()).toBe(true);
    await expect(page.locator('.scratchpad-web-status')).toContainText('Ready.');
    expect((await account.post('/api/scratchpad/web-search', {})).webSearch).toMatchObject({ provider: 'searxng', searxngUrl: search.url, results: 7 });
});

async function addKey(page, key, label, value) {
    await page.locator(`#scratchpad-web-search-settings .manage-api-keys[data-key="${key}"]`).click();
    const manager = page.locator('dialog[open]').filter({ has: page.locator('.secretKeyManager') });
    await expect(manager.locator('.secretKeyManagerInfo')).toContainText(label);
    await manager.locator('[data-action="add-secret"]').click();
    const entry = page.locator('dialog[open]').last();
    await entry.locator('.popup-input').fill(value);
    await entry.locator('#newSecretLabel').fill(`Scratchpad ${label} fixture`);
    await entry.locator('.popup-button-ok').click();
    await expect(manager.locator('.secretKeyManagerList')).toContainText(`Scratchpad ${label} fixture`);
    await manager.locator('.popup-button-ok').click();
}

test('a custom address searches the chosen service and sends its key in the chosen header', async ({ app, search }) => {
    test.setTimeout(150000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
    await page.locator('#scratchpad-web-search-provider').selectOption('custom');
    await expect(page.locator('#scratchpad-web-search-searxng')).toBeHidden();
    await page.locator('#scratchpad-web-search-custom').fill(`${search.url}/custom?q={query}&n={count}`);
    await page.locator('#scratchpad-web-search-custom-header').fill('X-Fixture-Key');
    const dummyKey = 'scratchpad-browser-fixture-custom-not-a-real-key';
    await addKey(page, 'api_key_custom_search', 'Custom web search', dummyKey);
    await expect(page.locator('#scratchpad-web-search-custom')).toHaveValue(`${search.url}/custom?q={query}&n={count}`);
    const saving = page.waitForResponse('**/api/scratchpad/web-search/update');
    await page.locator('#scratchpad-web-search-save').click();
    const response = await saving;
    expect(response.ok(), await response.text()).toBe(true);
    expect(JSON.stringify(await response.json())).not.toContain(dummyKey);
    await expect(page.locator('.scratchpad-web-status')).toContainText('Ready.');
    expect((await account.post('/api/scratchpad/web-search', {})).webSearch).toMatchObject({
        provider: 'custom', customUrl: `${search.url}/custom?q={query}&n={count}`, customHeader: 'X-Fixture-Key', results: 5,
    });

    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-web-toggle').click();
    app.provider.mode.reply = { choices: [{ message: { content: 'The library archive describes early public libraries. [1]' } }] };
    const question = 'Find public library history through the custom service.';
    const accepted = await send(page, question);
    await account.settled(accepted.job.id);
    expect(search.calls.at(-1)).toMatchObject({ method: 'GET', path: '/search-services/custom', query: question, count: '5', key: dummyKey });
    await expect(page.locator('.scratchpad-web-sources summary')).toHaveText('Sources (2)');
    const calls = app.provider.calls.filter(call => call.messages?.at(-1)?.content === question);
    expect(JSON.stringify(calls[0].messages)).toContain('https://example.org/library-history');
});

test('Brave, NanoGPT, Exa and Tavily keys can be added through Scratchpad and saved without exposing their values', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account();
    const page = await account.open();
    await openScratchpad(page);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    const providers = [['brave', 'api_key_brave_search', 'Brave Search'], ['nanogpt', 'api_key_nanogpt', 'NanoGPT'], ['exa', 'api_key_exa', 'Exa'], ['tavily', 'api_key_tavily', 'Tavily']];
    for (const [provider, key, label] of providers) {
        await page.locator('#scratchpad-web-search-provider').selectOption(provider);
        const dummyKey = `scratchpad-browser-fixture-${provider}-not-a-real-key`;
        await addKey(page, key, label, dummyKey);
        await expect(page.locator('#scratchpad-web-search-provider')).toHaveValue(provider);
        const saving = page.waitForResponse('**/api/scratchpad/web-search/update');
        await page.locator('#scratchpad-web-search-save').click();
        const response = await saving;
        expect(response.ok(), await response.text()).toBe(true);
        const saved = await response.json();
        expect(saved.webSearch.provider).toBe(provider);
        expect(saved.readiness).toMatchObject({ provider, configured: true });
        expect(JSON.stringify(saved)).not.toContain(dummyKey);
        await expect(page.locator('.scratchpad-web-status')).toContainText('Ready.');
    }
    expect(app.provider.calls).toHaveLength(0);
});
