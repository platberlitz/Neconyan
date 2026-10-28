/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('shared template downloads', () => {
    let requests, compile, sanitize, applyLocale, renderTemplateAsync;

    beforeEach(async () => {
        jest.resetModules();
        requests = [];
        compile = jest.fn(source => data => `${source}:${data.name}`);
        sanitize = jest.fn(html => `safe(${html})`);
        applyLocale = jest.fn(html => `local(${html})`);
        jest.unstable_mockModule('../public/lib.js', () => ({ Handlebars: { compile }, DOMPurify: { sanitize } }));
        jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ applyLocale }));
        globalThis.XMLHttpRequest = class {
            open(method, url) { this.url = url; }
            send() { requests.push(this); }
        };
        globalThis.toastr = { error: jest.fn() };
        jest.spyOn(console, 'error').mockImplementation(() => {});
        ({ renderTemplateAsync } = await import('../public/scripts/templates.js'));
    });

    afterEach(() => {
        delete globalThis.XMLHttpRequest;
        delete globalThis.toastr;
        jest.restoreAllMocks();
    });

    function respond(request, status = 200) {
        Object.assign(request, { status, responseText: 'template', statusText: 'response' });
        request.onload();
    }

    test('concurrent callers share one request while keeping data and rendering options separate', async () => {
        const first = renderTemplateAsync('card', { name: 'first' });
        const second = renderTemplateAsync('card', { name: 'second' }, false, false);
        expect(requests).toHaveLength(1);
        respond(requests[0]);
        await expect(first).resolves.toBe('local(safe(template:first))');
        await expect(second).resolves.toBe('template:second');
        expect(compile).toHaveBeenCalledTimes(1);
        await expect(renderTemplateAsync('card', { name: 'cached' }, false, false)).resolves.toBe('template:cached');
        expect(requests).toHaveLength(1);
    });

    test('a failed shared request can be retried', async () => {
        const first = renderTemplateAsync('card');
        const second = renderTemplateAsync('card');
        respond(requests[0], 503);
        await Promise.all([first, second]);
        const retry = renderTemplateAsync('card', { name: 'retry' }, false, false);
        expect(requests).toHaveLength(2);
        respond(requests[1]);
        await expect(retry).resolves.toBe('template:retry');
    });

    test('different template paths still load independently', async () => {
        const first = renderTemplateAsync('card');
        const second = renderTemplateAsync('/extension/card.html', {}, true, true, true);
        expect(requests.map(request => request.url)).toEqual(['/scripts/templates/card.html', '/extension/card.html']);
        requests.forEach(request => respond(request));
        await Promise.all([first, second]);
        expect(compile).toHaveBeenCalledTimes(2);
    });
});
