import { describe, expect, jest, test } from '@jest/globals';
import { loadIsolated } from './pinned-prompt-test-support.js';

class FakeSelect {
    innerHTML = '';
    value = '';
}

async function createManager({ placementField = null } = {}) {
    const elements = { completion_prompt_manager_popup_entry_form_placement: placementField };
    const { PromptManager } = await loadIsolated('scripts/PromptManager.js', {
        '../script.js': { main_api: 'openai', eventSource: { emit: jest.fn(), on: jest.fn() }, event_types: {} },
        './group-chats.js': { is_group_generating: false },
    }, {
        HTMLSelectElement: FakeSelect,
        document: { getElementById: id => elements[id] ?? null },
    });
    const manager = new PromptManager();
    manager.configuration.prefix = 'completion_';
    manager.activeCharacter = { id: 100000 };
    manager.serviceSettings = {
        prompts: [
            { identifier: 'main', name: 'Main Prompt' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
            { identifier: 'jailbreak', name: 'Post-History Instructions' },
            { identifier: 'fresh', name: 'Fresh prompt' },
        ],
        prompt_order: [{
            character_id: 100000,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: false },
            ],
        }],
    };
    return manager;
}

const orderIds = manager => manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => entry.identifier);
const fresh = manager => manager.getPromptById('fresh');

describe('adding a prompt to the list', () => {
    test('puts it straight after the chosen prompt, switched on', async () => {
        const manager = await createManager();
        manager.appendPrompt(fresh(manager), manager.activeCharacter, 'main');

        expect(orderIds(manager)).toEqual(['main', 'fresh', 'chatHistory', 'jailbreak']);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'fresh').enabled).toBe(true);
    });

    test('puts it first for the top of the list and last without a known spot', async () => {
        const top = await createManager();
        top.appendPrompt(fresh(top), top.activeCharacter, '');
        expect(orderIds(top)).toEqual(['fresh', 'main', 'chatHistory', 'jailbreak']);

        for (const anchor of [null, 'missing']) {
            const end = await createManager();
            end.appendPrompt(fresh(end), end.activeCharacter, anchor);
            expect(orderIds(end)).toEqual(['main', 'chatHistory', 'jailbreak', 'fresh']);
        }
    });

    test('leaves a prompt that is already in the list where it is', async () => {
        const manager = await createManager();
        manager.appendPrompt(manager.getPromptById('jailbreak'), manager.activeCharacter, '');

        expect(orderIds(manager)).toEqual(['main', 'chatHistory', 'jailbreak']);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'jailbreak').enabled).toBe(false);
    });
});

describe('the Place after picker', () => {
    test('lists the top of the list, then every prompt in order', async () => {
        const placementField = new FakeSelect();
        const manager = await createManager({ placementField });
        manager.fillPlacementSelect('chatHistory');

        expect(placementField.innerHTML).toBe([
            '<option value="">Top of the list</option>',
            '<option value="main">Main Prompt</option>',
            '<option value="chatHistory">Chat History</option>',
            '<option value="jailbreak">Post-History Instructions</option>',
        ].join(''));
        expect(placementField.value).toBe('chatHistory');
    });

    test('starts on the last prompt when nothing in the list was selected', async () => {
        const placementField = new FakeSelect();
        const manager = await createManager({ placementField });
        manager.fillPlacementSelect(null);

        expect(placementField.value).toBe('jailbreak');
    });
});
