/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

class FakeLink extends EventTarget {
    constructor(href, { media = 'all', sheet = null } = {}) {
        super();
        this.href = href;
        this.media = media;
        this.sheet = sheet;
        this.disabled = false;
        this.dataset = {};
    }

    getAttribute(name) {
        return name === 'href' ? this.href : null;
    }

    finish(type = 'load') {
        if (type === 'load') this.sheet = { cssRules: [] };
        this.dispatchEvent(new Event(type));
    }
}

let links = [];
let resourceEntries = [];

function installBrowserStubs() {
    links = [];
    resourceEntries = [];
    globalThis.HTMLLinkElement = FakeLink;
    globalThis.window = globalThis;
    globalThis.matchMedia = (query) => ({ matches: query !== '(max-width: 768px)' });
    globalThis.document = {
        baseURI: 'http://neconyan.test/',
        fonts: { status: 'loaded', ready: Promise.resolve() },
        querySelectorAll: () => links,
    };
    jest.spyOn(performance, 'getEntriesByName').mockImplementation(name => resourceEntries.filter(entry => entry.name === name));
    delete globalThis.__neconyanStartupTasks;
}

function addLink(href, options) {
    const link = new FakeLink(href, options);
    links.push(link);
    return link;
}

const readiness = await import('../public/scripts/startup-readiness.js');

describe('startup readiness', () => {
    beforeEach(() => {
        installBrowserStubs();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        for (const link of links) {
            if (!link.sheet) link.finish();
        }
        jest.restoreAllMocks();
        delete globalThis.document;
        delete globalThis.matchMedia;
    });

    test('waits for a pending stylesheet before reporting ready', async () => {
        const link = addLink('http://neconyan.test/css/late.css');
        const ready = readiness.waitForStartupReadiness({ timeoutMs: 2000 });
        let settled = false;
        ready.then(() => { settled = true; });

        await new Promise(resolve => setTimeout(resolve, 30));
        expect(settled).toBe(false);

        link.finish();
        await expect(ready).resolves.toMatchObject({ timedOut: false, pending: [] });
    });

    test('turns preloaded deferred sheets on and waits for them', async () => {
        const activate = jest.fn(() => {
            const link = addLink('http://neconyan.test/css/deferred.css');
            setTimeout(() => link.finish(), 20);
        });

        const result = await readiness.waitForStartupReadiness({ timeoutMs: 2000, activateDeferredStyles: activate });

        expect(activate).toHaveBeenCalledTimes(1);
        expect(result.timedOut).toBe(false);
        expect(links[0].sheet).not.toBeNull();
    });

    test('picks up a stylesheet added while it waits, such as a shell style from settings', async () => {
        const first = addLink('http://neconyan.test/css/first.css');
        let shellStyle;
        setTimeout(() => {
            shellStyle = addLink('http://neconyan.test/css/shell-styles/windows-98.css');
            first.finish();
        }, 10);
        setTimeout(() => shellStyle.finish(), 60);

        const result = await readiness.waitForStartupReadiness({ timeoutMs: 2000 });

        expect(result.timedOut).toBe(false);
        expect(shellStyle.sheet).not.toBeNull();
    });

    test('waits for registered startup tasks such as the Agents panel', async () => {
        let mount;
        readiness.registerStartupTask('agents panel', new Promise(resolve => { mount = resolve; }));
        expect(readiness.getRegisteredStartupTaskNames()).toContain('agents panel');

        let settled = false;
        const ready = readiness.waitForStartupReadiness({ timeoutMs: 2000 }).then(result => {
            settled = true;
            return result;
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(settled).toBe(false);

        mount();
        await expect(ready).resolves.toMatchObject({ timedOut: false });
    });

    test('a failing startup task does not hold startup', async () => {
        readiness.registerStartupTask('broken', Promise.reject(new Error('boom')));
        const result = await readiness.waitForStartupReadiness({ timeoutMs: 2000 });
        expect(result.timedOut).toBe(false);
    });

    test('gives up at the cap when a stylesheet never loads', async () => {
        addLink('http://neconyan.test/css/stuck.css');
        const startedAt = Date.now();

        const result = await readiness.waitForStartupReadiness({ timeoutMs: 80 });

        expect(result.timedOut).toBe(true);
        expect(result.pending).toEqual(['http://neconyan.test/css/stuck.css']);
        expect(Date.now() - startedAt).toBeLessThan(1000);
    });

    test('does not wait for sheets whose media query does not match, or that failed', async () => {
        addLink('http://neconyan.test/css/mobile.css', { media: '(max-width: 768px)' });
        const failed = addLink('http://neconyan.test/css/missing.css');
        resourceEntries.push({ name: failed.href, responseEnd: Math.max(1, performance.now() - 1000) });
        const errored = addLink('http://neconyan.test/css/error.css');
        errored.dataset.sbStyleFailed = 'true';

        expect(readiness.collectPendingStylesheets()).toEqual([]);
        const result = await readiness.waitForStartupReadiness({ timeoutMs: 2000 });
        expect(result.timedOut).toBe(false);
    });

    test('a sheet parked on print media by loadStylesheetAsync still counts as pending', () => {
        const parked = addLink('http://neconyan.test/css/low-priority.css', { media: 'print' });
        expect(readiness.collectPendingStylesheets()).toEqual([parked]);
    });

    test('marks a stylesheet that errors so later checks skip it', async () => {
        const link = addLink('http://neconyan.test/css/broken.css');
        const wait = readiness.waitForStylesheet(link);
        link.finish('error');
        await wait;
        expect(link.dataset.sbStyleFailed).toBe('true');
        expect(readiness.isStylesheetSettled(link)).toBe(true);
    });
});
