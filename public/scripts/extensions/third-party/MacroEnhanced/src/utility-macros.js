import { safeRegister } from './registration.js';
import {
    CHARS_PER_TOKEN,
    CalcError,
    JsonPathError,
    REPEAT_MAX,
    capitalizeText,
    clampNumber,
    defaultText,
    estimateTokens,
    evaluateExpression,
    formatNumber,
    itemAt,
    jsonGet,
    repeatText,
    replaceText,
    roundTo,
    sortList,
    splitField,
    splitList,
    substringText,
    wrapText,
    truncateText,
    truncateTokensText,
} from './utility-impl.js';

export const CATEGORY_TEXT = 'enhanced-text';
export const CATEGORY_MATH = 'enhanced-math';
export const CATEGORY_LIST = 'enhanced-list';

function parseInteger(value, { warn, name, fallback = null }) {
    const n = Number.parseInt(String(value).trim(), 10);
    if (Number.isNaN(n)) {
        warn(`Argument "${name}" is not a whole number: "${value}"`);
        return fallback;
    }
    return n;
}

function parseNumber(value, { warn, name, fallback = null }) {
    const n = Number.parseFloat(String(value).trim());
    if (Number.isNaN(n)) {
        warn(`Argument "${name}" is not a number: "${value}"`);
        return fallback;
    }
    return n;
}

export function registerUtilityMacros() {
    // ---- text ----

    safeRegister('upper', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to convert to uppercase.' }],
        description: 'Converts text to uppercase.',
        returns: 'the uppercased text',
        exampleUsage: ['{{upper::hello}}'],
        handler: ({ unnamedArgs: [text] }) => String(text).toUpperCase(),
    });

    safeRegister('lower', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to convert to lowercase.' }],
        description: 'Converts text to lowercase.',
        returns: 'the lowercased text',
        exampleUsage: ['{{lower::HELLO}}'],
        handler: ({ unnamedArgs: [text] }) => String(text).toLowerCase(),
    });

    safeRegister('capitalize', {
        aliases: [{ alias: 'cap', visible: false }],
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to capitalize.' }],
        description: 'Capitalizes the first letter of the text.',
        returns: 'the text with its first letter capitalized',
        exampleUsage: ['{{capitalize::hello world}}'],
        handler: ({ unnamedArgs: [text] }) => capitalizeText(text),
    });

    safeRegister('replace', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The text to search in.' },
            { name: 'search', description: 'The exact text to find. Every occurrence is replaced.' },
            { name: 'replacement', optional: true, defaultValue: '', description: 'The replacement text. Leave out to delete the matches.' },
        ],
        description: 'Replaces every occurrence of a plain-text search string. Note: a literal "::" cannot appear in arguments.',
        returns: 'the text with every match replaced',
        exampleUsage: ['{{replace::the cat sat::cat::dog}}'],
        handler: ({ unnamedArgs: [text, search, replacement] }) => replaceText(text, search, replacement),
    });

    safeRegister('substring', {
        aliases: [{ alias: 'substr', visible: false }],
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The source text.' },
            { name: 'start', type: 'integer', description: 'Start position (0-based). Negative counts from the end.' },
            { name: 'end', type: 'integer', optional: true, description: 'End position (exclusive). Negative counts from the end. Omit for "until the end".' },
        ],
        description: 'Extracts part of the text by character positions.',
        returns: 'the extracted part of the text',
        exampleUsage: ['{{substring::hello world::0::5}}', '{{substring::hello world::-5}}'],
        handler: ({ unnamedArgs: [text, start, end], warn }) => {
            const from = parseInteger(start, { warn, name: 'start', fallback: 0 });
            const to = end === undefined || end === '' ? undefined : parseInteger(end, { warn, name: 'end', fallback: undefined });
            return substringText(text, from, to);
        },
    });

    // {{split}} and {{wrap}} resolve their own arguments (delayArgResolution) for
    // one reason: the host's lexer throws away whitespace between argument
    // separators, so a normally-resolved argument can never be a lone space. On
    // the lazy path the raw text survives, which lets {{space}} through intact.
    safeRegister('split', {
        category: CATEGORY_TEXT,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'text', description: 'The text to split.' },
            { name: 'separator', description: 'What to split on. Leave empty for a single space; write {{space}} to be explicit.' },
            { name: 'index', type: 'integer', description: 'Which piece to return, counting from 0. Negative counts from the end.' },
        ],
        description: 'Returns one piece of a split-up string. Returns nothing when the position is past either end.',
        returns: 'the piece at that position',
        exampleUsage: ['{{split::{{user}}::{{space}}::0}}', '{{split::a,b,c::,::-1}}'],
        handler: (ctx) => {
            const [rawText, rawSeparator, rawIndex] = ctx.unnamedArgs;
            const text = String(ctx.resolve(rawText ?? ''));
            const separator = String(ctx.resolve(rawSeparator ?? ''));
            const index = parseInteger(String(ctx.resolve(rawIndex ?? '')), { warn: ctx.warn, name: 'index', fallback: null });
            if (index === null) {
                return '';
            }
            return splitField(text, separator, index);
        },
    });

    safeRegister('wrap', {
        category: CATEGORY_TEXT,
        delayArgResolution: true,
        unnamedArgs: [
            { name: 'prefix', description: 'Put in front of the value. Write {{space}} for a space.' },
            { name: 'suffix', description: 'Put after the value.' },
            { name: 'value', description: 'The value to surround.' },
        ],
        description: 'Surrounds a value with a prefix and suffix, but produces nothing at all when the value is empty. Useful for separators that should disappear along with what they separate.',
        returns: 'the surrounded value, or nothing',
        exampleUsage: ['{{wrap::{{space}}::::{{split::{{user}}::{{space}}::1}}}}', '{{wrap:: (::)::{{getchatvar::title}}}}'],
        handler: (ctx) => {
            const [rawPrefix, rawSuffix, rawValue] = ctx.unnamedArgs;
            const prefix = String(ctx.resolve(rawPrefix ?? ''));
            const suffix = String(ctx.resolve(rawSuffix ?? ''));
            const value = String(ctx.resolve(rawValue ?? ''));
            return wrapText(value, prefix, suffix);
        },
    });

    safeRegister('length', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to measure.' }],
        description: 'Returns the number of characters in the text.',
        returns: 'a whole number',
        returnType: 'integer',
        exampleUsage: ['{{length::hello}}'],
        handler: ({ unnamedArgs: [text] }) => String(String(text).length),
    });

    safeRegister('repeat', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The text to repeat.' },
            { name: 'count', type: 'integer', description: `How many times to repeat (max ${REPEAT_MAX}).` },
        ],
        description: 'Repeats the text a number of times.',
        returns: 'the repeated text',
        exampleUsage: ['{{repeat::na::4}}'],
        handler: ({ unnamedArgs: [text, count], warn }) => {
            const n = parseInteger(count, { warn, name: 'count', fallback: 0 });
            const { result, clamped } = repeatText(text, n ?? 0);
            if (clamped) {
                warn(`Repeat count clamped to ${REPEAT_MAX}.`);
            }
            return result;
        },
    });

    safeRegister('default', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'value', description: 'The value to check.' },
            { name: 'fallback', description: 'What to use when the value is empty.' },
        ],
        description: 'Returns the value, or the fallback when the value is empty or only whitespace. Handy around {{getvar}} for unset variables.',
        returns: 'the value, or the fallback when it was empty',
        exampleUsage: ['{{default::{{getvar::mood}}::neutral}}'],
        handler: ({ unnamedArgs: [value, fallback] }) => defaultText(value, fallback),
    });

    safeRegister('truncate', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The text to shorten.' },
            { name: 'max', type: 'integer', description: 'Maximum length in characters, including the ellipsis.' },
            { name: 'ellipsis', optional: true, defaultValue: '…', description: 'Appended when the text is shortened.' },
        ],
        description: 'Shortens text to a maximum number of characters.',
        returns: 'the shortened text',
        exampleUsage: ['{{truncate::{{charDescription}}::300}}'],
        handler: ({ unnamedArgs: [text, max, ellipsis], warn }) => {
            const n = parseInteger(max, { warn, name: 'max' });
            if (n === null) {
                return String(text);
            }
            return truncateText(text, n, ellipsis === undefined || ellipsis === '' ? '…' : ellipsis);
        },
    });

    safeRegister('truncatetokens', {
        category: CATEGORY_TEXT,
        unnamedArgs: [
            { name: 'text', description: 'The text to shorten.' },
            { name: 'maxTokens', type: 'integer', description: 'Rough maximum length in tokens.' },
            { name: 'ellipsis', optional: true, defaultValue: '…', description: 'Appended when the text is shortened.' },
        ],
        description: `Shortens text to a rough token budget. This is an ESTIMATE (about ${CHARS_PER_TOKEN} characters per token) and can be off by 20% or more. Use it for budgeting, not exact limits.`,
        returns: 'the shortened text',
        exampleUsage: ['{{truncatetokens::{{lore::Backstory}}::150}}'],
        handler: ({ unnamedArgs: [text, maxTokens, ellipsis], warn }) => {
            const n = parseInteger(maxTokens, { warn, name: 'maxTokens' });
            if (n === null) {
                return String(text);
            }
            return truncateTokensText(text, n, ellipsis === undefined || ellipsis === '' ? '…' : ellipsis);
        },
    });

    safeRegister('tokencount', {
        category: CATEGORY_TEXT,
        unnamedArgs: [{ name: 'text', description: 'The text to estimate.' }],
        description: `Estimates the token count of the text (about ${CHARS_PER_TOKEN} characters per token). This is an estimate, not an exact count.`,
        returns: 'an estimated number of tokens',
        returnType: 'integer',
        exampleUsage: ['{{tokencount::{{charDescription}}}}'],
        handler: ({ unnamedArgs: [text] }) => String(estimateTokens(text)),
    });

    // ---- math ----

    safeRegister('calc', {
        aliases: [{ alias: 'math', visible: false }],
        category: CATEGORY_MATH,
        unnamedArgs: [{ name: 'expression', description: 'The expression to compute, e.g. "2 * (3 + 4)".' }],
        description: 'Computes an arithmetic expression. Supports + - * / % ^, parentheses, min, max, round, floor, ceil, abs, sqrt, pow, pi and e.',
        returns: 'the computed number',
        returnType: 'number',
        exampleUsage: ['{{calc::2 * (3 + 4)}}', '{{calc::max({{getvar::hp}}, 0)}}'],
        handler: ({ unnamedArgs: [expression], warn }) => {
            try {
                return formatNumber(evaluateExpression(expression));
            } catch (error) {
                if (error instanceof CalcError) {
                    warn(`Could not compute "${expression}": ${error.message}`);
                    return String(expression);
                }
                throw error;
            }
        },
    });

    safeRegister('round', {
        category: CATEGORY_MATH,
        unnamedArgs: [
            { name: 'value', type: 'number', description: 'The number to round.' },
            { name: 'decimals', type: 'integer', optional: true, defaultValue: '0', description: 'Decimal places to keep.' },
        ],
        description: 'Rounds a number to the given number of decimal places.',
        returns: 'the rounded number',
        returnType: 'number',
        exampleUsage: ['{{round::3.14159::2}}'],
        handler: ({ unnamedArgs: [value, decimals], warn }) => {
            const n = parseNumber(value, { warn, name: 'value' });
            if (n === null) {
                return String(value);
            }
            const d = decimals === undefined || decimals === '' ? 0 : parseInteger(decimals, { warn, name: 'decimals', fallback: 0 });
            return formatNumber(roundTo(n, d ?? 0));
        },
    });

    safeRegister('clamp', {
        category: CATEGORY_MATH,
        unnamedArgs: [
            { name: 'value', type: 'number', description: 'The number to clamp.' },
            { name: 'min', type: 'number', description: 'Lowest allowed value.' },
            { name: 'max', type: 'number', description: 'Highest allowed value.' },
        ],
        description: 'Limits a number to a range.',
        returns: 'the number, limited to the range',
        returnType: 'number',
        exampleUsage: ['{{clamp::{{getvar::hp}}::0::100}}'],
        handler: ({ unnamedArgs: [value, min, max], warn }) => {
            const n = parseNumber(value, { warn, name: 'value' });
            const lo = parseNumber(min, { warn, name: 'min' });
            const hi = parseNumber(max, { warn, name: 'max' });
            if (n === null || lo === null || hi === null) {
                return String(value);
            }
            return formatNumber(clampNumber(n, lo, hi));
        },
    });

    // {{calc}} already offers these as functions; they exist as macros of their own
    // so a value straight out of another macro can be passed without building an
    // expression string around it.
    const rounding = (name, apply, word) => {
        safeRegister(name, {
            category: CATEGORY_MATH,
            unnamedArgs: [{ name: 'value', type: 'number', description: 'The number to round.' }],
            description: `Rounds a number ${word}.`,
            returns: 'a whole number',
            returnType: 'integer',
            exampleUsage: [`{{${name}::{{calc::7 / 2}}}}`],
            handler: ({ unnamedArgs: [value], warn }) => {
                const n = parseNumber(value, { warn, name: 'value' });
                return n === null ? String(value) : formatNumber(apply(n));
            },
        });
    };
    rounding('floor', Math.floor, 'down to a whole number');
    rounding('ceil', Math.ceil, 'up to a whole number');

    const extreme = (name, pick, word) => {
        safeRegister(name, {
            category: CATEGORY_MATH,
            unnamedArgs: [
                { name: 'a', type: 'number', description: 'The first number.' },
                { name: 'b', type: 'number', description: 'The second number.' },
            ],
            description: `The ${word} of two numbers. For a whole list, use {{list${name}}}.`,
            returns: `the ${word} number`,
            returnType: 'number',
            exampleUsage: [`{{${name}::0::{{getchatvar::satiety_ren}}}}`],
            handler: ({ unnamedArgs: [a, b], warn }) => {
                const x = parseNumber(a, { warn, name: 'a' });
                const y = parseNumber(b, { warn, name: 'b' });
                if (x === null || y === null) {
                    return String(x === null ? a : b);
                }
                return formatNumber(pick(x, y));
            },
        });
    };
    extreme('min', Math.min, 'smaller');
    extreme('max', Math.max, 'larger');

    safeRegister('mod', {
        category: CATEGORY_MATH,
        unnamedArgs: [
            { name: 'value', type: 'number', description: 'The number to divide.' },
            { name: 'divisor', type: 'number', description: 'What to divide by.' },
        ],
        description: 'The remainder after dividing one number by another.',
        returns: 'the remainder',
        returnType: 'number',
        exampleUsage: ['{{mod::{{getchatvar::current_minutes}}::1440}}'],
        handler: ({ unnamedArgs: [value, divisor], warn }) => {
            const n = parseNumber(value, { warn, name: 'value' });
            const d = parseNumber(divisor, { warn, name: 'divisor' });
            if (n === null || d === null) {
                return String(value);
            }
            if (d === 0) {
                warn('{{mod}}: cannot divide by zero.');
                return String(value);
            }
            return formatNumber(n % d);
        },
    });

    // ---- lists ----

    safeRegister('join', {
        category: CATEGORY_LIST,
        unnamedArgs: [{ name: 'separator', description: 'Placed between the items.' }],
        list: { min: 1 },
        description: 'Joins the remaining arguments into one string.',
        returns: 'the joined text',
        exampleUsage: ['{{join::, ::sword::shield::potion}}'],
        handler: ({ unnamedArgs: [separator], list }) => (list ?? []).join(String(separator)),
    });

    safeRegister('item', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'index', type: 'integer', description: 'Position of the item (0 is first; negative counts from the end).' },
            { name: 'list', description: 'The list as one string.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'What separates the items.' },
        ],
        description: 'Picks one item out of a separated list.',
        returns: 'the item at that position, or empty when out of range',
        exampleUsage: ['{{item::0::red,green,blue}}', '{{item::-1::a;b;c::;}}'],
        handler: ({ unnamedArgs: [index, list, separator], warn }) => {
            const i = parseInteger(index, { warn, name: 'index' });
            if (i === null) {
                return '';
            }
            return itemAt(i, list, separator === undefined || separator === '' ? ',' : separator);
        },
    });

    safeRegister('count', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list as one string.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'What separates the items.' },
        ],
        description: 'Counts the items in a separated list.',
        returns: 'a whole number',
        returnType: 'integer',
        exampleUsage: ['{{count::red,green,blue}}'],
        handler: ({ unnamedArgs: [list, separator] }) => String(splitList(list, separator === undefined || separator === '' ? ',' : separator).length),
    });

    safeRegister('listsort', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'list', description: 'The list as one string.' },
            { name: 'separator', optional: true, defaultValue: ',', description: 'What separates the items.' },
            { name: 'order', optional: true, defaultValue: 'asc', description: '"asc" or "desc".' },
        ],
        description: 'Sorts a separated list alphabetically (numbers sort naturally).',
        returns: 'the sorted list',
        exampleUsage: ['{{listsort::banana,apple,cherry}}'],
        handler: ({ unnamedArgs: [list, separator, order] }) => {
            const sep = separator === undefined || separator === '' ? ',' : separator;
            return sortList(list, sep, order || 'asc').join(sep);
        },
    });

    safeRegister('jsonget', {
        category: CATEGORY_LIST,
        unnamedArgs: [
            { name: 'json', description: 'The JSON text.' },
            { name: 'path', description: 'The path to read, e.g. "user.name" or "items[0].id".' },
        ],
        description: 'Reads a value out of JSON text by path.',
        returns: 'the value at that path, or empty when it is missing',
        exampleUsage: ['{{jsonget::{{getvar::inventory}}::items[0].name}}'],
        handler: ({ unnamedArgs: [json, path], warn }) => {
            try {
                return jsonGet(json, path);
            } catch (error) {
                if (error instanceof JsonPathError) {
                    warn(`jsonget failed: ${error.message}`);
                    return '';
                }
                throw error;
            }
        },
    });
}
