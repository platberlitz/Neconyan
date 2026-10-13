/* global document, window, getComputedStyle */
/* eslint-disable playwright/no-standalone-expect -- The helper checks its own measured controls. */
import { expect } from '@playwright/test';

export async function checkImageControlContrast(page, selectors, phone) {
    const results = [];
    for (const theme of ['Neconyan Calico Dark', 'Neconyan Calico']) {
        await page.locator('#themes').selectOption({ label: theme }, { force: true });
        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
            await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation instanceof window.CSSTransition).map(animation => animation.finished.catch(() => {}))));
            for (const selector of selectors) {
                const measured = await page.locator(selector).first().evaluate(async element => {
                    const { contrastRatio } = await import('/scripts/theme-contrast.js');
                    const context = document.createElement('canvas').getContext('2d');
                    const rgb = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
                    const composite = (over, under) => over.slice(0, 3).map((value, index) => value * over[3] / 255 + under[index] * (1 - over[3] / 255));
                    const ancestors = [];
                    for (let parent = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
                    let background = [255, 255, 255];
                    for (const parent of ancestors) background = composite(rgb(getComputedStyle(parent).backgroundColor), background);
                    const style = getComputedStyle(element);
                    const colour = getComputedStyle(element.querySelector('span') || element).color;
                    return { ratio: contrastRatio(rgb(colour).slice(0, 3), background), height: element.getBoundingClientRect().height, colour, background, image: style.backgroundImage };
                });
                results.push({ theme, accent, selector, ...measured });
                expect(measured.ratio, JSON.stringify(results)).toBeGreaterThanOrEqual(4.5);
                expect(measured.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
            }
        }
    }
    await page.locator('#themes').selectOption({ label: 'Neconyan Calico Dark' }, { force: true });
    await page.evaluate(() => window.toastr.remove());
    return results;
}
