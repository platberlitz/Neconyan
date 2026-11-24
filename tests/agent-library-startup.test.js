import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
    STARTUP_MIGRATION_REVISION,
    composeCatalogueRevision,
    isAgentLibraryStartupSettled,
    markAgentLibraryStartupSettled,
    whenAgentLibraryStartupSettled,
} from '../public/scripts/extensions/in-chat-agents/library-startup.js';
import { __setHostForTests, waitForAgents } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js';

const indexSource = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const bundledRevision = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/revision.json', import.meta.url), 'utf8')).revision;

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function controlledStartup() {
    let settle;
    const settled = new Promise(resolve => {
        settle = resolve;
    });
    return {
        settle: () => settle(true),
        whenAgentLibraryStartupSettled: jest.fn(({ signal } = {}) => new Promise(resolve => {
            signal?.addEventListener('abort', () => resolve(false), { once: true });
            settled.then(resolve);
        })),
    };
}

describe('stored catalogue revision', () => {
    test('a bare bundled revision saved before startup migrations were versioned no longer matches', () => {
        const stored = composeCatalogueRevision(bundledRevision);
        expect(stored).toBe(`${bundledRevision}:startup-${STARTUP_MIGRATION_REVISION}`);
        expect(stored).not.toBe(bundledRevision);
        expect(composeCatalogueRevision(` ${bundledRevision}\n`)).toBe(stored);
    });

    test('an unknown bundled revision stays unknown so the library is always prepared', () => {
        expect(composeCatalogueRevision('')).toBe('');
        expect(composeCatalogueRevision(undefined)).toBe('');
    });

    test('startup compares and saves the combined revision', () => {
        expect(indexSource).toContain('const catalogueRevision = composeCatalogueRevision(await readBundledCatalogueRevision());');
        expect(indexSource).toContain('accountStorage.getItem(BUNDLED_CATALOGUE_REVISION_KEY) === catalogueRevision');
        expect(indexSource).toContain('accountStorage.setItem(BUNDLED_CATALOGUE_REVISION_KEY, catalogueRevision);');
    });

    test('the startup update notice puts each escaped line on its own row', () => {
        expect(indexSource).toContain("toastr.success(startupUpdates.map(item => escapeHtml(item)).join('<br>'), 'Agents updated', { escapeHtml: false });");
    });
});

describe('agent library startup signal', () => {
    test('waiters resolve false on abort and true once startup settles', async () => {
        expect(isAgentLibraryStartupSettled()).toBe(false);
        const controller = new AbortController();
        const aborted = whenAgentLibraryStartupSettled({ signal: controller.signal });
        const waiting = whenAgentLibraryStartupSettled();
        controller.abort();
        expect(await aborted).toBe(false);

        markAgentLibraryStartupSettled();
        markAgentLibraryStartupSettled();
        expect(await waiting).toBe(true);
        expect(isAgentLibraryStartupSettled()).toBe(true);
        expect(await whenAgentLibraryStartupSettled()).toBe(true);
    });

    test('initialisation settles after its startup migrations, including when they fail', () => {
        const init = indexSource.slice(indexSource.indexOf('const catalogueRevision = composeCatalogueRevision('));
        const finallyBlock = init.slice(init.indexOf('} finally {'), init.indexOf('// Initialize the pipeline runner'));
        expect(init.indexOf('await finishAgentLibraryInitialization();')).toBeLessThan(init.indexOf('} finally {'));
        expect(finallyBlock).toContain('markAgentLibraryStartupSettled();');
    });
});

describe('Regex Agent Themes waits for In-Chat Agents startup', () => {
    afterEach(() => {
        __setHostForTests(null);
    });

    test('loaded agents are not reconciled until startup migrations finish', async () => {
        const agents = [{ id: 'agent-plot', regexScripts: [] }];
        const startup = controlledStartup();
        __setHostForTests({ ok: true, store: { getAgents: () => agents }, scripts: {}, startup });

        let result = null;
        const waiting = waitForAgents({ attempts: 1, delayMs: 1 }).then(value => {
            result = value;
        });
        await flush();
        expect(result).toBeNull();

        agents[0].regexScripts.push({ id: 'plot-compass-card' });
        startup.settle();
        await waiting;
        expect(result).toMatchObject({ ok: true, ready: true });
        expect(startup.whenAgentLibraryStartupSettled).toHaveBeenCalledTimes(1);
    });

    test('cancelling the boot stops the wait', async () => {
        const startup = controlledStartup();
        __setHostForTests({ ok: true, store: { getAgents: () => [{ id: 'a' }] }, scripts: {}, startup });
        const controller = new AbortController();
        const waiting = waitForAgents({ signal: controller.signal });
        controller.abort();
        expect(await waiting).toMatchObject({ ok: false, ready: false, cancelled: true });
    });

    test('an In-Chat Agents build without the signal keeps the old polling', async () => {
        __setHostForTests({ ok: true, store: { getAgents: () => [{ id: 'a' }] }, scripts: {} });
        expect(await waitForAgents({ attempts: 1, delayMs: 1 })).toMatchObject({ ok: true, ready: true });
    });

    test('the host loads the startup signal by absolute URL and tolerates its absence', () => {
        const hostSource = readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js', import.meta.url), 'utf8');
        expect(hostSource).toContain('\'/scripts/extensions/in-chat-agents/library-startup.js\'');
        expect(hostSource).toContain('import(STARTUP_URL).catch(() => null)');
    });
});
