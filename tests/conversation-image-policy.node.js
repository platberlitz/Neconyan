/* eslint playwright/expect-expect: off -- Exact shared prompt payloads with no network. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { composeConversationPromptMessages } from '../public/scripts/neconyan-conversation/prompt-messages.js';
import { conversationReplyImageProof } from '../public/scripts/neconyan-conversation/prompt-media.js';
import { createPromptMediaContext } from '../public/scripts/prompt-media-policy.js';
import { getConversationAttachmentSummary } from '../public/scripts/neconyan-conversation/thread-store-utils.js';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mediaPolicy = createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images: 'display-only' } } });
const image = { id: 'picture', role: 'assistant', name: 'Nova', mes: '', extra: { media: [{ type: 'image', url: 'https://example.invalid/x', title: 'PRIVATE_IMAGE_PROMPT' }] } };
const compose = (messages, more = {}) => composeConversationPromptMessages(messages, 'Reply', 'Nova', {
    mediaPolicy, hash, convertImages: () => { throw new Error('No image conversion permitted'); }, ...more,
});

test('display only removes image bytes and unconditional title summaries without changing visible data', async () => {
    const original = structuredClone(image);
    const result = await compose([image]);
    assert.equal(JSON.stringify(result).includes('PRIVATE_IMAGE_PROMPT'), false);
    assert.equal(JSON.stringify(result).includes('image_url'), false);
    assert.deepEqual(image, original);
    assert.match(getConversationAttachmentSummary(image), /PRIVATE_IMAGE_PROMPT/);
});

test('direct and group reply references cannot reintroduce an excluded title', async () => {
    const reply = { id: 'reply', role: 'user', name: 'User', mes: 'Continue', extra: { conversation_reply_to: {
        messageId: 'picture', name: 'Nova', text: 'PRIVATE_IMAGE_PROMPT', attachmentSummary: 'PRIVATE_IMAGE_PROMPT',
    } } };
    reply.extra.conversation_reply_to.neconyan_image_source = conversationReplyImageProof(image, reply.extra.conversation_reply_to, '', hash);
    for (const groupId of ['', 'group']) {
        const result = await compose([image, reply], { groupId });
        assert.equal(JSON.stringify(result).includes('PRIVATE_IMAGE_PROMPT'), false);
        assert.match(JSON.stringify(result), /explicit reply to Nova/);
    }
    await assert.rejects(compose([reply]), /original message is unavailable/);
});

test('mixed old attachment text requires a source-bound reviewed choice', async () => {
    const message = structuredClone(image);
    message.extra.conversation_attachment_context = 'PRIVATE_IMAGE_PROMPT and document text';
    await assert.rejects(compose([message]), /Review this message/);
    message.extra.neconyan_image_context = { version: 1, mode: 'omit', source_hash: hash([message.extra.conversation_attachment_context, null]) };
    assert.equal(JSON.stringify(await compose([message])).includes('PRIVATE_IMAGE_PROMPT'), false);
    message.extra.conversation_attachment_context += ' changed';
    await assert.rejects(compose([message]), /Review this message/);
});

test('new context provenance preserves extracted file text while removing image summaries', async () => {
    const message = structuredClone(image);
    message.extra.files = [{ url: '/user/files/a.txt', name: 'A' }];
    message.extra.conversation_attachment_context = 'PRIVATE_IMAGE_PROMPT\nDocument text';
    message.extra.conversation_attachment_context_provenance = { version: 1, file_text: 'Document text', source_hash: hash([
        message.extra.conversation_attachment_context, message.extra.media, message.extra.files,
    ]) };
    const result = JSON.stringify(await compose([message]));
    assert.equal(result.includes('PRIVATE_IMAGE_PROMPT'), false);
    assert.match(result, /Document text/);
});

test('authored message text and generated-image_url display data are preserved', async () => {
    const message = { ...image, mes: 'Authored prose', extra: { image_url: 'https://example.invalid/generated' } };
    assert.match(JSON.stringify(await compose([message])), /Authored prose/);
    assert.equal(message.extra.image_url, 'https://example.invalid/generated');
});

test('automatic caption read permission never sends Conversation image bytes when inline media is off', async () => {
    const mediaPolicy = createPromptMediaContext({ extension_settings: { caption: { auto_mode: true } } }, {}, { media_inlining: false });
    const source = { ...image, extra: { media: [{ ...image.extra.media[0], source: 'upload' }] } };
    let conversions = 0;
    const result = await composeConversationPromptMessages([source], 'Reply', 'Nova', { mediaPolicy, hash, convertImages: () => { conversions++; return []; } });
    assert.equal(conversions, 0);
    assert.equal(JSON.stringify(result).includes('image_url'), false);
    assert.match(JSON.stringify(result), /PRIVATE_IMAGE_PROMPT/);
});

test('native generated image inclusion preserves the historical generic label, not its private generation prompt', async () => {
    const source = { ...image, extra: { image_url: '/user/images/generated.png', image_prompt: 'PRIVATE_GENERATION_PROMPT' } };
    const options = { hash, convertImages: urls => urls.map(() => 'data:image/png;base64,AAAA') };
    const before = await composeConversationPromptMessages([source], 'Reply', 'Nova', options);
    const after = await composeConversationPromptMessages([source], 'Reply', 'Nova', { ...options, mediaPolicy: createPromptMediaContext({}) });
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(after).includes('PRIVATE_GENERATION_PROMPT'), false);
});

test('edited sources or quotes need review instead of rewriting preserved quoted prose', async () => {
    const source = { ...image, mes: 'Original authored prose.' };
    const reference = { messageId: source.id, text: 'Original authored prose.', attachmentSummary: 'PRIVATE_IMAGE_PROMPT' };
    reference.neconyan_image_source = conversationReplyImageProof(source, reference, source.mes, hash);
    const reply = { id: 'quote', role: 'user', name: 'User', mes: 'Continue', extra: { conversation_reply_to: reference } };
    assert.match(JSON.stringify(await compose([source, reply])), /Original authored prose/);
    source.mes = 'Edited after the reply.';
    await assert.rejects(compose([source, reply]), /quote provenance/);
    assert.equal(reference.text, 'Original authored prose.');
    source.mes = 'Original authored prose.';
    reference.text = 'An independently edited quotation.';
    await assert.rejects(compose([source, reply]), /quote provenance/);
});
