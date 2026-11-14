import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePresetPrompts } from '../public/scripts/extensions/in-chat-agents/agent-context-macros.js';
import { assembleRoleplayChatPrompt } from '../src/generation/roleplay-chat-prompt.js';

const settings = prompts => ({ prompts, prompt_order: [{ character_id: 100001,
    order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.identifier !== 'off' })) }] });

test('resolved reply rules replace saved text and keep injections beside an empty or disabled main', () => {
    const preset = settings([{ identifier: 'main', content: 'Saved main' }, { identifier: 'off', content: 'Disabled' },
        { identifier: 'scenario', content: 'Facts' }, { identifier: 'last', content: 'Last rule' }]);
    const resolved = [{ identifier: 'main', marker: true, content: 'Character override' },
        { identifier: 'last', content: 'Resolved last' }];
    const injections = { preparedPrompts: resolved, beforeMain: [{ name: 'Before', content: 'First' }],
        afterMain: [{ key: 'after', content: 'After' }, { key: 'empty', content: ' ' }] };
    assert.deepEqual(capturePresetPrompts(preset, 'normal', injections).map(rule => rule.content),
        ['First', 'Character override', 'After', 'Resolved last']);
    preset.prompt_order[0].order[0].enabled = false;
    assert.deepEqual(capturePresetPrompts(preset, 'normal', injections).map(rule => rule.content),
        ['First', 'After', 'Resolved last']);
    preset.prompt_order[0].order[0].enabled = true;
    resolved[0].content = '';
    assert.deepEqual(capturePresetPrompts(preset, 'normal', injections).map(rule => rule.content),
        ['First', 'After', 'Resolved last']);
});

for (const absolute of [false, true]) {
    for (const squash of [false, true]) {
        test(`assembled reply rules match the ${absolute ? 'depth' : 'relative'} main placement, squash=${squash}`, async () => {
            const preset = settings([{ identifier: 'main', content: 'MAIN', role: 'system', injection_position: absolute ? 1 : 0, injection_depth: 0 },
                { identifier: 'chatHistory', marker: true }]);
            preset.squash_system_messages = squash;
            const contributions = [
                { key: 'b-before', content: 'BEFORE_B', position: 2, role: 'user' },
                { key: 'a-before', content: 'BEFORE_A', position: 2, role: 'system' },
                { key: 'd-after', content: 'AFTER_D', position: 0, role: 'assistant' },
                { key: 'c-after', content: 'AFTER_C', position: 0, role: 'user' },
            ];
            const result = await assembleRoleplayChatPrompt([], { global: {} }, { active: preset },
                { WIDepthEntries: [] }, { contributions, userName: 'User', characterName: 'Nova' });
            const expected = absolute ? ['BEFORE_A', 'BEFORE_B', 'MAIN', 'AFTER_D', 'AFTER_C']
                : ['BEFORE_B', 'BEFORE_A', 'MAIN', 'AFTER_C', 'AFTER_D'];
            assert.deepEqual(result.presetPrompts.map(rule => rule.content), expected);
            const sent = result.messages.map(message => message.content).join('\n');
            for (let index = 1; index < expected.length; index++) {
                assert.ok(sent.indexOf(expected[index - 1]) < sent.indexOf(expected[index]), sent);
            }
        });
    }
}
