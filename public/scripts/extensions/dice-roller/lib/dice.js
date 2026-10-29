export const DICE_SIDES = Object.freeze([4, 6, 8, 10, 12, 20, 100]);
export const MAX_DICE = 4;
export const MAX_MODIFIER = 20;

export const ROLL_MODES = Object.freeze({
    NORMAL: 'normal',
    ADVANTAGE: 'advantage',
    DISADVANTAGE: 'disadvantage',
});

export const DIFFICULTIES = Object.freeze([
    Object.freeze({ id: 'easy', label: 'Easy', share: 0.4 }),
    Object.freeze({ id: 'normal', label: 'Normal', share: 0.6 }),
    Object.freeze({ id: 'hard', label: 'Hard', share: 0.75 }),
    Object.freeze({ id: 'extreme', label: 'Extreme', share: 0.9 }),
]);

export const OUTCOMES = Object.freeze({
    CRITICAL_SUCCESS: 'CRITICAL SUCCESS',
    SUCCESS: 'SUCCESS',
    PARTIAL_SUCCESS: 'PARTIAL SUCCESS',
    FAILURE: 'FAILURE',
    CRITICAL_FAILURE: 'CRITICAL FAILURE',
});

const OUTCOME_KEYS = Object.freeze({
    [OUTCOMES.CRITICAL_SUCCESS]: 'critical-success',
    [OUTCOMES.SUCCESS]: 'success',
    [OUTCOMES.PARTIAL_SUCCESS]: 'partial',
    [OUTCOMES.FAILURE]: 'failure',
    [OUTCOMES.CRITICAL_FAILURE]: 'critical-failure',
});

const OUTCOME_GUIDANCE = Object.freeze({
    [OUTCOMES.CRITICAL_SUCCESS]: 'It succeeds brilliantly. Show it working better than hoped, with an extra benefit or a lucky twist.',
    [OUTCOMES.SUCCESS]: 'It succeeds. Show it working cleanly.',
    [OUTCOMES.PARTIAL_SUCCESS]: 'It only half works. Give the success a real cost, a complication or only part of what was wanted.',
    [OUTCOMES.FAILURE]: 'It fails. Show the setback clearly, then keep the story moving.',
    [OUTCOMES.CRITICAL_FAILURE]: 'It fails badly. Show the failure and add a fresh problem or danger that follows from it.',
});

export const ROLL_MARKER = '\u{1F3B2}';

const OUTCOME_PATTERN = 'CRITICAL SUCCESS|PARTIAL SUCCESS|CRITICAL FAILURE|SUCCESS|FAILURE';
const ROLL_LINE_PATTERN = new RegExp(
    `${ROLL_MARKER}\\s*(?:(.+?)\\s+-\\s+)?rolled\\s+(-?\\d+)\\s+vs\\s+(-?\\d+)\\s*(?:\\(([^)\\n]*)\\))?\\s*-\\s*(${OUTCOME_PATTERN})\\b`,
    'giu',
);

function clampInteger(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

export function normaliseSides(value) {
    const sides = Number(value);
    return DICE_SIDES.includes(sides) ? sides : 20;
}

export function normaliseCount(value) {
    return clampInteger(value, 1, MAX_DICE, 1);
}

export function normaliseModifier(value) {
    return clampInteger(value, -MAX_MODIFIER, MAX_MODIFIER, 0);
}

export function normaliseMode(value) {
    return Object.values(ROLL_MODES).includes(value) ? value : ROLL_MODES.NORMAL;
}

export function getDifficulty(id) {
    return DIFFICULTIES.find(difficulty => difficulty.id === id) ?? null;
}

export function getTotalRange({ sides, count, modifier }) {
    const safeSides = normaliseSides(sides);
    const safeCount = normaliseCount(count);
    const safeModifier = normaliseModifier(modifier);
    return {
        min: safeCount + safeModifier,
        max: (safeCount * safeSides) + safeModifier,
    };
}

export function getTargetForDifficulty({ sides, count, difficulty }) {
    const preset = getDifficulty(difficulty) ?? getDifficulty('normal');
    const { min, max } = getTotalRange({ sides, count, modifier: 0 });
    return Math.round(min + (preset.share * (max - min)));
}

export function resolveTarget({ sides, count, modifier, difficulty, customTarget }) {
    if (difficulty === 'custom') {
        const { min, max } = getTotalRange({ sides, count, modifier });
        return clampInteger(customTarget, min, max + 1, getTargetForDifficulty({ sides, count, modifier, difficulty: 'normal' }));
    }
    return getTargetForDifficulty({ sides, count, modifier, difficulty });
}

export function getPartialBand({ sides, count }) {
    const span = (normaliseCount(count) * normaliseSides(sides)) - normaliseCount(count);
    return Math.max(1, Math.round(span * 0.15));
}

function rollPool(sides, count, random) {
    const dice = [];
    for (let index = 0; index < count; index++) {
        const value = Math.floor(random() * sides) + 1;
        dice.push(Math.min(sides, Math.max(1, value)));
    }
    return dice;
}

function sum(values) {
    return values.reduce((total, value) => total + value, 0);
}

export function getOutcome({ dice, sides, total, target, criticals = true, partials = true, count }) {
    if (criticals && dice.length > 0) {
        if (dice.every(value => value === sides)) {
            return OUTCOMES.CRITICAL_SUCCESS;
        }
        if (dice.every(value => value === 1)) {
            return OUTCOMES.CRITICAL_FAILURE;
        }
    }
    if (total >= target) {
        return OUTCOMES.SUCCESS;
    }
    if (partials && total >= target - getPartialBand({ sides, count: count ?? dice.length })) {
        return OUTCOMES.PARTIAL_SUCCESS;
    }
    return OUTCOMES.FAILURE;
}

export function rollDice(options = {}, random = Math.random) {
    const sides = normaliseSides(options.sides);
    const count = normaliseCount(options.count);
    const modifier = normaliseModifier(options.modifier);
    const mode = normaliseMode(options.mode);
    const difficulty = options.difficulty === 'custom' || getDifficulty(options.difficulty) ? options.difficulty : 'normal';
    const target = resolveTarget({ sides, count, modifier, difficulty, customTarget: options.customTarget });

    const pools = [rollPool(sides, count, random)];
    if (mode !== ROLL_MODES.NORMAL) {
        pools.push(rollPool(sides, count, random));
    }
    let keptIndex = 0;
    if (pools.length === 2) {
        const first = sum(pools[0]);
        const second = sum(pools[1]);
        if (mode === ROLL_MODES.ADVANTAGE) {
            keptIndex = second > first ? 1 : 0;
        } else {
            keptIndex = second < first ? 1 : 0;
        }
    }
    const dice = pools[keptIndex];
    const natural = sum(dice);
    const total = natural + modifier;
    const outcome = getOutcome({
        dice,
        sides,
        total,
        target,
        count,
        criticals: options.criticals !== false,
        partials: options.partials !== false,
    });

    return {
        action: cleanAction(options.action),
        sides,
        count,
        modifier,
        mode,
        difficulty,
        target,
        dice,
        droppedDice: pools.length === 2 ? pools[keptIndex === 0 ? 1 : 0] : [],
        natural,
        total,
        outcome,
    };
}

export function getOutcomeKey(outcome) {
    return OUTCOME_KEYS[String(outcome ?? '').toUpperCase()] ?? 'failure';
}

export function getOutcomeGuidance(outcome) {
    return OUTCOME_GUIDANCE[String(outcome ?? '').toUpperCase()] ?? OUTCOME_GUIDANCE[OUTCOMES.FAILURE];
}

export function cleanAction(value) {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[()|]/g, ' ')
        .replace(/\s+-\s+/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/[.!,;:\s]+$/u, '')
        .slice(0, 120)
        .trim();
}

export function formatDiceNotation({ sides, count, modifier }) {
    const safeModifier = normaliseModifier(modifier);
    const modifierText = safeModifier > 0 ? `+${safeModifier}` : safeModifier < 0 ? `${safeModifier}` : '';
    return `${normaliseCount(count)}d${normaliseSides(sides)}${modifierText}`;
}

function formatModeLabel(mode) {
    if (mode === ROLL_MODES.ADVANTAGE) {
        return ', advantage';
    }
    if (mode === ROLL_MODES.DISADVANTAGE) {
        return ', disadvantage';
    }
    return '';
}

export function formatRollLine(result) {
    const action = cleanAction(result.action);
    const notation = formatDiceNotation(result);
    const details = `${notation}: ${result.dice.join(' + ')}${formatModeLabel(result.mode)}`;
    const lead = action ? `${action} - rolled` : 'Rolled';
    return `${ROLL_MARKER} ${lead} ${result.total} vs ${result.target} (${details}) - ${result.outcome}`;
}

export function parseRollLines(text) {
    const source = String(text ?? '');
    const rolls = [];
    for (const match of source.matchAll(ROLL_LINE_PATTERN)) {
        rolls.push({
            text: match[0],
            index: match.index,
            action: cleanAction(match[1] ?? ''),
            total: Number(match[2]),
            target: Number(match[3]),
            details: String(match[4] ?? '').trim(),
            outcome: match[5].toUpperCase(),
        });
    }
    return rolls;
}

export function buildDiceDirective(rolls, userName = 'the user') {
    if (!Array.isArray(rolls) || rolls.length === 0) {
        return '';
    }
    const name = String(userName ?? '').trim() || 'the user';
    const lines = [`[Dice result for ${name}]`];
    for (const roll of rolls) {
        const subject = roll.action ? roll.action : `The attempt in ${name}'s last message`;
        lines.push(`${subject}: ${roll.outcome}. ${getOutcomeGuidance(roll.outcome)}`);
    }
    lines.push('Write the next reply with this result as settled fact. Describe what happens in the story, and keep the dice, the numbers and the word roll out of the reply.');
    return lines.join('\n');
}

/**
 * The chat a browser generation would see, built from the saved chat: hidden
 * messages left out, and the reply being swiped or regenerated dropped.
 * @param {object[]} chat Saved chat messages.
 * @param {string} type Generation type.
 * @returns {object[]}
 */
export function getGenerationChat(chat, type) {
    const visible = (Array.isArray(chat) ? chat : []).filter(message => message && !message.is_system);
    if ((type === 'swipe' || type === 'regenerate') && visible.length && !visible[visible.length - 1].is_user) {
        visible.pop();
    }
    return visible;
}

export function findRollMessageForGeneration(chat, type) {
    if (!Array.isArray(chat) || type === 'quiet' || type === 'impersonate') {
        return null;
    }
    let lastUserIndex = -1;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message?.is_user && !message?.is_system) {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0) {
        return null;
    }
    const after = chat.length - 1 - lastUserIndex;
    if (after > 1 || (after === 1 && type !== 'continue')) {
        return null;
    }
    return chat[lastUserIndex];
}
