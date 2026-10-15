/* eslint playwright/expect-expect: off -- Pure shared policy, Node assertions. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { attachmentIdentity, canonicalPromptMedia, createPromptMediaContext, detachMessageMedia, generatedImageInputPreference, projectPromptMediaRecords, promptMediaText, selectPromptMedia } from '../public/scripts/prompt-media-policy.js';
const hash = value => crypto.createHash('sha256').update(canonicalPromptMedia(value)).digest('hex');
const context = (images = 'include', controls = {}) => createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images } } }, {}, controls);
const records = extra => [{}, { is_user: true, mes: 'Authored text', extra }];
const image = { type: 'image', url: 'data:image/png;base64,unrepaired', title: 'Image description', append_title: true };

test('compatible copies remain usable when companion processing projects history again', () => {
    const item = { ...image, url: '/user/images/original.png', neconyan_prompt: {
        version: 1, mode: 'include', attachment_hash: hash(['image', '/user/images/original.png']),
        image_url: `/user/images/neconyan-repaired/${'a'.repeat(64)}.png`, original_evidence: { rawHash: 'b'.repeat(64) },
    } };
    const source = records({ media: [item] }), before = structuredClone(source);
    const once = projectPromptMediaRecords(source, context(), { hash });
    const twice = projectPromptMediaRecords(once, context(), { hash });
    assert.deepEqual(twice, once);
    assert.equal(twice[1].extra.media[0].url, item.neconyan_prompt.image_url);
    assert.deepEqual(source, before);
    const changed = structuredClone(source);
    changed[1].extra.media[0].url = '/user/images/changed.png';
    assert.throws(() => projectPromptMediaRecords(changed, context(), { hash }), /changed/);
});

test('display only preserves saved data and omits bytes, descriptions and caption work', () => {
    const source = records({ media: [image], media_index: -1, media_display: 'gallery' });
    const before = structuredClone(source);
    const result = selectPromptMedia(source, { ...context('display-only'), automaticCaptions: true }, { hash });
    assert.deepEqual(source, before);
    assert.equal(result.records[1].extra.media, undefined);
    assert.equal(promptMediaText(result.records[1], 0, result), 'Authored text');
    assert.equal(result.decisions[0].read, false);
    assert.equal(result.decisions[0].autoCaption, false);
});

test('empty ordinary arrays and selector residue represent no attachment', () => {
    for (const extra of [{ media: [], media_index: -1 }, { media_display: 'gallery', inline_image: true }]) {
        const result = selectPromptMedia(records(extra), context(), { hash });
        assert.deepEqual(result.records[1].extra, {});
        assert.deepEqual(result.decisions, []);
    }
    assert.throws(() => selectPromptMedia(records({ media: null }), context()), { code: 'ROLEPLAY_IMAGE_INPUT' });
});

test('gallery selection bounds selected inputs, not stored entries', () => {
    const result = selectPromptMedia(records({ media: Array.from({ length: 8 }, () => ({ ...image })), media_display: 'gallery' }), context(), { hash });
    assert.equal(result.decisions.filter(item => item.read).length, 1);
    assert.equal(result.records[1].extra.media.length, 1);
    assert.throws(() => selectPromptMedia(records({ media: [image], media_display: 'gallery', media_index: -1 }), context(), { hash }), /remaining image/);
});

test('connection byte veto is independent of capability and preserves existing text', () => {
    const result = selectPromptMedia(records({ media: [image] }), context('include', { media_inlining: false }), { hash });
    assert.equal(result.decisions[0].read, false);
    assert.equal(promptMediaText(result.records[1], 0, result), 'Authored text\n\nImage description');
});

test('description choice is bound to the attachment and needs no image read', () => {
    const item = { ...image, append_title: false, neconyan_prompt: { version: 1, mode: 'caption', attachment_hash: hash(attachmentIdentity(image)), caption: { source: 'custom', text: 'Chosen description' } } };
    const result = selectPromptMedia(records({ media: [item] }), context(), { hash });
    assert.equal(result.decisions[0].read, false);
    assert.equal(promptMediaText(result.records[1], 0, result), 'Authored text\n\nChosen description');
    assert.throws(() => selectPromptMedia(records({ media: [{ ...item, url: 'changed' }] }), context(), { hash }), /changed/);
});

test('hidden ordinary media is omitted but tool records keep their original strict schema', () => {
    const source = records({ media: [image] }); source[1].is_system = true;
    assert.equal(selectPromptMedia(source, context(), { hash }).decisions[0].read, false);
    source[1].extra.tool_invocations = [];
    assert.equal(selectPromptMedia(source, context(), { hash }).records[1], source[1]);
});

test('legacy image exclusion does not mutate or require its file', () => {
    const source = records({ image: 'https://example.invalid/missing.png', title: 'Old description', append_title: true });
    const result = selectPromptMedia(source, context('display-only'), { hash });
    assert.equal(result.records[1].extra.image, undefined);
    assert.equal(result.records[1].extra.append_title, undefined);
    assert.equal(source[1].extra.image, 'https://example.invalid/missing.png');
});

test('detaching the last image cleans selectors and preserves authored titles', () => {
    const extra = { media: [image], media_index: 0, media_display: 'gallery', inline_image: true, title: 'Authored title', append_title: true, tracker: { value: 1 } };
    for (const all of [false, true]) {
        assert.deepEqual(detachMessageMedia(extra, 0, all).extra, { title: 'Authored title', append_title: true, tracker: { value: 1 } });
    }
    assert.equal(extra.media.length, 1);
});

test('gallery deletion preserves the selected survivor and accepts missing URLs', () => {
    const media = [{ url: '/user/images/a.png' }, { url: '/user/images/b.png' }, {}];
    assert.equal(detachMessageMedia({ media, media_index: 1 }, 0).extra.media_index, 0);
    assert.equal(detachMessageMedia({ media, media_index: 1 }, 1).extra.media_index, 0);
    assert.equal(detachMessageMedia({ media, media_index: 1 }, 2).extra.media_index, 1);
    assert.equal(detachMessageMedia({ media }, 0).extra.media_index, undefined);
    assert.deepEqual(detachMessageMedia({ media: [{}] }, 0).urls, []);
});

test('browser compatibility getters are not mistaken for saved legacy image keys', () => {
    const extra = {};
    Object.defineProperty(extra, 'image', { enumerable: false, get() { throw new Error('Do not read a browser alias'); } });
    const result = selectPromptMedia([{}, { mes: 'Text only', is_user: true, extra }], createPromptMediaContext({}));
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.records[1].extra, {});
});

test('browser provenance identities match protected server canonical JSON', async () => {
    const { roleplayHash } = await import('../src/roleplay-store.js');
    const value = ['mixed file/image context', { text: 'Quoted prose', attachmentSummary: 'Old image title', messageId: 'source', nested: { z: null, a: [1, 'two'] } }];
    assert.equal(hash(value), roleplayHash(value));
    assert.equal(hash(value), hash([value[0], { nested: { a: [1, 'two'], z: null }, messageId: 'source', attachmentSummary: 'Old image title', text: 'Quoted prose' }]));
});

test('new image defaults preserve Conversation inclusion without inheriting Roleplay choices', () => {
    const settings = {};
    assert.equal(generatedImageInputPreference(settings), 'display-only');
    assert.equal(generatedImageInputPreference(settings, true), 'include');
    settings.chatImageInput = 'caption';
    assert.equal(generatedImageInputPreference(settings, true), 'include');
    settings.conversationChatImageInput = 'display-only';
    assert.equal(generatedImageInputPreference(settings, true), 'display-only');
    assert.equal(generatedImageInputPreference(JSON.parse(JSON.stringify(settings))), 'caption');
});
