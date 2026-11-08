/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (index < values.length ? String(values[index]) : ''), ''),
}));

const { initialiseStructuredPrefillUI } = await import('../public/scripts/structured-prefill-ui.js');
const { structuredPrefillSettings, structuredPrefillStatus, STRUCTURED_PREFILL_DEFAULTS } = await import('../public/scripts/structured-prefill.js');

const powerUserSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const blockStart = powerUserSource.indexOf('let structuredPrefillUiLoading');
const blockEnd = powerUserSource.indexOf('//MARK: loadPowerUser', blockStart);
const lazyBlock = powerUserSource.slice(blockStart, blockEnd);

class FakeOption {
    constructor(text, value) {
        this.text = text;
        this.value = value;
    }
}

class FakeElement {
    constructor({ tagName = 'div', type = '', dataset = {} } = {}) {
        this.tagName = tagName;
        this.type = type;
        this.dataset = { ...dataset };
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.children = [];
        this.selectors = new Map();
        this.all = new Map();
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = children;
    }

    querySelector(selector) {
        return this.selectors.get(selector) ?? null;
    }

    querySelectorAll(selector) {
        return this.all.get(selector) ?? [];
    }
}

function createEventTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event) {
            for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
            return true;
        },
        count(type) {
            return listeners.get(type)?.size ?? 0;
        },
    };
}

function preset(name, values) {
    return { ...structuredPrefillSettings(values), name };
}

function createWorld({ settingsReady = true } = {}) {
    const root = new FakeElement();
    const fieldElements = new Map();
    for (const [key, value] of Object.entries(STRUCTURED_PREFILL_DEFAULTS)) {
        const type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
        fieldElements.set(key, new FakeElement({ tagName: 'input', type, dataset: { sp: key } }));
    }
    const elements = {
        status: new FakeElement(),
        presets: new FakeElement({ tagName: 'select' }),
        name: new FakeElement({ tagName: 'input' }),
        verification: new FakeElement(),
        bundled: new FakeElement({ tagName: 'select' }),
        description: new FakeElement(),
        import: new FakeElement({ tagName: 'input' }),
    };
    root.selectors.set('[data-sp-status]', elements.status);
    root.selectors.set('[data-sp-presets]', elements.presets);
    root.selectors.set('[data-sp-name]', elements.name);
    root.selectors.set('[data-sp-verification]', elements.verification);
    root.selectors.set('[data-sp-bundled]', elements.bundled);
    root.selectors.set('[data-sp-description]', elements.description);
    root.selectors.set('[data-sp-import]', elements.import);
    root.selectors.set('[data-sp="prefill_gen_profile_id"]', fieldElements.get('prefill_gen_profile_id'));
    root.all.set('[data-sp]', [...fieldElements.values()]);

    const documentTarget = {
        querySelector: selector => selector === '#structured-prefill-settings'
            ? root
            : selector === '[data-sp-verification]' ? elements.verification : null,
    };
    const windowTarget = createEventTarget();
    globalThis.window = windowTarget;
    globalThis.document = documentTarget;
    globalThis.Option = FakeOption;

    const power = {
        structured_prefill: structuredPrefillSettings({ enabled: true, override_prefill_text: 'Initial text' }),
        structured_prefill_presets: [
            preset('First', { override_prefill_text: 'First text', hide_prefill_in_display: true }),
            preset('Second', { override_prefill_text: 'Second text', hide_prefill_in_display: false }),
        ],
    };
    const eventListeners = new Map();
    const eventSource = {
        active: 0,
        on(type, listener) {
            this.active += 1;
            if (!eventListeners.has(type)) eventListeners.set(type, new Set());
            eventListeners.get(type).add(listener);
        },
        once() {},
        removeListener(type, listener) {
            this.active -= 1;
            eventListeners.get(type)?.delete(listener);
        },
        emit(type) {
            for (const listener of [...(eventListeners.get(type) ?? [])]) listener();
        },
    };
    const eventTypes = {
        CHAT_CHANGED: 'chat-changed',
        MESSAGE_SWIPED: 'message-swiped',
        MESSAGE_RECEIVED: 'message-received',
        CHARACTER_MESSAGE_RENDERED: 'character-message-rendered',
        GENERATION_STARTED: 'generation-started',
        GENERATION_ENDED: 'generation-ended',
        GENERATION_STOPPED: 'generation-stopped',
    };
    const chat = {
        last: null,
        findLast() {
            return this.last;
        },
    };
    const importCalls = [];
    const context = vm.createContext({
        power_user: power,
        structuredPrefillSettings,
        structuredPrefillStatus,
        saveSettingsDebounced: jest.fn(),
        t: (strings, ...values) => strings.reduce((out, part, index) => out + part + (index < values.length ? String(values[index]) : ''), ''),
        chat,
        eventSource,
        event_types: eventTypes,
        settingsReady,
        window: windowTarget,
        document: documentTarget,
        CustomEvent,
        console,
    });
    const script = new vm.Script(lazyBlock, {
        importModuleDynamically: async specifier => {
            importCalls.push(specifier);
            if (specifier.includes('structured-prefill-ui.js')) {
                const module = new vm.SyntheticModule(['initialiseStructuredPrefillUI'], () => {});
                module.setExport('initialiseStructuredPrefillUI', initialiseStructuredPrefillUI);
                return module;
            }
            if (specifier.includes('extensions.js')) {
                const module = new vm.SyntheticModule(['extension_settings'], () => {});
                module.setExport('extension_settings', { connectionManager: { profiles: [] } });
                return module;
            }
            throw new Error(`Unexpected import: ${specifier}`);
        },
    });
    script.runInContext(context);

    return { context, power, root, elements, fieldElements, windowTarget, eventSource, importCalls, chat };
}

describe('Structured Prefill lazy panel loader', () => {
    test('does not request the panel at startup and replays a preset applied before first open', async () => {
        const world = createWorld();
        world.context.bindStructuredPrefillStatus();
        expect(world.importCalls).toEqual([]);

        await world.context.refreshStructuredPrefillUiAfterHydration();
        expect(world.importCalls).toEqual([]);

        expect(world.context.applyStructuredPrefillPreset('First')).toBe('First');
        expect(world.power.structured_prefill.override_prefill_text).toBe('First text');
        expect(world.elements.name.value).toBe('');

        await world.context.requestStructuredPrefillUi();
        expect(world.importCalls).toHaveLength(2);
        expect(world.elements.name.value).toBe('First');
        expect(world.fieldElements.get('override_prefill_text').value).toBe('First text');
        expect(world.fieldElements.get('enabled').checked).toBe(true);
    });

    test('applies a preset to visible fields after the panel is loaded', async () => {
        const world = createWorld();
        world.context.bindStructuredPrefillStatus();
        await world.context.requestStructuredPrefillUi();
        expect(world.fieldElements.get('override_prefill_text').value).toBe('Initial text');

        expect(world.context.applyStructuredPrefillPreset('Second')).toBe('Second');
        expect(world.elements.name.value).toBe('Second');
        expect(world.fieldElements.get('override_prefill_text').value).toBe('Second text');
        expect(world.fieldElements.get('hide_prefill_in_display').checked).toBe(false);
    });

    test('remounts loaded controls after settings hydration without duplicate subscriptions', async () => {
        const world = createWorld();
        world.context.bindStructuredPrefillStatus();
        await world.context.requestStructuredPrefillUi();
        expect(world.eventSource.active).toBe(7);
        expect(world.windowTarget.count('neconyan:prefill-status')).toBe(1);
        expect(world.windowTarget.count('neconyan:structured-prefill-preset-applied')).toBe(1);

        world.power.structured_prefill = structuredPrefillSettings({ enabled: false, override_prefill_text: 'Hydrated text' });
        world.power.structured_prefill_presets = [preset('Hydrated', { override_prefill_text: 'Hydrated preset text' })];
        await world.context.refreshStructuredPrefillUiAfterHydration();

        expect(world.fieldElements.get('enabled').checked).toBe(false);
        expect(world.fieldElements.get('override_prefill_text').value).toBe('Hydrated text');
        expect(world.eventSource.active).toBe(7);
        expect(world.windowTarget.count('neconyan:prefill-status')).toBe(1);
        expect(world.windowTarget.count('neconyan:structured-prefill-preset-applied')).toBe(1);
        expect(world.importCalls).toHaveLength(2);
    });

    test('refreshes visible fields when the Formatting panel opens again', async () => {
        const world = createWorld();
        world.context.bindStructuredPrefillStatus();
        await world.context.requestStructuredPrefillUi();

        world.power.structured_prefill = structuredPrefillSettings({ enabled: false, override_prefill_text: 'Reopened text' });
        await world.context.requestStructuredPrefillUi();

        expect(world.fieldElements.get('enabled').checked).toBe(false);
        expect(world.fieldElements.get('override_prefill_text').value).toBe('Reopened text');
        expect(world.eventSource.active).toBe(7);
        expect(world.windowTarget.count('neconyan:structured-prefill-preset-applied')).toBe(1);
        expect(world.importCalls).toHaveLength(2);
    });

    test('waits for settings hydration before loading an early Formatting activation', async () => {
        const world = createWorld({ settingsReady: false });
        await world.context.requestStructuredPrefillUi();
        expect(world.importCalls).toEqual([]);

        world.context.settingsReady = true;
        world.power.structured_prefill = structuredPrefillSettings({ enabled: true, override_prefill_text: 'Ready text' });
        world.context.bindStructuredPrefillStatus();
        await world.context.refreshStructuredPrefillUiAfterHydration();

        expect(world.importCalls).toHaveLength(2);
        expect(world.fieldElements.get('override_prefill_text').value).toBe('Ready text');
        expect(world.fieldElements.get('enabled').checked).toBe(true);
    });

    test('paints a status recorded before the panel loads and keeps it across remount and settings refresh', async () => {
        const world = createWorld();
        world.chat.last = { extra: { structured_prefill: { verification: 'matched' } } };
        world.context.bindStructuredPrefillStatus();
        expect(world.importCalls).toEqual([]);
        expect(world.elements.verification.dataset.verification).toBe('matched');
        expect(world.elements.verification.textContent).toContain('Reply matches the full pattern');

        // Native stream reads report a mismatch before the Formatting panel is ever opened.
        world.windowTarget.dispatchEvent(new CustomEvent('neconyan:prefill-status', {
            detail: { verification: 'mismatch' },
        }));
        expect(world.elements.verification.dataset.verification).toBe('mismatch');
        expect(world.elements.verification.textContent).toContain('does not match the pattern');

        await world.context.requestStructuredPrefillUi();
        expect(world.elements.verification.dataset.verification).toBe('mismatch');

        // The chat-load path after a reload reads the saved reply's own status.
        world.chat.last = { extra: { structured_prefill: { verification: 'matched' } } };
        world.eventSource.emit('chat-changed');
        expect(world.elements.verification.dataset.verification).toBe('matched');

        world.power.structured_prefill = structuredPrefillSettings({ enabled: false, override_prefill_text: 'Refreshed' });
        await world.context.refreshStructuredPrefillUiAfterHydration();
        expect(world.elements.verification.dataset.verification).toBe('matched');
        expect(world.eventSource.active).toBe(7);
        expect(world.windowTarget.count('neconyan:prefill-status')).toBe(1);
        expect(world.windowTarget.count('neconyan:structured-prefill-preset-applied')).toBe(1);
    });
});
