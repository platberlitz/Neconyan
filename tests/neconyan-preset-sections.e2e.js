/* global document, window, getComputedStyle, CSSTransition */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './neconyan-conversation-durable-fixture.js';

const screenshots = fileURLToPath(new URL('../screenshots/', import.meta.url));
const captureLabel = process.env.NECONYAN_PRESET_SCREENSHOTS;
test.setTimeout(180000);

async function openPrompts(page) {
    await page.evaluate(() => window.NeconyanShell.openTab('left', 'presets'));
    const invitation = page.getByRole('button', { name: 'Not now', exact: true });
    if (await invitation.isVisible()) await invitation.click();
    await page.getByRole('tab', { name: 'Prompts', exact: false }).click();
    await expect(page.locator('#completion_prompt_manager')).toBeVisible();
}

async function seededPage(app, phone) {
    const account = await app.account({ phone, activeConnection: true, configureSettings: settings => {
        const prompts = ['Main', 'Primary Toggles', 'Narration Voice', 'Reply Style'].flatMap((name, index) => [
            { identifier: `section-${index}`, name: `--- ${name}`, role: 'system', system_prompt: false, content: '', injection_position: 0 },
            { identifier: `prompt-${index}`, name: `${name} instructions`, role: 'system', system_prompt: false, content: `Follow the ${name.toLowerCase()} instructions.`, injection_position: 0 },
        ]);
        Object.assign(settings.oai_settings, { prompts, prompt_order: [{ character_id: 100001,
            order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })) }] });
        settings.extension_settings.BunnyPresetTools = { enablePromptSections: true,
            promptSectionStates: Object.fromEntries(prompts.filter(prompt => prompt.identifier.startsWith('section-')).map(prompt => [prompt.identifier, false])) };
    } });
    const page = await account.open({ workspace: false });
    await page.evaluate(async avatar => {
        const core = await import('/script.js');
        const context = window.SillyTavern.getContext();
        await context.getCharacters();
        await core.selectCharacterById(context.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
    }, account.avatar);
    await openPrompts(page);
    return page;
}

async function capture(page, name) {
    if (!captureLabel) return;
    await fs.mkdir(screenshots, { recursive: true });
    await expect(page.locator('#toast-container')).toBeHidden();
    await page.screenshot({ path: path.join(screenshots, `${name}-${captureLabel}.png`) });
}

async function lockGeometry(page) {
    return page.locator('.bpt-section-row').evaluateAll(rows => rows.map(row => {
        const bounds = row.getBoundingClientRect();
        const lock = row.querySelector('.bpt-section-lock').getBoundingClientRect();
        const style = getComputedStyle(row);
        return { title: row.dataset.sectionName, height: bounds.height, lockHeight: lock.height,
            topGap: lock.top - bounds.top - parseFloat(style.borderTopWidth),
            bottomGap: bounds.bottom - lock.bottom - parseFloat(style.borderBottomWidth),
            rightGap: bounds.right - lock.right - parseFloat(style.borderRightWidth),
            rows: style.gridTemplateRows, areas: style.gridTemplateAreas, gap: style.gap };
    }));
}

async function assertAccentContrast(page) {
    for (const [name, colour] of [['default', ''], ['pale', 'rgba(110, 231, 183, 1)'], ['dark', 'rgba(126, 34, 206, 1)']]) {
        const measured = await page.evaluate(async ({ colour }) => {
            const root = document.documentElement;
            root.dataset.neconyanAccent = colour ? 'custom' : 'theme';
            if (colour) root.style.setProperty('--SmartThemeQuoteColor', colour);
            else root.style.removeProperty('--SmartThemeQuoteColor');
            await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => {})));
            const canvas = document.createElement('canvas').getContext('2d');
            const rgba = value => {
                canvas.clearRect(0, 0, 1, 1);
                canvas.fillStyle = value;
                canvas.fillRect(0, 0, 1, 1);
                return [...canvas.getImageData(0, 0, 1, 1).data];
            };
            const composite = (ink, background, opacity = 1) => {
                const alpha = ink[3] / 255 * opacity;
                return [...ink.slice(0, 3).map((value, index) => value * alpha + background[index] * (1 - alpha)), 255];
            };
            const luminance = rgb => rgb.slice(0, 3).reduce((sum, value, index) => sum +
                (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index], 0);
            return ['.bpt-section-title', '.bpt-section-lock'].map(selector => {
                const node = document.querySelector(selector);
                const parents = [];
                for (let parent = node; parent; parent = parent.parentElement) parents.unshift(parent);
                let background = [255, 255, 255, 255];
                let opacity = 1;
                for (const parent of parents) {
                    const style = getComputedStyle(parent);
                    opacity *= Number(style.opacity);
                    background = composite(rgba(style.backgroundColor), background, opacity);
                }
                const foreground = composite(rgba(getComputedStyle(node).color), background, opacity);
                const a = luminance(foreground);
                const b = luminance(background);
                return { selector, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
            });
        }, { colour });
        console.log('SECTION_ACCENT_CONTRAST ' + JSON.stringify({ name, measured }));
        for (const value of measured) expect(value.contrast, `${name} ${value.selector}`).toBeGreaterThanOrEqual(4.5);
    }
}

for (const phone of [false, true]) {
    const viewport = phone ? 'phone' : 'desktop';
    test(`${viewport} section locks fill the row and preserve nested collapse controls`, async ({ app }) => {
        const page = await seededPage(app, phone);
        const list = page.locator('#completion_prompt_manager_list');
        if (!await list.isVisible()) await page.locator('#completion_prompt_manager_drawer > .inline-drawer-toggle').click();
        await expect(page.locator('.bpt-section-row')).toHaveCount(4);
        await list.scrollIntoViewIfNeeded();
        await capture(page, `${viewport}-preset-sections`);
        const geometry = await lockGeometry(page);
        console.log('SECTION_LOCK_GEOMETRY ' + JSON.stringify({ viewport, geometry }));
        for (const row of geometry) {
            expect(Math.abs(row.topGap), JSON.stringify(row)).toBeLessThan(1);
            expect(Math.abs(row.bottomGap), JSON.stringify(row)).toBeLessThan(1);
            expect(Math.abs(row.rightGap), JSON.stringify(row)).toBeLessThan(1);
        }
        await assertAccentContrast(page);
        const section = page.locator('.bpt-section-row[data-section-id="section-0"]');
        const trigger = section.locator('.bpt-section-trigger');
        const lock = section.locator('.bpt-section-lock');
        const prompt = list.locator('[data-pm-identifier="prompt-0"]');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(lock).toHaveAttribute('aria-pressed', 'true');
        await expect(trigger).toBeDisabled();
        await expect(prompt).toBeHidden();
        await lock.click();
        await expect(lock).toHaveAttribute('aria-pressed', 'false');
        await trigger.click();
        await expect(prompt).toBeVisible();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await trigger.click();
        await expect(prompt).toBeHidden();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
}
