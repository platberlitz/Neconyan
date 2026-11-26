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

describe('unsaved new-prompt draft across async redraws', () => {
    class FakeElement {
        constructor(tag = 'div') {
            this.tagName = tag;
            this.style = {};
            this.dataset = {};
            this.children = [];
            this.parentElement = null;
            this.nextSibling = null;
            this.innerHTML = '';
            this.focused = false;
            this.classList = { toggle: jest.fn(), contains: () => false };
        }
        appendChild(child) {
            if (child.parentElement) {
                child.parentElement.children = child.parentElement.children.filter(item => item !== child);
            }
            child.parentElement = this;
            this.children.push(child);
            return child;
        }
        insertBefore(child) { return this.appendChild(child); }
        insertAdjacentHTML() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
        addEventListener() {}
        contains(target) {
            return target === this || this.children.some(child => child.contains?.(target));
        }
        focus() {
            this.focused = true;
            if (this.ownerDocument) this.ownerDocument.activeElement = this;
        }
    }

    async function createRenderManager() {
        const resolvers = [];
        const container = new FakeElement('div');
        const footerDiv = new FakeElement('div');
        container.querySelector = selector => selector === '.completion_prompt_manager_footer' ? footerDiv : null;
        const origin = new FakeElement('div');
        const host = new FakeElement('div');
        const popup = new FakeElement('div');
        const nameInput = new FakeElement('input');
        const doc = {
            body: new FakeElement('body'),
            activeElement: null,
            getElementById: id => elements[id] ?? null,
        };
        doc.activeElement = doc.body;
        for (const el of [container, origin, host, popup, nameInput]) el.ownerDocument = doc;
        origin.appendChild(popup);
        popup.appendChild(nameInput);
        const elements = {
            completion_prompt_manager_popup: popup,
            completion_prompt_manager_popup_edit: new FakeElement('div'),
            completion_prompt_manager_popup_entry_form_name: nameInput,
            completion_prompt_manager_popup_entry_form_role: new FakeElement('select'),
            completion_prompt_manager_popup_entry_form_prompt: new FakeElement('textarea'),
            completion_prompt_manager_popup_entry_form_injection_position: new FakeElement('select'),
            completion_prompt_manager_popup_entry_form_injection_depth: new FakeElement('input'),
            completion_prompt_manager_depth_block: new FakeElement('div'),
            completion_prompt_manager_order_block: new FakeElement('div'),
            completion_prompt_manager_popup_entry_form_injection_order: new FakeElement('input'),
            completion_prompt_manager_popup_entry_form_injection_trigger: new FakeElement('select'),
            completion_prompt_manager_popup_entry_form_forbid_overrides: new FakeElement('input'),
            completion_prompt_manager_forbid_overrides_block: new FakeElement('div'),
            completion_prompt_manager_popup_entry_source_block: new FakeElement('div'),
            completion_prompt_manager_popup_entry_source: new FakeElement('span'),
        };
        elements.completion_prompt_manager_popup_entry_form_injection_position.removeAttribute = jest.fn();

        const { PromptManager } = await loadIsolated('scripts/PromptManager.js', {
            '../script.js': { main_api: 'openai', eventSource: { emit: jest.fn(), on: jest.fn() }, event_types: {} },
            './group-chats.js': { is_group_generating: false },
            './templates.js': {
                renderTemplateAsync: () => new Promise(resolve => resolvers.push(resolve)),
            },
            './power-user.js': { power_user: { prompt_manager_drag_locked: false } },
        }, {
            HTMLElement: FakeElement,
            HTMLSelectElement: FakeSelect,
            document: doc,
        });
        const manager = new PromptManager();
        manager.configuration.prefix = 'completion_';
        manager.containerElement = container;
        manager.activeCharacter = { id: 100000 };
        manager.serviceSettings = {
            prompts: [
                { identifier: 'main', name: 'Main Prompt' },
                { identifier: 'jailbreak', name: 'Post-History Instructions' },
            ],
            prompt_order: [{
                character_id: 100000,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'jailbreak', enabled: true },
                ],
            }],
        };
        manager.getDisplayTokenUsage = () => 0;
        manager.getActivePromptTokenCounts = () => ({ chatHistory: 0 });
        manager.getInChatAgentTokenUsage = () => 0;
        manager.getEditorHost = () => host;
        manager.setEditFormBlockVisibility = jest.fn();
        manager.hidePopup = jest.fn();
        manager.clearInspectForm = jest.fn();
        return { manager, resolvers, doc, popup, host, nameInput };
    }

    test('keeps an open unsaved new-prompt draft and its input focus when an in-flight redraw finishes', async () => {
        const { manager, resolvers, doc, popup, host, nameInput } = await createRenderManager();
        manager.capturePopupOrigin();
        host.appendChild(popup);

        const pendingRender = manager.renderPromptManager(manager.renderRequestId);
        // While header rendering is in flight, the user opens a new unsaved prompt draft and focuses its name input.
        const draftId = 'draft-new-prompt-uuid';
        manager.selectedPromptId = draftId;
        manager.pendingNewPromptId = draftId;
        manager.activePopupArea = 'edit';
        popup.style.display = 'block';
        nameInput.focus();
        // Simulate browser losing focus when popup is temporarily moved back to origin during redraw.
        const restore = manager.restorePopupToOrigin.bind(manager);
        manager.restorePopupToOrigin = () => {
            restore();
            doc.activeElement = doc.body;
        };

        resolvers.shift()('<div>header</div>');
        await new Promise(resolve => setTimeout(resolve, 0));
        resolvers.shift()('<div>footer</div>');
        expect(await pendingRender).toBe(true);

        expect(manager.hidePopup).not.toHaveBeenCalled();
        expect(manager.selectedPromptId).toBe(draftId);
        expect(manager.pendingNewPromptId).toBe(draftId);
        expect(manager.activePopupArea).toBe('edit');
        expect(doc.activeElement).toBe(nameInput);
    });

    test('still closes the editor when a non-draft selected prompt no longer exists', async () => {
        const { manager, resolvers } = await createRenderManager();
        const clearEditSpy = jest.spyOn(manager, 'clearEditForm');

        manager.selectedPromptId = 'deleted-saved-prompt';
        manager.pendingNewPromptId = null;
        manager.activePopupArea = 'edit';

        const pendingRender = manager.renderPromptManager(manager.renderRequestId);
        resolvers.shift()('<div>header</div>');
        await new Promise(resolve => setTimeout(resolve, 0));
        resolvers.shift()('<div>footer</div>');
        expect(await pendingRender).toBe(true);

        expect(manager.hidePopup).toHaveBeenCalledTimes(1);
        expect(clearEditSpy).toHaveBeenCalledTimes(1);
        expect(manager.selectedPromptId).toBeNull();
        expect(manager.activePopupArea).toBe('');
    });

    test('clearEditForm clears pendingNewPromptId so dismissed drafts are no longer protected', async () => {
        const { manager } = await createRenderManager();
        manager.selectedPromptId = 'draft-uuid';
        manager.pendingNewPromptId = 'draft-uuid';
        manager.activePopupArea = 'edit';
        expect(manager.isPendingNewPromptDraft()).toBe(true);

        manager.clearEditForm();
        expect(manager.pendingNewPromptId).toBeNull();
        expect(manager.isPendingNewPromptDraft()).toBe(false);
    });
});
