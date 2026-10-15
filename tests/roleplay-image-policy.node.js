/* eslint playwright/expect-expect: off -- Real server capture and prompt functions, synthetic records. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { captureSavedRoleplayImages } = await import('../src/generation/world-info.js');
const { buildRoleplaySavedHistory } = await import('../src/generation/roleplay-prompt.js');
const { createPromptMediaContext } = await import('../public/scripts/prompt-media-policy.js');
const policy = createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images: 'display-only' } } });

test('real capture and history omit unrepaired images without touching their files', () => {
    for (const url of ['data:image/png;base64,invalid', '/user/images/does-not-exist.png', 'https://example.invalid/image.png']) {
        const records = [{}, { is_user: true, mes: 'Keep this text', extra: { media: [{ url, title: 'Do not send', append_title: true }] } }];
        const images = captureSavedRoleplayImages({}, records, 'list', {}, policy);
        assert.deepEqual(images, []);
        assert.deepEqual(buildRoleplaySavedHistory(records, { images, mediaPolicy: policy }), [{ role: 'user', content: 'Keep this text' }]);
    }
});

test('legacy snapshot capture still refuses empty media while new policy treats it as no attachment', () => {
    const records = [{}, { is_user: true, mes: 'Keep', extra: { media: [], media_index: -1, media_display: 'gallery' } }];
    assert.throws(() => captureSavedRoleplayImages({}, records, 'list'), { code: 'ROLEPLAY_INVALID' });
    const images = captureSavedRoleplayImages({}, records, 'list', {}, policy);
    assert.deepEqual(buildRoleplaySavedHistory(records, { images, mediaPolicy: policy }), [{ role: 'user', content: 'Keep' }]);
    assert.deepEqual(records[1].extra.media, []);
});

test('connection off no longer requires a saved caption or readable image', () => {
    const mediaPolicy = createPromptMediaContext({}, {}, { media_inlining: false });
    const records = [{}, { is_user: true, mes: 'Keep', extra: { media: [{ url: '/user/images/missing.png' }] } }];
    const images = captureSavedRoleplayImages({}, records, 'list', {}, mediaPolicy);
    assert.deepEqual(images, []);
    assert.deepEqual(buildRoleplaySavedHistory(records, { images, mediaPolicy }), [{ role: 'user', content: 'Keep' }]);
});

test('caption reads do not require image descriptors in main history when inline media is off', () => {
    const mediaPolicy = createPromptMediaContext({ extension_settings: { caption: { auto_mode: true } } }, {}, { media_inlining: false });
    const records = [{}, { is_user: true, mes: 'Keep', extra: { media: [{ type: 'image', source: 'upload', url: '/user/images/caption-source.png', title: 'Existing description', append_title: true }] } }];
    assert.deepEqual(buildRoleplaySavedHistory(records, { images: [], mediaPolicy }), [{ role: 'user', content: 'Keep\n\nExisting description' }]);
});
