import { safeRegister } from './registration.js';
import { conditionIsTrue, isCompatActive } from './compat-macros.js';
import { CATEGORY_LIST, CATEGORY_MATH, CATEGORY_TEXT } from './utility-macros.js';
import { JsonPathError, formatNumber, splitList, truncateText } from './utility-impl.js';
import {
    RegexError,
    boolString,
    compareValues,
    countWords,
    isFalsyText,
    isTruthyText,
    jsonValueAt,
    jsonSetValue,
    listContains,
    padText,
    regexReplaceText,
    shuffleList,
    sliceList,
    splitSwitchPair,
    sumList,
    titleCaseText,
    uniqueList,
} from './logic-impl.js';

export const CATEGORY_LOGIC = 'enhanced-logic';

function parseIntArg(value, { warn, name, fallback = null }) {
    const n = Number.parseInt(String(value).trim(), 10);
    if (Number.isNaN(n)) {
        warn(`Argument "${name}" is not a whole number: "${value}"`);
        return fallback;
    }
    return n;
}

const listSeparator = (separator) => (separator === undefined || separator === '' ? ',' : separator);

const conditionArgs = ({ unnamedArgs, list }) => [...unnamedArgs, ...(list ?? [])];

/**
 * How {{and}} and {{or}} read one argument. Normally that is plain truthiness,
 * matching {{if}}. With compat mode on, an argument written as an infix
 * expression is worked out instead. otherwise `{{or::a::{{lower::$<t>}} == "x"}}`
 * would see a non-empty string and call it true whatever the comparison says.
 */
function argIsTrue(value, warn) {
    return isCompatActive() ? conditionIsTrue(value, warn) : isTruthyText(value);
}

export function registerLogicMacros() {
    // ---- comparisons (compose with {{if}}: they return "true"/"false", and the
    // engine's {{if}} treats the string "false" as falsy) ----

    const comparison = (name, test, symbol) => {
        safeRegister(name, {
            category: CATEGORY_LOGIC,
            unnamedArgs: [
                { name: 'a', description: 'The left value.' },
                { name: 'b', description: 'The right value.' },
            ],
            description: `True when a ${symbol} b. Numbers compare numerically, anything else as text. Composes with {{if}}.`,
            returns: 'true or false',
            returnType: 'boolean',
            exampleUsage: [`{{${name}::{{getvar::hp}}::10}}`],
            handler: ({ unnamedArgs: [a, b] }) => boolString(test(compareValues(a, b))),
        });
    };
    comparison('eq', c => c === 0, '=');
    comparison('neq', c => c !== 0, '≠');
    comparison('gt', c => c === 1, '>');
    comparison('gte', c => c >= 0, '≥');
    comparison('lt', c => c === -1, '<');
    comparison('lte', c => c <= 0, '≤');

    safeRegister('and', {
        category: CATEGORY_LOGIC,
        unnamedArgs: [
            { name: 'first', description: 'The first value.' },
            { name: 'second', description: 'The second value.' },
        ],
        list: true,
        description: 'True when every value is truthy (same rules as {{if}}: empty, "false", "off" and "0" are false).',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{and::{{gt::{{getvar::hp}}::0}}::{{getvar::awake}}}}'],
        handler: (ctx) => boolString(conditionArgs(ctx).every(arg => argIsTrue(arg, ctx.warn))),
    });

    safeRegister('or', {
        category: CATEGORY_LOGIC,
        unnamedArgs: [
            { name: 'first', description: 'The first value.' },
            { name: 'second', description: 'The second value.' },
        ],
        list: true,
        description: 'True when at least one value is truthy (same rules as {{if}}).',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{or::{{getvar::injured}}::{{getvar::tired}}}}'],
        handler: (ctx) => boolString(conditionArgs(ctx).some(arg => argIsTrue(arg, ctx.warn))),
    });

    safeRegister('not', {
        category: CATEGORY_LOGIC,
        unnamedArgs: [{ name: 'value', description: 'The value to invert.' }],
        description: 'Inverts a truthy/falsy value (same rules as {{if}}).',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{not::{{getvar::visible}}}}'],
        handler: ({ unnamedArgs: [value] }) => boolString(isFalsyText(value)),
    });

    safeRegister('isempty', {
        aliases: [{ alias: 'blank', visible: true }],
        category: CATEGORY_LOGIC,
        unnamedArgs: [{ name: 'value', description: 'The value to check.' }],
        description: 'True when the value is empty or only whitespace.',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{isempty::{{getvar::quest}}}}', '{{blank::{{getchatvar::target}}}}'],
        handler: ({ unnamedArgs: [value] }) => boolString(!String(value ?? '').trim()),
    });

    safeRegister('switch', {
        category: CATEGORY_LOGIC,
        delayArgResolution: true,
        unnamedArgs: [{ name: 'value', description: 'The value to match.' }],
        list: { min: 1 },
        description: 'Matches a value against case=result branches and returns the matching result. Only the winning branch\'s macros run. "default=result" catches everything else.',
        returns: 'the matching branch\'s result',
        exampleUsage: ['{{switch::{{getvar::mood}}::happy=She beams.::sad=She sighs.::default=She waits.}}'],
        handler: (ctx) => {
            const value = String(ctx.resolve(ctx.unnamedArgs[0] ?? ''));
            let defaultRaw = null;
            for (const rawPair of ctx.list ?? []) {
                const pair = splitSwitchPair(rawPair);
                if (!pair) {
                    ctx.warn(`{{switch}}: branch "${truncateText(String(rawPair), 30)}" has no "=" and was skipped.`);
                    continue;
                }
                if (pair.rawKey.trim().toLowerCase() === 'default') {
                    defaultRaw = pair.rawResult;
                    continue;
                }
                const key = String(ctx.resolve(pair.rawKey));
                if (compareValues(value, key) === 0) {
                    return String(ctx.resolve(pair.rawResult));
                }
            }
            return defaultRaw !== null ? String(ctx.resolve(defaultRaw)) : '';
        },
    });

    // ---- list math ----

    safeRegister('sum', {
        category: CATEGORY_MATH,
        unnamedArgs: [
            { name: 'list', description: 'The numbers to add.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Adds up the numbers in a list. Non-numeric items are skipped with a warning.',
        returns: 'the total',
        returnType: 'number',
        exampleUsage: ['{{sum::3, 4, 5}}'],
        handler: ({ unnamedArgs: [list, separator], warn }) => {
            const { total, skipped } = sumList(splitList(list, listSeparator(separator)));
            if (skipped.length) {
                warn(`{{sum}}: skipped non-numeric item(s): ${skipped.join(', ')}`);
            }
            return formatNumber(total);
        },
    });

    safeRegister('avg', {
        category: CATEGORY_MATH,
        unnamedArgs: [
            { name: 'list', description: 'The numbers to average.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Averages the numbers in a list. Non-numeric items are skipped with a warning.',
        returns: 'the average',
        returnType: 'number',
        exampleUsage: ['{{avg::3, 4, 5}}'],
        handler: ({ unnamedArgs: [list, separator], warn }) => {
            const { total, used, skipped } = sumList(splitList(list, listSeparator(separator)));
            if (skipped.length) {
                warn(`{{avg}}: skipped non-numeric item(s): ${skipped.join(', ')}`);
            }
            if (!used) {
                warn('{{avg}}: no numeric items to average.');
                return '';
            }
            return formatNumber(total / used);
        },
    });

    const listExtreme = (name, better, word) => {
        safeRegister(name, {
            category: CATEGORY_MATH,
            unnamedArgs: [
                { name: 'list', description: 'The values to compare.' },
                { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
            ],
            description: `The ${word} value in a list (numeric when possible).`,
            returns: `the ${word} value`,
            exampleUsage: [`{{${name}::3, 11, 7}}`],
            handler: ({ unnamedArgs: [list, separator], warn }) => {
                const items = splitList(list, listSeparator(separator));
                if (!items.length) {
                    warn(`{{${name}}}: the list is empty.`);
                    return '';
                }
                return items.reduce((best, item) => (compareValues(item, best) === better ? item : best));
            },
        });
    };
    listExtreme('listmin', -1, 'smallest');
    listExtreme('listmax', 1, 'largest');

    // ---- list ops ----

    safeRegister('listunique', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list to deduplicate.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Removes duplicate items, keeping the first occurrence.',
        returns: 'the deduplicated list',
        exampleUsage: ['{{listunique::a, b, a, c}}'],
        handler: ({ unnamedArgs: [list, separator] }) => {
            const sep = listSeparator(separator);
            return uniqueList(splitList(list, sep)).join(sep);
        },
    });

    safeRegister('listreverse', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list to reverse.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Reverses the order of the items.',
        returns: 'the reversed list',
        exampleUsage: ['{{listreverse::a, b, c}}'],
        handler: ({ unnamedArgs: [list, separator] }) => {
            const sep = listSeparator(separator);
            return splitList(list, sep).reverse().join(sep);
        },
    });

    safeRegister('listslice', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The source list.' },
            { name: 'start', type: 'integer', description: 'Start index (0-based). Negative counts from the end.' },
            { name: 'end', type: 'integer', optional: true, description: 'End index (exclusive). Omit for "until the end".' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Extracts part of a list by item positions.',
        returns: 'the sliced list',
        exampleUsage: ['{{listslice::a, b, c, d::0::2}}', '{{listslice::a, b, c::-1}}'],
        handler: ({ unnamedArgs: [list, start, end, separator], warn }) => {
            const sep = listSeparator(separator);
            const from = parseIntArg(start, { warn, name: 'start', fallback: 0 });
            const to = end === undefined || end === '' ? undefined : parseIntArg(end, { warn, name: 'end', fallback: undefined });
            return sliceList(splitList(list, sep), from, to).join(sep);
        },
    });

    safeRegister('listcontains', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list to search.' },
            { name: 'item', description: 'The item to look for.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'True when the list contains the item (numbers match numerically). Composes with {{if}}.',
        returns: 'true or false',
        returnType: 'boolean',
        exampleUsage: ['{{listcontains::sword, shield::shield}}'],
        handler: ({ unnamedArgs: [list, item, separator] }) =>
            boolString(listContains(splitList(list, listSeparator(separator)), item)),
    });

    safeRegister('listshuffle', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list to shuffle.' },
            { name: 'seed', optional: true, defaultValue: '', description: 'With a seed the order is fixed (cache-friendly); without one it re-shuffles every call.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'The list separator.' },
        ],
        description: 'Shuffles the items. Give it a seed to make the order deterministic and prompt-cache-friendly.',
        returns: 'the shuffled list',
        exampleUsage: ['{{listshuffle::a, b, c::myseed}}'],
        handler: ({ unnamedArgs: [list, seed, separator] }) => {
            const sep = listSeparator(separator);
            return shuffleList(splitList(list, sep), seed ?? '').join(sep);
        },
    });

    // ---- text ----

    const padMacro = (name, side) => {
        safeRegister(name, {
            category: CATEGORY_TEXT,
            unnamedArgs: [
                { name: 'text', description: 'The text to pad.' },
                { name: 'length', type: 'integer', description: 'The target length (max 500).' },
                { name: 'pad', optional: true, defaultValue: ' ', description: 'The padding characters.' },
            ],
            description: `Pads the ${side} of the text to a target length.`,
            returns: 'the padded text',
            exampleUsage: [`{{${name}::7::4::0}}`],
            handler: ({ unnamedArgs: [text, length, pad], warn }) => {
                const target = parseIntArg(length, { warn, name: 'length', fallback: null });
                return target === null ? String(text) : padText(text, target, pad, side);
            },
        });
    };
    padMacro('padstart', 'start');
    padMacro('padend', 'end');

    safeRegister('titlecase', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to convert.' }],
        description: 'Uppercases the first letter of every word.',
        returns: 'the converted text',
        exampleUsage: ['{{titlecase::the winter market}}'],
        handler: ({ unnamedArgs: [text] }) => titleCaseText(text),
    });

    safeRegister('wordcount', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to count.' }],
        description: 'Counts the words in the text.',
        returns: 'the number of words',
        returnType: 'integer',
        exampleUsage: ['{{wordcount::how many words is this}}'],
        handler: ({ unnamedArgs: [text] }) => String(countWords(text)),
    });

    safeRegister('regexreplace', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The text to search in.' },
            { name: 'pattern', description: 'A regular expression (max 200 characters).' },
            { name: 'replacement', optional: true, defaultValue: '', description: 'The replacement; $1-$9 insert capture groups.' },
            { name: 'flags', optional: true, defaultValue: 'g', description: 'Regex flags (g, i, m, s, u).' },
        ],
        description: 'Regular-expression replace with guardrails. On any problem the original text is returned with a warning. Note: a complex pattern on long text can be slow.',
        returns: 'the replaced text',
        exampleUsage: ['{{regexreplace::a1b2c3::[0-9]+::#}}'],
        handler: ({ unnamedArgs: [text, pattern, replacement, flags], warn }) => {
            try {
                return regexReplaceText(text, pattern, replacement, flags === undefined || flags === '' ? 'g' : flags);
            } catch (error) {
                if (error instanceof RegexError) {
                    warn(`{{regexreplace}}: ${error.message}`);
                    return String(text ?? '');
                }
                throw error;
            }
        },
    });

    // ---- JSON ----

    safeRegister('jsonkeys', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'json', description: 'The JSON text.' },
            { name: 'path', optional: true, defaultValue: '', description: 'A path like a.b[0]. Omit for the top level.' },
        ],
        description: 'The keys of a JSON object, comma-separated.',
        returns: 'the keys',
        exampleUsage: ['{{jsonkeys::{{getvar::inventory}}}}'],
        handler: ({ unnamedArgs: [json, path], warn }) => {
            try {
                const value = jsonValueAt(json, path ?? '');
                if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                    warn('{{jsonkeys}}: the value at that path is not an object.');
                    return '';
                }
                return Object.keys(value).join(', ');
            } catch (error) {
                if (error instanceof JsonPathError) {
                    warn(`{{jsonkeys}}: ${error.message}`);
                    return '';
                }
                throw error;
            }
        },
    });

    safeRegister('jsonlength', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'json', description: 'The JSON text.' },
            { name: 'path', optional: true, defaultValue: '', description: 'A path like a.b[0]. Omit for the top level.' },
        ],
        description: 'The length of a JSON value: array items, object keys, or string characters.',
        returns: 'the length',
        returnType: 'integer',
        exampleUsage: ['{{jsonlength::{{getvar::party}}::members}}'],
        handler: ({ unnamedArgs: [json, path], warn }) => {
            try {
                const value = jsonValueAt(json, path ?? '');
                if (Array.isArray(value)) {
                    return String(value.length);
                }
                if (value !== null && typeof value === 'object') {
                    return String(Object.keys(value).length);
                }
                if (typeof value === 'string') {
                    return String(value.length);
                }
                warn('{{jsonlength}}: the value at that path has no length.');
                return '';
            } catch (error) {
                if (error instanceof JsonPathError) {
                    warn(`{{jsonlength}}: ${error.message}`);
                    return '';
                }
                throw error;
            }
        },
    });

    safeRegister('jsonset', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'variable', description: 'The variable holding JSON (created if missing).' },
            { name: 'path', description: 'A path like a.b[0]. Missing levels are created.' },
            { name: 'value', description: 'The value to store (as text).' },
            { name: 'scope', optional: true, defaultValue: 'local', description: 'local (this chat, default) or global.' },
        ],
        description: 'Sets a value inside a JSON variable, creating missing levels. Returns nothing, like {{setvar}}.',
        returns: 'an empty string',
        exampleUsage: ['{{jsonset::inventory::weapons[0]::sword}}'],
        handler: ({ unnamedArgs: [variable, path, value, scope], warn }) => {
            const name = String(variable ?? '').trim();
            if (!name) {
                warn('{{jsonset}}: give it a variable name.');
                return '';
            }
            const scopeName = String(scope ?? 'local').trim().toLowerCase() || 'local';
            if (scopeName !== 'local' && scopeName !== 'global') {
                warn(`{{jsonset}}: scope must be local or global (got "${scope}").`);
                return '';
            }
            const variables = SillyTavern.getContext().variables?.[scopeName];
            if (!variables) {
                warn('{{jsonset}}: the variables API is unavailable.');
                return '';
            }
            try {
                const current = variables.get(name);
                variables.set(name, jsonSetValue(current ?? '', path, value));
            } catch (error) {
                if (error instanceof JsonPathError) {
                    warn(`{{jsonset}}: ${error.message}`);
                    return '';
                }
                throw error;
            }
            return '';
        },
    });
}
