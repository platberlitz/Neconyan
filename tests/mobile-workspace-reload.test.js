import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const reloadSource = source.slice(source.indexOf('let reloadingWorkspace = false;'), source.indexOf('async function confirmCacheClearAfterChatSaveFailure'))
    .replace('export async function', 'async function');

function fixture(overrides = {}) {
    const calls = [];
    const context = {
        is_send_press: false,
        is_group_generating: false,
        this_edit_mes_id: undefined,
        document: { body: { dataset: {} } },
        chat: [],
        getCurrentChatId: () => 'saved-chat',
        flushPendingChatSavesForNavigation: async () => { calls.push('save-chat'); return true; },
        saveSettings: async () => { calls.push('save-settings'); return true; },
        Popup: { show: { confirm: async () => { calls.push('confirm'); return false; } } },
        POPUP_RESULT: { AFFIRMATIVE: true },
        toastr: { info: message => calls.push(message) },
        window: { location: { reload: () => calls.push('reload') } },
        t: ([message]) => message,
        ...overrides,
    };
    const reload = runInNewContext(`${reloadSource}\nreloadNeconyanWorkspace`, context);
    return { calls, context, reload };
}

describe('Reload Neconyan', () => {
    test('finishes pending saves before reloading the page', async () => {
        const { reload, calls } = fixture();
        await reload();
        expect(calls).toEqual(['save-chat', 'save-settings', 'reload']);
    });

    test.each([
        [{ is_send_press: true }, 'Wait for the current reply before reloading Neconyan.'],
        [{ this_edit_mes_id: 0 }, 'Save or cancel your message edit before reloading Neconyan.'],
    ])('never discards an active edit or reply', async (state, message) => {
        const { reload, calls } = fixture(state);
        await reload();
        expect(calls).toEqual([message]);
    });

    test('keeps temporary messages if the person cancels', async () => {
        const { reload, calls } = fixture({ getCurrentChatId: () => undefined, chat: [{ mes: 'A temporary reply' }] });
        await reload();
        expect(calls).toEqual(['save-chat', 'save-settings', 'confirm']);
    });

    test('when the local server is unavailable, reloads only after confirmation', async () => {
        const { reload, calls, context } = fixture({ flushPendingChatSavesForNavigation: async () => false });
        await reload();
        expect(calls).toEqual(['confirm']);
        context.Popup.show.confirm = async () => { calls.push('confirmed'); return true; };
        await reload();
        expect(calls).toEqual(['confirm', 'confirmed', 'reload']);
    });

    test('rechecks for a reply that began while saves were in flight', async () => {
        const { reload, calls, context } = fixture();
        context.saveSettings = async () => { context.is_group_generating = true; return true; };
        await reload();
        expect(calls).toEqual(['save-chat', 'Wait for the current reply before reloading Neconyan.']);
    });
});
