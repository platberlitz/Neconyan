/**
 * Release-owned extension catalog.
 *
 * These entries are deliberately data, rather than a second discovery path:
 * the extension API, server-plugin loader, and import reporting all use the
 * same IDs. `license` is null where the source does not ship a standalone
 * license or declare one in its manifest.
 */
export const NECONYAN_NATIVE_EXTENSIONS = Object.freeze([
    {
        directory: 'Neconyan-Preset-Tools',
        displayName: 'Preset Tools',
        version: '1.5.4',
        entry: 'content.js',
        style: 'styles.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny.git',
        pinnedRevision: '5a6d0733fddbfde6dc55b9e81d804d824b7a61ba',
        license: null,
        licenseFiles: [],
        legacyIds: ['BunnyPresetTools'],
    },
    {
        directory: 'ChatCompletionTabs',
        displayName: 'Chat Completion Tabs',
        version: '1.0.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/RivelleDays/SillyTavern-ChatCompletionTabs',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny.git',
        pinnedRevision: '5a6d0733fddbfde6dc55b9e81d804d824b7a61ba',
        license: null,
        licenseFiles: [],
        legacyIds: ['SillyTavern-ChatCompletionTabs'],
    },
    {
        directory: 'sillytavern-character-colors',
        displayName: 'Dialogue Colors',
        version: '6.1.3',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/sillytavern-character-colors',
        sourceOrigin: 'https://github.com/platberlitz/sillytavern-character-colors.git',
        pinnedRevision: '5af565658bc223a74e99d025670db6835dd83682',
        license: null,
        licenseFiles: [],
        generateInterceptor: 'DialogueColorsInterceptor',
    },
    {
        directory: 'Neconyan-Terminal-UI',
        displayName: 'Termeownal UI',
        version: '2.4.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Terminal-UI',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-Terminal-UI.git',
        pinnedRevision: '16d1540c6b88d97a9519725d89b04e1f7164bd1a',
        license: 'AGPL-3.0',
        licenseFiles: [],
        legacyIds: ['SillyBunny-Terminal-UI'],
    },
    {
        directory: 'Neconyan-BotSearcher',
        displayName: 'BotSearcher',
        version: '0.9.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher.git',
        pinnedRevision: '2e175ff439f884fc0bb662ff9930212237053780',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        serverId: 'neconyan-botsearcher',
        legacyIds: ['SillyBunny-BotSearcher', 'sillybunny-botsearcher'],
        legacyServerIds: ['sillybunny-botsearcher'],
        serverEntry: 'server/index.js',
    },
    {
        directory: 'Neconyan-PromptTags',
        displayName: 'Prompt Tags',
        version: '1.0.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: null,
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-PromptTags.git',
        pinnedRevision: '20a0ef20c4ed9d2c81a5e4a893501462a6f39183',
        license: 'MIT',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-PromptTags'],
    },
    {
        directory: 'Neconyan-Regex-Agent-Themes',
        displayName: 'Regex Agent Themes',
        version: '1.0.1',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Regex-Agent-Themes',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-Regex-Agent-Themes.git',
        pinnedRevision: '3c8e708f8c86e77a92f23526c738e87c82df98c9',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-Regex-Agent-Themes'],
    },
    {
        directory: 'MacroEnhanced',
        displayName: 'Macro Enhanced',
        version: '0.3.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: null,
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-MacroEnhanced.git',
        pinnedRevision: '1b56c631a1d3f5f2c3548f0189f7f72a299c4f68',
        license: null,
        licenseFiles: [],
        legacyIds: ['SillyBunny-MacroEnhanced', 'Neconyan-MacroEnhanced'],
    },
    {
        directory: 'Neconyan-WorldInfo-Lab',
        displayName: 'World Info Lab',
        version: '0.3.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-WorldInfo-Lab.git',
        pinnedRevision: 'dd71ab5fdc5aabb56ad88e0a836c52f7f9a5c3eb',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-WorldInfo-Lab'],
    },
    {
        directory: 'Neconyan-Prompting-Lab',
        displayName: 'Prompting Lab',
        version: '0.3.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Prompting-Lab',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-Prompting-Lab.git',
        pinnedRevision: 'a27547601af7fe2b07f77af6ddea72c89062f47f',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-Prompting-Lab'],
    },
    {
        directory: 'Neconyan-Debugger',
        displayName: 'Debugger',
        version: '0.1.1',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: null,
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-Debugger.git',
        pinnedRevision: 'e85bc651d2ef5e061943e8292884a0f6c12509ae',
        license: null,
        licenseFiles: [],
        runtimeDirectory: 'neconyan-debugger',
        runtimeId: 'neconyan-debugger',
        legacyIds: ['SillyBunny-Debugger', 'sillybunny-debugger', 'Neconyan-Debugger'],
    },
    {
        directory: 'Neconyan-Chats-Archive',
        displayName: 'Chat Archive',
        version: '0.4.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/SillyBunny-Chats-Archive',
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-Chats-Archive.git',
        pinnedRevision: 'a1d0fa757f64ff9cebeda63c6539ae7c6c89e27d',
        license: 'AGPL-3.0',
        licenseFiles: [],
        runtimeDirectory: 'neconyan-chats-archive',
        runtimeId: 'neconyan-chats-archive',
        legacyIds: ['SillyBunny-Chats-Archive', 'sillybunny-chats-archive', 'Neconyan-Chats-Archive'],
    },
    {
        directory: 'Neconyan-Lorebook-Distiller',
        displayName: 'Lorebook Distiller',
        version: '0.1.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/SillyBunny-Lorebook-Distiller',
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-Lorebook-Distiller.git',
        pinnedRevision: '237ea54d6f94e731d4b918f9c445e1b78fa2dcf6',
        license: 'AGPL-3.0',
        licenseFiles: [],
        legacyIds: ['SillyBunny-Lorebook-Distiller'],
    },
    {
        directory: 'Neconyan-Time-Machine',
        displayName: 'Card & Lorebook Time Machine',
        version: '0.2.2',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/SillyBunny-Time-Machine',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-Time-Machine.git',
        pinnedRevision: 'b9ec088a76480f014fc01e5cc9f78d36d897fc86',
        license: 'AGPL-3.0',
        licenseFiles: [],
        legacyIds: ['SillyBunny-Time-Machine'],
    },
    {
        directory: 'Neconyan-Deep-Swipe',
        displayName: 'Deep Swipe',
        version: '1.5.5-sb1',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe',
        sourceOrigin: 'https://github.com/SillyBunnyTeam/SillyBunny-Deep-Swipe.git',
        pinnedRevision: '16d4bd5b9a9f1c7e128166e3338f3f248c258b78',
        license: null,
        licenseFiles: [],
        legacyIds: ['SillyBunny-Deep-Swipe'],
    },
    {
        directory: 'Neconyan-Story-Mode',
        displayName: 'Story Mode',
        version: '0.2.4',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/SillyBunny-Story-Mode',
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-Story-Mode.git',
        pinnedRevision: '0a61c14ba0673f80e042c68dfb9b2dadf3d8ced9',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-Story-Mode'],
    },
    {
        directory: 'Neconyan-Hopper',
        displayName: 'Meower',
        version: '0.4.0',
        entry: 'index.js',
        style: 'style.css',
        sourceUrl: 'https://github.com/platberlitz/SillyBunny-Hopper',
        sourceOrigin: 'https://github.com/platberlitz/SillyBunny-Hopper.git',
        pinnedRevision: 'e7374c14a8cb1c87712c93f65666058fd4efa076',
        license: 'AGPL-3.0',
        licenseFiles: ['LICENSE'],
        legacyIds: ['SillyBunny-Hopper'],
        serverId: 'hopper',
        serverEntry: 'server/index.js',
    },
]);

function normalizeNativeId(name) {
    return String(name ?? '')
        .trim()
        .replace(/^third-party[\\/]/i, '')
        .toLowerCase();
}

const nativeById = new Map(NECONYAN_NATIVE_EXTENSIONS.flatMap(extension => [
    [normalizeNativeId(extension.directory), extension],
    [normalizeNativeId(extension.runtimeId ?? extension.directory), extension],
    ...(extension.legacyIds ?? []).map(id => [normalizeNativeId(id), extension]),
]));

export function getNativeExtension(name) {
    return nativeById.get(normalizeNativeId(name)) ?? null;
}

export function isNativeExtension(name) {
    return Boolean(getNativeExtension(name));
}

export function getNativeExtensionIds() {
    return NECONYAN_NATIVE_EXTENSIONS.map(extension => extension.runtimeId ?? `third-party/${extension.directory}`);
}

export function getNativeExtensionAliases(name) {
    return getNativeExtension(name)?.legacyIds ?? [];
}

export function getNativeServerExtensions() {
    return NECONYAN_NATIVE_EXTENSIONS.filter(extension => extension.serverEntry);
}

export function getNativeServerExtensionAliases(name) {
    const extension = NECONYAN_NATIVE_EXTENSIONS.find(candidate => candidate.serverId === name || candidate.legacyServerIds?.includes(name));
    return extension?.legacyServerIds ?? [];
}
