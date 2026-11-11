import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const fence = change => '```scratchpad-change\n' + JSON.stringify(change) + '\n```';

function picture() {
    const image = new PNG({ width: 96, height: 64 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([240, 210, 150, 255], i);
    return PNG.sync.write(image);
}

async function openRail(page) {
    await page.locator('#neconyan-workspace-rail [data-neconyan-route="scratchpad"]').click();
    await expect(page.locator('#neconyan-scratchpad')).toBeVisible();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
}

test('a reply with a finished image keeps its regenerate and swipe controls, which wait while the image is pending', async ({ app }) => {
    test.setTimeout(240000);
    const imageProvider = await app.images();
    imageProvider.mode.reply = { data: [{ b64_json: picture().toString('base64') }] };
    const account = await app.account({ configureSettings: saved => {
        saved.extension_settings['quick-image-gen'] = { provider: 'gptimage', gptImageKey: 'fixture-image-key', gptImageModel: 'gpt-image-1',
            gptImageProxyUrl: imageProvider.url, width: 1024, height: 1024, style: 'none', appendQuality: false, useSTStyle: false,
            reviewBeforeGenerate: false, setupWizardSeen: true };
    } });
    const page = await account.open({ workspace: false });
    await openRail(page);
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();

    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: fence({ type: 'image', action: 'generate', target: 'image', prompt: 'A little observatory below a moonlit sky.', reason: 'An illustration of the idea.' }) } }] };
    await page.locator('.scratchpad-composer').fill('Suggest the requested picture for me to review.');
    const sent = page.waitForResponse('**/api/scratchpad/send');
    await page.locator('.scratchpad-send').click();
    const reply = await sent;
    expect(reply.ok(), await reply.text()).toBe(true);
    await account.settled((await reply.json()).job.id);
    await expect(page.locator('.scratchpad-message.is-pending')).toHaveCount(0);

    const swipes = page.locator('.scratchpad-reply-swipes');
    const previous = page.getByRole('button', { name: 'Previous reply', exact: true });
    const next = page.getByRole('button', { name: 'Generate another reply', exact: true });
    await expect(next).toBeEnabled();

    imageProvider.mode.hold = 'gpt-image-1';
    const generating = page.waitForResponse('**/api/scratchpad/images/generate');
    await page.locator('.scratchpad-image-card').first().getByRole('button', { name: 'Generate image', exact: true }).click();
    const accepted = await generating;
    expect(accepted.ok(), await accepted.text()).toBe(true);
    const job = (await accepted.json()).job;
    await expect(swipes.getByRole('button')).toHaveCount(2);
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();

    await fetch(imageProvider.url.replace(/\/v1$/, '') + '/fixture/release', { method: 'POST', body: '{}' });
    imageProvider.mode.hold = '';
    await account.settled(job.id);
    await expect(page.locator('.scratchpad-generated-image').first()).toBeVisible();
    await expect(next).toBeEnabled();

    app.provider.mode.reply = { choices: [{ message: { role: 'assistant', content: 'A second version, written without a picture.' } }] };
    const regenerating = page.waitForResponse('**/api/scratchpad/send');
    await next.click();
    const regenerated = await regenerating;
    expect(regenerated.ok(), await regenerated.text()).toBe(true);
    await account.settled((await regenerated.json()).job.id);
    await expect(page.locator('.scratchpad-swipe-count')).toHaveText('2 of 2');
    await expect(page.locator('.scratchpad-image-card')).toHaveCount(0);

    await previous.click();
    await expect(page.locator('.scratchpad-swipe-count')).toHaveText('1 of 2');
    await expect(page.locator('.scratchpad-generated-image').first()).toBeVisible();
});
