/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as generationOutcome from '../public/scripts/generation-outcome.js';
import { isGenerationLengthFinish } from '../public/scripts/generation-request-controls.js';
import { captureRecoveryAnchor, getHeldReplyTarget } from '../public/scripts/held-generation-recovery.js';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const userMessage = () => ({ mes: 'Hello', is_user: true, send_date: 'user-date' });
const assistantMessage = () => ({ mes: 'Existing reply. ', is_user: false, send_date: 'reply-date', swipe_id: 0, extra: { reasoning: 'Existing thought. ' } });
function contextFor(chat, type = 'normal') {
    const last = chat.at(-1);
    return { v: 2, chatId: 'chat-a', characterAvatar: 'avatar.png', type, api: 'openai', streaming: false,
        chatLength: chat.length, lastSendDate: last.send_date, lastIsUser: last.is_user,
        anchor: captureRecoveryAnchor(last), startedAt: 1000 };
}

describe('retained reply matching', () => {
    test('restores an unsaved normal reply and replaces a saved partial instead of duplicating it', () => {
        const chat = [userMessage()];
        const context = contextFor(chat);
        expect(getHeldReplyTarget(chat, context, 'reply')).toEqual({ type: 'normal' });
        chat.push({ mes: 'Partial', gen_started: new Date(1000), gen_finished: new Date(1100), extra: {} });
        expect(getHeldReplyTarget(chat, context, 'reply')).toEqual({ type: 'appendFinal', reasoningPrefix: '' });
        chat[1].extra.resumable_generation_id = 'reply';
        expect(getHeldReplyTarget(chat, context, 'reply')).toEqual({ type: 'saved' });
    });

    test('does not overwrite an edited prompt or another reply', () => {
        const chat = [userMessage()];
        const context = contextFor(chat);
        chat[0].mes = 'Edited prompt';
        expect(getHeldReplyTarget(chat, context, 'reply')).toBeNull();
        chat[0].mes = 'Hello';
        chat.push({ mes: 'Other reply', gen_started: new Date(2000) });
        expect(getHeldReplyTarget(chat, context, 'reply')).toBeNull();
    });

    test('continuation keeps only the original prefix and reasoning when a partial was saved', () => {
        const chat = [assistantMessage()];
        const context = contextFor(chat, 'continue');
        chat[0].mes += 'Partial';
        chat[0].extra.reasoning += 'New partial thought';
        chat[0].gen_started = new Date(1000);
        chat[0].send_date = 'new-date';
        expect(getHeldReplyTarget(chat, context, 'reply')).toEqual({ type: 'appendFinal', prefix: 'Existing reply. ', reasoningPrefix: 'Existing thought. ' });
        chat[0].mes = 'Edited prefix. Partial';
        expect(getHeldReplyTarget(chat, context, 'reply')).toBeNull();
    });

    test('swipe recovery preserves the selected slot and recognises already saved alternative replies', () => {
        const chat = [assistantMessage()];
        const context = contextFor(chat, 'swipe');
        chat[0].gen_started = new Date(1000);
        chat[0].mes = 'Partial replacement';
        expect(getHeldReplyTarget(chat, context, 'reply').type).toBe('appendFinal');
        chat[0].swipe_id = 1;
        expect(getHeldReplyTarget(chat, context, 'reply')).toBeNull();
        chat[0].swipe_info = [{ extra: { resumable_generation_id: 'reply' } }];
        expect(getHeldReplyTarget(chat, context, 'reply').type).toBe('saved');
    });

    test('large chats produce compact recovery headers', () => {
        const message = assistantMessage();
        message.mes = 'x'.repeat(1_000_000);
        message.extra.reasoning = 'y'.repeat(1_000_000);
        expect(JSON.stringify(contextFor([message], 'continue')).length).toBeLessThan(1024);
    });
});

function recoveryHost() {
    const chat = [userMessage()];
    const job = { id: 'held-reply', context: contextFor(chat), status: 'finished', attached: false };
    const timers = new Map();
    const wakeListeners = new Map();
    let timerId = 0;
    const addEventListener = (event, callback) => wakeListeners.set(event, callback);
    const host = vm.createContext({
        ...generationOutcome, isGenerationLengthFinish,
        chat, chatGeneration: 0, chatId: 'chat-a', this_chid: 0, selected_group: null,
        characters: [{ avatar: 'avatar.png' }], is_send_press: false, activeGenerationRun: null,
        document: { visibilityState: 'visible', addEventListener }, window: { addEventListener }, console, generation_started: null,
        getCurrentChatId: () => host.chatId, getRequestHeaders: () => ({}),
        listRecoverableGenerations: jest.fn(async () => [job]),
        openHeldGeneration: jest.fn(async () => Response.json({ text: 'Final reply' })),
        discardGeneration: jest.fn(async () => {}),
        saveChatConditional: jest.fn(async () => true), syncMesToSwipe: jest.fn(),
        saveReply: jest.fn(async ({ type, getMessage, reasoning }) => {
            const message = { mes: getMessage, extra: { reasoning }, gen_started: new Date(1000) };
            if (type === 'appendFinal') chat[chat.length - 1] = message;
            else chat.push(message);
        }),
        getHeldReplyTarget, extractMessageFromData: data => data.text, extractReasoningFromData: () => '',
        extractImagesFromData: () => [], extractReasoningSignatureFromData: () => null, extractMultiSwipes: () => [],
        cleanUpMessage: ({ getMessage }) => getMessage, getRegexedString: text => text, regex_placement: {},
        t: strings => strings[0], toastr: { info: jest.fn(), error: jest.fn(), warning: jest.fn() }, playMessageSound: jest.fn(),
        setTimeout: jest.fn((callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; }),
        clearTimeout: jest.fn(id => timers.delete(id)),
    });
    const names = ['scheduleHeldGenerationRecovery', 'startHeldGenerationRecoveryTimer', 'saveChatWithHeldReply', 'recoverHeldGenerations', 'recoverHeldGenerationPass', 'applyHeldGeneration'];
    const functions = names.map(name => source.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([\\s\\S]*?^})`, 'm'))[1]);
    vm.runInContext('let heldRecoveryTimer; let heldRecoveryPromise; const heldRecoveryFailures = new Map(); let heldRecoveryRetries = 0; let heldRecoveryGeneration = 0;\n' + functions.join('\n'), host);
    const listeners = [...source.matchAll(/^\s*(?:document|window)\.addEventListener\('(visibilitychange|pageshow|online)', scheduleHeldGenerationRecovery\);$/gm)];
    vm.runInContext(listeners.map(match => match[0]).join('\n'), host);
    const runTimer = async () => {
        expect(timers.size).toBe(1);
        const [id, { callback, delay }] = timers.entries().next().value;
        timers.delete(id);
        callback();
        await new Promise(resolve => setImmediate(resolve));
        expect(timers.size).toBeLessThanOrEqual(1);
        return delay;
    };
    return { host, job, timers, runTimer, wake: event => wakeListeners.get(event)() };
}

describe('recovery and save acknowledgement', () => {
    test.each([false, true])('retains unfinished prose after a provider length stop, streaming: %s', async streaming => {
        const { host, job } = recoveryHost();
        const text = 'She opens the door and';
        job.context.streaming = streaming;
        host.openHeldGeneration.mockResolvedValue(Response.json({ text, choices: [{ finish_reason: 'length' }] }));
        host.readChatCompletionStream = () => async function* () {
            yield { text, state: { finishReason: 'length' } };
        };
        host.cleanUpMessage = jest.fn(({ getMessage, displayIncompleteSentences }) => displayIncompleteSentences ? getMessage : '');
        await host.recoverHeldGenerations();
        expect(host.saveReply).toHaveBeenCalledWith(expect.objectContaining({ getMessage: text }));
        expect(host.discardGeneration).toHaveBeenCalledTimes(1);
        await host.recoverHeldGenerations();
        expect(host.saveReply).toHaveBeenCalledTimes(1);
    });

    test('returning before completion schedules another pass and later saves exactly once', async () => {
        const { host, job } = recoveryHost();
        job.status = 'running';
        await host.recoverHeldGenerations();
        expect(host.setTimeout).toHaveBeenCalled();
        expect(host.saveReply).not.toHaveBeenCalled();
        job.status = 'finished';
        await Promise.all([host.recoverHeldGenerations(), host.recoverHeldGenerations()]);
        expect(host.saveReply).toHaveBeenCalledTimes(1);
        expect(host.discardGeneration).toHaveBeenCalledWith(job.id, {});
    });

    test('a failed save retains the reply and retries saving without adding it again', async () => {
        const { host } = recoveryHost();
        host.saveChatConditional.mockResolvedValueOnce(false);
        await host.recoverHeldGenerations();
        expect(host.discardGeneration).not.toHaveBeenCalled();
        await host.recoverHeldGenerations();
        expect(host.saveReply).toHaveBeenCalledTimes(1);
        expect(host.saveChatConditional).toHaveBeenCalledTimes(2);
        expect(host.discardGeneration).toHaveBeenCalledTimes(1);
    });

    test('recovers reasoning and images even when the provider returns no prose', async () => {
        const { host } = recoveryHost();
        host.extractMessageFromData = () => '';
        host.extractReasoningFromData = () => 'A complete thought';
        host.extractImagesFromData = () => ['data:image/png;base64,fixture'];
        await host.recoverHeldGenerations();
        expect(host.saveReply).toHaveBeenCalledWith(expect.objectContaining({
            getMessage: '', reasoning: 'A complete thought', imageUrls: ['data:image/png;base64,fixture'],
        }));
        expect(host.discardGeneration).toHaveBeenCalledTimes(1);
    });

    test.each(['list', 'read'])('does not write into another chat when it changes during %s', async step => {
        const { host, job } = recoveryHost();
        if (step === 'list') host.listRecoverableGenerations.mockImplementation(async () => { host.chatGeneration++; return [job]; });
        else host.openHeldGeneration.mockImplementation(async () => { host.chatGeneration++; return Response.json({ text: 'Final reply' }); });
        await host.recoverHeldGenerations();
        expect(host.saveReply).not.toHaveBeenCalled();
        expect(host.discardGeneration).not.toHaveBeenCalled();
    });

    test('a held reply that cannot be read is retried twice, then dropped with one notice', async () => {
        const { host, job } = recoveryHost();
        job.context.streaming = true;
        host.readChatCompletionStream = () => async function* () {
            yield { text: 'Partial' };
            throw new Error('Stream ended without a finish signal');
        };
        await expect(host.recoverHeldGenerations()).rejects.toThrow('finish signal');
        await expect(host.recoverHeldGenerations()).rejects.toThrow('finish signal');
        expect(host.discardGeneration).not.toHaveBeenCalled();
        await host.recoverHeldGenerations();
        expect(host.discardGeneration).toHaveBeenCalledWith(job.id, {});
        expect(host.toastr.error).toHaveBeenCalledTimes(1);
        expect(host.toastr.info).not.toHaveBeenCalled();
        expect(host.saveReply).not.toHaveBeenCalled();
    });

    test('a lookup that keeps failing is retried less and less often, and promptly again after a success or a wake-up', async () => {
        const { host, runTimer } = recoveryHost();
        host.console = { warn: jest.fn() };
        host.listRecoverableGenerations.mockRejectedValue(new TypeError('Failed to fetch'));
        host.scheduleHeldGenerationRecovery();
        const delays = [];
        for (let round = 0; round < 9; round++) delays.push(await runTimer());
        expect(delays).toEqual([2000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
        expect(host.listRecoverableGenerations).toHaveBeenCalledTimes(9);
        expect(host.console.warn).toHaveBeenCalledTimes(9);

        // The page's online, pageshow and visibilitychange listeners call this.
        host.scheduleHeldGenerationRecovery();
        expect(host.setTimeout.mock.calls.at(-1)[1]).toBe(2000);

        host.listRecoverableGenerations.mockResolvedValueOnce([]);
        const timers = host.setTimeout.mock.calls.length;
        await runTimer();
        expect(host.setTimeout).toHaveBeenCalledTimes(timers);
        host.listRecoverableGenerations.mockRejectedValue(new TypeError('Failed to fetch'));
        host.scheduleHeldGenerationRecovery();
        await runTimer();
        expect(host.setTimeout.mock.calls.at(-1)[1]).toBe(2000);
    });

    test.each(['online', 'pageshow', 'visibilitychange'])('a failed first lookup after %s restarts the short retry delays', async event => {
        const { host, timers, runTimer, wake } = recoveryHost();
        host.console = { warn: jest.fn() };
        host.listRecoverableGenerations.mockRejectedValue(new TypeError('Failed to fetch'));
        host.scheduleHeldGenerationRecovery();
        for (let round = 0; round < 7; round++) await runTimer();
        expect([...timers.values()][0].delay).toBe(60000);

        wake(event);
        const delays = [];
        for (let round = 0; round < 4; round++) delays.push(await runTimer());
        expect(delays).toEqual([2000, 2000, 4000, 8000]);
        expect(timers.size).toBe(1);
    });

    test.each(['online', 'pageshow', 'visibilitychange'])('a lookup started before %s cannot replace the wake timer when it fails late', async event => {
        const { host, timers, runTimer, wake } = recoveryHost();
        host.console = { warn: jest.fn() };
        host.listRecoverableGenerations.mockRejectedValue(new TypeError('Failed to fetch'));
        host.scheduleHeldGenerationRecovery();
        for (let round = 0; round < 7; round++) await runTimer();

        let rejectLookup;
        host.listRecoverableGenerations.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectLookup = reject; }));
        await runTimer();
        expect(timers.size).toBe(0);
        wake(event);
        const [wakeTimerId] = timers.keys();
        const scheduled = host.setTimeout.mock.calls.length;
        rejectLookup(new TypeError('Failed to fetch'));
        await new Promise(resolve => setImmediate(resolve));
        expect(host.setTimeout).toHaveBeenCalledTimes(scheduled);
        expect([...timers.keys()]).toEqual([wakeTimerId]);
        expect(timers.get(wakeTimerId).delay).toBe(2000);
        expect(await runTimer()).toBe(2000);
        expect(await runTimer()).toBe(2000);
        expect(timers.size).toBe(1);
    });

    test('recovery keeps one short timer when the wake timer fires before an older lookup settles', async () => {
        const { host, timers, runTimer, wake } = recoveryHost();
        host.console = { warn: jest.fn() };
        host.listRecoverableGenerations.mockRejectedValue(new TypeError('Failed to fetch'));
        host.scheduleHeldGenerationRecovery();
        for (let round = 0; round < 7; round++) await runTimer();
        let rejectLookup;
        host.listRecoverableGenerations.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectLookup = reject; }));
        await runTimer();
        wake('online');
        expect(await runTimer()).toBe(2000);
        expect(host.listRecoverableGenerations).toHaveBeenCalledTimes(8);
        const scheduled = host.setTimeout.mock.calls.length;
        rejectLookup(new TypeError('Failed to fetch'));
        await new Promise(resolve => setImmediate(resolve));
        expect(host.setTimeout).toHaveBeenCalledTimes(scheduled);
        expect(timers.size).toBe(1);
        expect(await runTimer()).toBe(2000);
        expect(await runTimer()).toBe(2000);
        expect(host.listRecoverableGenerations).toHaveBeenCalledTimes(10);
    });

    test('defers recovery while another generation owns the chat', async () => {
        const { host } = recoveryHost();
        host.activeGenerationRun = {};
        await host.recoverHeldGenerations();
        expect(host.listRecoverableGenerations).not.toHaveBeenCalled();
        expect(host.setTimeout).toHaveBeenCalled();
    });

    test('a reply cut short is saved without claiming the server copy, so recovery can complete it', async () => {
        const { host } = recoveryHost();
        host.chat.push({ mes: 'Partial', is_user: false, gen_started: new Date(1000), extra: {} });
        expect(await host.saveChatWithHeldReply({ id: 'held-reply' }, () => true, { keepHeld: true })).toBe(true);
        expect(host.saveChatConditional).toHaveBeenCalledTimes(1);
        expect(host.discardGeneration).not.toHaveBeenCalled();
        expect(host.chat.at(-1).extra.resumable_generation_id).toBeUndefined();
        await host.recoverHeldGenerations();
        expect(host.saveReply).toHaveBeenCalledWith(expect.objectContaining({ type: 'appendFinal', getMessage: 'Final reply' }));
        expect(host.discardGeneration).toHaveBeenCalledTimes(1);
    });
});
