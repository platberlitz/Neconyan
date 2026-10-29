/* global document, getComputedStyle, HTMLElement */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function getComposerSpacing(page) {
    return page.evaluate(() => {
        const composer = document.getElementById('nonQRFormItems');
        const textarea = document.getElementById('send_textarea');
        const form = document.getElementById('send_form');
        const bar = document.getElementById('form_sheld');
        const leftRail = document.getElementById('leftSendForm');
        const textareaRect = textarea?.getBoundingClientRect();
        const leftRailRect = leftRail?.getBoundingClientRect();
        const leftRailStyle = leftRail ? getComputedStyle(leftRail) : null;
        const leftRailOverflowX = leftRailStyle?.overflowX ?? '';
        const leftRailClipsControls = ['auto', 'clip', 'hidden', 'scroll'].includes(leftRailOverflowX);
        const leftRailClipRight = leftRailRect
            ? leftRailRect.right - Number.parseFloat(leftRailStyle.borderRightWidth)
            : 0;
        const getVisibleControls = id => Array.from(document.getElementById(id)?.children ?? [])
            .filter(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const leftControls = getVisibleControls('leftSendForm');
        const rightControls = getVisibleControls('rightSendForm');
        const leftControlRects = leftControls.map(element => element.getBoundingClientRect());
        const rightControlRects = rightControls.map(element => element.getBoundingClientRect());
        const rightmostLeftControl = leftControls.reduce((rightmost, element) => (
            !rightmost || element.getBoundingClientRect().right > rightmost.getBoundingClientRect().right ? element : rightmost
        ), null);

        if (!composer || !form || !bar || !leftRail || !rightmostLeftControl || !textareaRect || rightControlRects.length === 0) {
            return null;
        }

        const leftControlRight = Math.max(...leftControlRects.map(rect => rect.right));
        // The left rail is a horizontal scrollport with two visible slots. A control scrolled
        // past its clip edge paints nowhere the textarea can meet, so clearance runs to that
        // edge; a rail that does not clip still measures its furthest control.
        const leftRailVisibleRight = leftRailClipsControls
            ? Math.min(leftControlRight, leftRailClipRight)
            : leftControlRight;
        const leftRailOverflowIsClipped = leftControlRight <= leftRailClipRight || leftRailClipsControls;

        return {
            columnGap: Number.parseFloat(getComputedStyle(composer).columnGap),
            leftClearance: textareaRect.left - leftRailVisibleRight,
            leftRailOverflowIsClipped,
            leftControlBorderRadius: getComputedStyle(rightmostLeftControl).borderTopRightRadius,
            rightClearance: Math.min(...rightControlRects.map(rect => rect.left)) - textareaRect.right,
            textareaWidth: textareaRect.width,
            composerBorderRadius: getComputedStyle(composer).borderRadius,
            composerBorderTopWidth: getComputedStyle(composer).borderTopWidth,
            composerBorderColor: getComputedStyle(composer).borderColor,
            composerBackgroundImage: getComputedStyle(composer).backgroundImage,
            composerBackgroundColor: getComputedStyle(composer).backgroundColor,
            barBorderRadius: getComputedStyle(bar).borderRadius,
            barBorderTopWidth: getComputedStyle(bar).borderTopWidth,
            barBorderTopColor: getComputedStyle(bar).borderTopColor,
            barBackgroundImage: getComputedStyle(bar).backgroundImage,
            barBoxShadow: getComputedStyle(bar).boxShadow,
            barHeight: bar.getBoundingClientRect().height,
            textareaBorderRadius: getComputedStyle(textarea).borderRadius,
            textareaBackgroundColor: getComputedStyle(textarea).backgroundColor,
            textareaBoxShadow: getComputedStyle(textarea).boxShadow,
            formOutlineStyle: getComputedStyle(form).outlineStyle,
        };
    });
}

test.describe('mobile composer spacing at 320x568', () => {
    test.use({
        viewport: { width: 320, height: 568 },
        isMobile: true,
        hasTouch: true,
        userAgent: IPHONE_USER_AGENT,
    });

    test('normal and compact modes keep the action rails clear of the textarea', async ({ page }) => {
        // This suite measures the single-row input; whole-interface compact mode is a separate setting.
        await isolateSettingsSaves(page, settings => { settings.power_user.compact_input_area = true; });
        await openQuietChatForSmoke(page);

        await page.evaluate(async () => {
            document.documentElement.style.setProperty('--sb-bottom-bar-scale', '1.5');
            // Exercise the real connected layout, rather than force Send into a disconnected row.
            (await import('/script.js')).setOnlineStatus('Composer spacing fixture connection');
        });

        for (const compactMode of ['false', 'true']) {
            await page.evaluate(mode => {
                document.documentElement.setAttribute('data-sb-compact-mode', mode);
                document.getElementById('send_form')?.classList.remove('sb-generating-controls');
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
            }, compactMode);
            await waitForAnimationFrames(page, 2);
            // Wait for the previous focus transition before measuring idle colours.
            await expect(page.locator('#send_textarea')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

            const defaultState = await getComposerSpacing(page);

            expect(defaultState).not.toBeNull();
            // Overflow beyond the rail is acceptable only while the rail clips it. If the
            // overflow becomes visible, the clearance above measures the control itself.
            expect(defaultState.leftRailOverflowIsClipped).toBe(true);
            // Phones put the border and rounded corners on the outer bar, not the inner row.
            expect(Number.parseFloat(defaultState.composerBorderRadius)).toBe(0);
            expect(Number.parseFloat(defaultState.composerBorderTopWidth)).toBe(0);
            expect(defaultState.composerBackgroundImage).toBe('none');
            expect(Number.parseFloat(defaultState.barBorderRadius)).toBeGreaterThan(0);
            expect(Number.parseFloat(defaultState.barBorderTopWidth)).toBeGreaterThan(0);
            expect(defaultState.barBackgroundImage).toBe('none');
            expect(defaultState.barBoxShadow).toBe('none');
            await expect(page.locator('#sb-bottom-chat-bar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await expect(page.locator('#sb-bottom-chat-bar')).toHaveCSS('padding-left', '3px');
            expect(Number.parseFloat(defaultState.textareaBorderRadius)).toBeGreaterThan(0);
            expect(defaultState.textareaBackgroundColor).toBe('rgba(0, 0, 0, 0)');
            expect(Number.parseFloat(defaultState.leftControlBorderRadius)).toBeGreaterThanOrEqual(compactMode === 'true' ? 9 : 10);

            await page.locator('#send_textarea').focus();
            await waitForAnimationFrames(page, 2);

            const focusState = await getComposerSpacing(page);

            expect(focusState).not.toBeNull();
            expect(focusState.columnGap).toBeGreaterThanOrEqual(6);
            expect(focusState.leftClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.rightClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.textareaWidth).toBeGreaterThanOrEqual(100);
            expect(focusState.formOutlineStyle).toBe('none');
            expect(focusState.composerBorderColor).not.toBe(defaultState.composerBorderColor);
            expect(focusState.composerBackgroundImage).toBe(defaultState.composerBackgroundImage);
            expect(focusState.textareaBackgroundColor).not.toBe(defaultState.textareaBackgroundColor);
            expect(focusState.textareaBoxShadow).not.toBe(defaultState.textareaBoxShadow);
            expect(focusState.barBorderTopColor).toBe(defaultState.barBorderTopColor);

            // A late chat-load step can call hideStopButton() and drop the class, so re-apply it until it sticks.
            await expect.poll(async () => {
                await page.evaluate(() => {
                    if (document.activeElement instanceof HTMLElement) {
                        document.activeElement.blur();
                    }
                    document.getElementById('send_form')?.classList.add('sb-generating-controls');
                });
                await waitForAnimationFrames(page, 2);
                return (await getComposerSpacing(page))?.barBorderTopColor;
            }).not.toBe(defaultState.barBorderTopColor);

            const generatingState = await getComposerSpacing(page);

            expect(generatingState).not.toBeNull();
            expect(generatingState.barBorderTopColor).not.toBe(defaultState.barBorderTopColor);
            expect(generatingState.barBackgroundImage).toBe(defaultState.barBackgroundImage);
            expect(generatingState.barBoxShadow).toBe(`${generatingState.barBorderTopColor} 0px 0px 0px 3px inset`);
            expect(generatingState.barHeight).toBe(defaultState.barHeight);
            expect(generatingState.composerBackgroundImage).toBe('none');
            expect(generatingState.composerBackgroundColor).toBe(defaultState.composerBackgroundColor);

            await page.locator('#send_form').evaluate(form => form.classList.remove('sb-generating-controls'));
            await expect(page.locator('#form_sheld')).toHaveCSS('border-top-color', defaultState.barBorderTopColor);
            await expect(page.locator('#form_sheld')).toHaveCSS('box-shadow', defaultState.barBoxShadow);
        }
    });
});
