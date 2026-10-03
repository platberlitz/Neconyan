import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function runtime() {
    const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const body = source.match(/^export async function getOneCharacter\([\s\S]*?^}/m)[0];
    const card = { avatar: 'New card.png', name: '<b>New card</b>', chat: 123, data: { description: 'Saved definition' } };
    const context = vm.createContext({
        characters: [{ avatar: 'Assistant.png', name: 'Assistant' }], this_chid: 0,
        fetch: jest.fn(async () => ({ ok: true, json: async () => structuredClone(card) })),
        getRequestHeaders: () => ({}), DOMPurify: { sanitize: value => value.replace(/<[^>]*>/g, '') },
        toastr: { error: jest.fn() }, t: (parts, value) => parts[0] + (value ?? '') + (parts[1] ?? ''),
    });
    vm.runInContext(body.replace(/^export /, ''), context);
    return context;
}

test('a new saved card can join the list without replacing the active character', async () => {
    const context = runtime();
    const assistant = context.characters[0];
    expect(await context.getOneCharacter('New card.png', { allowInsert: true })).toBe(true);
    expect(context.characters).toHaveLength(2);
    expect(context.characters[context.this_chid]).toBe(assistant);
    expect(context.characters[1]).toMatchObject({ avatar: 'New card.png', name: 'New card', chat: '123' });
    expect(context.toastr.error).not.toHaveBeenCalled();
    expect(await context.getOneCharacter('New card.png', { allowInsert: true })).toBe(true);
    expect(context.characters).toHaveLength(2);
});

test('ordinary refreshes do not insert an unknown card', async () => {
    const context = runtime();
    expect(await context.getOneCharacter('New card.png')).toBe(false);
    expect(context.characters).toHaveLength(1);
    expect(context.toastr.error).toHaveBeenCalledTimes(1);
});

test('a failed read cannot add a card', async () => {
    const context = runtime();
    context.fetch.mockResolvedValue({ ok: false });
    expect(await context.getOneCharacter('New card.png', { allowInsert: true })).toBe(false);
    expect(context.characters).toHaveLength(1);
});

test('a context change during the read cannot add the card to another chat or account', async () => {
    const context = runtime();
    let current = true;
    context.fetch.mockImplementation(async () => {
        current = false;
        return { ok: true, json: async () => ({ avatar: 'New card.png', name: 'New card' }) };
    });
    expect(await context.getOneCharacter('New card.png', { allowInsert: true, isCurrent: () => current })).toBe(false);
    expect(context.characters).toHaveLength(1);
    expect(context.toastr.error).not.toHaveBeenCalled();
});

test('an already stale read makes no request', async () => {
    const context = runtime();
    expect(await context.getOneCharacter('New card.png', { allowInsert: true, isCurrent: () => false })).toBe(false);
    expect(context.fetch).not.toHaveBeenCalled();
});
