import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDirs = [];

function createPluginsDirectory() {
    const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-plugin-loader-'));
    tempDirs.push(pluginsPath);
    return pluginsPath;
}

async function importPluginLoader(config, { commandExists = false, gitFactory = null, nativeFailure = false } = {}) {
    jest.resetModules();

    const effectiveConfig = {
        enableServerPluginsAutoUpdate: false,
        ...config,
    };

    await jest.unstable_mockModule('../src/util.js', () => ({
        color: {
            blue: value => value,
            cyan: value => value,
            green: value => value,
            red: value => value,
            yellow: value => value,
        },
        getConfig: jest.fn(() => effectiveConfig),
        getConfigValue: jest.fn((key, defaultValue) => Object.prototype.hasOwnProperty.call(effectiveConfig, key) ? effectiveConfig[key] : defaultValue),
    }));

    await jest.unstable_mockModule('command-exists', () => ({
        sync: jest.fn(() => commandExists),
    }));

    const defaultGitFactory = jest.fn(() => ({
        checkIsRepo: jest.fn(async () => false),
    }));
    await jest.unstable_mockModule('simple-git', () => ({
        CheckRepoActions: {
            IS_REPO_ROOT: 'IS_REPO_ROOT',
        },
        default: gitFactory || defaultGitFactory,
    }));

    const nativeModules = [
        ['Neconyan-BotSearcher', 'neconyan-botsearcher'],
        ['Neconyan-Hopper', 'hopper'],
    ];
    for (const [directory, id] of nativeModules) {
        await jest.unstable_mockModule(`../public/scripts/extensions/third-party/${directory}/server/index.js`, () => ({
            info: { id, name: id, description: 'Native loader check' },
            init: async router => {
                if (nativeFailure) throw new Error('Native startup failure');
                router.get('/probe', (_request, response) => response.sendStatus(204));
            },
        }));
    }
    return await import('../src/plugin-loader.js');
}

function createApp() {
    return { use: jest.fn() };
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();

    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('plugin loader diagnostics', () => {
    test('warns when a singular server plugin config key leaves installed plugins disabled', async () => {
        const pluginsPath = createPluginsDirectory();
        fs.mkdirSync(path.join(pluginsPath, 'similharity'));
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { loadPlugins } = await importPluginLoader({
            enableserverplugin: true,
            enableServerPlugins: false,
        });

        await loadPlugins(createApp(), pluginsPath);

        const warnings = warnSpy.mock.calls.flat().join('\n');
        expect(warnings).toContain('Config key \'enableserverplugin\' is ignored');
        expect(warnings).toContain('Did you mean \'enableServerPlugins\'');
        expect(warnings).toContain('Server plugins are installed');
        expect(warnings).toContain('enableServerPlugins: true');
    });

    test('prints an install hint when a plugin package dependency is missing', async () => {
        const pluginsPath = createPluginsDirectory();
        const pluginPath = path.join(pluginsPath, 'similharity');
        fs.mkdirSync(pluginPath);
        fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({
            type: 'module',
            main: 'index.mjs',
        }));
        fs.writeFileSync(path.join(pluginPath, 'index.mjs'), 'import \'@lancedb/lancedb\';\n');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { loadPlugins } = await importPluginLoader({
            enableServerPlugins: true,
        });

        await loadPlugins(createApp(), pluginsPath);

        const errors = errorSpy.mock.calls.flat().join('\n');
        expect(errors).toContain('Server plugin dependency \'@lancedb/lancedb\' was not found');
        expect(errors).toContain(`cd "${pluginPath}" && npm install`);
        expect(errors).toContain('bun install');
        expect(errors).toContain('node_modules is busy');
    });

    test('does not print dependency install hints for missing Windows absolute paths', async () => {
        const pluginsPath = createPluginsDirectory();
        const pluginPath = path.join(pluginsPath, 'local-plugin');
        fs.mkdirSync(pluginPath);
        fs.writeFileSync(path.join(pluginPath, 'package.json'), JSON.stringify({
            type: 'module',
            main: 'index.mjs',
        }));
        fs.writeFileSync(path.join(pluginPath, 'index.mjs'), 'import \'C:/missing/local-module.js\';\n');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { loadPlugins } = await importPluginLoader({
            enableServerPlugins: true,
        });

        await loadPlugins(createApp(), pluginsPath);

        const errors = errorSpy.mock.calls.flat().join('\n');
        expect(errors).not.toContain('Server plugin dependency');
        expect(errors).not.toContain('npm install');
        expect(errors).not.toContain('bun install');
    });

    test('does not load hidden staging directories or mutate release-pinned plugins', async () => {
        const pluginsPath = createPluginsDirectory();
        const pluginPath = path.join(pluginsPath, 'pinned-plugin');
        const hiddenPath = path.join(pluginsPath, '.server-plugin-updates');
        fs.mkdirSync(pluginPath);
        fs.mkdirSync(hiddenPath);
        fs.writeFileSync(path.join(pluginPath, '.sillybunny-release.json'), '{}');
        fs.writeFileSync(path.join(hiddenPath, 'index.mjs'), 'throw new Error("hidden staging code loaded");\n');
        const gitFactory = jest.fn();
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const { loadPlugins } = await importPluginLoader({
            enableServerPlugins: true,
            enableServerPluginsAutoUpdate: true,
        }, {
            commandExists: true,
            gitFactory,
        });

        await loadPlugins(createApp(), pluginsPath);

        expect(gitFactory).not.toHaveBeenCalled();
        expect(logSpy.mock.calls.flat().join('\n')).toContain('Skipping mutable auto-update for release-pinned plugin pinned-plugin');
    });

    test('continues to load dot-prefixed plugins that are not updater storage', async () => {
        const pluginsPath = createPluginsDirectory();
        const pluginPath = path.join(pluginsPath, '.custom-plugin');
        fs.mkdirSync(pluginPath);
        fs.writeFileSync(path.join(pluginPath, 'index.mjs'), [
            'export const info = { id: "hidden_plugin", name: "Hidden", description: "Test" };',
            'export function init() {}',
        ].join('\n'));
        const app = createApp();
        const { getLoadedServerPluginIds, getLoadedServerPlugins, loadPlugins } = await importPluginLoader({ enableServerPlugins: true });

        await loadPlugins(app, pluginsPath);

        expect(getLoadedServerPluginIds()).toContain('hidden_plugin');
        expect(getLoadedServerPlugins()).toContainEqual({
            id: 'hidden_plugin',
            directoryPath: fs.realpathSync(pluginPath),
        });
    });
});


describe('Neconyan native server ownership', () => {
    test('loads native routes with optional plugins disabled', async () => {
        const pluginsPath = createPluginsDirectory();
        const app = createApp();
        const { loadPlugins, getLoadedServerPluginIds } = await importPluginLoader({ enableServerPlugins: false });
        await loadPlugins(app, pluginsPath);
        expect(getLoadedServerPluginIds()).toEqual(['neconyan-botsearcher', 'hopper']);
        expect(app.use.mock.calls.map(([route]) => route)).toEqual([
            '/api/plugins/neconyan-botsearcher', '/api/plugins/sillybunny-botsearcher', '/api/plugins/hopper',
        ]);
    });

    test('reserves native IDs even after startup failure and skips old copies before update or import', async () => {
        const pluginsPath = createPluginsDirectory();
        const marker = path.join(pluginsPath, 'duplicate-ran');
        const poison = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'imported');`;
        for (const name of ['Neconyan-Hopper', 'Neconyan-BotSearcher', 'hopper', 'sillybunny-botsearcher']) {
            fs.mkdirSync(path.join(pluginsPath, name));
            fs.writeFileSync(path.join(pluginsPath, name, 'index.mjs'), poison);
        }
        fs.writeFileSync(path.join(pluginsPath, 'HOPPER.mjs'), poison);
        fs.writeFileSync(path.join(pluginsPath, 'renamed.mjs'), [
            "import fs from 'node:fs';",
            'export const info = { id: "hopper", name: "Old Meower", description: "Duplicate check" };',
            `export function init() { fs.writeFileSync(${JSON.stringify(marker)}, 'initialized'); }`,
        ].join('\n'));
        fs.writeFileSync(path.join(pluginsPath, 'custom.mjs'), [
            'export const info = { id: "custom", name: "Custom", description: "Unrelated plugin" };',
            'export function init() {}',
        ].join('\n'));
        const gitFactory = jest.fn();
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { loadPlugins, getLoadedServerPluginIds } = await importPluginLoader({
            enableServerPlugins: true, enableServerPluginsAutoUpdate: true,
        }, { nativeFailure: true, commandExists: true, gitFactory });
        await loadPlugins(createApp(), pluginsPath);
        expect(gitFactory).not.toHaveBeenCalled();
        expect(fs.existsSync(marker)).toBe(false);
        expect(getLoadedServerPluginIds()).toEqual(['custom']);
    });
});
