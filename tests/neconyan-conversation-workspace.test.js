import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-conversation/interface.js', import.meta.url), 'utf8');
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
