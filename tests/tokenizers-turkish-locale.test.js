/* global globalThis */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function turkishLocaleLowerCase(text, locale) {
    if (locale === 'und') {
        return String(text).toLowerCase();
    }
    return String(text)
        .replace(/İ/g, 'i')
        .replace(/I/g, 'ı')
        .toLowerCase();
}

await jest.unstable_mockModule('../public/lib.js', () => ({
    localforage: {
        createInstance: () => ({
            getItem: jest.fn(async () => ({})),
            setItem: jest.fn(async () => undefined),
        }),
    },
}));

await jest.unstable_mockModule('../public/script.js', () => ({
    characters: [],
    event_types: {},
    eventSource: { on: jest.fn() },
    main_api: 'openai',
    nai_settings: { model_novel: '' },
    online_status: 'connected',
    this_chid: undefined,
}));

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { tokenizer: 0 },
    registerDebugFunction: jest.fn(),
}));

await jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: { OPENAI: 'openai' },
    model_list: [],
    oai_settings: { chat_completion_source: 'openai', openai_model: 'gpt-4o' },
}));

await jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: [],
    selected_group: null,
}));

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getStringHash: jest.fn(() => 1234),
}));

await jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({
    kai_flags: { can_use_tokenization: true },
    kai_settings: {},
}));

await jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: { OOBA: 'ooba', OPENROUTER: 'openrouter', DREAMGEN: 'dreamgen' },
    textgenerationwebui_settings: { type: 'ooba' },
    getTextGenServer: jest.fn(() => ''),
    getTextGenModel: jest.fn(() => ''),
}));

await jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(),
    getCurrentOpenRouterModelTokenizer: jest.fn(),
    openRouterModels: [],
}));

await jest.unstable_mockModule('../public/scripts/chat-prompt-tokens.js', () => ({
    resolveChatTokenizerModel: jest.fn(() => 'gpt-4o'),
}));

await jest.unstable_mockModule('../public/scripts/background-memory-saver.js', () => ({
    registerBackgroundMemoryHandler: jest.fn(),
}));

const {
    TEXTGEN_TOKENIZERS,
    getAvailableTokenizers,
    getFriendlyTokenizerName,
    tokenizers,
} = await import('../public/scripts/tokenizers.js');
TEXTGEN_TOKENIZERS.push('ooba');

describe('Turkish locale resilience for internal tokenizer IDs, notes stems, and utils search vs equality', () => {
    let originalToLocaleLowerCase;
    let originalSessionStorage;
    let originalJQuery;

    beforeEach(() => {
        originalToLocaleLowerCase = String.prototype.toLocaleLowerCase;
        originalSessionStorage = globalThis.sessionStorage;
        originalJQuery = globalThis.$;

        String.prototype.toLocaleLowerCase = function (locale) {
            return turkishLocaleLowerCase(this, locale);
        };
        globalThis.sessionStorage = {
            getItem: key => key === 'tokenizationSupported' ? '1' : null,
        };
    });

    afterEach(() => {
        String.prototype.toLocaleLowerCase = originalToLocaleLowerCase;
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.$ = originalJQuery;
    });

    test('client tokenizers return ASCII keys (openai, api_kobold, api_textgenerationwebui) under simulated tr-TR locale', () => {
        const options = [
            { value: String(tokenizers.OPENAI), text: 'OpenAI (tiktoken)' },
            { value: String(tokenizers.API_KOBOLD), text: 'API (KoboldAI Classic)' },
            { value: String(tokenizers.API_TEXTGENERATIONWEBUI), text: 'API (Text Completion)' },
        ];
        globalThis.$ = () => ({
            find: selector => selector === 'option'
                ? { toArray: () => options }
                : { val: () => String(tokenizers.BEST_MATCH), text: () => 'Best Match' },
            text: () => '',
        });

        expect(getAvailableTokenizers().map(item => item.tokenizerKey)).toEqual([
            'openai',
            'api_kobold',
            'api_textgenerationwebui',
        ]);
        expect(getFriendlyTokenizerName('openai').tokenizerKey).toBe('openai');
        expect(getFriendlyTokenizerName('kobold').tokenizerKey).toBe('api_kobold');
        expect(getFriendlyTokenizerName('textgenerationwebui').tokenizerKey).toBe('api_textgenerationwebui');
    });

    test('notes-dialogs linkLabel uses locale-independent "und" comparison under simulated tr-TR locale', () => {
        const notesDialogsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'notebooks', 'notes-dialogs.js'), 'utf8');
        const linkLabelSource = notesDialogsSource.match(/^function linkLabel\([\s\S]*?^}/m)?.[0];
        expect(linkLabelSource).toBeTruthy();
        expect(linkLabelSource).toContain('.toLocaleLowerCase(\'und\')');

        const context = vm.createContext({});
        vm.runInContext(`
            String.prototype.toLocaleLowerCase = function (locale) {
                if (locale === 'und') return String(this).toLowerCase();
                return String(this).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase();
            };
            ${linkLabelSource}
            globalThis.linkLabel = linkLabel;
        `, context);

        const notes = [{ path: 'folderA/API.md' }, { path: 'folderB/api.md' }];
        expect(context.linkLabel(notes[0], notes)).toBe('folderA/API');
    });

    test('utils.js search folds kır/kir and İçe/içe while rename equality keeps kır.jsonl distinct from kir.jsonl', () => {
        const utilsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'utils.js'), 'utf8');
        const extract = pattern => utilsSource.match(pattern)?.[0] ?? '';

        const compareSrc = extract(/^export function compareIgnoreCaseAndAccents\([\s\S]*?^}/m).replace(/^export /, '');
        const normSearchSrc = extract(/^function normalizeSearchIgnoreCaseAndAccents\([\s\S]*?^}/m);
        const includesSrc = extract(/^export function includesIgnoreCaseAndAccents\([\s\S]*?^}/m).replace(/^export /, '');
        const equalsSrc = extract(/^export function equalsIgnoreCaseAndAccents\([\s\S]*?^}/m).replace(/^export /, '');

        expect(compareSrc).toBeTruthy();
        expect(normSearchSrc).toBeTruthy();
        expect(includesSrc).toBeTruthy();
        expect(equalsSrc).toBeTruthy();

        const context = vm.createContext({});
        vm.runInContext([
            compareSrc,
            normSearchSrc,
            includesSrc,
            equalsSrc,
            'globalThis.includesIgnoreCaseAndAccents = includesIgnoreCaseAndAccents;',
            'globalThis.equalsIgnoreCaseAndAccents = equalsIgnoreCaseAndAccents;',
        ].join('\n'), context);

        expect(context.includesIgnoreCaseAndAccents('kır.jsonl', 'kir')).toBe(true);
        expect(context.includesIgnoreCaseAndAccents('İçe aktar', 'içe')).toBe(true);
        expect(context.equalsIgnoreCaseAndAccents('kır.jsonl', 'kir.jsonl')).toBe(false);
    });
});
