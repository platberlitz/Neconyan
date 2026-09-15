import { CAVEAT_TEXT, STATUS, STATUS_LABEL } from '../constants.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { loadHost } from '../host.js';
import * as lab from '../lab.js';
import { willCreateChatFile } from '../apply-state.js';
import { avatarThumbnail } from './character-picker.js';
import { dismissWarning, isWarningDismissed } from '../settings.js';
import { registerActiveTask } from '../operations.js';
import * as storage from '../storage.js';

const CHAT_FILE_WARNING = 'chat-file-creation';

/** Status chips carry a word as well as a colour, never colour alone. */
function statusChip(status) {
    return element('span', {
        className: `sbpl-chip sbpl-chip-${status}`,
        text: STATUS_LABEL[status] ?? status,
    });
}

export function describeRun(run) {
    if (run.status === STATUS.ERROR) {
        return run.error?.message ?? 'Something went wrong.';
    }
    if (run.status === STATUS.SKIPPED) {
        return 'Skipped because the run was stopped.';
    }
    const failed = (run.assertionResults ?? []).filter(result => result.pass === false);
    const unchecked = (run.assertionResults ?? []).filter(result => result.pass === null);
    const details = [];
    if (failed.length) {
        details.push(failed.map(result => result.message).join(' '));
    }

    const diff = run.diffVsBaseline;
    const changed = Boolean(diff && (
        diff.changedSections?.length
        || diff.addedSections?.length
        || diff.removedSections?.length
    ));
    if (diff && (changed || run.status === STATUS.CHANGED)) {
        details.push(diff.summary ?? 'This prompt differs from the baseline.');
    } else if (diff) {
        details.push('Matches the baseline.');
    } else if (!diff) {
        details.push('No baseline yet. Set this run as the baseline to compare against later.');
    }

    if (unchecked.length) {
        const label = `${unchecked.length} check${unchecked.length === 1 ? ' was' : 's were'} unchecked:`;
        details.push(`${label} ${unchecked.map(result => result.message).join(' ')}`);
    }
    return details.filter(Boolean).join(' ') || 'Matches the baseline.';
}

export function createRunTab({ onRunFinished = null } = {}) {
    let root = null;
    let suiteSelect = null;
    let warningsHost = null;
    let statusLine = null;
    let progressBar = null;
    let progressLabel = null;
    let queueHost = null;
    let resultsHost = null;
    let runButton = null;
    let cancelButton = null;
    let baselineButton = null;

    let suites = [];
    let activeSuite = null;
    let controller = null;
    let lastResult = null;
    let running = false;
    let refreshEpoch = 0;
    let preflightEpoch = 0;
    const chatFileChecks = new Map();

    function cachedChatFileCheck(context, avatar) {
        if (!chatFileChecks.has(avatar)) {
            chatFileChecks.set(avatar, willCreateChatFile(context, avatar));
        }
        return chatFileChecks.get(avatar);
    }

    async function refreshSuites({ preferredSuiteId = '', keepResult = false } = {}) {
        const epoch = ++refreshEpoch;
        const suiteId = preferredSuiteId || activeSuite?.id || suiteSelect?.value;
        const retainedResult = keepResult ? lastResult : null;
        const nextSuites = await storage.listSuites();
        if (epoch !== refreshEpoch || !suiteSelect || !root) {
            return;
        }
        const nextSuite = nextSuites.find(suite => suite.id === suiteId) ?? nextSuites[0] ?? null;
        const storedResult = nextSuite?.id === suiteId && retainedResult
            ? retainedResult
            : (nextSuite ? await loadStoredResult(nextSuite) : null);
        if (epoch !== refreshEpoch || !root) {
            return;
        }
        suites = nextSuites;
        activeSuite = nextSuite;
        lastResult = storedResult;
        replace(suiteSelect, ...nextSuites.map(suite => element('option', {
            text: `${suite.name} (${suite.caseIds.length})`,
            attributes: { value: suite.id },
        })));
        if (nextSuite) {
            suiteSelect.value = nextSuite.id;
        }
        if (storedResult) {
            renderResults(storedResult);
        }
        if (!lastResult && !running) {
            replace(resultsHost, nextSuites.length ? null : emptyState(
                'No test suites yet.',
                'Create a suite and add a test case on the Tests tab, then come back here.',
            ));
        }
        updateControls();
        await showPreflight();
    }

    function updateControls() {
        const hasCases = Boolean(activeSuite?.caseIds?.length);
        runButton.disabled = running || !hasCases;
        cancelButton.hidden = !running;
        baselineButton.hidden = !lastResult || running;
        // Changing the suite mid-run would make the results, and any baselines
        // saved from them, land under the wrong suite.
        suiteSelect.disabled = running || !suites.length;
    }

    function summarizeRuns(runs) {
        const summary = {
            [STATUS.PASS]: 0,
            [STATUS.CHANGED]: 0,
            [STATUS.UNCHECKED]: 0,
            [STATUS.FAIL]: 0,
            [STATUS.ERROR]: 0,
            [STATUS.SKIPPED]: 0,
            total: runs.length,
        };
        for (const run of runs) {
            if (run?.status in summary) {
                summary[run.status] += 1;
            }
        }
        return summary;
    }

    /** Load one coherent stored execution when the tab opens. */
    async function loadStoredResult(suite) {
        const candidates = [];
        for (const caseId of suite?.caseIds ?? []) {
            for (const entry of await storage.listRuns(caseId)) {
                const run = await storage.getRun(entry.id);
                if (run?.suiteId === suite.id) {
                    candidates.push(run);
                }
            }
        }
        if (!candidates.length) {
            return null;
        }

        // A suite run writes one record per case. Select the newest suiteRunId
        // as a unit; independently selecting each case's newest record can
        // combine unrelated or aborted executions and make them look like one
        // baseline candidate.
        const groups = new Map();
        for (const run of candidates) {
            const key = run.suiteRunId || `legacy:${run.id}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(run);
        }
        const [, grouped] = [...groups.entries()].sort(([, left], [, right]) => {
            const latest = runs => runs.reduce((value, run) => Math.max(value, Date.parse(run.startedAt) || 0), 0);
            return latest(right) - latest(left);
        })[0] ?? [];
        if (!grouped?.length) {
            return null;
        }
        const latestByCase = new Map();
        for (const run of grouped) {
            const previous = latestByCase.get(run.caseId);
            if (!previous || String(run.startedAt ?? '') > String(previous.startedAt ?? '')) {
                latestByCase.set(run.caseId, run);
            }
        }
        const runs = [...latestByCase.values()];
        return {
            suiteRunId: runs[0].suiteRunId,
            runs,
            restoreProblems: [],
            aborted: false,
            summary: summarizeRuns(runs),
        };
    }

    /**
     * What pressing Run would do, listed before it is pressed: every case in
     * the suite, what it pins, how many checks it carries, and whether it has
     * a baseline to be compared against.
     */
    function renderQueue(report, suite) {
        if (!queueHost) {
            return;
        }
        replace(queueHost);
        if (!suite || running || lastResult || !report?.cases?.length) {
            return;
        }
        const blockedById = new Map((report.blocked ?? []).map(entry => [entry.caseId, entry.reason]));
        let names = new Map();
        try {
            names = new Map(lab.readAvailableOptions().characters.map(item => [item.avatar, item.name]));
        } catch {
            names = new Map();
        }

        const ready = report.runnable?.length ?? 0;
        queueHost.append(element('p', {
            className: 'sbpl-summary',
            text: blockedById.size
                ? `Ready to run: ${ready} of ${report.cases.length} test cases.`
                : `Ready to run: ${ready} test case${ready === 1 ? '' : 's'}.`,
        }));

        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Test case', 'Character', 'Checks', 'Baseline', 'State']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');
        for (const testCase of report.cases) {
            const avatar = testCase.pins?.characterAvatar ?? '';
            const blockedReason = blockedById.get(testCase.id);
            const characterName = names.get(avatar) || avatar || 'No character';
            const characterCell = element('td');
            if (avatar) {
                characterCell.append(avatarThumbnail(avatar, characterName, 'sbpl-row-avatar'));
            }
            characterCell.append(element('span', { text: characterName }));
            const row = element('tr');
            row.append(
                element('td', { text: testCase.name || 'Untitled test case' }),
                characterCell,
                element('td', { className: 'sbpl-number', text: String(testCase.assertions?.length ?? 0) }),
                element('td', { text: suite.baselines?.[testCase.id] ? 'Set' : 'None yet' }),
                element('td', { text: blockedReason ?? 'Ready' }),
            );
            body.append(row);
        }
        table.append(head, body);
        scroller.append(table);
        queueHost.append(scroller);
    }

    async function showPreflight() {
        if (!warningsHost) {
            return;
        }
        const epoch = ++preflightEpoch;
        const suite = activeSuite ? structuredClone(activeSuite) : null;
        replace(warningsHost);
        replace(queueHost);
        if (!suite) {
            return;
        }
        let report;
        try {
            report = await lab.preflightSuite(suite, { chatFileChecker: cachedChatFileCheck });
        } catch (error) {
            if (epoch !== preflightEpoch || activeSuite?.id !== suite.id || !root) {
                return;
            }
            warningsHost.append(warning(`This suite could not be checked: ${errorMessage(error)}`));
            return;
        }
        if (epoch !== preflightEpoch || activeSuite?.id !== suite.id || !root) {
            return;
        }
        renderQueue(report, suite);

        for (const blocked of report.blocked) {
            warningsHost.append(warning(`One test case cannot run: ${blocked.reason}`));
        }
        if (report.charactersWithoutChats.length && !isWarningDismissed(CHAT_FILE_WARNING)) {
            const note = warning(
                `${report.charactersWithoutChats.length === 1 ? 'One character has' : `${report.charactersWithoutChats.length} characters have`} no chat yet. Running these tests will open them, which creates a chat for each.`,
            );
            note.append(button('Do not show this again', async () => {
                const task = registerActiveTask('warning dismissal');
                try {
                    dismissWarning(CHAT_FILE_WARNING);
                    await showPreflight();
                } finally {
                    task.release();
                }
            }, { className: 'menu_button sbpl-button sbpl-button-quiet' }));
            warningsHost.append(note);
        }
        if (report.unsavedPresetEdits) {
            warningsHost.append(warning(report.unsavedPresetEditsCertain
                ? 'You have unsaved changes in the preset panel. Running tests will discard them. Save the preset first if you want to keep them.'
                : 'If you have unsaved changes in the preset panel, running tests will discard them. Save the preset first if you want to keep them.'));
        }
    }

    function warning(text) {
        const node = element('div', { className: 'sbpl-warning', attributes: { role: 'note' } });
        node.append(element('p', { className: 'sbpl-warning-text', text }));
        return node;
    }

    function renderCaveats(runs) {
        const codes = new Set(runs.flatMap(run => run?.caveats ?? []));
        if (!codes.size) {
            return null;
        }
        const wrapper = element('div', { className: 'sbpl-caveats' });
        wrapper.append(element('p', {
            className: 'sbpl-caveats-title',
            text: 'What these runs cannot show',
        }));
        const list = element('ul', { className: 'sbpl-caveat-list' });
        for (const code of codes) {
            const text = CAVEAT_TEXT[code];
            if (text) {
                list.append(element('li', { text }));
            }
        }
        wrapper.append(list);
        return wrapper;
    }

    function renderResults(result) {
        replace(resultsHost);
        if (!result) {
            return;
        }
        const { runs, summary, restoreProblems } = result;

        const counts = element('p', { className: 'sbpl-summary' });
        const parts = [];
        for (const status of [STATUS.PASS, STATUS.CHANGED, STATUS.UNCHECKED, STATUS.FAIL, STATUS.ERROR, STATUS.SKIPPED]) {
            if (summary[status]) {
                parts.push(`${summary[status]} ${STATUS_LABEL[status].toLowerCase()}`);
            }
        }
        counts.textContent = parts.length ? parts.join(', ') : 'Nothing ran.';
        resultsHost.append(counts);

        if (restoreProblems?.length) {
            resultsHost.append(warning(
                `Your settings and original character/group chat could not be fully put back: ${restoreProblems.join('; ')}. Check your character, group chat, persona, preset and connection profile.`,
            ));
        }

        const scroller = element('div', { className: 'sbpl-scroll-x' });
        const table = element('table', { className: 'sbpl-table' });
        const head = element('thead');
        const headRow = element('tr');
        for (const label of ['Test case', 'Result', 'Tokens', 'What happened']) {
            headRow.append(element('th', { text: label, attributes: { scope: 'col' } }));
        }
        head.append(headRow);
        const body = element('tbody');

        for (const run of runs) {
            const row = element('tr');
            const nameCell = element('td');
            if (run.environment?.characterAvatar) {
                nameCell.append(avatarThumbnail(
                    run.environment.characterAvatar,
                    run.environment.characterName || '',
                    'sbpl-row-avatar',
                ));
            }
            nameCell.append(element('span', { text: run.caseName || 'Untitled test case' }));
            row.append(nameCell);
            const statusCell = element('td');
            statusCell.append(statusChip(run.status));
            row.append(statusCell);
            row.append(element('td', {
                className: 'sbpl-number',
                text: run.capture?.tokenTable?.total ? formatTokens(run.capture.tokenTable.total) : '—',
            }));
            row.append(element('td', { text: describeRun(run) }));
            body.append(row);
        }
        table.append(head, body);
        scroller.append(table);
        resultsHost.append(scroller);

        const caveats = renderCaveats(runs);
        if (caveats) {
            resultsHost.append(caveats);
        }
    }

    async function start(onlyCaseId = '') {
        if (running || !activeSuite || !root) {
            return;
        }
        const suite = structuredClone(activeSuite);
        const caseId = onlyCaseId;
        const runController = new AbortController();
        const task = registerActiveTask('run tab launch', { signal: runController.signal });
        running = true;
        controller = runController;
        preflightEpoch++;
        lastResult = null;
        updateControls();
        replace(queueHost);
        replace(resultsHost);
        progressBar.hidden = false;
        progressBar.value = 0;
        statusLine.textContent = 'Getting ready...';

        try {
            const host = await loadHost();
            if (task.signal.aborted || !root) {
                return;
            }
            const report = await lab.preflightSuite(suite, { chatFileChecker: cachedChatFileCheck });
            if (task.signal.aborted || !root) {
                return;
            }
            if (report.unsavedPresetEdits && report.unsavedPresetEditsCertain) {
                statusLine.textContent = 'Save or discard your unsaved preset changes before running tests.';
                return;
            }
            const only = id => !caseId || id === caseId;
            const result = await lab.runSuite(suite, {
                signal: task.signal,
                host,
                cases: report.runnable.filter(testCase => only(testCase.id)),
                blocked: report.blocked.filter(entry => only(entry.caseId)),
                onProgress: (event) => {
                    if (!root) {
                        return;
                    }
                    progressBar.max = event.total;
                    if (event.status === 'running') {
                        progressLabel.textContent = `Testing ${event.caseName} (${event.index + 1} of ${event.total})`;
                        statusLine.textContent = progressLabel.textContent;
                    } else {
                        progressBar.value = event.index + 1;
                    }
                },
            });
            if (!root) {
                return;
            }
            lastResult = result;
            if (result.restoreProblems?.length) {
                statusLine.textContent = result.aborted
                    ? 'Stopped, but some settings could not be put back.'
                    : 'Finished, but some settings could not be put back.';
            } else {
                statusLine.textContent = result.aborted
                    ? 'Stopped. Your settings have been put back.'
                    : 'Finished. Your settings have been put back.';
            }
            renderResults(result);
            onRunFinished?.(result);
        } catch (error) {
            if (root) {
                statusLine.textContent = task.signal.aborted
                    ? 'Stopped.'
                    : `The run could not finish: ${errorMessage(error)}`;
            }
        } finally {
            task.release();
            if (controller === runController) {
                running = false;
                controller = null;
                progressBar.hidden = true;
                progressLabel.textContent = '';
                updateControls();
                chatFileChecks.clear();
                await refreshSuites({ preferredSuiteId: suite.id, keepResult: true });
            }
        }
    }

    function build() {
        root = element('div', { className: 'sbpl-run-tab' });

        const controls = element('div', { className: 'sbpl-controls' });
        suiteSelect = element('select', {
            className: 'text_pole sbpl-select',
            id: 'sbpl-run-suite',
            attributes: { 'aria-label': 'Suite to run' },
        });
        suiteSelect.addEventListener('change', async () => {
            const suiteId = suiteSelect.value;
            activeSuite = suites.find(suite => suite.id === suiteId) ?? null;
            lastResult = null;
            replace(resultsHost);
            updateControls();
            await refreshSuites({ preferredSuiteId: suiteId });
        });

        runButton = button('Run suite', () => { void start(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            statusLine.textContent = 'Stopping after the current test case...';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;
        baselineButton = button('Set passing runs as baselines', async () => {
            if (!activeSuite || !lastResult) {
                return;
            }
            const suite = structuredClone(activeSuite);
            const runs = structuredClone(lastResult.runs);
            const task = registerActiveTask('baseline promotion');
            try {
                await lab.promoteAllPassing(suite, runs);
                statusLine.textContent = 'Saved passing runs as baselines. Future runs will be compared against them.';
                await refreshSuites({ preferredSuiteId: suite.id, keepResult: true });
            } catch (error) {
                statusLine.textContent = `The baselines could not be saved: ${errorMessage(error)}`;
            } finally {
                task.release();
            }
        }, { className: 'menu_button sbpl-button' });
        baselineButton.hidden = true;

        controls.append(suiteSelect, runButton, cancelButton, baselineButton);

        warningsHost = element('div', { className: 'sbpl-warnings' });
        statusLine = statusRegion('');
        progressLabel = element('p', { className: 'sbpl-progress-label' });
        progressBar = element('progress', { className: 'sbpl-progress' });
        progressBar.hidden = true;
        queueHost = element('div', { className: 'sbpl-queue' });
        resultsHost = element('div', { className: 'sbpl-results' });

        root.append(controls, warningsHost, progressLabel, progressBar, statusLine, queueHost, resultsHost);
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
            }
            if (!suites.length || !suiteSelect.options.length) {
                void refreshSuites();
            }
            return root;
        },
        refresh() {
            if (!running) {
                // The chat-file checks describe a moment in time; a refresh
                // (a chat change, an edit) may have made them stale.
                chatFileChecks.clear();
                void refreshSuites();
            }
        },
        /** Runs a single test case, so a small change can be checked on its own. */
        runOne(testCase) {
            if (!root) {
                return;
            }
            if (running) {
                statusLine.textContent = 'A run is already in progress. Stop it or let it finish first.';
                return;
            }
            const caseId = testCase?.id ?? '';
            const currentSuiteId = testCase?.suiteId || activeSuite?.id || '';
            void (async () => {
                await refreshSuites({ preferredSuiteId: currentSuiteId });
                if (!root) {
                    return;
                }
                const suite = suites.find(item => item.id === currentSuiteId && item.caseIds.includes(caseId))
                    ?? (activeSuite?.caseIds.includes(caseId) ? activeSuite : null)
                    ?? suites.find(item => item.caseIds.includes(caseId));
                if (!suite) {
                    return;
                }
                activeSuite = suite;
                suiteSelect.value = suite.id;
                await start(caseId);
            })().catch((error) => {
                if (root) {
                    statusLine.textContent = `That test case could not be run: ${errorMessage(error)}`;
                }
            });
        },
        dispose() {
            refreshEpoch++;
            preflightEpoch++;
            controller?.abort();
            controller = null;
            root?.remove();
            root = null;
        },
    };
}
