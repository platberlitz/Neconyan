import { describe, expect, test } from '@jest/globals';
import { getPlotCompassObjective, getPlotCompassScopeKey, setPlotCompassObjective } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
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
        expect(getPlotCompassObjective({ plotCompassScope: 'chat', plotCompassObjective: 'Private' }, {})).toBe('');
        expect(() => setPlotCompassObjective({}, {}, 'character', 'Plan')).toThrow();
    });

    test('server prompt uses the selected identity and never falls back to global', () => {
        let settings = setPlotCompassObjective({ plotCompassObjective: 'Global secret' }, first, 'chat', 'Chat plan');
        const agent = { sourceTemplateId: 'tpl-plot-compass-companion', settings };
        expect(getCompanionTemplateSettings(agent, { plotCompassIdentity: first })).toContain('Chat plan');
        expect(getCompanionTemplateSettings(agent, { plotCompassIdentity: second })).not.toContain('Global secret');
        settings = setPlotCompassObjective(settings, first, 'global', 'Global plan');
        agent.settings = settings;
        expect(getCompanionTemplateSettings(agent, { plotCompassIdentity: second })).toContain('Global plan');
    });
});
