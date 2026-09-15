import { STATUS, STATUS_LABEL } from '../constants.js';
import { compareRuns } from '../compare.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { collapseUnchanged, diffSection, isUnchanged, PART } from '../diff.js';
import { loadHost } from '../host.js';
import { macroConfigDiffers } from '../integrations/macroenhanced.js';
import * as lab from '../lab.js';
import { registerActiveTask } from '../operations.js';
import { CC_API_ID, isSupportedApiId, labelForApiId, PRESET_API_IDS } from '../presets.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

/**
 * Compares two runs of the same test case and shows what changed, section by
 * section, with the token cost of each change. The two runs can be two moments
 * in time, or the same test case built twice under two setups.
 */
const LETTERS = 'ABCDEF';
const MAX_SETUPS = LETTERS.length;

export function createDiffTab() {
    let root = null;
    let suiteSelect = null;
    let caseSelect = null;
    let baseSelect = null;
    let compareSelect = null;
    let rawToggle = null;
    let output = null;
    let status = null;
    let setupHost = null;
    let rowsHost = null;
    let summaryHost = null;
    let addSetupButton = null;
    let setupRunButton = null;
    let setupStopButton = null;
    let setups = [];

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let activeCase = null;
    let runIndex = [];
    let renderSeq = 0;
    let reloadEpoch = 0;
    let setupRunEpoch = 0;
    let setupController = null;
    let running = false;

    async function reload(epoch = ++reloadEpoch) {
        const suiteId = activeSuite?.id;
        const nextSuites = await storage.listSuites();
        if (epoch !== reloadEpoch || !root) {
            return;
        }
        suites = nextSuites;
        activeSuite = nextSuites.find(suite => suite.id === suiteId) ?? nextSuites[0] ?? null;
        replace(suiteSelect, ...nextSuites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        await reloadCases(epoch);
    }

    async function reloadCases(epoch = ++reloadEpoch) {
        const suite = activeSuite;
        const caseId = activeCase?.id;
        const savedSetups = setups.map(entry => entry.read());
        renderSeq++;
        const nextCases = suite ? await lab.getSuiteCases(suite) : [];
        if (epoch !== reloadEpoch || activeSuite?.id !== suite?.id || !root) {
            return;
        }
        cases = nextCases;
        activeCase = nextCases.find(item => item.id === caseId) ?? nextCases[0] ?? null;
        replace(caseSelect, ...nextCases.map(item => element('option', {
            text: item.name,
            attributes: { value: item.id },
        })));
        if (activeCase) {
            caseSelect.value = activeCase.id;
        }
        renderSetups(activeCase?.id === caseId ? savedSetups : []);
        await reloadRuns({}, epoch);
    }

    /**
     * @param {{base?: string, compare?: string}} [preferred] runs to select
     *   instead of whatever was chosen before, used after a setup comparison.
     */
    async function reloadRuns({ base = '', compare = '' } = {}, epoch = ++reloadEpoch) {
        // A refresh must not silently swap a pair of runs the user chose.
        const previousBase = base || baseSelect.value;
        const previousCompare = compare || compareSelect.value;
        const suite = activeSuite;
        const testCase = activeCase;
        renderSeq++;
        const nextRunIndex = testCase ? await storage.listRuns(testCase.id) : [];
        if (epoch !== reloadEpoch
            || activeSuite?.id !== suite?.id
            || activeCase?.id !== testCase?.id
            || !root) {
            return;
        }
        runIndex = nextRunIndex;
        const has = id => nextRunIndex.some(entry => entry.id === id);
        const baselineId = suite?.baselines?.[testCase?.id ?? ''] ?? '';
        const options = nextRunIndex.map(entry => element('option', {
            text: `${entry.variantLabel ? `${entry.variantLabel} · ` : ''}${describeWhen(entry.startedAt)} · ${STATUS_LABEL[entry.status] ?? entry.status}${entry.id === baselineId ? ' · baseline' : ''}`,
            attributes: { value: entry.id },
        }));
        replace(baseSelect, ...options.map(node => node.cloneNode(true)));
        replace(compareSelect, ...options);

        if (has(previousBase)) {
            baseSelect.value = previousBase;
        } else if (baselineId && has(baselineId)) {
            baseSelect.value = baselineId;
        } else if (nextRunIndex.length > 1) {
            baseSelect.value = nextRunIndex[1].id;
        }
        if (has(previousCompare)) {
            compareSelect.value = previousCompare;
        } else if (nextRunIndex.length) {
            compareSelect.value = nextRunIndex[0].id;
        }
        await render();
    }

    function describeWhen(value) {
        if (!value) {
            return 'Unknown time';
        }
        try {
            return new Date(value).toLocaleString();
        } catch {
            return value;
        }
    }

    async function render() {
        // Two renders can overlap when selects change quickly; only the
        // newest one may write, or the outputs stack up.
        const seq = ++renderSeq;
        const caseId = activeCase?.id;
        const baselineId = baseSelect.value;
        const currentId = compareSelect.value;
        const normalize = !rawToggle.checked;
        replace(output);
        if (!activeCase) {
            output.append(emptyState(
                'Nothing to compare yet.',
                'Run a test case at least once, then come back to compare two of its runs.',
            ));
            return;
        }
        if (runIndex.length < 2) {
            output.append(emptyState(
                'Only one run so far.',
                'Comparing needs two runs of the same test case. Run it again after changing something, or build it under two setups above.',
            ));
            return;
        }

        const [baseline, current] = await Promise.all([
            storage.getRun(baselineId),
            storage.getRun(currentId),
        ]);
        if (seq !== renderSeq || activeCase?.id !== caseId) {
            return;
        }
        if (!baseline || !current) {
            output.append(emptyState('That run could not be loaded.', 'It may have been removed to save space.'));
            return;
        }
        if (baseline.id === current.id) {
            output.append(emptyState('Those are the same run.', 'Choose two different runs to compare.'));
            return;
        }

        renderEnvironmentDelta(baseline, current);

        const spans = current.cache?.volatileSpans ?? [];
        const comparison = compareRuns(current, baseline, { volatileSpans: spans, normalize });
        const occurrenceCounts = new Map();
        for (const row of comparison.tokenDeltas) {
            occurrenceCounts.set(row.id, (occurrenceCounts.get(row.id) ?? 0) + 1);
        }
        const rows = comparison.tokenDeltas.map((delta) => ({
            ...diffSection(baseline, current, delta.id, {
                occurrence: delta.occurrence,
                volatileSpans: spans,
                normalize,
            }),
            label: occurrenceCounts.get(delta.id) > 1
                ? `${delta.label} (occurrence ${delta.occurrence + 1} of ${occurrenceCounts.get(delta.id)})`
                : delta.label,
            baselineTokens: delta.baseline,
            currentTokens: delta.current,
            onlyInBaseline: delta.status === 'removed',
            onlyInCurrent: delta.status === 'added',
        }));
        const changed = rows.filter(row => row.onlyInBaseline || row.onlyInCurrent || !isUnchanged(row.parts));

        const summary = element('p', { className: 'sbpl-summary' });
        summary.textContent = changed.length
            ? `${changed.length} section${changed.length === 1 ? '' : 's'} differ, ${describeDelta(comparison.totalDelta)}.`
            : comparison.outboundChanged || comparison.sectionOrderChanged
                ? "The section text is unchanged, but the final outbound prompt's structure, message order, or protocol fields changed."
                : comparison.identical
                    ? normalize
                        ? 'These two runs produce the same prompt, ignoring parts that change every time.'
                        : 'These two runs produce exactly the same prompt.'
                    : comparison.summary;
        output.append(summary);

        output.append(renderTokenTable(rows));

        if (!changed.length) {
            return;
        }
        for (const row of changed) {
            output.append(renderSectionDiff(row));
        }
    }

    function describeDelta(delta) {
        if (delta === 0) {
            return 'using the same number of tokens';
        }
        return `using ${Math.abs(delta).toLocaleString()} ${delta > 0 ? 'more' : 'fewer'} tokens`;
    }

    function renderEnvironmentDelta(baseline, current) {
        const differences = [];
        const pairs = [
            ['Model', baseline.environment?.model, current.environment?.model],
            ['Preset', baseline.environment?.presetName, current.environment?.presetName],
            ['Connection', baseline.environment?.profileName, current.environment?.profileName],
            ['Neconyan version', baseline.environment?.forkVersion, current.environment?.forkVersion],
        ];
        for (const [label, before, after] of pairs) {
            if (before && after && before !== after) {
                differences.push(`${label}: ${before} → ${after}`);
            }
        }
        if (macroConfigDiffers(baseline.environment?.macroEnhanced ?? null, current.environment?.macroEnhanced ?? null)) {
            differences.push('The Macro Enhanced configuration changed between these runs.');
        }
        const tagsBefore = baseline.environment?.promptTagsProfile?.profileName ?? '';
        const tagsAfter = current.environment?.promptTagsProfile?.profileName ?? '';
        if (tagsBefore !== tagsAfter) {
            differences.push(`Prompt Tags profile: ${tagsBefore || 'none'} → ${tagsAfter || 'none'}`);
        }
        if (!differences.length) {
            return;
        }
        const note = element('div', { className: 'sbpl-warning', attributes: { role: 'note' } });
        note.append(element('p', {
            className: 'sbpl-warning-text',
            text: 'These runs were made with different settings, which may explain the difference:',
        }));
        const list = element('ul', { className: 'sbpl-caveat-list' });
        for (const line of differences) {
            list.append(element('li', { text: line }));
        }
        note.append(list);
        output.append(note);
    }

    function renderTokenTable(rows) {
        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Section', 'Baseline', 'This run', 'Change']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');
        for (const row of rows) {
            const delta = row.currentTokens - row.baselineTokens;
            const tr = element('tr');
            tr.append(element('td', { text: row.label }));
            tr.append(element('td', { className: 'sbpl-number', text: formatTokens(row.baselineTokens) }));
            tr.append(element('td', { className: 'sbpl-number', text: formatTokens(row.currentTokens) }));
            tr.append(element('td', {
                className: 'sbpl-number',
                text: delta === 0 ? '—' : `${delta > 0 ? '+' : '−'}${formatTokens(Math.abs(delta))}`,
            }));
            body.append(tr);
        }
        table.append(head, body);
        scroller.append(table);
        return scroller;
    }

    function renderSectionDiff(row) {
        const wrapper = element('details', { className: 'sbpl-diff-section' });
        wrapper.open = true;
        const delta = row.currentTokens - row.baselineTokens;
        const suffix = row.onlyInBaseline
            ? ' (removed)'
            : (row.onlyInCurrent ? ' (added)' : '');
        wrapper.append(element('summary', {
            className: 'sbpl-diff-summary',
            text: `${row.label}${suffix}: ${delta === 0 ? 'same size' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toLocaleString()} tokens`}`,
        }));

        const pre = element('pre', { className: 'sbpl-diff-body' });
        for (const part of collapseUnchanged(row.parts)) {
            const span = element('span', {
                className: `sbpl-diff-${part.type}`,
                text: part.text,
            });
            if (part.type === PART.ADDED) {
                span.setAttribute('aria-label', `Added: ${part.text}`);
            } else if (part.type === PART.REMOVED) {
                span.setAttribute('aria-label', `Removed: ${part.text}`);
            }
            pre.append(span);
        }
        wrapper.append(pre);
        return wrapper;
    }

    /* ------------------------------------------------- setup comparison */

    /**
     * The preset kind a case already pins, used as the starting choice so a
     * swap replaces like with like. Each setup can pick a different kind: a
     * Text Completion case pins five presets, and a comparison may want to move
     * the instruct template rather than the sampler.
     */
    function presetKindFor(testCase) {
        const pinned = (testCase?.pins?.presets ?? []).find(ref => ref?.name && isSupportedApiId(ref.apiId));
        return pinned?.apiId ?? CC_API_ID;
    }

    /** One row of the setup list: which preset of which kind, and which connection. */
    function setupRow(options, defaults = {}) {
        const kindSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Preset kind to swap' },
        });
        replace(kindSelect, ...PRESET_API_IDS.map(id => element('option', {
            text: labelForApiId(id),
            attributes: { value: id },
        })));
        kindSelect.value = defaults.presetApiId ?? CC_API_ID;

        const presetSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Preset for this setup' },
        });
        const fillPresets = (selected = '') => {
            replace(presetSelect, element('option', {
                text: 'Preset the test case pins',
                attributes: { value: '' },
            }), ...(options.presets[kindSelect.value] ?? []).map(name => element('option', {
                text: name,
                attributes: { value: name },
            })));
            presetSelect.value = selected;
        };
        fillPresets(defaults.presetName ?? '');
        kindSelect.addEventListener('change', () => fillPresets(''));

        const profileSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Connection for this setup' },
        });
        replace(profileSelect, element('option', {
            text: 'Connection the test case pins',
            attributes: { value: '' },
        }), ...options.profiles.map(profile => element('option', {
            text: profile.name,
            attributes: { value: profile.id },
        })));
        profileSelect.value = defaults.connectionProfileId ?? '';

        const node = element('div', { className: 'sbpl-controls' });
        const remove = button('Remove', () => {
            setups = setups.filter(entry => entry.node !== node);
            node.remove();
            renumberSetups();
        }, { className: 'menu_button sbpl-button sbpl-button-quiet' });
        const position = element('span', { className: 'sbpl-field-label' });
        node.append(position, kindSelect, presetSelect, profileSelect, remove);

        return {
            node,
            position,
            remove,
            read: () => ({
                presetApiId: kindSelect.value,
                presetName: presetSelect.value,
                connectionProfileId: profileSelect.value,
                profileName: options.profiles.find(profile => profile.id === profileSelect.value)?.name ?? '',
            }),
        };
    }

    /** Setups are read as a list, so their labels have to follow their order. */
    function renumberSetups() {
        setups.forEach((entry, index) => {
            entry.position.textContent = `Setup ${LETTERS[index] ?? index + 1}`;
            // Two is the fewest that can be compared at all.
            entry.remove.hidden = setups.length <= 2;
        });
        updateSetupControls();
    }

    function addSetup(options, defaults = {}) {
        if (setups.length >= MAX_SETUPS) {
            return;
        }
        const entry = setupRow(options, defaults);
        setups.push(entry);
        rowsHost.append(entry.node);
        renumberSetups();
    }

    function renderSetups(savedSetups = []) {
        replace(setupHost);
        replace(summaryHost);
        setups = [];
        if (!activeCase) {
            return;
        }
        let options;
        try {
            options = lab.readAvailableOptions();
        } catch (error) {
            setupHost.append(element('p', {
                className: 'sbpl-settings-note',
                text: `The presets and connections could not be read: ${errorMessage(error)}`,
            }));
            return;
        }

        const apiId = presetKindFor(activeCase);
        const names = options.presets[apiId] ?? [];
        const pinnedName = (activeCase.pins?.presets ?? []).find(ref => ref?.apiId === apiId)?.name ?? '';

        rowsHost = element('div', { className: 'sbpl-setup-rows' });
        addSetupButton = button('Add a setup', () => addSetup(options), {
            className: 'menu_button sbpl-button sbpl-button-quiet',
        });
        const actions = element('div', { className: 'sbpl-controls' });
        actions.append(addSetupButton, setupRunButton, setupStopButton);

        setupHost.append(
            element('p', {
                className: 'sbpl-summary',
                text: 'Build this test case under several setups and compare the prompts they produce.',
            }),
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Only the preset and the connection differ between setups; the character, persona, example message and checks stay as the test case has them. Nothing is sent, so this costs no tokens.',
            }),
            rowsHost,
            actions,
        );

        if (savedSetups.length) {
            savedSetups.slice(0, MAX_SETUPS).forEach(defaults => addSetup(options, defaults));
        } else {
            addSetup(options, { presetApiId: apiId, presetName: names.includes(pinnedName) ? pinnedName : '' });
            addSetup(options, { presetApiId: apiId, presetName: names.find(name => name !== pinnedName) ?? '' });
        }
    }

    function updateSetupControls() {
        if (addSetupButton) {
            addSetupButton.disabled = running || setups.length >= MAX_SETUPS;
        }
        setupRunButton.disabled = running || !activeSuite || !activeCase || setups.length < 2;
        setupRunButton.textContent = `Build this test case under ${setups.length} setups`;
        setupStopButton.hidden = !running;
        setupStopButton.disabled = !running;
        suiteSelect.disabled = running;
        caseSelect.disabled = running;
        for (const entry of setups) {
            entry.node.querySelectorAll('select, button').forEach((control) => {
                control.disabled = running;
            });
        }
    }

    /** What each setup produced, so three or more can be read at a glance. */
    function renderSetupSummary(runs) {
        replace(summaryHost);
        const rows = lab.summarizeSetups(runs);
        if (rows.length < 2) {
            return;
        }
        summaryHost.append(element('p', { className: 'sbpl-summary', text: 'What each setup produced' }));
        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Setup', 'Result', 'Tokens', 'Against the first', 'Checks']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');
        for (const row of rows) {
            const tr = element('tr');
            tr.append(element('td', { text: row.label }));
            const statusCell = element('td');
            statusCell.append(element('span', {
                className: `sbpl-chip sbpl-chip-${row.status}`,
                text: STATUS_LABEL[row.status] ?? row.status,
            }));
            tr.append(statusCell);
            tr.append(element('td', {
                className: 'sbpl-number',
                text: row.built ? formatTokens(row.tokens) : '—',
            }));
            tr.append(element('td', {
                className: 'sbpl-number',
                text: row.delta === null
                    ? '—'
                    : (row.delta === 0 ? 'same' : `${row.delta > 0 ? '+' : '−'}${formatTokens(Math.abs(row.delta))}`),
            }));
            tr.append(element('td', { text: describeChecks(row) }));
            body.append(tr);
        }
        table.append(head, body);
        scroller.append(table);
        summaryHost.append(scroller);
    }

    function describeChecks(row) {
        if (row.error) {
            return row.error;
        }
        const parts = [];
        if (row.passed) {
            parts.push(`${row.passed} passed`);
        }
        if (row.failed) {
            parts.push(`${row.failed} failed`);
        }
        if (row.unchecked) {
            parts.push(`${row.unchecked} unchecked`);
        }
        return parts.join(', ') || 'No checks';
    }

    async function compareSetups() {
        if (running || !activeSuite || !activeCase || setups.length < 2) {
            return;
        }
        const epoch = ++setupRunEpoch;
        const suite = structuredClone(activeSuite);
        const testCase = structuredClone(activeCase);
        suite.caseIds = [testCase.id];
        const setupInputs = setups.map(entry => entry.read());
        const controller = new AbortController();
        setupController = controller;
        running = true;
        updateSetupControls();
        replace(summaryHost);
        status.textContent = `Building this test case under ${setupInputs.length} setups. Your character, persona, preset and connection change while it runs, and are put back afterwards.`;
        let presetWarning = '';
        try {
            const report = await lab.preflightSuite(suite);
            if (epoch !== setupRunEpoch || setupController !== controller || !root || controller.signal.aborted) {
                return;
            }
            if (report.unsavedPresetEdits && report.unsavedPresetEditsCertain) {
                status.textContent = 'Save or discard your unsaved preset changes before comparing setups.';
                return;
            }
            if (report.unsavedPresetEdits) {
                presetWarning = 'Neconyan could not confirm whether the preset panel has unsaved changes; any unsaved changes may be discarded.';
                status.textContent = `${presetWarning} ${status.textContent}`;
            }
            const host = await loadHost();
            if (epoch !== setupRunEpoch || setupController !== controller || !root || controller.signal.aborted) {
                return;
            }
            const result = await lab.runSetups(
                suite,
                testCase,
                setupInputs,
                { host, signal: controller.signal },
            );
            if (epoch !== setupRunEpoch || setupController !== controller || !root) {
                return;
            }
            const [first, second] = result.runs;
            await reloadRuns({ base: first?.id ?? '', compare: second?.id ?? '' });
            if (epoch !== setupRunEpoch || setupController !== controller || !root) {
                return;
            }
            renderSetupSummary(result.runs);

            const failed = result.runs.filter(run => run?.status === STATUS.ERROR);
            const reason = failed[0]?.error?.message ?? 'the run did not finish.';
            let completion;
            if (result.aborted) {
                completion = 'Stopped the setup comparison.';
            } else if (failed.length === result.runs.length) {
                completion = `No setup could be built: ${reason}`;
            } else if (failed.length) {
                completion = `${failed.length} of ${result.runs.length} setups could not be built: ${reason}`;
            } else {
                completion = `All ${result.runs.length} setups were built.`;
            }
            const restoration = result.restoreProblems?.length
                ? `Your own settings could not be fully put back: ${result.restoreProblems.join('; ')}. Check your character, persona, preset and connection profile.`
                : 'Your settings have been put back.';
            status.textContent = `${completion} ${restoration}${presetWarning ? ` ${presetWarning}` : ''}`;
        } catch (error) {
            if (epoch === setupRunEpoch && setupController === controller && root) {
                status.textContent = controller.signal.aborted
                    ? 'Stopped the setup comparison.'
                    : `The setups could not be compared: ${errorMessage(error)}`;
            }
        } finally {
            if (epoch === setupRunEpoch && setupController === controller) {
                running = false;
                setupController = null;
                updateSetupControls();
            }
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-diff-tab' });
        const controls = element('div', { className: 'sbpl-controls' });

        suiteSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Suite' } });
        suiteSelect.addEventListener('change', async () => {
            const epoch = ++reloadEpoch;
            const suiteId = suiteSelect.value;
            activeSuite = suites.find(suite => suite.id === suiteId) ?? null;
            activeCase = null;
            await reloadCases(epoch);
        });

        caseSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Test case' } });
        caseSelect.addEventListener('change', async () => {
            const epoch = ++reloadEpoch;
            const caseId = caseSelect.value;
            activeCase = cases.find(item => item.id === caseId) ?? null;
            renderSetups();
            await reloadRuns({}, epoch);
        });

        baseSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Compare from' } });
        compareSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Compare to' } });
        baseSelect.addEventListener('change', () => { void render(); });
        compareSelect.addEventListener('change', () => { void render(); });

        const rawLabel = element('label', { className: 'checkbox_label sbpl-raw-toggle' });
        rawToggle = element('input', { attributes: { type: 'checkbox' } });
        rawToggle.checked = !getSettings().normalizeVolatile;
        rawToggle.addEventListener('change', () => {
            updateSettings({ normalizeVolatile: !rawToggle.checked });
            void render();
        });
        rawLabel.append(rawToggle, element('span', { text: 'Show parts that change every run' }));

        const promote = button('Set the "To" run as the baseline', async () => {
            if (!activeSuite || !activeCase || !compareSelect.value) {
                return;
            }
            const suite = structuredClone(activeSuite);
            const caseId = activeCase.id;
            const runId = compareSelect.value;
            const entry = runIndex.find(item => item.id === runId);
            const task = registerActiveTask('baseline promotion');
            try {
                await lab.promoteBaseline(suite, caseId, runId);
                status.textContent = `Saved the ${describeWhen(entry?.startedAt)} run as the baseline for this test case.`;
                await reload();
            } catch (error) {
                status.textContent = `That baseline could not be saved: ${errorMessage(error)}`;
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });

        controls.append(suiteSelect, caseSelect);
        const runControls = element('div', { className: 'sbpl-controls' });
        runControls.append(
            element('span', { className: 'sbpl-field-label', text: 'From' }),
            baseSelect,
            element('span', { className: 'sbpl-field-label', text: 'To' }),
            compareSelect,
            promote,
        );

        setupRunButton = button('Build this test case under 2 setups', () => { void compareSetups(); }, {
            className: 'menu_button sbpl-button',
            title: 'Builds the same test case once per setup, then compares the prompts',
        });
        setupStopButton = button('Stop', () => {
            setupController?.abort();
            status.textContent = 'Stopping after the current setup...';
        }, { className: 'menu_button sbpl-button' });
        setupStopButton.hidden = true;
        setupHost = element('div', { className: 'sbpl-setups' });
        summaryHost = element('div', { className: 'sbpl-setup-summary' });

        status = statusRegion('');
        output = element('div', { className: 'sbpl-diff-output' });
        root.append(controls, setupHost, status, summaryHost, runControls, rawLabel, output);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                void reload().catch((error) => {
                    status.textContent = `Runs could not be loaded: ${errorMessage(error)}`;
                });
            }
            return root;
        },
        refresh() {
            // Rebuilding the setup choosers mid-run would drop the pair being
            // built and re-enable the button while the runner is still going.
            if (!running) {
                void reload().catch(() => {});
            }
        },
        dispose() {
            reloadEpoch++;
            renderSeq++;
            setupRunEpoch++;
            setupController?.abort();
            setupController = null;
            root?.remove();
            root = null;
        },
    };
}
