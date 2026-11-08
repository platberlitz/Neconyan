import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { normalizeLocator, chatPath, statePath, readChat, readChatShared, readState, mutateState } = await import('../src/mewmory/store.js');

function disk(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mewmory-locator-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group-chats') };
}

for (const locator of [
    { avatar: ' Nova.png', chat: 'Source', group: false },
    { avatar: 'Nova.png', chat: ' Source', group: false },
    { avatar: ' Nova.png', chat: ' Source', group: false },
    { avatar: '', chat: ' Source', group: true },
    { avatar: '\u00a0Nova.png', chat: '\u00a0Source\u00a0', group: false },
]) {
    test(`Mewmory preserves the exact saved filename ${JSON.stringify(locator)}`, t => {
        const directories = disk(t);
        const plain = { ...locator, avatar: locator.avatar.trim(), chat: locator.chat.trim() };
        const filename = value => value.group
            ? path.join(directories.groupChats, value.chat + '.jsonl')
            : path.join(directories.chats, value.avatar.replace('.png', ''), value.chat + '.jsonl');
        for (const [value, message] of [[locator, 'Exact chat'], [plain, 'Different chat']]) {
            fs.mkdirSync(path.dirname(filename(value)), { recursive: true });
            fs.writeFileSync(filename(value), [{ chat_metadata: {} }, { name: 'Nova', is_user: false, mes: message }]
                .map(row => JSON.stringify(row)).join('\n'));
        }
        assert.deepEqual(normalizeLocator(locator), locator);
        assert.deepEqual(normalizeLocator({ ...locator, chat: locator.chat + '.jsonl' }), locator);
        assert.equal(chatPath(directories, locator), filename(locator));
        for (const read of [readChat, readChatShared]) {
            assert.equal(read(directories, locator).messages[0].mes, 'Exact chat');
            assert.equal(read(directories, plain).messages[0].mes, 'Different chat');
        }
        assert.notEqual(statePath(directories, locator), statePath(directories, plain));
        mutateState(directories, locator, state => { state.enabled = true; }, 0);
        assert.deepEqual(readState(directories, locator).locator, locator);
        assert.equal(readState(directories, locator).enabled, true);
        assert.equal(readState(directories, plain).enabled, false);
        mutateState(directories, plain, state => { state.enabled = true; }, 0);
        mutateState(directories, locator, state => { state.enabled = false; }, 1);
        assert.equal(readState(directories, plain).enabled, true);
    });
}

test('Mewmory rejects empty, unsafe and oversized saved filenames', () => {
    const valid = { avatar: 'Nova.png', chat: 'Source', group: false };
    for (const invalid of ['', ' ', '\t', null, 42, 'x'.repeat(256), '../Source', '/Source', 'a\\b', 'a\0b', 'Source ']) {
        assert.throws(() => normalizeLocator({ ...valid, chat: invalid }), `chat: ${JSON.stringify(invalid)}`);
        assert.throws(() => normalizeLocator({ ...valid, avatar: invalid }), `avatar: ${JSON.stringify(invalid)}`);
    }
    for (const chat of ['.jsonl', ' .jsonl', '\u00a0.jsonl']) assert.throws(() => normalizeLocator({ ...valid, chat }));
});
