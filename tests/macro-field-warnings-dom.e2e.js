/* global window, document */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const ORIGIN = 'http://macro-warnings.test';
const publicFile = path => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/neconyan-macro-warnings.css">
<style>body { margin: 0; font: 15px sans-serif; } textarea, input { box-sizing: border-box; width: 100%; } .row { display: flex; gap: 8px; } .displayNone { display: none; }</style>
</head><body>
<label for="description">Description</label>
<textarea id="description" data-macros aria-describedby="description_hint">Hi {{char}}</textarea>
<p id="description_hint">Shown to the model.</p>
<div class="row" id="row"><input id="row_input" data-macros value="{{user}}"><button>Go</button></div>
<textarea id="story" data-macros data-macro-dialect="story-string">{{#if system}}{{system}}{{/if}}</textarea>
<textarea id="agent" data-macros data-macro-dialect="agent">{{currentMessage}}</textarea>
<textarea id="plain">{{chra}}</textarea>
<textarea id="off" data-macros="false">{{chra}}</textarea>
<textarea id="typo_on_load" data-macros>{{chra}}</textarea>
</body></html>`;

async function open(page, viewport) {
    page.on('pageerror', error => { throw error; });
    await page.route(`${ORIGIN}/**`, route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
        const type = path.endsWith('.css') ? 'text/css' : 'text/javascript';
        return route.fulfill({ contentType: type, body: publicFile(path.slice(1)) });
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(async ({ width }) => {
        const module = await import('/scripts/macro-field-warnings.js');
        window.names = ['char', 'user', 'if', 'else', 'getvar', 'setvar'];
        module.registerMacroFieldDialect('agent', () => ['currentMessage']);
        window.macroWarnings = module.createMacroFieldWarnings({ getKnownNames: () => window.names, debounceMs: 250, registryPollMs: 100 });
        window.viewportWidth = width;
    }, viewport);
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`macro field warnings DOM at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393 });
        test.beforeEach(async ({ page }) => open(page, viewport));

        test('clean fields stay untouched and a typo present on load warns at once', async ({ page }) => {
            await expect(page.locator('.nn-macro-field-warning')).toHaveCount(1);
            const warning = page.locator('#typo_on_load + .nn-macro-field-warning');
            await expect(warning).toHaveText('Unknown macro: {{chra}} Check the spelling. Neconyan sends unknown macros as plain text.');
            await expect(warning).toHaveAttribute('role', 'status');
            await expect(warning).toHaveAttribute('aria-live', 'polite');
            const id = await warning.getAttribute('id');
            await expect(page.locator('#typo_on_load')).toHaveAttribute('aria-describedby', id);
            for (const id of ['description', 'row_input', 'story', 'agent', 'plain', 'off']) {
                expect(await page.locator(`#${id}`).evaluate(field => field.nextElementSibling?.classList.contains('nn-macro-field-warning') ?? false)).toBe(false);
            }
            await expect(page.locator('#description')).toHaveAttribute('aria-describedby', 'description_hint');
        });

        test('typing waits for a pause, change checks at once and fixing clears', async ({ page }) => {
            const field = page.locator('#description');
            const before = await page.locator('#description_hint').boundingBox();
            await field.fill('Hi {{chra}} and {{user');
            await page.waitForTimeout(80);
            const warning = page.locator('#description + .nn-macro-field-warning');
            await expect(warning).toHaveCount(0);
            await expect(warning).toHaveCount(1);
            await expect(warning.locator('[data-kind="unknown"] code')).toHaveText(['{{chra}}']);
            await expect(warning.locator('[data-kind="unclosed"] code')).toHaveText(['{{user']);
            await expect(warning.locator('[data-kind="unclosed"]')).toContainText('Add the closing braces.');
            const id = await warning.getAttribute('id');
            await expect(field).toHaveAttribute('aria-describedby', `description_hint ${id}`);
            await field.evaluate(element => {
                element.value = 'Hi {{char}} }}';
                element.dispatchEvent(new Event('change', { bubbles: true }));
            });
            await expect(warning.locator('[data-kind="stray"]')).toHaveText('Extra closing braces: }} Remove them or add the opening braces.');
            await field.fill('Hi {{char}} and {{user}}');
            await expect(page.locator('.nn-macro-field-warning')).toHaveCount(1);
            await expect(field).toHaveAttribute('aria-describedby', 'description_hint');
            expect(await page.locator('#description_hint').boundingBox()).toEqual(before);
        });

        test('programmatic value changes, like a character switch, update and clear the warning', async ({ page }) => {
            await page.evaluate(() => { document.getElementById('description').value = '{{chra}} {{usr}} {{a1}} {{b2}}'; });
            const warning = page.locator('#description + .nn-macro-field-warning');
            await expect(warning.locator('code')).toHaveText(['{{chra}}', '{{usr}}', '{{a1}}']);
            await expect(warning.locator('.nn-macro-field-warning-more')).toHaveText('+1 more');
            await expect(warning.locator('.nn-macro-field-warning-label')).toHaveText('Unknown macros:');
            await page.evaluate(() => { document.getElementById('description').value = 'A clean card for {{char}}'; });
            await expect(warning).toHaveCount(0);
            await page.evaluate(() => { document.getElementById('typo_on_load').value = ''; });
            await expect(page.locator('.nn-macro-field-warning')).toHaveCount(0);
        });

        test('fields added, marked, unmarked or removed later are followed', async ({ page }) => {
            await page.evaluate(() => {
                const popup = document.createElement('div');
                popup.id = 'popup';
                popup.style.cssText = 'display:flex;flex-direction:column;height:300px';
                const expanded = document.createElement('textarea');
                expanded.id = 'expanded';
                expanded.dataset.macros = '';
                expanded.dataset.macroDialect = 'story-string';
                expanded.value = '{{#each items}}{{this}}{{/each}} {{wiBefre}}';
                popup.append(expanded);
                document.body.append(popup);
            });
            await expect(page.locator('#expanded + .nn-macro-field-warning code')).toHaveText(['{{wiBefre}}']);
            await page.evaluate(() => document.getElementById('popup').remove());
            await expect(page.locator('.nn-macro-field-warning')).toHaveCount(1);
            await page.evaluate(() => document.getElementById('plain').setAttribute('data-macros', ''));
            await expect(page.locator('#plain + .nn-macro-field-warning')).toHaveCount(1);
            await page.evaluate(() => document.getElementById('plain').removeAttribute('data-macros'));
            await expect(page.locator('#plain + .nn-macro-field-warning')).toHaveCount(0);
            await expect(page.locator('#plain')).not.toHaveAttribute('aria-describedby', /.+/);
        });

        test('dialects allow their own names only where they apply', async ({ page }) => {
            await page.evaluate(() => {
                document.getElementById('story').value = '{{#if system}}{{system}}{{/if}}{{wiBefore}}{{currentMessage}}';
                document.getElementById('agent').value = '{{currentMessage}} {{wiBefore}}';
            });
            await expect(page.locator('#story + .nn-macro-field-warning code')).toHaveText(['{{currentMessage}}']);
            await expect(page.locator('#agent + .nn-macro-field-warning code')).toHaveText(['{{wiBefore}}']);
        });

        test('a row of controls keeps its columns and nothing overflows', async ({ page }) => {
            const row = page.locator('#row');
            const before = await row.boundingBox();
            await page.evaluate(() => { document.getElementById('row_input').value = `{{${'averyveryverylongunknownmacroname'.repeat(3)}}} {{user`; });
            const warning = page.locator('#row + .nn-macro-field-warning');
            await expect(warning).toHaveCount(1);
            expect(await row.boundingBox()).toEqual(before);
            const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
            expect(widths.scroll).toBeLessThanOrEqual(widths.client);
            const box = await warning.boundingBox();
            expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
        });

        test('macros registered later clear an open warning', async ({ page }) => {
            const warning = page.locator('#typo_on_load + .nn-macro-field-warning');
            await expect(warning).toHaveCount(1);
            await page.evaluate(() => { window.names = [...window.names, 'chra']; });
            await expect(warning).toHaveCount(0);
        });

        test('a hidden field hides its warning', async ({ page }) => {
            await page.evaluate(() => document.getElementById('typo_on_load').classList.add('displayNone'));
            await expect(page.locator('#typo_on_load + .nn-macro-field-warning')).toBeHidden();
        });
    });
}
