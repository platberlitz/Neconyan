/* global window, document, openBulkEditPopup, refreshAgentReferenceOptions, syncCategoryChips */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const agentPath = '../public/scripts/extensions/in-chat-agents/';
function declarations(path, names) {
    const source = read(path);
    return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
        .map(node => node.declaration ?? node)
        .filter(node => names.includes(node.id?.name) || node.declarations?.some(item => names.includes(item.id.name)))
        .map(node => source.slice(node.start, node.end)).join('\n');
}

for (const viewport of [{ width: 393, height: 852 }, { width: 1280, height: 900 }]) {
    test.describe(`agent editor DOM at ${viewport.width}px`, () => {
        test.use({ viewport, hasTouch: viewport.width === 393 });
        test.beforeEach(async ({ page }) => {
            page.on('pageerror', error => { throw error; });
            const popup = read('../public/index.html').match(/<template id="popup_template"[\s\S]*?<\/template>/)[0];
            const bulk = read(`${agentPath}settings.html`).match(/<template id="ica--bulkEditPopup"[\s\S]*?<\/template>/)[0];
            await page.setContent(`<button id="open">Edit selected agents</button>${popup}${bulk}<select multiple id="references" aria-label="Related agents"></select>
                <div id="ica--settings"><label class="ica--category-field">Category<select id="ica--categoryFilter"><option value="">All</option><option value="tracker">Trackers</option></select></label></div>`);
            await page.addScriptTag({ content: read('../public/lib/jquery-3.5.1.min.js') });
            await page.evaluate(() => {
                Object.assign(window, {
                    uuidv4: () => `popup-${window.popupId = (window.popupId ?? 0) + 1}`, runAfterAnimation: (element, action) => setTimeout(action, 0),
                    removeFromArray: (array, item) => array.splice(array.indexOf(item), 1), shouldSendOnEnter: () => true,
                    power_user: {}, toastPositionClasses: [], toastr: { options: {}, success() {}, info() {}, error() {} },
                    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
                    selectedAgentIds: new Set(['agent']), captureAgentSaveGuard: () => () => true,
                    record: { id: 'agent', injection: { role: 0 }, phase: 'pre', postProcess: {} },
                    getAgentById: () => window.record, lockBundledAgentCustomization: () => {},
                    saveAgentBatch: async changes => {
                        if (!window.acceptSave) throw new Error('Save failed. Try again.');
                        window.record = changes[0];
                    },
                    refreshSavedAgents: async () => {}, exitSelectMode: () => {},
                    normalizeStringIdList: values => [...new Set((values ?? []).map(value => value.trim()))],
                    renderAgentList: () => {},
                });
            });
            await page.addScriptTag({ content: [
                declarations('../public/scripts/utils.js', ['escapeHtml', 'clamp']),
                declarations('../public/scripts/popup.js', ['POPUP_TYPE', 'POPUP_RESULT', 'showPopupHelper', 'Popup', 'PopupUtils', 'fixToastrForDialogs', 'getTopmostModalLayer']),
                declarations(`${agentPath}index.js`, ['openBulkEditPopup', 'applyBulkEdit', 'refreshAgentReferenceOptions', 'syncCategoryChips']),
            ].join('\n') });
            await page.evaluate(() => { document.getElementById('open').onclick = () => { window.dialogFinished = openBulkEditPopup(); }; });
        });

        test('failed bulk saves retain the form, support retry and restore focus after Escape', async ({ page }) => {
            const opener = page.getByRole('button', { name: 'Edit selected agents' });
            await opener.click();
            const dialog = page.getByRole('dialog', { name: 'Edit selected agents' });
            const role = page.getByLabel('Injection Role');
            await expect(role).toBeFocused();
            await role.selectOption('1');
            await page.getByRole('button', { name: 'Apply changes' }).click();
            await expect(dialog.getByRole('alert')).toHaveText('Save failed. Try again.');
            await expect(role).toHaveValue('1');
            await expect(role).toBeEnabled();
            expect(await page.evaluate(() => window.record.injection.role)).toBe(0);
            await page.keyboard.press('Tab');
            expect(await page.evaluate(() => document.activeElement.closest('dialog') !== null)).toBe(true);
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(opener).toBeFocused();
            await opener.click();
            await page.getByLabel('Injection Role').selectOption('1');
            await page.evaluate(() => { window.acceptSave = true; });
            await page.getByRole('button', { name: 'Apply changes' }).click();
            await expect(dialog).toHaveCount(0);
            expect(await page.evaluate(() => window.record.injection.role)).toBe(1);
        });

        test('cleared reference selections stay empty and generated selections respect exact IDs', async ({ page }) => {
            await page.evaluate(() => {
                window.options = ['Agent-A', 'agent-a'].map(id => ({ id, name: id, referenceIds: [id] }));
                refreshAgentReferenceOptions(window.$('#references'), window.options, ['Agent-A']);
            });
            await expect(page.getByLabel('Related agents')).toHaveValues(['Agent-A']);
            await page.getByLabel('Related agents').selectOption([]);
            await page.evaluate(() => refreshAgentReferenceOptions(window.$('#references'), window.options, ['Agent-A']));
            await expect(page.getByLabel('Related agents')).toHaveValues([]);
            await page.evaluate(() => refreshAgentReferenceOptions(window.$('#references'), window.options, ['Agent-A'], ['agent-a']));
            await expect(page.getByLabel('Related agents')).toHaveValues(['agent-a']);
        });

        test('category controls follow the phone breakpoint without a list refresh', async ({ page }) => {
            await page.evaluate(() => syncCategoryChips(''));
            await page.setViewportSize({ width: 1280, height: 900 });
            await expect(page.getByRole('group', { name: 'Filter by category' })).toBeHidden();
            await page.setViewportSize({ width: 393, height: 852 });
            await expect(page.getByRole('group', { name: 'Filter by category' })).toBeVisible();
        });
    });
}
