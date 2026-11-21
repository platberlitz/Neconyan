import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(testDirectory, '..', 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let index = source.indexOf('{', start); index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Could not find the end of ${name}`);
}

function makeHarness(disabledExtensions = []) {
    const state = { disabledExtensions };
    class FakeButton {}
    const document = {
        querySelector: jest.fn(() => null),
        querySelectorAll: jest.fn(() => []),
    };
    const context = vm.createContext({
        document,
        HTMLElement: FakeButton,
        NN_EXTENSION_ALIASES: {},
        getSillyTavernContext: () => ({ extensionSettings: { disabledExtensions: state.disabledExtensions } }),
    });

    vm.runInContext([
        'let nnMessageActionExtensionSignature = null;',
        extractFunction('normalizeExtensionName'),
        extractFunction('getDisabledExtensionsSignature'),
        extractFunction('isExtensionEnabled'),
        extractFunction('syncMessageActionExtensionVisibility'),
    ].join('\n'), context);

    return { context, document, state, FakeButton };
}

function makeButton(FakeButton, requiredExtension) {
    const button = new FakeButton();
    button.dataset = { requiresExtension: requiredExtension };
    button.classList = { toggle: jest.fn() };
    button.toggleAttribute = jest.fn();
    button.setAttribute = jest.fn();
    button.getAttribute = jest.fn(() => null);
    button.removeAttribute = jest.fn();
    return button;
}

describe('message action extension visibility', () => {
    test('a document scan is skipped while the disabled extension list is unchanged', () => {
        const { context, document, state, FakeButton } = makeHarness(['tts']);
        const button = makeButton(FakeButton, 'tts');
        document.querySelectorAll.mockReturnValue([button]);

        context.syncMessageActionExtensionVisibility();
        expect(document.querySelectorAll).toHaveBeenCalledTimes(1);
        expect(button.classList.toggle).toHaveBeenCalledWith('displayNone', true);

        context.syncMessageActionExtensionVisibility();
        expect(document.querySelectorAll).toHaveBeenCalledTimes(1);

        state.disabledExtensions = ['tts', 'translate'];
        context.syncMessageActionExtensionVisibility();
        expect(document.querySelectorAll).toHaveBeenCalledTimes(2);
    });

    test('an unchanged list still scans a freshly rendered message root', () => {
        const { context } = makeHarness([]);
        const root = { querySelectorAll: jest.fn(() => []) };

        context.syncMessageActionExtensionVisibility(root);
        context.syncMessageActionExtensionVisibility(root);

        expect(root.querySelectorAll).toHaveBeenCalledTimes(2);
    });

    test('third-party prefixes are ignored when comparing names', () => {
        const { context, document, FakeButton } = makeHarness(['third-party/tts']);
        const button = makeButton(FakeButton, 'TTS');
        document.querySelectorAll.mockReturnValue([button]);

        context.syncMessageActionExtensionVisibility();

        expect(button.classList.toggle).toHaveBeenCalledWith('displayNone', true);
    });
});
