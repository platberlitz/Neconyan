import { element, button, textField } from './fields.js';
import { creatorProposal } from './model.js';

export const GAME_MODULES = Object.freeze({
    relationships: { title: 'Trust and relationships', initial: { trust: 0 }, rules: 'Change trust only after a concrete action changes the relationship. Give each supporting character independent motives. Never treat trust as consent.' },
    inventory: { title: 'Inventory and currency', initial: { coins: 0, inventory: [] }, rules: 'Record acquisitions, spending, use and transfers. Reject spending more currency or items than the character owns. Preserve who holds each item.' },
    quests: { title: 'Quests and clues', initial: { quests: [], clues: [] }, rules: 'Track objectives, evidence and unresolved questions separately. Reveal clues through observable events, not omniscient disclosure. Never mark an objective complete before its conditions occur.' },
    time: { title: 'Time and stamina', initial: { scene: 0, stamina: 10 }, rules: 'Advance scene time only when an action takes time. Apply fatigue consistently. Describe the consequences before offering a costly action.' },
    factions: { title: 'Factions and reputation', initial: { reputation: {} }, rules: 'Track reputation separately for each faction. Change it only when that faction can learn what happened.' },
    checks: { title: 'Dice checks', initial: { checks: [] }, rules: 'State the check, difficulty and consequences before a roll. Ask the user for a roll or an agreed external dice tool result. Do not invent a random result, reroll a committed result, or change the difficulty afterwards.' },
});

export function createGameState(modules) {
    if (!Array.isArray(modules) || modules.some(key => !Object.hasOwn(GAME_MODULES, key))) throw new Error('Choose supported game modules.');
    return { revision: 0, values: Object.assign({}, ...modules.map(key => structuredClone(GAME_MODULES[key].initial))), events: [] };
}

/** Preview state changes are explicit, bounded and idempotent, including zero values. */
export function applyGameEvent(state, event) {
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 100) throw new Error('Give each state change a unique ID.');
    const previous = state.events.find(item => item.id === event.id);
    if (previous) {
        if (JSON.stringify(previous.event) !== JSON.stringify(event)) throw new Error('That action ID already belongs to a different change.');
        return structuredClone(state);
    }
    if (event.revision !== state.revision) throw new Error('The state changed. Review the action against the current revision.');
    if (!Object.hasOwn(state.values, event.key)) throw new Error('This game module does not define that value.');
    const next = structuredClone(state);
    if (event.operation === 'add') {
        if (!Number.isFinite(next.values[event.key]) || !Number.isFinite(event.value)) throw new Error('Numeric changes need finite numbers.');
        const value = next.values[event.key] + event.value;
        if (!Number.isFinite(value) || (['coins', 'stamina', 'scene'].includes(event.key) && value < 0)) throw new Error('This action would leave an invalid balance.');
        next.values[event.key] = value;
    } else if (event.operation === 'append') {
        if (!Array.isArray(next.values[event.key]) || typeof event.value !== 'string' || event.value.length > 1000) throw new Error('List changes need a short text value.');
        next.values[event.key].push(event.value);
    } else throw new Error('Choose add for a number or append for a list.');
    next.revision++;
    next.events.push({ id: event.id, event: structuredClone(event) });
    if (next.events.length > 100) throw new Error('Reset the simulator before testing more than 100 actions.');
    return next;
}

export function gameRulesPackage(draft) {
    const modules = draft.game?.modules ?? [];
    if (!modules.length) throw new Error('Choose at least one game module.');
    const state = createGameState(modules);
    return [
        'Character game rules',
        ...modules.map(key => `${GAME_MODULES[key].title}: ${GAME_MODULES[key].rules}`),
        'Initial state for a new story only: ' + JSON.stringify(state.values),
        'Keep a concise state ledger in the conversation. Begin from the last accepted ledger, not the initial values. Zero is a valid existing value. An alternative reply starts from the same preceding state; an abandoned alternative does not commit an action. Explain changes with their in-story cause. Ask before resolving ambiguous or contradictory state. These rules describe a narrative game; do not claim a software tracker has validated them.',
        'The character and supporting cast act towards their own goals. Offer meaningful choices without deciding the user’s speech, thoughts or actions. Resolve the chosen action and leave the next decision open.',
        draft.game?.instructions ?? '',
    ].filter(Boolean).join('\n\n');
}

export function renderGameTools(workspace, main) {
    const draft = workspace.session.draft;
    const modules = draft.game?.modules ?? [];
    main.append(element('h3', '', 'Give the story rules to play by'), element('p', 'creator-hint', 'Build a narrative game kit for the character card. The simulator below checks explicit example actions; your chat model follows the published rules, rather than an automatic game-state service.'));
    for (const [key, module] of Object.entries(GAME_MODULES)) {
        const label = element('label', 'creator-choice');
        const check = element('input'); check.type = 'checkbox'; check.checked = modules.includes(key);
        check.addEventListener('change', () => workspace.edit(next => {
            next.game ??= {};
            const current = next.game.modules ?? [];
            next.game.modules = check.checked ? [...current, key] : current.filter(item => item !== key);
            delete next.game.simulation;
        }, true));
        label.append(check, document.createTextNode(module.title)); main.append(label);
    }
    main.append(textField('Custom game rules', draft.game?.instructions ?? '', value => workspace.edit(next => { next.game ??= {}; next.game.instructions = value; })));
    main.append(button('Review game rules for the card', () => workspace.run(async () => {
        const current = workspace.session.draft;
        const rules = gameRulesPackage(current);
        workspace.proposal(creatorProposal(current, { post_history_instructions: [current.card.data.post_history_instructions, rules].filter(Boolean).join('\n\n') }, 'Game rules'), main);
    })));
    main.append(element('h4', '', 'Isolated state simulator'));
    const state = draft.game?.simulation ?? createGameState(modules);
    main.append(element('pre', 'creator-preview', JSON.stringify(state.values, null, 2)));
    let eventText = JSON.stringify({ id: crypto.randomUUID(), revision: state.revision, key: Object.keys(state.values)[0] || 'trust', operation: 'add', value: 1 }, null, 2);
    main.append(textField('Test action', eventText, value => { eventText = value; }), button('Test state change', () => workspace.run(async () => {
        const nextState = applyGameEvent(state, JSON.parse(eventText));
        workspace.edit(next => { next.game ??= {}; next.game.simulation = nextState; }, true);
    })), button('Reset simulator', () => workspace.edit(next => { next.game ??= {}; next.game.simulation = createGameState(next.game.modules ?? []); }, true)));
}
