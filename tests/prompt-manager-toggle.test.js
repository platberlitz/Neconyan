import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { managerFixture, renderedManagerFixture } from './pinned-prompt-test-support.js';

describe('shared Prompt Manager enabled mutation', () => {
    test('turns off immediately, clears tokens and variables, preserves drawer, renders and saves once', async () => {
        const { manager, counts, emit, cleanup } = await managerFixture();
        const sequence = [];
        emit.mockImplementation(() => sequence.push('notify'));
        manager.render.mockImplementation(() => sequence.push('render'));
        expect(manager.setPromptEnabled('a', false)).toBe(true);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'a').enabled).toBe(false);
        expect(counts.a).toBeNull();
        expect(cleanup).toHaveBeenCalledWith('{{setvar::mode::on}}');
        expect(sequence).toEqual(['notify', 'render']);
        expect(manager.render).toHaveBeenCalledTimes(1);
        expect(manager.saveServiceSettings).toHaveBeenCalledTimes(1);
        expect(manager.setStoredDrawerExpanded).toHaveBeenCalledWith(true);
        expect(manager.setPromptEnabled('a', false)).toBe(false);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(manager.setPromptEnabled('a', true)).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
    test('guards missing scopes/definitions/entries and restricted UI switches', async () => {
        const { manager, cleanup } = await managerFixture();
        for (const identifier of ['absent', 'detached', '', null, 'restricted']) expect(manager.setPromptEnabled(identifier, false)).toBe(false);
        expect(manager.setPromptEnabled('a', 'false')).toBe(false);
        manager.activeCharacter = null;
        expect(manager.setPromptEnabled('a', false)).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        expect(manager.render).not.toHaveBeenCalled();
        expect(manager.saveServiceSettings).not.toHaveBeenCalled();
    });
    test('even same-name preset application intervals cannot mutate an old order', async () => {
        const { manager, cleanup } = await managerFixture();
        manager.isPresetChanging = true;
        expect(manager.setPromptEnabled('a', false)).toBe(false);
        expect(await manager.setPromptPinned('a', true)).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        expect(manager.saveServiceSettings).not.toHaveBeenCalled();
    });
    test('command retains parsing, duplicate-name lookup, broader permissions and one final render/save', async () => {
        const { manager, cleanup } = await managerFixture();
        const source = readFileSync(new URL('../public/scripts/slash-commands.js', import.meta.url), 'utf8');
        const start = source.indexOf('function setPromptEntryCallback(');
        const end = source.indexOf('\n/**', start);
        const callback = new Function('promptManager', 'isTrueBoolean', 'isFalseBoolean', source.slice(start, end) + '\nreturn setPromptEntryCallback;')(
            manager, value => ['true', '1', 'on'].includes(value.toLowerCase()), value => ['false', '0', 'off'].includes(value.toLowerCase()));
        const mutate = jest.spyOn(manager, 'setPromptEnabled');
        expect(callback({ identifier: '["a","detached","restricted"]', name: ['Shared'] }, 'toggle')).toBe('');
        expect(mutate.mock.calls.map(call => call[0])).toEqual(['a', 'restricted', 'b']);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'a').enabled).toBe(false);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'b').enabled).toBe(true);
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'restricted').enabled).toBe(false);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(manager.render).toHaveBeenCalledTimes(1);
        expect(manager.saveServiceSettings).toHaveBeenCalledTimes(1);
        callback({ name: 'Shared' }, 'true');
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'a').enabled).toBe(true);
        callback({ identifier: 'a' }, 'false');
        expect(cleanup).toHaveBeenCalledTimes(2);
        callback({ identifier: 'a' }, 'invalid');
        expect(manager.render).toHaveBeenCalledTimes(3);
    });
    test('scope checks reject stale rows even when a new preset repeats an identifier', async () => {
        const { manager } = await managerFixture();
        const scope = { name: 'A', character: manager.activeCharacter, prompt: manager.getPromptById('a'), entry: manager.getPromptOrderEntry(manager.activeCharacter, 'a') };
        expect(manager.isPromptScopeCurrent(scope)).toBe(true);
        manager.serviceSettings.prompts = structuredClone(manager.serviceSettings.prompts);
        expect(manager.isPromptScopeCurrent(scope)).toBe(false);
    });
    test('a real list click immediately after a global character update still toggles, without waiting for rendering', async () => {
        const { manager } = await renderedManagerFixture();
        manager.configuration.promptOrder.dummyId = 42;
        await manager.renderPromptManagerListItems();
        const row = manager.listElement.rows.find(row => row.dataset.pmIdentifier === 'a');
        const button = row.querySelector('.prompt-manager-toggle-action');
        const oldCharacter = manager.activeCharacter;
        manager.handleCharacterUpdated({ detail: { id: 9, character: { name: 'Updated' } } });
        expect(manager.activeCharacter).not.toBe(oldCharacter);
        button.click();
        expect(manager.getPromptOrderEntry(manager.activeCharacter, 'a').enabled).toBe(false);
        expect(button.getAttribute('aria-checked')).toBe('false');
        expect(manager.render).toHaveBeenCalledTimes(1);
    });
    test('quotes and angle brackets remain literal in rendered switch and pin names and never create attributes', async () => {
        const { manager } = await renderedManagerFixture();
        const name = 'A "quote" <b> & \'single\'';
        manager.getPromptById('a').name = name;
        await manager.renderPromptManagerListItems();
        const row = manager.listElement.rows.find(row => row.dataset.pmIdentifier === 'a');
        const toggle = row.querySelector('.prompt-manager-toggle-action');
        const pin = row.querySelector('.prompt-manager-pin-action');
        expect(toggle.getAttribute('aria-label')).toBe(name);
        expect(toggle.title).toBe(name);
        expect(pin.getAttribute('aria-label')).toBe(`Pin ${name} to chat`);
        expect(pin.title).toBe(`Pin ${name} to chat`);
        expect(manager.listElement.html).toContain('A &quot;quote&quot; &lt;b&gt; &amp; &#39;single&#39;');
        expect(manager.listElement.html).not.toContain('<b>');
    });
    test('character and group strategies publish the selected scope immediately, without borrowing the first order', async () => {
        const { manager, emit } = await managerFixture();
        manager.configuration.promptOrder.strategy = 'character';
        manager.serviceSettings.prompt_order.push({ character_id: '7', order: [{ identifier: 'b', enabled: false }] },
            { character_id: 'group', order: [{ identifier: 'a', enabled: false }] });
        manager.handleCharacterSelected({ detail: { id: 7, character: { name: 'Other' } } });
        expect(manager.activeCharacter.id).toBe(7);
        expect(emit).toHaveBeenLastCalledWith('updated', { manager, reason: 'character' });
        expect(manager.setPromptEnabled('a', false)).toBe(false);
        expect(manager.setPromptEnabled('b', true)).toBe(true);
        manager.handleGroupSelected({ detail: { id: 'group', group: { members: ['nova.png'] } } });
        expect(emit).toHaveBeenLastCalledWith('updated', { manager, reason: 'group' });
        expect(manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => entry.identifier)).toEqual(['a']);
        expect(manager.getPromptOrderEntry({ id: 42 }, 'a').enabled).toBe(true);
    });
    test('reordering refreshes existing native control scopes to the cloned order entries', async () => {
        let sortableOptions;
        const $ = () => ({ sortable: options => {
            if (options === 'toArray') return ['b', 'a', 'restricted'];
            sortableOptions = options;
        } });
        const { manager, emit } = await renderedManagerFixture({}, { $ });
        manager.updateDragLockState = jest.fn();
        await manager.renderPromptManagerListItems();
        const oldEntry = manager.getPromptOrderEntry(manager.activeCharacter, 'a');
        const button = manager.listElement.rows.find(row => row.dataset.pmIdentifier === 'a').querySelector('.prompt-manager-toggle-action');
        const scope = button.promptScope;
        manager.makeDraggable();
        sortableOptions.update({}, null);
        expect(manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => entry.identifier)).toEqual(['b', 'a', 'restricted']);
        expect(scope.entry).not.toBe(oldEntry);
        expect(manager.isPromptScopeCurrent(scope)).toBe(true);
        button.click();
        expect(scope.entry.enabled).toBe(false);
        expect(emit).toHaveBeenCalledWith('updated', { manager, reason: 'reorder' });
    });
});
