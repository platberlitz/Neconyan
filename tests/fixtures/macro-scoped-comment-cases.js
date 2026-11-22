/**
 * Real-evaluator results for the comment macro in its scoped form.
 *
 * `before` was captured by evaluating `input` with the macro sources of origin/staging
 * (19ace18c) through `createMacroEnvironment` in src/macros/index.js; `after` is what
 * the fixed sources must give. `changed: false` rows must be identical in both.
 */
export const SCOPED_COMMENT_CASES = [
    { name: 'inline comment', input: 'A{{// hidden}}B', before: 'AB', after: 'AB' },
    { name: 'inline comment alias', input: 'A{{comment x}}B', before: 'AB', after: 'AB' },
    { name: 'scoped comment', input: 'A{{//}}hidden{{///}}B', before: 'AhiddenB', after: 'AB' },
    { name: 'multi-line scoped comment', input: 'A{{//}}First\nSecond{{///}}B', before: 'AFirst\nSecondB', after: 'AB' },
    { name: 'scoped comment alias', input: 'A{{comment}}x{{/comment}}B', before: 'A{{comment}}x{{/comment}}B', after: 'AB' },
    { name: 'scoped alias, any case', input: '{{COMMENT}}x{{/Comment}}', before: '{{COMMENT}}x{{/Comment}}', after: '' },
    { name: 'spaces inside the braces', input: 'A{{//}}hidden{{///}}B{{ // }}c{{ /// }}D', before: 'AhiddenBcD', after: 'ABD' },
    { name: 'flag on the opener', input: '{{#//}}x{{///}}', before: 'x', after: '' },
    { name: 'nested scoped comments', input: 'A{{//}}a{{//}}b{{///}}c{{///}}B', before: 'AabcB', after: 'AB' },
    { name: 'two scoped comments', input: 'A{{//}}x{{///}}B{{//}}y{{///}}C', before: 'AxByC', after: 'ABC' },
    { name: 'empty scoped comment', input: 'A{{//}}{{///}}B', before: 'AB', after: 'AB' },
    { name: 'stray braces inside the text', input: 'A{{//}}a { b }} c{{///}}B', before: 'Aa { b }} cB', after: 'AB' },
    { name: 'unclosed macro inside the text', input: 'A{{//}}a } b {{ c{{///}}B', before: 'Aa } b {{ c{{///}}B', after: 'Aa } b {{ c{{///}}B' },
    { name: 'unknown macro inside the text', input: '{{//}}{{unknownmacro}}{{///}}', before: '{{unknownmacro}}', after: '' },
    { name: 'scoped macro inside the text', input: '{{//}}{{if 1}}a{{/if}}{{///}}', before: 'a', after: '' },
    { name: 'inside another scope', input: '{{if 1}}a{{//}}z{{///}}b{{/if}}', before: 'azb', after: 'ab' },
    { name: 'inside trim', input: '{{trim}}  {{//}}h{{///}}  a  {{/trim}}', before: 'h  a', after: 'a' },
    { name: 'inside an inline argument', input: '{{if 1::a{{//}}z{{///}}b}}', before: '{{if 1::a{{//}}z{{///}}b}}', after: '{{if 1::a{{//}}z{{///}}b}}' },
    { name: 'setvar inside a scoped comment', input: '{{//}}{{setvar::x::1}}{{///}}[{{getvar::x}}]', before: '[1]', after: '[1]' },
    { name: 'setvar inside an inline comment', input: '{{// {{setvar::x::1}}}}[{{getvar::x}}]', before: '[1]', after: '[1]' },
    { name: 'lone opener', input: 'A{{//}}B', before: 'AB', after: 'AB' },
    { name: 'lone opener before text', input: 'A{{//}}text', before: 'Atext', after: 'Atext' },
    { name: 'opener and closer of different names', input: '{{//}}x{{/comment}}', before: 'x{{/comment}}', after: 'x{{/comment}}' },
    { name: 'stray closer', input: 'A{{///}}B', before: 'AB', after: 'AB' },
    { name: 'stray closer after text', input: 'x{{///}}', before: 'x', after: 'x' },
    { name: 'second closer is stray', input: '{{//}}a{{///}}b{{///}}c', before: 'abc', after: 'bc' },
    { name: 'stray alias closer', input: 'A{{/comment}}B', before: 'A{{/comment}}B', after: 'A{{/comment}}B' },
    { name: 'inline comment before a closer', input: 'A{{// x}}b{{///}}C', before: 'AbC', after: 'AbC' },
    { name: 'if and else', input: '{{if 1}}a{{else}}b{{/if}}', before: 'a', after: 'a' },
    { name: 'trim scope', input: '[{{trim}} x {{/trim}}]', before: '[x]', after: '[x]' },
    { name: 'setvar scope', input: '{{setvar::a}}v{{/setvar}}{{getvar::a}}', before: 'v', after: 'v' },
].map(entry => ({ ...entry, changed: entry.before !== entry.after }));

/** What `MacroCstWalker.findUnclosedScopes` returns (names only) before and after the fix. */
export const UNCLOSED_SCOPE_CASES = [
    { input: '{{//}}a', before: [], after: ['//'] },
    { input: '{{//}}a{{///}}', before: [], after: [] },
    { input: '{{// x}}', before: [], after: [] },
    { input: '{{comment}}a', before: [], after: ['comment'] },
    { input: '{{comment}}a{{/comment}}', before: [], after: [] },
    { input: '{{if 1}}{{//}}a', before: ['if'], after: ['if', '//'] },
    { input: '{{///}}', before: [], after: [] },
];
