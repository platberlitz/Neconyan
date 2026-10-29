import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import {
    AGENT_TEMPLATE_CONFLICT_GROUPS,
    TARO_GUIDE_BUDGETS,
    TARO_GUIDE_MAX_NEW_PICKS,
    TARO_GUIDE_QUESTIONS,
    chooseInstalledCopy,
    copiesForTemplate,
    createDefaultTaroGuideAnswers,
    getAgentRequestCost,
    getAgentRequestCostLabel,
    getTaroUndoBlockReason,
    isAutomaticRequestCost,
    isTerminalTaroUndoError,
    mergePickSelection,
    normalizeTaroGuideAnswers,
    recommendAgents,
} from '../public/scripts/extensions/in-chat-agents/agent-recommendations.js';

const templates = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url), 'utf8'));
const templateById = new Map(templates.map(template => [template.id, template]));
const names = result => result.picks.map(pick => pick.name);
const skippedNames = result => result.skipped.map(entry => entry.name);

function agentFrom(templateId, overrides = {}) {
    const template = templateById.get(templateId);
    return {
        ...structuredClone(template),
        id: `agent-${templateId}-${overrides.order ?? 0}-${Math.random().toString(36).slice(2)}`,
        name: template.name,
        sourceTemplateId: template.id,
        enabled: false,
        injection: { ...(template.injection ?? {}), order: overrides.order ?? 10 },
        ...overrides,
    };
}

function recommend(answers, context = {}) {
    return recommendAgents(answers, { templates, agents: [], ...context });
}

describe('Taro agent recommendations', () => {
    test('every rule and conflict points at a bundled template that still exists', () => {
        const required = [
            'tpl-dont-write-for-user', 'tpl-user-agency-guard', 'tpl-repeat-spotter', 'tpl-repetition-breaker',
            'tpl-pace-setter', 'tpl-length-trimmer', 'tpl-scene-tracker', 'tpl-status-tracker', 'tpl-item-tracker',
            'tpl-continuity-pins', 'tpl-continuity-corrector', 'tpl-character-authenticity', 'tpl-friction-mode',
            'tpl-friction-keeper', 'tpl-proofreader', 'tpl-dialogue-humaniser', 'tpl-format-fixer',
            'tpl-prompt-adherence-checker', 'tpl-knowledge-guard', 'tpl-intent-reader', 'tpl-nsfw-enhancer',
            'tpl-cyoa-choices-skill-checks', 'tpl-direction-menu', 'tpl-vitals-companion', 'tpl-time-tracker',
            'tpl-relationship-tracker', 'tpl-npc-profiles', 'tpl-parallel-tracker', 'tpl-event-tracker',
            'tpl-position-tracker-companion', 'tpl-visual-map-companion',
        ];
        for (const id of required) expect(templateById.has(id)).toBe(true);
        const conflictIds = AGENT_TEMPLATE_CONFLICT_GROUPS.flatMap(group => [...(group.ids ?? []), ...(group.hub ? [group.hub] : [])]);
        for (const id of conflictIds) expect(templateById.has(id)).toBe(true);
        expect(TARO_GUIDE_QUESTIONS).toHaveLength(4);
        expect(TARO_GUIDE_BUDGETS.free.label).toBe('No extra requests');
        expect(TARO_GUIDE_BUDGETS.light.label).toBe('Up to two extra-request agents');
        expect(TARO_GUIDE_BUDGETS.any.label).toBe('No limit');
    });

    test('reads extra-request cost from the installed shape', () => {
        expect(getAgentRequestCost(templateById.get('tpl-proofreader'))).toBe('after');
        expect(getAgentRequestCost(templateById.get('tpl-intent-reader'))).toBe('before');
        expect(getAgentRequestCost(templateById.get('tpl-position-tracker-companion'))).toBe('after');
        expect(getAgentRequestCost(templateById.get('tpl-vitals-companion'))).toBe('after');
        expect(getAgentRequestCost(templateById.get('tpl-scene-tracker'))).toBe('free');
        expect(getAgentRequestCost(templateById.get('tpl-cyoa-choices-skill-checks'))).toBe('free');
        expect(getAgentRequestCost(templateById.get('tpl-friction-mode'))).toBe('free');
        expect(getAgentRequestCost(templateById.get('tpl-actor-interview-companion'))).toBe('manual');
        expect(isAutomaticRequestCost('manual')).toBe(false);
        expect(isAutomaticRequestCost('before')).toBe(true);
        expect(getAgentRequestCost({ preProcess: { mode: 'intercept', interceptTiming: 'post-main-generation' } })).toBe('after');
        expect(getAgentRequestCostLabel('before')).toContain('before the reply');
        expect(getAgentRequestCostLabel('manual')).toContain('press Run');
        expect(getAgentRequestCostLabel('free')).toContain('no extra request');
        expect(TARO_GUIDE_BUDGETS.light.help).not.toContain('model calls');
        expect(TARO_GUIDE_BUDGETS.free.help).toContain('manual Run');
    });

    test('normalizes hostile saved answers and ignores unknown values', () => {
        const hostile = JSON.parse('{"styles":["roleplay","Roleplay","nope",null,{}],"fixes":"agency","extras":["map","map","__proto__"],"budget":"unlimited","explicit":"yes","__proto__":{"polluted":true}}');
        expect(normalizeTaroGuideAnswers(hostile)).toEqual({
            version: 1,
            styles: ['roleplay'],
            fixes: [],
            extras: ['map'],
            explicit: false,
            budget: 'light',
        });
        expect(normalizeTaroGuideAnswers(null)).toEqual(createDefaultTaroGuideAnswers());
        expect(normalizeTaroGuideAnswers('nope')).toEqual(createDefaultTaroGuideAnswers());
        expect(normalizeTaroGuideAnswers({ budget: 'ANY', styles: ['ADVENTURE'] })).toEqual({
            ...createDefaultTaroGuideAnswers(),
            budget: 'any',
            styles: ['adventure'],
        });
    });

    test('No extra requests picks only prompt-only agents and reports blocked fixes honestly', () => {
        const free = recommend({ fixes: ['agency', 'pushback', 'continuity'], budget: 'free' });
        expect(names(free)).toEqual(expect.arrayContaining(['Don\'t Write for User', 'Friction Mode', 'Scene Tracker', 'Status Tracker']));
        expect(free.picks.every(pick => pick.cost === 'free')).toBe(true);
        expect(free.budget.newExtraCount).toBe(0);

        const blocked = recommend({ fixes: ['repeat', 'length', 'voice', 'prose', 'format', 'rules', 'knowledge', 'intent'], budget: 'free' });
        expect(blocked.picks).toHaveLength(0);
        expect(skippedNames(blocked)).toEqual(expect.arrayContaining([
            'Repeat Spotter', 'Pace Setter', 'Character Authenticity Checker', 'Proofreader',
            'Format Fixer', 'Prompt Adherence Checker', 'Knowledge Guard', 'Intent Reader',
        ]));
        expect(blocked.skipped.every(entry => /extra request/.test(entry.reason))).toBe(true);
        expect(blocked.notes.join(' ')).toContain('Some answers need an agent');
    });

    test('the light budget allows two new extra-request agents, in stable order, including existing ones', () => {
        const result = recommend({ fixes: ['repeat', 'length', 'prose'], budget: 'light' });
        expect(names(result)).toEqual(['Repeat Spotter', 'Pace Setter']);
        expect(result.picks.every(pick => pick.needsCreate)).toBe(true);
        expect(result.budget.newExtraCount).toBe(2);
        expect(result.budget.remainingExtraRequests).toBe(2);
        expect(result.skipped.find(entry => entry.name === 'Proofreader')).toMatchObject({
            reason: expect.stringContaining('two extra-request slots'),
        });

        const anyRepeat = recommend({ fixes: ['repeat', 'length'], budget: 'any' });
        expect(names(anyRepeat)).toEqual(['Repetition Breaker', 'Length Trimmer']);

        const existing = [
            agentFrom('tpl-proofreader', { enabled: true }),
            agentFrom('tpl-direction-menu', { enabled: true }),
        ];
        const full = recommend({ fixes: ['voice'], budget: 'light' }, { agents: existing });
        expect(full.picks).toHaveLength(0);
        expect(full.budget.activeExtraCount).toBe(2);
        expect(full.budget.remainingExtraRequests).toBe(0);
        expect(full.skipped.find(entry => entry.name === 'Character Authenticity Checker').reason).toContain('Both extra-request slots');
        expect(full.notes.join(' ')).toContain('does not switch any of them off');
    });

    test('a customised installed copy overrides the template cost', () => {
        const customised = agentFrom('tpl-proofreader', {
            enabled: false,
            postProcess: { ...templateById.get('tpl-proofreader').postProcess, promptTransformEnabled: false },
        });
        const result = recommend({ fixes: ['prose'], budget: 'free' }, { agents: [customised] });
        expect(names(result)).toEqual(['Proofreader']);
        expect(result.picks[0]).toMatchObject({ cost: 'free', needsCreate: false, agentId: customised.id });
    });

    test('multiple copies prefer an enabled copy, then the lowest order', () => {
        const enabled = agentFrom('tpl-proofreader', { enabled: true, order: 90 });
        const lower = agentFrom('tpl-proofreader', { enabled: false, order: 10 });
        const already = recommend({ fixes: ['prose'], budget: 'light' }, { agents: [enabled, lower] });
        expect(already.picks).toHaveLength(0);
        expect(already.alreadyOn[0]).toMatchObject({ name: 'Proofreader', agentId: enabled.id });

        const first = agentFrom('tpl-proofreader', { enabled: false, order: 40 });
        const second = agentFrom('tpl-proofreader', { enabled: false, order: 5 });
        const choose = recommend({ fixes: ['prose'], budget: 'light' }, { agents: [first, second] });
        expect(choose.picks[0]).toMatchObject({ name: 'Proofreader', agentId: second.id, needsCreate: false });
    });

    test('matching ignores a wrong-source name match and breaks order ties by id', () => {
        const source = agentFrom('tpl-proofreader', { enabled: false, order: 20 });
        const wrongSource = agentFrom('tpl-proofreader', {
            enabled: true,
            order: 1,
            sourceTemplateId: 'tpl-custom-lookalike',
            name: 'Proofreader',
        });
        const copies = copiesForTemplate([wrongSource, source], templateById.get('tpl-proofreader'));
        expect(copies.map(agent => agent.id)).toEqual([source.id]);
        expect(chooseInstalledCopy(copies, () => false)).toBe(source);

        const first = agentFrom('tpl-proofreader', { enabled: false, order: 30 });
        first.id = 'b-copy';
        const second = agentFrom('tpl-proofreader', { enabled: false, order: 30 });
        second.id = 'a-copy';
        expect(chooseInstalledCopy([first, second], () => false)).toBe(second);

        const picked = recommend({ fixes: ['prose'], budget: 'light' }, { agents: [wrongSource, source] });
        expect(picked.picks[0]).toMatchObject({ name: 'Proofreader', agentId: source.id });
        expect(picked.alreadyOn).toHaveLength(0);
    });

    test('manual companions use a manual cost label and do not consume automatic request slots', () => {
        const manual = agentFrom('tpl-actor-interview-companion', { enabled: true });
        expect(getAgentRequestCost(manual)).toBe('manual');
        const result = recommend({ fixes: ['voice'], budget: 'light' }, { agents: [manual] });
        expect(names(result)).toEqual(['Character Authenticity Checker']);
        expect(result.budget.activeExtraCount).toBe(0);
        expect(result.budget.newExtraCount).toBe(1);
        expect(result.budget.remainingExtraRequests).toBe(2);
    });

    test('recalculation keeps a cleared pick cleared and checks only new picks', () => {
        const previousKnown = ['a', 'b'];
        const picks = [{ templateId: 'a' }, { templateId: 'b' }, { templateId: 'c' }];
        expect([...mergePickSelection({ previousSelection: [], previousKnown, picks })]).toEqual(['c']);
        expect([...mergePickSelection({ previousSelection: ['a'], previousKnown, picks })]).toEqual(['a', 'c']);
        expect([...mergePickSelection({ previousSelection: [], previousKnown, picks, resetSelection: true })]).toEqual(['a', 'b', 'c']);
    });

    test('undo guards distinguish a moved scope from a network retry', () => {
        expect(getTaroUndoBlockReason({ workspaceCurrent: false, scope: 'individual', expectedScope: 'individual' })).toContain('chat changed');
        expect(getTaroUndoBlockReason({ workspaceCurrent: true, scope: 'group', expectedScope: 'individual' })).toContain('chat type changed');
        expect(getTaroUndoBlockReason({ workspaceCurrent: true, scope: 'individual', expectedScope: 'individual', guardCurrent: false })).toContain('changed elsewhere');
        expect(getTaroUndoBlockReason({ workspaceCurrent: true, scope: 'individual', expectedScope: 'individual' })).toBe('');
        expect(isTerminalTaroUndoError('The chat changed. Open Taro\'s guide again.')).toBe(true);
        expect(isTerminalTaroUndoError('One of these agents changed elsewhere.')).toBe(true);
        expect(isTerminalTaroUndoError('Failed to fetch')).toBe(false);
        expect(isTerminalTaroUndoError('The switches could not be saved. Try again.')).toBe(false);
    });

    test('already-on conflicts take precedence and never switch anything off', () => {
        const beatPlanner = recommend({ fixes: ['intent'], budget: 'any' }, {
            agents: [agentFrom('tpl-beat-planner', { enabled: true })],
        });
        expect(names(beatPlanner)).not.toContain('Intent Reader');
        expect(beatPlanner.skipped.find(entry => entry.name === 'Intent Reader').reason).toContain('Beat Planner');

        const visualMap = recommend({ extras: ['map'], budget: 'any' }, {
            agents: [agentFrom('tpl-visual-map-companion', { enabled: true })],
        });
        expect(names(visualMap)).not.toContain('Position Tracker');
        expect(visualMap.skipped.find(entry => entry.name === 'Position Tracker').reason).toContain('Visual Map');

        const frictionKeeper = recommend({ fixes: ['pushback'], budget: 'free' }, {
            agents: [agentFrom('tpl-friction-keeper', { enabled: true })],
        });
        expect(names(frictionKeeper)).not.toContain('Friction Mode');
        expect(frictionKeeper.skipped.find(entry => entry.name === 'Friction Mode').reason).toContain('Friction Keeper');

        const directionMenu = recommend({ styles: ['adventure'], budget: 'any' }, {
            agents: [agentFrom('tpl-direction-menu', { enabled: true })],
        });
        expect(names(directionMenu)).not.toContain('CYOA Choices with Skill Checks');
        expect(names(directionMenu)).toEqual(expect.arrayContaining(['Item Tracker', 'Event Tracker']));
    });

    test('continuity falls back to trackers when they already cover the facts', () => {
        const pins = recommend({ fixes: ['continuity'], budget: 'light' });
        expect(names(pins)).toEqual(['Continuity Pins']);
        expect(pins.picks[0].cost).toBe('before');

        const covered = recommend({ fixes: ['continuity'], budget: 'light' }, {
            agents: [agentFrom('tpl-scene-tracker', { enabled: true })],
        });
        expect(names(covered)).not.toContain('Continuity Pins');
        expect(names(covered)).toEqual(['Status Tracker']);
        expect(covered.alreadyOn.map(entry => entry.name)).toEqual(['Scene Tracker']);
    });

    test('adventure, romance, big cast and extras map to their real templates', () => {
        const adventure = recommend({ styles: ['adventure'], extras: ['choices'], budget: 'light' });
        expect(names(adventure)).toEqual(expect.arrayContaining(['CYOA Choices with Skill Checks', 'Item Tracker', 'Event Tracker']));
        expect(names(adventure)).not.toContain('Direction Menu');

        const romance = recommend({ styles: ['romance'], extras: ['bonds'], budget: 'light' });
        expect(names(romance)).toEqual(['Relationship Tracker']);
        expect(romance.picks[0].reasons).toHaveLength(2);

        const bigcast = recommend({ styles: ['bigcast'], budget: 'light' });
        expect(names(bigcast)).toEqual(expect.arrayContaining(['NPC Profile Cards', 'Parallel Off-Screen']));

        const offscreen = recommend({ extras: ['offscreen'], budget: 'light' }, {
            agents: [agentFrom('tpl-parallel-tracker', { enabled: true })],
        });
        expect(offscreen.alreadyOn.map(entry => entry.name)).toEqual(['Parallel Off-Screen']);
    });

    test('explicit scenes are opt-in only and respect the budget', () => {
        expect(names(recommend({ budget: 'any' }))).not.toContain('NSFW Enhancer');
        expect(names(recommend({ explicit: true, budget: 'any' }))).toEqual(['NSFW Enhancer']);
        const free = recommend({ explicit: true, budget: 'free' });
        expect(free.picks).toHaveLength(0);
        expect(free.skipped[0]).toMatchObject({ name: 'NSFW Enhancer', reason: expect.stringContaining('extra request') });
    });

    test('a missing bundled template is skipped with an honest reason', () => {
        const without = templates.filter(template => template.id !== 'tpl-dont-write-for-user');
        const result = recommendAgents({ fixes: ['agency'], budget: 'free' }, { templates: without, agents: [] });
        expect(result.picks).toHaveLength(0);
        expect(result.skipped[0].reason).toContain('not in the bundled library');
    });

    test('roleplay explains that it needs no extra agent', () => {
        const result = recommend({ styles: ['roleplay'], budget: 'light' });
        expect(result.picks).toHaveLength(0);
        expect(result.notes.join(' ')).toContain('Roleplay needs no extra agent');
    });

    test('caps new picks at six and stays deterministic', () => {
        const answers = {
            styles: ['roleplay', 'adventure', 'romance', 'bigcast'],
            fixes: TARO_GUIDE_QUESTIONS[1].options.map(option => option.value),
            extras: TARO_GUIDE_QUESTIONS[2].options.map(option => option.value),
            explicit: true,
            budget: 'any',
        };
        const first = recommend(answers);
        const second = recommend(answers);
        expect(first.picks).toHaveLength(TARO_GUIDE_MAX_NEW_PICKS);
        expect(first.picks.map(pick => pick.templateId)).toEqual(second.picks.map(pick => pick.templateId));
        expect(new Set(first.picks.map(pick => pick.templateId)).size).toBe(TARO_GUIDE_MAX_NEW_PICKS);
        expect(first.skipped.length).toBeGreaterThan(0);
        expect(first.skipped.some(entry => entry.reason.includes('Only 6 new agents'))).toBe(true);
    });

    test('a budget with no new extra slots still allows prompt-only picks', () => {
        const existing = [agentFrom('tpl-proofreader', { enabled: true }), agentFrom('tpl-direction-menu', { enabled: true })];
        const result = recommend({ extras: ['scene'], budget: 'light' }, { agents: existing });
        expect(names(result)).toEqual(['Scene Tracker', 'Time Tracker']);
        expect(result.picks.every(pick => pick.cost === 'free')).toBe(true);
        expect(result.budget.activeExtraCount).toBe(2);
    });
});
