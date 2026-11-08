import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ escapeHtml: value => String(value) }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/plot-compass-context.js', () => ({
    getPlotCompassIdentity: () => ({ avatar: 'mira.png', chatId: 'one' }),
}));
const { changePlotCompassScope, submitPlotCompassOnEnter } = await import('../public/scripts/extensions/in-chat-agents/companion/plot-compass-controls.js');

describe('Plot Compass controls', () => {
    test('keeps unsaved drafts separate when switching objective scopes', () => {
        const input = { value: 'Unsaved global', dataset: { plotScope: 'global' } };
        const select = { value: 'chat', closest: () => ({ querySelector: () => input }) };
        const agent = { settings: { plotCompassObjective: 'Saved global' } };
        changePlotCompassScope(select, agent);
        expect(input.value).toBe('');
        input.value = 'Unsaved chat';
        select.value = 'global';
        changePlotCompassScope(select, agent);
        expect(input.value).toBe('Unsaved global');
        select.value = 'chat';
        changePlotCompassScope(select, agent);
        expect(input.value).toBe('Unsaved chat');
    });

    test('Enter submits once while composition and modified keys do not submit', () => {
        const click = jest.fn();
        const event = { key: 'Enter', preventDefault: jest.fn(), stopPropagation: jest.fn(),
            currentTarget: { closest: () => ({ querySelector: () => ({ click }) }) } };
        submitPlotCompassOnEnter(event);
        expect(click).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        for (const variant of [{ isComposing: true }, { originalEvent: { isComposing: true } }, { keyCode: 229 }, { shiftKey: true }, { repeat: true }]) {
            submitPlotCompassOnEnter({ ...event, ...variant });
        }
        expect(click).toHaveBeenCalledTimes(1);
    });
});
