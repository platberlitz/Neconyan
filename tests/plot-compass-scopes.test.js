import { describe, expect, test } from '@jest/globals';
import { getPlotCompassObjective, getPlotCompassScopeKey, getPlotCompassPrompt, isPlotCompassObjectiveEnabled, PLOT_COMPASS_SCOPES, setPlotCompassObjective, setPlotCompassObjectives } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { getCompanionTemplateSettings } from '../public/scripts/extensions/in-chat-agents/companion/companion-prompts.js';

describe('Plot Compass objective scopes', () => {
    const first = { avatar: 'mira.png', chatId: 'one' };
    const second = { avatar: 'mira.png', chatId: 'two' };
    const other = { avatar: 'other.png', chatId: 'one' };

    test('preserves legacy global objectives while isolating chats and characters', () => {
        let settings = { plotCompassObjective: 'Old global plan' };
        expect(getPlotCompassObjective(settings, first)).toBe('Old global plan');
        settings = setPlotCompassObjective(settings, first, 'chat', ' First chat ');
        settings = setPlotCompassObjective(settings, second, 'chat', 'Second chat');
        settings = setPlotCompassObjective(settings, first, 'character', 'Mira plan');
        settings = setPlotCompassObjective(settings, other, 'character', 'Other plan');
        expect(getPlotCompassObjective(settings, first, 'chat')).toBe('First chat');
        expect(getPlotCompassObjective(settings, second, 'chat')).toBe('Second chat');
        expect(getPlotCompassObjective(settings, other, 'chat')).toBe('');
        expect(getPlotCompassObjective(settings, second, 'character')).toBe('Mira plan');
        expect(getPlotCompassObjective(settings, other, 'character')).toBe('Other plan');
        expect(getPlotCompassObjective(settings, first, 'global')).toBe('Old global plan');
        settings = setPlotCompassObjective(settings, first, 'chat', '');
        expect(getPlotCompassObjective(settings, first, 'chat')).toBe('');
        expect(getPlotCompassObjective(settings, second, 'chat')).toBe('Second chat');
    });

    test('keeps group and character identities separate and refuses missing owners', () => {
        const group = { groupId: 'group-1', avatar: 'mira.png', chatId: 'one' };
        expect(getPlotCompassScopeKey('character', group)).toBe(getPlotCompassScopeKey('character', { ...group, avatar: 'other.png' }));
        expect(getPlotCompassScopeKey('chat', group)).not.toBe(getPlotCompassScopeKey('chat', first));
        expect(getPlotCompassObjective({ plotCompassObjective: 'Global' }, {}, 'chat')).toBe('');
        expect(() => setPlotCompassObjective({}, {}, 'character', 'Plan')).toThrow();
    });

    test('server prompt combines objectives for the active identity regardless of the old selected scope', () => {
        let settings = setPlotCompassObjective({ plotCompassObjective: 'Global plan', plotCompassScope: 'global' }, first, 'chat', 'Chat plan');
        settings = setPlotCompassObjective(settings, first, 'character', 'Card plan');
        const agent = { sourceTemplateId: 'tpl-plot-compass-companion', settings };
        const prompt = identity => getCompanionTemplateSettings(agent, { plotCompassIdentity: identity });
        for (const text of ['Global plan', 'Card plan', 'Chat plan']) expect(prompt(first)).toContain(text);
        expect(prompt(second)).toContain('Global plan');
        expect(prompt(second)).toContain('Card plan');
        expect(prompt(second)).not.toContain('Chat plan');
        expect(prompt(other)).toContain('Global plan');
        expect(prompt(other)).not.toContain('Card plan');
        expect(prompt(other)).not.toContain('Chat plan');
    });

    test.each(Array.from({ length: 8 }, (_, mask) => [mask]))('supports enabled combination %i without deleting any objective', mask => {
        const objectives = PLOT_COMPASS_SCOPES.map((scope, index) => ({ scope, objective: `${scope} plan`, enabled: Boolean(mask & (1 << index)) }));
        const settings = setPlotCompassObjectives({}, first, objectives);
        const restored = JSON.parse(JSON.stringify(settings));
        const prompt = getPlotCompassPrompt(restored, first);
        for (const { scope, objective, enabled } of objectives) {
            expect(getPlotCompassObjective(restored, first, scope)).toBe(objective);
            expect(prompt.includes(objective)).toBe(enabled);
        }
        expect(prompt.includes('none set')).toBe(mask === 0);
    });

    test('keeps toggle states with their own cards and chats and can re-enable saved text', () => {
        const original = setPlotCompassObjectives({}, first, [
            { scope: 'character', objective: 'Card plan', enabled: false },
            { scope: 'chat', objective: 'Chat plan', enabled: false },
        ]);
        expect(isPlotCompassObjectiveEnabled(original, second, 'character')).toBe(false);
        expect(isPlotCompassObjectiveEnabled(original, second, 'chat')).toBe(true);
        expect(isPlotCompassObjectiveEnabled(original, other, 'character')).toBe(true);
        const next = setPlotCompassObjectives(original, first, [{ scope: 'chat', objective: getPlotCompassObjective(original, first, 'chat'), enabled: true }]);
        expect(getPlotCompassPrompt(next, first)).toContain('Chat plan');
        expect(getPlotCompassPrompt(next, first)).not.toContain('Card plan');
        expect(getPlotCompassPrompt(original, first)).toContain('none set');
    });

    test('groups compose only global, matching group and matching group-chat objectives', () => {
        const group = { groupId: 'group-1', avatar: 'mira.png', chatId: 'one' };
        let settings = setPlotCompassObjective({ plotCompassObjective: 'Global plan' }, first, 'character', 'Private card plan');
        settings = setPlotCompassObjective(settings, group, 'character', 'Group plan');
        settings = setPlotCompassObjective(settings, group, 'chat', 'Group chat plan');
        expect(getPlotCompassPrompt(settings, group)).toContain('[This group objective]\nGroup plan');
        expect(getPlotCompassPrompt(settings, group)).toContain('Group chat plan');
        expect(getPlotCompassPrompt(settings, group)).not.toContain('Private card plan');
        expect(getPlotCompassPrompt(settings, { ...group, groupId: 'group-2' })).toBe('[Plot Compass Objective]\n[Global objective]\nGlobal plan');
    });

    test('expands macros per layer without truncating the combined objectives', () => {
        const settings = setPlotCompassObjectives({}, first, PLOT_COMPASS_SCOPES.map(scope => ({ scope, objective: '{{char}}' + scope[0].repeat(1990), enabled: true })));
        const resolve = value => value.replace('{{char}}', 'Mira');
        const agent = { sourceTemplateId: 'tpl-plot-compass-companion', settings };
        const prompt = getCompanionTemplateSettings(agent, { plotCompassIdentity: first, resolve });
        for (const scope of PLOT_COMPASS_SCOPES) expect(prompt).toContain('Mira' + scope[0].repeat(1990));
        expect(prompt.length).toBeGreaterThan(6000);
    });
});
