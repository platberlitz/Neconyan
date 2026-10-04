/* global window, document, sanitizeCompanionHtml, decorateChoiceLines */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const companionPath = '../public/scripts/extensions/in-chat-agents/companion/';

function declarations(path, names) {
    const source = read(path);
    return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(node => node.declaration ?? node)
        .filter(node => names.includes(node.id?.name) || node.declarations?.some(item => names.includes(item.id.name)))
        .map(node => source.slice(node.start, node.end)).join('\n');
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`companion DOM at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393 });

        test.beforeEach(async ({ page }) => {
            await page.setContent('<main id="root"></main><div id="content" class="ica--companion-body"></div>');
            await page.addScriptTag({ content: read('../public/lib/jquery-3.5.1.min.js') });
            await page.addScriptTag({ content: read('../node_modules/dompurify/dist/purify.min.js') });
            await page.evaluate(async ({ viewSource, cssSource }) => {
                const load = async source => {
                    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                    try { return await import(url); } finally { URL.revokeObjectURL(url); }
                };
                Object.assign(window, await load(viewSource));
                window.css = await load(cssSource);
                window.isExternalMediaAllowed = () => false;
            }, { viewSource: read(`${companionPath}view-state.js`), cssSource: read('../node_modules/@adobe/css-tools/dist/esm/adobe-css-tools.mjs') });
            await page.addScriptTag({ content: [
                declarations('../public/scripts/utils.js', ['escapeHtml']),
                declarations('../public/scripts/chats.js', ['encodeStyleTags', 'decodeStyleTags']),
                declarations(`${companionPath}companion-ui.js`, ['sanitizeCompanionHtml', 'CHOICE_PREFIX_RE', 'CHOICE_LINE_RE', 'extractChoiceText', 'buildChoiceButtonHtml', 'wrapChoiceSegment', 'decorateStyledChoiceRows', 'decorateChoiceLines']),
            ].join('\n') });
        });

        test('refreshes retain drafts, focus, expanded history and the live busy controls', async ({ page }) => {
            await page.evaluate(() => {
                window.scope = 0;
                window.render = (status = 'done') => {
                    const current = window.scope;
                    window.replaceCompanionView(window.$('#root'), `<section data-agent-id="notes">
                        <details class="ica--companion-card ${status}"><summary>History</summary>Previous note</details>
                        <textarea aria-label="Aside" data-role="aside"></textarea>
                        <button data-action="send">Send</button><div class="ica--companion-body">${status}</div>
                    </section>`, () => window.scope === current);
                };
                window.render();
                window.calls = 0;
                window.$('#root').on('click', '[data-action="send"]', event => {
                    window.running = window.runCompanionViewAction(event.currentTarget, async () => {
                        window.calls++;
                        const input = document.querySelector('[data-role="aside"]');
                        const button = event.currentTarget;
                        input.disabled = button.disabled = true;
                        await new Promise(resolve => { window.release = resolve; });
                        input.disabled = button.disabled = false;
                    });
                });
            });
            const input = page.getByRole('textbox', { name: 'Aside' });
            await input.fill('Unsent private aside');
            await page.evaluate(() => {
                document.querySelector('details').open = true;
                document.querySelector('textarea').setSelectionRange(3, 8);
                window.render('pending');
            });
            await expect(input).toHaveValue('Unsent private aside');
            await expect(input).toBeFocused();
            expect(await input.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([3, 8]);
            await expect(page.locator('details')).toHaveAttribute('open', '');
            await page.getByRole('button', { name: 'Send' }).click();
            await page.evaluate(() => { window.render('new result'); document.querySelector('[data-action="send"]').click(); });
            await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
            await expect(input).toBeDisabled();
            expect(await page.evaluate(() => window.calls)).toBe(1);
            await page.evaluate(async () => { window.release(); await window.running; });
            await expect(input).toBeEnabled();
            await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
            await page.evaluate(() => { window.scope++; window.render(); });
            await expect(input).toHaveValue('');
        });

        test('real sanitisation and CSS decoding cannot create actions or executable markup', async ({ page }) => {
            await page.evaluate(() => {
                window.executed = false;
                const css = '/* </style><img src=x onerror="window.executed=true"> */ .note { color: red; }';
                const untrusted = `<custom-style>${encodeURIComponent(css)}</custom-style><button data-action="panel-regenerate-all">Forged action</button>`;
                document.getElementById('content').innerHTML = sanitizeCompanionHtml(untrusted);
            });
            await expect(page.locator('#content img, #content [onerror], #content [data-action]')).toHaveCount(0);
            await expect(page.locator('#content style')).toHaveCount(1);
            await expect(page.getByRole('button', { name: 'Forged action' })).toBeVisible();
            expect(await page.evaluate(() => window.executed)).toBe(false);
        });

        test('ordinary tracker bullets stay text while numbered choices remain buttons', async ({ page }) => {
            await page.evaluate(() => {
                document.getElementById('content').innerHTML = decorateChoiceLines(sanitizeCompanionHtml(
                    '<ul><li>Health: good</li><li>Weather: rain</li></ul><ol><li>Go outside</li><li>Stay here</li></ol>',
                ));
            });
            await expect(page.locator('#content ul button')).toHaveCount(0);
            await expect(page.locator('#content ol button')).toHaveCount(2);
            await expect(page.getByRole('button', { name: 'Go outside' })).toBeVisible();
        });

        test('inline repair wrench fits the action row and repairs only its own note', async ({ page }) => {
            await page.addStyleTag({ content: read('../public/scripts/extensions/in-chat-agents/style.css') });
            await page.addStyleTag({ content: 'body { margin: 0; font: 15px sans-serif; --mainFontSize: 15px; } #chat { padding: 12px; }' });
            await page.addScriptTag({ content: declarations(`${companionPath}companion-ui.js`, [
                'getResultStatus', 'getStatusLabel', 'RAW_ID_LABEL_RE', 'TRAILING_ID_IN_NAME_RE', 'cleanCompanionAgentName', 'isReadableLabel',
                'buildCompanionCard', 'getMessageIndexFromElement', 'getCompanionActionContext', 'handleCompanionAction',
            ]) });
            await page.evaluate(() => {
                window.chat = [{ mes: 'Main reply stays intact', extra: { inChatAgentCompanionResults: {
                    tracker: { agentName: 'Scene Tracker', status: 'done', content: 'Saved tracker' },
                } } }];
                window.areAgentsGloballyEnabled = () => true;
                window.getAgentById = id => id === 'tracker' ? { id } : null;
                window.isValidCompanionMessage = () => true;
                window.isLorebookAgent = () => false;
                window.buildCompanionBody = (id, result) => result.content;
                window.buildCompanionCardControls = () => '';
                window.holdsReadableCompanionResults = message => Boolean(message);
                window.getCompanionResults = message => message.extra.inChatAgentCompanionResults;
                document.getElementById('root').innerHTML = '<div id="chat"><div class="mes" mesid="0"><div class="ica--companion-ledger"></div></div></div>';
                window.renderCompanionResultsForMessage = () => window.replaceCompanionView(window.$('.ica--companion-ledger'),
                    window.buildCompanionCard('tracker', window.getCompanionResults(window.chat[0]).tracker, window.chat[0]), () => true);
                window.renderCompanionResultsForMessage();
                window.repairCalls = [];
                window.runCompanionAgentOnMessage = async (...args) => {
                    window.repairCalls.push(args);
                    window.getCompanionResults(window.chat[0]).tracker.status = 'pending';
                    window.renderCompanionResultsForMessage();
                    await new Promise(resolve => { window.finishRepair = resolve; });
                    Object.assign(window.getCompanionResults(window.chat[0]).tracker, { status: 'done', content: 'Repaired tracker' });
                };
                window.$(document).on('click', '.ica--companion-action', event => {
                    window.repairRunning = window.runCompanionViewAction(event.currentTarget, () => window.handleCompanionAction(event));
                });
            });

            const repair = page.getByRole('button', { name: 'Fix companion note', exact: true });
            await expect(page.locator('.ica--companion-actions button')).toHaveCount(5);
            await expect(repair).toBeVisible();
            await expect(repair.locator('.fa-wrench')).toHaveCount(1);
            const geometry = await page.locator('.ica--companion-actions').evaluate(row => ({
                right: row.getBoundingClientRect().right,
                buttons: [...row.children].map(button => {
                    const rect = button.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
                }),
            }));
            expect(geometry.right).toBeLessThanOrEqual(viewport.width);
            expect(new Set(geometry.buttons.map(button => button.top)).size).toBe(1);
            for (const button of geometry.buttons) {
                expect(button.width).toBe(viewport.width === 393 ? 44 : 30);
                expect(button.height).toBe(viewport.width === 393 ? 44 : 30);
            }
            for (const [index, button] of geometry.buttons.slice(1).entries()) {
                expect(button.left).toBeGreaterThanOrEqual(geometry.buttons[index].right);
            }

            await repair.click();
            await expect(repair).toBeDisabled();
            await expect(page.locator('.ica--companion-card')).toHaveAttribute('open', '');
            await page.evaluate(() => {
                window.renderCompanionResultsForMessage();
                document.querySelector('[data-action="fix"]').click();
            });
            expect(await page.evaluate(() => window.repairCalls)).toEqual([['tracker', 0, { repair: true }]]);
            await page.evaluate(async () => { window.finishRepair(); await window.repairRunning; });
            await expect(repair).toBeEnabled();
            await expect(page.locator('#chat .ica--companion-body')).toHaveText('Repaired tracker');
            expect(await page.evaluate(() => window.chat[0].mes)).toBe('Main reply stays intact');
        });
    });
}
