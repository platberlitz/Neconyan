/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { readableBackendError } from '../public/scripts/text-backend-failures.js';

// Run the real request functions of each text backend without booting the browser application.
function load(context, file, names) {
    const source = readFileSync(new URL(`../public/scripts/${file}`, import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node)
            .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name} in ${file}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}

function runtime(file, names) {
    const context = vm.createContext({
        console: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        toastr: { error: jest.fn(), warning: jest.fn() },
        Response, TransformStream, TextDecoderStream, MessageEvent,
        main_api: 'kobold', online_status: 'model',
        nai_settings: { streaming_novel: true },
        textgenerationwebui_settings: { type: 'llamacpp' },
        getRequestHeaders: () => ({}),
        readableBackendError,
        watchTextBackend: () => ({ run: work => work(), rejected: () => {}, inspect: async () => {} }),
        streamCompletionSignal: () => false, isGenerationLengthFinish: () => false, parseTextgenLogprobs: () => null,
        fetchResumable: jest.fn(),
    });
    load(context, file, names);
    return context;
}

const BACKENDS = {
    'Text Completion': { file: 'textgen-settings.js', names: ['tryParseStreamingError', 'readTextGenerationStream', 'generateTextGenWithStreaming'], send: 'generateTextGenWithStreaming', title: 'Text Completion API', warning: ['[Text Completion API] The backend returned an error.', 'Out of memory'] },
    KoboldAI: { file: 'kai-settings.js', names: ['tryParseStreamingError', 'generateKoboldWithStreaming'], send: 'generateKoboldWithStreaming', title: 'KoboldAI API', warning: ['[KoboldAI API] The backend returned an error.', 'Out of memory', expect.anything()] },
    NovelAI: { file: 'nai-settings.js', names: ['tryParseStreamingError', 'generateNovelWithStreaming'], send: 'generateNovelWithStreaming', title: 'NovelAI API', warning: ['[NovelAI API] The backend returned an error.', 'Out of memory', expect.anything()] },
};

async function failedRequest(name, quiet) {
    const backend = BACKENDS[name];
    const context = runtime(backend.file, backend.names);
    context.fetchResumable.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Out of memory' } }), { status: 500, statusText: 'Server Error' }));
    const options = quiet === undefined ? [] : [{ quiet }];
    await expect(context[backend.send]({ model: 'test' }, new AbortController().signal, ...options)).rejects.toThrow('Out of memory');
    return { context, backend };
}

describe('backend errors on quiet text requests', () => {
    test.each(Object.keys(BACKENDS))('%s: a quiet request logs the error and leaves the toast to its caller', async name => {
        const { context, backend } = await failedRequest(name, true);
        expect(context.toastr.error).not.toHaveBeenCalled();
        expect(context.console.warn).toHaveBeenCalledWith(...backend.warning);
    });

    test.each(Object.keys(BACKENDS))('%s: a normal request still shows the error once', async name => {
        const { context, backend } = await failedRequest(name, undefined);
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(context.toastr.error).toHaveBeenCalledWith('Out of memory', backend.title);
        expect(context.console.warn).toHaveBeenCalledWith(...backend.warning);
    });

    test.each([true, false])('a Text Completion error without a message is logged, and shown only when not quiet (quiet: %s)', async quiet => {
        const context = runtime(BACKENDS['Text Completion'].file, BACKENDS['Text Completion'].names);
        context.fetchResumable.mockResolvedValue(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));
        await expect(context.generateTextGenWithStreaming({ model: 'test' }, new AbortController().signal, { quiet })).rejects.toThrow('Got response status 400');
        expect(context.console.warn).toHaveBeenCalledWith('[Text Completion API] The backend returned an error.', 'HTTP 400: Bad Request');
        expect(context.toastr.error).toHaveBeenCalledTimes(quiet ? 0 : 1);
    });

    test.each([true, false])('an error inside a Text Completion stream follows the same rule (quiet: %s)', async quiet => {
        const context = runtime(BACKENDS['Text Completion'].file, BACKENDS['Text Completion'].names);
        load(context, 'sse-stream.js', ['EventSourceStream']);
        context.getEventSourceStream = vm.runInContext('() => new EventSourceStream()', context);
        context.fetchResumable.mockResolvedValue(new Response('data: {"error":{"message":"Context overflow"}}\n\n'));
        const stream = await context.generateTextGenWithStreaming({ model: 'test' }, new AbortController().signal, { quiet });
        const reading = (async () => {
            for await (const chunk of stream()) void chunk;
        })();
        await expect(reading).rejects.toThrow('Context overflow');
        expect(context.console.warn).toHaveBeenCalledWith('[Text Completion API] The backend returned an error.', 'Context overflow');
        expect(context.toastr.error).toHaveBeenCalledTimes(quiet ? 0 : 1);
    });
});
