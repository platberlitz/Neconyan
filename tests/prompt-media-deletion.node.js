/* eslint playwright/expect-expect: off -- Execute the actual browser handler with controlled host services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { detachMessageMedia } from '../public/scripts/prompt-media-policy.js';
const source = fs.readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');
function handler(name, host) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start > 0);
    const end = source.indexOf('\n}', start) + 2;
    return vm.runInNewContext('(' + source.slice(start, end) + ')', host);
}
function fixture() {
    const extra = { media: [{ type: 'image', url: '/user/images/old.png' }], media_index: 0, media_display: 'gallery', inline_image: true, title: 'Authored title' };
    const message = { mes: 'Authored prose', extra: structuredClone(extra), swipe_id: 0, swipe_info: [{ extra: structuredClone(extra) }] };
    const calls = [], host = { chat: [message], chat_metadata: {}, structuredClone, console,
        getCurrentChatId: () => 'chat', getCurrentUserHandle: () => 'account',
        POPUP_RESULT: { AFFIRMATIVE: 1, CUSTOM1: 2, CANCELLED: 0 }, SCROLL_BEHAVIOR: { KEEP: 0 },
        t: strings => strings.join(''), toastr: Object.fromEntries(['info', 'warning', 'error'].map(key => [key, text => calls.push([key, text])])),
        Popup: { show: { confirm: async (_title, _body, options) => { options.onClose({ inputResults: new Map([['delete_media_files_checkbox', true]]) }); return 1; } } },
        saveChatConditional: async () => { calls.push(['save']); return true; },
        appendMediaToMessage: () => calls.push(['render']), deleteMediaFromServer: async () => { calls.push(['delete']); return { retained: true }; }, detachMessageMedia,
    };
    return { host, message, calls, run: () => handler('deleteMessageMedia', host)(0, 0, {}) };
}
for (const throws of [false, true]) test(`refused deletion save (${throws ? 'throw' : 'false'}) restores targeted attachment and active swipe, preserving concurrent prose`, async () => {
    const f = fixture(), before = structuredClone(f.message.extra);
    f.host.saveChatConditional = async () => { f.message.mes = 'Later authored prose'; f.message.extra.unrelated = 'keep'; if (throws) throw new Error('Save failed'); return false; };
    await f.run();
    assert.deepEqual(f.message.extra, { ...before, unrelated: 'keep' });
    assert.deepEqual(f.message.swipe_info[0].extra, before);
    assert.equal(f.message.mes, 'Later authored prose');
    assert.equal(f.calls.some(([kind]) => kind === 'delete'), false);
});
test('successful last-image deletion removes empty residue before optional physical deletion', async () => {
    const f = fixture();
    f.host.saveChatConditional = async () => {
        assert.equal(Object.hasOwn(f.message.extra, 'media'), false);
        assert.equal(Object.hasOwn(f.message.swipe_info[0].extra, 'media'), false);
        f.calls.push(['save']); return true;
    };
    await f.run();
    assert.equal(f.message.extra.title, 'Authored title');
    assert.equal(f.message.mes, 'Authored prose');
    assert.ok(f.calls.findIndex(([kind]) => kind === 'save') < f.calls.findIndex(([kind]) => kind === 'delete'));
    assert.ok(f.calls.some(([kind, text]) => kind === 'info' && text.includes('other chats')));
});
for (const changed of ['account', 'chat', 'swipe']) test(`a ${changed} switch during confirmation prevents deletion`, async () => {
    const f = fixture(), before = JSON.stringify(f.message);
    const confirm = f.host.Popup.show.confirm;
    f.host.Popup.show.confirm = async (...args) => {
        const result = await confirm(...args);
        if (changed === 'account') f.host.getCurrentUserHandle = () => 'other';
        if (changed === 'chat') f.host.chat = [];
        if (changed === 'swipe') f.message.swipe_id = 1;
        return result;
    };
    await f.run();
    if (changed === 'swipe') f.message.swipe_id = 0;
    assert.equal(JSON.stringify(f.message), before);
    assert.equal(f.calls.some(([kind]) => ['save', 'delete'].includes(kind)), false);
});
test('navigation during acknowledged save prevents physical deletion', async () => {
    const f = fixture();
    f.host.saveChatConditional = async () => { f.host.chat = []; return true; };
    await f.run();
    assert.equal(f.calls.some(([kind]) => kind === 'delete'), false);
});
test('retained managed copy does not emit a physical deletion event', async () => {
    let events = 0;
    const host = { console, fetch: async () => Response.json({ retained: true }), getRequestHeaders: () => ({}),
        eventSource: { emit: async () => { events++; } }, event_types: { MEDIA_ATTACHMENT_DELETED: 'deleted' },
        getCurrentUserHandle: () => 'account', toastr: { error: () => assert.fail('Unexpected deletion error') } };
    const result = await handler('deleteMediaFromServer', host)('/user/images/neconyan-repaired/copy.png');
    assert.equal(result.retained, true);
    assert.equal(events, 0);
});
