// Small tools typed as commands at the start of a line in the Scratchpad box. Each command line is replaced by its
// result before the message is sent, so the assistant reads the outcome as plain text and no tool-calling model is needed.

export const TYPED_TOOL_NAMES = Object.freeze(['roll', 'calc', 'pick', 'now']);
export const MAX_ROLL_DICE = 100;
export const MAX_ROLL_SIDES = 1000;
export const MAX_CALC_LENGTH = 200;
export const MAX_PICK_OPTIONS = 50;

const COMMAND = /^\/([a-z]+)(?:[ \t]+(.*))?$/i;
const ROLL_TERM = /([+-]?)\s*(?:(\d*)d(\d+)|(\d+))\s*/gyi;

export class TypedToolError extends Error {
    constructor(code, line) {
        super(code);
        this.code = code;
        this.line = line;
    }
}

function secureInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buffer = new Uint32Array(1);
    do globalThis.crypto.getRandomValues(buffer); while (buffer[0] >= limit);
    return buffer[0] % max;
}

function roll(input, line, randomInt) {
    const source = input.trim();
    ROLL_TERM.lastIndex = 0;
    const terms = [];
    let end = 0;
    for (let match = ROLL_TERM.exec(source); match; match = ROLL_TERM.exec(source)) {
        if (terms.length && !match[1]) break;
        terms.push(match);
        end = ROLL_TERM.lastIndex;
    }
    if (!terms.some(term => term[3])) throw new TypedToolError('roll', line);
    const note = source.slice(end).trim();
    const parts = [];
    let total = 0;
    let dice = 0;
    for (const [, sign, count, sides, flat] of terms) {
        const negative = sign === '-';
        if (flat !== undefined) {
            const value = Number(flat);
            if (value > 1_000_000) throw new TypedToolError('roll', line);
            total += negative ? -value : value;
            parts.push({ negative, text: String(value) });
            continue;
        }
        const amount = count === '' ? 1 : Number(count);
        const faces = Number(sides);
        dice += amount;
        if (amount < 1 || dice > MAX_ROLL_DICE || faces < 2 || faces > MAX_ROLL_SIDES) throw new TypedToolError('roll-limit', line);
        const rolled = Array.from({ length: amount }, () => randomInt(faces) + 1);
        const sum = rolled.reduce((left, right) => left + right, 0);
        total += negative ? -sum : sum;
        parts.push({ negative, text: `[${rolled.join(', ')}]` });
    }
    const notation = terms.map(([, sign, count, sides, flat], index) =>
        `${index || sign === '-' ? (sign === '-' ? '-' : '+') : ''}${flat ?? `${count === '' ? 1 : Number(count)}d${Number(sides)}`}`).join('');
    const shown = parts.map((part, index) => `${index ? (part.negative ? ' - ' : ' + ') : (part.negative ? '-' : '')}${part.text}`).join('');
    return `\u{1F3B2} ${notation}${note ? ` (${note})` : ''}: ${shown} = ${total}`;
}

function calculate(input, line) {
    const source = input.replace(/\s+/g, '').replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/,/g, '.');
    if (!source || source.length > MAX_CALC_LENGTH) throw new TypedToolError('calc', line);
    let position = 0;
    let depth = 0;
    const fail = () => { throw new TypedToolError('calc', line); };
    const number = () => {
        const match = /^(?:\d+\.?\d*|\.\d+)/.exec(source.slice(position));
        if (!match) fail();
        position += match[0].length;
        return Number(match[0]);
    };
    const atom = () => {
        if (source[position] === '(') {
            position += 1;
            if ((depth += 1) > 50) fail();
            const value = sum();
            if (source[position] !== ')') fail();
            position += 1;
            depth -= 1;
            return value;
        }
        return number();
    };
    const unary = () => {
        if (source[position] === '-') { position += 1; return -unary(); }
        if (source[position] === '+') { position += 1; return unary(); }
        const base = atom();
        if (source[position] !== '^') return base;
        position += 1;
        return base ** unary();
    };
    const product = () => {
        let value = unary();
        while ('*/%'.includes(source[position] ?? ' ')) {
            const operator = source[position];
            position += 1;
            const right = unary();
            value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
        }
        return value;
    };
    function sum() {
        let value = product();
        while ('+-'.includes(source[position] ?? ' ')) {
            const operator = source[position];
            position += 1;
            const right = product();
            value = operator === '+' ? value + right : value - right;
        }
        return value;
    }
    const value = sum();
    if (position !== source.length) fail();
    if (!Number.isFinite(value)) throw new TypedToolError('calc-result', line);
    return `\u{1F9EE} ${input.trim().replace(/\s+/g, ' ')} = ${Number(value.toPrecision(12))}`;
}

function pick(input, line, randomInt, labels) {
    const options = input.split(input.includes('|') ? '|' : ',').map(item => item.trim()).filter(Boolean);
    if (options.length < 2 || options.length > MAX_PICK_OPTIONS) throw new TypedToolError('pick', line);
    return `\u{1F3AF} ${labels.picked}: ${options[randomInt(options.length)]} (${labels.from}: ${options.join(', ')})`;
}

/**
 * Replaces every command line of a message with its result.
 * @param {string} text The typed message.
 * @param {{ randomInt?: (max: number) => number, now?: Date, locale?: string, labels?: { picked: string, from: string, now: string } }} [options]
 * @returns {{ text: string, used: string[], help: boolean }} `help` is true when the message only asks for the command list.
 */
export function expandTypedTools(text, { randomInt = secureInt, now = new Date(), locale, labels = { picked: 'Picked', from: 'from', now: 'Now' } } = {}) {
    const source = String(text ?? '');
    if (/^\/(?:tools|help)\s*$/i.test(source.trim())) return { text: source, used: [], help: true };
    const used = [];
    let fenced = false;
    const lines = source.split('\n').map(line => {
        if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
        const match = fenced ? null : COMMAND.exec(line.trimEnd());
        const name = match?.[1].toLowerCase();
        if (!TYPED_TOOL_NAMES.includes(name)) return line;
        const input = match[2] ?? '';
        used.push(name);
        if (name === 'roll') return roll(input, line, randomInt);
        if (name === 'calc') return calculate(input, line);
        if (name === 'pick') return pick(input, line, randomInt, labels);
        return `\u{1F552} ${labels.now}: ${now.toLocaleString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    });
    return { text: used.length ? lines.join('\n') : source, used, help: false };
}
