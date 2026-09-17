import { describe, expect, test, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isExpressionSource, readMessageExpression, writeMessageExpression } from '../public/scripts/expression-history.js';

const core = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const expressions = readFileSync(new URL('../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8');
const companion = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', import.meta.url), 'utf8');
const extract = (source, name) => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '');

describe('exact expression history', () => {
    test('keeps variants and explicit resets independent per swipe through JSON storage', () => {
        const message = { extra: { keep: 1 }, swipe_id: 0, swipe_info: [{ extra: { keep: 2 } }, { extra: {} }] };
        expect(writeMessageExpression(message, 'Cat.png', '/characters/Cat/joy-2.webp?t=1')).toBe(true);
        message.swipe_id = 1;
        expect(readMessageExpression(message, 'Cat.png')).toBeUndefined();
        writeMessageExpression(message, 'Cat.png', null);
        const stored = JSON.parse(JSON.stringify(message));
        expect(readMessageExpression(stored, 'Cat.png').src).toBeNull();
        stored.swipe_id = 0;
        expect(readMessageExpression(stored, 'Cat.png').src).toBe('/characters/Cat/joy-2.webp?t=1');
        expect(stored.extra.keep).toBe(1);
        expect(stored.swipe_info[0].extra.keep).toBe(2);
        expect(readMessageExpression(stored, 'Other.png')).toBeUndefined();
    });

    for (const src of ['https://other.test/a.png', '//other.test/a.png', '/api/secret.png', '/characters/%2e%2e/api/a.png', '/characters/a%5cb.png', '/characters/a.png#x', ' ', undefined]) {
        test(`rejects unsafe imported source ${src}`, () => {
            expect(isExpressionSource(src)).toBe(false);
        });
    }

    test('accepts the server’s unescaped multiword sprite paths', () => {
        expect(isExpressionSource('/characters/Expression Cat/joy variant.png?t=1')).toBe(true);
    });

    test('captures message, swipe, chat load, author and text, and a newer choice invalidates old work', () => {
        const message = { mes: 'same reply', name: 'Cat', avatar: 'Cat.png' };
        const state = { generation: 1, id: 'chat', chat: [message] };
        const runtime = vm.createContext({ ...state, getChatGeneration: () => state.generation, getCurrentChatId: () => state.id,
            getMessageExpressionAvatar: m => m?.avatar });
        vm.runInContext(`const expressionRequests = new WeakMap();\n${extract(core, 'captureExpressionTarget')}\n${extract(core, 'isExpressionTargetCurrent')}`, runtime);
        const old = runtime.captureExpressionTarget(message);
        expect(runtime.isExpressionTargetCurrent(old)).toBe(true);
        runtime.captureExpressionTarget(message);
        expect(runtime.isExpressionTargetCurrent(old)).toBe(false);
        for (const mutate of [() => state.generation++, () => { state.id += 'x'; }, () => message.swipe_id = 1,
            () => message.mes += ' edited', () => message.name += ' renamed', () => message.avatar = 'Other.png']) {
            const target = runtime.captureExpressionTarget(message);
            mutate();
            expect(runtime.isExpressionTargetCurrent(target)).toBe(false);
        }
    });

    test('loaded messages and existing swipes are read-only, identical new replies still need classification', () => {
        const message = { mes: 'same', swipe_id: 0, swipes: ['same', 'other'] };
        const chat = [message];
        const runtime = vm.createContext({ getContext: () => ({ chat }), getMessageExpressionAvatar: () => 'Cat.png' });
        vm.runInContext(`let processedExpressions = new WeakMap();\n${['rememberExpressionMessage', 'seedExpressionHistory', 'needsExpression'].map(name => extract(expressions, name)).join('\n')}`, runtime);
        runtime.seedExpressionHistory();
        expect(runtime.needsExpression(message)).toBe(false);
        message.swipe_id = 1; message.mes = 'other';
        expect(runtime.needsExpression(message)).toBe(false);
        expect(runtime.needsExpression({ mes: 'same' })).toBe(true);
        message.mes = 'edited';
        expect(runtime.needsExpression(message)).toBe(true);
    });

    for (const name of ['runSingleCompanionAgent', 'runBatchCompanionAgents']) {
        test(`${name} discards delayed results without cancellation writes to the new swipe`, async () => {
            const message = { mes: 'old', swipe_id: 0 };
            const agent = { id: 'expression', companion: {} };
            let release;
            const request = new Promise(resolve => { release = resolve; });
            const write = jest.fn();
            const runtime = vm.createContext({ chat: [message], getChatGeneration: () => 1, getCurrentChatId: () => 'chat',
                getAgentPostProcessingTarget: () => undefined,
                isValidCompanionTargetMessage: () => true, isAgentRuntimeAllowed: () => true, getCompanionConfig: () => ({ maxTokens: 100 }),
                getCompanionResultContent: () => '', getCompanionResults: () => ({}), getAgentGenerationCancelRevision: () => 0,
                buildCompanionPromptMessages: async () => [], buildBatchPromptPayload: async () => ({ promptMessages: [], taskPayloads: [] }),
                getUnitExtraContextSections: () => [], requestPromptTransform: () => request, MAX_AGENT_MAX_TOKENS: 100,
                setCompanionResult: write, restoreCompanionResult: write, emitCompanionResultsUpdated: write, DOMException,
            });
            vm.runInContext(`${extract(companion, 'captureCompanionTarget')}\n${extract(companion, name)}`, runtime);
            const pending = runtime[name](name.includes('Batch') ? [agent] : agent, 0, 'normal', 0);
            await Promise.resolve();
            message.swipe_id = 1;
            release({ output: 'joy' });
            await pending;
            expect(write).not.toHaveBeenCalled();
        });
    }
});
