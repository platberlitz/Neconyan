import assert from 'node:assert/strict';
import test from 'node:test';
import { MacroRegistry, registerMacros } from '../src/macros/index.js';
import { scanMacroProblems } from '../public/scripts/scratchpad/checks/macros.js';

registerMacros();
const knownNames = MacroRegistry.getAllMacros().map(definition => definition.name);

test('every registered macro example passes the Scratchpad macro scanner', () => {
    const failures = [];
    for (const definition of MacroRegistry.getAllMacros()) {
        for (const text of [definition.exampleUsage].flat()) {
            if (!text) continue;
            for (const finding of scanMacroProblems(text, { knownNames })) {
                failures.push(`${definition.name}: ${text}: ${finding.rule}: ${finding.message}`);
            }
        }
    }
    assert.deepEqual(failures, []);
});

test('the scanner follows the macro engine\'s scoped pairing and flags only real problems', () => {
    for (const text of [
        '{{if 1}}yes{{else}}no{{/if}}',
        'x{{trim}}  y  {{/trim}}z',
        '{{setvar::a}}val{{/setvar}}[{{getvar::a}}]',
        '{{if {{getvar::a}}}}h{{/if}}',
        '{{#user}} hi',
        '{{#if 1}}x{{/if}}',
        '{{time_UTC+2}}',
    ]) {
        assert.deepEqual(scanMacroProblems(text, { knownNames }), [], text);
    }
    assert.equal(scanMacroProblems('{{notARealMacro}}', { knownNames })[0]?.rule, 'macro-unknown');
    assert.equal(scanMacroProblems('{{/if}}', { knownNames })[0]?.severity, 'info');
});
