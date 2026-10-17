import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, jest, test } from '@jest/globals';
import { renderMessagesInBatches } from '../public/scripts/chat-render-lifecycle/render-batch.js';

const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const names = ['redisplayChat', 'renderRedisplayChatMessages', 'renderRedisplayChatMessagesLegacy', 'renderRedisplayChatMessagesThroughLifecycle'];
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(row => row.declaration ?? row).filter(row => names.includes(row.id?.name))
    .map(row => source.slice(row.start, row.end)).join('\n');

for (const lifecycle of [false, true]) for (const outcome of ['complete', 'navigation', 'failure']) {
    test(`atomic ${lifecycle ? 'lifecycle' : 'legacy'} redraw keeps the old reply until ${outcome}`, async () => {
        const no = () => {};
        let current = true;
        const original = [{ text: 'Visible preview', inert: false }, { text: 'Already disabled', inert: true }];
        let rows = [...original];
        let release;
        let reached;
        const gate = new Promise(resolve => { release = resolve; });
        const paused = new Promise(resolve => { reached = resolve; });
        const dispatched = [];
        const documentRef = { createDocumentFragment: () => ({ children: [], appendChild(node) {
            this.children.push(...(node.children ?? [node]));
        } }), dispatchEvent(event) { dispatched.push(event); } };
        const tags = jest.fn();
        const removed = jest.fn();
        const controls = jest.fn();
        const observed = jest.fn(element => { expect(rows).toContain(element); });
        const committed = jest.fn();
        const runtime = vm.createContext({
            console: { info: no }, performance, document: documentRef,
            CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
            chat: Array.from({ length: 17 }, (_, index) => ({ mes: `Saved ${index}` })),
            captureChatRenderValidity: () => () => current,
            chatElement: { 0: { appendChild: fragment => rows.push(...fragment.children) }, find: () => {
                const previous = [...rows];
                return { toArray: () => previous, removeClass: no, remove() { removed(); rows = rows.filter(row => !previous.includes(row)); } };
            } },
            getRenderedChatMessageWindow: () => ({ renderedMessageCount: 1, firstMessageId: 0, lastMessageId: 0 }),
            getChatRenderWindowSize: () => 50, getMobileChatRenderBatchSize: () => 8,
            isChatRenderLifecycleRolloutEnabled: () => lifecycle, CHAT_RENDER_LIFECYCLE_ROUTE: { REDISPLAY_BATCH: 'batch' },
            unobserveChatMessageResize: no, observeChatMessageResize: observed, removeChatHistoryWindowControls: controls,
            applyCharacterTagsToMessageDivs: tags,
            syncChatHistoryWindowControls: no, refreshSwipeButtons: no, applyStylePins: no, updateEditArrowClasses: no,
            updateMessageElement: (message, { messageId }) => {
                if (outcome === 'failure' && messageId === 8) throw new Error('Interrupted render');
                return [{ text: message.mes, classList: { add: no } }];
            },
            lodash: { range: (a, b) => Array.from({ length: b - a }, (_, index) => a + index) },
            renderMessagesInBatches: options => renderMessagesInBatches({ ...options, documentRef }),
            waitForNextFrame: async () => { reached(); await gate; },
        });
        vm.runInContext(functions, runtime);
        const rendering = runtime.redisplayChat({ atomic: true, replaceRenderedWindow: true, onCommit: committed });
        await paused;
        expect(rows.map(row => row.text)).toEqual(['Visible preview', 'Already disabled']);
        expect(original.map(row => row.inert)).toEqual([true, true]);
        expect(observed).not.toHaveBeenCalled();
        expect(controls).not.toHaveBeenCalled();
        expect(removed).not.toHaveBeenCalled();
        if (outcome === 'navigation') {
            current = false;
            rows = [{ text: 'Another chat' }];
        }
        release();
        await expect(rendering.then(() => null, error => error.message)).resolves.toBe(outcome === 'failure' ? 'Interrupted render' : null);
        expect(rows.map(row => row.text)).toEqual(outcome === 'complete'
            ? Array.from({ length: 17 }, (_, index) => `Saved ${index}`)
            : outcome === 'navigation' ? ['Another chat'] : ['Visible preview', 'Already disabled']);
        expect(original.map(row => row.inert)).toEqual([false, true]);
        expect(removed).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
        expect(tags).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
        expect(controls).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
        expect(observed).toHaveBeenCalledTimes(outcome === 'complete' ? 17 : 0);
        expect(committed).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
        expect(dispatched.map(event => event.type)).toEqual(outcome === 'complete' ? ['neconyan:chat-rows-prepared'] : []);
        expect(dispatched[0]?.detail.elements.length ?? 0).toBe(outcome === 'complete' ? 17 : 0);
    });
}
