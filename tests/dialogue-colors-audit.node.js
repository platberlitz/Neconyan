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
export const getContext = () => globalThis.__dcAuditContext ?? { chat: [], chatMetadata: {} };
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async options => globalThis.__dcAuditQuiet?.(options) ?? '';
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

const EXTENSION = '../public/scripts/extensions/third-party/sillytavern-character-colors/src';
const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const { isMessageEligibleForAttributionVerification } = await import(`${EXTENSION}/verify.js`);
const { callLLMWithProfile, classifyLlmRequestError } = await import(`${EXTENSION}/llm.js`);
const { replaceMessageSelectionWithFontTag } = await import(`${EXTENSION}/context-menu.js`);
hooks.deregister();

test('the welcome greeting is not sent for attribution verification', () => {
    assert.equal(isMessageEligibleForAttributionVerification({
        name: 'Assistant',
        is_user: false,
        is_system: false,
        mes: '"Hello there," she said.',
        extra: { type: 'assistant_message' },
    }), false);
});

test('a swipe that is still generating is not verified against the old text', () => {
    assert.equal(isMessageEligibleForAttributionVerification({
        name: 'Alice',
        is_user: false,
        mes: '"Old swipe," Alice said.',
        swipes: ['"Old swipe," Alice said.'],
        swipe_id: 1,
    }), false);
    assert.equal(isMessageEligibleForAttributionVerification({
        name: 'Alice',
        is_user: false,
        mes: '"Finished swipe," Alice said.',
        swipes: ['"Old swipe," Alice said.', '"Finished swipe," Alice said.'],
        swipe_id: 1,
    }), true);
});

test('the user\'s own messages are not sent for attribution verification', () => {
    assert.equal(isMessageEligibleForAttributionVerification({
        name: 'You',
        is_user: true,
        mes: '"Wait," I said.',
    }), false);
});

test('main-AI requests hand the cancel signal to the host', async () => {
    let rawSignal = null;
    let quietSignal = null;
    globalThis.__dcAuditQuiet = options => { quietSignal = options.signal; return 'quiet result'; };
    try {
        globalThis.__dcAuditContext = { generateRaw: async options => { rawSignal = options.signal; return 'raw result'; } };
        assert.equal(await callLLMWithProfile('data', { timeoutMs: 500 }), 'raw result');
        assert.ok(rawSignal instanceof AbortSignal, 'generateRaw receives a signal');

        globalThis.__dcAuditContext = {};
        assert.equal(await callLLMWithProfile('data', { timeoutMs: 500 }), 'quiet result');
        assert.ok(quietSignal instanceof AbortSignal, 'generateQuietPrompt receives a signal');
    } finally {
        delete globalThis.__dcAuditQuiet;
        delete globalThis.__dcAuditContext;
    }
});

test('host stop messages count as cancellations, not provider failures', () => {
    for (const message of ['Cancelled by stop event', 'Cancelled by extension', 'Cancelled by external signal']) {
        assert.equal(classifyLlmRequestError(new Error(message)).category, 'cancelled', message);
    }
    assert.notEqual(classifyLlmRequestError(new Error('Request failed')).category, 'cancelled');
});

test('assigning a colour keeps quotes and apostrophes as typed', () => {
    const selectedText = '"Hello," she said. It\'s late.';
    const msg = { mes: selectedText };

    assert.equal(replaceMessageSelectionWithFontTag(msg, selectedText, '#12ABef', {
        sourceStart: 0,
        sourceEnd: selectedText.length,
    }), true);
    assert.equal(msg.mes, `<font color="#12abef">${selectedText}</font>`);
});
