import { listComparableProfiles } from '../ab.js';
import { button, element, emptyState, errorMessage, field, promptField, replace, statusRegion } from '../dom.js';
import { greetingChoices, readCharacterCard, requestAnalysis, runExperiment } from '../experiment.js';
import { getContext } from '../host.js';
import { getSelectedVersion } from '../prompt-drafts.js';
import { createCharacterPicker } from './character-picker.js';
import { currentPersona, renderScenePreview } from './scene-preview.js';
import { getSettings, updateSettings } from '../settings.js';
import * as storage from '../storage.js';

const ROLES = ['system', 'user', 'assistant'];
const ANALYSIS_MAX_TOKENS = 800;

/**
 * Compares a prompt with a modified version of it. Both versions are sent
 * through the same connection, against the same scenario and character card,
 * so the prompt text is the only difference between the two requests. An
 * optional follow-up asks a model what changed and what the replies show.
 *
 * Everything here spends tokens, so nothing is sent until a button is pressed.
 */
export function createExperimentTab() {
    let root = null;
    let promptATextarea = null;
    let promptBTextarea = null;
    let loaderPromptSelect = null;
    let loaderVersionSelect = null;
    let roleSelect = null;
    let characterPicker = null;
    let characterSelect = null;
    let greetingSelect = null;
    let greetingHost = null;
    let greetingChosen = false;
    let greetingAvatar = '';
    let previewHost = null;
    let card = null;
    let greetings = [];
    let scenarioTextarea = null;
    let profileSelect = null;
    let tokensInput = null;
    let runButton = null;
    let cancelButton = null;
    let status = null;
    let output = null;
    let analysisHost = null;

    let prompts = [];
    let profiles = [];
    let characters = [];
    let controller = null;
    let analysisController = null;
    let lastResult = null;
    let runInputs = [];
    let reloadEpoch = 0;
    let actionEpoch = 0;
    let analysisEpoch = 0;

    function startReload() {
        const epoch = ++reloadEpoch;
        void reload(epoch).catch((error) => {
            if (epoch === reloadEpoch && status) {
                status.textContent = `Saved prompts could not be loaded: ${errorMessage(error)}`;
            }
        });
    }

    async function reload(epoch) {
        const nextPrompts = await storage.listPromptDrafts();
        if (epoch !== reloadEpoch) {
            return;
        }
        prompts = nextPrompts;
        renderLoaderOptions();
        loadProfiles();
        loadCharacters();
    }

    function renderLoaderOptions() {
        const previous = loaderPromptSelect.value;
        const previousVersion = loaderVersionSelect.value;
        replace(loaderPromptSelect, ...prompts.map(prompt => element('option', {
            text: prompt.title,
            attributes: { value: prompt.id },
        })));
        if (prompts.some(prompt => prompt.id === previous)) {
            loaderPromptSelect.value = previous;
        }
        renderLoaderVersions(previousVersion);
    }

    function renderLoaderVersions(preferredVersion = '') {
        const prompt = prompts.find(item => item.id === loaderPromptSelect.value);
        replace(loaderVersionSelect, ...(prompt?.versions ?? []).map(version => element('option', {
            text: version.label,
            attributes: { value: version.id },
        })));
        if (prompt) {
            loaderVersionSelect.value = prompt.versions.some(version => version.id === preferredVersion)
                ? preferredVersion
                : (getSelectedVersion(prompt)?.id ?? prompt.versions[0].id);
        }
    }

    function loadedVersionContent() {
        const prompt = prompts.find(item => item.id === loaderPromptSelect.value);
        const version = prompt?.versions.find(item => item.id === loaderVersionSelect.value);
        return version ? { prompt, version } : null;
    }

    function loadProfiles() {
        const previous = profileSelect.value;
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
        if (profiles.some(profile => profile.id === previous && profile.usable)) {
            profileSelect.value = previous;
        } else if (usable[0]) {
            profileSelect.value = usable[0].id;
        }
        updateControls();
    }

    function loadCharacters() {
        const previous = characterSelect.value;
        characters = (getContext()?.characters ?? [])
            .filter(character => character?.avatar)
            .map(character => ({ avatar: character.avatar, name: character.name ?? character.avatar }));
        characterPicker.setOptions(characters.map(item => ({ value: item.avatar, name: item.name })));
        characterPicker.setValue(characters.some(character => character.avatar === previous) ? previous : '');
        renderGreetings();
    }

    /** The openings the chosen card offers, and the one both requests will use. */
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
        greetingHost.hidden = greetings.length === 0;
        renderPreview();
    }

    function chosenGreeting() {
        return greetings.find(choice => String(choice.index) === greetingSelect.value)?.text ?? '';
    }

    /** What both requests will carry, beneath the prompt being tested. */
    function renderPreview() {
        const persona = currentPersona(getContext());
        renderScenePreview(previewHost, {
            characterAvatar: card?.avatar ?? '',
            characterName: card?.name ?? '',
            personaKey: persona.key,
            personaName: persona.name,
            lines: [
                { from: 'character', text: chosenGreeting(), note: 'greeting' },
                { from: 'persona', text: scenarioTextarea?.value ?? '', note: 'test message' },
            ],
        });
    }

    function updateControls() {
        const busy = Boolean(controller);
        const ready = profiles.some(profile => profile.id === profileSelect.value && profile.usable);
        runButton.disabled = !ready || busy;
        cancelButton.hidden = !busy;
        for (const control of runInputs) {
            control.disabled = busy;
        }
        if (characterPicker) {
            characterPicker.node.inert = busy;
        }
    }

    /* --------------------------------------------------------------- run */

    async function run() {
        if (controller) {
            return;
        }
        const promptA = promptATextarea.value;
        const promptB = promptBTextarea.value;
        if (!promptA.trim() && !promptB.trim()) {
            status.textContent = 'Write a prompt in at least one of the two boxes first.';
            return;
        }
        const profile = profiles.find(item => item.id === profileSelect.value && item.usable);
        if (!profile) {
            status.textContent = 'Choose a connection profile.';
            return;
        }

        const input = {
            promptA,
            promptB,
            role: roleSelect.value,
            character: characterSelect.value
                ? readCharacterCard(characterSelect.value, getContext())
                : null,
            scenario: scenarioTextarea.value,
            greeting: chosenGreeting(),
            profileId: profile.id,
            maxTokens: updateSettings({ abMaxTokens: Number(tokensInput.value) }).abMaxTokens,
        };
        tokensInput.value = String(input.maxTokens);
        stopAnalysis();
        const requestController = new AbortController();
        controller = requestController;
        const { signal } = requestController;
        const epoch = ++actionEpoch;
        updateControls();
        lastResult = null;
        replace(output);
        replace(analysisHost);
        status.textContent = 'Waiting for both replies. This sends the prompts and uses tokens.';

        try {
            const replies = await runExperiment({
                ...input,
                signal,
            });
            if (epoch !== actionEpoch) {
                return;
            }
            lastResult = {
                replies,
                promptA: input.promptA,
                promptB: input.promptB,
                scenario: input.scenario,
                characterName: input.character?.name ?? '',
                profileId: input.profileId,
            };
            renderReplies(replies, profile);
            renderAnalysisControls();
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

    function renderReplies(replies, profile) {
        const note = element('p', { className: 'sbpl-status' });
        note.textContent = 'Both requests shared the same scenario, character, and connection'
            + `${profile ? ` (${profile.name})` : ''}, but their replies are independent stochastic samples. Only the prompt input differed.`;
        output.append(note);

        const grid = element('div', { className: 'sbpl-ab-grid' });
        for (const reply of replies) {
            const panel = element('section', { className: 'sbpl-ab-panel' });
            panel.append(element('h4', { className: 'sbpl-ab-title', text: `Prompt ${reply.key}` }));
            panel.append(element('pre', {
                className: reply.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: reply.error ?? reply.text,
            }));
            grid.append(panel);
        }
        output.append(grid);
    }

    /* ---------------------------------------------------------- analysis */

    function renderAnalysisControls() {
        replace(analysisHost);
        if (!lastResult || lastResult.replies.every(reply => reply.error)) {
            return;
        }
        const wrapper = element('div', { className: 'sbpl-analysis' });
        wrapper.append(
            element('p', { className: 'sbpl-field-label', text: 'Analysis (optional)' }),
            element('p', {
                className: 'sbpl-field-hint',
                text: 'Asks a model what changed between the two prompts and what the replies show. This sends one more request and uses tokens.',
            }),
        );

        const analysisProfileSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Connection profile for the analysis' },
        });
        for (const profile of profiles) {
            const option = element('option', {
                text: profile.usable
                    ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
                    : `${profile.name} (cannot be used here)`,
                attributes: { value: profile.id },
            });
            option.disabled = !profile.usable;
            analysisProfileSelect.append(option);
        }
        if (lastResult.profileId) {
            analysisProfileSelect.value = lastResult.profileId;
        }

        const analysisOutput = element('div', { className: 'sbpl-ab-output' });
        const analyzeButton = button('Get the analysis', () => {
            void analyze(analysisProfileSelect, analysisOutput, analyzeButton);
        }, { className: 'menu_button sbpl-button' });

        const controls = element('div', { className: 'sbpl-controls' });
        controls.append(analysisProfileSelect, analyzeButton);
        wrapper.append(controls, analysisOutput);
        analysisHost.append(wrapper);
    }

    function stopAnalysis() {
        analysisEpoch += 1;
        analysisController?.abort();
        analysisController = null;
    }

    async function analyze(analysisProfileSelect, analysisOutput, analyzeButton) {
        const source = lastResult;
        const profileId = analysisProfileSelect.value;
        if (!source || analysisController
            || !profiles.some(profile => profile.id === profileId && profile.usable)) {
            return;
        }
        const [replyA, replyB] = source.replies;
        const details = {
            promptA: source.promptA,
            promptB: source.promptB,
            replyA: replyA?.text ?? '',
            replyB: replyB?.text ?? '',
            scenario: source.scenario,
            characterName: source.characterName,
        };
        const requestController = new AbortController();
        analysisController = requestController;
        const epoch = ++analysisEpoch;
        const runEpoch = actionEpoch;
        analyzeButton.disabled = true;
        analysisProfileSelect.disabled = true;
        status.textContent = 'Waiting for the analysis. This sends a request and uses tokens.';
        try {
            const result = await requestAnalysis(details, {
                profileId,
                maxTokens: ANALYSIS_MAX_TOKENS,
                signal: requestController.signal,
            });
            if (epoch !== analysisEpoch || runEpoch !== actionEpoch) {
                return;
            }
            replace(analysisOutput, element('pre', {
                className: result.error ? 'sbpl-ab-body sbpl-ab-error' : 'sbpl-ab-body',
                text: result.error ?? result.text,
            }));
            status.textContent = result.error ? 'The analysis could not be fetched.' : 'Finished.';
        } catch (error) {
            if (epoch === analysisEpoch && runEpoch === actionEpoch) {
                status.textContent = `The analysis could not be fetched: ${errorMessage(error)}`;
            }
        } finally {
            if (epoch === analysisEpoch && analysisController === requestController) {
                analysisController = null;
                analyzeButton.disabled = false;
                analysisProfileSelect.disabled = false;
            }
        }
    }

    /* --------------------------------------------------------------- build */

    function build() {
        root = element('div', { className: 'sbpl-experiment-tab' });

        const promptA = promptField('Prompt A', {
            rows: 6,
            hint: 'The prompt as it is now.',
        });
        promptATextarea = promptA.textarea;
        const promptB = promptField('Prompt B', {
            rows: 6,
            hint: 'The modified version to test against it.',
        });
        promptBTextarea = promptB.textarea;

        const copyDown = button('Copy A into B', () => {
            promptBTextarea.value = promptATextarea.value;
        }, {
            className: 'menu_button sbpl-button',
            title: 'Start the modified version from the current prompt',
        });

        // The two versions are what this tab is about, so they travel together
        // and can sit next to each other wherever there is room for them.
        const promptPair = element('div', { className: 'sbpl-prompt-pair' });
        promptPair.append(promptA.wrapper, copyDown, promptB.wrapper);

        loaderPromptSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Prompt to load' },
        });
        loaderPromptSelect.addEventListener('change', () => renderLoaderVersions());
        loaderVersionSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Draft version to load' },
        });
        const loadA = button('Load into A', () => {
            const loaded = loadedVersionContent();
            if (loaded) {
                promptATextarea.value = loaded.version.content;
                status.textContent = `Loaded "${loaded.prompt.title}" (${loaded.version.label}) into prompt A.`;
            }
        }, { className: 'menu_button sbpl-button' });
        const loadB = button('Load into B', () => {
            const loaded = loadedVersionContent();
            if (loaded) {
                promptBTextarea.value = loaded.version.content;
                status.textContent = `Loaded "${loaded.prompt.title}" (${loaded.version.label}) into prompt B.`;
            }
        }, { className: 'menu_button sbpl-button' });
        const loader = element('div', { className: 'sbpl-field' });
        const loaderControls = element('div', { className: 'sbpl-controls' });
        loaderControls.append(loaderPromptSelect, loaderVersionSelect, loadA, loadB);
        loader.append(
            element('p', { className: 'sbpl-field-label', text: 'Load a saved prompt' }),
            loaderControls,
            element('span', {
                className: 'sbpl-field-hint',
                text: 'Prompts and their drafts come from the Prompts tab.',
            }),
        );

        roleSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Role the prompts speak as' },
        });
        for (const role of ROLES) {
            roleSelect.append(element('option', { text: role, attributes: { value: role } }));
        }

        characterPicker = createCharacterPicker({
            label: 'Character card',
            includeBlank: true,
            blankLabel: 'No character card',
        });
        characterSelect = characterPicker.input;
        characterSelect.addEventListener('change', renderGreetings);

        greetingSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Which greeting both requests carry' },
        });
        greetingSelect.addEventListener('change', () => {
            greetingChosen = true;
            renderPreview();
        });
        greetingHost = field('Opening', greetingSelect, {
            hint: 'The greeting sent with both prompts. Cards can carry more than one.',
        });
        previewHost = element('div', { className: 'sbpl-preview' });

        scenarioTextarea = element('textarea', {
            className: 'text_pole sbpl-textarea',
            attributes: { rows: '2', 'aria-label': 'Test message' },
        });
        // The preview is only useful if it follows what is being typed.
        scenarioTextarea.addEventListener('input', renderPreview);

        profileSelect = element('select', {
            className: 'text_pole sbpl-select',
            attributes: { 'aria-label': 'Connection profile' },
        });

        tokensInput = element('input', {
            className: 'text_pole sbpl-input',
            attributes: { type: 'number', min: '16', max: '32000', step: '16', 'aria-label': 'Reply length' },
        });
        tokensInput.value = String(getSettings().abMaxTokens);
        tokensInput.addEventListener('change', () => {
            const next = updateSettings({ abMaxTokens: Number(tokensInput.value) });
            tokensInput.value = String(next.abMaxTokens);
        });

        runButton = button('Get both replies', () => { void run(); }, {
            className: 'menu_button menu_button_primary sbpl-button',
        });
        cancelButton = button('Stop', () => {
            controller?.abort();
            status.textContent = 'Stopping.';
        }, { className: 'menu_button sbpl-button' });
        cancelButton.hidden = true;

        const sendControls = element('div', { className: 'sbpl-controls' });
        sendControls.append(profileSelect, tokensInput, runButton, cancelButton);

        runInputs = [
            promptATextarea,
            promptBTextarea,
            copyDown,
            loaderPromptSelect,
            loaderVersionSelect,
            loadA,
            loadB,
            roleSelect,
            characterSelect,
            greetingSelect,
            scenarioTextarea,
            profileSelect,
            tokensInput,
        ];

        status = statusRegion('');
        output = element('div', { className: 'sbpl-ab-output' });
        analysisHost = element('div', { className: 'sbpl-analysis-host' });

        root.append(
            element('p', {
                className: 'sbpl-settings-note',
                text: 'Test a prompt against a modified version of it. Both are sent through the same connection with the same character card and test message. The replies are independent stochastic samples, so a difference can suggest an effect but cannot prove your prompt change caused it. Like Compare models, this uses tokens when you ask for replies.',
            }),
            promptPair,
            loader,
            field('Speaking as', roleSelect),
            characterPicker.node,
            element('span', {
                className: 'sbpl-field-hint',
                text: 'Adds the character\'s description, personality, scenario, and greeting to both requests.',
            }),
            greetingHost,
            field('Test message', scenarioTextarea, {
                hint: 'Sent as the user message in both requests. Left empty, a plain "Hello." is sent.',
            }),
            previewHost,
            sendControls,
            status,
            output,
            analysisHost,
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
            if (!lastResult) {
                replace(output, emptyState(
                    'No comparison yet.',
                    'Fill in the two prompts, pick a connection, and choose "Get both replies".',
                ));
            }
            return root;
        },
        refresh() {
            if (root) {
                if (!controller) {
                    tokensInput.value = String(getSettings().abMaxTokens);
                }
                startReload();
            }
        },
        dispose() {
            reloadEpoch += 1;
            actionEpoch += 1;
            controller?.abort();
            controller = null;
            stopAnalysis();
            root?.remove();
            root = null;
        },
    };
}
