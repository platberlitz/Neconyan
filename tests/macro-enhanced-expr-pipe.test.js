import { jest } from '@jest/globals';
import * as chevrotain from 'chevrotain';

await jest.unstable_mockModule('../public/lib.js', () => ({ chevrotain }));

const { MacroParser } = await import('../public/scripts/macros/engine/MacroParser.js');
const { rewriteIfConditions } = await import('../public/scripts/extensions/third-party/MacroEnhanced/src/compat-impl.js');

function parseErrors(input) {
    return MacroParser.parseDocument(input).errors.map(error => String(error.message).split('\n')[0]);
}

describe('the pipe limitation documented for {{expr}}', () => {
    test('a raw || inside {{expr}} cannot parse, so the reference recommends {{or}}', () => {
        expect(parseErrors('{{expr::a || b}}').length).toBeGreaterThan(0);
        expect(parseErrors('{{expr::a && b}}')).toEqual([]);
    });

    test('compat mode rewrites || inside {{if}} into parseable {{or}} macros', () => {
        const names = { expr: 'expr', or: 'or', and: 'and', not: 'not' };
        const rewritten = rewriteIfConditions('{{if::a || b}}yes{{/if}}', names);

        expect(rewritten).not.toContain('||');
        expect(rewritten).toContain('{{or::');
        expect(parseErrors(rewritten)).toEqual([]);
    });
});
