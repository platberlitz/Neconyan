import { element, button } from './fields.js';
import { creatorAgentTargets, startCreatorAgentProcessing } from './agent-processing.js';

const labels = { name: 'Display name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First greeting', mes_example: 'Interviewer examples', depth_prompt: 'Character’s Note', creator_notes: 'Public creator notes', system_prompt: 'Main prompt', post_history_instructions: 'Post-history instructions', creator: 'Creator', character_version: 'Card version' };

export async function renderCreatorAgents(workspace, main) {
    const { getAgents, getAgentRegexScripts, getAgentConnectionFallbacks, AGENT_CATEGORIES = {}, getAgentListKind = () => 'custom' } = await import('../extensions/in-chat-agents/agent-store.js');
    if (!main.isConnected) return;
    const draft = workspace.session.draft;
    const agents = getAgents();
    const categoryKeys = Object.keys(AGENT_CATEGORIES);
    const sortedAgents = [...agents].sort((a, b) => {
        const catDiff = categoryKeys.indexOf(getAgentListKind(a)) - categoryKeys.indexOf(getAgentListKind(b));
        return catDiff !== 0 ? catDiff : String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });
    });
    const selection = draft.writing?.agentProcessing ?? { agents: [], fields: [] };
    const selectedAgents = [...selection.agents];
    const selectedFields = new Set(selection.fields);
    const save = () => workspace.edit(next => { next.writing ??= {}; next.writing.agentProcessing = { agents: [...selectedAgents], fields: [...selectedFields] }; });
    main.append(element('h3', '', 'Post-process fields with agents'), element('p', 'creator-muted', 'Choose agents from your library, then the fields to revise. Agents run in the order you choose, one field or greeting at a time. Each agent receives the previous result. Review the changes before applying them.'), element('p', 'creator-muted', 'Uses each agent’s prompt and enabled regex rules. An agent’s own connection is used when set; otherwise it uses Catelier’s connection. Chat triggers, chat history and automatic tool actions are not used here.'));

    const agentBox = element('fieldset', 'creator-fieldset creator-selector-card creator-agent-selector');
    agentBox.append(element('legend', '', 'Agents to use'));

    let searchQuery = '';
    let activeCategory = 'all';
    const agentRows = [];
    const categoryButtons = new Map();

    const searchWrap = element('div', 'creator-field creator-agent-search-field');
    const searchHead = element('div', 'creator-selector-toolbar');
    const searchLabel = element('label', 'creator-field-label', 'Find an agent');
    const searchInputId = 'creator_agent_search_input';
    searchLabel.htmlFor = searchInputId;
    const agentActions = element('div', 'creator-selector-actions');
    const agentSummary = element('span', 'creator-selector-summary');
    const clearAgentsBtn = button('Clear', () => {
        selectedAgents.length = 0;
        for (const row of agentRows) row.input.checked = false;
        if (activeCategory === 'selected') activeCategory = 'all';
        save();
        refreshOrder();
        applyAgentFilter();
    });
    clearAgentsBtn.classList.add('creator-mini-btn');
    clearAgentsBtn.setAttribute('aria-label', 'Clear selected agents');
    agentActions.append(agentSummary, clearAgentsBtn);
    searchHead.append(searchLabel, agentActions);

    const searchInput = element('input', 'text_pole creator-input creator-agent-search');
    searchInput.type = 'search';
    searchInput.id = searchInputId;
    searchInput.placeholder = 'Search agent names';
    searchInput.setAttribute('aria-label', 'Find an agent');
    searchWrap.append(searchHead, searchInput);
    agentBox.append(searchWrap);

    const presentCategories = categoryKeys.filter(cat => sortedAgents.some(agent => getAgentListKind(agent) === cat));
    if (sortedAgents.length > 6 && presentCategories.length > 1) {
        const filterBar = element('div', 'creator-agent-categories');
        filterBar.setAttribute('role', 'toolbar');
        filterBar.setAttribute('aria-label', 'Filter agents by category');
        const makeCatBtn = (key, text) => {
            const btn = button(text, () => {
                activeCategory = key;
                applyAgentFilter();
            });
            btn.classList.add('creator-cat-chip');
            btn.setAttribute('aria-pressed', String(activeCategory === key));
            categoryButtons.set(key, btn);
            filterBar.append(btn);
        };
        makeCatBtn('all', `All (${sortedAgents.length})`);
        makeCatBtn('selected', `Selected (${selectedAgents.length})`);
        for (const cat of presentCategories) {
            const count = sortedAgents.filter(agent => getAgentListKind(agent) === cat).length;
            makeCatBtn(cat, `${AGENT_CATEGORIES[cat]?.label ?? cat} (${count})`);
        }
        agentBox.append(filterBar);
    }

    const order = element('p', 'creator-muted creator-agent-order');
    const choicesScroll = element('div', sortedAgents.length > 10 ? 'creator-agent-grid-scroll' : '');
    const choices = element('div', 'creator-choice-grid creator-agent-grid');
    const emptyFilterNote = element('p', 'creator-muted creator-agent-empty', 'No matching agents.');
    emptyFilterNote.hidden = true;

    const applyAgentFilter = () => {
        const query = searchQuery.trim().toLocaleLowerCase();
        let visibleCount = 0;
        for (const row of agentRows) {
            const matchesQuery = !query || row.nameLower.includes(query);
            const matchesCat = activeCategory === 'all'
                || (activeCategory === 'selected' ? selectedAgents.includes(row.id) : row.category === activeCategory);
            const show = matchesQuery && matchesCat;
            row.label.hidden = !show;
            row.label.style.display = show ? '' : 'none';
            if (show) visibleCount += 1;
        }
        for (const [key, btn] of categoryButtons.entries()) {
            btn.setAttribute('aria-pressed', String(activeCategory === key));
        }
        emptyFilterNote.hidden = !sortedAgents.length || visibleCount > 0;
    };

    const refreshOrder = () => {
        const count = selectedAgents.length;
        agentSummary.textContent = count ? `${count} selected` : `${sortedAgents.length} available`;
        clearAgentsBtn.disabled = count === 0;
        const selectedChip = categoryButtons.get('selected');
        if (selectedChip) selectedChip.textContent = `Selected (${count})`;
        order.textContent = count
            ? `Order: ${selectedAgents.map(id => agents.find(agent => agent.id === id)?.name ?? 'Unavailable agent').join(' → ')}`
            : 'No agents selected.';
        order.classList.toggle('is-active', count > 0);
        for (const row of agentRows) {
            const stepIndex = selectedAgents.indexOf(row.id);
            row.label.classList.toggle('is-selected', stepIndex >= 0);
            if (stepIndex >= 0) {
                row.badge.textContent = String(stepIndex + 1);
                row.badge.hidden = false;
            } else {
                row.badge.textContent = '';
                row.badge.hidden = true;
            }
        }
    };

    searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        applyAgentFilter();
    });

    for (const agent of sortedAgents) {
        const label = element('label', 'creator-choice-pill creator-agent-pill');
        const input = element('input');
        input.type = 'checkbox';
        input.checked = selectedAgents.includes(agent.id);
        input.setAttribute('aria-label', agent.name);
        const textSpan = element('span', 'creator-choice-label', agent.name);
        const badge = element('span', 'creator-agent-step-badge');
        badge.setAttribute('aria-hidden', 'true');
        badge.hidden = true;
        input.addEventListener('change', () => {
            if (input.checked) {
                if (!selectedAgents.includes(agent.id)) selectedAgents.push(agent.id);
            } else {
                const idx = selectedAgents.indexOf(agent.id);
                if (idx >= 0) selectedAgents.splice(idx, 1);
            }
            save();
            refreshOrder();
            if (activeCategory === 'selected') applyAgentFilter();
        });
        label.append(input, textSpan, badge);
        choices.append(label);
        agentRows.push({ id: agent.id, nameLower: String(agent.name ?? '').toLocaleLowerCase(), category: getAgentListKind(agent), label, input, badge });
    }
    if (!sortedAgents.length) choices.append(element('p', 'creator-muted', 'Add or import agents in Agents, then return here.'));
    refreshOrder();
    applyAgentFilter();
    choicesScroll.append(choices, emptyFilterNote);
    agentBox.append(order, choicesScroll);
    main.append(agentBox);

    const fields = element('fieldset', 'creator-fieldset creator-selector-card creator-postprocess-fields');
    fields.append(element('legend', '', 'Fields to post-process'));
    const allTargets = creatorAgentTargets(draft).map(target => {
        const isLocked = draft.locks.includes(target.field);
        const isEmpty = !target.text.trim();
        const isDisabled = isLocked || isEmpty;
        const targetLabel = target.index === undefined ? (labels[target.field] ?? target.field) : `Alternate greeting ${target.index + 1}`;
        return { ...target, isLocked, isEmpty, isDisabled, targetLabel };
    });
    const readyTargets = allTargets.filter(target => !target.isDisabled);
    const readyCoreTargets = readyTargets.filter(target => target.index === undefined);
    const readyGreetingTargets = readyTargets.filter(target => target.index !== undefined);
    const disabledTargets = allTargets.filter(target => target.isDisabled);
    const fieldInputs = [];

    const fieldToolbar = element('div', 'creator-selector-toolbar');
    const fieldSummary = element('span', 'creator-selector-summary');
    const fieldActions = element('div', 'creator-selector-actions');
    const selectReadyBtn = button('All ready', () => {
        for (const item of fieldInputs) {
            if (!item.target.isDisabled) {
                selectedFields.add(item.target.key);
                item.input.checked = true;
            }
        }
        save();
        refreshFieldSummary();
    });
    selectReadyBtn.classList.add('creator-mini-btn');
    selectReadyBtn.setAttribute('aria-label', 'Select all ready fields');
    const clearFieldsBtn = button('Clear', () => {
        selectedFields.clear();
        for (const item of fieldInputs) item.input.checked = false;
        save();
        refreshFieldSummary();
    });
    clearFieldsBtn.classList.add('creator-mini-btn');
    clearFieldsBtn.setAttribute('aria-label', 'Clear selected fields');
    fieldActions.append(selectReadyBtn, clearFieldsBtn);
    fieldToolbar.append(fieldSummary, fieldActions);
    fields.append(fieldToolbar);

    const refreshFieldSummary = () => {
        const readySelected = readyTargets.filter(target => selectedFields.has(target.key)).length;
        fieldSummary.textContent = readyTargets.length
            ? `${readySelected} of ${readyTargets.length} ready selected`
            : 'No filled fields ready';
        selectReadyBtn.disabled = !readyTargets.length || readySelected === readyTargets.length;
        clearFieldsBtn.disabled = selectedFields.size === 0;
    };

    const buildFieldPill = target => {
        const label = element('label', 'creator-choice-pill creator-field-pill');
        const input = element('input');
        input.type = 'checkbox';
        input.checked = selectedFields.has(target.key);
        input.disabled = target.isDisabled;
        input.setAttribute('aria-label', target.targetLabel);
        input.addEventListener('change', () => {
            if (input.checked) selectedFields.add(target.key);
            else selectedFields.delete(target.key);
            save();
            refreshFieldSummary();
        });
        const textSpan = element('span', 'creator-choice-label', target.targetLabel);
        label.append(input, textSpan);
        if (target.isLocked) {
            const meta = element('span', 'creator-choice-meta', 'Locked');
            meta.setAttribute('aria-hidden', 'true');
            label.append(meta);
        }
        fieldInputs.push({ target, input });
        return label;
    };

    if (readyCoreTargets.length) {
        const coreGrid = element('div', 'creator-choice-grid creator-choice-grid--fields');
        for (const target of readyCoreTargets) coreGrid.append(buildFieldPill(target));
        fields.append(coreGrid);
    }
    if (readyGreetingTargets.length) {
        const greetingGroup = element('div', 'creator-choice-subgroup');
        greetingGroup.append(element('span', 'creator-choice-subheading', `Alternate greetings (${readyGreetingTargets.length})`));
        const greetingGrid = element('div', 'creator-choice-grid creator-choice-grid--greetings');
        for (const target of readyGreetingTargets) greetingGrid.append(buildFieldPill(target));
        greetingGroup.append(greetingGrid);
        fields.append(greetingGroup);
    }
    if (disabledTargets.length) {
        const disabledGroup = element('div', 'creator-choice-subgroup creator-choice-subgroup--disabled');
        disabledGroup.append(element('p', 'creator-muted creator-choice-disabled-note', 'Empty or locked fields cannot be selected.'));
        const disabledGrid = element('div', 'creator-choice-grid creator-choice-grid--disabled');
        for (const target of disabledTargets) disabledGrid.append(buildFieldPill(target));
        disabledGroup.append(disabledGrid);
        fields.append(disabledGroup);
    } else {
        fields.append(element('p', 'creator-muted creator-choice-disabled-note', 'Empty or locked fields cannot be selected.'));
    }
    refreshFieldSummary();
    main.append(fields);
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
