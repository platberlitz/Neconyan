/* global window */
import { expect } from '@playwright/test';

/** Capture account-specific instructions before a no-page server test submits work. */
export async function captureBrowserMacros(page) {
    await page.waitForFunction(() => window.__dialogueColorsRuntime_v1?.initialized === true);
    const dialoguecolors = await page.evaluate(async () => {
        const { substituteParams } = await import('/script.js');
        return substituteParams('{{dialoguecolors}}');
    });
    expect(typeof dialoguecolors).toBe('string');
    expect(dialoguecolors).not.toContain('{{dialoguecolors}}');
    return { dialoguecolors };
}
