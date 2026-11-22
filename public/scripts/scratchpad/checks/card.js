/**
 * Fixed checks for a character card. Pure and dependency-free: the caller
 * supplies token counting, known macros and the lorebooks that exist.
 */
import { scanMacroProblems } from './macros.js';

const GREETING_FIELDS = ['alternate_greetings', 'group_only_greetings'];
const PERMANENT_FIELDS = ['description', 'personality', 'scenario', 'system_prompt', 'post_history_instructions'];
const TOKEN_FIELDS = [
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
    ['first_mes', 'First message'],
    ['alternate_greetings', 'Alternate greetings'],
    ['group_only_greetings', 'Group-only greetings'],
    ['mes_example', 'Example messages'],
    ['creator_notes', 'Creator\'s notes'],
    ['system_prompt', 'System prompt'],
    ['post_history_instructions', 'Post-history instructions'],
];
// Tags whose end tag is optional are left out: unclosed <p> and <li> are valid HTML.
const CHECKED_HTML_TAGS = new Set(['b', 'i', 'em', 'strong', 'div', 'span', 'blockquote', 'u', 's', 'small', 'big', 'font', 'a', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const USER_SPEECH = /(^|\n)\s*\*{0,2}\s*\{\{\s*user\s*\}\}\s*\*{0,2}\s*(?::|says\b|said\b|asks\b|replies\b|smiles\b|nods\b|laughs\b|sighs\b|turns\b|walks\b|looks\b|leans\b|shakes\b|reaches\b)/i;
// The acting subject must be {{user}}, not merely mentioned later in the line.
const USER_ACTION = /(^|\n)\s*\*{0,2}\s*\{\{\s*user\s*\}\}(?=\s)/i;

function fieldValue(character, field) {
    const data = character?.data?.[field];
    if (typeof data === 'string' && data.trim()) return data.trim();
    const top = field === 'creator_notes' ? character?.creatorcomment : character?.[field];
    return String(top ?? '').trim();
}

function fieldList(character, field) {
    const fromData = character?.data?.[field];
    const fromTop = character?.[field];
    const value = Array.isArray(fromData) ? fromData : Array.isArray(fromTop) ? fromTop : [];
    return value.map(item => String(item ?? ''));
}

function extraLorebooks(character, extraBooks) {
    const filename = String(character?.avatar ?? '').replace(/\.[^.]+$/, '');
    const list = Array.isArray(extraBooks)
        ? extraBooks
        : Array.isArray(extraBooks?.[filename]) ? extraBooks[filename] : [];
    return list.map(item => String(item ?? '').trim()).filter(Boolean);
}

/** Every <style> block a card can carry, plus the surrounding saved text. */
export function cardCssSources(character) {
    const values = [
        ...TOKEN_FIELDS.map(([field]) => fieldValue(character, field)),
        fieldValue(character, 'character_version'),
        fieldValue(character, 'creator'),
    ];
    const blocks = [];
    let styleOpen = 0;
    let styleClose = 0;
    for (const value of values) {
        for (const match of value.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style>|$)/gi)) {
            blocks.push(match[1]);
        }
        styleOpen += (value.match(/<style\b/gi) || []).length;
        styleClose += (value.match(/<\/style>/gi) || []).length;
    }
    return { css: blocks.join('\n'), styleOpen, styleClose };
}

const APP_SHELL_IDS = new Set(['chat', 'sheld', 'send_form', 'send_textarea', 'top-bar', 'top-settings-holder', 'left-nav-panel', 'right-nav-panel', 'movingDivs']);

/** Every id the card's own fields define, so card CSS can target its own markup. */
export function cardDefinedIds(character) {
    const ids = new Set();
    for (const [field] of TOKEN_FIELDS) {
        const values = field === 'alternate_greetings' || field === 'group_only_greetings' ? fieldList(character, field) : [fieldValue(character, field)];
        for (const value of values) {
            for (const match of String(value ?? '').matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi)) {
                const id = (match[1] || match[2] || match[3] || '').trim();
                if (id) ids.add(id);
            }
        }
    }
    return ids;
}

/** Selectors that cannot work once card CSS is scoped to .mes_text. */
export function brokenCardSelectors(css, definedIds = new Set()) {
    const broken = [];
    const cleaned = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of cleaned.matchAll(/([^{}]+)\{/g)) {
        const prelude = block[1].trim();
        if (!prelude || prelude.startsWith('@')) continue;
        for (const selector of prelude.split(',').map(item => item.trim()).filter(Boolean)) {
            if (/^from\b|^to\b|^\d+%$/.test(selector)) continue;
            const ids = [...selector.matchAll(/#([A-Za-z_][\w-]*)/g)].map(match => match[1]);
            const unknownId = ids.find(id => !APP_SHELL_IDS.has(id) && !definedIds.has(id));
            if (unknownId || ids.some(id => APP_SHELL_IDS.has(id)) || /(^|[^-\w])(body|html|:root)([^-\w]|$)/i.test(selector)) {
                if (!broken.includes(selector)) broken.push(selector);
            }
        }
    }
    return broken;
}

/** The first obviously unbalanced HTML tag in a greeting, if any. */
export function unbalancedHtml(text) {
    const stack = [];
    for (const match of String(text ?? '').matchAll(/<\s*(\/?)\s*([A-Za-z][\w-]*)([^>]*)>/g)) {
        const [, closing, rawName, rest] = match;
        const name = rawName.toLowerCase();
        if (!CHECKED_HTML_TAGS.has(name)) continue;
        if (rest.trim().endsWith('/')) continue;
        if (!closing) {
            stack.push(name);
        } else if (stack.at(-1) === name) {
            stack.pop();
        } else {
            return `</${name}>`;
        }
    }
    return stack.length ? `<${stack.at(-1)}>` : '';
}

function target(name, field) {
    return { kind: 'card', name, ...(field ? { field } : {}) };
}

function finding(name, field, rule, severity, message, details) {
    return { rule, severity, target: target(name, field), message, ...(details ? { details } : {}) };
}

/**
 * Checks one card.
 * @param {object} character Character record, with data and shallow
 * @param {{name?: string, contextSize?: number, knownMacros?: Iterable<string>, knownLorebooks?: Iterable<string>, extraBooks?: string[]|Record<string, string[]>, countTokens?: (text: string) => number|Promise<number>}} options Check context
 * @returns {Promise<{findings: object[], name: string}>}
 */
export async function checkCharacterCard(character, { name, contextSize = 0, knownMacros = [], knownLorebooks = [], extraBooks = [], countTokens = text => Math.ceil(String(text ?? '').length / 4) } = {}) {
    const cardName = String(name || character?.name || 'Character').trim();
    const findings = [];
    const push = (field, rule, severity, message, details) => findings.push(finding(cardName, field, rule, severity, message, details));

    const card = fieldValue(character, 'name') || character?.name || '';
    if (!String(card).trim()) push('name', 'card-empty-name', 'error', 'The name field is empty.');
    if (!fieldValue(character, 'description')) push('description', 'card-empty-description', 'error', 'The description is empty, so the character has no grounding.');
    if (!fieldValue(character, 'first_mes')) push('first_mes', 'card-empty-first-message', 'error', 'There is no first message, so the card cannot open a chat by itself.');

    const greetings = [['first_mes', fieldValue(character, 'first_mes')], ...GREETING_FIELDS.flatMap(field => fieldList(character, field).map((text, index) => [field, text, index + 1]))];
    for (const [field, text, index] of greetings) {
        if (!text) continue;
        if (USER_SPEECH.test(text) || USER_ACTION.test(text)) {
            push(field, 'card-writes-user', 'warning', `Greeting${index ? ` ${index}` : ''} appears to write speech or actions for {{user}}.`);
        }
        const html = unbalancedHtml(text);
        if (html) push(field, 'card-unbalanced-html', 'warning', `Greeting${index ? ` ${index}` : ''} has an unbalanced HTML tag ${html}.`);
    }

    const examples = fieldValue(character, 'mes_example');
    if (examples && !/^\s*<START>/i.test(examples)) {
        push('mes_example', 'card-example-format', 'warning', 'Example messages should begin with a <START> block.');
    }

    for (const field of GREETING_FIELDS) {
        const list = fieldList(character, field);
        const seen = new Map();
        list.forEach((text, index) => {
            const trimmed = text.trim();
            if (!trimmed) push(field, 'card-empty-greeting', 'warning', `Greeting ${index + 1} is empty.`);
            else if (seen.has(trimmed)) push(field, 'card-duplicate-greeting', 'warning', `Greeting ${index + 1} repeats greeting ${seen.get(trimmed)}.`);
            else seen.set(trimmed, index + 1);
        });
    }

    const { css, styleOpen, styleClose } = cardCssSources(character);
    if (styleOpen > styleClose) push('', 'card-unclosed-style', 'error', 'A <style> block is opened but never closed.');
    for (const selector of brokenCardSelectors(css, cardDefinedIds(character))) {
        const shell = [...selector.matchAll(/#([A-Za-z_][\w-]*)/g)].map(match => match[1]).find(id => APP_SHELL_IDS.has(id));
        push('', 'card-css-selector', 'warning', shell
            ? `CSS selector ${selector} cannot match: #${shell} belongs to the app shell, outside the message.`
            : `CSS selector ${selector} may not match: this card defines no element with that id.`);
    }

    const knownBooks = new Set([...knownLorebooks].map(item => String(item)));
    const linked = String(character?.data?.extensions?.world ?? '').trim();
    if (linked && knownBooks.size && !knownBooks.has(linked)) {
        push('', 'card-lorebook-missing', 'warning', `The linked lorebook ${linked} does not exist.`);
    }
    for (const book of extraLorebooks(character, extraBooks)) {
        if (knownBooks.size && !knownBooks.has(book)) push('', 'card-lorebook-missing', 'warning', `The extra lorebook ${book} does not exist.`);
    }

    // Structural problems need no registry; an empty list skips only the unknown-name rule.
    for (const [field] of TOKEN_FIELDS) {
        const text = field === 'alternate_greetings' || field === 'group_only_greetings'
            ? fieldList(character, field).join('\n')
            : fieldValue(character, field);
        if (!text) continue;
        for (const item of scanMacroProblems(text, { knownNames: knownMacros })) {
            push(field, item.rule, item.severity, item.message, item.details);
        }
    }
    const note = String(character?.data?.extensions?.depth_prompt?.prompt ?? '').trim();
    for (const item of scanMacroProblems(note, { knownNames: knownMacros })) {
        push('extensions.depth_prompt.prompt', item.rule, item.severity, item.message, item.details);
    }

    let permanent = 0;
    const weighted = [
        ...TOKEN_FIELDS.filter(([field]) => !GREETING_FIELDS.includes(field)),
        ['extensions.depth_prompt.prompt', 'Character\'s note'],
    ];
    for (const [field, label] of weighted) {
        const text = field === 'extensions.depth_prompt.prompt'
            ? String(character?.data?.extensions?.depth_prompt?.prompt ?? '')
            : field.endsWith('_greetings') ? fieldList(character, field).join('\n') : fieldValue(character, field);
        if (!text) continue;
        const tokens = Number(await countTokens(text)) || 0;
        if (PERMANENT_FIELDS.includes(field) || field === 'extensions.depth_prompt.prompt') permanent += tokens;
        push(field, 'card-field-tokens', 'info', `${label} uses about ${tokens} tokens.`);
    }
    const permanentText = [...PERMANENT_FIELDS.map(field => fieldValue(character, field)), String(character?.data?.extensions?.depth_prompt?.prompt ?? '')].join('\n');
    permanent = Number(await countTokens(permanentText)) || permanent;
    if (contextSize > 0 && permanent > contextSize / 2) {
        push('', 'card-permanent-tokens', 'warning', `Permanent text uses about ${permanent} of ${contextSize} context tokens, over half the context.`);
    } else if (contextSize > 0) {
        push('', 'card-permanent-tokens', 'info', `Permanent text uses about ${permanent} of ${contextSize} context tokens.`);
    }

    if (character?.shallow) {
        push('', 'card-shallow', 'info', 'Only part of this card is loaded, so it was not fully checked.');
    }
    return { kind: 'card', findings, name: cardName };
}
