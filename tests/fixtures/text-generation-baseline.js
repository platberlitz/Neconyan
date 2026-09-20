// Fixed inputs for the browser request behaviour captured before extraction.
export const providerTypes = ['ooba', 'mancer', 'vllm', 'aphrodite', 'tabby', 'koboldcpp', 'togetherai', 'llamacpp', 'ollama', 'infermaticai', 'dreamgen', 'openrouter', 'featherless', 'huggingface', 'generic'];
// SHA-256 of JSON request bodies produced by createTextGenGenerationData at
// 28691175b, with the explicit dependencies below and the existing dynamic-temperature provider list.
export const providerDigests = [
    '15543a7da15209a8ad8023c2ea11add20ef65c873e08146dfee91163af0bac8a',
    'b2cdc235ae3c6112b061a2576923f5930fbc9899ead644adef58831a9a79d742',
    '1e815451a8e4727add9ed7fe92832ce16b7f94c7261f822a11e90378907cf46d',
    'b17faed157c0421152388798cbd134f8b8505c8d651494f2ab7a5e23da42f3a5',
    '4c2ab2c25088ce5510dd9c6efca7939484ad8fe0fcc1525ac971aeefd300469b',
    'eccbc5dce1277a93853c001e7db87ebc97b4a4b9d78fc74723c563ce01aebe40',
    'bed1ebda573a24eb4124832bc3adeb9ce439d93a6fc706f3f2e9706356a744a1',
    '740bc970d8e569b38a7939830071540921e295a95ac5b7e81d7da21ad8d72c9c',
    '7870ccdc9a7eaa10b475ebdedc1aea3485ed3a4bdc11e563309792527673d029',
    '280947910e6e061489a9bb59963a512e49dce875574307eedb4f0c4eafdbddec',
    'c827a0f37bc7c12eaee9593d2a17142fbf058511605e5f11360a29a0614c0def',
    '9f18829cf7dd4d370a44e5a4b476c8f1428f1eb39f565de0bbe9748814d8e803',
    '196fe25a50f024c7d3e2995196e3260dd6f4b11349dad0698e34c68ccd093b3c',
    'e80125328d5cb0e8436e99f8934a4efeb27ec118b16dc43209b923b68c5ce0a4',
    '9aa93854ccfe712c2c71800f225550a915b2cba72b23272053de840741459cd3',
];
export const providerSettings = {
    temp: 0.7, dynatemp: true, min_temp: 0.2, max_temp: 1.2, dynatemp_exponent: 1.5,
    top_p: 0.9, top_k: 30, typical_p: 0.95, min_p: 0.05, rep_pen: 1.1,
    freq_pen: 0.2, presence_pen: 0.3, seed: -1, min_length: 2,
    epsilon_cutoff: 10, eta_cutoff: 20, n: 3, temperature_last: true,
    rep_pen_range: 128, rep_pen_decay: 0.8, rep_pen_slope: 0.4,
    dry_sequence_breakers: '["{{char}}", "\\n"]',
    negative_prompt: '{{user}}', guidance_scale: 1.5,
    grammar_string: 'root ::= "yes"', json_schema: { type: 'object' },
    sampler_order: [6, 0, 1], sampler_priority: ['temperature', 'top_p'],
    samplers: ['top_k', 'top_p'], samplers_priorities: ['temperature'],
    logit_bias: [{ text: '[9]', value: -2 }],
    openrouter_providers: ['fixture'], openrouter_service_tier: 'priority',
    openrouter_quantizations: ['fp16'], openrouter_allow_fallbacks: false,
};
export const providerDependencies = {
    requestTokenProbabilities: true, contextLimit: 8192,
    apiServer: 'http://127.0.0.1:5000', stoppingStrings: ['STOP', 'NEXT', 'THIRD', 'FOURTH', 'FIFTH'],
    tokenBans: { banned_tokens: '4,5', banned_strings: ['forbidden'] },
    logitBias: { 9: -2 }, cachePrompt: false, random: () => 0.25,
    substitute: value => typeof value === 'string' ? value.replaceAll('{{char}}', 'Ada').replaceAll('{{user}}', 'Sam') : value,
};

export const instructSettings = {
    enabled: true, wrap: true, macro: true, names_behavior: 'always',
    input_sequence: '<user {{name}}>', input_suffix: '</user>\n',
    output_sequence: '<assistant {{name}}>', output_suffix: '</assistant>\n',
    system_sequence: '<system>', system_suffix: '</system>\n',
    last_system_sequence: '<quiet>', last_output_sequence: '<last>',
    story_string_prefix: '<story>', story_string_suffix: '</story>\n',
    stop_sequence: '<stop>', sequences_as_stop_strings: true,
};
export const promptMessages = [
    { role: 'system', content: 'Be {{char}}.' },
    { role: 'user', name: 'Visitor', content: [{ type: 'text', text: 'Hello {{user}}' }, { content: 'second part' }] },
    { role: 'assistant', content: 'Prefill' },
];

// Captured from the browser's original scoped and raw functions before extraction.
export const expectedPrompts = {
    scoped: '<system>\nBe {{char}}.</system>\n<user Visitor>\nVisitor: Hello {{user}}\n\nsecond part</user>\n<quiet>\nPrefill',
    raw: '<story>\n Story Ada </story>\n<system>\nBe Ada.</system>\n<user Visitor>\nVisitor: Hello Sam\n\nsecond part</user>\n<assistant Ada>\nAda: Prefill</assistant>\n<last>\nAda: Sam',
    plain: 'Story Ada\nBe Ada.\nVisitor: Hello Sam\n\nsecond part\nAda: Prefill\n Sam ',
    chat: [
        { role: 'system', content: 'Story Ada' }, { role: 'system', content: 'Be Ada.' },
        { role: 'user', name: 'Visitor', content: [{ type: 'text', text: 'Hello Sam' }, { content: 'second part' }] },
        { role: 'assistant', content: 'Prefill' }, { role: 'assistant', content: ' Sam ' },
    ],
};
