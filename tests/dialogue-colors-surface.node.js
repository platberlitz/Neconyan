/* global globalThis */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Dialogue Colors reaches the host only through st-api.js; stubbing it lets the real
// readability code run against a small fake page.
const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
export const escapeHtml = value => String(value);
export const escapeRegex = value => String(value);
export const extension_settings = {};
export const getContext = () => ({ chat: [], chatMetadata: {} });
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async () => '';
export const registerMacro = () => {};
export const getRequestHeaders = () => ({});
export const saveMetadata = () => {};
export const saveMetadataDebounced = () => {};
export const promptManager = null;
`;

const PAGE = 'rgb(22, 23, 22)';
const CHAT = 'rgb(49, 49, 44)';

function element(backgroundColor, parentElement = null) {
    return { backgroundColor, parentElement };
}

const page = { body: element(PAGE), message: null, characterMessage: null };
// The hidden message template is always in the page; it is not a chat message.
page.template = element('rgba(0, 0, 0, 0)', page.body);

globalThis.document = {
    get body() { return page.body; },
    querySelector(selector) {
        if (selector === '#chat .mes:not([is_user="true"]):not([is_system="true"]) .mes_text') return page.characterMessage;
        if (selector === '#chat .mes_text') return page.message;
        if (selector === '#chat .mes_text, .mes_text') return page.message ?? page.template;
        return null;
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
};
globalThis.getComputedStyle = target => ({ backgroundColor: target.backgroundColor });
globalThis.window ??= { innerWidth: 1024, innerHeight: 768, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const stored = new Map();
let storageFails = false;
globalThis.localStorage = {
    getItem(key) {
        if (storageFails) throw new Error('Storage unavailable');
        return stored.get(key) ?? null;
    },
    setItem(key, value) {
        if (storageFails) throw new Error('Storage unavailable');
        stored.set(key, String(value));
    },
};

const EXTENSION = '../public/scripts/extensions/third-party/sillytavern-character-colors/src';
const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
const { getContrastSurfaceColor, hasMessageSurface, invalidateThemeCache } = await import(`${EXTENSION}/palettes.js`);
const { settings } = await import(`${EXTENSION}/state.js`);
hooks.deregister();

function measure() {
    invalidateThemeCache();
    return getContrastSurfaceColor();
}

test.beforeEach(() => {
    settings.themeMode = 'auto';
    stored.clear();
    storageFails = false;
    page.body = element(PAGE);
    page.template.parentElement = page.body;
    page.message = null;
    page.characterMessage = null;
});

test('only a message in the chat counts as a surface to measure', () => {
    assert.equal(hasMessageSurface(), false);
    assert.equal(measure(), '#161716');
    assert.equal(stored.size, 0);

    page.message = element(CHAT, page.body);
    assert.equal(hasMessageSurface(), true);
    assert.equal(measure(), '#31312c');
});

test('the chat surface is remembered for start-ups that have no message yet', () => {
    page.message = element(CHAT, page.body);
    measure();
    page.message = null;
    assert.equal(measure(), '#31312c');

    // A remembered surface belongs to its theme; a light page measures itself again.
    page.body = element('rgb(245, 245, 245)');
    page.template.parentElement = page.body;
    assert.equal(measure(), '#f5f5f5');
});

test('unavailable storage falls back to measuring the page', () => {
    storageFails = true;
    page.message = element(CHAT, page.body);
    assert.equal(measure(), '#31312c');
    page.message = null;
    assert.equal(measure(), '#161716');
});

test('a character message sets the surface even when a user message is drawn first', () => {
    const USER_BUBBLE = 'rgb(34, 36, 43)';
    const CHARACTER_BUBBLE = 'rgb(27, 29, 36)';
    const characterMessage = element(CHARACTER_BUBBLE, page.body);
    page.characterMessage = characterMessage;

    // A truncated chat that alternates speakers starts with a different speaker after each
    // new message. The surface must not follow it, or every message is recoloured and saved.
    page.message = element(USER_BUBBLE, page.body);
    assert.equal(measure(), '#1b1d24');
    page.message = characterMessage;
    assert.equal(measure(), '#1b1d24');

    // A chat with only user messages still has a surface to measure.
    page.characterMessage = null;
    page.message = element(USER_BUBBLE, page.body);
    assert.equal(measure(), '#22242b');
});
