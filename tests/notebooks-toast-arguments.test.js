import fs from 'node:fs';
import { expect, test } from '@jest/globals';
import { parse } from 'acorn';

const directory = new URL('../public/scripts/notebooks/', import.meta.url);
const kinds = new Set(['success', 'info', 'warning', 'error']);

function calls(node, found = []) {
    if (Array.isArray(node)) {
        for (const item of node) calls(item, found);
    } else if (node && typeof node.type === 'string') {
        if (node.type === 'CallExpression') found.push(node);
        for (const [key, value] of Object.entries(node)) if (key !== 'type' && value && typeof value === 'object') calls(value, found);
    }
    return found;
}

const isToast = callee => (callee.type === 'Identifier' && callee.name === 'toast')
    || (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'toast');
const isKind = node => node.type === 'Literal' && kinds.has(node.value);
const validKind = node => isKind(node) || (node.type === 'ConditionalExpression' && isKind(node.consequent) && isKind(node.alternate));

test('every Notes toast call passes the kind first and the message second', () => {
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.js'));
    const problems = [];
    let found = 0;
    for (const file of files) {
        const ast = parse(fs.readFileSync(new URL(file, directory), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
        for (const call of calls(ast).filter(item => isToast(item.callee))) {
            found++;
            const place = `${file}:${call.loc.start.line}`;
            if (call.arguments.length !== 2) problems.push(`${place} passes ${call.arguments.length} arguments, expected 2`);
            else if (!validKind(call.arguments[0])) problems.push(`${place} does not pass success, info, warning or error as its first argument`);
        }
    }
    expect(found).toBeGreaterThanOrEqual(50);
    expect(problems).toEqual([]);
});
