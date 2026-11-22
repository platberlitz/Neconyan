/* global window, document */
/* eslint-disable playwright/no-conditional-in-test -- Admin and other accounts share one script with different expectations. */
import path from 'node:path';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const PLANTED = [
    'sk-PLANTEDKEY1234567890abcdef',
    'PLANTEDBEARERTOKEN9876543210',
    'PLANTEDQUERYKEY123',
    'PLANTEDPASSWORD',
    'PLANTEDURLKEY456',
    'PLANTEDCOOKIE789',
    'PLANTEDCOOKIE2',
    'PLANTEDSIGNATURE0123456789abcdef',
    'PLANTEDXAPIKEY',
    'UExBTlRFREJBU0lD',
];
const PLANTED_PROMPT = 'PLANTEDPROMPTTEXT about a private story';
const SECRET_MESSAGE = ['Quota exceeded for the plan.',
    `Bearer ${PLANTED[1]} and ${PLANTED[0]}`,
    `https://user:${PLANTED[3]}@api.example.invalid/v1?key=${PLANTED[4]}&mode=1`,
    `token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQTEFOVEVEIn0.${PLANTED[7]}`,
    `API_KEY=${PLANTED[2]}`,
    `Cookie: session=${PLANTED[5]}; other=${PLANTED[6]}`,
    `AUTHORIZATION: Basic ${PLANTED[9]}`,
    `X-Api-Key: ${PLANTED[8]}`].join(' ');
const output = path.join('/tmp/opencode/app-evidence');

// The chat itself is shared as ordinary context, so chat text is checked only inside the evidence section.
const evidenceOnly = text => text.slice(text.indexOf('## App evidence')).split(/\n## (?!#)/)[0];

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

async function useDurableConnection(page) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
}

async function sendScratchpad(app, account, page, question) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-composer').fill(question);
    const [response] = await Promise.all([
        page.waitForResponse('**/api/scratchpad/send'),
        page.locator('.scratchpad-send').click(),
    ]);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).job.id;
}

async function failChatSend(page, avatar, text) {
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        await core.getCharacters();
        await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, avatar);
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_textarea').press('Enter');
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).is_send_press), { timeout: 30000 }).toBe(false);
    await page.evaluate(() => window.toastr.clear());
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} App diagnostics shares real evidence with an admin and an ordinary account`, async ({ app }) => {
        test.setTimeout(420000);
        const size = phone ? 'phone' : 'desktop';
        const admin = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
        await admin.post('/api/users/create', { handle: 'second-user', name: 'Second user', password: '', admin: false });
        const ordinary = await app.account({ handle: 'second-user', phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
        if (phone) {
            await installIPhoneSafari(admin.context, { standalone: true });
            await installIPhoneSafari(ordinary.context, { standalone: true });
        }
        const provider = app.provider;
        fs.mkdirSync(output, { recursive: true });

        const adminPage = await admin.open({ workspace: false });
        const ordinaryPage = await ordinary.open({ workspace: false });
        await acknowledgeActiveSettings(adminPage);
        await acknowledgeActiveSettings(ordinaryPage);

        // The ordinary account's own failures sit in the same server and must stay out of the admin's section only
        // where they are not part of the server-wide admin view.
        const viewers = [
            { name: 'admin', account: admin, page: adminPage, other: ordinary, otherPage: ordinaryPage, status: 429, otherStatus: 402,
                marker: 'OTHERONEMARKER', foreign: [402], isAdmin: true },
            { name: 'ordinary', account: ordinary, page: ordinaryPage, other: admin, otherPage: adminPage, status: 451, otherStatus: 406,
                marker: 'OTHERTWOMARKER', foreign: [429, 406], isAdmin: false },
        ];
        for (const viewer of viewers) {
            const { account, page, other, otherPage, marker } = viewer;

            // The other account fails a model call, a request and a Scratchpad reply with its own marker.
            provider.mode.httpError = { status: viewer.otherStatus, body: { error: { message: `${marker} limit reached. ${SECRET_MESSAGE}` } } };
            await failChatSend(otherPage, other.avatar, `${marker} chat text`);
            await other.context.request.post('/api/scratchpad/session/update', { headers: other.headers, data: { nonsense: marker } });
            await openScratchpad(otherPage);
            await useDurableConnection(otherPage);
            const otherJob = await sendScratchpad(app, other, otherPage, `${marker} question`);
            await other.settled(otherJob, 'failed');
            await otherPage.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());

            // This account fails a model call and a Scratchpad reply with the planted secrets.
            provider.mode.httpError = { status: viewer.status, body: { error: { message: SECRET_MESSAGE } } };
            await failChatSend(page, account.avatar, PLANTED_PROMPT);
            await account.context.request.post('/api/scratchpad/bucket', { headers: account.headers, data: { source: { kind: 'nonsense' } } });
            await openScratchpad(page);
            await useDurableConnection(page);
            const failedJob = await sendScratchpad(app, account, page, 'First question that fails');
            await account.settled(failedJob, 'failed');

            // The switch is off by default and Show preview then has no evidence.
            await page.getByRole('tab', { name: 'Context', exact: true }).click();
            if (phone) await applyIOSOnlyCss(page);
            const toggle = page.getByRole('checkbox', { name: /^App diagnostics/ });
            await expect(toggle).not.toBeChecked();
            const previewButton = page.getByRole('button', { name: 'Show preview', exact: true });
            const preview = page.locator('pre.scratchpad-preview-text');
            await previewButton.click();
            await expect(preview).not.toContainText('## App evidence');

            // One tap on the quick prompt turns on only this switch.
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            await page.getByRole('button', { name: 'What went wrong in Neconyan?', exact: true }).click();
            await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on App diagnostics for this session.' }).first()).toBeVisible();
            await expect(page.locator('.scratchpad-composer')).toHaveValue('Use the app diagnostics to tell me what went wrong in Neconyan, and what I should try or share next.');
            await page.evaluate(() => window.toastr.clear());
            await page.getByRole('tab', { name: 'Context', exact: true }).click();
            await expect(toggle).toBeChecked();
            await expect(page.getByRole('checkbox', { name: /^Problem checks/ })).not.toBeChecked();
            const row = toggle.locator('..');
            await row.scrollIntoViewIfNeeded();
            const box = await row.boundingBox();
            expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(phone ? 393 : 1280);

            await previewButton.click();
            await expect(preview).toContainText('## App evidence');
            const shown = await preview.innerText();
            fs.writeFileSync(path.join(output, `${size}-${viewer.name}-preview.txt`), shown);
            const section = evidenceOnly(shown);
            expect(section).toContain('### Neconyan and this device');
            expect(section).toContain('### Failed model requests');
            expect(section).toContain(`HTTP ${viewer.status}`);
            expect(section).toContain('Quota exceeded for the plan');
            expect(section).toContain('### Failed or slow server requests');
            expect(section).toContain('### Failed jobs');
            for (const secret of PLANTED) expect(section.toLowerCase(), `preview leaks ${secret}`).not.toContain(secret.toLowerCase());
            expect(section).not.toContain('PLANTEDPROMPTTEXT');
            // Another account's browser errors, requests and jobs never appear. The server-wide admin parts are the one exception.
            const accountParts = section.split('### Server crash reports')[0].split('### Recent server error')[0];
            expect(accountParts).not.toContain(marker);
            for (const status of viewer.foreign) expect(accountParts).not.toContain(`HTTP ${status}`);
            if (viewer.isAdmin) expect(accountParts).not.toContain('/api/scratchpad/session/update');
            if (viewer.isAdmin) {
                expect(section).toContain('### Recent server error and warning lines (admin only)');
            } else {
                expect(section).not.toContain('(admin only)');
            }

            // The server refuses the admin parts to an ordinary account.
            const adminRoute = await account.context.request.post('/api/scratchpad/evidence/admin', { headers: account.headers, data: {} });
            expect(adminRoute.status()).toBe(viewer.isAdmin ? 200 : 403);
            const adminText = await adminRoute.text();
            if (!viewer.isAdmin) {
                expect(adminText).not.toMatch(/serverCrashes|logLines|entries/);
            } else {
                for (const secret of PLANTED) expect(adminText.toLowerCase()).not.toContain(secret.toLowerCase());
            }
            const ownRoute = await account.context.request.post('/api/scratchpad/evidence', { headers: account.headers, data: {} });
            expect(ownRoute.status()).toBe(200);
            const ownText = await ownRoute.text();
            for (const secret of PLANTED) expect(ownText.toLowerCase()).not.toContain(secret.toLowerCase());
            expect(ownText).not.toContain(marker);
            expect(ownText).not.toMatch(/"handle"|second-user|default-user/);

            if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1' && viewer.isAdmin) {
                fs.mkdirSync(path.join('..', 'screenshots', 'scratchpad-app-evidence'), { recursive: true });
                await page.keyboard.press('Escape');
                await page.mouse.move(0, 0);
                await row.scrollIntoViewIfNeeded();
                await page.locator('#neconyan-scratchpad').screenshot({ path: path.join('..', 'screenshots', 'scratchpad-app-evidence', `${size}-context-after.png`) });
                await previewButton.click();
                await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
                await page.locator('#neconyan-scratchpad').screenshot({ path: path.join('..', 'screenshots', 'scratchpad-app-evidence', `${size}-preview.png`) });
            }

            // The real send: the provider is healthy again and the request it receives carries the evidence.
            provider.mode.httpError = null;
            provider.mode.reply = { choices: [{ message: { content: 'The evidence shows a rate limit.' } }] };
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            const question = `What went wrong in Neconyan? (${viewer.name})`;
            await page.locator('.scratchpad-composer').fill(question);
            const [response] = await Promise.all([
                page.waitForResponse('**/api/scratchpad/send'),
                page.locator('.scratchpad-send').click(),
            ]);
            expect(response.ok(), await response.text()).toBe(true);
            const job = (await response.json()).job.id;
            await account.settled(job);
            const calls = provider.calls.filter(call => call.messages?.at(-1)?.content === question);
            expect(calls).toHaveLength(1);
            const received = JSON.stringify(calls[0].body, null, 2);
            fs.writeFileSync(path.join(output, `${size}-${viewer.name}-request.json`), received);
            const sent = calls[0].messages.map(message => String(message.content)).join('\n');
            expect(sent).toContain('## App evidence');
            expect(sent).toContain('### Failed model requests');
            expect(sent).toContain(`HTTP ${viewer.status}`);
            expect(sent).toContain('Quota exceeded for the plan');
            expect(sent).toContain('App evidence for this message:');
            for (const secret of PLANTED) expect(sent.toLowerCase(), `request leaks ${secret}`).not.toContain(secret.toLowerCase());
            expect(evidenceOnly(sent)).not.toContain('PLANTEDPROMPTTEXT');
            const sentAccountParts = sent.split('### Server crash reports')[0].split('### Recent server error')[0];
            expect(sentAccountParts).not.toContain(marker);
            for (const status of viewer.foreign) expect(sentAccountParts).not.toContain(`HTTP ${status}`);
            if (!viewer.isAdmin) expect(sent).not.toContain('(admin only)');

            // Switching it off again sends the ordinary request without any evidence or evidence instructions.
            await page.getByRole('tab', { name: 'Context', exact: true }).click();
            await toggle.uncheck();
            await expect(toggle).not.toBeChecked();
            await page.getByRole('tab', { name: 'Chat', exact: true }).click();
            const plain = `Plain question (${viewer.name})`;
            await page.locator('.scratchpad-composer').fill(plain);
            const [plainResponse] = await Promise.all([
                page.waitForResponse('**/api/scratchpad/send'),
                page.locator('.scratchpad-send').click(),
            ]);
            await account.settled((await plainResponse.json()).job.id);
            const plainCalls = provider.calls.filter(call => call.messages?.at(-1)?.content === plain);
            expect(plainCalls).toHaveLength(1);
            const plainSent = plainCalls[0].messages.map(message => String(message.content)).join('\n');
            expect(plainSent).not.toMatch(/App evidence|## App evidence/);
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        }
    });
}
