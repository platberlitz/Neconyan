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
    getSkillCheckOutcome,
    getTargetForDifficulty,
    isSameSkillCheck,
    parseChoiceReferences,
    parseRollLines,
    parseSkillCheck,
    parseSkillChoices,
    resolveTarget,
    rollDice,
    rollSkillCheck,
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
import {
    appendComposerSendAdditions,
    discardComposerSend,
    prepareComposerSend,
    registerComposerSendHook,
} from '../public/scripts/composer-send-hooks.js';

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
        expect(indexSource).toContain('diceRollerStart = import(\'./companion/dice-roller.js\')');
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

    test('auto roll and auto send are options, off by default, and send without touching the message box', () => {
        const runtime = readRepoFile('public/scripts/extensions/in-chat-agents/companion/dice-roller.js');
        expect(runtime).toContain('createCheckbox(\'autoRoll\', \'Auto roll\'');
        expect(runtime).toContain('createCheckbox(\'autoSend\', \'Auto send\'');
        expect(runtime).toContain('autoRoll: false,');
        expect(runtime).toContain('autoSend: false,');
        expect(runtime).toContain('registerComposerSendHook(addRollAfterMessage)');
        expect(runtime).toContain('eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, rollAfterReply)');
        const addRollAfterMessage = runtime.slice(runtime.indexOf('function addRollAfterMessage'), runtime.indexOf('function decorateTextNode'));
        expect(addRollAfterMessage).not.toContain('insertIntoComposer');
        expect(addRollAfterMessage).not.toContain('send_textarea');

        const script = readRepoFile('public/script.js');
        const send = script.slice(script.indexOf('export async function sendTextareaMessage'), script.indexOf('export async function sendTextareaMessage') + 4000);
        expect(send).toContain('if (textareaText && generateType === \'normal\') {\n        prepareComposerSend(textareaText, { type: generateType });');
        expect(send).toContain('discardComposerSend();');
        expect(script).toContain('await sendMessageAsUser(appendComposerSendAdditions(textareaText), messageBias);');
        expect(readRepoFile('public/scripts/group-chats.js')).toContain('await sendMessageAsUser(appendComposerSendAdditions(userInput), bias.messageBias);');
    });

    test('CYOA and Doors agents read the visible roll in place of their hidden one', () => {
        for (const slug of ['cyoa-choices-skill-checks', 'doors-fate-checks']) {
            const template = JSON.parse(readRepoFile(`public/scripts/extensions/in-chat-agents/templates/${slug}.json`));
            expect(template.prompt).toContain('carries a 🎲 dice line');
        }
    });

    test('as companions, CYOA and Doors write only their choices and leave the check to the reply', () => {
        for (const [slug, tag, heading] of [
            ['cyoa-choices-skill-checks', 'CHOICES', '## CYOA Skill Check Resolution'],
            ['doors-fate-checks', 'DOORS', '## Fate Check Resolution'],
        ]) {
            const { prompt } = JSON.parse(readRepoFile(`public/scripts/extensions/in-chat-agents/templates/${slug}.json`));
            const section = prompt.slice(prompt.indexOf(heading) + heading.length).trimStart();
            expect(section.startsWith(`As a companion task, the [${tag}] block is your whole result`)).toBe(true);
            expect(section.indexOf('using the 🎲 dice line')).toBeLessThan(section.indexOf('{{roll:1d100}}'));
        }
    });
});

describe('Dice Roller skill checks', () => {
    test('reads the tag CYOA Choices with Skill Checks and Doors with Fate Checks write', () => {
        expect(parseSkillCheck('1. **[Speech 42/100]** Talk the guard down')).toEqual({ skill: 'Speech', target: 42, action: 'Talk the guard down' });
        expect(parseSkillCheck('I go for it.\n2. [Lockpicking 65/100] Pick the side door\nquietly')).toEqual({ skill: 'Lockpicking', target: 65, action: 'Pick the side door' });
        expect(parseSkillCheck('[Nerve 140 / 100] Jump')).toMatchObject({ skill: 'Nerve', target: 100 });
        expect(parseSkillCheck('Talk the guard down')).toBeNull();
        expect(parseSkillCheck('[Speech 42/20] Talk')).toBeNull();
    });

    test('reads the numbered tagged choices a reply or Companion note offers', () => {
        const choices = parseSkillChoices([
            '[CHOICES]',
            '1. **[Speech 42/100]** Talk the guard down',
            '2) [Stealth 30/100] Slip past the gate',
            '3. Wait and watch',
            '- 4. Force the door **[Strength 60/100]**',
            '[/CHOICES]',
        ].join('\n'));
        expect([...choices.keys()]).toEqual([1, 2, 4]);
        expect(choices.get(1)).toEqual({ skill: 'Speech', target: 42, action: 'Talk the guard down' });
        expect(choices.get(2)).toEqual({ skill: 'Stealth', target: 30, action: 'Slip past the gate' });
        expect(choices.get(4)).toEqual({ skill: 'Strength', target: 60, action: 'Force the door' });
    });

    test('reads the choice numbers a message starts with, and leaves other numbers alone', () => {
        expect(parseChoiceReferences('1')).toEqual([1]);
        expect(parseChoiceReferences('1, then 2')).toEqual([1, 2]);
        expect(parseChoiceReferences('1, then 2. I also wave at the guard.')).toEqual([1, 2]);
        expect(parseChoiceReferences('2 and then 1 while humming')).toEqual([2, 1]);
        expect(parseChoiceReferences('Option 3 & #1')).toEqual([3, 1]);
        expect(parseChoiceReferences('1. I draw my sword first')).toEqual([1]);
        expect(parseChoiceReferences('1 then 1')).toEqual([1]);
        expect(parseChoiceReferences('I pick 2')).toEqual([]);
        expect(parseChoiceReferences('100 goblins')).toEqual([]);
        expect(parseChoiceReferences('1.5 metres away')).toEqual([]);
        expect(parseChoiceReferences('3:00, we meet')).toEqual([]);
        expect(parseChoiceReferences('[Speech 42/100] Talk')).toEqual([]);
    });

    test('scores a d100 roll under the target with the agents\' bands', () => {
        expect(getSkillCheckOutcome(1, 5)).toBe(OUTCOMES.CRITICAL_SUCCESS);
        expect(getSkillCheckOutcome(100, 100)).toBe(OUTCOMES.CRITICAL_FAILURE);
        expect(getSkillCheckOutcome(32, 42)).toBe(OUTCOMES.SUCCESS);
        expect(getSkillCheckOutcome(33, 42)).toBe(OUTCOMES.PARTIAL_SUCCESS);
        expect(getSkillCheckOutcome(52, 42)).toBe(OUTCOMES.PARTIAL_SUCCESS);
        expect(getSkillCheckOutcome(53, 42)).toBe(OUTCOMES.FAILURE);
    });

    test('a skill check line reaches the reply like any other roll', () => {
        const rolled = rollSkillCheck({ skill: 'Speech', target: 42, action: 'Talk the guard down' }, sequence(31)(100));
        expect(rolled).toMatchObject({ check: 'skill', sides: 100, count: 1, total: 31, target: 42, outcome: OUTCOMES.SUCCESS });
        expect(isSameSkillCheck(rolled, { skill: 'Speech', target: 42 })).toBe(true);
        expect(isSameSkillCheck(rolled, { skill: 'Speech', target: 50 })).toBe(false);
        expect(isSameSkillCheck(rollDice({ sides: 20 }), { skill: 'Speech', target: 42 })).toBe(false);
        const line = formatRollLine(rolled);
        expect(line).toBe('🎲 Talk the guard down - rolled 31 vs 42 (Speech check, d100 roll under) - SUCCESS');
        expect(parseRollLines(`1. [Speech 42/100] Talk the guard down\n${line}`)).toEqual([
            expect.objectContaining({ action: 'Talk the guard down', total: 31, target: 42, outcome: OUTCOMES.SUCCESS }),
        ]);
    });
});

describe('composer send hooks', () => {
    test('a hook\'s line goes after the sent text once, and is told it went', () => {
        const onSent = jest.fn();
        const hook = jest.fn(() => ({ text: '🎲 Rolled 17 vs 12 (1d20: 17) - SUCCESS', onSent }));
        const unregister = registerComposerSendHook(hook);
        try {
            prepareComposerSend('I open the door.  \n', { type: 'normal' });
            expect(hook).toHaveBeenCalledWith({ text: 'I open the door.  \n', type: 'normal' });
            expect(appendComposerSendAdditions('I open the door.  \n')).toBe('I open the door.\n🎲 Rolled 17 vs 12 (1d20: 17) - SUCCESS');
            expect(onSent).toHaveBeenCalledTimes(1);
            expect(appendComposerSendAdditions('Again')).toBe('Again');
            expect(onSent).toHaveBeenCalledTimes(1);
        } finally {
            unregister();
        }
    });

    test('a send that never became a message drops its lines, and a failing hook is skipped', () => {
        const onSent = jest.fn();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const unregisterBroken = registerComposerSendHook(() => {
            throw new Error('broken');
        });
        const unregister = registerComposerSendHook(() => ({ text: 'line', onSent }));
        try {
            prepareComposerSend('Hello');
            discardComposerSend();
            expect(appendComposerSendAdditions('Hello')).toBe('Hello');
            expect(onSent).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledWith('A composer send hook failed', expect.any(Error));
        } finally {
            unregisterBroken();
            unregister();
            error.mockRestore();
        }
    });
});
