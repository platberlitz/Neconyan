/* global globalThis */
import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { availabilityCopy } from '../public/scripts/extensions/third-party/Neconyan-BotSearcher/client/copy.js';
import { hostT as promptingLabHostT } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/host.js';
import { hostMessage as worldInfoLabHostMessage, hostT as worldInfoLabHostT } from '../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/host.js';

// Error messages that reach the translation lookup: the narration queue toast, the BotSearcher guidance, the labs'
// host-aware t, and source pins for the sites that need the whole app to run (they are checked on screen in a preview).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const THIRD_PARTY = 'public/scripts/extensions/third-party';
const AGENTS = 'public/scripts/extensions/in-chat-agents';

afterEach(() => {
    delete globalThis.SillyTavern;
});

describe('the narration queue toast', () => {
    const source = read('public/scripts/extensions/tts/index.js');
    const cut = /^function getTtsQueueErrorMessage\(error\) \{[\s\S]*?^}/m.exec(source)?.[0];
    const knownBody = 'The server could not finish this request. Try again in a moment.';
    const dictionary = { [knownBody]: 'O servidor não conseguiu concluir esta solicitação. Tente novamente em instantes.' };

    function message(error) {
        const context = vm.createContext({ Error, String, localizeMessage: text => dictionary[text] ?? text });
        const getTtsQueueErrorMessage = vm.runInContext(`${cut}\ngetTtsQueueErrorMessage`, context);
        return getTtsQueueErrorMessage(error);
    }

    test('the function is found in the source', () => {
        expect(cut).toContain('function getTtsQueueErrorMessage(error)');
    });

    test('keeps the status and translates only a body the dictionary knows', () => {
        expect(message(new Error(`HTTP 500: ${knownBody}`))).toBe(`HTTP 500: ${dictionary[knownBody]}`);
        expect(message(new Error('HTTP 502: upstream connect error'))).toBe('HTTP 502: upstream connect error');
        expect(message(new Error('HTTP 400: first line\nsecond line'))).toBe('HTTP 400: first line\nsecond line');
    });

    test('shows an error message without the Error prefix', () => {
        expect(message(new Error('Some details are missing. Enter the text, voice, API key and group ID, then try again.')))
            .toBe('Some details are missing. Enter the text, voice, API key and group ID, then try again.');
        expect(message(new Error('HTTP 401. See server console for details.'))).toBe('HTTP 401. See server console for details.');
    });

    test('shows other values as before', () => {
        expect(message('plain thrown text')).toBe('plain thrown text');
        expect(message(new Error(''))).toBe('Error');
        expect(message(undefined)).toBe('undefined');
    });
});

describe('the BotSearcher version mismatch guidance', () => {
    const states = {
        same: { health: { protocol: 1, version: '1.0.0' } },
        older: { health: { protocol: 1, version: '0.9.0' } },
        newer: { health: { protocol: 1, version: '9.0.0' } },
        nothing: { health: {} },
    };

    // Recorded on the code before this change (the same call), byte for byte, including the double space before the recovery sentence.
    const recorded = {
        same: 'Page connection version: 2. Helper connection version: 1. Frontend version: 1.0.0. Server version: 1.0.0.  Update Neconyan and restart it, then check again. Update Neconyan and restart it to apply the matching native service.',
        older: 'Page connection version: 2. Helper connection version: 1. Frontend version: 1.0.0. Server version: 0.9.0.  Update Neconyan to include the native service, then restart it. Update Neconyan and restart it to apply the matching native service.',
        newer: 'Page connection version: 2. Helper connection version: 1. Frontend version: 1.0.0. Server version: 9.0.0.  The server is newer; update the frontend extension to v9.0.0. A server downgrade is not offered. Update Neconyan and restart it to apply the matching native service.',
        nothing: 'Page connection version: 2. Helper connection version: not reported. Frontend version: 1.0.0.  The server version cannot be ordered safely. Verify both deployments manually; no server replacement is offered. Update Neconyan and restart it to apply the matching native service.',
    };

    // With a host t that returns each key in brackets, the guidance shows which sentences were built whole, in order.
    const expectedKeys = {
        same: [
            'Page connection version: ${0}. Helper connection version: ${1}.',
            'Frontend version: ${0}. Server version: ${1}.',
            'Update Neconyan and restart it, then check again.',
        ],
        older: [
            'Page connection version: ${0}. Helper connection version: ${1}.',
            'Frontend version: ${0}. Server version: ${1}.',
            'Update Neconyan to include the native service, then restart it.',
        ],
        newer: [
            'Page connection version: ${0}. Helper connection version: ${1}.',
            'Frontend version: ${0}. Server version: ${1}.',
            'The server is newer; update the frontend extension to v${0}. A server downgrade is not offered.',
        ],
        nothing: [
            'Page connection version: ${0}. Helper connection version: not reported.',
            'Frontend version: ${0}.',
            'The server version cannot be ordered safely. Verify both deployments manually; no server replacement is offered.',
        ],
    };
    const lastSentence = 'Update Neconyan and restart it to apply the matching native service.';

    test.each(Object.keys(states))('without a host the guidance is the same text as before (%s)', state => {
        const copy = availabilityCopy('protocol-mismatch', states[state].health, 2, '1.0.0');

        expect(copy.guidance).toBe(recorded[state]);
        expect(copy.title).toBe('BotSearcher page and helper do not match');
        expect(copy.lead).toBe('The BotSearcher page and its helper service are different versions, so they cannot work together.');
    });

    test.each(Object.keys(states))('with a host t every sentence is built whole, on its own (%s)', state => {
        const keys = [];
        globalThis.SillyTavern = {
            getContext: () => ({
                t: (strings, ...values) => {
                    const key = strings.reduce((text, part, index) => text + part + (index < values.length ? `\${${index}}` : ''), '');
                    keys.push(key);
                    return `[${key}]`;
                },
            }),
        };

        const copy = availabilityCopy('protocol-mismatch', states[state].health, 2, '1.0.0');

        // What is shown is the protocol, version, recovery and closing sentences, each from its own key, with today's double space.
        const [protocol, version, recovery] = expectedKeys[state];
        expect(copy.guidance).toBe(`[${protocol}] [${version}]  [${recovery}] [${lastSentence}]`);
        expect(keys).toEqual(expect.arrayContaining([protocol, version, recovery, lastSentence]));
        expect(keys[0]).toBe(protocol);
        expect(keys.at(-1)).toBe(lastSentence);
        expect(copy.title).toBe('BotSearcher page and helper do not match');
        expect(copy.lead).toBe('The BotSearcher page and its helper service are different versions, so they cannot work together.');
    });
});

describe.each([
    ['Prompting Lab', promptingLabHostT],
    ['World Info Lab', worldInfoLabHostT],
])('%s hostT', (_name, hostT) => {
    test('gives the English text, as a template literal does, without a host', () => {
        const missing = undefined;
        expect(hostT`Technical details: ${'context.loadWorldInfo'}`).toBe('Technical details: context.loadWorldInfo');
        expect(hostT`Missing parts: ${missing}.`).toBe('Missing parts: undefined.');
        expect(hostT`No values here.`).toBe('No values here.');
    });

    test('gives the host t result when the host provides one', () => {
        globalThis.SillyTavern = { getContext: () => ({ t: (strings, ...values) => `T(${strings.join('|')};${values.join(',')})` }) };

        expect(hostT`Technical details: ${'x'}`).toBe('T(Technical details: |;x)');
    });

    test('gives the English text when the host has no t', () => {
        globalThis.SillyTavern = { getContext: () => ({}) };

        expect(hostT`Technical details: ${'x'}`).toBe('Technical details: x');
    });
});

describe('World Info Lab hostMessage', () => {
    const e0786 = 'The saved job list uses a format this version of Neconyan cannot read.';
    const e0786Translated = 'A lista de tarefas salva usa um formato que esta versão do Neconyan não consegue ler.';

    test('gives a message back unchanged, and a missing one as text, without a host', () => {
        expect(worldInfoLabHostMessage(e0786)).toBe(e0786);
        expect(worldInfoLabHostMessage(undefined)).toBe('');
        expect(worldInfoLabHostMessage(null)).toBe('');
        expect(worldInfoLabHostMessage(502)).toBe('502');
    });

    test('gives a message back unchanged when the host context has no translate', () => {
        globalThis.SillyTavern = { getContext: () => ({}) };
        expect(worldInfoLabHostMessage(e0786)).toBe(e0786);

        globalThis.SillyTavern = { getContext: () => null };
        expect(worldInfoLabHostMessage(e0786)).toBe(e0786);
    });

    test('looks each whole message up with the host translate, as its only argument', () => {
        const map = { [e0786]: e0786Translated };
        const calls = [];
        globalThis.SillyTavern = { getContext: () => ({ translate: (...args) => { calls.push(args); return map[args[0]] || args[0]; } }) };

        expect(worldInfoLabHostMessage(e0786)).toBe(e0786Translated);
        expect(worldInfoLabHostMessage('Failed to fetch')).toBe('Failed to fetch');
        expect(worldInfoLabHostMessage(undefined)).toBe('');
        expect(calls).toEqual([[e0786], ['Failed to fetch'], ['']]);
    });

    test('a looked-up message goes into a hostT frame as written, and the frame is found by its own key', () => {
        const dictionary = {
            'Scan failed. Technical details: ${0}': 'Falha na varredura. Detalhes técnicos: ${0}',
            [e0786]: e0786Translated,
        };
        const translate = text => dictionary[text] || text;
        const t = (strings, ...values) => translate(strings.reduce((text, part, index) => text + part + (values[index] !== undefined ? `\${${index}}` : ''), ''))
            .replace(/\$\{(\d+)\}/g, (_match, index) => values[index]);
        globalThis.SillyTavern = { getContext: () => ({ t, translate }) };

        const shown = detail => worldInfoLabHostT`Scan failed. Technical details: ${worldInfoLabHostMessage(detail)}`;

        expect(shown(e0786)).toBe(`Falha na varredura. Detalhes técnicos: ${e0786Translated}`);
        expect(shown('Failed to fetch')).toBe('Falha na varredura. Detalhes técnicos: Failed to fetch');
    });
});

describe('the changed lines are in the source as planned', () => {
    // Each entry is one replaced line. These sites need the whole app to run, so they are checked on screen in the
    // preview; here the text is pinned.
    const lines = [
        // File and upload errors show the message itself, without the 'Error: ' prefix.
        ['public/scripts/chats.js', 'toastr.error(error?.message || String(error), t`Could not upload file`);'],
        ['public/scripts/chats.js', 'toastr.error(error?.message || String(error), t`Could not delete image`);'],
        ['public/scripts/chats.js', 'toastr.error(error?.message || String(error), t`Could not delete file`);'],
        ['public/scripts/utils.js', 'toastr.error(error?.message || String(error), \'Could not prepare the file name\');'],
        // Extension reinstall.
        ['public/scripts/extensions.js', 'import { addLocaleData, getCurrentLocale, localizeMessage, t } from \'./i18n.js\';'],
        ['public/scripts/extensions.js', 'toastr.error(t`Could not reinstall ${extensionName}: ${localizeMessage(error.message)}`, t`Could not reinstall`);'],
        // Narration queue.
        ['public/scripts/extensions/tts/index.js', 'import { applyLocale, localizeMessage, t } from \'/scripts/i18n.js\';'],
        // Missing translations count.
        ['public/scripts/i18n.js', 'toastr.success(t`Found ${uniqueMissingData.length} missing translations. Their full list is in the developer console (press F12 to open it).`);'],
        // Labs: the compatibility reason is built with the host t where it is made.
        [`${THIRD_PARTY}/Neconyan-Prompting-Lab/src/host.js`, 'reason: hostT`${EXTENSION_LABEL} does not work with this version of Neconyan. Missing parts: ${required.join(\', \')}. Update Neconyan to use it.`,'],
        [`${THIRD_PARTY}/Neconyan-Prompting-Lab/src/host.js`, 'reason: hostT`${EXTENSION_LABEL} could not load the Neconyan prompt tools it needs. Reload Neconyan and try again.`,'],
        [`${THIRD_PARTY}/Neconyan-Prompting-Lab/src/ui/runtime.js`, 'import { hostT } from \'../host.js\';'],
        [`${THIRD_PARTY}/Neconyan-Prompting-Lab/src/ui/runtime.js`, 'drawerStatus.title = hostT`Technical details: ${state.availability.reason}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/host.js`, 'reason: hostT`World Info Lab does not work with this version of Neconyan. Missing parts: ${required.join(\', \')}. Update Neconyan to use it.`,'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/host.js`, 'reason: hostT`World Info Lab could not load the Neconyan lorebook tools it needs. Reload Neconyan and try again.`,'],
        // The detail of a World Info Lab error line is looked up whole, by its exact key, through the context's translate.
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/host.js`, 'export function hostMessage(text) {'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/host.js`, 'const translate = getContext()?.translate;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/runtime.js`, 'import { hostT } from \'../host.js\';'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/runtime.js`, 'drawerStatus.title = hostT`Technical details: ${state.availability.reason}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, 'import { getContext, hostMessage, hostT, loadHost, notify } from \'../host.js\';'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, 'hostStatus.title = hostT`Technical details: ${availability.reason ?? \'Neconyan compatibility check failed.\'}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, 'runStatus.textContent = hostT`Lorebook scanning is unavailable. Update Neconyan or World Info Lab, then reload. Technical details: ${availability.reason ?? \'Compatibility check failed.\'}`;'],
        // The failed-scan line: one whole sentence for each case, with the error text looked up whole.
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, 'const detail = hostMessage(errorMessage(error));'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, '? hostT`Scan failed. The previous completed result is still shown. Technical details: ${detail}`'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`, ': hostT`Scan failed. Technical details: ${detail}`;'],
        // The confirm box: one whole sentence for a test with a lorebook and one for a test without.
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'import { getContext, hostMessage, hostT } from \'../host.js\';'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, '? hostT`Prepare the deletion of \'${name}\' from \'its lorebook\' for review?`'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, ': hostT`Prepare the deletion of \'${name}\' from \'${selected.bookName}\' for review?`;'],
        // The other World Info Lab error lines that can show an in-scope message: each frame is one whole sentence (apply, test
        // preview, saved test run and delete, lorebook reload with its returned warning, lorebook load, batch preview, batch apply, health check).
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, '} catch (error) { status.textContent = hostT`The apply did not finish: ${hostMessage(errorMessage(error))}. Its saved record is retained.`; }'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The test preview could not finish: ${hostMessage(errorMessage(error))}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The saved test could not run. Technical details: ${hostMessage(errorMessage(error))}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The saved test could not be deleted. Technical details: ${hostMessage(errorMessage(error))}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'const detail = hostMessage(errorMessage(error));'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`Lorebooks could not be reloaded. Technical details: ${detail} Try again.`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'return hostT`Lorebooks could not be reloaded. Technical details: ${detail}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`"${bookSelect.value}" could not be loaded. Try again. Technical details: ${hostMessage(errorMessage(error))}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The preview could not be built. Your lorebook was not changed. Technical details: ${hostMessage(errorMessage(error))}`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The apply did not finish: ${hostMessage(errorMessage(error))}. Its saved record is retained for recovery.`;'],
        [`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`, 'status.textContent = hostT`The health check could not finish. Technical details: ${hostMessage(errorMessage(error))}`;'],
        // Mewmory: the message gets its own element, so the label and state stay in one text node.
        ['public/scripts/mewmory/ui.js', 'const jobMessage = job.error?.message || job.warning || \'\';'],
        ['public/scripts/mewmory/ui.js', 'const jobLine = node(\'p\', \'mewmory-caption\', job.label + \' · \' + job.state);'],
        ['public/scripts/mewmory/ui.js', 'if (jobMessage) jobLine.append(\': \', node(\'span\', \'\', jobMessage));'],
        // Dialogue Colors import errors.
        [`${THIRD_PARTY}/sillytavern-character-colors/src/storage.js`, 'function hostT(strings, ...values) {'],
        [`${THIRD_PARTY}/sillytavern-character-colors/src/storage.js`, 'return importError(\'invalid_character\', hostT`Character entry "${rawKey}" is not in the expected format.`);'],
        [`${THIRD_PARTY}/sillytavern-character-colors/src/storage.js`, 'return importError(\'invalid_group_profile\', hostT`Group profile "${rawKey}" is not in the expected format.`);'],
        // BotSearcher guidance.
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, '? hostT`Page connection version: ${frontendProtocol}. Helper connection version: not reported.`'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, ': hostT`Page connection version: ${frontendProtocol}. Helper connection version: ${health.protocol}.`;'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, '? hostT`Frontend version: ${frontendVersion}. Server version: ${health.version}.`'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, ': hostT`Frontend version: ${frontendVersion}.`);'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, 'let recovery = \' \' + hostT`Update Neconyan and restart it, then check again.`;'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, 'recovery = \' \' + hostT`Update Neconyan to include the native service, then restart it.`;'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, 'recovery = \' \' + hostT`The server is newer; update the frontend extension to v${health.version}. A server downgrade is not offered.`;'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, 'recovery = \' \' + hostT`The server version cannot be ordered safely. Verify both deployments manually; no server replacement is offered.`;'],
        [`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`, '${hostT`Update Neconyan and restart it to apply the matching native service.`}'],
        // Wrapped so their own key is looked up exactly.
        ['public/script.js', 'throw new Error(t`The chat could not be imported. Check that the file is a valid chat export, then try again.`);'],
        ['public/script.js', 'toastr.warning(t`The reply number for message #${mesId} was ${newSwipeId}, which is not valid. It has been reset to ${chat[mesId].swipes.length - 1}.`);'],
        ['public/script.js', 'toastr.warning(t`The reply number for message #${mesId} was ${newSwipeId}, which is not valid. It has been reset to the first reply.`);'],
        ['public/script.js', 'toastr.warning(t`Value must be between ${$(this).attr(\'min\')} and ${$(this).attr(\'max\')}.`);'],
        ['public/scripts/bookmarks.js', 'toastr.warning(t`Could not find message ${mesId}.`, context);'],
        ['public/scripts/account-data.js', 'import { t } from \'./i18n.js\';'],
        ['public/scripts/account-data.js', 'resetStatus.textContent = record.result.reset ? t`The account reset is complete.` : t`The account reset is not complete. Contact the server owner for help.`;'],
        // Tracker repair summary (one text per part, error count and advice together).
        [`${AGENTS}/agent-runner.js`, 'import { t } from \'../../i18n.js\';'],
        [`${AGENTS}/agent-runner.js`, 'parts.push(trackerRepairs > 1 ? t`${trackerRepairs} trackers repaired` : t`1 tracker repaired`);'],
        [`${AGENTS}/agent-runner.js`, 'parts.push(changedRuns.length > 1 ? t`${changedRuns.length} prompt transforms applied` : t`1 prompt transform applied`);'],
        [`${AGENTS}/agent-runner.js`, 'parts.push(postProcessRuns > 1 ? t`${postProcessRuns} post-processes run` : t`1 post-process run`);'],
        [`${AGENTS}/agent-runner.js`, 'parts.push(t`regex snapshot updated`);'],
        [`${AGENTS}/agent-runner.js`, '? t`${errorRuns} errors. A broken tracker has no clear start or end. Check that it has both a start marker and an end marker in the message, then try again.`'],
        [`${AGENTS}/agent-runner.js`, ': t`1 error. A broken tracker has no clear start or end. Check that it has both a start marker and an end marker in the message, then try again.`;'],
        [`${AGENTS}/agent-runner.js`, '? t`${errorRuns} errors. Some trackers could not be repaired. Check the connection the agent uses, then try again.`'],
        [`${AGENTS}/agent-runner.js`, ': t`1 error. Some trackers could not be repaired. Check the connection the agent uses, then try again.`;'],
        [`${AGENTS}/agent-runner.js`, 'toastr.warning([...parts, errors].join(\', \'), \'Tracker repair incomplete\');'],
        // Companion retry toasts: one text for one companion, one for several.
        [`${AGENTS}/companion/companion-dashboard.js`, 'import { t } from \'../../../i18n.js\';'],
        [`${AGENTS}/companion/companion-dashboard.js`, '? t`1 companion failed again. Check your connection, then try again.`'],
        [`${AGENTS}/companion/companion-dashboard.js`, ': t`${failedAgain} companions failed again. Check your connection, then try again.`);'],
        [`${AGENTS}/companion/companion-panel.js`, 'import { t } from \'../../../i18n.js\';'],
        [`${AGENTS}/companion/companion-panel.js`, '? t`1 companion failed again. Check your connection, then try again.`'],
        [`${AGENTS}/companion/companion-panel.js`, ': t`${failedAgain} companions failed again. Check your connection, then try again.`);'],
        // Server tools and account import notes now fall back to the wording of their toasts.
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.configNote, error.message || \'Could not save config.yaml.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.thumbnailNote, error.message || \'Could not save thumbnail settings.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.thumbnailNote, error.message || \'Could not clear thumbnail cache.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.updateNote, error.message || \'Could not restart Neconyan.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.updateNote, error.message || \'Could not update Neconyan.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'if (stashMessage && refs.updateNote instanceof HTMLElement) refs.updateNote.append(\'\\n\', stashMessage);'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.updateNote, error.message || \'Could not update Neconyan from release ZIP.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.note, error.message || \'Could not import from that folder path.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.note, error.message || \'Could not sync third-party extensions from that folder.\', \'danger\');'],
        ['public/scripts/neconyan-tabs.js', 'setServerAdminMessage(refs.note, error.message || \'Could not import that backup ZIP.\', \'danger\');'],
    ];

    test.each(lines)('%s has the line %s', (file, line) => {
        expect(read(file)).toContain(line);
    });

    test('the old forms are gone from the sites that changed', () => {
        const chats = read('public/scripts/chats.js');
        for (const title of ['Could not upload file', 'Could not delete image', 'Could not delete file']) {
            expect(chats).not.toContain(`toastr.error(String(error), t\`${title}\`)`);
        }
        expect(read('public/scripts/utils.js')).not.toContain('toastr.error(String(error), \'Could not prepare the file name\')');

        const tts = read('public/scripts/extensions/tts/index.js');
        const queue = /^async function processTtsQueue\(\) \{[\s\S]*?^}/m.exec(tts)?.[0] ?? '';
        expect(queue).toContain('toastr.error(getTtsQueueErrorMessage(error));');
        expect(queue).not.toContain('error.toString()');
        expect(tts.match(/toastr\.error\(getTtsQueueErrorMessage\(error\)\);/g)).toHaveLength(2);

        const runner = read(`${AGENTS}/agent-runner.js`);
        expect(runner).not.toContain('parts.join(\', \') + \'.\'');
        expect(runner).not.toContain('tracker${trackerRepairs > 1');

        expect(read(`${AGENTS}/companion/companion-dashboard.js`)).not.toContain('countLabel(failedAgain');
        expect(read(`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`)).not.toContain('const book = selected.bookName ?? \'its lorebook\'');
        expect(read(`${THIRD_PARTY}/Neconyan-BotSearcher/client/copy.js`)).not.toContain('?? \'not reported\'');
        expect(read('public/scripts/mewmory/ui.js')).not.toContain('job.state + (job.error?.message');
    });

    test('the World Info Lab error lines no longer build their frames by hand', () => {
        const workbench = read(`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/workbench.js`);
        expect(workbench).not.toContain('`Scan failed.${retained} Technical details: ${errorMessage(error)}`');
        expect(workbench).not.toContain('const retained = latestResult ?');

        // Each old literal with its backticks, so that the first apply line does not match the recovery one.
        const futureTabs = read(`${THIRD_PARTY}/Neconyan-WorldInfo-Lab/src/ui/future-tabs.js`);
        for (const old of [
            '`The apply did not finish: ${errorMessage(error)}. Its saved record is retained.`',
            '`The test preview could not finish: ${errorMessage(error)}`',
            '`The saved test could not run. Technical details: ${errorMessage(error)}`',
            '`The saved test could not be deleted. Technical details: ${errorMessage(error)}`',
            '`Lorebooks could not be reloaded. Technical details: ${errorMessage(error)}`',
            '`"${bookSelect.value}" could not be loaded. Try again. Technical details: ${errorMessage(error)}`',
            '`The preview could not be built. Your lorebook was not changed. Technical details: ${errorMessage(error)}`',
            '`The apply did not finish: ${errorMessage(error)}. Its saved record is retained for recovery.`',
            '`The health check could not finish. Technical details: ${errorMessage(error)}`',
        ]) {
            expect(futureTabs).not.toContain(old);
        }
        // The saved-tests reload line keeps its own use of this form (it is not changed here).
        expect(futureTabs.match(/`\$\{warning\} Try again\.`/g)).toHaveLength(1);
    });

    test('the nine server tools notes no longer fall back to a \'Failed to\' wording', () => {
        const source = read('public/scripts/neconyan-tabs.js');
        const calls = [...source.matchAll(/setServerAdminMessage\(([\s\S]*?)\);\n/g)].map(match => match[1]);
        const old = [
            'Failed to save config.yaml.',
            'Failed to save thumbnail settings.',
            'Failed to clear thumbnail cache.',
            'Failed to restart Neconyan.',
            'Failed to update Neconyan.',
            'Failed to update Neconyan from release ZIP.',
            'Failed to import from that folder path.',
            'Failed to sync third-party extensions from that folder.',
            'Failed to import that backup ZIP.',
        ];

        expect(calls.length).toBeGreaterThan(20);
        for (const text of old) {
            for (const call of calls) {
                expect(call).not.toContain(`'${text}'`);
            }
        }
        expect(source).not.toContain('.filter(Boolean).join(\'\\n\'), \'danger\')');
        // The three load fallbacks and the console lines keep their wording.
        expect(source).toContain('\'Failed to load config.yaml.\'');
        expect(source).toContain('\'Failed to load thumbnail settings.\'');
        expect(source).toContain('\'Failed to load server tools.\'');
        expect(source).toContain('console.error(\'Failed to update Neconyan.\', error);');
    });
});
