import { compareProfiles, listComparableProfiles } from '../ab.js';
import { button, element, emptyState, errorMessage, formatTokens, replace, statusRegion } from '../dom.js';
import { getContext } from '../host.js';
import * as lab from '../lab.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

/**
 * Sends one captured prompt to two connection profiles and shows the replies
 * next to each other. Along with Compare prompts, this spends tokens, so
 * nothing happens until the button is pressed.
 */
export function createAbTab() {
    let root = null;
    let suiteSelect = null;
    let caseSelect = null;
    let runSelect = null;
    let leftSelect = null;
    let rightSelect = null;
    let tokensInput = null;
    let sendButton = null;
    let cancelButton = null;
    let status = null;
    let output = null;

    let suites = [];
    let activeSuite = null;
    let cases = [];
    let activeCase = null;
    let runIndex = [];
    let profiles = [];
    let controller = null;
    let reloadEpoch = 0;
    let actionEpoch = 0;

    function startReload(task = reload) {
        const epoch = ++reloadEpoch;
        void task(epoch).catch((error) => {
            if (epoch === reloadEpoch && status) {
                status.textContent = `Saved runs could not be loaded: ${errorMessage(error)}`;
            }
        });
    }

    async function reload(epoch) {
        const nextSuites = await storage.listSuites();
        if (epoch !== reloadEpoch) {
            return;
        }
        suites = nextSuites;
        activeSuite = suites.find(suite => suite.id === activeSuite?.id) ?? suites[0] ?? null;
        replace(suiteSelect, ...suites.map(suite => element('option', {
            text: suite.name,
            attributes: { value: suite.id },
        })));
        if (activeSuite) {
            suiteSelect.value = activeSuite.id;
        }
        await reloadCases(epoch);
        if (epoch === reloadEpoch) {
            loadProfiles();
        }
    }

    async function reloadCases(epoch) {
        const suite = activeSuite;
        const nextCases = suite ? await lab.getSuiteCases(suite) : [];
        if (epoch !== reloadEpoch) {
            return;
        }
        cases = nextCases;
        activeCase = cases.find(item => item.id === activeCase?.id) ?? cases[0] ?? null;
        replace(caseSelect, ...cases.map(item => element('option', {
            text: item.name,
            attributes: { value: item.id },
        })));
        if (activeCase) {
            caseSelect.value = activeCase.id;
        }
        await reloadRuns(epoch);
    }

    async function reloadRuns(epoch) {
        const previous = runSelect.value;
        const testCase = activeCase;
        const nextRuns = testCase ? await storage.listRuns(testCase.id) : [];
        if (epoch !== reloadEpoch) {
            return;
        }
        runIndex = nextRuns;
        replace(runSelect, ...runIndex.map(entry => element('option', {
            text: describeWhen(entry.startedAt),
            attributes: { value: entry.id },
        })));
        if (runIndex.some(entry => entry.id === previous)) {
            runSelect.value = previous;
        } else if (runIndex.length) {
            runSelect.value = runIndex[0].id;
        }
        updateControls();
    }

    /** Refreshes the choices without discarding the ones already made. */
    function loadProfiles() {
        const previousLeft = leftSelect.value;
        const previousRight = rightSelect.value;
        profiles = listComparableProfiles(getContext());
        for (const select of [leftSelect, rightSelect]) {
            replace(select, ...profiles.map((profile) => {
                const option = element('option', {
                    text: profile.usable
                        ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                        : `${profile.name} (cannot be used here)`,
                    attributes: { value: profile.id },
                });
                option.disabled = !profile.usable;
                return option;
            }));
        }
        const usable = profiles.filter(profile => profile.usable);
        const keep = value => profiles.some(profile => profile.id === value && profile.usable);
        leftSelect.value = keep(previousLeft) ? previousLeft : (usable[0]?.id ?? '');
        rightSelect.value = keep(previousRight) ? previousRight : (usable[1]?.id ?? '');
        updateControls();
    }

    function selectedProfiles() {
        const selected = [leftSelect.value, rightSelect.value]
            .map(id => profiles.find(profile => profile.id === id && profile.usable));
        return selected.every(Boolean) && selected[0].id !== selected[1].id ? selected : [];
    }

    function describeWhen(value) {
        try {
            return value ? new Date(value).toLocaleString() : 'Unknown time';
        } catch {
            return String(value ?? '');
        }
    }

    function updateControls() {
        const busy = Boolean(controller);
        sendButton.disabled = !runIndex.length || selectedProfiles().length !== 2 || busy;
        cancelButton.hidden = !busy;
        for (const control of [suiteSelect, caseSelect, runSelect, leftSelect, rightSelect, tokensInput]) {
            control.disabled = busy;
        }
    }

    async function send() {
        // The controller doubles as the in-flight guard. It has to be set
        // before the first await, or a double-click sends the prompt twice.
        if (controller || !runSelect.value) {
            return;
        }
        const runId = runSelect.value;
        const chosen = selectedProfiles();
        if (chosen.length !== 2) {
            status.textContent = 'Choose exactly two distinct usable connection profiles.';
            return;
        }
        const profileIds = chosen.map(profile => profile.id);
        const maxTokens = updateSettings({ abMaxTokens: Number(tokensInput.value) }).abMaxTokens;
        tokensInput.value = String(maxTokens);
        const requestController = new AbortController();
        controller = requestController;
        const { signal } = requestController;
        const epoch = ++actionEpoch;
        updateControls();

        try {
            const run = await storage.getRun(runId);
            if (epoch !== actionEpoch) {
                return;
            }
            if (!run) {
                status.textContent = 'That run could not be loaded.';
                return;
            }
            if (signal.aborted) {
                status.textContent = 'Stopped.';
                return;
            }

            replace(output);
            status.textContent = 'Waiting for replies. This sends the prompt and uses tokens.';
            const replies = await compareProfiles(run, profileIds, {
                maxTokens,
                signal,
            });
            if (epoch !== actionEpoch) {
                return;
            }
            renderReplies(run, replies, chosen);
            status.textContent = signal.aborted ? 'Stopped.' : 'Finished.';
        } catch (error) {
            if (epoch === actionEpoch) {
                status.textContent = `The replies could not be fetched: ${errorMessage(error)}`;
            }
        } finally {
            if (epoch === actionEpoch && controller === requestController) {
                controller = null;
                updateControls();
            }
        }
    }

    function renderReplies(run, replies, chosen) {
        const note = element('p', { className: 'sbpl-status' });
        note.textContent = `Both replies used the same prompt of ${formatTokens(run.capture?.tokenTable?.total ?? 0)} tokens.`;
        output.append(note);

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const reply of replies) {
            const profile = chosen.find(item => item.id === reply.profileId);
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', {
                className: 'sbpl-ab-title',
                text: profile?.name ?? reply.profileId,
            }));
            if (profile?.model) {
                panel.append(element('p', { className: 'sbpl-case-meta', text: profile.model }));
            }
            panel.append(element('pre', {
                className: reply.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: reply.error ?? reply.text,
            }));
            grid.append(panel);
        }
        output.append(grid);
    }

    function build() {
        root = element('div', { className: 'sbpl-ab-tab' });

        suiteSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Suite' } });
        suiteSelect.addEventListener('change', () => {
            activeSuite = suites.find(suite => suite.id === suiteSelect.value) ?? null;
            activeCase = null;
            startReload(reloadCases);
        });
        caseSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Test case' } });
        caseSelect.addEventListener('change', () => {
            activeCase = cases.find(item => item.id === caseSelect.value) ?? null;
            startReload(reloadRuns);
        });
        runSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Run' } });

        leftSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'First connection profile' } });
        rightSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Second connection profile' } });
        leftSelect.addEventListener('change', updateControls);
        rightSelect.addEventListener('change', updateControls);

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '32000', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
        });

        sendButton = button('Get both replies', () => { void send(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            status.textContent = 'Stopping.';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        const pickers = element('div', { className: 'sbpl-controls' });
        pickers.append(suiteSelect, caseSelect, runSelect);
        const profilePickers = element('div', { className: 'sbpl-controls' });
        profilePickers.append(leftSelect, rightSelect, tokensInput, sendButton, cancelButton);

        status = statusRegion('');
        output = element('div', { className: 'sbpl-ab-output' });

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'This sends one saved prompt through two different usable connection profiles and compares their replies. Unlike prompt tests, it uses tokens. Nothing is added to any chat, and your active connection does not change.',
            }),
            pickers,
            profilePickers,
            status,
            output,
        );
        updateControls();
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                startReload();
            } else if (!controller) {
                tokensInput.value = String(getSettings().abMaxTokens);
            }
            if (!runIndex.length) {
                replace(output, emptyState(
                    'No saved runs yet.',
                    'Run a test case first. Its saved prompt is what gets sent here.',
                ));
            }
            return root;
        },
        refresh() {
            if (root && !controller) {
                tokensInput.value = String(getSettings().abMaxTokens);
                startReload();
            }
        },
        dispose() {
            reloadEpoch += 1;
            actionEpoch += 1;
            controller?.abort();
            controller = null;
            root?.remove();
            root = null;
        },
    };
}
