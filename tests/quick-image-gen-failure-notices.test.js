import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import { createNotifier } from '../public/scripts/extensions/quick-image-gen/lib/notifications.js';

// Quick Image Gen is too large to load, so the failure paths are cut out of its source as they
// stand and run against stand-ins for the helpers around them.
const source = fs.readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const cutFunction = name => {
    const found = syntax.body.find(row => row.id?.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};

function failureHost(overrides = {}) {
    const clock = { now: 0 };
    const toastr = { warning: jest.fn(), error: jest.fn(), info: jest.fn(), success: jest.fn() };
    const console = { log: jest.fn(), warn: jest.fn() };
    const context = {
        console,
        logs: { append: message => ({ message }) },
        debugLoggingEnabled: false,
        qigToast: null,
        showStatus: jest.fn(),
        getAbortError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
        getContext: () => ({}),
        resolveLLMPromptProfileContext: () => ({}),
        isSceneTranscriptPrompt: () => false,
        buildSceneDescriptionInstruction: () => 'Describe the scene.',
        appendWorldInfoToRequest: text => text,
        shouldReviewPrompt: () => false,
        callOverrideLLM: jest.fn(),
        callInternalStandaloneLLM: jest.fn(async () => { throw new TypeError('Failed to fetch'); }),
        logLLMHelperResponseMeta: () => undefined,
        cleanSceneDescriptionText: text => text,
        buildLLMEmptyPromptWarning: () => '',
        setImageAsBackground: jest.fn(async () => { throw new TypeError('Failed to fetch'); }),
        assertGenerationCanCommit: () => undefined,
        ...overrides,
    };
    context.log = message => context.writeLog(message);
    vm.createContext(context);
    vm.runInContext([
        cutFunction('writeLog'),
        cutFunction('warnLog'),
        cutFunction('debugLog'),
        cutFunction('generateSceneDescription'),
        cutFunction('maybeAutoSetBackground'),
        'globalThis.writeLog = writeLog;',
    ].join('\n'), context);
    context.qigToast = createNotifier({ getToastr: () => toastr, log: context.log, now: () => clock.now });
    return { context, toastr, console, clock };
}

describe('Quick Image Gen failure notices', () => {
    test('a background that cannot be set is shown once per burst and logged as a warning', async () => {
        const { context, toastr, console, clock } = failureHost();
        const settings = { autoSetBackground: true, backgroundMode: 'chat' };

        await context.maybeAutoSetBackground([{ url: '/a.png' }], settings);
        await context.maybeAutoSetBackground([{ url: '/b.png' }], settings);

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toBe('Auto background failed: Failed to fetch');
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(console.warn).toHaveBeenCalledWith('[QIG]', 'Auto background failed: Failed to fetch');
        expect(console.log).not.toHaveBeenCalledWith('[QIG]', expect.stringContaining('failed'));

        context.setImageAsBackground.mockRejectedValueOnce(new Error('The image is too large.'));
        await context.maybeAutoSetBackground([{ url: '/c.png' }], settings);
        expect(toastr.warning).toHaveBeenCalledTimes(2);

        clock.now += 5000;
        await context.maybeAutoSetBackground([{ url: '/d.png' }], settings);
        expect(toastr.warning).toHaveBeenCalledTimes(3);
    });

    test('a scene description that cannot reach the model is shown once and still falls back', async () => {
        const { context, toastr, console } = failureHost();

        await expect(context.generateSceneDescription({}, 'A quiet harbour.', null)).resolves.toBe('');
        await expect(context.generateSceneDescription({}, 'A quiet harbour.', null)).resolves.toBe('');

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toBe('Scene description failed: Failed to fetch');
        expect(console.warn).toHaveBeenCalledWith('[QIG]', 'Scene description failed: Failed to fetch');
    });

    test('a cancelled scene description is not reported as a failure', async () => {
        const abort = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        const { context, toastr, console } = failureHost({ callInternalStandaloneLLM: jest.fn(async () => { throw abort; }) });

        await expect(context.generateSceneDescription({}, 'A quiet harbour.', null)).rejects.toBe(abort);

        expect(toastr.warning).not.toHaveBeenCalled();
        expect(console.warn).not.toHaveBeenCalled();
    });

    // These two sit inside functions too large to run here, so their source is checked instead.
    test.each([
        ['generateLLMPrompt', 'qigToast.warning(`LLM prompt failed: ${e.message}`', 'llm-prompt-failed', 'warnLog(`LLM prompt failed: '],
        ['generateImage', 'qigToast.error("Generation failed: " + e.message', 'generation-failed', 'warnLog(`Error: '],
    ])('%s throttles its failure notice and logs it as a warning', (name, toast, key, warning) => {
        const body = cutFunction(name);
        const notice = body.slice(body.indexOf(toast), body.indexOf('});', body.indexOf(toast)));
        expect(notice).toContain(`throttleKey: \`${key}:\${e.message}\``);
        expect(body).toContain(warning);
        expect(body).not.toContain(` ${warning.replace('warnLog', 'log')}`);
    });
});
