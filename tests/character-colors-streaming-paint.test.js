/* global globalThis */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const counters = { attributions: 0 };
let observers = [];
let context;
let chatRoot;
let mesElement;
let mesText;

function createMesText() {
    return {
        isConnected: true,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

function createMesElement(index = 0) {
    const text = createMesText();
    return {
        isConnected: true,
        text,
        getAttribute: attribute => (attribute === 'mesid' ? String(index) : null),
        querySelector: selector => (selector === '.mes_text' ? text : null),
    };
}

class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.connected = false;
        this.target = null;
        observers.push(this);
    }

    observe(target) {
        this.connected = true;
        this.target = target;
    }

    disconnect() {
        this.connected = false;
    }

    fire() {
        if (!this.connected) return;
        this.callback([], this);
    }
}

beforeAll(async () => {
    globalThis.MutationObserver = FakeMutationObserver;
    globalThis.document = {
        getElementById: id => (id === 'chat' ? chatRoot : null),
        querySelector: () => mesElement,
        querySelectorAll: () => [],
    };

    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/attribution.js', () => ({
        attributeDialogueSegments: () => {
            counters.attributions++;
            return { segments: [], createdCharacters: false };
        },
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/attribution-store.js', () => ({
        isHostSystemOrToolMessage: () => false,
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/fonts.js', () => ({
        applyCustomFontsToFontTags: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/color-blocks.js', () => ({
        collectFontColorsFromText: () => new Set(),
        pruneReducibleCompositeEntries: value => value,
        stripTrailingColorMetadata: value => value,
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/dom-engine.js', () => ({
        applySegmentDecoration: jest.fn(),
        clearSegmentDecoration: jest.fn(),
        decorateNarratorTextNodes: jest.fn(),
        getMessageQuoteOverrideOptions: () => ({ overrides: {} }),
        matchSegmentsToElements: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/narrator-style.js', () => ({
        getNarratorVisual: () => null,
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/palettes.js', () => ({
        applyThemeReadabilityAndBrightness: value => value,
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/live-colors.js', () => ({
        queueColorStateSave: jest.fn(),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/third-party/sillytavern-character-colors/src/st-api.js', () => ({
        converter: { makeHtml: value => String(value) },
        power_user: { quote_text_color: '#888888', encode_tags: false, personas: {} },
        escapeHtml: value => String(value),
        escapeRegex: value => String(value),
        extension_settings: {},
        getContext: () => context,
        eventSource: { on() {}, emit() {} },
        event_types: {},
        setExtensionPrompt() {},
        saveSettings: async () => true,
        saveSettingsDebounced() {},
        saveCharacterDebounced() {},
        getCharacters: () => [],
        extension_prompt_types: {},
        extension_prompt_roles: {},
        generateQuietPrompt: async () => '',
        registerMacro() {},
        getRequestHeaders: () => ({}),
        saveMetadata() {},
        saveMetadataDebounced() {},
        promptManager: null,
    }));

    await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/streaming-paint.js');
    const state = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js');
    state.settings.enabled = true;
    state.settings.coloringEngine = 'dom';
    state.settings.thoughtSymbols = '*';
});

beforeEach(async () => {
    counters.attributions = 0;
    observers = [];
    mesElement = createMesElement();
    mesText = mesElement.text;
    chatRoot = {
        contains: target => target === mesElement,
        querySelector: () => mesElement,
    };
    context = {
        chat: [{ id: 'msg-1', send_date: '1', swipe_id: 0, name: 'Alice', is_user: false, mes: '"Hello' }],
        chatId: 'chat-1',
        groupId: '',
        characterId: 'alice',
    };
    const state = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js');
    state.settings.enabled = true;
    state.settings.coloringEngine = 'dom';
    state.resetStreamingSession();
});

async function streaming() {
    return import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/streaming-paint.js');
}

function connectedObservers() {
    return observers.filter(observer => observer.connected);
}

describe('Dialogue Colors streaming paint', () => {
    test('ten token events plus ten visible writes paint once per write, not once per event and write', async () => {
        const { beginStreamingPaint } = await streaming();

        expect(beginStreamingPaint()).toBe(true);
        expect(counters.attributions).toBe(1);
        expect(observers).toHaveLength(1);
        expect(connectedObservers()).toHaveLength(1);

        for (let token = 0; token < 9; token++) expect(beginStreamingPaint()).toBe(false);
        expect(counters.attributions).toBe(1);
        expect(observers).toHaveLength(1);

        for (let token = 0; token < 10; token++) {
            context.chat[0].mes += ` word${token}`;
            observers[0].fire();
        }
        expect(counters.attributions).toBe(11);

        for (let token = 0; token < 5; token++) beginStreamingPaint();
        expect(counters.attributions).toBe(11);
    });

    test('ending a stream disconnects its observer and a new stream paints immediately', async () => {
        const { beginStreamingPaint, endStreamingPaint } = await streaming();

        beginStreamingPaint();
        const first = observers[0];
        first.fire();
        expect(counters.attributions).toBe(2);

        endStreamingPaint();
        expect(first.connected).toBe(false);
        expect(connectedObservers()).toHaveLength(0);
        first.fire();
        expect(counters.attributions).toBe(2);

        expect(beginStreamingPaint()).toBe(true);
        expect(counters.attributions).toBe(3);
        expect(observers).toHaveLength(2);
        expect(connectedObservers()).toHaveLength(1);
    });

    test('a host that replaces .mes_text is detected on the next token, without a repaint storm', async () => {
        const { beginStreamingPaint } = await streaming();

        beginStreamingPaint();
        const first = observers[0];
        expect(first.target).toBe(mesText);

        const replacement = createMesElement();
        mesElement.isConnected = false;
        mesText.isConnected = false;
        mesElement = replacement;
        mesText = replacement.text;
        context.chat[0].mes = '"Hello again"';

        expect(beginStreamingPaint()).toBe(true);
        expect(counters.attributions).toBe(2);
        expect(observers).toHaveLength(1);
        expect(connectedObservers()).toHaveLength(1);
        expect(first.target).toBe(mesText);
    });

    test('a replaced message object ends the stale session and the next token starts a fresh one', async () => {
        const { beginStreamingPaint } = await streaming();

        beginStreamingPaint();
        const first = observers[0];

        context.chat = [{ id: 'msg-2', send_date: '2', swipe_id: 0, name: 'Alice', is_user: false, mes: 'Second swipe' }];
        mesElement = createMesElement();
        mesText = mesElement.text;
        chatRoot = {
            contains: target => target === mesElement,
            querySelector: () => mesElement,
        };

        expect(beginStreamingPaint()).toBe(false);
        expect(first.connected).toBe(false);

        expect(beginStreamingPaint()).toBe(true);
        expect(counters.attributions).toBe(2);
        expect(observers).toHaveLength(2);
        expect(connectedObservers()).toHaveLength(1);
    });

    test('disabling the extension stops the session and creates no observer', async () => {
        const { beginStreamingPaint, endStreamingPaint } = await streaming();
        const state = await import('../public/scripts/extensions/third-party/sillytavern-character-colors/src/state.js');

        beginStreamingPaint();
        const first = observers[0];
        state.settings.enabled = false;
        endStreamingPaint();

        expect(first.connected).toBe(false);
        expect(beginStreamingPaint()).toBe(false);
        expect(observers).toHaveLength(1);
        expect(connectedObservers()).toHaveLength(0);
    });
});
