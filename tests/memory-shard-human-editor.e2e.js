/* global document, getComputedStyle, window */
import { expect, test } from '@playwright/test';
import { isolateSettingsSaves, settleCssTransitions } from './chat-scroll-regression-helpers.js';

test.use({ serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });
test.setTimeout(120000);

const SAMPLE_SHARD = [
    '# MEMORY SHARD: ASH-3',
    '',
    '## Current Snapshot',
    '- Location: Flooded chapel beneath the old conservatory',
    '- Time: Past midnight, heavy storm outside',
    '- Present: Aria, Thorne',
    '- Situation: Aria opened the iron strongbox and found her sister\'s wax seal.',
    '- Mood: Raw shock giving way to fragile truce',
    '- Physical: Aria\'s left forearm is bandaged; Thorne is soaked through',
    '- Next up: Confront the regent before dawn or cross the river',
    '',
    '## Tone & Atmosphere',
    'Gothic mystery with slow-burn tension, taut dialogue, and weathered candlelight.',
    '',
    '## Characters',
    '### Aria',
    '- Role: Protagonist and disinherited archivist',
    '- Appearance: Dark coat, singed cuff, bandaged left forearm',
    '- Personality: Sharp-tongued, loyal, slow to forgive',
    '- Status: Alive, injured left forearm, shaken but resolved',
    '',
    '## Relationships',
    '- Aria -> Thorne (fragile truce): Bitter betrayal softened after seeing the real seal.',
    '',
    '## Story Events',
    '### 1. [Critical] The Strongbox Revealed (Flooded Chapel)',
    '- What happened: Aria pried open the iron box and found her sister\'s unbroken seal beside Thorne\'s forged death writ.',
    '- Aftermath: Suspicion shifted from Thorne directly onto the regent.',
    '',
    '## Key Scenes',
    '### The Wax Seal in the Rain',
    'Water dripped from the cracked arches onto the iron lid as Aria turned the seal toward the flame.',
    '',
    '## Memorable Quotes & Voices',
    '- Aria: "You let me hate you for three winters just to keep her breathing." (quiet, incredulous)',
    '',
    '## Callbacks & Loose Threads',
    '- [Open] The missing second ledger: Still locked inside the regent\'s study.',
    '- [Planted] Silver ferry token: Tucked inside Aria\'s boot from the dockmaster.',
    '- [Resolved] The burned archive accusation: Proven to be a staged cover-up.',
].join('\n');

async function seedMemoryShardPanel(page, prefix, note) {
    return page.evaluate(async ({ prefix, note }) => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const response = await fetch('/scripts/extensions/in-chat-agents/templates/memory-shard-companion.json');
        const template = await response.json();
        const id = `${prefix}shard`;
        await store.saveAgent({
            ...template,
            id,
            sourceTemplateId: template.id,
            enabled: true,
        });
        const { chat } = await import('/script.js');
        const msgIndex = chat.length;
        chat.push({
            is_user: false,
            mes: 'Rain drummed against the stained glass while the lantern flickered.',
            extra: {
                inChatAgentCompanionResults: {
                    [id]: {
                        status: 'done',
                        agentName: template.name,
                        format: template.companion.format,
                        content: note,
                    },
                },
            },
        });
        const panelMod = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        panelMod.openCompanionPanel();
        return { id, msgIndex };
    }, { prefix, note });
}

async function cleanupSeededAgents(page, prefix) {
    await page.evaluate(async prefix => {
        const { getAgents, deleteAgent } = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        for (const agent of getAgents().filter(agent => agent.id.startsWith(prefix))) {
            await deleteAgent(agent.id);
        }
    }, prefix).catch(() => {});
}

for (const width of [393, 1280]) {
    test(`Memory Shard renders pretty HTML regex and edits by section at ${width}px`, async ({ browser }) => {
        const phone = width === 393;
        const context = await browser.newContext({
            viewport: { width, height: phone ? 852 : 900 },
            hasTouch: phone,
            serviceWorkers: 'block',
            reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        const prefix = `ms-human-${width}-`;

        try {
            await isolateSettingsSaves(page, settings => {
                settings.accountStorage = {
                    ...settings.accountStorage,
                    'NeconyanTutorialStatus.v1': 'skipped',
                    'NeconyanTutorialHidden.v1': 'true',
                };
            });
            await page.goto('/');
            await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
            await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...');

            const { id, msgIndex } = await seedMemoryShardPanel(page, prefix, SAMPLE_SHARD);

            const panel = page.locator('#ica--tracker-panel');
            const body = panel.locator(`.ica--tpanel-agent[data-agent-id="${id}"] .ica--tpanel-agent-body`);
            await expect(body.locator('.custom-ms-hero')).toBeVisible();
            await expect(body.locator('.custom-ms-hero-code')).toHaveText('ASH-3');
            await expect(body.locator('.custom-ms-sec-snapshot')).toBeVisible();
            await expect(body.locator('.custom-ms-sub.custom-ms-ev')).toHaveCount(1);
            await expect(body.locator('.custom-ms-tag-critical')).toHaveText('Critical');
            await expect(body.locator('.custom-ms-rel-pair')).toHaveCount(1);
            await expect(body.locator('.custom-ms-tag-open')).toHaveText('Open');
            await expect(body.locator('.custom-ms-tag-resolved')).toHaveText('Resolved');

            const renderedLayout = await body.evaluate(el => {
                const rect = el.getBoundingClientRect();
                const heroStyle = getComputedStyle(el.querySelector('.custom-ms-hero'));
                const snapshotList = el.querySelector('.custom-ms-sec-snapshot + ul');
                const snapshotDisplay = snapshotList ? getComputedStyle(snapshotList).display : '';
                const overflowNodes = [...el.querySelectorAll('.custom-ms-hero, .custom-ms-sec, .custom-ms-sub, ul, p')]
                    .filter(node => node.getBoundingClientRect().right > rect.right + 4)
                    .map(node => node.className || node.tagName);
                return {
                    panelOverflow: el.closest('#ica--tracker-panel').scrollWidth > el.closest('#ica--tracker-panel').clientWidth + 1,
                    heroBorderRadius: heroStyle.borderRadius,
                    snapshotDisplay,
                    overflowNodes,
                };
            });

            expect(renderedLayout.panelOverflow).toBe(false);
            expect(renderedLayout.heroBorderRadius).not.toBe('0px');
            expect(renderedLayout.snapshotDisplay).toBe('grid');
            expect(renderedLayout.overflowNodes).toEqual([]);

            // Open the human-friendly Memory Shard editor
            const editBtn = panel.locator(`.ica--tpanel-agent[data-agent-id="${id}"] [data-action="panel-edit-note"]`).first();
            await editBtn.click();

            const editor = page.locator('.ica--ms-editor');
            await expect(editor).toBeVisible();
            await expect(editor.locator('.ica--ms-editor-title-input')).toHaveValue('MEMORY SHARD: ASH-3');
            await expect(editor.locator('.ica--ms-editor-card')).toHaveCount(8);

            // First section (Current Snapshot) starts expanded; edit it cleanly
            const firstBody = editor.locator('.ica--ms-editor-card').first().locator('.ica--ms-editor-textarea');
            await expect(firstBody).toBeVisible();
            await firstBody.fill([
                '- Location: East Harbour Pier',
                '- Time: First light before dawn',
                '- Present: Aria, Thorne',
                '- Situation: Boarding the ferry with the wax seal.',
                '- Mood: Determined',
            ].join('\n'));

            // Add a custom section via the Add control
            await editor.locator('.ica--ms-editor-add-select').selectOption('custom');
            await editor.locator('.ica--ms-editor-add-btn').click();
            await expect(editor.locator('.ica--ms-editor-card')).toHaveCount(9);

            const addedCard = editor.locator('.ica--ms-editor-card').last();
            await addedCard.locator('.ica--ms-editor-section-heading').fill('Inventory');
            await addedCard.locator('.ica--ms-editor-textarea').fill('- Wax seal: Wrapped in oiled cloth inside Aria\'s coat pocket.');

            // Switch to Raw Markdown and confirm clean two-way sync
            await editor.locator('[data-ms-mode="raw"]').click();
            const rawTextarea = editor.locator('.ica--ms-editor-raw-textarea');
            await expect(rawTextarea).toBeVisible();
            const rawValue = await rawTextarea.inputValue();
            expect(rawValue).toContain('- Location: East Harbour Pier');
            expect(rawValue).toContain('## Inventory');
            expect(rawValue).toContain('Wrapped in oiled cloth');

            // Switch back to Sections and confirm no horizontal overflow in popup
            await editor.locator('[data-ms-mode="sections"]').click();
            const editorOverflow = await editor.evaluate(el => el.scrollWidth > el.clientWidth + 2);
            expect(editorOverflow).toBe(false);

            // Save and verify both stored plain Markdown and live HTML re-render
            await page.locator('.popup-button-ok').click();
            await expect(editor).toBeHidden();

            await expect(body.locator('.custom-ms-sec-snapshot + ul')).toContainText('East Harbour Pier');
            await expect(body.locator('.custom-ms-sec-custom .custom-ms-sec-title')).toHaveText('Inventory');

            const storedContent = await page.evaluate(async ({ msgIndex, id }) => {
                const { chat } = await import('/script.js');
                return chat[msgIndex]?.extra?.inChatAgentCompanionResults?.[id]?.content || '';
            }, { msgIndex, id });
            expect(storedContent).toContain('# MEMORY SHARD: ASH-3');
            expect(storedContent).toContain('- Location: East Harbour Pier');
            expect(storedContent).toContain('## Inventory');
        } finally {
            await cleanupSeededAgents(page, prefix);
            await context.close();
        }
    });
}

test('Memory Shard editor accent buttons maintain readable contrast across pale and dark accents', async ({ browser }) => {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const prefix = 'ms-accent-';

    try {
        await isolateSettingsSaves(page, settings => {
            settings.accountStorage = {
                ...settings.accountStorage,
                'NeconyanTutorialStatus.v1': 'skipped',
                'NeconyanTutorialHidden.v1': 'true',
            };
        });
        await page.goto('/');
        await page.waitForFunction(() => window.NeconyanShell && document.body.classList.contains('neconyan-rail-ready'));
        await expect(page.locator('#ica--run-status')).not.toHaveText('Loading your agents...', { timeout: 20000 });

        const { id } = await seedMemoryShardPanel(page, prefix, SAMPLE_SHARD);
        const panel = page.locator('#ica--tracker-panel');
        await panel.locator(`.ica--tpanel-agent[data-agent-id="${id}"] [data-action="panel-edit-note"]`).first().click();
        await expect(page.locator('.ica--ms-editor')).toBeVisible();

        const measureContrast = () => page.evaluate(() => {
            function sampleRgba(cssColor) {
                const canvas = document.createElement('canvas');
                canvas.width = 1;
                canvas.height = 1;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = cssColor;
                ctx.fillRect(0, 0, 1, 1);
                const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
                return [r, g, b];
            }
            function luminance([r, g, b]) {
                const toLin = v => {
                    const s = v / 255;
                    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                };
                return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
            }
            function ratio(fg, bg) {
                const l1 = luminance(fg);
                const l2 = luminance(bg);
                return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            }
            const activeTab = document.querySelector('.ica--ms-editor-mode-btn.is-active');
            const addBtn = document.querySelector('.ica--ms-editor-add-btn');
            const activeStyle = getComputedStyle(activeTab);
            const addStyle = getComputedStyle(addBtn);
            return {
                activeContrast: ratio(sampleRgba(activeStyle.color), sampleRgba(activeStyle.backgroundColor)),
                addContrast: ratio(sampleRgba(addStyle.color), sampleRgba(addStyle.backgroundColor)),
            };
        });

        const defaultContrast = await measureContrast();
        expect(defaultContrast.activeContrast, 'default active mode tab contrast').toBeGreaterThanOrEqual(4.5);
        expect(defaultContrast.addContrast, 'default add section button contrast').toBeGreaterThanOrEqual(4.5);

        const accentSamples = [
            { name: 'Mint Glass', rgba: 'rgba(110,231,183,1)' },
            { name: 'Plum Wine', rgba: 'rgba(126,34,206,1)' },
        ];

        for (const sample of accentSamples) {
            await page.evaluate(rgba => {
                const picker = document.querySelector('#sb-accent-primary-picker');
                if (picker) {
                    picker.dispatchEvent(new CustomEvent('change', { detail: { rgba }, bubbles: true }));
                }
            }, sample.rgba);
            await settleCssTransitions(page);
            const contrast = await measureContrast();
            expect(contrast.activeContrast, `${sample.name} active mode tab contrast`).toBeGreaterThanOrEqual(4.5);
            expect(contrast.addContrast, `${sample.name} add section button contrast`).toBeGreaterThanOrEqual(4.5);
        }
    } finally {
        await page.evaluate(() => {
            const preset = document.querySelector('.sb-accent-preset[data-accent="calico"], .sb-accent-preset[data-accent="default"]');
            if (typeof preset?.click === 'function') {
                preset.click();
            }
        }).catch(() => {});
        await cleanupSeededAgents(page, prefix);
        await context.close();
    }
});
