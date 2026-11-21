import { getActiveCompanionResults, getPlotCompassOpeningNote, isDiceRollerAgent, isEmptyOutputSentinel, isPlotCompassAgent, normalizeCompanionMacroSyntax, selectCompanionChatHistory } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { buildDiceDirective, findDiceRollsForGeneration } from '../../public/scripts/extensions/in-chat-agents/companion/dice.js';
import { buildTrackerEchoGuard, getActiveCompanionTrackerLineKeys, getActiveInlineTrackerLineKeys, getActiveInlineTrackerTags, getOwnedCompanionTrackerLineKeys, getOwnedCompanionTrackerShape, getVisibleCompanionTrackerLineKeys } from '../../public/scripts/extensions/in-chat-agents/companion/companion-tracker-context.js';
import { isNativeCompanion } from './agent-definition.js';

const OUTPUT_LINE_KEY_SCAN_DEPTH = 12;

export function resolveSavedCompanionText(content, host, snapshot, environment) {
    const names = environment.names;
    environment.names = { ...names, char: (!host.is_user && String(host.name ?? '').trim()) || names.char };
    try {
        return String(environment.evaluate(normalizeCompanionMacroSyntax(content), {
            legacy: !snapshot.experimentalMacroEngine, strictCapabilities: true, original: host.is_system ? '' : host.mes,
        }) ?? '').trim();
    } finally { environment.names = names; }
}

/** Line formats an active companion has written lately, so custom formats its prompt only implies are still owned. */
function collectRecentCompanionOutputLineKeys(active, messages) {
    const companions = new Map(active.filter(isNativeCompanion).map(agent => [agent.id, agent])), keys = new Set();
    for (let index = messages.length - 1, seen = 0; index >= 0 && seen < OUTPUT_LINE_KEY_SCAN_DEPTH; index--, seen++) {
        for (const [id, result] of Object.entries(getActiveCompanionResults(messages[index]))) {
            const agent = companions.get(id);
            if (!agent || result?.status !== 'done' || !result.content?.trim()) continue;
            for (const key of getOwnedCompanionTrackerLineKeys(agent, result.content)) keys.add(key);
        }
    }
    return keys;
}

/** Saved feedback and retained notes have separate ownership and must never be injected twice. */
export function prepareCompanionFeedback(active, historyAgents, records, snapshot, environment, policies, generationType) {
    const hidden = new Set(snapshot.agents.hiddenIds ?? []);
    const messages = records.slice(1).filter(message => !(generationType === 'continue' && message === records.at(-1)));
    const owners = new Map([...historyAgents, ...active].map(agent => [agent.id, agent]));
    const inlineTags = getActiveInlineTrackerTags(active), shapes = new Map(), feedback = [];
    const inlineLineKeys = getActiveInlineTrackerLineKeys(active), lineKeys = new Set();
    const rememberShape = (agent, body) => {
        const shape = agent && getOwnedCompanionTrackerShape(agent, body);
        if (shape && !inlineTags.has(shape.tag)) shapes.set(shape.tag, shape.shape);
        const visible = agent ? getVisibleCompanionTrackerLineKeys(agent, body, inlineLineKeys) : new Set();
        for (const key of visible) lineKeys.add(key);
        return (shape && !inlineTags.has(shape.tag)) || visible.size > 0;
    };
    const diceExtensions = [];
    for (const agent of active.filter(isDiceRollerAgent)) {
        if (hidden.has(agent.id)) continue;
        const roll = findDiceRollsForGeneration(records.slice(1), generationType);
        if (!roll.rolls.length) continue;
        const prompt = String(environment.evaluate(normalizeCompanionMacroSyntax(agent.prompt), {
            legacy: !snapshot.experimentalMacroEngine,
            strictCapabilities: true,
            original: roll.message?.is_system ? '' : String(roll.message?.mes ?? ''),
        }) ?? '').trim();
        const content = buildDiceDirective(roll.rolls, environment.names?.user, prompt);
        if (!content) continue;
        diceExtensions.push({ key: `inchat_agent_companion_${agent.id}`, content,
            position: agent.injection.position, depth: agent.injection.depth, role: ['system', 'user', 'assistant'][agent.injection.role], scan: agent.injection.scan });
    }
    for (const agent of active) {
        if (!isNativeCompanion(agent) || hidden.has(agent.id) || !agent.companion.feedback.enabled) continue;
        const selected = [];
        for (let index = messages.length - 1; index >= 0 && selected.length < agent.companion.feedback.depth; index--) {
            const host = messages[index], result = getActiveCompanionResults(host)[agent.id];
            if ((host.is_user && !isPlotCompassAgent(agent)) || result?.status !== 'done' || (result.includeInChatHistory === true && !host.is_user) || !result.content?.trim() || isEmptyOutputSentinel(result.content)) continue;
            selected.unshift(resolveSavedCompanionText(result.content, host, snapshot, environment));
        }
        const opening = isPlotCompassAgent(agent) && getPlotCompassOpeningNote(records[0]?.chat_metadata, agent.id);
        if (opening && selected.length < agent.companion.feedback.depth && !isEmptyOutputSentinel(opening.content)) {
            selected.unshift(resolveSavedCompanionText(opening.content, { is_system: true }, snapshot, environment));
        }
        const body = selected.filter(Boolean).join('\n\n');
        if (body) feedback.push({ agent, body, guarded: rememberShape(agent, body) });
    }
    const retained = selectCompanionChatHistory(messages, { policies });
    for (const [host, ids] of retained) {
        const results = getActiveCompanionResults(host);
        for (const id of ids) rememberShape(owners.get(id), resolveSavedCompanionText(results[id].content, host, snapshot, environment));
    }
    const guarded = shapes.size > 0 || lineKeys.size > 0;
    let guardIncluded = false;
    const extensions = [...diceExtensions, ...feedback.map(({ agent, body, guarded: owns }) => {
        const guard = owns && !guardIncluded ? buildTrackerEchoGuard(shapes, lineKeys) + '\n\n' : '';
        guardIncluded ||= owns;
        return { key: `inchat_agent_companion_${agent.id}`, content: `[${agent.name || 'Companion'} - auxiliary notes]\n${guard}${body}`,
            position: agent.injection.position, depth: agent.injection.depth, role: ['system', 'user', 'assistant'][agent.injection.role], scan: agent.injection.scan };
    })];
    if (guarded && !guardIncluded) extensions.push({ key: 'inchat_agent_companion_tracker_echo_guard', content: buildTrackerEchoGuard(shapes, lineKeys), position: 1, depth: 0, role: 'system', scan: false });
    const trackerLineKeys = getActiveCompanionTrackerLineKeys(active, [...lineKeys, ...collectRecentCompanionOutputLineKeys(active, messages)]);
    return { extensions, trackerTags: [...shapes.keys()], trackerLineKeys: [...trackerLineKeys] };
}
