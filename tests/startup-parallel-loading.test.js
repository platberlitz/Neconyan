import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import vm from 'node:vm';
import lodash from 'lodash';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const messageSource = fs.readFileSync(new URL('../public/scripts/system-messages.js', import.meta.url), 'utf8');
const messageStart = messageSource.indexOf('export async function initSystemMessages()');
const messageEnd = messageSource.indexOf('\nconst ASSISTANT_HELP_FACE_PATTERN', messageStart);
if (messageStart < 0 || messageEnd < 0) throw new Error('System message initialiser not found');

function messageFixture() {
    const pending = new Map();
    const messages = {};
    const safety = [];
    const render = jest.fn(name => {
        const task = deferred();
        pending.set(name, task);
        return task.promise;
    });
    const context = vm.createContext({
        lodash, structuredClone, system_messages: messages, SAFETY_CHAT: safety,
        systemUserName: 'System', system_avatar: 'system.png', displayVersion: 'test-version',
        getMessageTimeStamp: () => 'test-time', t: strings => strings[0], renderTemplateAsync: render,
    });
    const run = vm.runInContext(`${messageSource.slice(messageStart, messageEnd).replace('export ', '')}\ninitSystemMessages`, context);
    return { run, pending, messages, safety, render };
}

describe('startup system templates', () => {
    test('requests all templates before waiting and publishes the correct messages together', async () => {
        const { run, pending, messages, safety, render } = messageFixture();
        const task = run();
        expect([...pending.keys()]).toEqual(['help', 'hotkeys', 'formatting', 'welcome', 'welcomePrompt', 'assistantNote']);
        expect(render).toHaveBeenCalledWith('welcome', { displayVersion: 'test-version' });
        for (const [name, wait] of [...pending].reverse()) {
            if (name !== 'help') wait.resolve(`rendered:${name}`);
        }
        await Promise.resolve();
        expect(messages).toEqual({});
        expect(safety).toEqual([]);
        pending.get('help').resolve('rendered:help');
        await task;
        for (const [key, name] of Object.entries({ help: 'help', hotkeys: 'hotkeys', formatting: 'formatting', welcome: 'welcome', welcome_prompt: 'welcomePrompt', assistant_note: 'assistantNote' })) {
            expect(messages[key]).toMatchObject({ mes: `rendered:${name}`, is_system: true, extra: { swipeable: false } });
        }
        expect(messages.welcome_prompt.extra).toMatchObject({ uses_system_ui: true, isSmallSys: true });
        expect(safety).toHaveLength(1);
        expect(safety[0].send_date).toBe('test-time');
    });

    test('failed templates reject startup without publishing incomplete messages', async () => {
        const { run, pending, messages, safety } = messageFixture();
        const task = run();
        pending.get('help').reject(new Error('template failed'));
        for (const [name, wait] of pending) if (name !== 'help') wait.resolve(name);
        await expect(task).rejects.toThrow('template failed');
        expect(messages).toEqual({});
        expect(safety).toEqual([]);
    });
});
