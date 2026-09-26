import { MAX_EXPORT_WITH_BASELINES_BYTES } from '../constants.js';
import { button, element, errorMessage, field, replace, statusRegion } from '../dom.js';
import { findCharactersWithTests, PRIVACY_NOTICE } from '../embed.js';
import { getContext } from '../host.js';
import * as lab from '../lab.js';
import { registerActiveTask } from '../operations.js';
import { mountSavedPromptingResults, runPromptingLab } from '../native.js';
import { getSettings, isSettingsReadOnly, updateSettings } from '../settings.js';
import * as storage from '../storage.js';
import { downloadExport, formatSize } from '../transfer.js';

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
    let reviewHost = null;
    const savedDisposers = [];

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
            const exported = await runPromptingLab('transfer', { operation: 'export', suiteId: suite.id, includeBaselines, includePresets, includeConnection });
            downloadExport(exported.fileName, exported.text);
            status.textContent = `Exported ${exported.caseCount} test cases (${formatSize(exported.size)}), with ${exported.presetCount} presets.`;
        } catch (error) {
            status.textContent = `The suite could not be exported: ${errorMessage(error)}`;
        }
    }

    async function importFile(file) {
        let task = null;
        try {
            if (Number(file.size) > MAX_EXPORT_WITH_BASELINES_BYTES) {
                throw new Error(`That file is ${formatSize(file.size)}, which is larger than the ${formatSize(MAX_EXPORT_WITH_BASELINES_BYTES)} import limit.`);
            }
            task = registerActiveTask('suite import');
            const text = await file.text();
            const imported = await runPromptingLab('transfer', { operation: 'import', text }, { signal: task.signal });
            status.textContent = `Imported '${imported.suite.name}' and its saved test definitions. Imported presets are available on the Presets tab.`;
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
                    const task = registerActiveTask('embedded case adoption');
                    try {
                        const adopted = await runPromptingLab('embed', { operation: 'adopt', suiteId, avatar: carrier.avatar }, { signal: task.signal });
                        status.textContent = `Copied ${adopted.cases.length} test cases from ${carrier.name}.`;
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

        const saveInto = button('Preview saving this suite into a character card', async () => {
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
            let task = null;
            try {
                task = registerActiveTask('character card embedding');
                const record = await runPromptingLab('embed', { operation: 'preview', suiteId: activeSuite.id, avatar }, { signal: task.signal, returnRecord: true });
                showEmbeddedProposal(record.result, record);
            } catch (error) {
                status.textContent = `They could not be saved into the card: ${errorMessage(error)}`;
            } finally {
                task?.release();
            }
        }, { className: 'menu_button sbpl-button' });
        embedHost.append(saveInto);
    }

    function showEmbeddedProposal(proposal, record) {
        replace(reviewHost, element('p', { text: `${proposal.count} tests (${formatSize(proposal.size)}) will replace ${proposal.previousCount} stored tests in ${proposal.avatar}.` }),
            button('Apply reviewed character tests', async () => {
                if (!globalThis.confirm?.(`${PRIVACY_NOTICE}\n\nApply these reviewed test definitions?`)) return;
                try {
                    await runPromptingLab('embed-apply', { proposalKey: record.key, resultHash: record.resultHash });
                    await getContext().getCharacters?.();
                    replace(reviewHost);
                    await reload();
                    status.textContent = 'The reviewed tests were saved into the character card.';
                } catch (error) { status.textContent = `The saved operation needs attention: ${errorMessage(error)}`; }
            }, { className: 'menu_button sbpl-button' }));
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
                await runPromptingLab('storage', { method: 'clearRuns', args: [] }, { signal: task.signal });
                await reload();
                status.textContent = 'Deleted every saved run and cleared every baseline.';
                onChanged?.();
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });

        status = statusRegion('');
        embedHost = element('div', { className: 'sbpl-embed-section' });
        reviewHost = element('div', { className: 'sbpl-embed-section' });

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
            reviewHost,
            element('p', { className: 'sbpl-field-label', text: 'Clearing data' }),
            danger,
            status,
        );
        savedDisposers.push(mountSavedPromptingResults(root, { kind: 'embed', operation: 'preview', label: 'Saved character test proposals',
            onResult: showEmbeddedProposal, onError: error => { status.textContent = errorMessage(error); } }));
        const savedTransfer = element('div', { className: 'sbpl-controls' });
        root.append(savedTransfer);
        savedDisposers.push(mountSavedPromptingResults(root, { kind: 'transfer', label: 'Saved suite transfers', onResult: result => {
            savedTransfer.replaceChildren();
            if (typeof result.text === 'string') savedTransfer.append(button('Download saved suite export', () => downloadExport(result.fileName, result.text)));
            else if (result.suite) { status.textContent = `Imported suite: ${result.suite.name}`; void reload({ preferredSuiteId: result.suite.id }); }
        }, onError: error => { status.textContent = errorMessage(error); } }));
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
            savedDisposers.splice(0).forEach(dispose => dispose());
            root?.remove();
            root = null;
        },
    };
}
