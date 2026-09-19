// Captured from the real browser at 8e538b4ef before extraction.
export const modern = [
    ['{{char}}/{{user}}', 'Char/User'], ['\\{{char\\}}', '\\Char'], ['a{{trim}}b', 'ab'],
    ['{{setvar::probe::5}}{{getvar::probe}}', '5'], ['{{incvar::probe}}{{getvar::probe}}', '66'],
    ['{{addvar::probe::10}}{{getvar::probe}}', '16'], ['{{.probe = 2}}{{.probe++}}/{{.probe}}', '3/3'],
    ['{{if true}}yes{{else}}no{{/if}}', 'yes'], ['{{reverse::{{char}}}}', 'rahC'],
    ['{{pick::a::b::c}}/{{pick::a::b::c}}', 'c/b'], ['{{roll 1d1}}', '1'], ['{{random::only}}', 'only'],
];
export const legacy = [
    ['<USER>/<CHAR>/{{char}}', 'User/Char/Char'], ['\\{{char\\}}', '\\{{char\\}}'], ['{{reverse:abc}}', 'cba'],
    ['{{setvar::probe::5}}{{getvar::probe}}', '5'], ['{{incvar::probe}}{{getvar::probe}}', '66'],
    ['{{addvar::probe::10}}{{getvar::probe}}', '16'], ['{{pick::a::b::c}}/{{pick::a::b::c}}', 'c/c'],
    ['{{roll 1d1}}', '1'], ['{{random::only}}', 'only'], ['{{obj}}|{{a.b}}|{{axb}}', '{"x":1}|literal|{{axb}}'],
];
