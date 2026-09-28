import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-conversation/interface.js', import.meta.url), 'utf8');
const chromeSource = readFileSync(new URL('../public/scripts/neconyan-conversation/chrome.js', import.meta.url), 'utf8');
function functionSource(name) {
    return source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
}

describe('Conversation connection notice', () => {
    test('keeps valid scoped profiles independent from the global connection', () => {
        class HTMLElement {
            hidden = true;
            dataset = {};
        }
        const notice = new HTMLElement();
        const context = vm.createContext({
            HTMLElement, document: { querySelector: () => notice },
            CHROME_IDS: { header: 'header' }, online_status: 'no_connection',
            getConnectionProfiles: () => [{ id: 'private-profile', name: 'My model' }],
            SillyTavern: { getContext: () => ({ ConnectionManagerRequestService: { sendRequest() {} } }) },
        });
        vm.runInContext(functionSource('hasValidConversationConnectionProfile') + '\n' + functionSource('updateConversationConnectionNotice'), context);
        context.updateConversationConnectionNotice({}, 'cat.png');
        expect(notice.hidden).toBe(false);
        context.updateConversationConnectionNotice({ connection_profile: 'My model' }, 'cat.png');
        expect(notice.hidden).toBe(true);
        context.updateConversationConnectionNotice({ connection_profile: 'Removed profile' }, 'cat.png');
        expect(notice.hidden).toBe(false);
        context.online_status = 'Connected model';
        context.updateConversationConnectionNotice({}, 'cat.png');
        expect(notice.hidden).toBe(true);
        context.online_status = 'no_connection';
        context.updateConversationConnectionNotice({}, null);
        expect(notice.hidden).toBe(true);
    });
});

function createWorkspaceContext(characters = []) {
    const context = vm.createContext({
        characters,
        conversationState: { conversationWorkspaceOpen: false, conversationSelectedAvatar: null, conversationSelectedGroupId: null },
        getCharacterForAvatar: avatar => characters.find(character => character.avatar === avatar),
        getConversationPals: () => [],
        getRoleplayCurrentCharacter: () => null,
        isAvatarInConversationGroup: () => true,
        getConversationBranches: () => [],
        closeConversationSettings: jest.fn(),
        emitConversationWorkspaceStateChange: jest.fn(),
        ensureConversationStylesheet: jest.fn(),
        scheduleInterfaceRefresh: jest.fn(),
        getSettings: () => ({ enabled: false }),
        saveSettings: jest.fn(),
        requestConversationRuntimeStart: jest.fn(),
        applySettingsToPanel: jest.fn(),
        setTimeout: jest.fn(),
        toastr: { info: jest.fn(), warning: jest.fn() },
    });
    for (const name of ['getDefaultConversationAvatar', 'openConversationWorkspaceForAvatar', 'openConversationWorkspaceFromWelcome']) {
        const body = chromeSource.match(new RegExp(`^export function ${name}\\([\\s\\S]*?^}`, 'm'))[0];
        vm.runInContext(body.replace(/^export /, ''), context);
    }
    return context;
}

describe('Conversation workspace entry', () => {
    test('opens the empty workspace from Home on a fresh install', () => {
        const context = createWorkspaceContext();

        expect(context.openConversationWorkspaceFromWelcome()).toBe(true);
        expect(context.conversationState.conversationWorkspaceOpen).toBe(true);
        expect(context.conversationState.conversationSelectedAvatar).toBeNull();
        expect(context.ensureConversationStylesheet).toHaveBeenCalled();
        expect(context.scheduleInterfaceRefresh).toHaveBeenCalledWith({ syncControls: false });
        expect(context.requestConversationRuntimeStart).not.toHaveBeenCalled();
        expect(context.toastr.warning).not.toHaveBeenCalled();
    });

    test('keeps the remembered character and group when opening from Home', () => {
        const context = createWorkspaceContext([{ avatar: 'first.png' }, { avatar: 'remembered.png' }]);
        context.conversationState.conversationSelectedAvatar = 'remembered.png';
        context.conversationState.conversationSelectedGroupId = 'friends';

        expect(context.openConversationWorkspaceFromWelcome()).toBe(true);
        expect(context.conversationState.conversationSelectedAvatar).toBe('remembered.png');
        expect(context.conversationState.conversationSelectedGroupId).toBe('friends');
        expect(context.requestConversationRuntimeStart).toHaveBeenCalled();
        expect(context.saveSettings).not.toHaveBeenCalled();
    });

    for (const characters of [[], [{ avatar: 'remaining.png' }]]) {
        test(`recovers a deleted selection with ${characters.length} remaining characters`, () => {
            const context = createWorkspaceContext(characters);
            context.conversationState.conversationSelectedAvatar = 'deleted.png';

            expect(context.openConversationWorkspaceFromWelcome()).toBe(true);
            expect(context.conversationState.conversationSelectedAvatar).toBe(characters[0]?.avatar || null);
            expect(context.toastr.warning).not.toHaveBeenCalled();
        });
    }

    test('does not report a missing requested character or branch as opened', () => {
        const context = createWorkspaceContext([{ avatar: 'cat.png' }]);

        expect(context.openConversationWorkspaceForAvatar('cat.png', { branchId: 'missing' })).toBe(false);
        expect(context.conversationState.conversationWorkspaceOpen).toBe(false);
        expect(context.openConversationWorkspaceForAvatar('deleted.png')).toBe(false);
    });
});
