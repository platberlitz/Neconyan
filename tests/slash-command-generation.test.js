import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { delayWithAbort } from '../public/scripts/slash-commands/SlashCommandRuntimeUtils.js';
import { SlashCommandAbortController } from '../public/scripts/slash-commands/SlashCommandAbortController.js';

const commands = readFileSync(new URL('../public/scripts/slash-commands.js', import.meta.url), 'utf8');
const utils = readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
function functionSource(source, name) {
    return source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'))[1];
}

function host(generating = false) {
    const input = { value: 'Keep my draft', val(value) { this.value = value; return this; }, 0: { dispatchEvent() {} } };
    const context = vm.createContext({
        setTimeout, clearTimeout, setInterval, clearInterval, Event, console,
        delayWithAbort, isTrueBoolean: value => String(value) === 'true', isFalseBoolean: value => String(value) === 'false',
        resolveVariable: value => value, setEphemeralStopStrings: jest.fn(), flushEphemeralStoppingStrings: jest.fn(),
        t: parts => parts.join(''), toastr: { warning: jest.fn(), error: jest.fn() },
        $: () => input, is_send_press: generating, is_group_generating: false, selected_group: null,
        Generate: jest.fn(async () => 'reply'), generateQuietPrompt: jest.fn(async () => 'quiet'), generateRaw: jest.fn(async () => 'raw'),
        deactivateSendButtons: jest.fn(), activateSendButtons: jest.fn(),
    });
    context.isGenerating = () => context.is_send_press || context.is_group_generating;
    vm.runInContext([
        functionSource(utils, 'waitUntilCondition'),
        ...['generateCallback', 'generateRawCallback', 'triggerGenerationCallback'].map(name => functionSource(commands, name)),
    ].join('\n'), context);
    return { context, input };
}

afterEach(() => jest.useRealTimers());

test.each(['generateCallback', 'generateRawCallback'])('%s preserves the active reply and draft with lock=true', async name => {
    const { context, input } = host(true);
    await context[name]({ lock: 'true' }, 'A separate prompt');
    expect(input.value).toBe('Keep my draft');
    expect(context.deactivateSendButtons).not.toHaveBeenCalled();
    expect(context.activateSendButtons).not.toHaveBeenCalled();
});

test.each(['generateCallback', 'generateRawCallback'])('%s still releases a lock it acquired while idle', async name => {
    const { context } = host();
    await context[name]({ lock: 'true' }, 'A separate prompt');
    expect(context.deactivateSendButtons).toHaveBeenCalledTimes(1);
    expect(context.activateSendButtons).toHaveBeenCalledTimes(1);
});

test.each(['generateCallback', 'generateRawCallback'])('%s does not unlock a reply started during its background prompt', async name => {
    const { context } = host();
    context.generateQuietPrompt = context.generateRaw = async () => { context.is_send_press = true; return 'reply'; };
    await context[name]({ lock: 'true' }, 'A separate prompt');
    expect(context.deactivateSendButtons).toHaveBeenCalledTimes(1);
    expect(context.activateSendButtons).not.toHaveBeenCalled();
});

test('a delayed trigger neither clears nor sends a newer draft', async () => {
    jest.useFakeTimers();
    const { context, input } = host(true);
    const triggered = context.triggerGenerationCallback({ await: 'true' });
    await jest.advanceTimersByTimeAsync(300);
    input.value = 'My newer draft';
    context.is_send_press = false;
    await jest.advanceTimersByTimeAsync(300);
    await triggered;
    expect(input.value).toBe('My newer draft');
    expect(context.Generate).toHaveBeenCalledWith('normal', { force_chid: undefined, suppressUserMessage: true });
});

test('stopping an awaited trigger prevents it from firing after the reply ends', async () => {
    jest.useFakeTimers();
    const { context } = host(true);
    const controller = new SlashCommandAbortController();
    const settled = jest.fn();
    const triggered = context.triggerGenerationCallback({ await: 'true', _abortController: controller }).then(settled);
    await jest.advanceTimersByTimeAsync(300);
    controller.abort();
    await jest.advanceTimersByTimeAsync(300);
    expect(settled).toHaveBeenCalledTimes(1);
    context.is_send_press = false;
    await jest.advanceTimersByTimeAsync(300);
    await triggered;
    expect(context.Generate).not.toHaveBeenCalled();
});

test('a detached trigger reports a failed generation without an unhandled rejection', async () => {
    jest.useFakeTimers();
    const { context } = host();
    context.console = { error: jest.fn() };
    context.Generate.mockRejectedValue(new Error('Provider unavailable'));
    await context.triggerGenerationCallback({ await: 'false' });
    await jest.advanceTimersByTimeAsync(500);
    expect(context.toastr.error).toHaveBeenCalledWith('Provider unavailable', 'API Error', { preventDuplicates: true });
});
