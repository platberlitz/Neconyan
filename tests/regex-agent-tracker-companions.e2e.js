/* global document, getComputedStyle, window, Node */
import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { acknowledgeSettingsSave } from './chat-scroll-regression-helpers.js';

for (const phone of [true, false]) {
    const deviceName = phone ? 'phone' : 'desktop';
    test(`tracker companion previews preserve their layout on ${deviceName}`, async ({ browser }, info) => {
        test.setTimeout(180000);
        const context = await browser.newContext({
            baseURL: info.project.use.baseURL,
            viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 },
            ...(phone ? { isMobile: true, hasTouch: true } : {}),
            serviceWorkers: 'block', reducedMotion: 'reduce',
        });
        try {
            const page = await context.newPage();
            await page.route('**/api/characters/all', route => route.fulfill({ json: [] }));
            await page.route('**/api/settings/get', async route => {
                const response = await route.fetch();
                const data = await response.json();
                const settings = JSON.parse(data.settings || await readFile(new URL('../default/content/settings.json', import.meta.url), 'utf8'));
                settings.firstRun = false;
                settings.extension_settings ||= {};
                settings.extension_settings.disabledExtensions = [...new Set([...(settings.extension_settings.disabledExtensions || []), 'third-party/Neconyan-Time-Machine'])];
                settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped', WelcomePage_PanelMode: 'full' };
                await route.fulfill({ response, json: { ...data, settings: JSON.stringify(settings) } });
            });
            await page.route('**/api/settings/save', route => acknowledgeSettingsSave(route));
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.querySelector('#rat_drawer') && !document.querySelector('#preloader'));
            await page.evaluate(() => window.NeconyanShell.openIncludedTool('third-party/Neconyan-Regex-Agent-Themes'));
            await page.locator('#rat_toggle_browse').click();
            await page.locator('#rat_drawer [data-focus-key="stage-next"]').click();
            const picker = page.locator('#rat_preview_archetype');
            for (const [value, label, expectedKey] of [
                ['position', 'Position Tracker', 'position'],
                ['visual-map', 'Visual Map', 'visual-map'],
                ['vitals', 'Vitals', 'vitals'],
                ['clothing', 'Clothing Tracker', 'clothing'],
                ['plot-compass', 'Plot Compass', 'plot-compass'],
                ['terminal', 'Terminal', 'level-up'],
            ]) {
                await expect(picker.locator(`option[value="${value}"]`)).toHaveText(label);
                await picker.selectOption(value);
                await expect(page.locator(`#rat_drawer [data-rat-key="${expectedKey}"]`).first()).toBeVisible();
            }
            await picker.selectOption('clothing');
            await expect(page.locator('#rat_drawer [data-clothing-outfit]').first()).toBeVisible();
            await picker.selectOption('plot-compass');
            await expect(page.locator('#rat_drawer [data-pc-card="1"]').first()).toBeVisible();

            // Verify the installed Clothing Tracker and bundled Plot Compass template through the real formatter.
            await expect.poll(() => page.evaluate(async () => {
                const { getAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const installed = getAgents().filter(agent => agent.sourceTemplateId === 'tpl-clothing-tracker-companion');
                return installed.map(agent => ({ enabled: agent.enabled, execution: agent.execution, phase: agent.phase }));
            })).toEqual([{ enabled: false, execution: 'companion', phase: 'post' }]);
            const storedNote = await page.evaluate(async () => {
                const { getAgents, loadAgents } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const { formatCompanionContent } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
                const { SAMPLES } = await import('/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js');
                const originalAgents = getAgents();
                const agent = originalAgents.find(item => item.sourceTemplateId === 'tpl-clothing-tracker-companion');
                const render = content => formatCompanionContent(agent.id, { content, format: 'html', status: 'done' });
                const note = document.createElement('div');
                note.innerHTML = render(SAMPLES.clothing.full);

                const plotTemplate = await fetch('/scripts/extensions/in-chat-agents/templates/plot-compass-companion.json').then(r => r.json());
                const transientPlotAgent = {
                    ...structuredClone(plotTemplate),
                    id: 'rat-e2e-plot-compass',
                    sourceTemplateId: plotTemplate.id,
                    enabled: true,
                    postProcess: { promptTransformEnabled: false },
                };
                const plotResult = { content: SAMPLES['plot-compass'].full, format: 'markdown', status: 'done' };
                const ctx = window.SillyTavern.getContext();
                const syntheticMessage = {
                    mes: 'Reply',
                    name: 'Mira',
                    is_user: false,
                    extra: { inChatAgentCompanionResults: { [transientPlotAgent.id]: plotResult } },
                };
                loadAgents([...originalAgents, transientPlotAgent], { fromServer: false });
                ctx.chat.push(syntheticMessage);
                let plotNode;
                let plotFallback;
                try {
                    plotNode = document.createElement('div');
                    plotNode.innerHTML = formatCompanionContent(transientPlotAgent.id, plotResult, syntheticMessage);
                    plotFallback = formatCompanionContent(transientPlotAgent.id, { content: 'Bring a sealed letter into the scene.', format: 'markdown', status: 'done' }, syntheticMessage);
                } finally {
                    ctx.chat.pop();
                    loadAgents(originalAgents, { fromServer: false });
                }
                return {
                    wearers: [...note.querySelectorAll('[data-clothing-wearer]')].map(el => el.textContent),
                    empty: render('tracker-none'),
                    plotMeta: {
                        version: plotTemplate.version,
                        enabled: plotTemplate.enabled,
                        execution: plotTemplate.execution,
                        phase: plotTemplate.phase,
                        format: plotTemplate.companion?.format,
                        regexCount: plotTemplate.regexScripts?.length ?? 0,
                    },
                    plotCard: Boolean(plotNode.querySelector('[data-pc-card="1"]')),
                    plotChoices: plotNode.querySelectorAll('button.ica--plot-choice').length,
                    plotSuggested: [...plotNode.querySelectorAll('.ica--plot-choice-tag')].map(el => el.textContent.trim()),
                    plotFallbackHasCard: plotFallback.includes('data-pc-card="1"'),
                    plotFallbackText: plotFallback,
                };
            });
            expect(storedNote.wearers).toEqual([expect.stringMatching(/^(?!.*\{\{user\}\}).+$/), 'Mira', 'Léa O’Connor']);
            expect(storedNote.empty).toBe('');
            expect(storedNote.plotMeta).toEqual({
                version: 2,
                enabled: false,
                execution: 'companion',
                phase: 'post',
                format: 'markdown',
                regexCount: 10,
            });
            expect(storedNote.plotCard).toBe(true);
            expect(storedNote.plotChoices).toBe(3);
            expect(storedNote.plotSuggested).toEqual(['Suggested']);
            expect(storedNote.plotFallbackHasCard).toBe(false);
            expect(storedNote.plotFallbackText).toContain('Bring a sealed letter into the scene.');

            // Keep the real formatter and app styles, but show the cards together
            // so the stock and themed screenshots use the same sample data and layout.
            await page.evaluate(() => {
                for (const child of document.body.children) child.style.display = 'none';
                for (const element of [document.documentElement, document.body]) {
                    for (const [property, value] of [['height', 'auto'], ['max-height', 'none'], ['overflow', 'visible'], ['position', 'static']]) {
                        element.style.setProperty(property, value, 'important');
                    }
                }
                const host = document.createElement('main');
                host.id = 'tracker-captures';
                host.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:18px;padding:20px;background:#202129;color:#eee;min-height:100vh;box-sizing:border-box';
                document.body.append(host);
            });
            const directory = new URL('../screenshots/', import.meta.url);
            await mkdir(directory, { recursive: true });
            const appearanceChecks = [];
            for (const [stage, slug] of [['before', null], ['after', 'obsidian-ink'], ['after-light', 'delft-porcelain']]) {
                await page.evaluate(async selected => {
                    const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                    const { mountPreview } = await import(`${base}preview.js`);
                    const { getTheme } = await import(`${base}themes/index.js`);
                    const host = document.querySelector('#tracker-captures');
                    host.textContent = '';
                    for (const [archetype, label] of [['position', 'Position Tracker'], ['visual-map', 'Visual Map'], ['vitals', 'Vitals'], ['clothing', 'Clothing Tracker'], ['plot-compass', 'Plot Compass']]) {
                        const section = document.createElement('section');
                        section.dataset.capture = archetype;
                        section.style.cssText = 'min-width:0;align-self:start';
                        const heading = document.createElement('h2');
                        heading.textContent = label;
                        heading.style.cssText = 'font:600 16px system-ui;color:#eee;margin:0 0 12px';
                        section.append(heading);
                        const card = document.createElement('div');
                        section.append(card);
                        host.append(section);
                        mountPreview(card, archetype, selected ? getTheme(selected) : null);
                    }
                }, slug);
                const screenshot = new URL(`regex-companions-${stage}-${deviceName}.png`, directory).pathname;
                await page.screenshot({ path: screenshot, fullPage: true });
                await info.attach(`${stage} ${deviceName}`, { path: screenshot, contentType: 'image/png' });
                for (const value of ['Harbour at dusk', 'Mira', 'Tavern', 'Docks', 'Health', '23', 'Bruised ribs', 'Sheltered']) {
                    await expect(page.locator('#tracker-captures')).toContainText(value);
                }
                const outfits = page.locator('[data-capture="clothing"] [data-clothing-outfit]');
                await expect(outfits).toHaveCount(3);
                await expect(outfits.nth(0)).toContainText('Rain-darkened navy coat');
                await expect(outfits.nth(1)).toContainText('Mira');
                await expect(outfits.nth(1)).toContainText('Cream jumper');
                await expect(outfits.nth(2)).toContainText('Léa O’Connor');
                await expect(outfits.nth(2)).toContainText('Wool waistcoat');
                const bounds = await page.evaluate(() => {
                    const host = document.querySelector('#tracker-captures');
                    return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
                        sections: [...host.children].map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })) };
                });
                expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
                for (const section of bounds.sections) expect(section.scroll).toBeLessThanOrEqual(section.width + 1);
                const fontSizes = await page.evaluate(() => ['position', 'vitals'].map(key => {
                    const card = document.querySelector(`[data-capture="${key}"] .mes_text > div`);
                    return getComputedStyle(card).fontSize;
                }));
                const inheritedInk = await page.evaluate(() => {
                    const elements = [...document.querySelectorAll('#tracker-captures small, #tracker-captures i')]
                        .filter(element => element.style.color === 'inherit');
                    return {
                        count: elements.length,
                        mismatches: elements.filter(element => getComputedStyle(element).color !== getComputedStyle(element.parentElement).color)
                            .map(element => element.outerHTML),
                        weather: getComputedStyle(document.querySelector('[data-capture="position"] small')).color,
                        positionInk: getComputedStyle(document.querySelector('[data-capture="position"] .mes_text > div')).color,
                    };
                });
                const clothingAppearance = await page.locator('[data-capture="clothing"] [data-clothing-card]').evaluate(card => {
                    const { color, background } = getComputedStyle(card);
                    const rows = [...card.querySelectorAll('[data-clothing-outfit]')];
                    const chips = [...card.querySelectorAll('[data-clothing-item]')];
                    return {
                        color, background,
                        chips: rows.map(row => [...row.querySelectorAll('[data-clothing-item]')].map(chip => [...chip.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim())),
                        icons: rows.map(row => [...row.querySelectorAll('[data-clothing-item]')].map(chip => [...chip.querySelectorAll('svg[data-clothing-icon]')].map(icon => icon.dataset.clothingIcon).join())),
                        iconsDrawn: [...card.querySelectorAll('svg')].every(icon => {
                            const box = icon.getBoundingClientRect();
                            return box.width >= 12 && box.height >= 12 && icon.querySelector('path')?.getAttribute('d')?.length > 100
                                && getComputedStyle(icon).fill === getComputedStyle(icon.parentElement).color;
                        }),
                        fits: rows.every(row => row.scrollWidth <= row.clientWidth + 1)
                            && chips.every(chip => chip.scrollWidth <= chip.clientWidth + 1),
                        readable: rows.every(row => [...row.children].every(child => getComputedStyle(child).color === color))
                            && chips.every(chip => getComputedStyle(chip).color === color),
                    };
                });
                expect(clothingAppearance.chips).toEqual([
                    ['Rain-darkened navy coat', 'grey trousers', 'leather boots'],
                    ['Cream jumper with rolled sleeves', 'brass watch'],
                    ['Wool waistcoat', 'ink-stained cuffs', 'blue neckerchief'],
                ]);
                expect(clothingAppearance.icons).toEqual([
                    ['outerwear', 'bottoms', 'footwear'],
                    ['top', 'jewellery'],
                    ['top', 'other', 'neckwear'],
                ]);
                expect(clothingAppearance.iconsDrawn).toBe(true);
                expect(clothingAppearance.fits).toBe(true);
                expect(clothingAppearance.readable).toBe(true);
                const plotAppearance = await page.locator('[data-capture="plot-compass"] [data-pc-card="1"]').evaluate(card => {
                    const { color, backgroundColor } = getComputedStyle(card);
                    const opts = [...card.querySelectorAll('[data-pc-opts="1"] > div')];
                    const rose = card.querySelector('svg');
                    const roseBox = rose?.getBoundingClientRect();
                    return {
                        color,
                        backgroundColor,
                        options: opts.length,
                        roseDrawn: Boolean(roseBox && roseBox.width >= 16 && roseBox.height >= 16),
                        fits: card.scrollWidth <= card.clientWidth + 1 && opts.every(opt => opt.scrollWidth <= opt.clientWidth + 1),
                    };
                });
                expect(plotAppearance.options).toBe(3);
                expect(plotAppearance.roseDrawn).toBe(true);
                expect(plotAppearance.fits).toBe(true);
                appearanceChecks.push({ fontSizes, inheritedInk, clothingAppearance, plotAppearance });
            }
            expect(appearanceChecks.map(check => check.fontSizes)).toEqual(Array(3).fill(appearanceChecks[0].fontSizes));
            expect(new Set(appearanceChecks.map(check => check.clothingAppearance.background)).size).toBe(3);
            expect(appearanceChecks[1].clothingAppearance.color).not.toBe(appearanceChecks[2].clothingAppearance.color);
            expect(new Set(appearanceChecks.map(check => check.plotAppearance.backgroundColor)).size).toBe(3);
            expect(appearanceChecks[1].plotAppearance.color).not.toBe(appearanceChecks[2].plotAppearance.color);
            for (const { inheritedInk } of appearanceChecks.slice(1)) {
                expect(inheritedInk.count).toBeGreaterThan(10);
                expect(inheritedInk.mismatches).toEqual([]);
                expect(inheritedInk.weather).toBe(inheritedInk.positionInk);
            }
            const measurements = await page.evaluate(() => {
                const root = document.querySelector('[data-capture="visual-map"]');
                const here = root.querySelector('[data-vm-d="here"]');
                const east = root.querySelector('[data-vm-d="east"]');
                const vitals = document.querySelector('[data-capture="vitals"]');
                return {
                    here: here && { x: here.getBoundingClientRect().x, y: here.getBoundingClientRect().y },
                    east: east && { x: east.getBoundingClientRect().x, y: east.getBoundingClientRect().y },
                    fills: [...vitals.querySelectorAll('[style*="width:"]')].map(element => ({ style: element.getAttribute('style'), width: getComputedStyle(element).width })),
                };
            });
            expect(measurements.here).not.toBeNull();
            expect(measurements.east).not.toBeNull();
            expect(measurements.east.x).toBeGreaterThan(measurements.here.x);
            for (const width of [23, 41, 57, 78, 90]) {
                expect(measurements.fills.some(fill => fill.style.includes(`width:${width}%`) && parseFloat(fill.width) > 0)).toBe(true);
            }
            const mapStyles = () => page.evaluate(() => {
                const root = document.querySelector('[data-capture="visual-map"]');
                return [...root.querySelectorAll('[data-vm-d]')].map(element => {
                    const style = getComputedStyle(element);
                    return { column: style.gridColumnStart, background: style.backgroundColor, shadow: style.boxShadow };
                });
            });
            const firstMap = await mapStyles();
            expect(firstMap.map(place => place.column)).toEqual(['2', '3']);
            await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const { mountPreview } = await import(`${base}preview.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                const host = document.createElement('section');
                document.querySelector('#tracker-captures').append(host);
                mountPreview(host, 'visual-map', getTheme('obsidian-ink'));
            });
            expect(await mapStyles()).toEqual(firstMap);

            const plotStyles = () => page.evaluate(() => {
                const card = document.querySelector('[data-capture="plot-compass"] [data-pc-card="1"]');
                const style = getComputedStyle(card);
                return { backgroundColor: style.backgroundColor, color: style.color, borderColor: style.borderTopColor };
            });
            const firstPlot = await plotStyles();
            await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const { mountPreview } = await import(`${base}preview.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                const host = document.createElement('section');
                document.querySelector('#tracker-captures').append(host);
                mountPreview(host, 'plot-compass', getTheme('obsidian-ink'));
            });
            expect(await plotStyles()).toEqual(firstPlot);

            // Exercise the additional selectors used by the real chat, including Tide's
            // phone rules, rather than relying on the gallery wrapper alone.
            await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const { mountPreview } = await import(`${base}preview.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                document.querySelector('#chat').id = 'original-chat-for-capture';
                document.body.classList.remove('documentstyle', 'echostyle', 'whisperstyle', 'hushstyle', 'ripplestyle');
                document.body.classList.add('tidestyle');
                const chat = document.createElement('div');
                chat.id = 'chat';
                chat.style.cssText = 'display:block;position:relative;width:100%;height:auto;max-height:none;overflow:visible';
                document.querySelector('#tracker-captures').append(chat);
                for (const [archetype, slug] of [['position', 'delft-porcelain'], ['visual-map', 'obsidian-ink'], ['vitals', 'delft-porcelain'], ['clothing', 'delft-porcelain'], ['plot-compass', 'obsidian-ink'], ['terminal', 'obsidian-ink']]) {
                    const message = document.createElement('div');
                    message.className = 'mes';
                    message.dataset.chatCapture = archetype;
                    const block = document.createElement('div');
                    block.className = 'mes_block';
                    message.append(block);
                    chat.append(message);
                    mountPreview(block, archetype, getTheme(slug));
                }
            });
            for (const [archetype, value] of [['position', 'Rain easing'], ['visual-map', 'Docks'], ['vitals', 'Bruised ribs'], ['clothing', 'Wool waistcoat'], ['plot-compass', 'Have the courier pause under the bridge lamp'], ['terminal', 'LEVEL UP CONFIRMED']]) {
                const message = page.locator(`#chat [data-chat-capture="${archetype}"]`);
                await expect(message).toContainText(value);
                await expect(message.locator('[data-rat]').first()).toBeVisible();
            }
            const chatDetails = await page.evaluate(() => {
                const chat = document.querySelector('#chat');
                const weather = chat.querySelector('[data-chat-capture="position"] small');
                const mapHere = chat.querySelector('[data-chat-capture="visual-map"] [data-vm-d="here"]');
                const mapEast = chat.querySelector('[data-chat-capture="visual-map"] [data-vm-d="east"]');
                const terminal = chat.querySelector('[data-chat-capture="terminal"] [data-rat-key="level-up"]');
                const terminalCursor = terminal?.querySelector('.custom-rat-tw-cursor');
                const terminalDots = terminal?.querySelector('.custom-rat-tw-dots');
                return {
                    weather: getComputedStyle(weather).color,
                    weatherParent: getComputedStyle(weather.parentElement).color,
                    hereColumn: getComputedStyle(mapHere).gridColumnStart,
                    eastColumn: getComputedStyle(mapEast).gridColumnStart,
                    terminalLists: terminal?.querySelectorAll('ul, ol, li, p').length ?? -1,
                    terminalStrong: terminal?.querySelectorAll('.custom-rat-tw-out strong').length ?? 0,
                    terminalCursor: terminalCursor ? getComputedStyle(terminalCursor, '::after').content : '',
                    terminalDotsGap: terminalDots ? parseFloat(getComputedStyle(terminalDots).gap) : 0,
                    terminalOverflow: terminal ? terminal.scrollWidth - terminal.clientWidth : 999,
                };
            });
            expect(chatDetails.weather).toBe(chatDetails.weatherParent);
            expect(chatDetails.hereColumn).toBe('2');
            expect(chatDetails.eastColumn).toBe('3');
            expect(chatDetails.terminalLists).toBe(0);
            expect(chatDetails.terminalStrong).toBeGreaterThanOrEqual(3);
            expect(chatDetails.terminalCursor).toContain('\u258e');
            expect(chatDetails.terminalDotsGap).toBeGreaterThan(2);
            expect(chatDetails.terminalOverflow).toBeLessThanOrEqual(1);

            // Verify both terminal companion templates end-to-end when installed, reconciled,
            // themed across dark/light/adaptive modes, rendered in companion notes & panel
            // containers (plus Echo chat style), and reverted cleanly to stock.
            await page.route('**/api/in-chat-agents/save', route => route.fulfill({ json: { ok: true } }));
            await page.route('**/api/in-chat-agents/delete', route => route.fulfill({ json: { ok: true } }));
            const terminalLifecycle = await page.evaluate(async () => {
                const base = '/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/';
                const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
                const { formatCompanionContent } = await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js');
                const { applyAll, reconcile } = await import(`${base}apply.js`);
                const { updateSettings } = await import(`${base}settings.js`);
                const { SAMPLES } = await import(`${base}samples.js`);
                const { STOCK } = await import(`${base}stock.js`);
                const { getTheme } = await import(`${base}themes/index.js`);
                const { mountPreview } = await import(`${base}preview.js`);

                const ids = ['tpl-user-based-stats-generator', 'tpl-level-up-companion'];
                const installed = [];
                for (const templateId of ids) {
                    let agent = store.getAgents().find(item => item.sourceTemplateId === templateId);
                    if (!agent) {
                        const slug = templateId.slice(4);
                        const tpl = await (await fetch(`/scripts/extensions/in-chat-agents/templates/${slug}.json`)).json();
                        agent = {
                            ...structuredClone(tpl),
                            id: `test-${templateId}`,
                            sourceTemplateId: templateId,
                            sourceTemplateVersion: tpl.version ?? 1,
                            enabled: false,
                        };
                        await store.saveAgent(agent);
                    }
                    installed.push(agent.id);
                }

                updateSettings({
                    theme: 'obsidian-ink',
                    autoReapply: true,
                    options: {
                        restyleBold: false,
                        glyphs: 'theme',
                        openDefaults: 'theme',
                    },
                });
                const rec = await reconcile();

                const host = document.createElement('div');
                host.style.cssText = 'display:flex;flex-direction:column;gap:12px;width:100%;max-width:100%;margin-top:16px';
                document.querySelector('#tracker-captures').append(host);

                const renderAndMeasure = (agentId, sample, containerClass, prefix) => {
                    const box = document.createElement('div');
                    box.className = containerClass;
                    box.style.cssText = 'width:100%;max-width:100%;box-sizing:border-box';
                    box.innerHTML = formatCompanionContent(
                        agentId,
                        { content: sample, format: 'markdown', status: 'done' },
                        undefined,
                        prefix,
                    );
                    host.append(box);
                    const root = box.querySelector('[data-rat-arch="terminal"]');
                    const details = root?.querySelector('details');
                    const summary = details?.querySelector('summary');
                    const openAfter = summary ? getComputedStyle(summary, '::after').content : '';
                    if (details) details.open = false;
                    const closedAfter = summary ? getComputedStyle(summary, '::after').content : '';
                    if (details) details.open = true;
                    return {
                        found: Boolean(root),
                        key: root?.dataset.ratKey || '',
                        overflow: root ? root.scrollWidth - root.clientWidth : 999,
                        lists: root ? root.querySelectorAll('ul, ol, li, p').length : -1,
                        strongCount: root ? root.querySelectorAll('.custom-rat-tw-out strong').length : 0,
                        openAfter,
                        closedAfter,
                    };
                };

                const notesStats = renderAndMeasure(installed[0], SAMPLES['user-stats'].full, 'ica--companion-body', '.ica--companion-body ');
                const panelLevel = renderAndMeasure(installed[1], SAMPLES['level-up'].full, 'ica--tpanel-agent-body', '.ica--tpanel-agent-body ');

                // Switch themes (light + adaptive) and verify live theme changes.
                updateSettings({ theme: 'delft-porcelain' });
                await applyAll({ force: true });
                const lightStats = store.getAgents().find(item => item.id === installed[0]).regexScripts[0].replaceString;
                updateSettings({ theme: 'adaptive-accent' });
                await applyAll({ force: true });
                const adaptiveLevel = store.getAgents().find(item => item.id === installed[1]).regexScripts[0].replaceString;

                // Exercise Echo chat style + options (all-closed, glyphs: none, restyleBold: true).
                document.body.classList.remove('tidestyle');
                document.body.classList.add('echostyle');
                const echoHost = document.createElement('div');
                echoHost.className = 'mes';
                const echoBlock = document.createElement('div');
                echoBlock.className = 'mes_block';
                echoHost.append(echoBlock);
                document.querySelector('#chat').append(echoHost);
                mountPreview(echoBlock, 'terminal', getTheme('obsidian-ink'), {
                    openDefaults: 'all-closed',
                    glyphs: 'none',
                    restyleBold: true,
                });
                const echoRoot = echoBlock.querySelector('[data-rat-key="level-up"]');
                const echoChecks = {
                    closed: echoRoot?.querySelector('details')?.open === false,
                    noDots: echoRoot?.querySelector('.custom-rat-tw-dots') === null,
                    noCursor: echoRoot?.querySelector('.custom-rat-tw-cursor') === null,
                    styledBold: echoRoot?.querySelectorAll('strong[data-rat-arch="bold"]').length ?? 0,
                    overflow: echoRoot ? echoRoot.scrollWidth - echoRoot.clientWidth : 999,
                };

                // Revert back to exact stock replaceStrings via settings.theme = 'stock' + applyAll().
                updateSettings({ theme: 'stock' });
                const rev = await applyAll();
                const revertedExact = ids.every((templateId, idx) => {
                    const current = store.getAgents().find(item => item.id === installed[idx]);
                    const stock = STOCK.filter(item => item.templateId === templateId);
                    return stock.length === 2 && stock.every(s => current.regexScripts.find(r => r.id === s.scriptId)?.replaceString === s.replaceString);
                });
                for (const id of installed) {
                    if (id.startsWith('test-')) await store.deleteAgent(id);
                }
                return {
                    recRepaired: rec.repaired,
                    notesStats,
                    panelLevel,
                    lightHasSlug: lightStats.includes('data-rat="delft-porcelain@'),
                    adaptiveHasSlug: adaptiveLevel.includes('data-rat="adaptive-accent@'),
                    echoChecks,
                    revReverted: rev.reverted,
                    revertedExact,
                };
            });

            expect(terminalLifecycle.recRepaired).toBeGreaterThanOrEqual(2);
            expect(terminalLifecycle.notesStats.found).toBe(true);
            expect(terminalLifecycle.notesStats.key).toBe('user-stats');
            expect(terminalLifecycle.notesStats.overflow).toBeLessThanOrEqual(1);
            expect(terminalLifecycle.notesStats.lists).toBe(0);
            expect(terminalLifecycle.notesStats.strongCount).toBeGreaterThanOrEqual(5);
            expect(terminalLifecycle.notesStats.openAfter).toContain('[open]');
            expect(terminalLifecycle.notesStats.closedAfter).toContain('[closed]');
            expect(terminalLifecycle.panelLevel.found).toBe(true);
            expect(terminalLifecycle.panelLevel.key).toBe('level-up');
            expect(terminalLifecycle.panelLevel.overflow).toBeLessThanOrEqual(1);
            expect(terminalLifecycle.panelLevel.lists).toBe(0);
            expect(terminalLifecycle.panelLevel.strongCount).toBeGreaterThanOrEqual(3);
            expect(terminalLifecycle.panelLevel.openAfter).toContain('[open]');
            expect(terminalLifecycle.panelLevel.closedAfter).toContain('[closed]');
            expect(terminalLifecycle.lightHasSlug).toBe(true);
            expect(terminalLifecycle.adaptiveHasSlug).toBe(true);
            expect(terminalLifecycle.echoChecks).toEqual({
                closed: true,
                noDots: true,
                noCursor: true,
                styledBold: expect.any(Number),
                overflow: expect.any(Number),
            });
            expect(terminalLifecycle.echoChecks.styledBold).toBeGreaterThanOrEqual(3);
            expect(terminalLifecycle.echoChecks.overflow).toBeLessThanOrEqual(1);
            expect(terminalLifecycle.revReverted).toBeGreaterThanOrEqual(2);
            expect(terminalLifecycle.revertedExact).toBe(true);
        } finally {
            await context.close();
        }
    });
}
