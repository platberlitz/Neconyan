/* eslint playwright/expect-expect: off -- Native file evidence and shared prompt construction. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fixture, png } from './roleplay-transactions-fixture.js';
import { roleplayHash } from '../src/roleplay-store.js';
import { decodeCompatibleImage, publishManagedImage, verifyPromptImageCopy, accountImagePath } from '../src/managed-image-files.js';
import { attachmentIdentity, createPromptMediaContext, promptImageCopyDescriptor } from '../public/scripts/prompt-media-policy.js';
import { composeConversationPromptMessages } from '../public/scripts/neconyan-conversation/prompt-messages.js';
const { buildConversationPromptMessages } = await import('../src/endpoints/conversation-generation.js');
function setup(t) {
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    const original = path.join(f.scope.directories.userImages, 'original.png');
    fs.writeFileSync(original, png);
    const image = decodeCompatibleImage(`data:image/png;base64,${png.toString('base64')}`);
    const published = publishManagedImage(f.scope.directories, image);
    const item = { type: 'image', url: '/user/images/original.png' };
    item.neconyan_prompt = { version: 1, mode: 'include', attachment_hash: roleplayHash(attachmentIdentity(item)),
        image_url: published, original_evidence: { rawHash: image.rawHash } };
    const message = { id: 'picture', role: 'user', name: 'User', mes: 'Look', extra: { media: [item] } };
    return { ...f, original, item, message };
}
function roleplayHashBytes(bytes) { return process.getBuiltinModule('crypto').createHash('sha256').update(bytes).digest('hex'); }
for (const damage of ['changed-original', 'missing-original', 'changed-copy', 'missing-copy']) test(`Conversation refuses ${damage} before converting a derivative`, async t => {
    const f = setup(t), copy = accountImagePath(f.scope.directories, f.item.neconyan_prompt.image_url);
    if (damage === 'changed-original') fs.writeFileSync(f.original, Buffer.concat([png, Buffer.from('changed')]));
    if (damage === 'missing-original') fs.unlinkSync(f.original);
    if (damage === 'changed-copy') fs.writeFileSync(copy, Buffer.concat([png, Buffer.from('changed')]));
    if (damage === 'missing-copy') fs.unlinkSync(copy);
    let conversions = 0;
    await assert.rejects(composeConversationPromptMessages([f.message], 'Reply', 'Nova', {
        mediaPolicy: createPromptMediaContext({}), hash: roleplayHash,
        validateImages: copies => copies.forEach(value => verifyPromptImageCopy(f.scope.directories, value)),
        convertImages: async (_urls, { beforeRead }) => { await beforeRead(0); conversions++; return []; },
    }));
    assert.equal(conversions, 0);
    await assert.rejects(buildConversationPromptMessages([f.message], 'Reply', 'Nova', {
        userDirectories: f.scope.directories, mediaPolicy: createPromptMediaContext({}),
    }));
});
test('an identical imported original remains valid and proof descriptors never enter provider messages', async t => {
    const f = setup(t);
    fs.unlinkSync(f.original); fs.writeFileSync(f.original, png);
    const value = verifyPromptImageCopy(f.scope.directories, promptImageCopyDescriptor(f.item));
    assert.equal(value.rawHash, roleplayHashBytes(png));
    const result = await buildConversationPromptMessages([f.message], 'Reply', 'Nova', {
        userDirectories: f.scope.directories, mediaPolicy: createPromptMediaContext({}),
    });
    assert.ok(JSON.stringify(result).includes('data:image/png;base64,'));
    assert.equal(JSON.stringify(result).includes('originalHash'), false);
    assert.equal(JSON.stringify(result).includes('promptImageCopies'), false);
});
test('display-only never validates or converts a damaged derivative; an unvalidated included copy fails closed', async t => {
    const f = setup(t); fs.unlinkSync(f.original);
    let validations = 0, conversions = 0;
    const options = { hash: roleplayHash, validateImages: () => { validations++; }, convertImages: () => { conversions++; return []; } };
    await composeConversationPromptMessages([f.message], 'Reply', 'Nova', { ...options,
        mediaPolicy: createPromptMediaContext({ power_user: { neconyan_prompt_media: { version: 1, images: 'display-only' } } }),
    });
    assert.equal(validations, 0); assert.equal(conversions, 0);
    await assert.rejects(composeConversationPromptMessages([f.message], 'Reply', 'Nova', {
        ...options, validateImages: undefined, mediaPolicy: createPromptMediaContext({}),
    }), /Review saved prompt copies/);
    assert.equal(conversions, 0);
});
test('Conversation mode-only choice changes retain bound copy evidence; changed attachments cannot inherit it', t => {
    const f = setup(t), source = fs.readFileSync(new URL('../public/scripts/prompt-media-client.js', import.meta.url), 'utf8');
    const start = source.indexOf('function generatedImagePromptPolicy('), end = source.indexOf('\n}', start) + 2;
    const policy = vm.runInNewContext('(' + source.slice(start, end) + ')', { promptAttachmentHash: roleplayHash, attachmentIdentity });
    let item = f.item;
    for (const mode of ['display-only', 'include', 'caption', 'include']) {
        item = policy(item, mode);
        assert.equal(item.neconyan_prompt.image_url, f.item.neconyan_prompt.image_url);
        assert.equal(item.neconyan_prompt.original_evidence.rawHash, f.item.neconyan_prompt.original_evidence.rawHash);
    }
    assert.equal(policy({ ...item, url: '/user/images/other.png' }, 'include').neconyan_prompt.image_url, undefined);
});

for (const position of [32, 33]) test(`Conversation validates derivative at position ${position} only when its converter will read it`, async t => {
    const f = setup(t); fs.unlinkSync(f.original);
    const ordinary = Array.from({ length: Math.ceil((position - 1) / 4) }, (_, index) => ({ id: `ordinary-${index}`, role: 'user', mes: '',
        extra: { media: Array.from({ length: Math.min(4, position - 1 - index * 4) }, () => ({ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` })) } }));
    const call = () => buildConversationPromptMessages([...ordinary, f.message], 'Reply', 'Nova', {
        userDirectories: f.scope.directories, mediaPolicy: createPromptMediaContext({}),
    });
    if (position === 32) await assert.rejects(call(), /original file changed or is missing/);
    else assert.equal((await call()).flatMap(row => Array.isArray(row.content) ? row.content : []).filter(part => part.type === 'image_url').length, 32);
});
test('aggregate byte exhaustion does not validate a later unread image', async () => {
    const { convertImageUrlsToBase64 } = await import('../src/endpoints/conversation-utils.js');
    const visited = [];
    const result = await convertImageUrlsToBase64([`data:image/png;base64,${png.toString('base64')}`, '/never-read'], 1, {
        maxAggregateBytes: png.length, beforeRead: index => { visited.push(index); if (index === 1) throw new Error('unread image'); },
    });
    assert.deepEqual(visited, [0]); assert.equal(result[1], '');
});

test('an empty ordinary image cannot displace derivative validation', async t => {
    const f = setup(t); fs.unlinkSync(f.original);
    f.message.extra.media.unshift({ type: 'image', url: '' });
    await assert.rejects(buildConversationPromptMessages([f.message], 'Reply', 'Nova', {
        userDirectories: f.scope.directories, mediaPolicy: createPromptMediaContext({}),
    }), /original file changed or is missing/);
});
test('Conversation accepts a legacy image without dereferencing modern media fields', async () => {
    const result = await buildConversationPromptMessages([{ id: 'legacy', role: 'user', mes: 'Look',
        extra: { image: `data:image/png;base64,${png.toString('base64')}` } }], 'Reply', 'Nova', {
        mediaPolicy: createPromptMediaContext({}),
    });
    assert.equal(result.flatMap(row => Array.isArray(row.content) ? row.content : []).filter(part => part.type === 'image_url').length, 1);
});
