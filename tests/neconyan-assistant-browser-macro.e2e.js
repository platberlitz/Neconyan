/* global window */
import { expect } from '@playwright/test';
import { test, send } from './neconyan-conversation-durable-fixture.js';

test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable server.');
test.setTimeout(180000);

const DRAFT = Object.freeze({
    name: 'fixtureGreeting',
    template: '{{upper::quiet}} {{reverse::abc}}',
    description: 'Deterministic browser macro for the fixture.',
    args: [],
});
const PREVIEW = 'QUIET cba';
const SAVED_REPLY = 'The fixture browser macro is saved.';
const DECLINED_REPLY = 'The fixture browser macro was not saved.';

function toolReply() {
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: 'save-browser-macro', type: 'function', function: {
            name: 'Neconyan_Assistant_SaveBrowserMacro',
            arguments: JSON.stringify({ ...DRAFT, userConfirmed: true }),
        },
    }] }, finish_reason: 'tool_calls' }] };
}

function providerFor(app, finalReply) {
    app.provider.mode.reply = body => body.messages.some(message => message.role === 'tool')
        ? { choices: [{ message: { role: 'assistant', content: finalReply } }] }
        : toolReply();
}

async function assistantAccount(app) {
    const account = await app.account({ configureSettings: settings => {
        settings.power_user.experimental_macro_engine = true;
        settings.extension_settings.disabledExtensions = (settings.extension_settings.disabledExtensions ?? [])
            .filter(name => !String(name).includes('MacroEnhanced'));
    } });
    await account.post('/api/characters/merge-attributes', { avatars: [account.avatar], data: {
        data: { extensions: { neconyan_assistant: { id: 'miso-male', version: 1 } } },
    } });
    return account;
}

async function openAssistant(account, options = {}) {
    const page = await account.open(options);
    await expect.poll(() => page.evaluate(() => Boolean(window.SillyTavern?.getContext()?.macros?.registry?.hasMacro?.('me-listpick'))),
        { timeout: 30000, message: 'Macro Enhanced registers its browser macros' }).toBe(true);
    return page;
}

function reviewPopup(page) {
    return page.locator('dialog.popup[open]').filter({ has: page.locator('.neconyan-assistant-review') });
}

async function expectExactReview(review) {
    await expect(review).toContainText('Allow browser macro edit?');
    await expect(review).toContainText(`Target: ${DRAFT.name}`);
    await expect(review).toContainText('Field: Definition');
    const values = review.locator('pre');
    await expect(values).toHaveCount(3);
    await expect(values.nth(0)).toHaveText('(new macro)');
    expect(JSON.parse(await values.nth(1).textContent())).toEqual({ ...DRAFT, enabled: true });
    await expect(values.nth(2)).toHaveText(PREVIEW);
}

async function awaitReview(page, account, rootId) {
    const review = reviewPopup(page);
    try {
        await expect(review).toBeVisible({ timeout: 60000 });
    } catch (error) {
        const jobs = await allJobs(account, rootId);
        throw new Error('The browser macro review never opened: ' + JSON.stringify(jobs.map(({ id, type, state, stage, error: jobError }) => ({
            id, type, state, stage, error: jobError,
        }))), { cause: error });
    }
    return review;
}

async function allJobs(account, rootId) {
    const jobs = [await account.job(rootId)];
    const seen = new Set();
    for (const job of jobs) {
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        for (const id of job.children ?? []) {
            if (!seen.has(id)) jobs.push(await account.job(id));
        }
    }
    return jobs;
}

async function findToolJob(account, rootId) {
    let found = null;
    await expect.poll(async () => {
        const tool = (await allJobs(account, rootId)).find(job => job.type === 'media.assistant-tool');
        if (!tool) return null;
        found = tool;
        return tool.state + ':' + tool.stage;
    }, { timeout: 60000, message: 'The browser macro tool reaches native approval' }).toBe('waiting:approval');
    return found;
}

async function readToolJob(account, rootId) {
    const tool = (await allJobs(account, rootId)).find(job => job.type === 'media.assistant-tool');
    if (!tool) throw new Error('The browser macro tool job is missing.');
    return tool;
}

async function readApproval(account, job) {
    const response = await account.context.request.get(`/api/jobs/${job.id}/approval/${job.result.approval.id}`, {
        headers: account.headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
}

async function storedMacros(page) {
    return page.evaluate(async () => {
        const { getBrowserDefs } = await import('/scripts/extensions/third-party/MacroEnhanced/src/custom/browser-store.js');
        return getBrowserDefs();
    });
}

async function assertBrowserOnly(account) {
    const settings = JSON.parse((await account.post('/api/settings/get')).settings);
    expect(settings.extension_settings.MacroEnhanced?.customMacros ?? []).toEqual([]);
    expect(JSON.stringify(settings)).not.toContain(DRAFT.template);
}

async function assertFinalReplyOnce(account, reply) {
    const branch = await account.branch();
    expect(branch.messages.filter(message => message.mes === reply)).toHaveLength(1);
}

test('assistant browser macro waits for native approval, survives reload and saves only in this browser', async ({ app }, info) => {
    providerFor(app, SAVED_REPLY);
    const account = await assistantAccount(app);
    const page = await openAssistant(account);
    const accepted = await send(page, 'Yes, save the fixture greeting macro now.');
    const review = await awaitReview(page, account, accepted.job.id);
    await expectExactReview(review);
    const pending = await findToolJob(account, accepted.job.id);
    const approval = await readApproval(account, pending);
    expect(approval.decision).toBe(null);
    expect(approval.proposal).toMatchObject({
        kind: 'neconyan-browser-macro',
        tool: 'Neconyan_Assistant_SaveBrowserMacro',
        arguments: { ...DRAFT, userConfirmed: true },
        resource: { kind: 'browser-macro', id: DRAFT.name },
    });
    await page.screenshot({ path: info.outputPath('browser-macro-review.png') });

    await page.close();
    const reopened = await openAssistant(account, { workspace: false });
    const recovered = reviewPopup(reopened);
    await expect(recovered).toBeVisible({ timeout: 30000 });
    await expectExactReview(recovered);
    await reopened.screenshot({ path: info.outputPath('browser-macro-review-reopened.png') });
    await recovered.locator('.popup-button-ok').click();
    await account.settled(accepted.job.id);

    const stored = await storedMacros(reopened);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ...DRAFT, enabled: true, authoringProposalId: expect.any(String) });
    await expect.poll(() => reopened.evaluate(name => window.SillyTavern.getContext().substituteParams(`{{${name}}}`), DRAFT.name))
        .toBe(PREVIEW);
    const finished = await readToolJob(account, accepted.job.id);
    expect(finished.result?.result).toMatchObject({
        tool: 'Neconyan_Assistant_SaveBrowserMacro',
        callId: 'save-browser-macro',
        result: { status: 'success', committed: true, name: DRAFT.name, scope: 'browser' },
    });
    await assertFinalReplyOnce(account, SAVED_REPLY);
    await assertBrowserOnly(account);
    expect(app.provider.calls).toHaveLength(2);
});

test('declining the browser macro review never saves the macro and still finishes the reply', async ({ app }) => {
    providerFor(app, DECLINED_REPLY);
    const account = await assistantAccount(app);
    const page = await openAssistant(account);
    const accepted = await send(page, 'Save the fixture greeting macro, but I will decline its review.');
    const review = await awaitReview(page, account, accepted.job.id);
    await expectExactReview(review);
    await review.locator('.popup-button-cancel').click();
    await account.settled(accepted.job.id);

    expect(await storedMacros(page)).toEqual([]);
    expect(await page.evaluate(name => window.SillyTavern.getContext().macros.registry.hasMacro(name), DRAFT.name)).toBe(false);
    const finished = await readToolJob(account, accepted.job.id);
    expect(finished.result?.result).toMatchObject({
        tool: 'Neconyan_Assistant_SaveBrowserMacro',
        callId: 'save-browser-macro',
        result: { status: 'denied', committed: false },
    });
    await assertFinalReplyOnce(account, DECLINED_REPLY);
    await assertBrowserOnly(account);
    expect(app.provider.calls).toHaveLength(2);
});

test('a failed approval acknowledgement retries without saving a second macro', async ({ app }) => {
    providerFor(app, SAVED_REPLY);
    const account = await assistantAccount(app);
    const page = await openAssistant(account);
    const accepted = await send(page, 'Yes, save one fixture greeting macro even if the first acknowledgement is lost.');
    const review = await awaitReview(page, account, accepted.job.id);
    await expectExactReview(review);

    let rejected = false;
    await page.route('**/api/jobs/*/approval/*', async route => {
        if (!rejected && route.request().method() === 'POST') {
            rejected = true;
            await route.abort('failed');
            return;
        }
        await route.continue();
    });
    await review.locator('.popup-button-ok').click();
    await expect.poll(() => rejected, { timeout: 30000, message: 'The first approval acknowledgement is refused' }).toBe(true);
    await expect.poll(async () => (await storedMacros(page)).length, { timeout: 30000 }).toBe(1);
    await account.settled(accepted.job.id);

    const stored = await storedMacros(page);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ...DRAFT, enabled: true, authoringProposalId: expect.any(String) });
    const finished = await readToolJob(account, accepted.job.id);
    expect(finished.result?.result).toMatchObject({
        tool: 'Neconyan_Assistant_SaveBrowserMacro',
        callId: 'save-browser-macro',
        result: { status: 'success', committed: true, name: DRAFT.name, scope: 'browser' },
    });
    await assertFinalReplyOnce(account, SAVED_REPLY);
    await assertBrowserOnly(account);
    expect(app.provider.calls).toHaveLength(2);
    await expect(reviewPopup(page)).toHaveCount(0);
});
