import { describe, expect, jest, test } from '@jest/globals';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_DIRECTORIES } from '../src/constants.js';
import { NECONYAN_NATIVE_EXTENSIONS } from '../src/neconyan-native-extensions.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const clone = jest.fn(() => { throw new Error('Unexpected remote clone'); });
jest.unstable_mockModule('../src/git/client.js', () => ({ createGitClient: () => ({ clone }) }));
jest.unstable_mockModule('simple-git', () => ({
    CheckRepoActions: { IS_REPO_ROOT: 'IS_REPO_ROOT' },
    default: () => { throw new Error('Unexpected Git mutation'); },
}));

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: jest.fn((_, fallback) => fallback),
    isValidUrl: jest.fn(() => true),
}));

const { router, isBundledThirdPartyExtension, rejectBundledThirdPartyExtension } = await import('../src/endpoints/extensions.js');

describe('bundled third-party extensions', () => {
    test('classifies tracked bundled third-party extensions as bundled', () => {
        expect(isBundledThirdPartyExtension('Neconyan-Preset-Tools')).toBe(true);
        expect(isBundledThirdPartyExtension('ChatCompletionTabs')).toBe(true);
        expect(isBundledThirdPartyExtension('chatcompletiontabs')).toBe(true);
        expect(isBundledThirdPartyExtension('third-party/ChatCompletionTabs')).toBe(true);
        expect(isBundledThirdPartyExtension('CommunityExtension')).toBe(false);
    });

    test('rejects updater mutations for bundled third-party extensions', () => {
        const response = {
            status: jest.fn(() => response),
            send: jest.fn(),
        };

        expect(rejectBundledThirdPartyExtension('ChatCompletionTabs', response, 'deleted')).toBe(true);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('ChatCompletionTabs comes with Neconyan'));
    });

    test('rejects case-variant updater mutations for bundled third-party extensions', () => {
        const response = {
            status: jest.fn(() => response),
            send: jest.fn(),
        };

        expect(rejectBundledThirdPartyExtension('chatcompletiontabs', response, 'deleted')).toBe(true);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledWith(expect.stringContaining('chatcompletiontabs comes with Neconyan'));
    });

    // Characterisation: the server already sends these sentences, so this passes before the change too. It shows the
    // English sent for each refused action is the same whole sentence.
    test.each([
        ['installed', 'ChatCompletionTabs comes with Neconyan, so it cannot be installed from the extension updater.'],
        ['updated', 'ChatCompletionTabs comes with Neconyan, so it cannot be updated from the extension updater.'],
        ['managed', 'ChatCompletionTabs comes with Neconyan, so it cannot be managed from the extension updater.'],
        ['switched', 'ChatCompletionTabs comes with Neconyan, so it cannot be switched from the extension updater.'],
        ['moved', 'ChatCompletionTabs comes with Neconyan, so it cannot be moved from the extension updater.'],
        ['deleted', 'ChatCompletionTabs comes with Neconyan, so it cannot be deleted from the extension updater.'],
    ])('sends one whole sentence when %s is refused', (action, sentence) => {
        const response = {
            status: jest.fn(() => response),
            send: jest.fn(),
        };

        expect(rejectBundledThirdPartyExtension('ChatCompletionTabs', response, action)).toBe(true);
        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.send).toHaveBeenCalledTimes(1);
        expect(response.send).toHaveBeenCalledWith(sentence);

        const other = { status: jest.fn(() => other), send: jest.fn() };
        expect(rejectBundledThirdPartyExtension('CommunityExtension', other, action)).toBe(false);
        expect(other.status).not.toHaveBeenCalled();
        expect(other.send).not.toHaveBeenCalled();
    });

    test('names one of the six actions at every call and never inserts the action into a shared sentence', () => {
        const source = fs.readFileSync(path.join(repositoryRoot, 'src/endpoints/extensions.js'), 'utf8');
        const actions = [...source.matchAll(/rejectBundledThirdPartyExtension\(\w+, response, '(\w+)'\)/g)].map(match => match[1]);

        expect(actions).toHaveLength(6);
        expect([...new Set(actions)].sort()).toEqual(['deleted', 'installed', 'managed', 'moved', 'switched', 'updated']);
        expect(source).not.toContain('cannot be ${');
    });

    test('no locale file has the combined refusal key', () => {
        const combined = '${0} comes with Neconyan, so it cannot be ${1} from the extension updater.';
        let checked = 0;
        const withCombinedKey = [];
        for (const directory of ['public/locales', 'public/locales/neconyan']) {
            for (const file of fs.readdirSync(path.join(repositoryRoot, directory)).filter(name => name.endsWith('.json'))) {
                const data = JSON.parse(fs.readFileSync(path.join(repositoryRoot, directory, file), 'utf8'));
                checked++;
                if (data && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, combined)) {
                    withCombinedKey.push(path.join(directory, file));
                }
            }
        }
        expect(checked).toBeGreaterThan(16);
        expect(withCombinedKey).toEqual([]);
    });
});


test('native discovery owns aliases once, protects every mutation, and preserves custom moves', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-native-discovery-'));
    const original = { ...PUBLIC_DIRECTORIES };
    const local = path.join(root, 'local');
    const core = path.join(root, 'core');
    const global = path.join(core, 'third-party');
    for (const directory of [local, global]) fs.mkdirSync(directory, { recursive: true });
    PUBLIC_DIRECTORIES.extensions = core;
    PUBLIC_DIRECTORIES.globalExtensions = global;
    const request = async (method, routePath, body = {}, query = {}) => {
        const handler = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route.stack[0].handle;
        const result = { status: 200, body: undefined };
        const response = {
            status(value) { result.status = value; return this; },
            send(value) { result.body = value; return this; },
            sendStatus(value) { result.status = value; return this; },
        };
        await handler({ body, query, user: { profile: { admin: true, handle: 'native-test' }, directories: { extensions: local } } }, response);
        return result;
    };
    try {
        for (const extension of NECONYAN_NATIVE_EXTENSIONS) {
            fs.mkdirSync(extension.runtimeDirectory ? path.join(core, extension.runtimeDirectory) : path.join(global, extension.directory));
        }
        fs.mkdirSync(path.join(local, 'Neconyan-MacroEnhanced'));
        fs.writeFileSync(path.join(local, 'Neconyan-MacroEnhanced/retained.txt'), 'Retain this user copy');
        fs.mkdirSync(path.join(global, 'SillyTavern-ChatCompletionTabs'));
        fs.mkdirSync(path.join(local, 'CustomTool'));
        fs.writeFileSync(path.join(local, 'CustomTool/user.txt'), 'Custom settings');
        const discovered = await request('get', '/discover');
        const native = discovered.body.filter(entry => entry.type === 'native');
        expect(native).toHaveLength(18);
        expect(native.find(entry => entry.name === 'third-party/MacroEnhanced').aliases).toContain('Neconyan-MacroEnhanced');
        expect(native.find(entry => entry.name === 'neconyan-debugger').aliases).toContain('Neconyan-Debugger');
        expect(discovered.body.filter(entry => entry.type === 'local')).toEqual([{ type: 'local', name: 'third-party/CustomTool' }]);
        expect(fs.readFileSync(path.join(local, 'Neconyan-MacroEnhanced/retained.txt'), 'utf8')).toBe('Retain this user copy');
        fs.writeFileSync(path.join(global, 'MacroEnhanced/manifest.json'), JSON.stringify({ version: 'native' }));
        fs.writeFileSync(path.join(local, 'Neconyan-MacroEnhanced/manifest.json'), JSON.stringify({ version: 'shadowed' }));
        fs.writeFileSync(path.join(local, 'CustomTool/manifest.json'), JSON.stringify({ version: 'local' }));
        fs.writeFileSync(path.join(core, 'neconyan-debugger/manifest.json'), JSON.stringify({ version: 'core' }));
        const withManifests = (await request('get', '/discover', {}, { manifests: '1' })).body;
        expect(withManifests.find(entry => entry.name === 'third-party/MacroEnhanced').manifest).toEqual({ version: 'native' });
        expect(withManifests.find(entry => entry.name === 'third-party/CustomTool').manifest).toEqual({ version: 'local' });
        expect(withManifests.find(entry => entry.name === 'neconyan-debugger').manifest).toEqual({ version: 'core' });
        expect(withManifests.find(entry => entry.name === 'third-party/Neconyan-Time-Machine').manifest).toBeUndefined();
        const refusalMismatches = [];
        for (const extension of NECONYAN_NATIVE_EXTENSIONS) {
            const extensionName = extension.directory.toLowerCase();
            for (const route of ['/install', '/update', '/branches', '/switch', '/move', '/delete', '/sync']) {
                const result = await request('post', route, {
                    extensionName, branch: 'main', source: 'local', destination: 'global',
                    url: `https://example.invalid/${extensionName}.git`,
                });
                expect(result.status).toBe(400);
                // The whole sentence each route sends, written out in full (/sync treats bundled extensions differently).
                const refusals = {
                    '/install': `${extensionName} comes with Neconyan, so it cannot be installed from the extension updater.`,
                    '/update': `${extensionName} comes with Neconyan, so it cannot be updated from the extension updater.`,
                    '/branches': `${extensionName} comes with Neconyan, so it cannot be managed from the extension updater.`,
                    '/switch': `${extensionName} comes with Neconyan, so it cannot be switched from the extension updater.`,
                    '/move': `${extensionName} comes with Neconyan, so it cannot be moved from the extension updater.`,
                    '/delete': `${extensionName} comes with Neconyan, so it cannot be deleted from the extension updater.`,
                };
                if (route !== '/sync' && result.body !== refusals[route]) {
                    refusalMismatches.push({ extensionName, route, body: result.body });
                }
            }
        }
        expect(refusalMismatches).toEqual([]);
        expect(clone).not.toHaveBeenCalled();
        const moved = await request('post', '/move', { extensionName: 'CustomTool', source: 'local', destination: 'global' });
        expect(moved.status).toBe(204);
        expect(fs.readFileSync(path.join(global, 'CustomTool/user.txt'), 'utf8')).toBe('Custom settings');
        expect(fs.existsSync(path.join(local, 'CustomTool'))).toBe(false);
    } finally {
        Object.assign(PUBLIC_DIRECTORIES, original);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
