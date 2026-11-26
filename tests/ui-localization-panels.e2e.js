/* global document, window, localStorage */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(120000);

const readLocale = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

for (const [layout, viewport, hasTouch] of [
    ['desktop', { width: 1280, height: 900 }, false],
    ['phone', { width: 393, height: 852 }, true],
]) {
    // The test titles below are fixed; this description just distinguishes the two layouts.
    // eslint-disable-next-line playwright/valid-title
    test.describe(layout, () => {
        test.use({ viewport, hasTouch });
        test('panel headers, folder counts and included tools are shown in German', async ({ page }) => {
            const german = { ...await readLocale('../public/locales/de-de.json'), ...await readLocale('../public/locales/neconyan/de-de.json') };
            await page.addInitScript(() => localStorage.setItem('language', 'de-de'));
            await page.goto('/', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.body.classList.contains('neconyan-rail-ready'));
            const skip = page.locator('#neconyan-tour-coachmark [data-tour-coach-skip]');
            if (await skip.isVisible()) await skip.click();

            const checkpoint = page.locator('#message_template .mes_bookmark');
            await expect(checkpoint).toHaveAttribute('data-tooltip', german['Open checkpoint chat\nShift+Click to replace the existing checkpoint with a new one']);
            await expect(checkpoint.locator('.neconyan-action-label')).toHaveCount(1);

            const header = selector => page.locator(`#right-nav-panel > .sb-character-shell-header ${selector}`);
            const title = () => header('.sb-shell-title').evaluate(element => element.firstChild?.textContent?.trim());
            // The header copy is rewritten on every tab switch, after the page was first translated.
            for (const [tab, english] of [
                ['characters', ['Characters', 'Choose a character and start a little chat.']],
                ['persona', ['Persona', 'Edit your own persona here for roleplay and chats!']],
                ['characters', ['Characters', 'Choose a character and start a little chat.']],
            ]) {
                await page.evaluate(tab => window.NeconyanShell.openTab('characters', tab), tab);
                await expect.poll(title).toBe(german[english[0]]);
                await expect(header('.sb-shell-subtitle')).toHaveText(german[english[1]]);
            }

            await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
            await expect(page.locator('.neconyan-lorebook-folder').filter({ hasText: german.Unfiled })).toHaveCount(1);
            await expect(page.locator('.neconyan-lorebook-folder').filter({ hasText: 'Unfiled' })).toHaveCount(0);

            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            // New accounts may have Memory Shard switched on, so either status is right as long as it is German.
            const runStatus = [german['No automatic agents enabled'], german['Ready for the next reply']];
            await expect.poll(() => page.locator('#ica--run-status').textContent()).toMatch(new RegExp(`^(?:${runStatus.join('|')})$`));
            // The shared release account can remember Connections & defaults from another test.
            const manage = page.locator('#ica--workspaceNav').getByRole('tab', { name: german['Manage agents'], exact: true });
            await manage.click();
            await expect(manage).toHaveAttribute('aria-selected', 'true');
            const agentList = page.locator('#ica--panel-manage #ica--agentList');
            const clearFilters = agentList.locator('.ica--clear-agent-filters');
            if (await clearFilters.isVisible()) await clearFilters.click();
            const editAgent = agentList.locator('.ica--card-primary-actions .ica--btn-edit').filter({ visible: true }).first();
            await expect(editAgent).toHaveAttribute('title', german['Open the editor with every setting for this agent']);
            await editAgent.click();
            await expect(page.locator('#ica--editor-summary')).toContainText('Reihenfolge');
            await page.keyboard.press('Escape');
            await expect(page.locator('#ica--editor')).toHaveCount(0);

            await page.locator('#ica--templates').click();
            const library = page.locator('.ica--template-browser');
            await expect(library).toBeVisible();

            const libraryHeaderSubtitleKey = 'Add a single agent, or choose a starter kit.';
            const starterKitSubtitleKey = 'Install a complete set of agents at once. Existing agents are kept.';
            const createCustomKitDescKey = 'Save your current agents as a reusable kit.';
            const allTypesKey = 'All types';
            const kitManyKey = 'scoped.ica.kit_agent_many';
            const partCKeys = ['Pawthfinder', 'Mewmory', 'Meower', 'Pawspective', 'Termeownal UI', 'Purrks', 'Character Purrks'];
            for (const key of [
                libraryHeaderSubtitleKey,
                starterKitSubtitleKey,
                createCustomKitDescKey,
                allTypesKey,
                'Plot Compass',
                'Memory Shard',
                'Director\'s Commentary',
                ...partCKeys,
            ]) {
                expect(german[key], `missing German translation for ${key}`).toBeTruthy();
                expect(german[key], `untranslated English hold for ${key}`).not.toBe(key);
            }
            expect(german[kitManyKey]).toBeTruthy();
            expect(german[kitManyKey]).not.toBe('${0} agents');

            await expect(library.locator('.ica--library-header p')).toHaveText(german[libraryHeaderSubtitleKey]);
            const kitsDetails = library.locator('.ica--library-kits');
            if (!await kitsDetails.evaluate(el => el.hasAttribute('open'))) {
                await library.locator('.ica--library-kits > summary').click();
            }
            const starterKitSubtitle = library.locator('.ica--library-kits .ica--template-section-desc');
            await expect(starterKitSubtitle).toHaveText(german[starterKitSubtitleKey]);
            await expect(starterKitSubtitle).not.toContainText('installieren');
            const puraTrackersKit = library.locator('.ica--group-card').filter({ hasText: german['Pura\'s Trackers Only'] });
            await expect(puraTrackersKit).toHaveCount(1);
            const puraTrackersName = puraTrackersKit.locator('.ica--group-card-header strong');
            await expect(puraTrackersName).toHaveText(german['Pura\'s Trackers Only']);
            expect(await puraTrackersName.getAttribute('data-i18n-ignore')).toBeNull();
            const puraTrackersPill = puraTrackersKit.locator('.ica--group-card-header .ica--card-pill');
            await expect(puraTrackersPill).toHaveText(german[kitManyKey].replace('${0}', '16'));
            await expect(puraTrackersPill).toHaveAttribute('data-i18n-ignore', '');
            const puraTrackersDesc = puraTrackersKit.locator('.ica--group-card-desc');
            await expect(puraTrackersDesc).toHaveText(german['All tracker agents including interactive menus and profile sheets']);
            expect(await puraTrackersDesc.getAttribute('data-i18n-ignore')).toBeNull();
            await expect(library.locator('.ica--group-card-create .ica--group-card-desc')).toHaveText(german[createCustomKitDescKey]);
            await expect(library.locator('.ica--template-category-select option[value=""]')).toHaveText(german[allTypesKey]);

            const beatPlannerDescKey = 'Fast three-line plan for the next reply: what {{user}} just did, what {{char}} wants, one concrete next beat. Don\'t run it with: Intent Reader, Plot Compass, Scene Driving Force, Scene Pressure Cocktail, Combined Director\'s Cut, Chaos Mode.';
            const beatCard = library.locator('.ica--template-card[data-id="tpl-beat-planner"]');
            await expect.poll(() => beatCard.locator('.ica--template-card-name').evaluate(el => el.firstChild?.textContent?.trim())).toBe(german['Beat Planner']);
            await expect(beatCard.locator('.ica--template-card-description')).toHaveText(german[beatPlannerDescKey]);
            expect(german[beatPlannerDescKey]).not.toContain('Plot Compass');
            await expect(beatCard.locator('.ica--template-card-description')).not.toContainText('Plot Compass');
            expect(german[beatPlannerDescKey]).toContain('{{user}}');
            expect(german[beatPlannerDescKey]).toContain('{{char}}');

            for (const [id, nameKey] of [
                ['tpl-translator', 'Translator'],
                ['tpl-character-authenticity', 'Character Authenticity Checker'],
                ['tpl-position-tracker-companion', 'Position Tracker'],
                ['tpl-plot-compass-companion', 'Plot Compass'],
                ['tpl-memory-shard-companion', 'Memory Shard'],
                ['tpl-directors-commentary-companion', 'Director\'s Commentary'],
            ]) {
                const card = library.locator(`.ica--template-card[data-id="${id}"]`);
                await expect.poll(() => card.locator('.ica--template-card-name').evaluate(el => el.firstChild?.textContent?.trim())).toBe(german[nameKey]);
            }

            const itemTrackerDescKey = 'Track items {{user}} acquires, loses, or uses that have narrative significance';
            await expect(library.locator('.ica--template-card[data-id="tpl-item-tracker"] .ica--template-card-description')).toHaveText(german[itemTrackerDescKey]);

            await page.locator('dialog.popup:has(.ica--template-browser)').getByRole('button', { name: german['Close library'], exact: true }).click();
            await expect(library).toHaveCount(0);

            await page.evaluate(() => window.NeconyanShell.openTab('left', 'mewmory'));
            await expect(page.locator('#left-nav-panel .sb-shell-title')).toHaveText(german.Mewmory);
            await expect(page.locator('#mewmory-tab-pawspective')).toHaveText(german.Pawspective);
            await expect(page.getByText(german['No Roleplay chat selected'], { exact: true })).toBeVisible();

            await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
            await page.waitForFunction(() => document.querySelector('.vectors_settings'));
            await page.evaluate(label => window.NeconyanExtensions.focusUnit(label), german.Vectorization);
            await expect(page.locator('.vectors_settings')).toBeVisible();
            await expect(page.locator('#vectors_force_chunk_delimiter')).toHaveJSProperty('placeholder', german['Optional separator, including line breaks']);
            await expect(page.locator('.vectors-title')).toHaveText(german['Find the relevant bits']);
            await expect(page.locator('[data-vectors-state]')).toHaveText(german['Retrieval is off. You can still index sources and try a search.']);
            await page.evaluate(() => window.NeconyanExtensions.focusUnit('Quick Image Gen'));
            await expect(page.locator('#qig-settings')).toBeVisible();
            await expect(page.locator('#qig-status-meta')).toContainText(german['Review off']);
            await expect(page.locator('#qig-prompt-help')).toHaveText(german['Not used while Chat scene is selected; the selected chat messages become the scene.']);

            // Labels made of a phrase and a name are one translated phrase, written after the locale has loaded.
            const phrase = (key, name) => german[key].replace('${0}', german[name]);
            await page.evaluate(() => window.NeconyanShell.openTab('right', 'extensions'));
            await page.evaluate(label => window.NeconyanExtensions.focusUnit(label), german.Vectorization);
            const vectorsHeader = page.locator('.vectors_settings > .inline-drawer > .inline-drawer-header');
            const vectorsIcon = vectorsHeader.locator('.inline-drawer-icon');
            await expect(vectorsHeader).toBeVisible();
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Collapse ${0}', 'Vectorization'));
            await vectorsHeader.evaluate(header => header.click());
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Expand ${0}', 'Vectorization'));
            await vectorsHeader.evaluate(header => header.click());
            await expect(vectorsIcon).toHaveAttribute('aria-label', phrase('Collapse ${0}', 'Vectorization'));
            await expect(vectorsHeader.locator('.sb-extension-unit-pin')).toHaveAttribute('aria-label', phrase('Pin ${0}', 'Vectorization'));
            await expect(vectorsHeader.locator('.sb-extension-unit-pin')).toHaveAttribute('title', phrase('Pin ${0}', 'Vectorization'));
            const settingsShell = page.locator('#user-settings-block');
            await expect(settingsShell.locator('.sb-shell-close')).toHaveAttribute('aria-label', phrase('Close ${0}', 'Settings'));
            await expect(settingsShell.locator('.sb-shell-close')).toHaveAttribute('title', phrase('Close ${0}', 'Settings'));
            await expect(settingsShell.locator('.sb-shell-nav-scroll-left')).toHaveAttribute('aria-label', phrase('Scroll ${0} sections left', 'Settings'));
            await expect(settingsShell.locator('.sb-shell-nav-scroll-right')).toHaveAttribute('aria-label', phrase('Scroll ${0} sections right', 'Settings'));
            const modeButton = mode => page.locator(`#neconyan-workspace-rail [data-neconyan-chat-mode="${mode}"]`);
            await expect(modeButton('roleplay')).toHaveAttribute('title', phrase('${0} is active', 'Roleplay'));
            await expect(modeButton('meower')).toHaveAttribute('title', phrase('Use ${0}', 'Meower'));
            await expect(page.locator('#neconyan-workspace-rail [data-neconyan-chat-mode="meower"] > span:not([aria-hidden="true"])')).toHaveText(german.Meower);
            await expect(modeButton('story')).toHaveAttribute('title', phrase('Use ${0}', 'Story Mode'));
            await page.evaluate(() => {
                const tool = window.NeconyanNativeTools?.getTools?.()?.find(item => item.id === 'third-party/Neconyan-Terminal-UI');
                if (tool) window.NeconyanNativeTools.openSettings(tool);
            });
            await expect(settingsShell.locator('.sb-shell-title')).toHaveText(german['Termeownal UI']);
            await expect(page.locator('#option_toggle_purrks > span')).toHaveText(german['Character Purrks']);
            expect(german['Character Purrks']).toContain(german.Purrks);
            await page.evaluate(() => window.NeconyanShell.openTab('left', 'agents'));
            await expect(page.locator('#left-nav-panel .sb-shell-close')).toHaveAttribute('aria-label', phrase('Close ${0}', 'Agents'));
            const workspaceSelect = page.locator('#ica--workspaceSelect');
            if (await workspaceSelect.isVisible()) {
                await workspaceSelect.selectOption('connections');
            } else {
                await page.locator('#ica--workspaceNav .ica--workspace-tab[data-workspace-view="connections"]').click();
            }
            await expect(page.locator('#ica--pathfinder-group-title')).toBeVisible();
            await expect(page.locator('#ica--pathfinder-group-title')).toHaveText(german.Pawthfinder);
            if (await workspaceSelect.isVisible()) {
                await workspaceSelect.selectOption('manage');
            } else {
                await page.locator('#ica--workspaceNav .ica--workspace-tab[data-workspace-view="manage"]').click();
            }

            await page.evaluate(async () => {
                const { openTimeMachine } = await import('/scripts/extensions/third-party/Neconyan-Time-Machine/src/ui.js');
                void openTimeMachine();
            });
            await expect(page.locator('#sbctm-title')).toHaveText(german['Time Machine']);
            await expect(page.locator('.sbctm-actions button')).toHaveText(german['Snapshot everything now']);
            await expect(page.locator('.sbctm-detail > .sbctm-empty')).toHaveText(german['Pick something on the left to see its history.']);
            // Measure the actual phone popup rather than assuming it fits from its styles.
            const bounds = await page.locator('.sbctm').boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
        });
    });
}
