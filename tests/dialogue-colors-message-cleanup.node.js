/* global globalThis */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Dialogue Colors reaches the host only through st-api.js, which imports paths that resolve
// inside a running app. Stubbing that one module lets the real extension code run here.
const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
export const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export const escapeRegex = value => String(value).replace(/[/\\-\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
export const extension_settings = {};
export const getContext = () => globalThis.__dcCleanupContext ?? { chat: [], chatMetadata: {} };
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async options => globalThis.__dcCleanupQuiet?.(options) ?? '';
export const registerMacro = () => {};
export const getRequestHeaders = () => ({});
export const saveMetadata = () => {};
export const saveMetadataDebounced = () => {};
export const promptManager = null;
`;

function createStubElement() {
    return {
        id: '',
        innerHTML: '',
        style: { cssText: '', display: 'none' },
        classList: { add() {}, remove() {}, contains: () => false },
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
        contains: () => false,
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    };
}

globalThis.document ??= {
    body: createStubElement(),
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: createStubElement,
    addEventListener() {},
};
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });
globalThis.window ??= { innerWidth: 1024, innerHeight: 768, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.fetch ??= async () => ({ ok: true, status: 200, json: async () => ({}) });
globalThis.toastr ??= { info() {}, success() {}, warning() {}, error() {} };

const EXTENSION = '../public/scripts/extensions/third-party/sillytavern-character-colors/src';
const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const { stripAllColorMetadataLines } = await import(`${EXTENSION}/color-blocks.js`);
const {
    applyChatColorMarkupCleanup,
    cleanChatColorMarkup,
    cleanColorMarkupText,
    restoreChatColorMarkup,
    stripColorFontTags,
} = await import(`${EXTENSION}/message-cleanup.js`);
hooks.deregister();

const COLORED = '<font color="#22aa66">"Hello."</font> Mira waves.';
const LINE = '[COLORS:Mira=#22aa66]';

test('every standalone colour line goes, but lines inside code and inline mentions stay', () => {
    assert.equal(stripAllColorMetadataLines(`${COLORED}\n${LINE}`), COLORED);
    assert.equal(stripAllColorMetadataLines(`${LINE}\nIntro.\n[COLOR:Mira=#22aa66]\nMore.\n${LINE}`), 'Intro.\nMore.');
    const code = 'Example:\n```\n[COLORS:Mira=#22aa66]\n```';
    assert.equal(stripAllColorMetadataLines(code), code);
    const inline = 'She wrote [COLORS:Mira=#22aa66] on the wall.';
    assert.equal(stripAllColorMetadataLines(inline), inline);
    assert.equal(stripAllColorMetadataLines('Nothing here.'), 'Nothing here.');
});

test('colour tags are removed only when asked, and other font tags stay', () => {
    assert.equal(cleanColorMarkupText(`${COLORED}\n${LINE}`), COLORED);
    assert.equal(cleanColorMarkupText(`${COLORED}\n${LINE}`, { fontTags: true }), '"Hello." Mira waves.');
    assert.equal(stripColorFontTags('<font face="serif"><font color=#a2c>"Hi"</font> there</font>'), '<font face="serif">"Hi" there</font>');
    assert.equal(stripColorFontTags('<FONT COLOR=\'#AABBCC\'>"Hi"</FONT>'), '"Hi"');
});

test('character messages and every swipe are cleaned, user and tool messages are not', () => {
    const userText = `I typed ${LINE} myself\n${LINE}`;
    const chat = [
        { is_user: true, mes: userText },
        { is_user: false, mes: `${COLORED}\n${LINE}`, swipe_id: 0, swipes: [`${COLORED}\n${LINE}`, `"Bye."\n${LINE}`, 'Plain.'] },
        { is_user: false, mes: `Tool output\n${LINE}`, extra: { tool_invocations: [] } },
        { is_user: false, mes: 'Already clean.' },
    ];
    const report = cleanChatColorMarkup(chat);
    assert.equal(report.messageCount, 1);
    assert.equal(report.swipeCount, 2);
    assert.equal(chat[0].mes, userText);
    assert.equal(chat[1].mes, COLORED);
    assert.deepEqual(chat[1].swipes, [COLORED, '"Bye."', 'Plain.']);
    assert.equal(chat[2].mes, `Tool output\n${LINE}`);

    assert.deepEqual(restoreChatColorMarkup(chat, report.changes), [1]);
    assert.equal(chat[1].mes, `${COLORED}\n${LINE}`);
    assert.deepEqual(chat[1].swipes, [`${COLORED}\n${LINE}`, `"Bye."\n${LINE}`, 'Plain.']);
});

test('the cleanup action edits the open chat and its undo puts the text back', async () => {
    const original = `${COLORED}\n${LINE}`;
    const chat = [{ is_user: false, mes: original, swipes: [original] }];
    globalThis.__dcCleanupContext = { chat, chatMetadata: {}, chatId: 'c1', characterId: 0, characters: [{ avatar: 'mira.png' }] };

    const report = await applyChatColorMarkupCleanup({ fontTags: true, silent: true });
    assert.equal(report.messageCount, 1);
    assert.equal(chat[0].mes, '"Hello." Mira waves.');
    assert.equal(await report.undo(), true);
    assert.equal(chat[0].mes, original);
    assert.deepEqual(chat[0].swipes, [original]);

    chat[0].mes = 'Plain.';
    chat[0].swipes = ['Plain.'];
    const empty = await applyChatColorMarkupCleanup({ silent: true });
    assert.equal(empty.messageCount, 0);
    assert.equal(empty.undo, null);
});
