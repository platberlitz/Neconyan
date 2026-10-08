module.exports = {
    root: true,
    plugins: [
        'jest',
        'playwright',
    ],
    extends: [
        'eslint:recommended',
    ],
    env: {
        es6: true,
        node: true,
        'jest/globals': true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
        { files: ['*.test.js'], extends: ['plugin:jest/recommended'] },
        { files: ['*.e2e.js', '*-fixture.js', '*-helpers.js', 'capture-screenshots.js'], extends: ['plugin:playwright/recommended'] },
        {
            files: ['in-chat-agents-templates.test.js'],
            rules: {
                'jest/expect-expect': ['warn', { assertFunctionNames: ['expect', 'expectLevelUpStatsDefaults', 'expectExistingStatsSectionOnStatsTemplate'] }],
            },
        },
        {
            files: ['neconyan-scratchpad-notebooks.e2e.js'],
            rules: {
                'playwright/expect-expect': ['warn', { assertFunctionNames: ['checkNoteSelection'] }],
            },
        },
    ],
    ignorePatterns: [
        '*.min.js',
        'node_modules/**/*',
    ],
    globals: {
        SillyTavern: 'readonly',
    },
    rules: {
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',

        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
    },
    settings: {
        jest: {
            version: 29,
        },
    },
};
