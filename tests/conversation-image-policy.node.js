/* eslint playwright/expect-expect: off -- Exact shared prompt payloads with no network. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConversationMessageReplyReference } from '../src/endpoints/conversation-messages.js';
import { roleplayHash as hash } from '../src/roleplay-store.js';
import { composeConversationPromptMessages } from '../public/scripts/neconyan-conversation/prompt-messages.js';
import { conversationReplyImageProof } from '../public/scripts/neconyan-conversation/prompt-media.js';
import { getConversationReplyPreviewParts } from '../public/scripts/neconyan-conversation/preview-utils.js';
import { createPromptMediaContext } from '../public/scripts/prompt-media-policy.js';
import { getConversationAttachmentSummary } from '../public/scripts/neconyan-conversation/thread-store-utils.js';
const mediaPolicy = createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images: 'display-only' } } });
const image = { id: 'picture', role: 'assistant', name: 'Nova', mes: '', extra: { media: [{ type: 'image', url: 'https://example.invalid/x', title: 'PRIVATE_IMAGE_PROMPT' }] } };
const compose = (messages, more = {}) => composeConversationPromptMessages(messages, 'Reply', 'Nova', {
    mediaPolicy, hash, convertImages: () => { throw new Error('No image conversion permitted'); }, ...more,
});

function quote(source, { browserPreview = false, legacy = false } = {}) {
    const reference = browserPreview
        ? { messageId: source.id, name: source.name, ...getConversationReplyPreviewParts(source, { browserPreview }) }
        : buildConversationMessageReplyReference(source);
    delete reference.authoredText;
    if (legacy) delete reference.neconyan_image_source;
    return { id: 'quote', role: 'user', name: 'User', mes: 'Continue', extra: { conversation_reply_to: reference } };
}

function referenceContent(result) {
    return result.find(row => row.identifier === 'conversation-group-reference-context')?.content ?? '';
}

test('real server references carry canonical proof and allow two text turns under account and branch veto', async () => {
    const source = { id: 'hey', role: 'user', name: 'User', mes: 'Hey', extra: {} };
    const reply = quote(source);
    const reference = reply.extra.conversation_reply_to;
    assert.deepEqual(reference.neconyan_image_source, conversationReplyImageProof(source, reference, 'Hey', hash));
    for (const policy of [mediaPolicy, createPromptMediaContext({}, { neconyan_prompt_media: { version: 1, images: 'display-only' } }, {}, { chatScope: 'branch' })]) {
        assert.match(JSON.stringify(await compose([source, reply, { ...source, id: 'second', mes: 'How are you?' }], { mediaPolicy: policy })), /How are you/);
    }
});

test('historical browser and server previews preserve boundaries, HTML, whitespace and attachment fallback', async () => {
    const texts = ['', 'x'.repeat(129), 'x'.repeat(130), 'x'.repeat(159), 'x'.repeat(160), 'x'.repeat(161),
        'x'.repeat(129) + ' ' + 'y'.repeat(80), '<p> Hello </p>\n\t <b>world</b> ' + 'z'.repeat(190)];
    for (const mes of texts) {
        const source = { ...structuredClone(image), mes };
        for (const browserPreview of [true, false]) {
            const strip = value => {
                const plain = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                return browserPreview ? plain.slice(0, 130) : plain;
            };
            const truncate = value => {
                const plain = String(value || '').replace(/\s+/g, ' ').trim();
                return plain.length > 160 ? plain.slice(0, 159) + '…' : plain;
            };
            const parts = getConversationReplyPreviewParts(source, { browserPreview });
            assert.equal(parts.text, truncate(strip(mes) || strip('image: PRIVATE_IMAGE_PROMPT')));
            assert.equal(parts.authoredText, truncate(strip(mes)));
            assert.equal(parts.attachmentSummary, truncate(getConversationAttachmentSummary(source)));
            const reply = quote(source, { browserPreview, legacy: true });
            const before = structuredClone([source, reply]);
            const result = await compose([source, reply]);
            assert.equal(JSON.stringify(result).includes('PRIVATE_IMAGE_PROMPT'), false);
            assert.deepEqual([source, reply], before);
            if (parts.authoredText) assert.ok(referenceContent(result).includes(parts.authoredText));
        }
    }
});

test('legacy recovery strips excluded image data and preserves authored and proven file text in direct and group prompts', async () => {
    const source = { ...structuredClone(image), mes: 'AUTHORED_QUOTE_PROSE' };
    source.extra.image_url = 'https://example.invalid/generated-private.png';
    source.extra.files = [{ url: '/user/files/a.txt', name: 'document' }];
    source.extra.conversation_attachment_context = 'PRIVATE_IMAGE_PROMPT\nFILE_QUOTE_CONTENT';
    // Generated image_url is normalised into media before context provenance is checked.
    const contextMedia = [...source.extra.media, { type: 'image', url: source.extra.image_url, title: 'Generated image' }];
    source.extra.conversation_attachment_context_provenance = { version: 1, file_text: 'FILE_QUOTE_CONTENT', source_hash: hash([
        source.extra.conversation_attachment_context, contextMedia, source.extra.files,
    ]) };
    const reply = quote(source, { legacy: true });
    const before = structuredClone([source, reply]);
    for (const groupId of ['', 'group']) {
        const result = JSON.stringify(await compose([source, reply], { groupId }));
        for (const privateValue of ['PRIVATE_IMAGE_PROMPT', image.extra.media[0].url, source.extra.image_url]) assert.equal(result.includes(privateValue), false);
        assert.match(result, /AUTHORED_QUOTE_PROSE/);
        assert.match(result, /FILE_QUOTE_CONTENT/);
        assert.match(result, /explicit reply to Nova/);
        assert.deepEqual([source, reply], before);
    }
});

test('long attachment-only labels match either historical preview without leaking the image title', async () => {
    const source = structuredClone(image);
    source.extra.media[0].title = 'PRIVATE_IMAGE_PROMPT'.repeat(20);
    for (const browserPreview of [true, false]) {
        const parts = getConversationReplyPreviewParts(source, { browserPreview });
        assert.equal(parts.text.length, browserPreview ? 130 : 160);
        assert.equal(parts.attachmentSummary.length, 160);
        assert.equal(parts.authoredText, '');
        const result = await compose([source, quote(source, { browserPreview, legacy: true })]);
        assert.equal(JSON.stringify(result).includes('PRIVATE_IMAGE_PROMPT'), false);
        assert.equal(referenceContent(result).includes('Referenced message or attachment:'), false);
    }
});

test('import-remapped stale proof recovers independently and retained sources are checked before transcript slicing', async () => {
    const source = { ...structuredClone(image), mes: 'SAFE_RETAINED_QUOTE' };
    const reply = quote(source);
    // A stale proof's authored text is never a source of recovered prose.
    reply.extra.conversation_reply_to.neconyan_image_source.authored_text = 'UNTRUSTED_PROOF_TEXT';
    source.id = 'imported-picture';
    reply.extra.conversation_reply_to.messageId = source.id;
    const middle = Array.from({ length: 35 }, (_, index) => ({ id: `middle-${index}`, role: 'user', mes: 'Later', extra: {} }));
    const result = await compose([source, ...middle, reply]);
    assert.match(referenceContent(result), /SAFE_RETAINED_QUOTE/);
    assert.equal(result.some(row => row.identifier === 'conversation-message-imported-picture'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_IMAGE_PROMPT'), false);
    assert.equal(JSON.stringify(result).includes('UNTRUSTED_PROOF_TEXT'), false);
});

test('legacy recovery refuses missing, duplicate, edited and mixed-pair source previews', async () => {
    const source = { ...structuredClone(image), mes: 'Original authored prose.' };
    const reply = quote(source, { legacy: true });
    const refused = records => assert.rejects(compose(records), error => error.imageIssue?.reason === 'mixed-reply-context');
    await refused([reply]);
    await refused([source, structuredClone(source), reply]);
    await refused([{ ...source, mes: 'Changed prose' }, reply]);
    await refused([source, { ...reply, extra: { conversation_reply_to: { ...reply.extra.conversation_reply_to, text: 'Changed quote' } } }]);
    const long = { ...source, mes: 'x'.repeat(200) };
    const mixed = quote(long, { legacy: true });
    mixed.extra.conversation_reply_to.text = getConversationReplyPreviewParts(long, { browserPreview: true }).text;
    mixed.extra.conversation_reply_to.attachmentSummary += ' changed';
    await refused([long, mixed]);
    // Absent summary fields are equivalent to the historical empty string.
    const plain = { ...source, extra: {} };
    const plainReply = quote(plain, { legacy: true });
    delete plainReply.extra.conversation_reply_to.attachmentSummary;
    assert.match(referenceContent(await compose([plain, plainReply])), /Original authored prose/);
});

test('recovery after invisible source edits emits only the matched authored preview', async () => {
    for (const browserPreview of [true, false]) {
        const source = { ...structuredClone(image), mes: 'x'.repeat(200) };
        const reply = quote(source, { browserPreview });
        const authored = getConversationReplyPreviewParts(source, { browserPreview }).authoredText;
        source.mes += ' NEWLY_EXPOSED_PROSE';
        const context = referenceContent(await compose([source, reply]));
        assert.ok(context.includes(authored));
        assert.equal(context.includes('NEWLY_EXPOSED_PROSE'), false);
    }
    const source = { ...structuredClone(image), mes: 'Hello world' };
    const reply = quote(source, { legacy: true });
    source.mes = '<b>Hello</b>\n\tworld';
    assert.match(referenceContent(await compose([source, reply])), /Hello world/);
});

test('saved omit and replacement choices precede exact legacy recovery and stale choices still refuse', async () => {
    const source = { ...structuredClone(image), mes: 'ORIGINAL_REVIEWED_QUOTE' };
    for (const groupId of ['', 'group']) {
        for (const mode of ['omit', 'replace']) {
            const reply = quote(source, { legacy: true });
            reply.extra.neconyan_image_context = { version: 1, mode, text: 'REVIEWED_REPLACEMENT',
                source_hash: hash(['', reply.extra.conversation_reply_to]) };
            const before = structuredClone([source, reply]);
            const context = referenceContent(await compose([source, reply], { groupId }));
            assert.equal(context.includes('ORIGINAL_REVIEWED_QUOTE'), false);
            assert.equal(context.includes('PRIVATE_IMAGE_PROMPT'), false);
            assert.equal(context.includes('REVIEWED_REPLACEMENT'), mode === 'replace');
            assert.deepEqual([source, reply], before);
            reply.extra.neconyan_image_context.source_hash = 'stale';
            await assert.rejects(compose([source, reply]), error => error.imageIssue?.reason === 'mixed-reply-context');
        }
    }
    const reply = quote(source, { legacy: true });
    reply.extra.neconyan_image_context = { version: 1, mode: 'replace', text: 7, source_hash: hash(['', reply.extra.conversation_reply_to]) };
    await assert.rejects(compose([source, reply]), error => error.imageIssue?.reason === 'mixed-reply-context');
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
    await assert.rejects(compose([reply]), /cannot be checked against its original message/);
});

test('mixed old attachment text requires a source-bound reviewed choice', async () => {
    const message = structuredClone(image);
    message.extra.conversation_attachment_context = 'PRIVATE_IMAGE_PROMPT and document text';
    await assert.rejects(compose([message]), /older message saved image descriptions and file text together/);
    message.extra.neconyan_image_context = { version: 1, mode: 'omit', source_hash: hash([message.extra.conversation_attachment_context, null]) };
    assert.equal(JSON.stringify(await compose([message])).includes('PRIVATE_IMAGE_PROMPT'), false);
    message.extra.conversation_attachment_context += ' changed';
    await assert.rejects(compose([message]), /older message saved image descriptions and file text together/);
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
    await assert.rejects(compose([source, reply]), /cannot be checked against its original message/);
    assert.equal(reference.text, 'Original authored prose.');
    source.mes = 'Original authored prose.';
    reference.text = 'An independently edited quotation.';
    await assert.rejects(compose([source, reply]), /cannot be checked against its original message/);
});

test('each Conversation refusal says what is wrong and where to choose again, with the same error shape', async () => {
    const message = structuredClone(image);
    message.extra.conversation_attachment_context = 'PRIVATE_IMAGE_PROMPT and document text';
    const contextHash = hash([message.extra.conversation_attachment_context, null]);
    const mixed = 'An older message saved image descriptions and file text together. Before Show only can apply, choose what the model receives for it in Review chat images.';
    const damaged = 'A message\'s reviewed attachment text is damaged. Choose again in Review chat images.';
    const quoted = 'A reply contains a quote that cannot be checked against its original message. Your image settings require you to review the quote before continuing. Choose what the model receives in Review chat images.';
    await assert.rejects(compose([message]), { message: mixed, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: { reason: 'mixed-attachment-context', index: 0, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] } });
    message.extra.neconyan_image_context = { version: 1, mode: 'replace', text: 7, source_hash: contextHash };
    await assert.rejects(compose([message]), { message: damaged, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: { reason: 'mixed-attachment-context', index: 0, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] } });
    const reply = { id: 'reply', role: 'user', name: 'User', mes: 'Continue', extra: { conversation_reply_to: { messageId: 'picture', name: 'Nova', text: 'PRIVATE_IMAGE_PROMPT', attachmentSummary: 'PRIVATE_IMAGE_PROMPT' } } };
    await assert.rejects(compose([reply]), { message: quoted, code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: { reason: 'mixed-reply-context', index: 0, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] } });
});
