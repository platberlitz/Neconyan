import { MAX_EXPORT_WITH_BASELINES_BYTES } from '../constants.js';
import { button, element, errorMessage, field, replace, statusRegion } from '../dom.js';
import { adoptEmbeddedCases, findCharactersWithTests, PRIVACY_NOTICE, readEmbeddedCases, writeEmbeddedCases, embeddedSize } from '../embed.js';
import { getContext, readInstalledPreset } from '../host.js';
import * as lab from '../lab.js';
import { registerActiveTask } from '../operations.js';
import { reviewConnectionFields, withoutFields } from '../presets.js';
import { createDraft } from '../schema.js';
import { getSettings, isSettingsReadOnly, updateSettings } from '../settings.js';
import * as storage from '../storage.js';
import { buildExport, downloadExport, formatSize, parseImport, suggestedFileName } from '../transfer.js';

/**
 * Preferences, moving suites between installations, and storing tests inside a
 * character card.
 */
export function createSettingsTab({ onChanged = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let status = null;
    let embedHost = null;
    let fileInput = null;
    let includePresetsInput = null;
    let includeConnectionInput = null;
    let suites = [];
    let activeSuite = null;
    let reloadEpoch = 0;

    async function reload({ preferredSuiteId = '' } = {}) {
        const epoch = ++reloadEpoch;
        const suiteId = preferredSuiteId || activeSuite?.id;
        const nextSuites = await storage.listSuites();
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        const nextSuite = nextSuites.find(suite => suite.id === suiteId) ?? nextSuites[0] ?? null;
        const cases = nextSuite ? await lab.getSuiteCases(nextSuite) : [];
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        suites = nextSuites;
        activeSuite = nextSuite;
        replace(suiteSelect, ...nextSuites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        renderEmbedSection(cases);
    }

    async function exportSuite(includeBaselines) {
        if (!activeSuite) {
            status.textContent = 'Choose a suite to export.';
            return;
        }
        const suite = structuredClone(activeSuite);
        const includePresets = Boolean(includePresetsInput?.checked);
        const includeConnection = includePresets && Boolean(includeConnectionInput?.checked);
        if (includeBaselines) {
            // Baseline runs hold the full built prompts. The card-embedding
            // path refuses to share captures outright; here the user decides,
            // but only after being told what the file will hold.
            const confirmed = globalThis.confirm?.(
                'Baseline runs contain the complete prompts that were built, including chat messages, persona text, and lorebook entries. Anyone you give this file to can read them.\n\nExport them anyway?',
            );
            if (!confirmed) {
                status.textContent = 'Nothing was exported.';
                return;
            }
        }
        try {
            const cases = await lab.getSuiteCases(suite);
            let baselineRuns = null;
            if (includeBaselines) {
                baselineRuns = [];
                for (const runId of Object.values(suite.baselines ?? {})) {
                    const run = await storage.getRun(runId);
                    if (run) {
                        baselineRuns.push(run);
                    }
                }
            }
            const presets = await collectPresets(cases, { includePresets, includeConnection });
            const { text, size, kind } = buildExport(suite, cases, baselineRuns, presets);
            downloadExport(suggestedFileName(suite), text);
            status.textContent = `Exported ${cases.length} test case${cases.length === 1 ? '' : 's'} (${formatSize(size)})${kind === 'suite-with-baselines' ? ', including baseline runs' : ''}${presets.length ? `, with ${presets.length} preset${presets.length === 1 ? '' : 's'}` : ''}.`;
        } catch (error) {
            status.textContent = `The suite could not be exported: ${errorMessage(error)}`;
        }
    }

    /**
     * Copies the presets a suite depends on, so it still works elsewhere.
     * Settings that say where requests go are left out unless the user asks
     * for them, because they point at someone's private setup.
     */
    async function collectPresets(cases, { includePresets, includeConnection }) {
        if (!includePresets) {
            return [];
        }
        const wanted = new Map();
        for (const testCase of cases) {
            for (const ref of testCase.pins.presets) {
                wanted.set(`${ref.apiId}:${ref.name}`, ref);
            }
        }
        const presets = [];
        for (const ref of wanted.values()) {
            const payload = readInstalledPreset(ref.apiId, ref.name);
            if (!payload) {
                continue;
            }
            const fields = reviewConnectionFields(ref.apiId, payload);
            presets.push(createDraft({
                apiId: ref.apiId,
                name: ref.name,
                payload: includeConnection
                    ? payload
                    : withoutFields(payload, fields.map(entry => entry.field)),
            }));
        }
        return presets;
    }

    async function importFile(file) {
        let task = null;
        try {
            if (Number(file.size) > MAX_EXPORT_WITH_BASELINES_BYTES) {
                throw new Error(`That file is ${formatSize(file.size)}, which is larger than the ${formatSize(MAX_EXPORT_WITH_BASELINES_BYTES)} import limit.`);
            }
            task = registerActiveTask('suite import');
            const text = await file.text();
            const { suite, cases, baselineRuns, presets } = parseImport(text);
            const imported = await storage.saveImportBatch({ suite, cases, baselineRuns, presets });
            status.textContent = `Imported "${suite.name}" with ${cases.length} test case${cases.length === 1 ? '' : 's'}${baselineRuns.length ? ' and its baseline runs' : ''}${presets.length ? `. Its ${presets.length} preset${presets.length === 1 ? ' is' : 's are'} waiting on the Presets tab, ready to publish` : ''}.`;
            await reload({ preferredSuiteId: imported.suite.id });
            onChanged?.();
        } catch (error) {
            status.textContent = `That file could not be imported: ${errorMessage(error)}`;
        } finally {
            task?.release();
        }
    }

    function renderEmbedSection(suiteCases = []) {
        replace(embedHost);
        embedHost.append(element('p', { className: 'sbpl-field-label', text: 'Tests stored inside character cards' }));
        embedHost.append(element('p', { className: 'sbpl-settings-note', text: PRIVACY_NOTICE }));

        const context = getContext();
        const carriers = findCharactersWithTests(context);
        if (carriers.length) {
            const list = element('ul', { className: 'sbpl-case-list' });
            for (const carrier of carriers) {
                const item = element('li', { className: 'sbpl-case-item' });
                item.append(element('span', {
                    text: `${carrier.name}: ${carrier.count} test case${carrier.count === 1 ? '' : 's'}`,
                }));
                item.append(button('Copy into this suite', async () => {
                    if (!activeSuite) {
                        status.textContent = 'Create a suite first.';
                        return;
                    }
                    const suiteId = activeSuite.id;
                    const adopted = adoptEmbeddedCases(
                        readEmbeddedCases(context, carrier.avatar),
                        carrier.avatar,
                    );
                    const task = registerActiveTask('embedded case adoption');
                    try {
                        for (const testCase of adopted) {
                            await storage.saveCase(testCase);
                        }
                        await storage.updateSuite(suiteId, (suite) => {
                            const ids = adopted.map(item2 => item2.id);
                            suite.caseIds.push(...ids.filter(id => !suite.caseIds.includes(id)));
                        });
                        status.textContent = `Copied ${adopted.length} test case${adopted.length === 1 ? '' : 's'} from ${carrier.name}.`;
                        await reload();
                        onChanged?.();
                    } finally {
                        task.release();
                    }
                }, { className: 'menu_button sbpl-button' }));
                list.append(item);
            }
            embedHost.append(list);
        } else {
            embedHost.append(element('p', {
                className: 'sbpl-case-meta',
                text: 'No installed character card carries test cases.',
            }));
        }

        const avatars = [...new Set(suiteCases
            .map(testCase => testCase.pins.characterAvatar)
            .filter(Boolean))];
        let characterSelect = null;
        if (avatars.length > 1) {
            const names = new Map((context.characters ?? []).map(character => [character.avatar, character.name]));
            const nameCounts = new Map();
            for (const avatar of avatars) {
                const name = names.get(avatar) || avatar;
                nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
            }
            characterSelect = element('select', {
                className: 'text_pole sbpl-select',
                attributes: { 'aria-label': 'Character card to save this suite into' },
            });
            characterSelect.append(element('option', {
                text: 'Choose a character card',
                attributes: { value: '' },
            }));
            for (const avatar of avatars) {
                const name = names.get(avatar) || avatar;
                characterSelect.append(element('option', {
                    text: nameCounts.get(name) > 1 ? `${name} (${avatar})` : name,
                    attributes: { value: avatar },
                }));
            }
            embedHost.append(field('Character card', characterSelect, {
                hint: 'This suite uses several characters. Choose which card receives its own test cases.',
            }));
        }

        const saveInto = button('Save this suite into a character card', async () => {
            if (!activeSuite) {
                status.textContent = 'Choose a suite first.';
                return;
            }
            const avatar = avatars.length === 1 ? avatars[0] : characterSelect?.value;
            if (!avatar) {
                status.textContent = avatars.length
                    ? 'Choose which character card to save into.'
                    : 'None of these test cases has a character, so there is no card to save them into.';
                return;
            }
            const forCharacter = suiteCases
                .filter(item => item.pins.characterAvatar === avatar)
                .map(item => structuredClone(item));
            const size = embeddedSize(forCharacter);
            const existing = readEmbeddedCases(context, avatar);
            const confirmed = globalThis.confirm?.(
                `${PRIVACY_NOTICE}\n\n${forCharacter.length} test case${forCharacter.length === 1 ? '' : 's'} (${formatSize(size)}) will be saved into this card. ${existing.length ? `They will replace the ${existing.length} test case${existing.length === 1 ? '' : 's'} already stored there.` : 'Any Prompting Lab test cases already stored there will be replaced.'}\n\nReplace the card's stored test cases?`,
            );
            if (!confirmed) {
                status.textContent = 'Nothing was saved into the card.';
                return;
            }
            let task = null;
            try {
                task = registerActiveTask('character card embedding');
                await writeEmbeddedCases(context, avatar, forCharacter, { signal: task.signal });
                status.textContent = `Saved ${forCharacter.length} test case${forCharacter.length === 1 ? '' : 's'} into the card.`;
                renderEmbedSection(suiteCases);
            } catch (error) {
                status.textContent = `They could not be saved into the card: ${errorMessage(error)}`;
            } finally {
                task?.release();
            }
        }, { className: 'menu_button sbpl-button' });
        embedHost.append(saveInto);
    }

    function build() {
        root = element('div', { className: 'sbpl-settings-tab' });
        const readOnly = isSettingsReadOnly();
        const settings = getSettings();

        const retention = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '1', max: '200', step: '1' },
        });
        retention.value = String(settings.runRetention);
        retention.disabled = readOnly;
        retention.addEventListener('change', () => {
            const next = updateSettings({ runRetention: Number(retention.value) });
            retention.value = String(next.runRetention);
            status.textContent = `Keeping the newest ${next.runRetention} runs for each test case.`;
        });

        const depth = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '0', max: '20', step: '1', placeholder: 'Not set' },
        });
        depth.value = settings.manualCachingAtDepth === null ? '' : String(settings.manualCachingAtDepth);
        depth.disabled = readOnly;
        depth.addEventListener('change', () => {
            const raw = depth.value.trim();
            const next = updateSettings({ manualCachingAtDepth: raw === '' ? null : Number(raw) });
            depth.value = next.manualCachingAtDepth === null ? '' : String(next.manualCachingAtDepth);
            status.textContent = next.manualCachingAtDepth === null
                ? 'Prompt caching checks are turned off.'
                : `Prompt caching checks will assume a depth of ${next.manualCachingAtDepth}.`;
        });

        suiteSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Suite' } });
        suiteSelect.addEventListener('change', async () => {
            const suiteId = suiteSelect.value;
            const suite = suites.find(item => item.id === suiteId) ?? null;
            const epoch = ++reloadEpoch;
            activeSuite = suite;
            replace(embedHost);
            const cases = suite ? await lab.getSuiteCases(suite) : [];
            if (epoch !== reloadEpoch || activeSuite?.id !== suiteId || !root) {
                return;
            }
            renderEmbedSection(cases);
        });

        fileInput = element('input', {
            className: 'sbpl-file-input',
            attributes: { type: 'file', accept: 'application/json,.json', 'aria-label': 'Suite file to import' },
        });
        fileInput.addEventListener('change', async () => {
            const [file] = fileInput.files ?? [];
            if (file) {
                await importFile(file);
            }
            fileInput.value = '';
        });

        includePresetsInput = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        includeConnectionInput = element('input', { className: 'sbpl-checkbox', attributes: { type: 'checkbox' } });
        includeConnectionInput.disabled = true;
        includePresetsInput.addEventListener('change', () => {
            includeConnectionInput.disabled = !includePresetsInput.checked;
            if (!includePresetsInput.checked) {
                includeConnectionInput.checked = false;
            }
        });
        const presetChoice = element('label', { className: 'sbpl-field sbpl-field-inline' });
        presetChoice.append(includePresetsInput, element('span', {
            className: 'sbpl-field-label',
            text: 'Include the presets these tests use',
        }));
        const connectionChoice = element('label', { className: 'sbpl-field sbpl-field-inline' });
        connectionChoice.append(includeConnectionInput, element('span', {
            className: 'sbpl-field-label',
            text: 'Also include proxy and endpoint settings',
        }));

        const transfer = element('div', { className: 'sbpl-controls' });
        transfer.append(
            suiteSelect,
            button('Export suite', () => { void exportSuite(false); }, { className: 'menu_button sbpl-button' }),
            button('Export with baselines', () => { void exportSuite(true); }, { className: 'menu_button sbpl-button' }),
        );

        const danger = button('Delete all saved runs', async () => {
            const confirmed = globalThis.confirm?.(
                'This deletes every saved run, including the runs your baselines point at, so every suite starts over without baselines. Test cases and suites are kept. Continue?',
            );
            if (!confirmed) {
                return;
            }
            const task = registerActiveTask('run history deletion');
            try {
                for (const testCase of await storage.listCases()) {
                    for (const entry of await storage.listRuns(testCase.id)) {
                        await storage.deleteRun(testCase.id, entry.id);
                    }
                }
                // The baseline pointers now point at nothing; clearing them keeps
                // every suite honest about having no baselines any more.
                for (const suite of await storage.listSuites()) {
                    await storage.updateSuite(suite.id, (current) => {
                        current.baselines = {};
                    });
                }
                await reload();
                status.textContent = 'Deleted every saved run and cleared every baseline.';
                onChanged?.();
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });

        status = statusRegion('');
        embedHost = element('div', { className: 'sbpl-embed-section' });

        if (readOnly) {
            root.append(element('p', {
                className: 'sbpl-settings-note',
                text: 'These settings were saved by a newer Prompting Lab version and are read-only until this extension is updated. The stored settings have not been changed.',
                attributes: { role: 'status' },
            }));
        }
        root.append(
            field('Runs kept for each test case', retention, {
                hint: 'Older runs are removed to save space. A run set as a baseline is always kept.',
            }),
            field('Prompt caching depth', depth, {
                hint: 'Only needed for the caching check. Your server administrator sets this value; leave it empty to skip those checks.',
            }),
            element('p', { className: 'sbpl-field-label', text: 'Moving suites between installations' }),
            presetChoice,
            connectionChoice,
            transfer,
            field('Import a suite file', fileInput),
            embedHost,
            element('p', { className: 'sbpl-field-label', text: 'Clearing data' }),
            danger,
            status,
        );
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Suites could not be loaded: ${errorMessage(error)}`;
                });
            }
            return root;
        },
        refresh() {
            void reload().catch(() => {});
        },
        dispose() {
            reloadEpoch++;
            root?.remove();
            root = null;
        },
    };
}
