/* global document, getComputedStyle, HTMLElement */
import { expect, test } from '@playwright/test';
import { openQuietChatForSmoke, waitForAnimationFrames } from './chat-scroll-regression-helpers.js';

const IPHONE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function getComposerSpacing(page) {
    return page.evaluate(() => {
        const composer = document.getElementById('nonQRFormItems');
        const textarea = document.getElementById('send_textarea');
        const form = document.getElementById('send_form');
        const bar = document.getElementById('form_sheld');
        const textareaRect = textarea?.getBoundingClientRect();
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

        if (!composer || !form || !bar || !rightmostLeftControl || !textareaRect || rightControlRects.length === 0) {
            return null;
        }

        return {
            columnGap: Number.parseFloat(getComputedStyle(composer).columnGap),
            leftClearance: textareaRect.left - Math.max(...leftControlRects.map(rect => rect.right)),
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
        await openQuietChatForSmoke(page);

        await page.evaluate(() => {
            document.documentElement.style.setProperty('--sb-bottom-bar-scale', '1.5');
            document.getElementById('send_but')?.classList.remove('displayNone');
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
            // Phones put the border and rounded corners on the outer bar, not the inner row.
            expect(Number.parseFloat(defaultState.composerBorderRadius)).toBe(0);
            expect(Number.parseFloat(defaultState.composerBorderTopWidth)).toBe(0);
            expect(defaultState.composerBackgroundImage).toBe('none');
            expect(Number.parseFloat(defaultState.barBorderRadius)).toBeGreaterThan(0);
            expect(Number.parseFloat(defaultState.barBorderTopWidth)).toBeGreaterThan(0);
            expect(defaultState.barBackgroundImage).toBe('none');
            expect(defaultState.barBoxShadow).toBe('none');
            expect(Number.parseFloat(defaultState.textareaBorderRadius)).toBeGreaterThan(0);
            expect(defaultState.textareaBackgroundColor).toBe('rgba(0, 0, 0, 0)');
            expect(Number.parseFloat(defaultState.leftControlBorderRadius)).toBeGreaterThanOrEqual(compactMode === 'true' ? 9 : 10);

            await page.locator('#send_textarea').focus();
            await waitForAnimationFrames(page, 2);

            const focusState = await getComposerSpacing(page);

            expect(focusState).not.toBeNull();
            expect(focusState.columnGap).toBeGreaterThanOrEqual(8);
            expect(focusState.leftClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.rightClearance).toBeGreaterThanOrEqual(6);
            expect(focusState.textareaWidth).toBeGreaterThanOrEqual(100);
            expect(focusState.formOutlineStyle).toBe('none');
            expect(focusState.composerBorderColor).not.toBe(defaultState.composerBorderColor);
            expect(focusState.composerBackgroundImage).toBe(defaultState.composerBackgroundImage);
            expect(focusState.textareaBackgroundColor).not.toBe(defaultState.textareaBackgroundColor);
            expect(focusState.textareaBoxShadow).not.toBe(defaultState.textareaBoxShadow);
            expect(focusState.barBorderTopColor).toBe(defaultState.barBorderTopColor);

            await page.evaluate(() => {
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
                document.getElementById('send_form')?.classList.add('sb-generating-controls');
            });
            await waitForAnimationFrames(page, 2);

            const generatingState = await getComposerSpacing(page);

            expect(generatingState).not.toBeNull();
            expect(generatingState.barBorderTopColor).not.toBe(defaultState.barBorderTopColor);
            expect(generatingState.barBackgroundImage).toBe(defaultState.barBackgroundImage);
            expect(generatingState.barBoxShadow).toBe(defaultState.barBoxShadow);
            expect(generatingState.composerBackgroundImage).toBe('none');
            expect(generatingState.composerBackgroundColor).toBe(defaultState.composerBackgroundColor);

            await page.locator('#send_form').evaluate(form => form.classList.remove('sb-generating-controls'));
            await expect(page.locator('#form_sheld')).toHaveCSS('border-top-color', defaultState.barBorderTopColor);
        }
    });
});
