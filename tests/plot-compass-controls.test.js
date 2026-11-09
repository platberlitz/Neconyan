import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({ escapeHtml: value => String(value) }));
await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/plot-compass-context.js', () => ({
    getPlotCompassIdentity: () => ({ avatar: 'mira.png', chatId: 'one' }),
}));
const { buildPlotCompassControls, readPlotCompassControls, submitPlotCompassOnEnter } = await import('../public/scripts/extensions/in-chat-agents/companion/plot-compass-controls.js');

describe('Plot Compass controls', () => {
    test('shows three independent fields with matching switches instead of a scope selector', () => {
        const html = buildPlotCompassControls({ settings: { plotCompassObjective: 'Saved global' } });
        expect(html.match(/data-role="plot-compass-objective"/g)).toHaveLength(3);
        expect(html.match(/data-role="plot-compass-enabled"/g)).toHaveLength(3);
        expect(html).not.toContain('<select');
        expect(html).toContain('Saved global');
        expect(html).toContain('This character card');
        expect(html).toContain('This chat only');
    });

    test('reads all available fields, retaining the text of a disabled objective', () => {
        // The editor temporarily disables every control before reading its values.
        const inputs = ['global', 'character', 'chat'].map(scope => ({ dataset: { plotScope: scope, plotAvailable: String(scope !== 'character') }, value: `${scope} draft`, disabled: true }));
        const element = { querySelectorAll: () => inputs, querySelector: selector => ({ checked: !selector.includes('global') }) };
        expect(readPlotCompassControls(element)).toEqual([
            { scope: 'global', objective: 'global draft', enabled: false },
            { scope: 'chat', objective: 'chat draft', enabled: true },
        ]);
    });

    test('disables unavailable local scopes in the editor without disabling global editing', () => {
        const html = buildPlotCompassControls({}, { editor: true, identity: {} });
        expect(html.match(/ disabled/g)).toHaveLength(4);
        expect(html).not.toContain('data-action=');
        expect(html).toContain('Save the agent to apply changes.');
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
