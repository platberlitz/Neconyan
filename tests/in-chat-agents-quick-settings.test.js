import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/quick-settings.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const extract = (text, name) => text.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '');
const companion = (id, config = {}) => ({ id, execution: 'companion', companion: { batch: false, batchAgentIds: [], sendContextToCompanions: false, contextRecipientAgentIds: [], dependencies: ['unchanged'], ...config } });

describe('agent shortcuts', () => {
    test('batch and sharing changes connect only selected companions, preserve outside links and remove template aliases', () => {
        const runtime = vm.createContext({
            isCompanionAgent: agent => agent.execution === 'companion',
            getCompanionReferenceIds: agent => [agent.id, agent.sourceTemplateId].filter(Boolean),
            getCompanionConfig: agent => structuredClone(agent.companion),
        });
        vm.runInContext(extract(source, 'changeSelectedCompanionLinks'), runtime);
        for (const field of ['batchAgentIds', 'contextRecipientAgentIds']) {
            const a = companion('Agent-A', { [field]: ['outside', 'template-b'] });
            const b = { ...companion('agent-a'), sourceTemplateId: 'template-b' };
            const inline = { id: 'inline', execution: 'inline' };
            const records = [a, b, inline];
            runtime.changeSelectedCompanionLinks(records, field, true);
            expect(a.companion[field]).toEqual(['outside', 'agent-a']);
            expect(b.companion[field]).toEqual(['Agent-A']);
            expect(inline).not.toHaveProperty('companion');
            expect(a.companion.dependencies).toEqual(['unchanged']);
            runtime.changeSelectedCompanionLinks(records, field, false);
            expect(a.companion[field]).toEqual(['outside']);
            expect(b.companion[field]).toEqual([]);
            const flag = field === 'batchAgentIds' ? 'batch' : 'sendContextToCompanions';
            expect(a.companion[flag]).toBe(true);
            expect(b.companion[flag]).toBe(false);
        }
    });

    test('history shortcuts save copies, skip inline agents and refresh only after a successful save', async () => {
        const agents = [companion('one'), { id: 'inline', execution: 'inline' }];
        const refreshed = [];
        let saved;
        let fail = true;
        const runtime = vm.createContext({
            structuredClone,
            getAgentById: id => agents.find(agent => agent.id === id),
            isCompanionAgent: agent => agent.execution === 'companion',
            getCompanionConfig: agent => structuredClone(agent.companion),
            lockBundledAgentCustomization: agent => { agent.phaseLocked = true; },
            saveAgentBatch: async changes => { if (fail) throw new Error('Unavailable'); saved = changes; },
            refreshSavedAgents: async ids => refreshed.push(...ids),
        });
        vm.runInContext(extract(index, 'setAgentsChatHistory'), runtime);
        await expect(runtime.setAgentsChatHistory(['one', 'inline'], true)).rejects.toThrow('Unavailable');
        expect(refreshed).toEqual([]);
        expect(agents[0].companion).not.toHaveProperty('includeInChatHistory');
        fail = false;
        await runtime.setAgentsChatHistory(['one', 'inline'], true);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ phaseLocked: true, companion: { includeInChatHistory: true } });
        expect(refreshed).toEqual(['one']);
    });

    test('selection uses the same search, view, type and timing filters as the list', () => {
        const values = { '#ica--search': '', '#ica--timingFilter': '' };
        let tab = 'all';
        const agents = [
            { id: 'a', name: 'Scene', description: '', tags: [], favorite: true, enabled: true, category: 'tracker', phase: 'pre', execution: 'inline' },
            { id: 'b', name: 'Other', description: 'scene', tags: [], favorite: false, enabled: false, category: 'custom', phase: 'post', execution: 'inline' },
            { id: 'c', name: 'Third', description: '', tags: ['SCENE'], favorite: true, enabled: true, category: 'custom', phase: 'post', execution: 'companion' },
        ];
        const isCompanionAgent = agent => agent.execution === 'companion';
        const runtime = vm.createContext({
            $: selector => ({ val: () => values[selector] }),
            getActiveAgentListTab: () => tab,
            isCompanionAgent,
            isAgentEnabledForCurrentScope: agent => agent.enabled,
            agentMatchesListTab: (agent, value) => {
                if (value === 'pre' || value === 'post') return !isCompanionAgent(agent) && agent.phase === value;
                if (value === 'companion') return isCompanionAgent(agent);
                return isCompanionAgent(agent) ? false : agent.category === value;
            },
        });
        for (const name of ['agentMatchesTimingFilter', 'agentMatchesAgentListView', 'getFilteredAgentList']) {
            vm.runInContext(extract(index, name), runtime);
        }
        values['#ica--search'] = 'scene';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual(['a', 'b', 'c']);
        tab = 'quick';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual(['a', 'c']);
        tab = 'on';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual(['a', 'c']);
        tab = 'custom';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual(['b']);
        tab = 'all';
        values['#ica--timingFilter'] = 'post';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual(['b', 'c']);
        values['#ica--timingFilter'] = 'pre';
        tab = 'companion';
        expect(runtime.getFilteredAgentList(agents).map(agent => agent.id)).toEqual([]);
    });
});
