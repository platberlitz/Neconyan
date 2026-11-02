/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_DICE_PROMPT,
    OUTCOMES,
    ROLL_MODES,
    buildDiceDirective,
    cleanAction,
    findDiceRollsForGeneration,
    findRollMessageForGeneration,
    formatRollLine,
    getGenerationChat,
    getOutcome,
    getTargetForDifficulty,
    parseRollLines,
    resolveTarget,
    rollDice,
} from '../public/scripts/extensions/in-chat-agents/companion/dice.js';
import { isDiceRollerAgent } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import {
    buildDiceCompanionCardHtml,
    buildDiceCompanionHostHtml,
    captureDiceCompanionWidget,
    getDiceRunHint,
    restoreDiceCompanionWidget,
} from '../public/scripts/extensions/in-chat-agents/companion/dice-companion-view.js';
import { getAgentRequestCost } from '../public/scripts/extensions/in-chat-agents/agent-recommendations.js';

const readRepoFile = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

function sequence(...faces) {
    let index = 0;
    return sides => () => {
        const face = faces[index % faces.length];
        index += 1;
        return (face - 1) / sides + 0.0001;
    };
}

describe('dice roller rules', () => {
    test('difficulty presets scale with the dice in use', () => {
        expect(['easy', 'normal', 'hard', 'extreme'].map(difficulty => getTargetForDifficulty({ sides: 20, count: 1, modifier: 0, difficulty })))
            .toEqual([9, 12, 15, 18]);
        expect(getTargetForDifficulty({ sides: 6, count: 2, modifier: 1, difficulty: 'normal' })).toBe(8);
        expect(resolveTarget({ sides: 20, count: 1, modifier: 0, difficulty: 'custom', customTarget: 99 })).toBe(21);
        expect(resolveTarget({ sides: 20, count: 1, modifier: 0, difficulty: 'custom', customTarget: 7 })).toBe(7);
    });

    test('outcomes cover criticals, success, partial success and failure', () => {
        const base = { sides: 20, count: 1, target: 12 };
        expect(getOutcome({ ...base, dice: [20], total: 20 })).toBe(OUTCOMES.CRITICAL_SUCCESS);
        expect(getOutcome({ ...base, dice: [1], total: 6 })).toBe(OUTCOMES.CRITICAL_FAILURE);
        expect(getOutcome({ ...base, dice: [12], total: 12 })).toBe(OUTCOMES.SUCCESS);
        expect(getOutcome({ ...base, dice: [10], total: 10 })).toBe(OUTCOMES.PARTIAL_SUCCESS);
        expect(getOutcome({ ...base, dice: [8], total: 8 })).toBe(OUTCOMES.FAILURE);
        expect(getOutcome({ ...base, dice: [10], total: 10, partials: false })).toBe(OUTCOMES.FAILURE);
        expect(getOutcome({ ...base, dice: [20], total: 20, criticals: false })).toBe(OUTCOMES.SUCCESS);
    });

    test('rolls keep the better or worse pool for advantage and disadvantage', () => {
        const advantage = rollDice({ sides: 20, count: 1, mode: ROLL_MODES.ADVANTAGE, difficulty: 'normal' }, sequence(5, 16)(20));
        expect(advantage.dice).toEqual([16]);
        expect(advantage.droppedDice).toEqual([5]);
        expect(advantage.outcome).toBe(OUTCOMES.SUCCESS);

        const disadvantage = rollDice({ sides: 20, count: 1, mode: ROLL_MODES.DISADVANTAGE, difficulty: 'normal' }, sequence(5, 16)(20));
        expect(disadvantage.dice).toEqual([5]);
        expect(disadvantage.outcome).toBe(OUTCOMES.FAILURE);

        const pool = rollDice({ sides: 6, count: 3, modifier: 2, difficulty: 'easy' }, sequence(2, 3, 4)(6));
        expect(pool.dice).toEqual([2, 3, 4]);
        expect(pool.total).toBe(11);
        expect(pool.target).toBe(9);
    });

    test('roll lines round-trip and stay on one tidy line', () => {
        const rolled = rollDice({ sides: 20, count: 1, modifier: 2, difficulty: 'normal', action: 'Pick the lock (quietly) | fast - now.' }, sequence(15)(20));
        const line = formatRollLine(rolled);
        expect(line).toBe('\u{1F3B2} Pick the lock quietly fast, now - rolled 17 vs 12 (1d20+2: 15) - SUCCESS');
        expect(parseRollLines(`I try my luck.\n${line}`)).toEqual([expect.objectContaining({
            action: 'Pick the lock quietly fast, now',
            total: 17,
            target: 12,
            details: '1d20+2: 15',
            outcome: OUTCOMES.SUCCESS,
        })]);

        const bare = formatRollLine({ ...rolled, action: '', outcome: OUTCOMES.PARTIAL_SUCCESS, mode: ROLL_MODES.ADVANTAGE });
        expect(bare).toBe('\u{1F3B2} Rolled 17 vs 12 (1d20+2: 15, advantage) - PARTIAL SUCCESS');
        expect(parseRollLines(bare)[0]).toMatchObject({ action: '', outcome: OUTCOMES.PARTIAL_SUCCESS });
        expect(parseRollLines('rolled 17 vs 12 - SUCCESS')).toEqual([]);
        expect(cleanAction('  Jump\nthe gap!  ')).toBe('Jump the gap');
    });

    test('the directive is short, assertive and keeps numbers out of the reply', () => {
        const directive = buildDiceDirective(parseRollLines('\u{1F3B2} Charm the guard - rolled 3 vs 12 (1d20: 1) - CRITICAL FAILURE'), 'Mira');
        expect(directive).toContain('[Dice result for Mira]');
        expect(directive).toContain('Charm the guard: CRITICAL FAILURE.');
        expect(directive).toContain('fresh problem or danger');
        expect(directive).toContain('settled fact');
        expect(directive).toContain(DEFAULT_DICE_PROMPT);
        expect(directive).not.toMatch(/\d/);
        expect(directive.length).toBeLessThan(420);
        expect(buildDiceDirective([], 'Mira')).toBe('');

        const unnamed = buildDiceDirective(parseRollLines('\u{1F3B2} Rolled 14 vs 12 (1d20: 14) - SUCCESS'), 'Mira');
        expect(unnamed).toContain('The attempt in Mira\'s last message: SUCCESS.');
    });

    test('an edited agent prompt replaces the closing instruction', () => {
        const directive = buildDiceDirective(parseRollLines('\u{1F3B2} Pick the lock - rolled 18 vs 12 (1d20: 18) - SUCCESS'), 'Mira',
            'Write the outcome in {{char}}\'s voice and keep the scene moving.');
        expect(directive).toContain('Write the outcome in {{char}}\'s voice and keep the scene moving.');
        expect(directive).not.toContain(DEFAULT_DICE_PROMPT);
        expect(buildDiceDirective(parseRollLines('\u{1F3B2} Rolled 14 vs 12 (1d20: 14) - SUCCESS'), 'Mira', '   '))
            .toContain(DEFAULT_DICE_PROMPT);
    });

    test('only the newest user message steers a reply', () => {
        const user = { is_user: true, mes: 'roll' };
        const reply = { is_user: false, mes: 'reply' };
        expect(findRollMessageForGeneration([reply, user], 'normal')).toBe(user);
        expect(findRollMessageForGeneration([user, reply], 'normal')).toBeNull();
        expect(findRollMessageForGeneration([user, reply], 'continue')).toBe(user);
        expect(findRollMessageForGeneration([user, reply, reply], 'continue')).toBeNull();
        expect(findRollMessageForGeneration([reply, user], 'impersonate')).toBeNull();
        expect(findRollMessageForGeneration([reply, user], 'quiet')).toBeNull();
    });

    test('server replies read the saved chat the way a browser reply would', () => {
        const user = { is_user: true, mes: 'roll' };
        const reply = { is_user: false, mes: 'reply' };
        const hidden = { is_user: false, is_system: true, mes: 'note' };
        expect(getGenerationChat([reply, user, hidden], 'normal')).toEqual([reply, user]);
        expect(getGenerationChat([user, reply], 'swipe')).toEqual([user]);
        expect(getGenerationChat([user, reply], 'regenerate')).toEqual([user]);
        expect(getGenerationChat([user, reply], 'continue')).toEqual([user, reply]);
        expect(getGenerationChat(undefined, 'normal')).toEqual([]);
        expect(findRollMessageForGeneration(getGenerationChat([user, reply], 'swipe'), 'swipe')).toBe(user);
        expect(findDiceRollsForGeneration([user, reply], 'swipe')).toEqual({
            message: user,
            rolls: [],
        });
    });
});

describe('dice roller companion wiring', () => {
    test('ships as a seeded, switched-off Companion agent in the Companions kit', () => {
        const template = JSON.parse(readRepoFile('public/scripts/extensions/in-chat-agents/templates/dice-roller-companion.json'));
        const catalog = JSON.parse(readRepoFile('public/scripts/extensions/in-chat-agents/templates/index.json'));
        expect(template).toMatchObject({
            id: 'tpl-dice-roller-companion',
            name: 'Dice Roller',
            category: 'companion',
            phase: 'post',
            execution: 'companion',
            enabled: false,
            icon: 'fa-dice-d20',
            companion: {
                trigger: 'manual',
                displayMode: 'panel',
                feedback: { enabled: true, depth: 1 },
            },
            injection: { position: 1, depth: 0, role: 0, order: 115, scan: false },
        });
        expect(template.prompt).toBe(DEFAULT_DICE_PROMPT);
        expect(catalog.find(entry => entry.id === template.id)).toEqual(template);

        const groups = JSON.parse(readRepoFile('public/scripts/extensions/in-chat-agents/templates/groups.json'));
        expect(groups.find(group => group.id === 'grp-companions').agentTemplateIds).toContain(template.id);

        const indexSource = readRepoFile('public/scripts/extensions/in-chat-agents/index.js');
        expect(indexSource).toMatch(/const DEFAULT_BUNDLED_TEMPLATE_IDS = new Set\(\[[\s\S]*?'tpl-dice-roller-companion',[\s\S]*?\]\);/);
        expect(indexSource).toMatch(/const BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS = new Set\(\[[\s\S]*?DICE_ROLLER_TEMPLATE_ID,[\s\S]*?\]\);/);
        expect(indexSource).toContain('void import(\'./companion/dice-roller.js\')');
        expect(existsSync(fileURLToPath(new URL('../public/scripts/extensions/dice-roller', import.meta.url)))).toBe(false);
        expect(readRepoFile('src/endpoints/extensions.js')).not.toContain('\'dice-roller\'');
        expect(readRepoFile('public/scripts/extensions-manager.js')).not.toContain('\'dice-roller\'');
    });

    test('identifies the agent by its template, never by the editable name', () => {
        expect(isDiceRollerAgent({ id: 'renamed', sourceTemplateId: 'tpl-dice-roller-companion', name: 'Chance' })).toBe(true);
        expect(isDiceRollerAgent({ id: 'renamed', name: 'Dice Roller' })).toBe(false);
        expect(isDiceRollerAgent({ id: 'tpl-dice-roller-companion', name: 'Anything' })).toBe(true);
        expect(getAgentRequestCost(JSON.parse(readRepoFile('public/scripts/extensions/in-chat-agents/templates/dice-roller-companion.json')))).toBe('free');
    });

    test('the note card offers the dice host without saved-note actions', () => {
        const host = buildDiceCompanionHostHtml({ agentId: 'dice"1', surface: 'card', messageIndex: 4 });
        expect(host).toContain('data-neco-dice-agent="dice&quot;1"');
        expect(host).toContain('data-neco-dice-surface="card"');
        expect(host).toContain('data-neco-dice-message-index="4"');

        const card = buildDiceCompanionCardHtml({ id: 'dice"1', name: 'Dice <Roller>', icon: 'fa-dice-d20' }, { messageIndex: 4 });
        expect(card).toContain('ica--companion-card--dice');
        expect(card).toContain('Dice &lt;Roller&gt;');
        expect(card).toContain('data-neco-dice-surface="card"');
        expect(card).not.toContain('data-action=');
    });

    test('the live widget keeps its input and focus across a panel or card replacement', () => {
        const input = {
            isConnected: true,
            selectionStart: 3,
            selectionEnd: 8,
            focus: jest.fn(),
            setSelectionRange: jest.fn(),
        };
        const widget = { contains: node => node === input, remove: jest.fn() };
        const oldHost = { dataset: { necoDiceAgent: 'dice-1' }, querySelector: () => widget };
        const root = { querySelector: () => oldHost };
        const previousDocument = globalThis.document;
        globalThis.document = { activeElement: input };
        try {
            const captured = captureDiceCompanionWidget(root);
            expect(widget.remove).toHaveBeenCalledTimes(1);
            expect(captured).toMatchObject({ widget, agentId: 'dice-1', focused: input, selection: [3, 8] });

            const newHost = { dataset: { necoDiceAgent: 'dice-1' }, append: jest.fn() };
            expect(restoreDiceCompanionWidget({ querySelectorAll: () => [newHost] }, captured)).toBe(true);
            expect(newHost.append).toHaveBeenCalledWith(widget);
            expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(input.setSelectionRange).toHaveBeenCalledWith(3, 8);
        } finally {
            globalThis.document = previousDocument;
        }
    });

    test('a roll with no visible widget names the surface that can finish it', () => {
        expect(getDiceRunHint('panel')).toContain('Companion panel');
        expect(getDiceRunHint('card')).toContain('latest reply');
        expect(getDiceRunHint('card')).not.toContain('Companion panel');
        expect(getDiceRunHint('hidden')).not.toContain('Companion panel');
        expect(getDiceRunHint('hidden')).toContain('editor');
    });

    test('the old composer popup and interceptor are gone', () => {
        const runtime = readRepoFile('public/scripts/extensions/in-chat-agents/companion/dice-roller.js');
        const workflows = readRepoFile('public/scripts/neconyan-conversation/roleplay-workflows.js');
        expect(runtime).not.toContain('necoDiceRollerInterceptor');
        expect(runtime).not.toContain('openDicePanel');
        expect(runtime).not.toContain('neco-dice-composer-button');
        expect(runtime).not.toContain('POPUP_TYPE');
        expect(runtime).toContain('Add to message');
        expect(runtime).toContain('Roll options');
        expect(runtime).toContain('diceRoller');
        // Hosts follow explicit render and lifecycle events, never a body-wide class watcher.
        expect(runtime).not.toContain('MutationObserver');
        expect(runtime).toContain('DICE_COMPANION_HOSTS_CHANGED_EVENT');
        expect(workflows).not.toContain('necoDiceRollerInterceptor');
    });

    test('the panel, card and runner know where the local dice live', () => {
        const panel = readRepoFile('public/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        const ui = readRepoFile('public/scripts/extensions/in-chat-agents/companion/companion-ui.js');
        const runner = readRepoFile('public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
        const windows = readRepoFile('public/scripts/extensions/in-chat-agents/companion/companion-windows.js');
        expect(panel).toContain('buildDiceCompanionHostHtml({ agentId, surface: \'panel\' })');
        expect(ui).toContain('buildDiceCompanionCardHtml');
        expect(windows).toContain('buildDiceCompanionHostHtml({ agentId: agent.id, surface: \'window\'');
        expect(runner).toContain('findDiceRollsForGeneration');
        expect(runner).toContain('runDiceCompanionLocally');
        expect(runner).toContain('if (!manual && isLocalCompanionAgent(agent))');
        expect(readRepoFile('src/generation/agent-definition.js')).toContain('if (isDiceRollerAgent(agent)) return false;');
        expect(readRepoFile('src/generation/companion-capacity.js')).toContain('!isDiceRollerAgent(agent)');
        expect(readRepoFile('src/generation/roleplay-companions.js')).toContain('!isDiceRollerAgent(agent)');
        expect(readRepoFile('src/generation/companion-feedback.js')).toContain('buildDiceDirective(roll.rolls');
    });
});
