import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatPresetPayload } from '../public/scripts/chat-preset-request.js';

test('profile preset requests preserve resolved controls and isolate active settings', async () => {
    const active = { chat_completion_source: 'openai', temp_openai: 1, openai_max_tokens: 8000,
        show_thoughts: true, auto_append_reasoning_tags: true, nanogpt_service_tier: 'priority', custom_url: 'https://saved.invalid' };
    const before = structuredClone(active);
    const preset = { temperature: 0.8, openai_max_tokens: 4000, nanogpt_allowed_providers: ['one'], nanogpt_ignored_providers: ['two'] };
    const overrides = { model: 'gpt-5.4', chat_completion_source: 'custom', max_tokens: 120, temperature: 0,
        include_reasoning: 'false', enable_web_search: 'off', request_images: '1', reasoning_effort: 'none',
        __connectionProfileRequestFields: ['include_reasoning', 'reasoning_effort'], modelOverride: 'hidden' };
    let captured;
    const result = await buildChatPresetPayload(active, preset, {}, overrides, async (settings, model, type) => {
        captured = settings;
        assert.equal(model, 'gpt-5.4');
        assert.equal(type, 'quiet');
        return { generate_data: { max_completion_tokens: settings.openai_max_tokens, temperature: settings.temp_openai,
            include_reasoning: false, reasoning_effort: undefined } };
    });
    assert.equal(captured.custom_url, active.custom_url);
    assert.equal(captured.auto_append_reasoning_tags, false);
    assert.equal(captured.nanogpt_service_tier, '');
    assert.deepEqual(captured.nanogpt_allowed_providers, ['one']);
    assert.deepEqual(captured.nanogpt_ignored_providers, ['two']);
    assert.equal(result.max_completion_tokens, 120);
    assert.equal(result.max_tokens, undefined);
    assert.equal(result.temperature, 0);
    assert.equal(result.include_reasoning, false);
    assert.equal(result.enable_web_search, false);
    assert.equal(result.request_images, true);
    assert.equal(result.reasoning_effort, undefined);
    assert.equal(result.__connectionProfileRequestFields, undefined);
    assert.equal(result.modelOverride, undefined);
    assert.deepEqual(active, before);
    assert.equal(overrides.include_reasoning, 'false');
    assert.equal(preset.temperature, 0.8);
});
