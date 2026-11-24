/* global window, document, navigator */
/* eslint-disable playwright/no-conditional-in-test -- the minified mapping check depends on whether this checkout has a fresh frontend build */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { acknowledgeActiveSettings, test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const CHECKOUT = path.resolve('..');
const PROMPT = 'Use the app diagnostics and Neconyan\'s source code to find what causes this bug. Cite the files and lines you used, say what I can do about it for now, and draft a bug report if it is a bug in Neconyan.';
const PLANNER_HEAD = 'You choose which parts of Neconyan';
const BUG_REPORT = {
    title: 'Scratchpad stage label throws when the preview is missing',
    summary: 'The Scratchpad reply preview throws a TypeError while it is checking the source.',
    steps: ['Open Scratchpad', 'Turn on Neconyan source code', 'Send a message'],
    expected: 'The preview shows Checking Neconyan source code.',
    actual: 'The page throws <img src=x onerror=alert(1)> and the preview stays empty.',
    evidence: ['TypeError: Cannot read properties of undefined (reading \'stage\')'],
    sourceRefs: ['public/scripts/scratchpad/index.js:1764', '../config.yaml:1'],
    environment: { viewport: 'phone and desktop' },
};
const REPLY = [
    'The error comes from `stageLabel` in public/scripts/scratchpad/index.js.',
    '',
    '```neconyan-bug-report',
    JSON.stringify(BUG_REPORT, null, 2),
    '```',
    '',
    'For now, reload the page and send again.',
].join('\n');

/** A minified position that maps back to the stage label, when this checkout holds a fresh build. */
function builtPosition() {
    const dist = path.join(CHECKOUT, 'dist', 'frontend');
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'asset-manifest.json'), 'utf8'));
        const entry = manifest.assets?.['scripts/scratchpad/index.js'];
        const original = fs.readFileSync(path.join(CHECKOUT, 'public', 'scripts', 'scratchpad', 'index.js'), 'utf8');
        if (!entry?.map || fs.readFileSync(path.join(dist, 'scripts', 'scratchpad', 'index.js'), 'utf8') !== original) return null;
        if (!fs.existsSync(path.join(dist, entry.map))) return null;
        const minified = fs.readFileSync(path.join(dist, entry.output), 'utf8').split('\n');
        for (const [index, text] of minified.entries()) {
            const column = text.search(/["'`]inspecting-source["'`]/);
            if (column < 0) continue;
            const lines = original.split('\n');
            const line = lines.findIndex(value => value.includes('preview?.stage === \'inspecting-source\'')) + 1;
            return { output: entry.output, line: index + 1, column: column + 1, original: { line, text: lines[line - 1] } };
        }
    } catch {
        return null;
    }
    return null;
}

async function openScratchpad(page) {
    await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
    await expect(page.locator('.scratchpad-composer')).toBeEnabled();
}

async function useDurableConnection(page) {
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.locator('#scratchpad-connection-miso').selectOption('durable');
    await page.getByRole('checkbox', { name: /^Stream replies/ }).uncheck();
}

async function send(account, page, text) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.scratchpad-composer').fill(text);
    const [response] = await Promise.all([page.waitForResponse('**/api/scratchpad/send'), page.locator('.scratchpad-send').click()]);
    expect(response.ok(), await response.text()).toBe(true);
    await account.settled((await response.json()).job.id);
}

const textOf = call => call.messages.map(message => String(message.content)).join('\n');
const isPlanner = call => call.messages?.some(message => String(message.content).startsWith(PLANNER_HEAD));
const sourceBlock = text => {
    const start = text.indexOf('<neconyan_source>');
    return start < 0 ? '' : text.slice(start, text.indexOf('</neconyan_source>', start) + '</neconyan_source>'.length);
};

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} Neconyan source code looks up real source before the reply`, async ({ app }) => {
        test.setTimeout(420000);
        const size = phone ? 'phone' : 'desktop';
        const width = phone ? 393 : 1280;
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, activeConnection: true });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const provider = app.provider;
        const page = await account.open({ workspace: false });
        await acknowledgeActiveSettings(page);
        await page.evaluate(async avatar => {
            const core = await import('/script.js');
            await core.getCharacters();
            await core.selectCharacterById(core.characters.findIndex(character => character.avatar === avatar), { switchMenu: false });
        }, account.avatar);
        await openScratchpad(page);
        await useDurableConnection(page);
        if (phone) await applyIOSOnlyCss(page);

        const toggle = page.getByRole('checkbox', { name: /^Neconyan source code/ });
        const evidence = page.getByRole('checkbox', { name: /^App diagnostics/ });
        const previewButton = page.getByRole('button', { name: 'Show preview', exact: true });
        const note = page.locator('.scratchpad-source-preview-note');
        await expect(toggle).not.toBeChecked();
        await previewButton.click();
        await expect(page.locator('pre.scratchpad-preview-text')).toBeVisible();
        await expect(note).toHaveCount(0);

        // The default send makes no planning call and carries no source block.
        provider.mode.reply = { choices: [{ message: { content: 'A plain answer.' } }] };
        const before = provider.calls.length;
        const plain = `Plain question before the switch (${size})`;
        await send(account, page, plain);
        const plainCalls = provider.calls.slice(before);
        expect(plainCalls.filter(isPlanner)).toHaveLength(0);
        expect(plainCalls.filter(call => call.messages?.at(-1)?.content === plain)).toHaveLength(1);
        expect(plainCalls.map(textOf).join('\n')).not.toContain('<neconyan_source>');
        expect(plainCalls.map(textOf).join('\n')).not.toContain('Neconyan source code for this message:');
        await expect(page.locator('.scratchpad-source-lookup')).toHaveCount(0);

        // A real stack: a minified built frame and a dev frame without a source map.
        const built = builtPosition();
        const frames = [
            built ? `at stageLabel (${app.url}/frontend-assets/${built.output}:${built.line}:${built.column})` : `at stageLabel (${app.url}/frontend-assets/scripts/scratchpad/index-0123456789ab.js:1:1)`,
            `at renderSourceLookup (${app.url}/frontend-assets/scripts/scratchpad/source-findings-0123456789ab.js:1:1)`,
        ];
        await page.evaluate(stack => {
            const error = new TypeError('Cannot read properties of undefined (reading \'stage\')');
            error.stack = [`TypeError: ${error.message}`, ...stack.map(frame => `    ${frame}`)].join('\n');
            window.NeconyanCrashDiagnostics.capture('unhandled-rejection', error);
        }, frames);

        // The quick prompt turns on App diagnostics and Neconyan source code together.
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await page.getByRole('button', { name: 'Check Neconyan\'s code for this bug', exact: true }).click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Turned on App diagnostics and Neconyan source code for this session.' }).first()).toBeVisible();
        await expect(page.locator('.scratchpad-composer')).toHaveValue(PROMPT);
        await page.evaluate(() => window.toastr.clear());
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await expect(toggle).toBeChecked();
        await expect(evidence).toBeChecked();
        const row = toggle.locator('..');
        await row.scrollIntoViewIfNeeded();
        const box = await row.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 36);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await previewButton.click();
        await expect(note).toBeVisible();
        await expect(note).toContainText('public/scripts, public/script.js and src');
        await expect(page.locator('pre.scratchpad-preview-text')).toContainText('## Neconyan source code');
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            fs.mkdirSync(path.join('..', 'screenshots', 'scratchpad-source-lookup'), { recursive: true });
            await page.mouse.move(0, 0);
            await row.scrollIntoViewIfNeeded();
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join('..', 'screenshots', 'scratchpad-source-lookup', `${size}-context-after.png`) });
            await note.scrollIntoViewIfNeeded();
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join('..', 'screenshots', 'scratchpad-source-lookup', `${size}-preview-after.png`) });
        }

        // Two planning rounds: the first asks for a search and two unsafe reads, the second reads one more file and stops.
        let round = 0;
        provider.mode.reply = body => {
            if (body.messages?.some(message => String(message.content).startsWith(PLANNER_HEAD))) {
                round += 1;
                const plan = round === 1
                    ? { done: false, requests: [{ op: 'search', query: 'inspecting-source', prefix: 'public/scripts/scratchpad/' }, { op: 'read', path: 'config.yaml' }, { op: 'read', path: '../secrets.json' }, { op: 'list', prefix: 'data/' }] }
                    : { done: true, requests: [{ op: 'read', path: 'src/scratchpad/source-research.js', start: 1, end: 12 }] };
                return { choices: [{ message: { content: JSON.stringify(plan) } }] };
            }
            return { choices: [{ message: { content: REPLY } }] };
        };
        const start = provider.calls.length;
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();
        await expect(page.locator('.scratchpad-composer')).toHaveValue(PROMPT);
        const [response] = await Promise.all([page.waitForResponse('**/api/scratchpad/send'), page.locator('.scratchpad-send').click()]);
        expect(response.ok(), await response.text()).toBe(true);
        await account.settled((await response.json()).job.id);
        const calls = provider.calls.slice(start);
        const planners = calls.filter(isPlanner);
        expect(planners).toHaveLength(2);
        for (const planner of planners) {
            const text = textOf(planner);
            expect(text).toContain(PROMPT);
            expect(text).not.toContain('belongs to account');
            expect(text).not.toContain('## Character card');
            expect(text).not.toContain(CHECKOUT);
            expect(text).not.toContain(app.directory);
            expect(text).not.toMatch(/^listen:|^whitelist:|api_key_custom/m);
            expect(planner.body.tools ?? []).toEqual([]);
        }
        expect(textOf(planners[0])).toContain('Round 1 of 2.');
        expect(textOf(planners[1])).toContain('Round 2 of 2.');
        expect(textOf(planners[1])).toContain('search for "inspecting-source" in public/scripts/scratchpad/');

        const finals = calls.filter(call => call.messages?.at(-1)?.content === PROMPT);
        expect(finals).toHaveLength(1);
        const sent = textOf(finals[0]);
        expect(sent).toContain('Neconyan source code for this message:');
        const block = sourceBlock(sent);
        expect(block).toContain('Read-only source code from this Neconyan install');
        expect(block).toMatch(/^### public\/scripts\/scratchpad\/index\.js lines \d+-\d+ of \d+$/m);
        // With a fresh build the minified position maps to the exact line; without one the lookup falls back to the definition.
        const located = built
            ? [`${built.original.line}: ${built.original.text}`, `maps to public/scripts/scratchpad/index.js:${built.original.line}`]
            : ['function stageLabel(preview) {'];
        for (const expected of located) expect(block).toContain(expected);
        expect(block).toContain('exact line is unmapped');
        expect(block).toMatch(/^\d+: export function renderSourceLookup\(/m);
        expect(block).toContain('### Search for "inspecting-source" in public/scripts/scratchpad/');
        expect(block).toMatch(/^### src\/scratchpad\/source-research\.js lines 1-12 of \d+$/m);
        expect(block).not.toContain(CHECKOUT);
        expect(block).not.toContain(app.directory);
        expect(block).not.toMatch(/^### (config\.yaml|secrets\.json|data\/)/m);
        // The source sits just before the question, and the assistant keeps it literal.
        const index = finals[0].messages.findIndex(message => String(message.content).startsWith('<neconyan_source>'));
        expect(index).toBe(finals[0].messages.length - 3);

        // The reply lists the files it checked and turns the draft into a copyable card.
        const reply = page.locator('.scratchpad-message.is-assistant').last();
        const disclosure = reply.locator('details.scratchpad-source-lookup');
        await expect(disclosure.locator('summary')).toHaveText(/^Source files checked \(\d+\)$/);
        await disclosure.locator('summary').click();
        await expect(disclosure.locator('.scratchpad-source-path').first()).toBeVisible();
        const paths = await disclosure.locator('.scratchpad-source-path').allInnerTexts();
        expect(paths).toContain('public/scripts/scratchpad/index.js');
        expect(paths).toContain('src/scratchpad/source-research.js');
        expect(paths.join('\n')).not.toMatch(/config|secrets|data\//);
        const card = reply.locator('.scratchpad-bug-report');
        await expect(card).toBeVisible();
        await expect(card.locator('.scratchpad-bug-heading')).toHaveText(BUG_REPORT.title);
        await expect(card).toContainText('<img src=x onerror=alert(1)>');
        expect(await card.locator('img').count()).toBe(0);
        await expect(card).toContainText('public/scripts/scratchpad/index.js:1764');
        await expect(card).not.toContainText('../config.yaml');
        await expect(card).toContainText('Nothing is submitted automatically');
        await expect(reply.locator('.scratchpad-text')).toContainText(['The error comes from', 'For now, reload the page']);
        await card.scrollIntoViewIfNeeded();
        const geometry = await card.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, scroll: element.scrollWidth, client: element.clientWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedBugReport = text; } } });
        });
        const copy = card.getByRole('button', { name: 'Copy bug report' });
        const copyBox = await copy.boundingBox();
        expect(copyBox.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
        await copy.click();
        await expect(page.locator('#toast-container .toast').filter({ hasText: 'Bug report copied.' }).first()).toBeVisible();
        const copied = await page.evaluate(() => window.__copiedBugReport);
        expect(copied).toMatch(new RegExp(`^## ${BUG_REPORT.title}\\n`));
        expect(copied).toContain('### Steps to reproduce\n\n1. Open Scratchpad\n2. Turn on Neconyan source code\n3. Send a message');
        expect(copied).toContain('\\<img src=x onerror=alert(1)\\>');
        expect(copied).toContain('- `public/scripts/scratchpad/index.js:1764`');
        await page.evaluate(() => window.toastr.clear());
        if (process.env.NECONYAN_SCRATCHPAD_SCREENSHOTS === '1') {
            await page.mouse.move(0, 0);
            const shots = path.join('..', 'screenshots', 'scratchpad-source-lookup');
            await disclosure.evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(shots, `${size}-reply-after.png`) });
            await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(shots, `${size}-bug-report-after.png`) });
            await copy.evaluate(element => element.scrollIntoView({ block: 'center' }));
            await page.locator('#neconyan-scratchpad').screenshot({ path: path.join(shots, `${size}-bug-copy-after.png`) });
        }

        // Switching it off again goes back to the ordinary request.
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await toggle.uncheck();
        await expect(toggle).not.toBeChecked();
        await previewButton.click();
        await expect(page.locator('pre.scratchpad-preview-text')).toBeVisible();
        await expect(note).toHaveCount(0);
        provider.mode.reply = { choices: [{ message: { content: 'Another plain answer.' } }] };
        const after = provider.calls.length;
        await send(account, page, `Plain question after the switch (${size})`);
        const offCalls = provider.calls.slice(after);
        expect(offCalls.filter(isPlanner)).toHaveLength(0);
        expect(offCalls.map(textOf).join('\n')).not.toContain('<neconyan_source>');
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
}
