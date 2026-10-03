import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/notebooks/notes-panels.js', import.meta.url), 'utf8')
    .match(/^async function shareOnce\([\s\S]*?^}/m)[0].replaceAll('import(', 'load(');

function fixture(mode = 'conversation') {
    let branchId = 'branch-one';
    let generation = 1;
    const inputs = Object.fromEntries(['send_textarea', 'sb_conversation_input'].map(id => [id, { value: '', dispatchEvent: jest.fn() }]));
    const app = {
        state: { account: 'owner', notebookId: 'notebook-one', note: { id: 'note-one', title: 'First note' } },
        elements: { textarea: { selectionStart: 0, selectionEnd: 4 } },
        flushSave: jest.fn(async () => true), request: jest.fn(async () => ({ grant: { id: 'grant-one' } })),
        failed: () => false, toast: jest.fn(),
    };
    const context = vm.createContext({
        document: { getElementById: id => inputs[id] }, Event,
        getCurrentUserHandle: () => 'owner', getChatGeneration: () => generation,
        NeconyanShell: { getActiveMode: () => mode },
        load: async () => ({ getCurrentCharAvatar: () => 'miso.png', getConversationThreadKey: () => 'persona:miso.png',
            getActiveConversationBranch: () => ({ id: branchId, createdAt: 1 }) }),
    });
    vm.runInContext(source, context);
    return { app, inputs, share: scope => context.shareOnce(app, scope), branch: value => { branchId = value; }, generation: () => generation++ };
}

describe('one-time note sharing', () => {
    test('adds the grant to the active Conversation draft and keeps the Roleplay draft', async () => {
        const f = fixture();
        f.inputs.send_textarea.value = 'Unsent Roleplay draft';
        f.inputs.sb_conversation_input.value = 'My question';
        await f.share('note');
        expect(f.inputs.sb_conversation_input.value).toContain('My question\nPlease read my note');
        expect(f.inputs.sb_conversation_input.value).toContain('noteId note-one, grantId grant-one');
        expect(f.inputs.send_textarea.value).toBe('Unsent Roleplay draft');
    });

    test('does not combine an old grant with a different note selected during the request', async () => {
        const f = fixture('roleplay');
        f.app.request.mockImplementation(async () => {
            f.app.state.note = { id: 'note-two', title: 'Second note' };
            return { grant: { id: 'grant-one' } };
        });
        await f.share('note');
        expect(f.inputs.send_textarea.value).toBe('');
        expect(f.app.toast).toHaveBeenCalledWith('warning', expect.any(String));
    });

    test('does not share into a Conversation branch chosen while the grant is created', async () => {
        const f = fixture();
        f.app.request.mockImplementation(async () => { f.branch('other-branch'); return { grant: { id: 'grant-one' } }; });
        await f.share('selection');
        expect(f.inputs.sb_conversation_input.value).toBe('');
        expect(f.inputs.send_textarea.value).toBe('');
    });

    test('does not grant access when saving finishes in a different note', async () => {
        const f = fixture('roleplay');
        f.app.flushSave.mockImplementation(async () => { f.app.state.note = { id: 'note-two' }; return true; });
        await f.share('note');
        expect(f.app.request).not.toHaveBeenCalled();
    });
});
