/* global globalThis */
import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import fs from 'node:fs';

const readSource = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

function mockNames(names, overrides = {}) {
    const factory = {};
    for (const name of names) {
        factory[name] = overrides[name] ?? jest.fn();
    }
    return () => ({ ...factory, ...overrides });
}

describe('regex debugger escaping and selector safety', () => {
    let executeRegexScriptForDebugging;

    beforeAll(async () => {
        jest.resetModules();
        const libNames = ['lodash', 'Fuse', 'DOMPurify', 'hljs', 'localforage', 'Handlebars', 'Bowser', 'DiffMatchPatch',
            'Readability', 'isProbablyReaderable', 'SVGInject', 'showdown', 'moment', 'seedrandom', 'Popper', 'droll',
            'morphdom', 'slideToggle', 'chalk', 'yaml', 'chevrotain', 'gzipSync', 'gzip', 'sha256'];
        await jest.unstable_mockModule('../public/lib.js', () => {
            const stubs = Object.fromEntries(libNames.map(name => [name, {}]));
            return { ...stubs, default: stubs };
        });

        await jest.unstable_mockModule('../public/script.js', mockNames([
            'characters', 'chat', 'eventSource', 'event_types', 'generateRaw', 'getCurrentChatId', 'getRequestHeaders',
            'is_send_press', 'messageFormatting', 'name1', 'name2', 'reloadCurrentChat', 'saveSettingsDebounced',
            'substituteParams', 'substituteParamsExtended', 'this_chid',
        ], {
            this_chid: undefined,
            characters: [],
            chat: [],
            event_types: { APP_READY: 'app_ready' },
            eventSource: { on: jest.fn() },
        }));
        await jest.unstable_mockModule('../public/scripts/extensions/regex/ai-draft.js', mockNames([
            'CURRENT_CONNECTION_ID', 'listRegexDraftProfiles', 'requestRegexDraft', 'resolveRegexDraftProfileId', 'trimRegexDraftSample', 'setupRegexAiDraft',
        ], { CURRENT_CONNECTION_ID: '__current__' }));
        await jest.unstable_mockModule('../public/scripts/extensions/regex/helpers.js', mockNames([
            'countRegexMatches', 'filterRegexScriptRows', 'setupRegexEditorHelpers',
        ]));

        const utilNames = [...readSource('../public/scripts/utils.js').matchAll(/^export (?:async function|function|const|let|class) (\w+)/gm)]
            .map(match => match[1]);
        const escapeHtml = str => String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const regexFromString = input => {
            const match = String(input ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
            return match ? new RegExp(match[1], match[2]) : new RegExp(String(input ?? ''));
        };
        const primitives = await import('../public/scripts/macro-primitives.js');
        await jest.unstable_mockModule('../public/scripts/utils.js', mockNames(utilNames, { ...primitives, escapeHtml, regexFromString }));
        await jest.unstable_mockModule('../public/scripts/extensions.js', mockNames(['extension_settings', 'getContext', 'renderExtensionTemplateAsync', 'saveMetadataDebounced', 'writeExtensionField'], { extension_settings: { regex: [] } }));
        await jest.unstable_mockModule('../public/scripts/popup.js', mockNames(['POPUP_RESULT', 'POPUP_TYPE', 'Popup', 'callGenericPopup'], { POPUP_RESULT: {}, POPUP_TYPE: {}, Popup: class {} }));
        await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join(''), translate: text => text }));
        await jest.unstable_mockModule('../public/scripts/group-chats.js', mockNames(['groups', 'saveGroupChat', 'selected_group'], { groups: [], selected_group: null }));
        await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: { addCommandObject: jest.fn() } }));
        await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: { fromProps: jest.fn() } }));
        await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: {},
            SlashCommandArgument: { fromProps: jest.fn() },
            SlashCommandNamedArgument: { fromProps: jest.fn() },
        }));
        await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({ commonEnumProviders: {}, enumIcons: {} }));
        await jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({ enumTypes: {}, SlashCommandEnumValue: class {} }));
        await jest.unstable_mockModule('../public/scripts/char-data.js', () => ({ regex_placement: {} }));
        await jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({ getPresetManager: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
        await jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', mockNames([
            'allowPresetScripts', 'allowScopedScripts', 'disallowPresetScripts', 'disallowScopedScripts',
            'getCurrentPresetAPI', 'getCurrentPresetName', 'getRegexScripts', 'getScriptsByType',
            'isPresetScriptsAllowed', 'isScopedScriptsAllowed', 'regex_placement', 'RegexProvider',
            'runRegexScript', 'saveScriptsByType', 'SCRIPT_TYPE_UNKNOWN', 'SCRIPT_TYPES', 'substitute_find_regex',
        ], { SCRIPT_TYPES: {}, regex_placement: {}, substitute_find_regex: {} }));
        await jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
        await jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ getSortableDelay: jest.fn() }));

        globalThis.jQuery = fn => {
            if (typeof fn === 'function') return;
            return { on: jest.fn(), find: jest.fn(), empty: jest.fn() };
        };
        globalThis.$ = globalThis.jQuery;

        ({ executeRegexScriptForDebugging } = await import('../public/scripts/extensions/regex/index.js'));
    });

    test('escapes highlightedOutput when findRegex fails to compile', () => {
        const rawText = '<b id="injected">formatted</b> & "quoted"';
        const result = executeRegexScriptForDebugging({ findRegex: '/[unclosed/', replaceString: 'x' }, rawText);

        expect(result.output).toBe(rawText);
        expect(result.error).toMatch(/^Compile error:/);
        expect(result.highlightedOutput).toBe('&lt;b id=&quot;injected&quot;&gt;formatted&lt;/b&gt; &amp; &quot;quoted&quot;');
        expect(result.highlightedOutput).not.toContain('<b');
    });

    test('escapes highlightedOutput when regex does not match', () => {
        const rawText = '<span id="inert">plain</span>';
        const result = executeRegexScriptForDebugging({ findRegex: '/nomatch/g', replaceString: 'x' }, rawText);

        expect(result.output).toBe(rawText);
        expect(result.error).toBeNull();
        expect(result.highlightedOutput).toBe('&lt;span id=&quot;inert&quot;&gt;plain&lt;/span&gt;');
    });

    test('debugger error banner and rule lookups avoid raw HTML and unescaped selector interpolation', () => {
        const source = readSource('../public/scripts/extensions/regex/index.js');
        expect(source).not.toContain('stepHeader.append($(`<div class=\'warning_text text_rose-500\'>${result.error}</div>`))');
        expect(source).toContain('stepHeader.append($(\'<div class="warning_text text_rose-500"></div>\').text(result.error));');
        expect(source).not.toContain('$(`#regex_debugger_rules [data-id="${scriptId}"]`)');
        expect(source).not.toContain('$(`#step-result-${scriptId}`)');
        expect(source).not.toContain('contentPanel.find(`#${targetId}`)');
    });
});
