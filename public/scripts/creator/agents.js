import { element, button, textField } from './fields.js';
import { creatorAgentTargets, startCreatorAgentProcessing } from './agent-processing.js';

const labels = { name: 'Display name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First greeting', mes_example: 'Interviewer examples', depth_prompt: 'Character’s Note', creator_notes: 'Public creator notes', system_prompt: 'Main prompt', post_history_instructions: 'Post-history instructions', creator: 'Creator', character_version: 'Card version' };

export async function renderCreatorAgents(workspace, main) {
    const { getAgents, getAgentRegexScripts, getAgentConnectionFallbacks } = await import('../extensions/in-chat-agents/agent-store.js');
    if (!main.isConnected) return;
    const draft = workspace.session.draft;
    const agents = getAgents();
    const selection = draft.writing?.agentProcessing ?? { agents: [], fields: [] };
    const selectedAgents = [...selection.agents];
    const selectedFields = new Set(selection.fields);
    const save = () => workspace.edit(next => { next.writing ??= {}; next.writing.agentProcessing = { agents: [...selectedAgents], fields: [...selectedFields] }; });
    main.append(element('h3', '', 'Post-process fields with agents'), element('p', 'creator-muted', 'Choose agents from your library, then the fields to revise. Agents run in the order you choose, one field or greeting at a time. Each agent receives the previous result. Review the changes before applying them.'), element('p', 'creator-muted', 'Uses each agent’s prompt and enabled regex rules. An agent’s own connection is used when set; otherwise it uses Catelier’s connection. Chat triggers, chat history and automatic tool actions are not used here.'));
    const agentBox = element('fieldset', 'creator-fieldset');
    agentBox.append(element('legend', '', 'Agents to use'));
    const order = element('p', 'creator-muted');
    const refreshOrder = () => { order.textContent = selectedAgents.length ? `Order: ${selectedAgents.map(id => agents.find(agent => agent.id === id)?.name ?? 'Unavailable agent').join(' → ')}` : 'No agents selected.'; };
    const choices = element('div', 'creator-choice-grid');
    agentBox.append(textField('Find an agent', '', value => {
        const query = value.trim().toLocaleLowerCase();
        for (const row of choices.children) {
            row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
            row.style.display = row.hidden ? 'none' : '';
        }
    }, { rows: 1, placeholder: 'Search agent names' }));
    for (const agent of agents) {
        const label = element('label', 'creator-choice-pill');
        const input = element('input'); input.type = 'checkbox'; input.checked = selectedAgents.includes(agent.id);
        input.addEventListener('change', () => {
            if (input.checked) selectedAgents.push(agent.id);
            else selectedAgents.splice(selectedAgents.indexOf(agent.id), 1);
            save(); refreshOrder();
        });
        label.append(input, document.createTextNode(agent.name)); choices.append(label);
    }
    if (!agents.length) choices.append(element('p', 'creator-muted', 'Add or import agents in Agents, then return here.'));
    refreshOrder(); agentBox.append(choices, order); main.append(agentBox);
    const fields = element('fieldset', 'creator-fieldset'); fields.append(element('legend', '', 'Fields to post-process'));
    const grid = element('div', 'creator-choice-grid');
    for (const target of creatorAgentTargets(draft)) {
        const label = element('label', 'creator-choice-pill');
        const input = element('input'); input.type = 'checkbox'; input.checked = selectedFields.has(target.key);
        input.disabled = draft.locks.includes(target.field) || !target.text.trim();
        input.addEventListener('change', () => { if (input.checked) selectedFields.add(target.key); else selectedFields.delete(target.key); save(); });
        label.append(input, document.createTextNode(target.index === undefined ? labels[target.field] ?? target.field : `Alternate greeting ${target.index + 1}`)); grid.append(label);
    }
    fields.append(grid, element('p', 'creator-muted', 'Empty or locked fields cannot be selected.')); main.append(fields);
    main.append(button('Run selected agents', () => workspace.run(async () => {
        const records = selectedAgents.map(id => {
            const agent = getAgents().find(item => item.id === id);
            if (!agent) throw new Error('A selected agent is no longer available. Choose your agents again.');
            return { id: agent.id, name: agent.name, prompt: agent.prompt, connectionProfile: agent.connectionProfile, connectionFallbacks: getAgentConnectionFallbacks(agent, agent.connectionProfile), maxTokens: agent.postProcess?.promptTransformMaxTokens ?? agent.preProcess?.maxTokens ?? agent.companion?.maxTokens, regexScripts: getAgentRegexScripts(agent) };
        });
        const proposal = startCreatorAgentProcessing(workspace.session.draft, records, [...selectedFields]);
        if (!workspace.edit(next => { next.proposals.push(proposal); })) return;
        await workspace.continueWriting(proposal.id);
    }), true));
    const saved = element('div', 'creator-actions');
    for (const proposal of draft.proposals.filter(item => item.label === 'Agent post-processing')) saved.append(button('Review agent post-processing', () => workspace.proposal(proposal)));
    main.append(saved);
}
