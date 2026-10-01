import { t } from '../../i18n.js';
import { regexFromString } from '../../regex-utils.js';

const FLAG_ORDER = 'dgimsuvy';

export const REGEX_FLAG_OPTIONS = Object.freeze([
    { flag: 'g', label: 'Every match', hint: 'Change every match, not just the first one.' },
    { flag: 'i', label: 'Ignore case', hint: 'Treat capital and small letters as the same.' },
    { flag: 's', label: 'Dot matches new lines', hint: 'Let . also match line breaks, so a match can span lines.' },
    { flag: 'm', label: '^ and $ per line', hint: 'Make ^ and $ match the start and end of every line, not only the whole text.' },
]);

export const REGEX_SNIPPETS = Object.freeze([
    { id: 'asterisks', label: 'Text in *asterisks*', pattern: '\\*([^*\\n]+)\\*' },
    { id: 'quotes', label: 'Text in "quotes"', pattern: '"([^"\\n]*)"' },
    { id: 'brackets', label: 'Text in [brackets]', pattern: '\\[([^\\]]*)\\]' },
    { id: 'tag', label: 'Any HTML tag', pattern: '<\\/?[a-z][^>]*>' },
    { id: 'word', label: 'Whole word', pattern: '\\bword\\b' },
    { id: 'anything', label: 'Anything (shortest)', pattern: '[\\s\\S]*?' },
    { id: 'digits', label: 'A number', pattern: '\\d+' },
    { id: 'line-start', label: 'Start of line', pattern: '^' },
    { id: 'line-end', label: 'End of line', pattern: '$' },
    { id: 'group', label: 'Capture group ( )', pattern: '()', wrap: true },
    { id: 'either', label: 'Either | or', pattern: '|' },
]);

export const REGEX_RECIPES = Object.freeze([
    { id: 'think', label: 'Remove thinking blocks', name: 'Remove thinking blocks', find: '/<think(?:ing)?>[\\s\\S]*?<\\/think(?:ing)?>\\s*/gi', replace: '' },
    { id: 'blank-lines', label: 'Collapse extra blank lines', name: 'Collapse blank lines', find: '/\\n{3,}/g', replace: '\\n\\n' },
    { id: 'html', label: 'Remove HTML tags', name: 'Remove HTML tags', find: '/<\\/?[a-z][^>]*>/gi', replace: '' },
    { id: 'brackets', label: 'Remove text in [brackets]', name: 'Remove bracketed notes', find: '/\\s*\\[[^\\]]*\\]/g', replace: '' },
    { id: 'quotes', label: 'Bold the dialogue', name: 'Bold dialogue', find: '/"([^"\\n]+)"/g', replace: '**"$1"**' },
    { id: 'swap', label: 'Swap one word for another', name: 'Swap a word', find: '/\\bcolor\\b/gi', replace: 'colour' },
    { id: 'trailing', label: 'Trim spaces at line ends', name: 'Trim trailing spaces', find: '/[ \\t]+$/gm', replace: '' },
]);

/**
 * Splits a Find Regex value the same way regexFromString reads it.
 * @param {string} input Find Regex value
 * @returns {{ source: string, flags: string, literal: boolean }}
 */
export function parseRegexInput(input) {
    const value = String(input ?? '');
    const match = value.match(/^\/([\s\S]+)\/([a-z]*)$/i);
    if (match) {
        return { source: match[1], flags: match[2], literal: true };
    }
    return { source: value, flags: '', literal: false };
}

/**
 * @param {string} flags Regex flags in any order
 * @returns {string} Unique flags in the order JavaScript prints them
 */
function sortFlags(flags) {
    return [...new Set(String(flags))].sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b)).join('');
}

/**
 * Turns one flag on or off, wrapping a plain pattern in slashes when needed.
 * @param {string} input Find Regex value
 * @param {string} flag Single flag letter
 * @param {boolean} enabled Whether the flag should be set
 * @returns {string} Updated Find Regex value
 */
export function setRegexFlag(input, flag, enabled) {
    const { source, flags } = parseRegexInput(input);
    if (!source) return String(input ?? '');
    const next = enabled ? flags + flag : flags.replaceAll(flag, '');
    return `/${source}/${sortFlags(next)}`;
}

/**
 * Inserts a snippet at the cursor, keeping it inside the slashes of a /pattern/flags value.
 * @param {string} input Find Regex value
 * @param {number} start Selection start
 * @param {number} end Selection end
 * @param {{ pattern: string, wrap?: boolean }} snippet Snippet to insert
 * @returns {{ value: string, cursor: number }}
 */
export function insertRegexSnippet(input, start, end, snippet) {
    const value = String(input ?? '');
    if (!value) {
        const cursor = 1 + (snippet.wrap ? 1 : snippet.pattern.length);
        return { value: `/${snippet.pattern}/g`, cursor };
    }

    const parsed = parseRegexInput(value);
    const min = parsed.literal ? 1 : 0;
    const max = parsed.literal ? 1 + parsed.source.length : value.length;
    const from = Math.min(Math.max(Number(start) || 0, min), max);
    const to = Math.min(Math.max(Number(end) || from, from), max);
    const selected = value.slice(from, to);
    const piece = snippet.wrap ? `(${selected})` : snippet.pattern;
    const cursor = from + (snippet.wrap ? (selected ? piece.length : 1) : piece.length);
    return { value: value.slice(0, from) + piece + value.slice(to), cursor };
}

const ESCAPES = Object.freeze({
    d: 'any digit (0-9)',
    D: 'any character that is not a digit',
    w: 'any letter, digit or underscore',
    W: 'any character that is not a letter, digit or underscore',
    s: 'any space, tab or line break',
    S: 'any character that is not a space',
    b: 'the edge of a word',
    B: 'a spot that is not the edge of a word',
    n: 'a line break',
    t: 'a tab',
    r: 'a carriage return',
});

/**
 * @param {string} source Pattern source
 * @param {number} index Index of a quantifier character
 * @returns {{ text: string, length: number } | null}
 */
function readQuantifier(source, index) {
    const char = source[index];
    let text = '';
    let length = 1;
    if (char === '*') text = 'repeated zero or more times';
    else if (char === '+') text = 'repeated one or more times';
    else if (char === '?') text = 'optional';
    else if (char === '{') {
        const match = source.slice(index).match(/^\{(\d+)(,?)(\d*)\}/);
        if (!match) return null;
        length = match[0].length;
        if (!match[2]) text = `exactly ${match[1]} times`;
        else if (!match[3]) text = `${match[1]} or more times`;
        else text = `between ${match[1]} and ${match[3]} times`;
    } else {
        return null;
    }
    if (source[index + length] === '?') {
        length += 1;
        text += ', as few as possible';
    }
    return { text, length };
}

/**
 * Lists the members of a character set, such as `a-z\\n"`, in plain words.
 * @param {string} inner Text between the square brackets
 * @returns {string} Comma-separated description
 */
function describeClassItems(inner) {
    const items = [];
    for (let index = 0; index < inner.length;) {
        let char = inner[index];
        let length = 1;
        if (char === '\\') {
            const next = inner[index + 1] ?? '';
            length = 2;
            if (ESCAPES[next]) {
                items.push(ESCAPES[next].replace(/^any /, ''));
                index += length;
                continue;
            }
            char = next;
        }
        if (inner[index + length] === '-' && index + length + 1 < inner.length) {
            const end = inner[index + length + 1] === '\\' ? inner[index + length + 2] ?? '' : inner[index + length + 1];
            items.push(`'${char}' to '${end}'`);
            index += length + (inner[index + length + 1] === '\\' ? 3 : 2);
            continue;
        }
        items.push(`'${char}'`);
        index += length;
    }
    return items.join(', ');
}

/**
 * Explains a Find Regex value piece by piece in plain words.
 * @param {string} input Find Regex value
 * @returns {{ token: string, text: string }[]} Explanation rows, in pattern order
 */
export function describeRegex(input) {
    const { source, flags } = parseRegexInput(input);
    const rows = [];
    if (!source) return rows;

    let literal = '';
    let groupCount = 0;
    const flushLiteral = () => {
        if (literal) rows.push({ token: literal, text: `the exact text '${literal}'` });
        literal = '';
    };
    const push = (token, text) => {
        flushLiteral();
        rows.push({ token, text });
    };

    for (let index = 0; index < source.length;) {
        const char = source[index];
        const quantifier = readQuantifier(source, index);
        if (quantifier && (rows.length || literal)) {
            const token = source.slice(index, index + quantifier.length);
            if (literal.length > 1) {
                const last = literal.slice(-1);
                literal = literal.slice(0, -1);
                flushLiteral();
                rows.push({ token: last, text: `the exact text '${last}'` });
            } else {
                flushLiteral();
            }
            push(token, `the piece before, ${quantifier.text}`);
            index += quantifier.length;
            continue;
        }

        if (char === '\\') {
            const next = source[index + 1] ?? '';
            if (ESCAPES[next]) {
                push(`\\${next}`, ESCAPES[next]);
            } else if (/\d/.test(next)) {
                push(`\\${next}`, `the same text that group ${next} matched`);
            } else {
                literal += next;
            }
            index += 2;
            continue;
        }

        if (char === '[') {
            let end = index + 1;
            if (source[end] === '^') end += 1;
            if (source[end] === ']') end += 1;
            while (end < source.length && source[end] !== ']') {
                end += source[end] === '\\' ? 2 : 1;
            }
            const token = source.slice(index, end + 1);
            const negated = token.startsWith('[^');
            const inner = describeClassItems(token.slice(negated ? 2 : 1, -1));
            push(token, negated ? `one character that is not any of: ${inner}` : `one character from: ${inner}`);
            index = end + 1;
            continue;
        }

        if (char === '(') {
            const rest = source.slice(index);
            const named = rest.match(/^\(\?<([a-zA-Z_]\w*)>/);
            if (named) {
                groupCount += 1;
                push(named[0], `start of group '${named[1]}' (use $<${named[1]}> in Replace With)`);
                index += named[0].length;
            } else if (rest.startsWith('(?:')) {
                push('(?:', 'start of a group that is not saved');
                index += 3;
            } else if (rest.startsWith('(?=')) {
                push('(?=', 'only if followed by');
                index += 3;
            } else if (rest.startsWith('(?!')) {
                push('(?!', 'only if not followed by');
                index += 3;
            } else if (rest.startsWith('(?<=')) {
                push('(?<=', 'only if preceded by');
                index += 4;
            } else if (rest.startsWith('(?<!')) {
                push('(?<!', 'only if not preceded by');
                index += 4;
            } else {
                groupCount += 1;
                push('(', `start of group ${groupCount} (use $${groupCount} in Replace With)`);
                index += 1;
            }
            continue;
        }

        if (char === ')') push(')', 'end of the group');
        else if (char === '|') push('|', 'or');
        else if (char === '.') push('.', flags.includes('s') ? 'any character, including line breaks' : 'any character except a line break');
        else if (char === '^') push('^', flags.includes('m') ? 'the start of a line' : 'the start of the text');
        else if (char === '$') push('$', flags.includes('m') ? 'the end of a line' : 'the end of the text');
        else literal += char;
        index += 1;
    }
    flushLiteral();
    return rows;
}

/**
 * Counts how many places the Find Regex changes in the sample text.
 * @param {string} input Find Regex value
 * @param {string} text Sample text
 * @returns {number} Match count, or -1 when the pattern is invalid
 */
export function countRegexMatches(input, text) {
    if (!input) return 0;
    const regex = regexFromString(String(input));
    if (!regex) return -1;
    if (!regex.flags.includes('g')) return regex.test(String(text ?? '')) ? 1 : 0;
    let count = 0;
    for (const match of String(text ?? '').matchAll(regex)) {
        count += 1;
        if (!match[0] && count > 10000) break;
    }
    return count;
}

/**
 * @param {string} tag Element tag
 * @param {string} className Class list
 * @param {string} [text] Text content
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Adds recipes, flag switches, snippet buttons, a plain explanation and test tools to the regex editor.
 * @param {HTMLElement} root Editor root
 * @param {{ getSampleText?: () => string, onChange?: () => void }} [options]
 */
export function setupRegexEditorHelpers(root, { getSampleText, onChange } = {}) {
    const find = /** @type {HTMLInputElement} */ (root.querySelector('.find_regex'));
    const helpers = root.querySelector('.regex_helpers');
    if (!find || !helpers) return;

    const notify = () => {
        find.dispatchEvent(new Event('input', { bubbles: true }));
        onChange?.();
    };

    const recipeSelect = /** @type {HTMLSelectElement} */ (root.querySelector('.regex_recipe_select'));
    if (recipeSelect) {
        recipeSelect.append(new Option(t`Choose a recipe...`, ''));
        for (const recipe of REGEX_RECIPES) recipeSelect.append(new Option(t([recipe.label]), recipe.id));
        recipeSelect.addEventListener('change', () => {
            const recipe = REGEX_RECIPES.find(item => item.id === recipeSelect.value);
            recipeSelect.value = '';
            if (!recipe) return;
            const name = /** @type {HTMLInputElement} */ (root.querySelector('.regex_script_name'));
            const replace = /** @type {HTMLTextAreaElement} */ (root.querySelector('.regex_replace_string'));
            if (name && !name.value.trim()) name.value = t([recipe.name]);
            find.value = recipe.find;
            if (replace) replace.value = recipe.replace.replaceAll('\\n', '\n');
            notify();
        });
    }

    const flagHost = helpers.querySelector('.regex_flag_chips');
    const flagInputs = REGEX_FLAG_OPTIONS.map(option => {
        const label = element('label', 'regex_helper_chip checkbox');
        label.title = t([option.hint]);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.regexFlag = option.flag;
        input.addEventListener('change', () => {
            find.value = setRegexFlag(find.value, option.flag, input.checked);
            notify();
        });
        label.append(input, element('span', '', t([option.label])), element('code', '', option.flag));
        flagHost?.append(label);
        return input;
    });

    const snippetHost = helpers.querySelector('.regex_snippet_chips');
    for (const snippet of REGEX_SNIPPETS) {
        const button = element('button', 'menu_button regex_helper_chip', t([snippet.label]));
        button.type = 'button';
        button.dataset.regexSnippet = snippet.id;
        button.addEventListener('click', () => {
            const { value, cursor } = insertRegexSnippet(find.value, find.selectionStart ?? find.value.length, find.selectionEnd ?? find.value.length, snippet);
            find.value = value;
            find.focus();
            find.setSelectionRange(cursor, cursor);
            notify();
        });
        snippetHost?.append(button);
    }

    const explainList = helpers.querySelector('.regex_explain_list');
    const testInput = /** @type {HTMLTextAreaElement} */ (root.querySelector('#regex_test_input'));
    const matchCount = root.querySelector('.regex_test_matches');

    const refresh = () => {
        const { source, flags } = parseRegexInput(find.value);
        for (const input of flagInputs) {
            input.checked = flags.includes(input.dataset.regexFlag);
            input.disabled = !source;
        }
        if (explainList) {
            explainList.replaceChildren();
            const rows = describeRegex(find.value);
            if (!rows.length) explainList.append(element('li', 'regex_explain_empty', t`Type a pattern or pick a piece above to see what it does.`));
            for (const row of rows) {
                const item = element('li', '');
                item.append(element('code', '', row.token), element('span', '', t([row.text])));
                explainList.append(item);
            }
        }
        if (matchCount && testInput) {
            const count = countRegexMatches(find.value, testInput.value);
            matchCount.textContent = count < 0
                ? t`The pattern has a mistake, so nothing matches.`
                : count === 1 ? t`1 match in the sample.` : t`${count} matches in the sample.`;
        }
    };

    const useLast = root.querySelector('.regex_test_use_last');
    useLast?.addEventListener('click', () => {
        const text = getSampleText?.() ?? '';
        if (!testInput) return;
        if (!text) {
            toastr.info(t`There is no reply in this chat yet.`);
            return;
        }
        testInput.value = text;
        testInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    root.addEventListener('input', (event) => {
        // Flag boxes fire 'input' before their 'change' handler rewrites the pattern.
        if (/** @type {HTMLElement} */ (event.target)?.dataset?.regexFlag) return;
        refresh();
    });
    refresh();
}

/**
 * Hides script rows whose name does not contain the search text.
 * @param {ParentNode} root Element holding the script lists
 * @param {string} query Search text
 * @returns {number} Number of rows left visible
 */
export function filterRegexScriptRows(root, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    let visible = 0;
    for (const row of root.querySelectorAll('.regex-script-label')) {
        const name = row.querySelector('.regex_script_name')?.textContent?.toLowerCase() ?? '';
        const shown = !needle || name.includes(needle);
        row.classList.toggle('regex_filtered_out', !shown);
        if (shown) visible += 1;
    }
    return visible;
}
