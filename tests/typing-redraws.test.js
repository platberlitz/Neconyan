import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { debounce } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/debounce.js';

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const rossSource = readFileSync(new URL('../public/scripts/RossAscends-mods.js', import.meta.url), 'utf8');
const conversationSource = readFileSync(new URL('../public/scripts/neconyan-conversation/chrome.js', import.meta.url), 'utf8');
const agentsSource = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const tagsSource = readFileSync(new URL('../public/scripts/tags.js', import.meta.url), 'utf8');
const chatsSource = readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');
const presetsSource = readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/presets-tab.js', import.meta.url), 'utf8');
const casesSource = readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/cases-tab.js', import.meta.url), 'utf8');
const promptsSource = readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/ui/prompts-tab.js', import.meta.url), 'utf8');

const revealSource = rossSource.slice(
    rossSource.indexOf('function revealSendTextAreaEnd('),
    rossSource.indexOf('/**\n * this makes the chat input'),
);
const messageEditSource = scriptSource.slice(
    scriptSource.indexOf('const messageEditPreviewDebounced'),
    scriptSource.indexOf('/**\n * Create the message edit UI.'),
);
const creatorNotesEnd = '$(\'#creator_notes_textarea\').on(\'input\', creatorNotesPreviewDebounced);';
const creatorNotesSource = `let creatorNotesPreviewDebounced = null;\n${scriptSource.slice(
    scriptSource.indexOf('creatorNotesPreviewDebounced = debounce('),
    scriptSource.indexOf(creatorNotesEnd) + creatorNotesEnd.length,
)}`;

function setupReveal({ focused = true, start = 5, end = 5, scrollTop = 0, clientHeight = 100, scrollHeight = 100 } = {}, options) {
    const sendTextArea = {
        value: 'line\n',
        selectionStart: start,
        selectionEnd: end,
        scrollTop,
        clientHeight,
        scrollHeight,
        scrollTo: jest.fn(),
    };
    const context = vm.createContext({
        sendTextArea,
        document: { activeElement: focused ? sendTextArea : {} },
    });
    vm.runInContext(revealSource, context);
    context.revealSendTextAreaEnd(options);
    return sendTextArea;
}

function setupMessageEdit() {
    const biasElement = {
        empty: jest.fn(() => biasElement),
        append: jest.fn(() => biasElement),
    };
    const otherElement = { empty: jest.fn(), append: jest.fn() };
    const mesBlock = {
        find: jest.fn(selector => selector === '.mes_bias' ? biasElement : otherElement),
        closest: jest.fn(() => 'message-element'),
    };
    let currentBias = '';
    const context = vm.createContext({
        debounce_timeout: { standard: 300 },
        debounce: (callback, timeout) => {
            let timer;
            return (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => callback(...args), timeout);
            };
        },
        messageFormatting: jest.fn(value => `formatted:${value}`),
        notifyCardScriptStripped: jest.fn(),
        saveChatDebounced: jest.fn(),
        updateMessage: jest.fn(() => ({ mesBlock, bias: currentBias })),
        this_edit_mes_id: 4,
    });
    vm.runInContext(messageEditSource, context);
    return {
        biasElement,
        context,
        mesBlock,
        type(value) {
            currentBias = value;
            context.messageEditAuto({});
        },
    };
}

function setupCreatorNotes({ menuType = 'create', avatar = 'a.png' } = {}) {
    const handlers = new Map();
    const values = new Map();
    const elements = new Map();
    const preview = { html: jest.fn() };
    const $ = selector => {
        if (selector === '#creator_notes_spoiler') {
            return preview;
        }
        if (!elements.has(selector)) {
            elements.set(selector, {
                val: jest.fn(() => values.get(selector) ?? ''),
                on: jest.fn((event, handler) => { handlers.set(event, handler); }),
            });
        }
        return elements.get(selector);
    };
    const context = vm.createContext({
        $,
        menu_type: menuType,
        this_chid: 0,
        characters: [{ avatar }],
        formatCreatorNotes: jest.fn((notes, avatarValue) => `formatted:${notes}:${avatarValue}`),
        debounce_timeout: { standard: 300 },
        debounce: (callback, timeout) => {
            let timer;
            return (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => callback(...args), timeout);
            };
        },
        cancelDebounce: jest.fn(),
    });
    vm.runInContext(creatorNotesSource, context);
    return {
        context,
        preview,
        type(value) {
            values.set('#creator_notes_textarea', value);
            handlers.get('input')();
        },
    };
}

describe('Typing redraws', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('the composer only follows the caret when the textarea overflows', () => {
        expect(setupReveal({ scrollHeight: 100 }).scrollTo).not.toHaveBeenCalled();
        expect(setupReveal({ scrollTop: 100, scrollHeight: 200 }).scrollTo).not.toHaveBeenCalled();
        expect(setupReveal({ scrollHeight: 200 }).scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'instant' });
        expect(setupReveal({ scrollHeight: 200, start: 0, end: 0 }).scrollTo).not.toHaveBeenCalled();
        expect(setupReveal({ scrollHeight: 200, focused: false }).scrollTo).not.toHaveBeenCalled();
        // A caller that just changed the height follows the end even when the new
        // height still reports the content as fitting, before the browser reflows.
        expect(setupReveal({ scrollTop: 100, scrollHeight: 200 }, { force: true }).scrollTo).toHaveBeenCalledWith({ top: 200, behavior: 'instant' });
    });

    test('message edits update data and save every keystroke but redraw the preview once', async () => {
        const { biasElement, context, mesBlock, type } = setupMessageEdit();

        for (const value of ['a', 'ab', 'abc']) {
            type(value);
        }

        expect(context.updateMessage).toHaveBeenCalledTimes(3);
        expect(context.saveChatDebounced).toHaveBeenCalledTimes(3);
        expect(mesBlock.find).not.toHaveBeenCalledWith('.mes_text');
        expect(biasElement.empty).not.toHaveBeenCalled();
        expect(context.messageFormatting).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(300);

        expect(biasElement.empty).toHaveBeenCalledTimes(1);
        expect(biasElement.append).toHaveBeenCalledWith('formatted:abc');
        expect(context.notifyCardScriptStripped).toHaveBeenCalledTimes(1);
        expect(context.notifyCardScriptStripped).toHaveBeenCalledWith('message-element', 4);
    });

    test('the creator notes preview updates once after typing and uses the current avatar', async () => {
        const created = setupCreatorNotes();
        for (const value of ['A', 'An', 'An edit']) {
            created.type(value);
        }
        expect(created.context.formatCreatorNotes).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(300);
        expect(created.context.formatCreatorNotes).toHaveBeenCalledTimes(1);
        expect(created.context.formatCreatorNotes).toHaveBeenCalledWith('An edit', '');
        expect(created.preview.html).toHaveBeenCalledWith('formatted:An edit:');

        const edited = setupCreatorNotes({ menuType: 'edit', avatar: 'persona.png' });
        edited.type('Notes');
        await jest.advanceTimersByTimeAsync(300);
        expect(edited.context.formatCreatorNotes).toHaveBeenCalledWith('Notes', 'persona.png');
    });

    test('the Prompting Lab debounce helper coalesces and cancels pending renders', async () => {
        const calls = [];
        const render = debounce(value => calls.push(value), 200);
        render('a');
        render('ab');
        render('abc');
        await jest.advanceTimersByTimeAsync(199);
        expect(calls).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        expect(calls).toEqual(['abc']);
        render('d');
        render.cancel();
        await jest.advanceTimersByTimeAsync(200);
        expect(calls).toEqual(['abc']);
    });

    test('every search surface binds its input handler to the deferred render', () => {
        const agentSearchBinding = agentsSource.slice(
            agentsSource.indexOf('$(\'#ica--search\').on(\'input\''),
            agentsSource.indexOf('$(\'#ica--timingFilter\').on(\'change\''),
        );
        expect(agentSearchBinding).toContain('agentListSearchRenderPending = true;');
        expect(agentSearchBinding).toContain('renderAgentListDebounced();');
        expect(agentsSource).toContain('container.attr(\'data-rendered-search\'');
        expect(agentsSource).toContain('wrapper.attr(\'data-rendered-search\'');
        expect(agentsSource).toContain('filterBar.find(\'.ica--template-search\').on(\'input\', renderTemplateResultsDebounced);');
        expect(tagsSource).toContain('html.find(\'#neconyan_assign_tag_search\').on(\'input\', renderTagManagerAssignChipsDebounced);');
        expect(chatsSource).toContain('renderAttachmentsDebounced();');
        expect(presetsSource).toContain('searchInput.addEventListener(\'input\', renderLibraryDebounced);');
        expect(casesSource).toContain('searchInput.addEventListener(\'input\', renderListDebounced);');
        expect(promptsSource).toContain('searchInput.addEventListener(\'input\', renderListDebounced);');
        expect(rossSource).toContain('pendingSendTextAreaFit');
        expect(scriptSource).toContain('pendingEditFitFrame');
        expect(conversationSource).toContain('pendingInputHeightFrame');
    });

    test('a pending agent search render settles before a bulk selection, not on blur', () => {
        // The search redraw owns the rows. Rebuilding them when a click moves focus
        // replaces the row under the pointer, so the click never reaches its button.
        const searchBinding = agentsSource.slice(
            agentsSource.indexOf('$(\'#ica--search\').on(\'input\''),
            agentsSource.indexOf('$(\'#ica--timingFilter\').on(\'change\''),
        );
        expect(searchBinding).not.toContain('.on(\'change\'');
        expect(agentsSource).not.toContain('filterBar.find(\'.ica--template-search\').on(\'change\'');
        expect(agentsSource).toContain('filterBar.find(\'.ica--template-search\').on(\'input\', renderTemplateResultsDebounced);');

        const bulkSelectionBinding = agentsSource.slice(
            agentsSource.indexOf('$(\'#ica--bulkSelectAll\').on(\'click\''),
            agentsSource.indexOf('$(\'#ica--bulkClear\').on(\'click\''),
        );
        expect(bulkSelectionBinding).toContain('flushPendingAgentListSearchRender();');
    });
});
