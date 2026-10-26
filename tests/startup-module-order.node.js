import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const waitFunction = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'waitForPageLoad');

test('the cyclic core module finishes evaluation before asynchronous startup', () => {
    function inspect(node) {
        if (!node || typeof node !== 'object') return;
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
        assert.notEqual(node.type, 'AwaitExpression', 'Top-level await exposes uninitialised settings and translations in WebKit');
        assert.ok(!(node.type === 'ForOfStatement' && node.await), 'Top-level for-await also suspends the module');
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(inspect);
            else if (value && typeof value === 'object') inspect(value);
        }
    }
    inspect(tree);
    const ready = tree.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.name === 'jQuery');
    assert.ok(ready, 'The main ready handler must remain registered');
    const first = ready.expression.arguments[0].body.body[0].expression;
    assert.equal(first.type, 'AwaitExpression');
    assert.equal(first.argument.callee.name, 'waitForPageLoad');
});

test('startup waits for page resources while leaving module evaluation synchronous', async () => {
    const listeners = [];
    const document = { readyState: 'interactive' };
    const context = vm.createContext({ document, window: { addEventListener: (...args) => listeners.push(args) } });
    vm.runInContext(source.slice(waitFunction.start, waitFunction.end), context);
    let continued = false;
    const pending = vm.runInContext('waitForPageLoad()', context).then(() => { continued = true; });
    await Promise.resolve();
    assert.equal(continued, false);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0][0], 'load');
    assert.equal(listeners[0][2].once, true);
    listeners[0][1]();
    await pending;
    assert.equal(continued, true);
    document.readyState = 'complete';
    await vm.runInContext('waitForPageLoad()', context);
    assert.equal(listeners.length, 1, 'An already loaded page needs no new event');
});
