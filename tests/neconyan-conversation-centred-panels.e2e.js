/* global document, getComputedStyle, innerHeight, innerWidth, window */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);

const GREEN_ACCENT = {
    quote_text_color: 'rgba(45, 212, 191, 1)',
    underline_text_color: 'rgba(134, 239, 172, 1)',
};

function applyStarlight(saved) {
    saved.power_user.neconyan_shell_style = 'starlight-conservatory';
    Object.assign(saved.power_user, GREEN_ACCENT);
}

const LONG_MESSAGES = [
    ['user', 'User', 'Kaveh, the east wall is definitely load-bearing.'],
    ['assistant', 'Kaveh', 'It is load-bearing, yes. That is what I have been saying since Tuesday. You cannot put a window through it and call it taste. The whole lintel would sag by spring, and then you would call me.'],
    ['user', 'User', 'What if the window is very small?'],
    ['assistant', 'Kaveh', 'A small hole in a load-bearing wall is still a hole in a load-bearing wall. I admire the optimism, but the house does not.'],
    ['user', 'User', 'Fine. The window stays.'],
    ['assistant', 'Kaveh', 'Thank you. I will pretend I did not see the pencil marks above the skirting board.'],
    ['user', 'User', 'They are measurements.'],
    ['assistant', 'Kaveh', 'They are measurements in the same way a cat sitting on a blueprint is a paperweight.'],
];

async function seedMessages(account) {
    const saved = await account.post('/api/neconyan-conversation/store/get');
    await account.post('/api/neconyan-conversation/thread/save', {
        avatar: account.avatar,
        personaId: account.personaId,
        version: saved.version,
        messages: LONG_MESSAGES.map(([role, name, mes], index) => ({
            id: `centred-panels-${index}`,
            role,
            name,
            mes,
            timestamp: 1700000000000 + index * 60000,
        })),
    });
}

async function emptyRailAndThread(account) {
    await account.changeStore(store => {
        const slot = store.characters[account.threadKey];
        if (!slot) throw new Error('Conversation fixture thread is missing.');
        Object.assign(slot.settings, { enabled: false });
        const branch = slot.branches[slot.activeBranchId];
        branch.messages = [];
        branch.preview = 'Conversation ready';
    });
}

async function openPalsRail(page) {
    const rail = page.locator('#sb_conversation_pals_rail');
    if (!(await rail.isVisible())) {
        await page.locator('#sb_conversation_pals_toggle').click();
    }
    await expect(rail).toBeVisible();
}

async function reopenConversation(page, avatar) {
    await page.evaluate(async avatar => {
        await window.SillyTavern.getContext().getCharacters();
        await (await import('/scripts/neconyan-conversation/chrome.js')).openConversationWorkspaceForAvatar(avatar);
    }, avatar);
    await expect(page.locator('#sb_conversation_input')).toBeVisible();
}

async function readLayout(page) {
    return page.evaluate(() => {
        const rect = element => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
        };
        const style = element => {
            const computed = getComputedStyle(element);
            return {
                backgroundImage: computed.backgroundImage,
                backgroundColor: computed.backgroundColor,
                borderTopWidth: computed.borderTopWidth,
                borderRadius: parseFloat(computed.borderTopLeftRadius),
                overflowY: computed.overflowY,
                display: computed.display,
                alignItems: computed.alignItems,
                justifyItems: computed.justifyItems,
                gap: computed.gap,
                float: computed.float,
                maxInlineSize: computed.maxInlineSize,
                textAlign: computed.textAlign,
            };
        };
        const timeline = document.querySelector('.sb-conversation-timeline');
        const stage = document.querySelector('#sb_conversation_stage');
        const composer = document.querySelector('.sb-conversation-composer');
        const card = document.querySelector('.sb-conversation-pal');
        const branches = document.querySelector('.sb-conversation-branch-list');
        const addBranch = document.querySelector('.sb-conversation-new-branch');
        const railEmpty = document.querySelector('#sb_conversation_pals_list > .sb-conversation-empty');
        const image = document.querySelector('#sb_conversation_pals_list .sb-conversation-empty-illustration');
        const caption = document.querySelector('#sb_conversation_pals_list .sb-conversation-empty span');
        const range = caption ? document.createRange() : null;
        if (range) range.selectNodeContents(caption);
        return {
            viewport: { width: innerWidth, height: innerHeight },
            timeline: rect(timeline),
            timelineStyle: style(timeline),
            timelineScrollHeight: timeline.scrollHeight,
            timelineClientHeight: timeline.clientHeight,
            stage: rect(stage),
            stageBackground: getComputedStyle(stage).backgroundColor,
            composer: rect(composer),
            card: card ? rect(card) : null,
            branches: branches ? rect(branches) : null,
            addBranch: addBranch ? rect(addBranch) : null,
            empty: document.querySelector('.sb-conversation-thread-empty') ? rect(document.querySelector('.sb-conversation-thread-empty')) : null,
            railEmpty: railEmpty ? rect(railEmpty) : null,
            railEmptyStyle: railEmpty ? style(railEmpty) : null,
            image: image ? rect(image) : null,
            imageStyle: image ? style(image) : null,
            caption: caption ? rect(caption) : null,
            captionStyle: caption ? style(caption) : null,
            captionLines: range ? Array.from(range.getClientRects()).map(line => ({ x: line.x, y: line.y, width: line.width })) : [],
        };
    });
}

for (const viewport of [
    { label: 'phone', phone: true, width: 393, height: 852 },
    { label: 'desktop', phone: false, width: 1280, height: 900 },
]) {
    test.describe(`Conversation centred panels at ${viewport.width}px`, () => {
        test('centres branch controls, stacks the empty rail cat, and panes the message area', async ({ app }, info) => {
            const account = await app.account({
                phone: viewport.phone,
                contextOptions: viewport.phone ? { userAgent: IPHONE_SAFARI_CONTEXT.userAgent, deviceScaleFactor: 3 } : {},
                configureSettings: applyStarlight,
            });
            if (viewport.phone) await installIPhoneSafari(account.context);
            await seedMessages(account);
            const page = await account.open();
            if (viewport.phone) await applyIOSOnlyCss(page);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await expect(page.locator('#sb_conversation_stage')).toBeVisible();

            await openPalsRail(page);
            const populated = await readLayout(page);

            expect(populated.card, 'a pal card is present').not.toBeNull();
            expect(populated.branches, 'the branch block is present').not.toBeNull();
            expect(populated.addBranch, 'the new branch control is present').not.toBeNull();
            expect(Math.abs(populated.branches.x - populated.card.x), 'branch block starts with the card').toBeLessThanOrEqual(1);
            expect(Math.abs(populated.branches.right - populated.card.right), 'branch block ends with the card').toBeLessThanOrEqual(1);
            expect(Math.abs((populated.addBranch.x + populated.addBranch.width / 2) - (populated.card.x + populated.card.width / 2)),
                'new branch label is centred under the card').toBeLessThanOrEqual(1);
            expect(populated.branches.width, 'branch controls keep a usable width').toBeGreaterThan(150);
            expect(populated.branches.y, 'branch block sits below the chat card').toBeGreaterThanOrEqual(populated.card.bottom);

            if (viewport.phone) await page.locator('#sb_conversation_pals_rail [data-sb-conversation-action="close-pals"]').click();
            const pane = await readLayout(page);
            expect(pane.timelineStyle.backgroundImage, 'message area has a translucent surface').toContain('linear-gradient');
            expect(pane.timelineStyle.backgroundColor, 'message area does not paint an opaque colour').toBe('rgba(0, 0, 0, 0)');
            expect(pane.timelineStyle.borderTopWidth, 'message area has a visible edge').toBe('1px');
            expect(pane.timelineStyle.borderRadius, 'message area keeps the shell radius').toBeGreaterThanOrEqual(10);
            expect(pane.timelineStyle.overflowY, 'message area still scrolls').toBe('auto');
            expect(pane.stageBackground, 'stage keeps the wallpaper visible').toBe('rgba(0, 0, 0, 0)');
            expect(pane.timeline.x, 'pane is inset from the stage').toBeGreaterThan(pane.stage.x + 2);
            expect(pane.timeline.y, 'pane is inset from the header').toBeGreaterThan(pane.stage.y + 2);
            expect(pane.timeline.right, 'pane is inset from the stage edge').toBeLessThan(pane.stage.right - 2);
            expect(pane.timeline.bottom, 'pane stops above the composer').toBeLessThan(pane.composer.y - 2);
            expect(pane.composer.bottom, 'composer stays reachable').toBeLessThanOrEqual(pane.viewport.height + 1);
            expect(pane.timeline.height, 'message area keeps most of the stage height').toBeGreaterThan(pane.stage.height * 0.6);
            expect(pane.timelineScrollHeight, 'populated messages scroll inside the pane').toBeGreaterThan(pane.timelineClientHeight);
            expect(errors).toEqual([]);
            await page.screenshot({ path: info.outputPath(`centred-panels-${viewport.label}-populated.png`) });

            await emptyRailAndThread(account);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'), undefined, { timeout: 60000 });
            await reopenConversation(page, account.avatar);
            if (viewport.phone) await applyIOSOnlyCss(page);
            await openPalsRail(page);
            const empty = await readLayout(page);

            expect(empty.railEmpty, 'empty rail container is present').not.toBeNull();
            expect(empty.image, 'empty rail illustration is present').not.toBeNull();
            expect(empty.caption, 'empty rail caption is present').not.toBeNull();
            expect(empty.railEmptyStyle.display, 'empty rail uses a vertical stack').toBe('grid');
            expect(empty.railEmptyStyle.alignItems, 'empty rail centres its rows').toBe('center');
            expect(empty.railEmptyStyle.justifyItems, 'empty rail centres its children').toBe('center');
            expect(empty.railEmptyStyle.textAlign, 'empty rail copy is centred').toBe('center');
            expect(empty.imageStyle.float, 'empty rail cat is not floated beside the copy').toBe('none');
            expect(empty.captionStyle.textAlign, 'empty rail caption is centred').toBe('center');
            expect(empty.captionStyle.maxInlineSize, 'empty rail caption has a bounded width').not.toBe('none');
            const imageCentre = empty.image.x + empty.image.width / 2;
            const captionCentre = empty.caption.x + empty.caption.width / 2;
            const railEmptyCentre = empty.railEmpty.x + empty.railEmpty.width / 2;
            expect(Math.abs(imageCentre - railEmptyCentre), 'cat is centred in the rail').toBeLessThanOrEqual(1);
            expect(Math.abs(captionCentre - railEmptyCentre), 'caption is centred under the cat').toBeLessThanOrEqual(1);
            expect(empty.caption.y, 'caption starts below the cat').toBeGreaterThanOrEqual(empty.image.bottom + 8);
            expect(empty.captionLines.length, 'caption keeps its two-line wrap').toBeGreaterThan(1);
            for (const line of empty.captionLines) {
                expect(line.y, 'caption never wraps beside the cat').toBeGreaterThanOrEqual(empty.image.bottom);
            }

            if (viewport.phone) await page.locator('#sb_conversation_pals_rail [data-sb-conversation-action="close-pals"]').click();
            const emptyPane = await readLayout(page);
            expect(emptyPane.empty, 'empty message card is present').not.toBeNull();
            expect(emptyPane.empty.x, 'empty card sits inside the pane').toBeGreaterThanOrEqual(emptyPane.timeline.x);
            expect(emptyPane.empty.right, 'empty card sits inside the pane').toBeLessThanOrEqual(emptyPane.timeline.right);
            expect(emptyPane.empty.bottom, 'empty card sits inside the pane').toBeLessThanOrEqual(emptyPane.timeline.bottom);
            expect(emptyPane.timelineStyle.backgroundImage, 'empty message area keeps the pane').toContain('linear-gradient');
            expect(emptyPane.composer.bottom, 'composer stays reachable in the empty state').toBeLessThanOrEqual(emptyPane.viewport.height + 1);
            expect(errors).toEqual([]);
            await page.screenshot({ path: info.outputPath(`centred-panels-${viewport.label}-empty.png`) });
        });
    });
}
