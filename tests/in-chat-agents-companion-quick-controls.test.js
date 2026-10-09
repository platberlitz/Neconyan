import { describe, test, expect, jest, beforeAll } from '@jest/globals';

let agents = [];
let quick;

beforeAll(async () => {
    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        escapeHtml: value => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'),
    }));
    await jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/agent-store.js', () => ({
        getAgents: () => agents,
        getCompanionConfig: agent => ({ includeInChatHistory: false, includeAllChatHistory: true, chatHistoryDepth: 1, dependencies: [], contextRecipientAgentIds: [], batchAgentIds: [], ...agent?.companion }),
        isCompanionAgent: agent => agent?.execution === 'companion',
    }));
    quick = await import('../public/scripts/extensions/in-chat-agents/companion/companion-quick-controls.js');
});

const companion = (id, name, companionConfig = {}, extra = {}) => ({ id, name, execution: 'companion', companion: companionConfig, ...extra });

describe('companion quick controls', () => {
    test('keeping notes switches chat history on and off', () => {
        const agent = companion('a', 'Alpha');
        expect(quick.applyCompanionQuickChange(agent, { kind: 'keep', checked: true }).companion.includeInChatHistory).toBe(true);
        expect(quick.applyCompanionQuickChange(agent, { kind: 'keep', checked: false }).companion.includeInChatHistory).toBe(false);
        expect(agent.companion).toEqual({});
    });

    test('a notes count keeps that many notes, blank keeps all, and bad values change nothing', () => {
        const agent = companion('a', 'Alpha');
        expect(quick.applyCompanionQuickChange(agent, { kind: 'depth', value: '3' }).companion).toMatchObject({ includeInChatHistory: true, includeAllChatHistory: false, chatHistoryDepth: 3 });
        expect(quick.applyCompanionQuickChange(agent, { kind: 'depth', value: ' ' }).companion).toMatchObject({ includeInChatHistory: true, includeAllChatHistory: true });
        expect(quick.applyCompanionQuickChange(agent, { kind: 'depth', value: '0' })).toBeNull();
        expect(quick.applyCompanionQuickChange(agent, { kind: 'depth', value: '2.5' })).toBeNull();
    });

    test('linking replaces template references and keeps the matching switch in step', () => {
        const target = companion('b-copy', 'Beta', {}, { sourceTemplateId: 'b-template' });
        const agent = companion('a', 'Alpha', { contextRecipientAgentIds: ['b-template', 'c'], sendContextToCompanions: true });
        const linked = quick.applyCompanionQuickChange(agent, { kind: 'link', field: 'contextRecipientAgentIds', candidate: target, checked: true });
        expect(linked.companion.contextRecipientAgentIds).toEqual(['c', 'b-copy']);
        const unlinked = quick.applyCompanionQuickChange(companion('a', 'Alpha', { batchAgentIds: ['b-copy'], batch: true }), { kind: 'link', field: 'batchAgentIds', candidate: target, checked: false });
        expect(unlinked.companion).toMatchObject({ batchAgentIds: [], batch: false });
        const after = quick.applyCompanionQuickChange(agent, { kind: 'link', field: 'dependencies', candidate: target, checked: true });
        expect(after.companion.dependencies).toEqual(['b-copy']);
        expect(quick.applyCompanionQuickChange(agent, { kind: 'link', field: 'unknown', candidate: target, checked: true })).toBeNull();
    });

    test('describes links in plain words', () => {
        const beta = companion('b', 'Beta');
        const gamma = companion('c', 'Gamma');
        expect(quick.describeCompanionLinks(companion('a', 'Alpha', { dependencies: ['b'], contextRecipientAgentIds: ['b', 'c'] }), [beta, gamma])).toBe('Runs after Beta · Sends notes to 2');
        expect(quick.describeCompanionLinks(companion('a', 'Alpha'), [beta])).toBe('Not connected');
        expect(quick.describeCompanionLinks(companion('a', 'Alpha'), [])).toBe('No other companions yet');
    });

    test('builds controls only for companions and lists the other companions to connect', () => {
        agents = [companion('a', 'Alpha', { includeInChatHistory: true, includeAllChatHistory: false, chatHistoryDepth: 4, dependencies: ['b'] }), companion('b', 'Beta <b>'), { id: 'x', name: 'Plain', execution: 'inline' }];
        expect(quick.buildCompanionQuickControlsHtml(agents[2])).toBe('');
        const html = quick.buildCompanionQuickControlsHtml(agents[0]);
        expect(html).toContain('data-companion-quick="a"');
        expect(html).toContain('data-quick-keep');
        expect(html).toContain('value="4"');
        expect(html).toContain('data-quick-link="dependencies" data-candidate-id="b" checked');
        expect(html).toContain('Beta &lt;b&gt;');
        expect(html).not.toContain('data-candidate-id="x"');
        expect(html).toContain('More connection options');
    });
});
