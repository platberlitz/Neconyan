import { safeRegister } from './registration.js';
import { getChatState, touchChatState } from './chat-state.js';
import { splitList, truncateText } from './utility-impl.js';
import {
    FROZEN_ENTRIES_WARN_AT,
    FROZEN_VALUE_MAX_CHARS,
    dayStamp,
    daysBetween,
    isValidStateKey,
    parseDiceFormula,
    parseTimestamp,
    pickIndex,
    rollDice,
    seasonOf,
    stickyNeedsRefresh,
    timeOfDay,
} from './state-impl.js';

export const CATEGORY_STATE = 'enhanced-state';

/**
 * State macros that WRITE persistent chat state. Every one of these must honour
 * env.extra.meSandboxState (the Workbench overlay). the sandbox tests assert it.
 */
export const STATEFUL_MACRO_NAMES = Object.freeze(['freeze', 'sticky', 'daily', 'rollonce']);

/** In-flight freeze/sticky/daily expansions, so content that contains its own
 *  key stops with a warning instead of looping. */
const expanding = new Set();

/** Test hook. */
export function resetStateRecursion() {
    expanding.clear();
}

/** Sandboxed state (Workbench overlay) when present, else the real chat state. */
function resolveState(env) {
    const sandboxState = env?.extra?.meSandboxState;
    if (sandboxState) {
        return { state: sandboxState, sandboxed: true };
    }
    return { state: getChatState(), sandboxed: false };
}

function persist(sandboxed) {
    if (!sandboxed) {
        touchChatState();
    }
}

function guardedResolve(ctx, kind, key, rawContent) {
    const guardKey = `${kind}:${String(key).toLowerCase()}`;
    if (expanding.has(guardKey)) {
        ctx.warn(`{{${kind}}} "${key}" expands itself; expansion stopped.`);
        return { value: '', recursed: true };
    }
    expanding.add(guardKey);
    try {
        return { value: String(ctx.resolve(rawContent ?? '')), recursed: false };
    } finally {
        expanding.delete(guardKey);
    }
}

function countEntries(state) {
    return ['frozen', 'sticky', 'daily', 'rolls']
        .reduce((total, kind) => total + Object.keys(state[kind] ?? {}).length, 0);
}

function storeEntry(ctx, state, kind, key, entry) {
    const value = String(entry.value ?? '');
    if (value.length > FROZEN_VALUE_MAX_CHARS) {
        ctx.warn(`The stored value for "${key}" is over ${FROZEN_VALUE_MAX_CHARS} characters and was truncated.`);
        entry.value = truncateText(value, FROZEN_VALUE_MAX_CHARS, '');
    }
    if (!Object.hasOwn(state[kind], key) && countEntries(state) >= FROZEN_ENTRIES_WARN_AT) {
        ctx.warn(`This chat now stores over ${FROZEN_ENTRIES_WARN_AT} frozen values. Clean up with /me-unfreeze.`);
    }
    state[kind][key] = entry;
}

export function registerStateMacros() {
    safeRegister('freeze', {
        category: CATEGORY_STATE,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'key', description: 'A name for the stored value (letters, numbers, dots, colons, hyphens).' },
            { name: 'content', description: 'The text to evaluate once. Macros inside only run the first time.' },
        ],
        description: 'Evaluates its content once, saves the result in this chat, and returns the saved result from then on. Keeps prompts byte-stable for prompt caching. Undo with /me-unfreeze.',
        returns: 'the stored result',
        exampleUsage: ['{{freeze::opening-weather::{{random::stormy::misty::clear}}}}'],
        handler: (ctx) => {
            const [rawKey, rawContent] = ctx.unnamedArgs;
            const key = String(ctx.resolve(rawKey ?? '')).trim();
            if (!isValidStateKey(key)) {
                ctx.warn(`{{freeze}}: "${key}" is not a valid key. The value was not saved.`);
                return guardedResolve(ctx, 'freeze', key || '(empty)', rawContent).value;
            }
            const { state, sandboxed } = resolveState(ctx.env);
            if (!state) {
                ctx.warn('{{freeze}}: no chat is loaded. The value was not saved.');
                return guardedResolve(ctx, 'freeze', key, rawContent).value;
            }
            const existing = state.frozen[key];
            if (existing) {
                return String(existing.value ?? '');
            }
            const { value, recursed } = guardedResolve(ctx, 'freeze', key, rawContent);
            if (recursed) {
                return value;
            }
            const entry = { value, frozenAt: Date.now() };
            storeEntry(ctx, state, 'frozen', key, entry);
            persist(sandboxed);
            return String(entry.value);
        },
    });

    safeRegister('sticky', {
        category: CATEGORY_STATE,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'messages', type: 'integer', description: 'Re-evaluate after this many of your messages.' },
            { name: 'key', description: 'A name for the stored value.' },
            { name: 'content', description: 'The text to evaluate at each refresh.' },
        ],
        description: 'Like {{freeze}}, but re-evaluates its content every N of your messages. Between refreshes the stored result is returned unchanged, so prompt caching only breaks at refresh points.',
        returns: 'the stored result',
        exampleUsage: ['{{sticky::10::mood::{{random::tense::playful::somber}}}}'],
        handler: (ctx) => {
            const [rawPeriod, rawKey, rawContent] = ctx.unnamedArgs;
            const period = Number.parseInt(String(ctx.resolve(rawPeriod ?? '')).trim(), 10);
            const key = String(ctx.resolve(rawKey ?? '')).trim();
            if (!Number.isFinite(period) || period < 1) {
                ctx.warn(`{{sticky}}: the first argument must be a whole number of messages (got "${rawPeriod}").`);
                return guardedResolve(ctx, 'sticky', key || '(empty)', rawContent).value;
            }
            if (!isValidStateKey(key)) {
                ctx.warn(`{{sticky}}: "${key}" is not a valid key. The value was not saved.`);
                return guardedResolve(ctx, 'sticky', key || '(empty)', rawContent).value;
            }
            const { state, sandboxed } = resolveState(ctx.env);
            if (!state) {
                ctx.warn('{{sticky}}: no chat is loaded. The value was not saved.');
                return guardedResolve(ctx, 'sticky', key, rawContent).value;
            }
            const entry = state.sticky[key];
            const userCount = state.counters.userMessages;
            if (!stickyNeedsRefresh(entry, userCount, period)) {
                return String(entry.value ?? '');
            }
            const { value, recursed } = guardedResolve(ctx, 'sticky', key, rawContent);
            if (recursed) {
                return value;
            }
            const next = { value, atUserCount: userCount };
            storeEntry(ctx, state, 'sticky', key, next);
            persist(sandboxed);
            return String(next.value);
        },
    });

    safeRegister('daily', {
        category: CATEGORY_STATE,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'key', description: 'A name for the stored value.' },
            { name: 'content', description: 'The text to evaluate once per calendar day.' },
        ],
        description: 'Like {{freeze}}, but re-evaluates its content once per calendar day (local time). Prompt caching only breaks at the first generation of each day.',
        returns: 'the stored result',
        exampleUsage: ['{{daily::forecast::{{random::sunny::overcast::drizzly}}}}'],
        handler: (ctx) => {
            const [rawKey, rawContent] = ctx.unnamedArgs;
            const key = String(ctx.resolve(rawKey ?? '')).trim();
            if (!isValidStateKey(key)) {
                ctx.warn(`{{daily}}: "${key}" is not a valid key. The value was not saved.`);
                return guardedResolve(ctx, 'daily', key || '(empty)', rawContent).value;
            }
            const { state, sandboxed } = resolveState(ctx.env);
            if (!state) {
                ctx.warn('{{daily}}: no chat is loaded. The value was not saved.');
                return guardedResolve(ctx, 'daily', key, rawContent).value;
            }
            const today = dayStamp(new Date());
            const entry = state.daily[key];
            if (entry && entry.day === today) {
                return String(entry.value ?? '');
            }
            const { value, recursed } = guardedResolve(ctx, 'daily', key, rawContent);
            if (recursed) {
                return value;
            }
            const next = { value, day: today };
            storeEntry(ctx, state, 'daily', key, next);
            persist(sandboxed);
            return String(next.value);
        },
    });

    safeRegister('rollonce', {
        category: CATEGORY_STATE,
        unnamedArgs: [
            { name: 'key', description: 'A name for the stored roll.' },
            { name: 'formula', description: 'Dice like 2d6, d20, 3d6+2, or a plain number of sides.' },
        ],
        description: 'Rolls dice once, saves the total in this chat, and returns the same total from then on. Cache-friendly, unlike {{roll}}. Re-roll with /me-unfreeze.',
        returns: 'the stored total',
        returnType: 'integer',
        exampleUsage: ['{{rollonce::strength::3d6}}'],
        handler: (ctx) => {
            const [rawKey, rawFormula] = ctx.unnamedArgs;
            const key = String(rawKey ?? '').trim();
            const formulaText = String(rawFormula ?? '').trim();
            const formula = parseDiceFormula(formulaText);
            if (!formula) {
                ctx.warn(`{{rollonce}}: "${formulaText}" is not a dice formula (like 2d6+1).`);
                return '';
            }
            if (!isValidStateKey(key)) {
                ctx.warn(`{{rollonce}}: "${key}" is not a valid key. Rolled without saving.`);
                return String(rollDice(formula));
            }
            const { state, sandboxed } = resolveState(ctx.env);
            if (!state) {
                ctx.warn('{{rollonce}}: no chat is loaded. Rolled without saving.');
                return String(rollDice(formula));
            }
            const entry = state.rolls[key];
            if (entry && entry.formula === formulaText) {
                return String(entry.value ?? '');
            }
            if (entry) {
                ctx.warn(`{{rollonce}}: the formula for "${key}" changed (${entry.formula} → ${formulaText}). re-rolled.`);
            }
            const next = { value: String(rollDice(formula)), formula: formulaText };
            storeEntry(ctx, state, 'rolls', key, next);
            persist(sandboxed);
            return next.value;
        },
    });

    safeRegister('listpick', {
        category: CATEGORY_STATE,
        unnamedArgs: [
            { name: 'key', description: 'A label that keeps different picks independent.' },
            { name: 'list', description: 'The items to pick from.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Picks one item from a list. always the same one for this chat and key. A cache-friendly {{random}} that needs no storage.',
        returns: 'the picked item',
        exampleUsage: ['{{listpick::weather::sunny, rainy, misty}}'],
        handler: (ctx) => {
            const [key, list, separator] = ctx.unnamedArgs;
            const items = splitList(list, separator === undefined || separator === '' ? ',' : separator);
            if (!items.length) {
                ctx.warn('{{listpick}}: the list is empty.');
                return '';
            }
            const chatSeed = String(SillyTavern.getContext().chatMetadata?.chat_id_hash ?? '');
            return items[pickIndex(`${chatSeed}:${String(key ?? '')}`, items.length)];
        },
    });

    safeRegister('timeofday', {
        category: CATEGORY_STATE,
        description: 'The coarse time of day: morning, afternoon, evening or night. Changes only a few times a day, so it is far kinder to prompt caching than {{time}}.',
        returns: 'morning, afternoon, evening or night',
        exampleUsage: ['{{timeofday}}'],
        handler: () => timeOfDay(new Date().getHours()),
    });

    safeRegister('season', {
        category: CATEGORY_STATE,
        unnamedArgs: [
            { name: 'hemisphere', optional: true, defaultValue: 'north', description: 'north (default) or south.' },
        ],
        description: 'The current season. Changes four times a year. safe for prompt caching.',
        returns: 'spring, summer, autumn or winter',
        exampleUsage: ['{{season}}', '{{season::south}}'],
        handler: (ctx) => seasonOf(new Date().getMonth(), ctx.unnamedArgs[0] || 'north'),
    });

    safeRegister('chatdays', {
        category: CATEGORY_STATE,
        description: 'How many whole days this chat has existed. Changes at most once a day.',
        returns: 'a whole number of days',
        returnType: 'integer',
        exampleUsage: ['{{chatdays}}'],
        handler: (ctx) => {
            const liveCtx = SillyTavern.getContext();
            const { state } = resolveState(ctx.env);
            let start = parseTimestamp(liveCtx.chat?.[0]?.send_date);
            if (!Number.isFinite(start)) {
                start = state?.counters?.firstSeenAt ?? NaN;
            }
            if (!Number.isFinite(start)) {
                ctx.warn('{{chatdays}}: no chat is loaded.');
                return '';
            }
            return String(daysBetween(start, Date.now()));
        },
    });

    const counterMacro = (name, counterKey, what) => {
        safeRegister(name, {
            category: CATEGORY_STATE,
            description: `How many ${what} Macro Enhanced has counted in this chat. Only changes when it happens, so it is cache-friendly.`,
            returns: 'a whole number',
            returnType: 'integer',
            exampleUsage: [`{{${name}}}`],
            handler: (ctx) => {
                const { state } = resolveState(ctx.env);
                if (!state) {
                    ctx.warn(`{{${name}}}: no chat is loaded.`);
                    return '0';
                }
                return String(state.counters[counterKey] ?? 0);
            },
        });
    };
    counterMacro('usermsgcount', 'userMessages', 'of your messages');
    counterMacro('charmsgcount', 'charMessages', 'character replies');
    counterMacro('swipecount', 'swipes', 'swipes');
    counterMacro('gencount', 'generations', 'generations');
}
