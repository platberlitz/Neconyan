import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    OUTCOMES,
    ROLL_MODES,
    buildDiceDirective,
    cleanAction,
    findRollMessageForGeneration,
    formatRollLine,
    getGenerationChat,
    getOutcome,
    getTargetForDifficulty,
    parseRollLines,
    resolveTarget,
    rollDice,
} from '../public/scripts/extensions/dice-roller/lib/dice.js';

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
        expect(directive).not.toMatch(/\d/);
        expect(directive.length).toBeLessThan(420);
        expect(buildDiceDirective([], 'Mira')).toBe('');

        const unnamed = buildDiceDirective(parseRollLines('\u{1F3B2} Rolled 14 vs 12 (1d20: 14) - SUCCESS'), 'Mira');
        expect(unnamed).toContain('The attempt in Mira\'s last message: SUCCESS.');
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
    });
});

describe('dice roller wiring', () => {
    test('ships switched on as a core extension with a generate interceptor', () => {
        const manifest = JSON.parse(readRepoFile('public/scripts/extensions/dice-roller/manifest.json'));
        expect(manifest).toMatchObject({
            display_name: 'Dice Roller',
            js: 'index.js',
            css: 'style.css',
            generate_interceptor: 'necoDiceRollerInterceptor',
            hooks: { activate: 'activate' },
        });
        expect(manifest).not.toHaveProperty('bundled_opt_in');
        expect(manifest.description).not.toMatch(/\u2014/);

        const entry = readRepoFile('public/scripts/extensions/dice-roller/index.js');
        expect(entry).toContain('globalThis.necoDiceRollerInterceptor');
        expect(entry).toContain('export function activate()');
        expect(entry).toContain('extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM');
        expect(entry).not.toContain('roll_dice');

        expect(readRepoFile('src/endpoints/extensions.js')).toMatch(/const CORE_EXTENSIONS = new Set\(\[[\s\S]*?'dice-roller',[\s\S]*?\]\);/);
        expect(readRepoFile('public/scripts/extensions-manager.js')).toContain('\'dice-roller\':');
    });
});
