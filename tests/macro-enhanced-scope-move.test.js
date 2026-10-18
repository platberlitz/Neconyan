import { describe, expect, test } from '@jest/globals';
import {
    createSaveGate,
    moveMacroBetweenScopes,
} from '../public/scripts/extensions/third-party/MacroEnhanced/src/custom/scope-move.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

async function tick() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

const moved = { id: 'moved', name: 'greet' };
const other = { id: 'other', name: 'other' };

describe('Macro Enhanced cross-scope macro moves', () => {
    test('source removal preserves macros added while the target card saves', async () => {
        const target = deferred();
        const added = { id: 'added', name: 'added' };
        const lists = { chat: [moved, other], character: [] };
        const move = moveMacroBetweenScopes({
            sourceScope: 'chat', targetScope: 'character', defId: moved.id,
            sourceDefs: [other], targetDefs: [moved],
            identityFor: scope => scope,
            readDefs: scope => lists[scope],
            persist: async (scope, defs) => {
                if (scope === 'character') await target.promise;
                lists[scope] = defs;
            },
        });
        lists.chat = [...lists.chat, added];
        target.resolve();
        await move;
        expect(lists.chat).toEqual([other, added]);
    });

    test('rollback preserves macros added while the source card saves', async () => {
        const source = deferred();
        const added = { id: 'added', name: 'added' };
        const lists = { chat: [other], character: [moved] };
        const move = moveMacroBetweenScopes({
            sourceScope: 'character', targetScope: 'chat', defId: moved.id,
            sourceDefs: [], targetDefs: [other, moved],
            identityFor: scope => scope,
            readDefs: scope => lists[scope],
            persist: async (scope, defs) => {
                if (scope === 'character') await source.promise;
                lists[scope] = defs;
            },
        });
        await tick();
        lists.chat = [...lists.chat, added];
        source.reject(new Error('card write failed'));
        await expect(move).rejects.toMatchObject({ rollback: 'done' });
        expect(lists.chat).toEqual([other, added]);
        expect(lists.character).toEqual([moved]);
    });

    test('target is written first; a deferred character source removal still uses its captured target', async () => {
        let current = { chat: 'chat-a', character: 'ren.png' };
        const writes = [];
        const source = deferred();
        let sourceStarted = false;
        const identityFor = scope => scope === 'global' ? 'global' : scope === 'chat' ? current.chat : current.character;
        const persist = async (scope, defs) => {
            writes.push({ scope, identity: identityFor(scope), ids: defs.map(def => def.id) });
            if (scope === 'character') {
                sourceStarted = true;
                await source.promise;
            }
        };

        const move = moveMacroBetweenScopes({
            sourceScope: 'character',
            targetScope: 'chat',
            defId: moved.id,
            sourceDefs: [],
            targetDefs: [other, moved],
            identityFor,
            persist,
        });
        while (!sourceStarted) {
            await tick();
        }

        expect(writes).toEqual([
            { scope: 'chat', identity: 'chat-a', ids: ['other', 'moved'] },
            { scope: 'character', identity: 'ren.png', ids: [] },
        ]);
        current = { chat: 'chat-b', character: 'iris.png' };
        source.resolve();
        await expect(move).resolves.toEqual({ targetScope: 'chat', targetIdentity: 'chat-a' });
        expect(writes).toEqual([
            { scope: 'chat', identity: 'chat-a', ids: ['other', 'moved'] },
            { scope: 'character', identity: 'ren.png', ids: [] },
        ]);
        expect(writes.some(write => write.identity === 'chat-b' || write.identity === 'iris.png')).toBe(false);
    });

    test('source rejection leaves the original and skips rollback when the target context changed', async () => {
        let current = { chat: 'chat-a', character: 'ren.png' };
        const writes = [];
        const source = deferred();
        let sourceStarted = false;
        const identityFor = scope => scope === 'global' ? 'global' : scope === 'chat' ? current.chat : current.character;
        const persist = async (scope, defs) => {
            writes.push({ scope, identity: identityFor(scope), ids: defs.map(def => def.id) });
            if (scope === 'character') {
                sourceStarted = true;
                await source.promise;
            }
        };

        const move = moveMacroBetweenScopes({
            sourceScope: 'character',
            targetScope: 'chat',
            defId: moved.id,
            sourceDefs: [],
            targetDefs: [other, moved],
            identityFor,
            persist,
        });
        while (!sourceStarted) {
            await tick();
        }
        current = { chat: 'chat-b', character: 'ren.png' };
        source.reject(new Error('card write failed'));

        await expect(move).rejects.toMatchObject({
            name: 'MoveMacroError',
            rollback: 'skipped',
            sourceRemoved: false,
        });
        expect(writes).toEqual([
            { scope: 'chat', identity: 'chat-a', ids: ['other', 'moved'] },
            { scope: 'character', identity: 'ren.png', ids: [] },
        ]);
        expect(writes.some(write => write.identity === 'chat-b')).toBe(false);
    });

    test('failed source removal rolls the target back when the target context is still current', async () => {
        const current = { chat: 'chat-a', character: 'ren.png' };
        const writes = [];
        const source = deferred();
        let sourceStarted = false;
        const identityFor = scope => scope === 'global' ? 'global' : scope === 'chat' ? current.chat : current.character;
        const persist = async (scope, defs) => {
            writes.push({ scope, identity: identityFor(scope), ids: defs.map(def => def.id) });
            if (scope === 'character') {
                sourceStarted = true;
                await source.promise;
            }
        };

        const move = moveMacroBetweenScopes({
            sourceScope: 'character',
            targetScope: 'chat',
            defId: moved.id,
            sourceDefs: [],
            targetDefs: [other, moved],
            identityFor,
            persist,
        });
        while (!sourceStarted) {
            await tick();
        }
        source.reject(new Error('card write failed'));

        await expect(move).rejects.toMatchObject({
            name: 'MoveMacroError',
            rollback: 'done',
            sourceRemoved: false,
        });
        expect(writes).toEqual([
            { scope: 'chat', identity: 'chat-a', ids: ['other', 'moved'] },
            { scope: 'character', identity: 'ren.png', ids: [] },
            { scope: 'chat', identity: 'chat-a', ids: ['other'] },
        ]);
    });

    test('a deferred character target checks the chat source again before removing it', async () => {
        let current = { chat: 'chat-a', character: 'ren.png' };
        const writes = [];
        const target = deferred();
        let targetStarted = false;
        const identityFor = scope => scope === 'global' ? 'global' : scope === 'chat' ? current.chat : current.character;
        const persist = async (scope, defs) => {
            writes.push({ scope, identity: identityFor(scope), ids: defs.map(def => def.id) });
            if (scope === 'character' && targetStarted === false) {
                targetStarted = true;
                await target.promise;
            }
        };

        const move = moveMacroBetweenScopes({
            sourceScope: 'chat',
            targetScope: 'character',
            defId: moved.id,
            sourceDefs: [other],
            targetDefs: [other, moved],
            identityFor,
            persist,
        });
        while (!targetStarted) {
            await tick();
        }

        current = { chat: 'chat-b', character: 'ren.png' };
        target.resolve();

        await expect(move).rejects.toMatchObject({
            name: 'MoveMacroError',
            rollback: 'done',
            sourceRemoved: false,
        });
        expect(writes).toEqual([
            { scope: 'character', identity: 'ren.png', ids: ['other', 'moved'] },
            { scope: 'character', identity: 'ren.png', ids: ['other'] },
        ]);
        expect(writes.some(write => write.identity === 'chat-b')).toBe(false);
    });

    test('the save gate allows one save at a time and opens again after it settles', async () => {
        const gate = createSaveGate();
        const first = deferred();
        let firstRuns = 0;
        const firstSave = gate.run(async () => {
            firstRuns++;
            await first.promise;
            return 'first';
        });
        expect(gate.busy).toBe(true);

        const second = await gate.run(async () => {
            firstRuns++;
            return 'second';
        });
        expect(second).toEqual({ started: false });
        expect(firstRuns).toBe(1);

        first.resolve();
        await expect(firstSave).resolves.toEqual({ started: true, value: 'first' });
        expect(gate.busy).toBe(false);

        await expect(gate.run(async () => 'third')).resolves.toEqual({ started: true, value: 'third' });
    });

    test('a rejected target write leaves the source untouched', async () => {
        const writes = [];
        const identityFor = scope => scope === 'global' ? 'global' : scope;
        const persist = async (scope, defs) => {
            writes.push({ scope, ids: defs.map(def => def.id) });
            if (scope === 'character') {
                throw new Error('card unavailable');
            }
        };

        await expect(moveMacroBetweenScopes({
            sourceScope: 'chat',
            targetScope: 'character',
            defId: moved.id,
            sourceDefs: [other],
            targetDefs: [other, moved],
            identityFor,
            persist,
        })).rejects.toThrow('card unavailable');
        expect(writes).toEqual([{ scope: 'character', ids: ['other', 'moved'] }]);
    });
});
