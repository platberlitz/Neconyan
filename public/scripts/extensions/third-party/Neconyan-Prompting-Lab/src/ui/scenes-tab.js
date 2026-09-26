import { listComparableProfiles } from '../ab.js';
import { hasUnsavedPresetEdits } from '../apply-state.js';
import { mountSavedPromptingResults } from '../native.js';
import { CAVEAT_TEXT } from '../constants.js';
import { button, element, errorMessage, field, formatTokens, promptField, replace, statusRegion } from '../dom.js';
import { getContext, loadHost } from '../host.js';
import { createCharacterPicker, createPersonaPicker } from './character-picker.js';
import { readCharacterCard, greetingChoices } from '../experiment.js';
import * as lab from '../lab.js';
import { acquireHostOperation } from '../operations.js';
import { CC_API_ID, labelForApiId, MODE_LABEL, modeOf, PRESET_API_IDS } from '../presets.js';
import {
    describeDuration,
    describeEstimate,
    estimateScene,
    formatScene,
    MAX_PRESETS,
    MAX_TURNS,
    mergeSavedSceneReplacement,
    runSceneComparison,
    SCENE_MODE,
    sceneFileName,
} from '../scenes.js';
import { renderScenePreview, currentPersona } from './scene-preview.js';
import { getSettings, updateSettings } from '../settings.js';
import { downloadExport } from '../transfer.js';

/**
 * Plays one scene under several presets and shows what each one wrote.
 *
 * Along with Compare prompts and Compare models, this tab spends tokens, and
 * only when its button is pressed.
 */
export function createScenesTab() {
    let root = null;
    let characterPicker = null;
    let characterSelect = null;
    let personaPicker = null;
    let personaSelect = null;
    let greetingSelect = null;
    let greetingHost = null;
    let greetingChosen = false;
    let greetingAvatar = '';
    let previewHost = null;
    let profileSelect = null;
    let kindSelect = null;
    let presetHost = null;
    let modeInputs = [];
    let turnsHost = null;
    let exchangesInput = null;
    let tokensInput = null;
    let estimateLine = null;
    let chatFileNote = null;
    let sendButton = null;
    let cancelButton = null;
    let status = null;
    let exportHost = null;
    let output = null;

    let options = { characters: [], personas: [], presets: {}, profiles: [] };
    let card = null;
    let greetings = [];
    let profiles = [];
    let presetChecks = [];
    let turnFields = [];
    let controller = null;
    let lastResult = null;
    let lastRun = null;
    let disposeSaved = null;
    let retrying = -1;
    let reloadEpoch = 0;
    let chatFileCheck = null;
    let actionEpoch = 0;
    // The reply arriving is a text change inside one panel, not a new layout;
    // keeping the nodes lets a stream update without rebuilding the grid.
    const turnNodes = new Map();
    const waitingSince = new WeakMap();
    let tickTimer = null;

    function currentMode() {
        return modeInputs.find(input => input.checked)?.value ?? SCENE_MODE.SCRIPTED;
    }

    function chosenPresets() {
        return presetChecks
            .filter(entry => entry.input.checked)
            .map(entry => ({ apiId: kindSelect.value, name: entry.name }));
    }

    function writtenTurns() {
        return turnFields.map(entry => entry.textarea.value);
    }

    function reload() {
        const epoch = ++reloadEpoch;
        try {
            options = lab.readAvailableOptions(getContext());
        } catch (error) {
            status.textContent = `The characters and presets could not be read: ${errorMessage(error)}`;
            return;
        }

        const previousCharacter = characterSelect.value;
        characterPicker.setOptions(options.characters.map(item => ({ value: item.avatar, name: item.name })));
        characterPicker.setValue(
            options.characters.some(character => character.avatar === previousCharacter)
                ? previousCharacter
                : (options.characters[0]?.avatar ?? ''),
        );

        const previousProfile = profileSelect.value;
        profiles = listComparableProfiles(getContext());
        replace(profileSelect, ...profiles.map((profile) => {
            const option = element('option', {
                text: profile.usable
                    ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                    : `${profile.name} (cannot be used here)`,
                attributes: { value: profile.id },
            });
            option.disabled = !profile.usable;
            return option;
        }));
        const usable = profiles.filter(profile => profile.usable);
        profileSelect.value = usable.some(profile => profile.id === previousProfile)
            ? previousProfile
            : (usable[0]?.id ?? '');

        const previousPersona = personaSelect.value;
        personaPicker.setOptions(options.personas.map(item => ({ value: item.key, name: item.name })));
        const persona = currentPersona(getContext());
        personaPicker.setValue(
            options.personas.some(item => item.key === previousPersona)
                ? previousPersona
                : (options.personas.some(item => item.key === persona.key) ? persona.key : ''),
        );

        renderPresetChoices();
        renderGreetings();
        void checkChatFile(epoch);
    }

    /** The openings the chosen card offers, and the one the scene will use. */
    function renderGreetings() {
        const avatar = characterSelect.value;
        const changedCharacter = avatar !== greetingAvatar;
        const previous = changedCharacter ? '' : greetingSelect.value;
        if (changedCharacter) {
            greetingChosen = false;
            greetingAvatar = avatar;
        }
        card = avatar ? readCharacterCard(avatar, getContext()) : null;
        greetings = greetingChoices(card);
        replace(
            greetingSelect,
            // Named, so that opening with the card's first message is a choice
            // on screen rather than something that quietly happens.
            element('option', { text: 'No opening', attributes: { value: '' } }),
            ...greetings.map(choice => element('option', {
                text: choice.snippet ? `${choice.label}: ${choice.snippet}` : choice.label,
                attributes: { value: String(choice.index) },
            })),
        );
        // Until someone picks, a card opens the way it says it does. After
        // that the choice is theirs and a refresh must not undo it.
        const stillOffered = previous === '' || greetings.some(choice => String(choice.index) === previous);
        greetingSelect.value = greetingChosen && stillOffered
            ? previous
            : String(greetings[0]?.index ?? '');
        // A card with one opening has nothing to choose between; a card with
        // none has nothing to show at all.
        greetingHost.hidden = greetings.length === 0;
        renderPreview();
    }

    function chosenGreeting() {
        return greetings.find(choice => String(choice.index) === greetingSelect.value)?.text ?? '';
    }

    function personaFor() {
        const chosen = options.personas.find(item => item.key === personaSelect.value);
        return chosen
            ? { key: chosen.key, name: chosen.name }
            : currentPersona(getContext());
    }

    function profileProblem(profile, presets) {
        if (!profile?.usable) {
            return 'Choose a usable connection profile.';
        }
        const modes = new Set(presets.map(preset => modeOf(preset.apiId)));
        if (modes.size !== 1) {
            return 'Choose presets from one completion mode.';
        }
        if (modes.has(profile.mode)) {
            return '';
        }
        const required = [...modes][0];
        return `Choose a ${MODE_LABEL[required]} connection profile for these ${MODE_LABEL[required]} presets.`;
    }

    function dirtyPresetProblem() {
        return PRESET_API_IDS.some(apiId => hasUnsavedPresetEdits(getContext, apiId) === true)
            ? 'Save the preset changes before playing a scene so the server can use them.'
            : '';
    }

    /** The scene as it will be sent, read as a conversation. */
    function renderPreview() {
        const persona = personaFor();
        renderScenePreview(previewHost, {
            characterAvatar: card?.avatar ?? characterSelect.value,
            characterName: card?.name ?? '',
            personaKey: persona.key,
            personaName: persona.name,
            lines: [
                { from: 'character', text: chosenGreeting(), note: 'opens the scene' },
                ...writtenTurns().map((text, index) => ({
                    from: 'persona',
                    text,
                    note: currentMode() === SCENE_MODE.SCRIPTED ? `turn ${index + 1}` : 'opening message',
                })),
            ],
        });
    }

    /** The server captures saved character and chat data without opening a chat. */
    function checkChatFile() {
        const avatar = characterSelect.value;
        const check = { avatar, pending: false, promise: Promise.resolve() };
        chatFileCheck = check;
        chatFileNote.hidden = true;
        updateControls();
        return check.promise;
    }

    /** The presets of the chosen kind, as a list that can be ticked. */
    function renderPresetChoices() {
        const previous = new Set(presetChecks.filter(entry => entry.input.checked).map(entry => entry.name));
        presetChecks = [];
        replace(presetHost);

        const names = options.presets[kindSelect.value] ?? [];
        if (!names.length) {
            presetHost.append(element('p', {
                className: 'sbpl-settings-note',
                text: `Neconyan has no ${labelForApiId(kindSelect.value).toLowerCase()} presets installed.`,
            }));
            updateControls();
            return;
        }

        for (const name of names) {
            const label = element('label', { className: 'checkbox_label sbpl-scene-preset' });
            const input = element('input', { attributes: { type: 'checkbox', value: name } });
            input.checked = previous.has(name);
            input.addEventListener('change', () => {
                // More than a handful of columns cannot be read side by side,
                // and every extra one is another round of requests.
                if (input.checked && chosenPresets().length > MAX_PRESETS) {
                    input.checked = false;
                    status.textContent = `Compare at most ${MAX_PRESETS} presets at a time.`;
                }
                updateControls();
            });
            label.append(input, element('span', { text: name }));
            presetHost.append(label);
            presetChecks.push({ name, input });
        }
        updateControls();
    }

    function renderTurnFields() {
        replace(turnsHost);
        const previous = turnFields.map(entry => entry.textarea.value);
        turnFields = [];

        const scripted = currentMode() === SCENE_MODE.SCRIPTED;
        const count = scripted ? Math.max(previous.length, 2) : 1;
        for (let index = 0; index < Math.min(count, MAX_TURNS); index += 1) {
            addTurnField(previous[index] ?? '', index);
        }

        if (scripted) {
            const actions = element('div', { className: 'sbpl-controls' });
            actions.append(
                button('Add a turn', () => {
                    if (turnFields.length >= MAX_TURNS) {
                        return;
                    }
                    addTurnField('', turnFields.length);
                    turnsHost.append(actions);
                    updateControls();
                }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
                button('Remove the last turn', () => {
                    if (turnFields.length <= 1) {
                        return;
                    }
                    turnFields.pop().wrapper.remove();
                    updateControls();
                }, { className: 'menu_button sbpl-button sbpl-button-quiet' }),
            );
            turnsHost.append(actions);
        } else {
            turnsHost.append(field('How many exchanges', exchangesInput, {
                hint: `The opening is sent, then the scene is carried on with "Continue the scene." Each preset answers its own replies from the second turn onwards, so the columns stop facing the same words.`,
            }));
        }
        updateControls();
        renderPreview();
    }

    function addTurnField(value, index) {
        const scripted = currentMode() === SCENE_MODE.SCRIPTED;
        const entry = promptField(scripted ? `Turn ${index + 1}` : 'Opening message', {
            rows: 2,
            hint: index === 0 ? 'Sent as you, exactly as written, to every preset.' : '',
        });
        entry.textarea.value = value;
        entry.textarea.addEventListener('input', () => {
            updateControls();
            renderPreview();
        });
        turnsHost.append(entry.wrapper);
        turnFields.push(entry);
    }

    function updateControls() {
        const busy = Boolean(controller);
        const presets = chosenPresets();
        const estimate = estimateScene({
            presets,
            mode: currentMode(),
            turns: writtenTurns(),
            exchanges: Number(exchangesInput.value),
            maxTokens: Number(tokensInput.value),
        });
        const profile = profiles.find(item => item.id === profileSelect.value);
        const modeProblem = presets.length ? profileProblem(profile, presets) : '';
        estimateLine.textContent = `${describeEstimate(estimate)}${modeProblem ? ` ${modeProblem}` : ''}`;
        const avatar = characterSelect.value;
        const chatFileReady = Boolean(avatar) && chatFileCheck?.avatar === avatar && !chatFileCheck.pending;
        const ready = estimate.presets >= 2 && estimate.turns >= 1
            && chatFileReady && !modeProblem;
        sendButton.disabled = !ready || busy;
        cancelButton.hidden = !busy;
        characterPicker.node.inert = busy;
        personaPicker.node.inert = busy;
        for (const control of [
            characterSelect,
            personaSelect,
            greetingSelect,
            profileSelect,
            kindSelect,
            exchangesInput,
            tokensInput,
            ...modeInputs,
            ...presetChecks.map(entry => entry.input),
            ...turnFields.map(entry => entry.textarea),
            ...turnsHost.querySelectorAll('button'),
        ]) {
            control.disabled = busy;
        }
        // Nothing may start a second run while one is in flight, retry included.
        for (const node of output.querySelectorAll('.sbpl-scene-retry')) {
            node.disabled = busy;
        }
    }

    /** What the running comparison is doing, read back as it happens. */
    function handleUpdate({ columns, streaming = null }) {
        lastResult = { ...(lastResult ?? {}), columns };
        const nodes = streaming ? turnNodes.get(streaming) : null;
        if (nodes) {
            // Only the text and its clock changed; rebuilding the grid here
            // would throw away the reader's scroll position several times a
            // second while a long reply arrives.
            nodes.body.textContent = streaming.text;
            nodes.label.textContent = turnLabel(streaming);
            return;
        }
        renderColumns({ columns });
    }

    /** Keeps the clock on a turn that is still being waited for honest. */
    function startTicking() {
        stopTicking();
        tickTimer = setInterval(() => {
            for (const [turn, nodes] of turnNodes) {
                if (turn.waiting) {
                    nodes.label.textContent = turnLabel(turn);
                }
            }
        }, 1000);
    }

    function stopTicking() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    async function send() {
        // Set before the first await: a second click would otherwise start a
        // whole second comparison and pay for it.
        if (controller) {
            return;
        }
        const presets = chosenPresets();
        const profile = listComparableProfiles(getContext())
            .find(item => item.id === profileSelect.value);
        const persona = personaFor();
        // Kept as they were when the run started, so a retry repeats this run
        // rather than whatever the form says by then.
        const run = {
            presets,
            characterAvatar: characterSelect.value,
            characterName: options.characters.find(item => item.avatar === characterSelect.value)?.name ?? '',
            personaKey: persona.key || null,
            connectionProfileId: profile?.id ?? '',
            connectionName: profile?.name ?? '',
            connectionModel: profile?.model ?? '',
            greeting: chosenGreeting(),
            mode: currentMode(),
            turns: writtenTurns(),
            exchanges: Number(exchangesInput.value),
            maxTokens: Number(tokensInput.value),
        };
        const estimate = estimateScene(run);
        if (estimate.presets < 2 || estimate.turns < 1 || !run.characterAvatar) {
            status.textContent = describeEstimate(estimate);
            return;
        }
        const modeProblem = profileProblem(profile, presets);
        if (modeProblem) {
            status.textContent = modeProblem;
            return;
        }
        let check = chatFileCheck;
        if (check?.avatar !== run.characterAvatar) {
            void checkChatFile();
            check = chatFileCheck;
        }
        const requestController = new AbortController();
        controller = requestController;
        const epoch = ++actionEpoch;
        let lease = null;
        updateControls();

        try {
            await check.promise;
            if (epoch !== actionEpoch || controller !== requestController || !root
                || check !== chatFileCheck || check.pending
                || check.avatar !== run.characterAvatar || characterSelect.value !== run.characterAvatar) {
                return;
            }
            lease = acquireHostOperation('a scene comparison', { signal: requestController.signal });
            const presetProblem = dirtyPresetProblem();
            if (presetProblem) {
                status.textContent = presetProblem;
                return;
            }
            lastRun = run;
            lastResult = null;
            replace(exportHost);
            replace(output);
            status.textContent = 'Building and sending the first turn. This uses tokens.';
            startTicking();
            const host = await loadHost();
            const result = await runSceneComparison({
                ...run,
                live: true,
                host,
                signal: lease.signal,
                onUpdate: (event) => {
                    if (epoch === actionEpoch) {
                        handleUpdate(event);
                    }
                },
                onProgress: (event) => {
                    if (epoch === actionEpoch) {
                        status.textContent = `${event.stage || 'Comparing scenes'} (${event.completed || 0}/${event.total || 0})`;
                    }
                },
            });
            if (epoch !== actionEpoch) {
                return;
            }
            lastResult = result;
            renderColumns(result);
            status.textContent = 'Scene comparison saved.';
        } catch (error) {
            if (epoch === actionEpoch) {
                status.textContent = error?.code === 'SBPL_BUSY'
                    ? errorMessage(error)
                    : `The scene could not be compared: ${errorMessage(error)}`;
            }
        } finally {
            lease?.release();
            if (epoch === actionEpoch && controller === requestController) {
                stopTicking();
                controller = null;
                updateControls();
                renderExportBar();
            }
        }
    }

    function recomputeCompletion(aborted) {
        const completedRequests = lastResult.columns.reduce(
            (total, column) => total + (column.turns ?? []).filter(turn => !turn.waiting).length,
            0,
        );
        const expectedRequests = estimateScene(lastRun).requests;
        Object.assign(lastResult, {
            completedRequests,
            expectedRequests,
            aborted: Boolean(aborted),
            incomplete: Boolean(aborted) || completedRequests < expectedRequests,
        });
    }

    /**
     * Plays the scene again for one preset whose connection let it down. The
     * column starts over from the first turn: a scene half told cannot be
     * picked up in the middle without pretending the missing reply happened.
     */
    async function retryColumn(index) {
        if (controller || !lastRun) {
            return;
        }
        const baseResult = lastResult;
        const target = baseResult?.columns?.[index];
        if (!target) {
            return;
        }
        const run = { ...lastRun, presets: [target.preset] };
        const profile = listComparableProfiles(getContext())
            .find(item => item.id === run.connectionProfileId);
        const modeProblem = profileProblem(profile, run.presets);
        if (modeProblem) {
            status.textContent = modeProblem;
            return;
        }
        const requestController = new AbortController();
        controller = requestController;
        const epoch = ++actionEpoch;
        let lease = null;
        retrying = index;
        updateControls();
        status.textContent = `Trying ${target.label} again. This uses tokens.`;

        try {
            lease = acquireHostOperation('a scene retry', { signal: requestController.signal });
            const presetProblem = dirtyPresetProblem();
            if (presetProblem) {
                status.textContent = presetProblem;
                return;
            }
            startTicking();
            const host = await loadHost();
            const result = await runSceneComparison({
                ...run,
                live: true,
                host,
                signal: lease.signal,
                onUpdate: ({ columns, streaming }) => {
                    if (epoch === actionEpoch) {
                        const merged = (lastResult?.columns ?? baseResult.columns).slice();
                        merged[index] = mergeSavedSceneReplacement(merged[index], columns[0]);
                        handleUpdate({ columns: merged, streaming });
                    }
                },
            });
            if (epoch !== actionEpoch) {
                return;
            }
            lastResult.columns[index] = mergeSavedSceneReplacement(lastResult.columns[index] ?? target, result.columns[0]);
            recomputeCompletion(result.aborted);
            renderColumns(lastResult);
            status.textContent = result.aborted ? 'Stopped.' : `Saved the new reply for ${target.label}.`;
        } catch (error) {
            if (epoch === actionEpoch) {
                status.textContent = error?.code === 'SBPL_BUSY'
                    ? errorMessage(error)
                    : `That preset could not be tried again: ${errorMessage(error)}`;
            }
        } finally {
            lease?.release();
            if (epoch === actionEpoch && controller === requestController) {
                stopTicking();
                controller = null;
                retrying = -1;
                updateControls();
                renderExportBar();
            }
        }
    }

    /**
     * Plays one column again from a chosen turn. Everything said before it is
     * handed back to the model as it stands, so only the turn being redone, and
     * the ones after it, are paid for a second time.
     */
    async function retryTurn(columnIndex, turnNumber) {
        if (controller || !lastRun) {
            return;
        }
        const baseResult = lastResult;
        const target = baseResult?.columns?.[columnIndex];
        if (!target) {
            return;
        }
        const kept = target.turns.filter(turn => turn.index < turnNumber);
        const history = kept.flatMap(turn => [
            { role: 'user', text: turn.userText },
            { role: 'assistant', text: turn.text },
        ]);
        const run = {
            ...lastRun,
            presets: [target.preset],
            startAt: turnNumber,
            history,
        };
        const profile = listComparableProfiles(getContext())
            .find(item => item.id === run.connectionProfileId);
        const modeProblem = profileProblem(profile, run.presets);
        if (modeProblem) {
            status.textContent = modeProblem;
            return;
        }
        const requestController = new AbortController();
        controller = requestController;
        const epoch = ++actionEpoch;
        let lease = null;
        retrying = columnIndex;
        updateControls();
        status.textContent = `Playing ${target.label} again from turn ${turnNumber}. This uses tokens.`;

        const merge = (fresh) => {
            const merged = (lastResult?.columns ?? baseResult.columns).slice();
            merged[columnIndex] = mergeSavedSceneReplacement(merged[columnIndex] ?? target, fresh);
            return merged;
        };

        try {
            lease = acquireHostOperation('a scene retry', { signal: requestController.signal });
            const presetProblem = dirtyPresetProblem();
            if (presetProblem) {
                status.textContent = presetProblem;
                return;
            }
            startTicking();
            const host = await loadHost();
            const result = await runSceneComparison({
                ...run,
                live: true,
                host,
                signal: lease.signal,
                onUpdate: ({ columns, streaming }) => {
                    if (epoch === actionEpoch) {
                        handleUpdate({ columns: merge(columns[0]), streaming });
                    }
                },
            });
            if (epoch !== actionEpoch) {
                return;
            }
            lastResult.columns = merge(result.columns[0]);
            recomputeCompletion(result.aborted);
            renderColumns(lastResult);
            status.textContent = result.aborted ? 'Stopped.' : `Saved ${target.label} from turn ${turnNumber}.`;
        } catch (error) {
            if (epoch === actionEpoch) {
                status.textContent = error?.code === 'SBPL_BUSY'
                    ? errorMessage(error)
                    : `That turn could not be played again: ${errorMessage(error)}`;
            }
        } finally {
            lease?.release();
            if (epoch === actionEpoch && controller === requestController) {
                stopTicking();
                controller = null;
                retrying = -1;
                updateControls();
                renderExportBar();
            }
        }
    }

    function turnLabel(turn) {
        if (turn.waiting && !waitingSince.has(turn)) {
            waitingSince.set(turn, Date.now() - (Number(turn.durationMs) || 0));
        }
        const durationMs = turn.waiting
            ? Math.max(Number(turn.durationMs) || 0, Date.now() - waitingSince.get(turn))
            : turn.durationMs;
        const timing = turn.waiting
            ? `waiting ${describeDuration(durationMs)}`
            : describeDuration(durationMs);
        return `Turn ${turn.index} · ${timing} · prompt ${formatTokens(turn.promptTokens)} tokens`;
    }

    /** True when a column stopped early and is worth another attempt. */
    function columnFailed(column) {
        return Boolean(column.error) || (column.turns ?? []).some(turn => turn.error);
    }

    function renderColumns(result) {
        replace(output);
        turnNodes.clear();
        if (!result.columns.length) {
            return;
        }

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const [index, column] of result.columns.entries()) {
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', { className: 'sbpl-ab-title', text: column.label }));
            if (column.error) {
                panel.append(element('pre', { className: 'sbpl-ab-body sbpl-ab-error', text: column.error }));
            }
            for (const turn of column.turns) {
                const label = element('p', { className: 'sbpl-scene-turn-label', text: turnLabel(turn) });
                const body = element('pre', {
                    className: turn.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                    text: turn.error ?? turn.text,
                });
                panel.append(label);
                panel.append(element('p', { className: 'sbpl-scene-said', text: turn.userText }));
                panel.append(body);
                turnNodes.set(turn, { label, body });

                // Offered where it is worth the tokens: a turn that failed, and
                // the last one, which is the one usually worth another roll.
                const isLast = turn === column.turns[column.turns.length - 1];
                if (column.done && !turn.waiting && (turn.error || isLast)) {
                    panel.append(button(`Play turn ${turn.index} again`, () => {
                        void retryTurn(index, turn.index);
                    }, {
                        className: 'menu_button sbpl-button sbpl-button-quiet sbpl-scene-retry',
                        title: 'Sends this turn again with everything before it left as it is. This uses tokens.',
                    }));
                }
            }
            if (columnFailed(column) && column.done) {
                panel.append(button('Play the whole scene again', () => { void retryColumn(index); }, {
                    className: 'menu_button sbpl-button sbpl-scene-retry',
                    title: `Plays every turn again for ${column.label}, from the first. This uses tokens.`,
                }));
            }
            grid.append(panel);
        }
        output.append(grid);

        const codes = [...new Set(result.columns.flatMap(column => column.caveats))];
        if (codes.length) {
            const wrapper = element('div', { className: 'sbpl-caveats' });
            wrapper.append(element('p', {
                className: 'sbpl-caveats-title',
                text: 'What these replies cannot show',
            }));
            const list = element('ul', { className: 'sbpl-caveat-list' });
            for (const code of codes) {
                if (CAVEAT_TEXT[code]) {
                    list.append(element('li', { text: CAVEAT_TEXT[code] }));
                }
            }
            wrapper.append(list);
            output.append(wrapper);
        }
        updateControls();
    }

    /** Saving is offered once there is something worth keeping. */
    function renderExportBar() {
        replace(exportHost);
        if (!lastResult?.columns?.length || controller) {
            return;
        }
        const FORMATS = {
            md: { label: 'Markdown', mime: 'text/markdown' },
            txt: { label: 'text', mime: 'text/plain' },
            html: { label: 'web page', mime: 'text/html' },
        };
        const save = (format) => {
            const savedAt = new Date().toISOString();
            try {
                downloadExport(
                    sceneFileName({ characterName: lastRun?.characterName ?? '', format, savedAt }),
                    formatScene(lastResult, {
                        format,
                        characterName: lastRun?.characterName ?? '',
                        connectionName: lastRun?.connectionName ?? '',
                        modelName: lastRun?.connectionModel ?? '',
                        savedAt: new Date(savedAt).toLocaleString(),
                    }),
                    FORMATS[format].mime,
                );
                status.textContent = `Saved the scene as a ${FORMATS[format].label} file.`;
            } catch (error) {
                status.textContent = `The scene could not be saved: ${errorMessage(error)}`;
            }
        };
        exportHost.append(
            button('Save as Markdown', () => save('md'), { className: 'menu_button sbpl-button' }),
            button('Save as text', () => save('txt'), { className: 'menu_button sbpl-button' }),
            button('Save as web page', () => save('html'), {
                className: 'menu_button sbpl-button',
                title: 'Keeps safe text formatting; model-written styles, links, forms, and scripts are removed',
            }),
        );
    }

    function build() {
        root = element('div', { className: 'sbpl-scenes-tab' });

        characterPicker = createCharacterPicker({ label: 'Character' });
        characterSelect = characterPicker.input;
        characterSelect.addEventListener('change', () => {
            renderGreetings();
            void checkChatFile();
        });

        personaPicker = createPersonaPicker({
            includeBlank: true,
            blankLabel: 'Stay on the persona you are using',
        });
        personaSelect = personaPicker.input;
        personaSelect.addEventListener('change', () => {
            renderPreview();
            updateControls();
        });

        greetingSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Which greeting opens the scene' },
        });
        greetingSelect.addEventListener('change', () => {
            greetingChosen = true;
            renderPreview();
        });
        greetingHost = field('Opening', greetingSelect, {
            hint: 'The greeting every preset answers. Cards can carry more than one.',
        });
        previewHost = element('div', { className: 'sbpl-preview' });
        chatFileNote = statusRegion('');
        chatFileNote.classList.add('sbpl-warning-text');
        chatFileNote.hidden = true;
        profileSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Connection profile' } });
        profileSelect.addEventListener('change', updateControls);

        kindSelect = element('select', { className: 'text_pole sbpl-select', attributes: { 'aria-label': 'Preset kind' } });
        replace(kindSelect, ...PRESET_API_IDS.map(id => element('option', {
            text: labelForApiId(id),
            attributes: { value: id },
        })));
        kindSelect.value = CC_API_ID;
        kindSelect.addEventListener('change', renderPresetChoices);
        presetHost = element('div', { className: 'sbpl-scene-presets' });

        const modeHost = element('div', { className: 'sbpl-controls' });
        modeInputs = [
            [SCENE_MODE.SCRIPTED, 'Scripted turns'],
            [SCENE_MODE.CONTINUE, 'One opening, then continue'],
        ].map(([value, text]) => {
            const label = element('label', { className: 'checkbox_label' });
            const input = element('input', { attributes: { type: 'radio', name: 'sbpl-scene-mode', value } });
            input.checked = value === SCENE_MODE.SCRIPTED;
            input.addEventListener('change', renderTurnFields);
            label.append(input, element('span', { text }));
            modeHost.append(label);
            return input;
        });

        exchangesInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '2', max: String(MAX_TURNS), step: '1', 'aria-label': 'How many exchanges' },
        });
        exchangesInput.value = '2';
        exchangesInput.addEventListener('change', updateControls);

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '32000', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
            updateControls();
        });

        turnsHost = element('div', { className: 'sbpl-scene-turns' });
        estimateLine = element('p', { className: 'sbpl-settings-note' });
        sendButton = button('Play the scene under each preset', () => { void send(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort('user-stop');
            status.textContent = 'Saving the stop request...';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        status = statusRegion('');
        exportHost = element('div', { className: 'sbpl-controls sbpl-scene-export' });
        output = element('div', { className: 'sbpl-ab-output' });

        const actions = element('div', { className: 'sbpl-controls' });
        actions.append(sendButton, cancelButton);

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Sends the same scene to a model once for each preset. This uses tokens. The server saves each reply and continues when the page closes.',
            }),
            characterPicker.node,
            chatFileNote,
            personaPicker.node,
            greetingHost,
            field('Connection', profileSelect, { hint: 'Every preset is sent through this same connection.' }),
            field('Preset kind', kindSelect),
            element('p', { className: 'sbpl-field-label', text: `Presets to compare (2 to ${MAX_PRESETS})` }),
            presetHost,
            element('p', { className: 'sbpl-field-label', text: 'The scene' }),
            modeHost,
            turnsHost,
            previewHost,
            field('Reply length', tokensInput, { hint: 'The most tokens each reply may use. Shared with the other comparison tabs.' }),
            estimateLine,
            actions,
            status,
            exportHost,
            output,
        );
        renderTurnFields();
        disposeSaved = mountSavedPromptingResults(root, { kind: 'scene',
            isBusy: () => Boolean(controller),
            onBusy: (value, previous) => {
                if (value || controller === previous) controller = value;
                updateControls();
                renderExportBar();
            },
            onResult: (result, record) => {
                lastRun = record.display;
                lastResult = result;
                renderColumns(result);
                renderExportBar();
                status.textContent = record.state === 'completed' ? 'Saved scene comparison loaded.' : 'Showing saved replies; observing the remaining work.';
            },
            onError: error => { status.textContent = errorMessage(error); },
        });
        return root;
    }

    return {
        render() {
            if (!root) {
                build();
                reload();
            }
            return root;
        },
        refresh() {
            if (!controller) {
                reload();
            }
        },
        dispose() {
            disposeSaved?.();
            reloadEpoch += 1;
            actionEpoch += 1;
            controller?.abort();
            controller = null;
            retrying = -1;
            stopTicking();
            turnNodes.clear();
            root?.remove();
            root = null;
        },
    };
}
