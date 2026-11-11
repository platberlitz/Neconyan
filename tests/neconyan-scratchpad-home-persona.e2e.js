/* global document, window */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

const locked = 'locked-ivy.png';
const picked = 'picked-ash.png';
const fallback = 'account-default.png';

function picture(colour) {
    const image = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < image.data.length; i += 4) image.data.set([...colour, 255], i);
    return PNG.sync.write(image);
}

async function shared(page) {
    return page.evaluate(async () => {
        const context = await import('/scripts/scratchpad/context.js');
        const source = context.currentSource();
        const result = await context.buildContext({ source, settings: { depth: 0, include: { card: true, persona: true, authorsNote: true, lore: true, preset: false, hidden: false } } });
        return { kind: source.kind, personaId: source.personaId, text: result.text, persona: result.capabilities.persona ?? null };
    });
}

async function openHomeWithChat(page, account, lockedAvatar) {
    await page.evaluate(async ([avatar, lock]) => {
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await context.selectCharacterById(context.characters.findIndex(item => item.avatar === avatar), { switchMenu: false });
        const script = await import('/script.js');
        context.chat.push({ name: 'Durable Nova', mes: 'A quiet opening line.', is_user: false, extra: {} });
        context.chatMetadata.persona = lock;
        await context.saveChat({ throwOnError: true });
        await script.reloadCurrentChat();
    }, [account.avatar, lockedAvatar]);
    await page.evaluate(async () => {
        await (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true });
        window.dispatchEvent(new Event('neconyan:navigate-home'));
    });
    await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
}

test('a persona picked on Home is shared, while the chat-locked persona stays hidden until the user picks', async ({ app }) => {
    test.setTimeout(180000);
    const account = await app.account({ configureSettings: saved => {
        saved.user_avatar = locked;
        saved.power_user.persona_auto_lock = true;
        saved.power_user.default_persona = fallback;
        saved.power_user.personas = { ...saved.power_user.personas, [locked]: 'Locked Ivy', [picked]: 'Picked Ash', [fallback]: 'Account Default' };
        const descriptor = description => ({ description, appendices: [], activeAppendices: {}, connections: [] });
        saved.power_user.persona_descriptions = { ...saved.power_user.persona_descriptions,
            [locked]: descriptor('LOCKED-BASE'), [picked]: descriptor('PICKED-BASE'), [fallback]: descriptor('DEFAULT-BASE') };
    } });
    const avatars = path.join(app.dataRoot, 'default-user', 'User Avatars');
    await fs.writeFile(path.join(avatars, locked), picture([120, 90, 180]));
    await fs.writeFile(path.join(avatars, picked), picture([90, 160, 120]));
    await fs.writeFile(path.join(avatars, fallback), picture([200, 200, 200]));
    const page = await account.open({ workspace: false });
    await openHomeWithChat(page, account, locked);

    const before = await shared(page);
    expect(before.kind).toBe('general');
    expect(before.personaId).toBe(fallback);
    expect(before.text).toContain('DEFAULT-BASE');
    expect(before.text).not.toContain('LOCKED-BASE');
    expect(before.persona).toEqual({ avatar: fallback, name: 'Account Default' });

    await page.evaluate(avatar => document.querySelector(`#user_avatar_block .avatar-container[data-avatar-id="${avatar}"]`).click(), picked);
    await expect.poll(async () => (await shared(page)).personaId).toBe(picked);
    const after = await shared(page);
    expect(after.text).toContain('PICKED-BASE');
    expect(after.text).not.toContain('LOCKED-BASE');
    expect(after.persona).toEqual({ avatar: picked, name: 'Picked Ash' });
    await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);

    await page.evaluate(async () => (await import('/scripts/welcome-screen.js')).hideWelcomeHome());
    await page.evaluate(async () => {
        await (await import('/scripts/welcome-screen.js')).openWelcomeScreen({ force: true });
        window.dispatchEvent(new Event('neconyan:navigate-home'));
    });
    await expect(page.locator('body')).toHaveClass(/neconyan-home-visible/);
    await expect.poll(async () => (await shared(page)).personaId).toBe(fallback);
    expect((await shared(page)).text).not.toContain('PICKED-BASE');
});
