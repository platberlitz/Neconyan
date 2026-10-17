/* eslint playwright/expect-expect: off -- Pure shared policy, Node assertions. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attachmentIdentity, canonicalPromptMedia, conversationImageOrigin, createPromptMediaContext, detachMessageMedia, generatedImageInputPreference, imageInputIssueDetail, IMAGE_INPUT_SETTINGS_CHANGED, isImageInputIssue, projectPromptMediaRecords, promptMediaText, roleplayImageOrigin, selectPromptMedia, validateImagePreference } from '../public/scripts/prompt-media-policy.js';
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
    assert.throws(() => selectPromptMedia(records({ media: [image], media_display: 'gallery', media_index: -1 }), context(), { hash }), /chosen image no longer exists/);
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

// Every refusal says what is wrong and where to fix it. The wording is part of the product, so it is pinned whole.
const refusal = action => {
    try { action(); } catch (error) { return error; }
    return assert.fail('Expected a refusal');
};
const accountMessage = 'The saved setting \'Don\'t send chat images to the model\' is damaged. Turn it off and on again in User Settings.';
const chatMessage = 'This chat\'s saved setting for sending images is damaged. Turn \'Don\'t send this chat\'s images to the model\' off and on again in Review chat images.';
const damaged = { version: 2, images: 'include' };

test('a damaged account or chat setting names its own control, with the same error shape', () => {
    const account = refusal(() => createPromptMediaContext({ power_user: { neconyan_prompt_media: damaged } }));
    const chat = refusal(() => createPromptMediaContext({}, { neconyan_prompt_media: damaged }));
    assert.equal(account.message, accountMessage);
    assert.equal(chat.message, chatMessage);
    assert.ok(chat.message.endsWith('in Review chat images.'));
    for (const error of [account, chat]) {
        assert.equal(error.code, 'ROLEPLAY_IMAGE_INPUT');
        assert.equal(error.status, 409);
        assert.deepEqual(error.imageIssue, { reason: 'invalid-policy', index: -1, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] });
    }
    // The account setting is checked first, so a damaged account hides a damaged chat.
    assert.equal(refusal(() => createPromptMediaContext({ power_user: { neconyan_prompt_media: damaged } }, { neconyan_prompt_media: damaged })).message, accountMessage);
});

const branchMessage = 'This branch\'s saved setting for sending images is damaged. Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.';

test('the scope argument picks the message, and the chat message is the default', () => {
    assert.equal(refusal(() => validateImagePreference(damaged, 'account')).message, accountMessage);
    assert.equal(refusal(() => validateImagePreference(damaged, 'chat')).message, chatMessage);
    assert.equal(refusal(() => validateImagePreference(damaged, 'branch')).message, branchMessage);
    assert.equal(refusal(() => validateImagePreference(damaged)).message, chatMessage);
    assert.equal(validateImagePreference(undefined, 'account'), 'include');
    assert.equal(validateImagePreference({ version: 1, images: 'display-only' }, 'chat'), 'display-only');
});

test('a Conversation branch names the branch control; Roleplay keeps the chat message; the account is still checked first', () => {
    const branch = refusal(() => createPromptMediaContext({}, { neconyan_prompt_media: damaged }, {}, { chatScope: 'branch' }));
    assert.equal(branch.message, branchMessage);
    assert.equal(branch.code, 'ROLEPLAY_IMAGE_INPUT');
    assert.equal(branch.status, 409);
    assert.deepEqual(branch.imageIssue, { reason: 'invalid-policy', index: -1, mediaIndex: -1, actions: ['review', 'display-only', 'caption'] });
    assert.equal(refusal(() => createPromptMediaContext({}, { neconyan_prompt_media: damaged })).message, chatMessage);
    assert.equal(refusal(() => createPromptMediaContext({}, { neconyan_prompt_media: damaged }, {}, { backend: 'text' })).message, chatMessage);
    assert.equal(refusal(() => createPromptMediaContext({ power_user: { neconyan_prompt_media: damaged } }, { neconyan_prompt_media: damaged }, {}, { chatScope: 'branch' })).message, accountMessage);
    // A good branch setting is read as before, whichever scope names it.
    assert.equal(createPromptMediaContext({}, { neconyan_prompt_media: { version: 1, images: 'display-only' } }, {}, { chatScope: 'branch' }).chat, 'display-only');
    // The Conversation callers pass the branch scope, and Roleplay callers do not.
    const client = readFileSync(new URL('../public/scripts/prompt-media-client.js', import.meta.url), 'utf8');
    assert.ok(client.includes('{ chatScope: \'branch\' });\n    }\n    return browserPromptMediaContext();'), 'effectiveBrowserPromptMediaContext passes the branch scope when Conversation is open');
    const prompt = readFileSync(new URL('../public/scripts/neconyan-conversation/prompt.js', import.meta.url), 'utf8');
    assert.equal(prompt.split('browserPromptMediaContext(').length - 1, 2);
    assert.equal(prompt.split('?? {}, { chatScope: \'branch\' })').length - 1, 2, 'both Conversation prompt paths pass the branch scope');
    const participants = readFileSync(new URL('../src/generation/conversation-participants.js', import.meta.url), 'utf8');
    assert.ok(participants.includes('{ backend: material.backend, chatScope: \'branch\' }'), 'the server Conversation path passes it too');
    const recovery = readFileSync(new URL('../src/roleplay-image-recovery.js', import.meta.url), 'utf8');
    assert.ok(recovery.includes('validateImagePreference(input.chatPreference);'), 'the Roleplay recovery path stays on the chat default');
});

test('an image refusal is recognised by its code or its imageIssue, on an error, its server reply, or a reply read as data', () => {
    const issue = { reason: 'invalid-policy', index: 2, mediaIndex: 0, actions: ['review'] };
    const fromPolicy = refusal(() => createPromptMediaContext({}, { neconyan_prompt_media: damaged }));
    assert.equal(isImageInputIssue(fromPolicy), true);
    assert.equal(isImageInputIssue({ error: 'x', code: 'ROLEPLAY_IMAGE_INPUT' }), true, 'a code alone');
    assert.equal(isImageInputIssue({ error: 'x', code: null, imageIssue: issue }), true, 'an imageIssue alone');
    assert.equal(isImageInputIssue(Object.assign(new Error('x'), { status: 409, body: { error: 'x', imageIssue: issue } })), true, 'an error carrying a server reply');
    assert.equal(isImageInputIssue(Object.assign(new Error('x'), { body: { code: 'ROLEPLAY_IMAGE_INPUT' } })), true);
    for (const other of [null, undefined, 'text', 42, new Error('x'), { code: 'ROLEPLAY_INVALID' }, { imageIssue: null }, { imageIssue: 'yes' },
        Object.assign(new Error('x'), { status: 500, body: { error: 'x', code: 'roleplay_settings_ack_required' } }), { error: { message: 'x' } }]) {
        assert.equal(isImageInputIssue(other), false, JSON.stringify(other));
    }
    assert.deepEqual(imageInputIssueDetail({ error: 'Server words.', code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: issue }), { ...issue, message: 'Server words.' });
    assert.deepEqual(imageInputIssueDetail(Object.assign(new Error('Error words.'), { body: { error: 'Body words.', imageIssue: issue } })), { ...issue, message: 'Error words.' });
    assert.deepEqual(imageInputIssueDetail({ message: 'Job words.', code: 'ROLEPLAY_IMAGE_INPUT' }), { message: 'Job words.' });
    assert.deepEqual(imageInputIssueDetail(fromPolicy), { ...fromPolicy.imageIssue, message: fromPolicy.message });
    assert.equal(IMAGE_INPUT_SETTINGS_CHANGED, 'neconyan:image-input-settings-changed');
});

test('the refusal detail carries the origin it is given, and only an object counts as one', () => {
    const origin = { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'c', avatar: 'a.png' } };
    const issue = { reason: 'invalid-policy', index: 2, mediaIndex: 0, actions: ['review'] };
    assert.deepEqual(imageInputIssueDetail({ message: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT', imageIssue: issue }, origin), { ...issue, message: 'Words.', origin });
    assert.deepEqual(imageInputIssueDetail({ message: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT' }, origin), { message: 'Words.', origin });
    for (const none of [undefined, null, 'a.png', 7]) assert.deepEqual(imageInputIssueDetail({ message: 'Words.', code: 'ROLEPLAY_IMAGE_INPUT' }, none), { message: 'Words.' });
});

test('a Roleplay origin is the chat locator the review takes, with the account', () => {
    assert.deepEqual(roleplayImageOrigin({ chat: 'Chat 1', avatar: 'nova.png', group: false }, 'alice'),
        { workspace: 'roleplay', account: 'alice', locator: { group: false, chat: 'Chat 1', avatar: 'nova.png' } });
    // The chat name carries no extension, a group locator has no avatar and no group id, and the order of keys is the review's.
    assert.deepEqual(roleplayImageOrigin({ chat: 'Chat 1.jsonl', avatar: 'nova.png', group: false }, 'alice').locator, { group: false, chat: 'Chat 1', avatar: 'nova.png' });
    assert.deepEqual(roleplayImageOrigin({ chat: 'Group chat', group: true, groupId: 'g-1' }, 'alice'), { workspace: 'roleplay', account: 'alice', locator: { group: true, chat: 'Group chat' } });
    assert.equal(JSON.stringify(roleplayImageOrigin({ avatar: 'nova.png', chat: 'c', group: false }, 'a').locator), '{"group":false,"chat":"c","avatar":"nova.png"}');
    // A locator that names no chat, or a solo chat with no character, gives no origin.
    for (const bad of [null, undefined, {}, { chat: '', group: false, avatar: 'a.png' }, { chat: 'c', group: false }, { chat: 'c', group: false, avatar: '' }, { chat: 7, group: true }]) {
        assert.equal(roleplayImageOrigin(bad, 'alice'), undefined, JSON.stringify(bad));
    }
});

test('a Conversation origin names the thread and branch, and keeps lifetimeSeed and createdAt only where they are known', () => {
    const full = conversationImageOrigin({ avatar: 'a.png', groupId: 'g-1', personaId: 'p.png', branchId: 'main', lifetimeSeed: 'seed', createdAt: 111 }, 'alice');
    assert.deepEqual(full, { workspace: 'conversation', account: 'alice', avatar: 'a.png', groupId: 'g-1', personaId: 'p.png', branchId: 'main', lifetimeSeed: 'seed', createdAt: '111' });
    assert.deepEqual(conversationImageOrigin({ avatar: 'a.png', branchId: 'main' }, 'alice'),
        { workspace: 'conversation', account: 'alice', avatar: 'a.png', groupId: '', personaId: '', branchId: 'main' });
    assert.equal('lifetimeSeed' in conversationImageOrigin({ avatar: 'a.png', branchId: 'main', createdAt: '' }, 'alice'), false);
    assert.equal('createdAt' in conversationImageOrigin({ avatar: 'a.png', branchId: 'main', lifetimeSeed: '' }, 'alice'), false);
    assert.equal(conversationImageOrigin({ avatar: 'a.png', branchId: 'main', createdAt: 0 }, 'alice').createdAt, '0');
    // No character or no branch is no origin.
    for (const bad of [undefined, {}, { avatar: 'a.png' }, { branchId: 'main' }, { avatar: '', branchId: 'main' }, { avatar: 'a.png', branchId: '' }]) {
        assert.equal(conversationImageOrigin(bad, 'alice'), undefined, JSON.stringify(bad));
    }
});

test('each image refusal gives the reworded message, with its reason and coordinates unchanged', () => {
    const own = policy => ({ ...image, neconyan_prompt: { version: 1, attachment_hash: hash(attachmentIdentity(image)), ...policy } });
    const select = (extra, ctx = context()) => selectPromptMedia(records(extra), ctx, { hash });
    const cases = [
        ['invalid-policy', 'An image\'s saved choice is damaged. Choose again for it in Review chat images.', () => select({ media: [own({ mode: 'sideways' })] })],
        ['stale-policy', 'An image changed after its choice was saved. Choose again for it in Review chat images.', () => select({ media: [own({ mode: 'include', attachment_hash: 'c'.repeat(64) })] })],
        ['invalid-policy', 'An image\'s compatible copy record is damaged. Prepare a new copy in Review chat images.', () => select({ media: [own({ mode: 'include', image_url: '/elsewhere/copy.png' })] })],
        ['missing-description', 'An image set to Use a description has no description. Choose or type one in Review chat images.', () => select({ media: [own({ mode: 'caption' })] })],
        ['missing-description', 'An image\'s description is missing or longer than 16 KiB. Edit it in Review chat images.', () => select({ media: [own({ mode: 'caption', caption: { source: 'custom', text: '  ' } })] })],
        ['missing-description', 'An image\'s description is missing or longer than 16 KiB. Edit it in Review chat images.', () => select({ media: [own({ mode: 'caption', caption: { source: 'custom', text: 'x'.repeat(16 * 1024 + 1) } })] })],
        ['malformed-media', 'A message\'s attachment list is damaged. Review it in Review chat images.', () => select({ media: 'not a list' })],
        ['legacy-media', 'A message\'s older image attachment is damaged. Review it in Review chat images.', () => select({ image_swipes: [] })],
        ['invalid-display', 'A message has an unknown image layout. Switch it to list or gallery, then try again.', () => select({ media: [image], media_display: 'carousel' })],
        ['invalid-selection', 'A gallery\'s chosen image no longer exists. Pick another image in that gallery, or fix it in Review chat images.', () => select({ media: [image], media_display: 'gallery', media_index: -1 })],
        ['malformed-media', 'A message has a damaged attachment. Remove it in Review chat images.', () => select({ media: ['not an attachment'] })],
        ['too-many-images', 'A message would send more than four images. Set some to Show only, or show them as a gallery so only one is sent.', () => select({ media: Array.from({ length: 5 }, () => ({ ...image })), media_display: 'list' })],
        ['policy-version', 'The page and the server are running different versions. Reload the page, then try again.', () => select({ media: [image] }, { ...context(), version: 2 })],
        ['invalid-policy', 'Image settings could not be read. Reload the page, then try again.', () => select({ media: [image] }, { ...context(), inlineImages: 'yes' })],
    ];
    for (const [reason, message, action] of cases) {
        const error = refusal(action);
        assert.equal(error.message, message);
        assert.equal(error.code, 'ROLEPLAY_IMAGE_INPUT');
        assert.equal(error.status, 409);
        assert.equal(error.imageIssue.reason, reason, message);
        assert.deepEqual(error.imageIssue.actions, ['review', 'display-only', 'caption']);
    }
    assert.equal(new Set(cases.map(([, message]) => message)).size, cases.length - 1, 'only the two description limits share a sentence');
});
