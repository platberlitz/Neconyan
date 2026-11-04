/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { REVERSE_PROXY_SUPPORTED_SOURCES } from '../public/scripts/chat-request-controls.js';

const openAiSource = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function functionSource(source, name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start) + 2;
    if (start < 0 || end < 2) {
        throw new Error(`Missing function: ${name}`);
    }
    return `${source.slice(start - 6, start) === 'async ' ? 'async ' : ''}${source.slice(start, end)}`;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createHarness() {
    const constantsStart = openAiSource.indexOf('export const chat_completion_sources =');
    const constantsEnd = openAiSource.indexOf('const REVERSE_PROXY_SOURCE_LABELS', constantsStart);
    const context = createContext({
        AbortController,
        REVERSE_PROXY_SUPPORTED_SOURCES,
        AbortReason: Error,
        main_api: 'openai',
        oai_settings: { chat_completion_source: 'linkapi', linkapi_endpoint: 'global', reverse_proxy: '', proxy_password: '' },
        getChatCompletionModel: settings => settings.google_model || '',
        makerReasoningRouteEpoch: 0,
        modelReasoningRouteBySource: new Map(),
        invalidateMakerReasoningRoute: () => { context.modelReasoningRouteBySource.delete('makersuite'); context.makerReasoningRouteEpoch++; },
        updateChatCompletionReasoningAvailability: jest.fn(),
        secret_state: new Proxy({}, { get: () => true }),
        SECRET_KEYS: new Proxy({}, { get: (_, key) => key }),
        selected_custom_endpoint_preset: null,
        abortStatusCheck: new AbortController(),
        online_status: 'no_connection',
        loading: false,
        connectDisabled: false,
        document: {},
        models: [],
        fetch: jest.fn(),
        URL,
        DOMPurify: { sanitize: value => value },
        Popup: { show: { confirm: jest.fn().mockResolvedValue(true) } },
        renderTemplateAsync: jest.fn().mockResolvedValue('proxy warning'),
        getStringHash: value => value,
        accountStorage: { getItem: () => 'true', setItem: jest.fn() },
        updateFeatureSupportFlags: jest.fn(),
        saveSettingsDebounced: jest.fn(),
        writeSecret: jest.fn(),
        getRequestHeaders: () => ({}),
        isValidUrl: value => URL.canParse(value),
        t: strings => strings.join(''),
        console: { error: jest.fn(), log: jest.fn(), debug: jest.fn() },
        toastr: { error: jest.fn() },
        displayOnlineStatus: jest.fn(),
        $: selector => ({
            val: () => '',
            empty: () => {},
            show: () => { if (selector === '.api_loading') context.loading = true; },
            hide: () => { if (selector === '.api_loading') context.loading = false; },
            addClass: name => { if (selector === '.api_button' && name === 'disabled') context.connectDisabled = true; },
            removeClass: name => { if (selector === '.api_button' && name === 'disabled') context.connectDisabled = false; },
            on: (event, target, handler) => {
                if (selector !== context.document || event !== 'click' || target !== '.api_loading') {
                    throw new Error('Unexpected cancel handler registration');
                }
                context.cancelClick = handler;
            },
        }),
    });
    runInContext(`
        ${openAiSource.slice(constantsStart, constantsEnd).replace('export { REVERSE_PROXY_SUPPORTED_SOURCES };', '').replaceAll('export ', '')}
        function setOnlineStatus(status) { online_status = status; }
        ${functionSource(scriptSource, 'startStatusLoading')}
        ${functionSource(scriptSource, 'stopStatusLoading')}
        ${functionSource(scriptSource, 'resultCheckStatus')}
        function saveModelList(data) { models = data; }
        ${functionSource(scriptSource, 'cancelStatusCheck')}
        ${functionSource(openAiSource, 'validateReverseProxy')}
const pendingProxyConfirmations = new Map();
${functionSource(openAiSource, 'confirmProxyAddress')}
${functionSource(openAiSource, 'confirmSavedProxy')}
        ${functionSource(openAiSource, 'getStatusOpen')}
        ${functionSource(openAiSource, 'onConnectButtonClick')}
    `, context);
    const cancelHandlerStart = scriptSource.indexOf('$(document).on(\'click\', \'.api_loading\',');
    if (cancelHandlerStart < 0) {
        throw new Error('Missing manual status cancellation handler');
    }
    runInContext(scriptSource.slice(cancelHandlerStart, scriptSource.indexOf('\n\n', cancelHandlerStart)), context);
    return {
        context,
        connect: () => context.onConnectButtonClick({ stopPropagation() {} }),
        cancel: () => context.cancelClick(),
        switchSource(source) {
            context.cancelStatusCheck('Chat Completion source changed');
            context.oai_settings.chat_completion_source = source;
        },
    };
}

function response(models) {
    return { ok: true, json: async () => ({ data: models.map(id => ({ id })) }) };
}

describe('Chat Completion reconnect status ownership', () => {
    test.each([
        ['fetch', false],
        ['fetch', true],
        ['body', false],
        ['body', true],
    ])('manual cancel during %s cleans up immediately and protects reconnect (completed: %s)', async (phase, completed) => {
        const { context, connect, cancel } = createHarness();
        const oldResult = deferred();
        const newRequest = deferred();
        const parsing = deferred();
        const json = () => {
            parsing.resolve();
            return oldResult.promise;
        };
        context.fetch.mockReturnValueOnce(phase === 'fetch' ? oldResult.promise : Promise.resolve({ ok: true, json }))
            .mockReturnValueOnce(newRequest.promise);

        const first = connect();
        if (phase === 'body') await parsing.promise;
        const oldSignal = context.fetch.mock.calls[0][1].signal;
        expect(context.loading).toBe(true);
        expect(context.connectDisabled).toBe(true);

        cancel();

        expect(oldSignal.aborted).toBe(true);
        expect(context.abortStatusCheck.signal.aborted).toBe(false);
        expect(context.online_status).toBe('no_connection');
        expect(context.loading).toBe(false);
        expect(context.connectDisabled).toBe(false);

        const second = connect();
        expect(context.loading).toBe(true);
        expect(context.connectDisabled).toBe(true);
        const newSignal = context.fetch.mock.calls[1][1].signal;
        if (completed) {
            newRequest.resolve(response(['new-model']));
            await second;
        }

        if (phase === 'fetch') {
            oldResult.reject(oldSignal.reason);
        } else {
            oldResult.resolve({ data: [{ id: 'old-model' }] });
        }
        await first;

        expect(newSignal.aborted).toBe(false);
        expect(context.loading).toBe(!completed);
        expect(context.connectDisabled).toBe(!completed);
        expect(context.online_status).toBe(completed ? 'Valid' : 'no_connection');
        expect(context.models).toEqual(completed ? [{ id: 'new-model' }] : []);

        if (!completed) {
            newRequest.resolve(response(['new-model']));
            await second;
        }
        expect(context.online_status).toBe('Valid');
        expect(context.models).toEqual([{ id: 'new-model' }]);
        expect(context.loading).toBe(false);
        expect(context.connectDisabled).toBe(false);
    });

    test.each(['linkapi', 'openai'])('connects to %s when requests do not overlap', async source => {
        const { context, connect, switchSource } = createHarness();
        switchSource(source);
        context.fetch.mockResolvedValue(response(['saved-model']));

        await connect();

        expect(context.online_status).toBe('Valid');
        expect(context.loading).toBe(false);
        expect(context.models).toEqual([{ id: 'saved-model' }]);
    });

    test('an older startup failure cannot disconnect a successful reconnect', async () => {
        const { context, connect } = createHarness();
        const startup = deferred();
        context.fetch.mockReturnValueOnce(startup.promise).mockResolvedValueOnce(response(['saved-linkapi-model']));

        const first = connect();
        await connect();
        expect(context.online_status).toBe('Valid');

        startup.reject(new Error('Connection interrupted'));
        await first;

        expect(context.online_status).toBe('Valid');
        expect(context.models).toEqual([{ id: 'saved-linkapi-model' }]);
    });

    test('switching profiles keeps the new connection loading when the old request aborts', async () => {
        const { context, connect, switchSource } = createHarness();
        const oldRequest = deferred();
        const newRequest = deferred();
        context.fetch.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);

        const first = connect();
        switchSource('openai');
        const second = connect();
        oldRequest.reject(new Error('Aborted'));
        await first;
        const loadingBeforeResponse = context.loading;
        newRequest.resolve(response(['proxy-model']));
        await second;

        expect(loadingBeforeResponse).toBe(true);
        expect(context.online_status).toBe('Valid');
    });

    test.each(['linkapi', 'openai'])('a stale model response cannot replace the model list after reconnecting to %s', async source => {
        const { context, connect, switchSource } = createHarness();
        const oldBody = deferred();
        context.fetch.mockResolvedValueOnce({ ok: true, json: () => oldBody.promise });
        const first = connect();
        await Promise.resolve();

        switchSource(source);
        context.fetch.mockResolvedValueOnce(response(['proxy-model']));
        await connect();
        oldBody.resolve({ data: [{ id: 'old-linkapi-model' }] });
        await first;

        expect(context.models).toEqual([{ id: 'proxy-model' }]);
        expect(context.online_status).toBe('Valid');
    });

    test('a status response cannot reconnect an inactive API', async () => {
        const { context, connect } = createHarness();
        const request = deferred();
        context.fetch.mockReturnValueOnce(request.promise);
        const pending = connect();
        context.main_api = 'textgenerationwebui';
        context.online_status = 'Text Completion connected';
        request.resolve(response(['old-linkapi-model']));
        await pending;

        expect(context.online_status).toBe('Text Completion connected');
        expect(context.models).toEqual([]);
    });

    test.each([true, false])('ignores a superseded proxy confirmation resolving to %s', async confirmation => {
        const { context, connect, switchSource } = createHarness();
        const popup = deferred();
        context.accountStorage.getItem = () => null;
        context.Popup.show.confirm.mockReturnValueOnce(popup.promise);
        switchSource('openai');
        context.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        const first = connect();
        await Promise.resolve();

        switchSource('linkapi');
        context.fetch.mockResolvedValueOnce(response(['saved-linkapi-model']));
        await connect();
        popup.resolve(confirmation);
        await first;

        expect(context.fetch).toHaveBeenCalledTimes(1);
        expect(context.online_status).toBe('Valid');
        expect(context.models).toEqual([{ id: 'saved-linkapi-model' }]);
        expect(context.accountStorage.setItem).not.toHaveBeenCalled();
        expect(context.toastr.error).not.toHaveBeenCalled();
    });

    test('a current provider failure remains disconnected', async () => {
        const { context, connect } = createHarness();
        context.fetch.mockRejectedValueOnce(new Error('Connection interrupted'));
        await connect();

        expect(context.online_status).toBe('no_connection');
        expect(context.loading).toBe(false);
    });

    test('an invalid proxy ends the loading state and allows a later reconnect', async () => {
        const { context, connect, switchSource } = createHarness();
        switchSource('openai');
        context.oai_settings.reverse_proxy = 'invalid proxy';

        await expect(connect()).resolves.toBeUndefined();
        expect(context.loading).toBe(false);
        expect(context.online_status).toBe('no_connection');
        expect(context.fetch).not.toHaveBeenCalled();

        context.oai_settings.reverse_proxy = 'https://proxy.example/v1';
        context.fetch.mockResolvedValueOnce(response(['proxy-model']));
        await connect();
        expect(context.online_status).toBe('Valid');
    });
});

describe('Chat Completion reverse proxy validation', () => {
    test.each(['https://live.invalid', ''])('confirms the proxy it is given, not the live setting (live: %j)', async live => {
        const { context } = createHarness();
        context.oai_settings.reverse_proxy = live;
        context.accountStorage.getItem = () => 'false';
        await context.validateReverseProxy(undefined, 'https://passed.invalid');
        expect(context.renderTemplateAsync).toHaveBeenCalledWith('proxyConnectionWarning', { proxyURL: 'https://passed.invalid' });
        expect(context.accountStorage.setItem).toHaveBeenCalledWith('Proxy_SkipConfirm_https://passed.invalid', 'true');
        expect(context.accountStorage.setItem).toHaveBeenCalledTimes(1);
    });

    test('rejects an invalid passed proxy even when the live setting is valid', async () => {
        const { context } = createHarness();
        context.oai_settings.reverse_proxy = 'https://live.invalid';
        context.online_status = 'Valid';
        await expect(context.validateReverseProxy(undefined, 'not a url')).rejects.toThrow();
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(context.online_status).toBe('no_connection');
        expect(context.accountStorage.setItem).not.toHaveBeenCalled();
    });

    test('validates the live setting when no proxy is passed (status check path)', async () => {
        const { context } = createHarness();
        context.oai_settings.reverse_proxy = 'https://live.invalid';
        context.accountStorage.getItem = () => 'false';
        await context.validateReverseProxy(undefined);
        expect(context.renderTemplateAsync).toHaveBeenCalledWith('proxyConnectionWarning', { proxyURL: 'https://live.invalid' });
        expect(context.accountStorage.setItem).toHaveBeenCalledWith('Proxy_SkipConfirm_https://live.invalid', 'true');
    });

    test('confirms the proxy every request sends, and only the main proxy marks the connection', () => {
        expect(openAiSource).toContain('const mainProxy = settings.reverse_proxy === oai_settings.reverse_proxy;');
        expect(openAiSource).toContain('validateReverseProxy: proxy => validateReverseProxy(undefined, proxy, { markConnection: mainProxy }),');
        expect(openAiSource).not.toContain('forwardProxy');
    });

    test('a declined proxy for a side request leaves the main connection status alone', async () => {
        const { context } = createHarness();
        context.online_status = 'Valid';
        context.accountStorage.getItem = () => 'false';
        context.Popup.show.confirm.mockResolvedValueOnce(false);
        await expect(context.validateReverseProxy(undefined, 'https://profile.invalid', { markConnection: false })).rejects.toThrow('Proxy connection denied.');
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(context.online_status).toBe('Valid');
    });

    test('an invalid proxy for a side request leaves the main connection status alone', async () => {
        const { context } = createHarness();
        context.online_status = 'Valid';
        await expect(context.validateReverseProxy(undefined, 'not a url', { markConnection: false })).rejects.toThrow();
        expect(context.toastr.error).toHaveBeenCalledTimes(1);
        expect(context.online_status).toBe('Valid');
    });

    test('requests waiting on the same new address share one confirmation', async () => {
        const { context } = createHarness();
        const popup = deferred();
        context.accountStorage.getItem = () => 'false';
        context.Popup.show.confirm.mockReturnValueOnce(popup.promise);
        const first = context.validateReverseProxy(undefined, 'https://shared.invalid');
        const second = context.validateReverseProxy(undefined, 'https://shared.invalid');
        await new Promise(resolve => setImmediate(resolve));
        popup.resolve(true);
        await Promise.all([first, second]);
        expect(context.Popup.show.confirm).toHaveBeenCalledTimes(1);
    });

    test('a confirmed address is not asked about again', async () => {
        const { context } = createHarness();
        const stored = new Map();
        context.accountStorage.getItem = key => stored.get(key) ?? null;
        context.accountStorage.setItem.mockImplementation((key, value) => stored.set(key, value));
        await context.validateReverseProxy(undefined, 'https://once.invalid');
        await context.validateReverseProxy(undefined, 'https://once.invalid');
        expect(context.Popup.show.confirm).toHaveBeenCalledTimes(1);
        expect(stored.get('Proxy_SkipConfirm_https://once.invalid')).toBe('true');
    });
});

describe('confirming a proxy when a profile or preset is saved', () => {
    function savedHarness(stored = {}) {
        const { context } = createHarness();
        const storage = new Map(Object.entries(stored));
        context.accountStorage.getItem = key => storage.get(key) ?? null;
        context.accountStorage.setItem.mockImplementation((key, value) => storage.set(key, value));
        context.toastr.warning = jest.fn();
        return { context, storage };
    }

    test('does not ask about an address confirmed before', async () => {
        const { context } = savedHarness({ 'Proxy_SkipConfirm_https://known.invalid': 'true' });
        await expect(context.confirmSavedProxy('https://known.invalid', 'openai', 'declined')).resolves.toBe(true);
        expect(context.Popup.show.confirm).not.toHaveBeenCalled();
    });

    test('asks once about a new address and remembers a yes', async () => {
        const { context, storage } = savedHarness();
        await expect(context.confirmSavedProxy('https://new.invalid', 'claude', 'declined')).resolves.toBe(true);
        expect(context.renderTemplateAsync).toHaveBeenCalledWith('proxyConnectionWarning', { proxyURL: 'https://new.invalid' });
        expect(storage.get('Proxy_SkipConfirm_https://new.invalid')).toBe('true');
    });

    test('a no shows the caller message and remembers nothing', async () => {
        const { context, storage } = savedHarness();
        context.Popup.show.confirm.mockResolvedValueOnce(false);
        await expect(context.confirmSavedProxy('https://new.invalid', 'openai', 'Not saved fixture')).resolves.toBe(false);
        expect(context.toastr.warning).toHaveBeenCalledWith('Not saved fixture');
        expect(storage.size).toBe(0);
    });

    test.each([
        ['no proxy', '', 'openai'],
        ['a source that sends no proxy', 'https://new.invalid', 'openrouter'],
        ['an address that is not a web address', 'not a url', 'openai'],
    ])('does not ask for %s', async (_label, proxy, source) => {
        const { context } = savedHarness();
        await expect(context.confirmSavedProxy(proxy, source, 'declined')).resolves.toBe(true);
        expect(context.Popup.show.confirm).not.toHaveBeenCalled();
    });
});
