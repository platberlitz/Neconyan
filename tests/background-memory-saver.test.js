import { expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { load } from 'cheerio';
import { BACKGROUND_MEMORY_SAVER_KEY, createBackgroundMemorySaver } from '../public/scripts/background-memory-saver.js';

function fixture(enabled = true, release = jest.fn()) {
    const doc = new EventTarget();
    doc.hidden = false;
    const host = new EventTarget();
    const data = new Map(enabled ? [[BACKGROUND_MEMORY_SAVER_KEY, 'on']] : []);
    const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const releaseCache = jest.fn();
    const saver = createBackgroundMemorySaver({ document: doc, host, storage, handlers: new Set([{ release, releaseCache }]) });
    return { saver, release, releaseCache, data,
        hide(value = true) { doc.hidden = value; doc.dispatchEvent(new Event('visibilitychange')); },
        native(state) { const event = new Event('neconyan:memory-lifecycle'); event.detail = { state }; host.dispatchEvent(event); },
        page(type) { host.dispatchEvent(new Event(type)); },
    };
}

test('off by default; the per-device choice survives hide/show and can be switched off', () => {
    const f = fixture(false);
    f.hide();
    expect(f.release).not.toHaveBeenCalled();
    f.saver.setEnabled(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.data.get(BACKGROUND_MEMORY_SAVER_KEY)).toBe('on');
    f.saver.setEnabled(false);
    f.hide();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.data.has(BACKGROUND_MEMORY_SAVER_KEY)).toBe(false);
});

test('duplicate native/browser events retain one wake callback and visible warnings only evict caches', async () => {
    const resume = jest.fn();
    const f = fixture(true, jest.fn(() => resume));
    f.native('pressure');
    expect(f.releaseCache).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
    f.native('background'); f.hide(); f.page('pagehide');
    expect(f.release).toHaveBeenCalledTimes(1);
    f.native('foreground'); f.hide(false);
    expect(resume).not.toHaveBeenCalled();
    f.page('pageshow');
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][0]()).toBe(true);
    f.saver.dispose(); f.hide();
    expect(f.release).toHaveBeenCalledTimes(1);
});

test('hiding during an asynchronous restore invalidates that restore and releases again afterwards', async () => {
    let finish;
    let canRestore;
    const release = jest.fn(() => predicate => { canRestore = predicate; return new Promise(resolve => { finish = resolve; }); });
    const f = fixture(true, release);
    f.hide(); f.hide(false);
    expect(canRestore()).toBe(true);
    f.hide();
    expect(canRestore()).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(2);
});

test('turning the option off still restores a view already released on the next foreground event', async () => {
    const resume = jest.fn();
    const f = fixture(true, jest.fn(() => resume));
    f.hide();
    f.saver.setEnabled(false);
    expect(resume).not.toHaveBeenCalled();
    f.hide(false);
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    f.hide();
    expect(f.release).toHaveBeenCalledTimes(1);
});

test('an interrupted view keeps its original wake callback across repeated tab switches', async () => {
    let finish;
    const resume = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const f = fixture(true, jest.fn(() => resume));
    f.hide(); f.hide(false); f.hide();
    finish(false);
    await Promise.resolve(); await Promise.resolve();
    expect(f.release).toHaveBeenCalledTimes(1);
    f.hide(false);
    expect(resume).toHaveBeenCalledTimes(2);
    finish();
    await Promise.resolve(); await Promise.resolve();
    f.hide();
    expect(f.release).toHaveBeenCalledTimes(2);
});

test('a fast hide/show permanently invalidates the old restore and retries once it settles', async () => {
    let finish;
    const resume = jest.fn(() => new Promise(resolve => { finish = resolve; }));
    const f = fixture(true, jest.fn(() => resume));
    f.hide(); f.hide(false);
    const oldValidity = resume.mock.calls[0][0];
    f.hide(); f.hide(false);
    expect(oldValidity()).toBe(false);
    finish(false);
    await Promise.resolve(); await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[1][0]()).toBe(true);
    finish();
});

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const node = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(row => row.id?.name === 'releaseBackgroundChatView');
function chatFixture({ visible = 95, protectedRow = -1, busy = false, templateContent = null } = {}) {
    let first = 0;
    const template = templateContent === null ? null
        : load(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'))('#message_template .mes');
    const elements = Array.from({ length: 100 }, (_, id) => {
        const row = template?.clone();
        if (id === 0) row?.find('.mes_text').html(templateContent);
        return { getAttribute: () => String(id), querySelector: selector => row ? row.find(selector).length > 0 : id === protectedRow, contains: () => false };
    });
    const runtime = vm.createContext({
        getSelection: () => null,
        isChatAutoNameIdle: () => !busy, isAgentWorkPending: () => false, loadingMoreMessagesOwner: null,
        document: { body: { classList: { contains: () => false } } }, CARD_SCRIPT_MARKER_TAG: 'neconyan-card-script',
        chatElement: [new EventTarget()],
        restoreVisibleChatMessageAnchor: jest.fn(),
        getRenderedChatMessageWindow: () => ({ elements: elements.slice(first), firstMessageId: first, lastMessageId: 99, renderedMessageCount: 100 - first }),
        captureVisibleChatMessageAnchor: () => ({ messageId: String(visible) }),
        captureChatRenderValidity: () => () => true, chatSendStartRevision: 1, chat: Array(100),
        pruneRenderedChatMessagesToWindow: jest.fn(({ windowSize }) => { first = 100 - windowSize; }),
        getMobileChatRenderBatchSize: count => count,
        showMoreMessages: jest.fn(count => { first -= count; }),
    });
    vm.runInContext(source.slice(node.start, node.end), runtime);
    return runtime;
}

test('idle bottom-reading chat releases 75 rows and restores only the same unmodified chat', async () => {
    const f = chatFixture();
    const restore = f.releaseBackgroundChatView();
    expect(f.pruneRenderedChatMessagesToWindow).toHaveBeenCalledWith({ windowSize: 25, pruneFrom: 'start' });
    await restore(() => true);
    expect(f.showMoreMessages).toHaveBeenCalledWith(75, { canRender: expect.any(Function) });
    f.showMoreMessages.mockClear(); f.chatSendStartRevision++;
    await restore(() => true);
    expect(f.showMoreMessages).not.toHaveBeenCalled();
});

test('an Agent starting while away prevents restoration from interfering with its work', async () => {
    const f = chatFixture();
    const restore = f.releaseBackgroundChatView();
    f.isAgentWorkPending = () => true;
    await restore(() => true);
    expect(f.showMoreMessages).not.toHaveBeenCalled();
});

test('reader input during restoration takes ownership of scrolling and stops further paging', async () => {
    const f = chatFixture();
    const restore = f.releaseBackgroundChatView();
    f.showMoreMessages.mockImplementationOnce(() => { f.chatElement[0].dispatchEvent(new Event('wheel')); });
    await restore(() => true);
    expect(f.showMoreMessages).toHaveBeenCalledTimes(1);
    expect(f.restoreVisibleChatMessageAnchor).not.toHaveBeenCalled();
});

test('partially restored history resumes up to the original first row on the next wake', async () => {
    const f = chatFixture();
    const restore = f.releaseBackgroundChatView();
    let visible = true;
    f.getMobileChatRenderBatchSize = count => Math.min(32, count);
    f.showMoreMessages.mockImplementationOnce(count => {
        expect(count).toBe(32);
        f.pruneRenderedChatMessagesToWindow({ windowSize: 57 });
        visible = false;
    });
    expect(await restore(() => visible)).toBe(false);
    visible = true;
    await restore(() => visible);
    expect(f.showMoreMessages.mock.calls.map(([count]) => count)).toEqual([32, 32, 11]);
    expect(f.getRenderedChatMessageWindow().firstMessageId).toBe(0);
});

test.each([{ visible: 0 }, { protectedRow: 0 }, { busy: true }])('keeps reading anchors, interactive cards and busy work: %j', options => {
    const f = chatFixture(options);
    expect(f.releaseBackgroundChatView()).toBeUndefined();
    expect(f.pruneRenderedChatMessagesToWindow).not.toHaveBeenCalled();
});

test('pruning stops before interactive content and keeps five rows above the reading position', () => {
    const f = chatFixture({ visible: 60, protectedRow: 20 });
    f.releaseBackgroundChatView();
    expect(f.pruneRenderedChatMessagesToWindow).toHaveBeenCalledWith({ windowSize: 80, pruneFrom: 'start' });
    const g = chatFixture({ visible: 60 });
    g.releaseBackgroundChatView();
    expect(g.pruneRenderedChatMessagesToWindow).toHaveBeenCalledWith({ windowSize: 45, pruneFrom: 'start' });
});

test('built-in idle message controls can be recreated without preventing all cleanup', () => {
    const f = chatFixture({ templateContent: '<p>A saved reply.</p>' });
    expect(f.releaseBackgroundChatView()).toEqual(expect.any(Function));
    expect(f.pruneRenderedChatMessagesToWindow).toHaveBeenCalledWith({ windowSize: 25, pruneFrom: 'start' });
});

test.each(['<input value="unfinished">', '<details><summary>Saved state</summary></details>', '<iframe></iframe>', '<button>Custom action</button>'])(
    'custom interactive reply content stays mounted: %s', templateContent => {
        const f = chatFixture({ templateContent });
        expect(f.releaseBackgroundChatView()).toBeUndefined();
        expect(f.pruneRenderedChatMessagesToWindow).not.toHaveBeenCalled();
    });
