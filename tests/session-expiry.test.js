import { describe, expect, jest, test } from '@jest/globals';
import { installSessionExpiryNotifier } from '../public/scripts/session-expiry.js';

function setup() {
    class Request extends EventTarget {
        status = 401;
        responseURL = 'https://neconyan.example/api/settings/save';
        getResponseHeader() { return 'required'; }
        send() { this.dispatchEvent(new Event('loadend')); }
    }
    const target = { location: { origin: 'https://neconyan.example' }, fetch: jest.fn(), XMLHttpRequest: Request };
    const fetch = target.fetch;
    const notify = jest.fn();
    installSessionExpiryNotifier(target, notify);
    return { target, fetch, notify };
}

function response(status, marker = 'required', url = 'https://neconyan.example/api/ping') {
    const result = new Response('original response', { status, headers: marker ? { 'X-Neconyan-Auth': marker } : {} });
    Object.defineProperty(result, 'url', { value: url });
    return result;
}

describe('session-expired notifications', () => {
    test.each([401, 403])('recognises app sign-out (%s) without changing the request or consuming its response', async status => {
        const { target, fetch, notify } = setup();
        const original = response(status);
        fetch.mockResolvedValue(original);
        const options = { method: 'POST', body: 'draft' };
        const result = await target.fetch('/api/ping', options);
        expect(result).toBe(original);
        expect(fetch).toHaveBeenCalledWith('/api/ping', options);
        expect(fetch.mock.contexts[0]).toBe(target);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(result.bodyUsed).toBe(false);
        await expect(result.text()).resolves.toBe('original response');
    });

    test.each([
        [401, null, 'https://neconyan.example/api/provider'],
        [403, null, 'https://neconyan.example/api/settings/save'],
        [200, 'required', 'https://neconyan.example/csrf-token'],
        [401, 'required', 'https://provider.example/api/chat'],
    ])('ignores unrelated errors and successful public requests (%s, %s, %s)', async (status, marker, url) => {
        const { target, fetch, notify } = setup();
        fetch.mockResolvedValue(response(status, marker, url));
        await target.fetch(url);
        expect(notify).not.toHaveBeenCalled();
    });

    test('notifies once across simultaneous fetches and reused XMLHttpRequests', async () => {
        const { target, fetch, notify } = setup();
        fetch.mockResolvedValue(response(401));
        const xhr = new target.XMLHttpRequest();
        xhr.send();
        xhr.send();
        await Promise.all([target.fetch('/api/ping'), target.fetch('/api/ping')]);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('ignores provider XMLHttpRequest failures before a real account expiry', () => {
        const { target, notify } = setup();
        const xhr = new target.XMLHttpRequest();
        xhr.getResponseHeader = () => null;
        xhr.send();
        expect(notify).not.toHaveBeenCalled();
        xhr.getResponseHeader = () => 'required';
        xhr.status = 403;
        xhr.send();
        expect(notify).toHaveBeenCalledTimes(1);
    });

    test('preserves network failures and aborts', async () => {
        const { target, fetch, notify } = setup();
        const error = new Error('aborted');
        fetch.mockRejectedValue(error);
        await expect(target.fetch('/api/ping')).rejects.toBe(error);
        expect(notify).not.toHaveBeenCalled();
    });

    test('does not replace a response when showing the toast fails', async () => {
        const { target, fetch, notify } = setup();
        const original = response(401);
        fetch.mockResolvedValue(original);
        notify.mockImplementation(() => { throw new Error('toast unavailable'); });
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(target.fetch('/api/ping')).resolves.toBe(original);
            expect(warning).toHaveBeenCalledTimes(1);
        } finally {
            warning.mockRestore();
        }
    });

    test('installation is idempotent', async () => {
        const { target, fetch, notify } = setup();
        const wrapped = target.fetch;
        const otherNotify = jest.fn();
        installSessionExpiryNotifier(target, otherNotify);
        fetch.mockResolvedValue(response(401));
        await target.fetch('/api/ping');
        expect(target.fetch).toBe(wrapped);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(otherNotify).not.toHaveBeenCalled();
    });
});
