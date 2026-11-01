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
                declarations('../public/scripts/chats.js', ['isExternalMediaUrl', 'stripCssCommentsQuoteAware', 'unescapeCssText', 'extractCssUrls', 'hasExternalCssUrl', 'sanitizeInlineStyleExternalMedia', 'encodeStyleTags', 'decodeStyleTags', 'addDOMPurifyHooks']),
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

        test('the live panel lock updates immediately in both directions', async ({ page }) => {
            await page.evaluate(() => {
                document.getElementById('root').id = 'ica--tracker-panel';
                window.savedPanelState = new Map();
                window.panelTranslations = {};
                window.t = strings => window.panelTranslations[strings[0]] ?? strings[0];
                window.accountStorage = {
                    setItem: (key, value) => window.savedPanelState.set(key, value),
                };
                window.collectPanelAgentStates = () => [];
                window.areAgentsGloballyEnabled = () => false;
            });
            await page.addScriptTag({ content: [
                'let panelLocked = false, livePreview = null, panelSearchQuery = ""; const panelOpen = true, panelLauncher = "handle";',
                declarations(`${companionPath}companion-panel.js`, [
                    'PANEL_LOCK_STORAGE_KEY', 'storePanelLocked', 'isCompanionPanelLocked', 'setCompanionPanelLocked',
                    'buildPanelRunButtonHtml', 'buildPanelRunButtonsHtml', 'buildPanelHtml', 'handlePanelAction',
                ]),
                `window.panelRenders = 0;
                function renderPanel() {
                    window.panelRenders++;
                    window.replaceCompanionView(window.$('#ica--tracker-panel'), buildPanelHtml(), () => true);
                }
                renderPanel();
                window.$('#ica--tracker-panel').on('click', '[data-action]', event => {
                    window.lockAction = window.runCompanionViewAction(event.currentTarget, () => handlePanelAction(event));
                });
                window.panelIsLocked = isCompanionPanelLocked;`,
            ].join('\n') });
            await page.evaluate(() => {
                const panel = document.getElementById('ica--tracker-panel');
                panel.insertAdjacentHTML('beforeend', '<textarea data-role="aside" aria-label="Unsent aside"></textarea><details><summary>Earlier notes</summary>Saved note</details>');
                window.originalLockButton = panel.querySelector('[data-action="panel-lock"]');
            });
            const aside = page.getByRole('textbox', { name: 'Unsent aside' });
            await aside.fill('Keep this draft');
            await page.locator('summary').click();
            const lock = page.locator('[data-action="panel-lock"]');
            await lock.focus();
            await page.keyboard.press('Space');
            await page.evaluate(() => window.lockAction);
            await expect(lock).toBeFocused();
            await expect(lock).toHaveAttribute('aria-pressed', 'true');
            await expect(lock).toHaveAttribute('aria-label', 'Unlock panel');
            await expect(lock).toHaveAttribute('title', 'Unlock panel auto-close');
            await expect(lock).toHaveClass(/is-active/);
            await expect(lock.locator('i')).toHaveClass('fa-solid fa-lock');
            expect(await page.evaluate(() => window.panelIsLocked())).toBe(true);
            expect(await page.evaluate(() => window.savedPanelState.get('ica--tracker-panel-locked'))).toBe('true');

            await lock.click();
            await page.evaluate(() => window.lockAction);
            await expect(lock).toBeFocused();
            await expect(lock).toHaveAttribute('aria-pressed', 'false');
            await expect(lock).toHaveAttribute('aria-label', 'Lock panel');
            await expect(lock).toHaveAttribute('title', 'Keep panel open until unlocked');
            await expect(lock).not.toHaveClass(/is-active/);
            await expect(lock.locator('i')).toHaveClass('fa-solid fa-lock-open');
            expect(await page.evaluate(() => window.panelIsLocked())).toBe(false);
            expect(await page.evaluate(() => window.savedPanelState.get('ica--tracker-panel-locked'))).toBe('false');
            expect(await lock.evaluate(node => node === window.originalLockButton)).toBe(true);
            expect(await page.evaluate(() => window.panelRenders)).toBe(1);
            await expect(lock).not.toHaveAttribute('data-ica-busy', 'true');
            await expect(aside).toHaveValue('Keep this draft');
            await expect(page.locator('details')).toHaveAttribute('open', '');

            const translations = JSON.parse(read('../public/locales/neconyan/pt-pt.json'));
            await page.evaluate(translations => { window.panelTranslations = translations; }, translations);
            await lock.click();
            await page.evaluate(() => window.lockAction);
            await expect(lock).toHaveAttribute('aria-label', translations['Unlock panel']);
            await expect(lock).toHaveAttribute('title', translations['Unlock panel auto-close']);
            await lock.click();
            await page.evaluate(() => window.lockAction);
            await expect(lock).toHaveAttribute('aria-label', translations['Lock panel']);
            await expect(lock).toHaveAttribute('title', translations['Keep panel open until unlocked']);
        });

        test('real sanitisation and CSS decoding cannot create actions or executable markup', async ({ page }) => {
            await page.evaluate(() => {
                window.executed = false;
                const css = '/* </style><img src=x onerror="window.executed=true"> */ .note { color: red; }';
                const attrBreakoutCss = 'a { content: " > <b id=injected-from-style>ok</b>"; }';
                const svgCss = '/* <b id=injected-from-svg>ok</b> */ .note { color: blue; }';
                const untrusted = [
                    `<custom-style>${encodeURIComponent(css)}</custom-style>`,
                    `<div id="attr-holder" title='<custom-style>${encodeURIComponent(attrBreakoutCss)}</custom-style>'>safe</div>`,
                    `<svg><desc><custom-style>${encodeURIComponent(svgCss)}</custom-style></desc></svg>`,
                    '<button data-action="panel-regenerate-all">Forged action</button>',
                ].join('');
                document.getElementById('content').innerHTML = sanitizeCompanionHtml(untrusted);
            });
            await expect(page.locator('#content img, #content [onerror], #content [data-action], #content #injected-from-style, #content #injected-from-svg')).toHaveCount(0);
            await expect(page.locator('#content style')).toHaveCount(1);
            await expect(page.locator('#content svg style')).toHaveCount(0);
            await expect(page.getByRole('button', { name: 'Forged action' })).toBeVisible();
            expect(await page.evaluate(() => window.executed)).toBe(false);
        });

        test('ordinary tracker bullets stay text while numbered choices remain buttons and attribute <br> cannot break out', async ({ page }) => {
            await page.evaluate(() => {
                document.getElementById('content').innerHTML = decorateChoiceLines(sanitizeCompanionHtml([
                    '<ul><li>Health: good</li><li>Weather: rain</li></ul>',
                    '<ol><li>Go outside</li><li>Stay here</li></ol>',
                    '<p>1. First choice<br>2. Second choice</p>',
                    '<p><span id="attr-br" title="a<br>1. <b id=injected-choice>ok</b>">text</span></p>',
                ].join('')));
            });
            await expect(page.locator('#content ul button')).toHaveCount(0);
            await expect(page.locator('#content ol button')).toHaveCount(2);
            await expect(page.locator('#content p button.ica--choice-line')).toHaveCount(2);
            await expect(page.locator('#content #injected-choice')).toHaveCount(0);
            await expect(page.locator('#content #attr-br')).toHaveAttribute('title', 'a<br>1. <b id=injected-choice>ok</b>');
            await expect(page.getByRole('button', { name: 'Go outside' })).toBeVisible();
            await expect(page.getByRole('button', { name: '1. First choice' })).toBeVisible();
        });

        test('blocks outbound requests from inline styles, escaped CSS URLs, video poster and SVG image when external media is forbidden', async ({ page }) => {
            const externalRequests = [];
            await page.route('**/*', async route => {
                const reqUrl = route.request().url();
                if (reqUrl.includes('127.0.0.1:9999') || reqUrl.includes('example.invalid')) {
                    externalRequests.push(reqUrl);
                    await route.abort();
                    return;
                }
                await route.continue();
            });

            await page.evaluate(() => {
                window.getCurrentEntityId = () => 'test-entity';
                window.accountStorage = { getItem: () => 'true', setItem: () => {} };
                window.toastr = { warning: () => {}, clear: () => {} };
                window.t = strings => strings.join('');
                window.addDOMPurifyHooks();

                const payload = [
                    '<div id="inline-bg" style="color: rgb(12, 34, 56); background-image: url(http://127.0.0.1:9999/inline.png);">Styled</div>',
                    '<div id="var-imageset" style="--u: \'//127.0.0.1:9999/var-imageset.png\'; background-image: image-set(var(--u) 1x); width: 10px; height: 10px;">x</div>',
                    '<div id="comment-string" style="background-image: url(\'/local.png?a=/*\'), url(\'https://127.0.0.1:9999/comment-in-string.png?b=*/\'); width: 10px; height: 10px;">x</div>',
                    '<div id="escaped-quote" style="background-image: url(\'//127.0.0.1:9999/escaped-quote.png?a=\\\'\'); width: 10px; height: 10px;">x</div>',
                    '<div id="backslash-css" style="background-image: url(\'/\\\\127.0.0.1:9999/backslash-css.png\'); width: 10px; height: 10px;">x</div>',
                    '<style>@IMPORT "http://127\\2e 0\\2e 0\\2e 1:9999/imp.css"; @keyframes kf { from { background-image: url(http://127.0.0.1:9999/keyframes.png); } to { background-image: url(http://127.0.0.1:9999/keyframes.png); } } .custom-box { color: rgb(20, 40, 60); background-image: url(//127.0.0.1:9999/proto.png); animation: kf 1s infinite; } .custom-esc { background-image: url(http\\://127.0.0.1:9999/escaped.png); }</style>',
                    '<div class="box esc">Box</div>',
                    '<video id="vid" poster="http://127.0.0.1:9999/poster.png"></video>',
                    '<svg><image href="http://127.0.0.1:9999/svg.png"/></svg>',
                    '<img src="/\\127.0.0.1:9999/backslash-img.png">',
                    '<img src="https:127.0.0.1:9999/schemeless-https.png">',
                    '<input type="image" src="http://127.0.0.1:9999/input-image.png">',
                    '<table id="tbl" background="http://127.0.0.1:9999/table-bg.png"><tr><td id="cell" background="http://127.0.0.1:9999/td-bg.png">x</td></tr></table>',
                ].join('');
                document.getElementById('content').innerHTML = sanitizeCompanionHtml(payload);
            });

            await expect(page.locator('#content #inline-bg')).toHaveCSS('color', 'rgb(12, 34, 56)');
            await expect(page.locator('#content #inline-bg')).toHaveCSS('background-image', 'none');
            await expect(page.locator('#content .custom-box')).toHaveCSS('color', 'rgb(20, 40, 60)');
            await expect(page.locator('#content .custom-box')).toHaveCSS('background-image', 'none');
            await expect(page.locator('#content #vid')).not.toHaveAttribute('poster');
            await expect(page.locator('#content svg image')).toHaveCount(0);
            await expect(page.locator('#content img')).toHaveCount(0);
            await expect(page.locator('#content input[type="image"]')).toHaveCount(0);
            await expect(page.locator('#content #tbl')).not.toHaveAttribute('background');
            await expect(page.locator('#content #cell')).not.toHaveAttribute('background');
            expect(externalRequests).toHaveLength(0);
        });

        test('inline repair wrench fits the action row and repairs only its own note', async ({ page }) => {
            await page.addStyleTag({ content: read('../public/scripts/extensions/in-chat-agents/style.css') });
            await page.addStyleTag({ content: `body { margin: 0; font: 15px sans-serif; --mainFontSize: 15px; } #chat { padding: 12px; }
                /* Matches the phone chat column, so the action row meets the same space budget as the app. */
                .mes { max-width: ${viewport.width === 393 ? 243 : 1200}px; }` });
            await page.addScriptTag({ content: [
                declarations('../public/script.js', ['getShortModelName']),
                declarations(`${companionPath}../model-label.js`, ['MAIN_MODEL_LABEL', 'PLAIN_MODEL_ID_RE', 'formatAgentModelName', 'getAgentResultModelName']),
                declarations(`${companionPath}companion-ui.js`, [
                    'getResultStatus', 'getStatusLabel', 'RAW_ID_LABEL_RE', 'TRAILING_ID_IN_NAME_RE', 'cleanCompanionAgentName', 'isReadableLabel',
                    'buildCompanionCard', 'getMessageIndexFromElement', 'getCompanionActionContext', 'handleCompanionAction',
                ]),
            ].join('\n') });
            await page.evaluate(() => {
                window.power_user = { timestamp_model_name_short: true };
                window.chat = [{ mes: 'Main reply stays intact', extra: { inChatAgentCompanionResults: {
                    tracker: { agentName: 'Scene Tracker', model: 'fixture/companion-model', status: 'done', content: 'Saved tracker' },
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
            await expect(page.locator('.ica--companion-meta')).toHaveText('companion-model');
            await expect(page.locator('.ica--companion-meta')).toHaveAttribute('title', 'fixture/companion-model');
            await expect(page.locator('.ica--companion-actions button')).toHaveCount(5);
            await expect(repair).toBeVisible();
            await expect(repair.locator('.fa-wrench')).toHaveCount(1);
            const geometry = await page.locator('.ica--companion-card').evaluate(card => ({
                right: card.querySelector('.ica--companion-actions').getBoundingClientRect().right,
                cardLeft: card.getBoundingClientRect().left,
                cardRight: card.getBoundingClientRect().right,
                summaryRight: card.querySelector('.ica--companion-summary').getBoundingClientRect().right,
                buttons: [...card.querySelector('.ica--companion-actions').children].map(button => {
                    const rect = button.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
                }),
            }));
            expect(geometry.right).toBeLessThanOrEqual(viewport.width);
            expect(new Set(geometry.buttons.map(button => button.top)).size).toBe(1);
            for (const button of geometry.buttons) {
                expect(button.width).toBe(viewport.width === 393 ? 36 : 30);
                expect(button.height).toBe(viewport.width === 393 ? 36 : 30);
            }
            for (const [index, button] of geometry.buttons.slice(1).entries()) {
                expect(button.left).toBeGreaterThanOrEqual(geometry.buttons[index].right);
                expect(button.left - geometry.buttons[index].right).toBe(viewport.width === 393 ? 8 : 4);
            }
            const inset = Math.min(geometry.buttons[0].left - geometry.cardLeft, geometry.cardRight - geometry.buttons.at(-1).right);
            expect(inset).toBeGreaterThanOrEqual(8);
            expect(geometry.buttons.at(-1).right).toBeLessThanOrEqual(geometry.summaryRight);
            // The phone row shrinks the visible target, so an invisible pad has to keep it tappable.
            const padded = await page.evaluate(pad => [...document.querySelectorAll('.ica--companion-actions button')].map(button => {
                const rect = button.getBoundingClientRect();
                return document.elementFromPoint(rect.left - pad + 1, rect.top + rect.height / 2) === button;
            }), viewport.width === 393 ? 4 : 0);
            expect(padded.every(Boolean)).toBe(true);

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
