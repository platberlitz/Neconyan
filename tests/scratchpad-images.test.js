/* global globalThis */
import { beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';

const characters = [{ avatar: 'Nova.png', name: 'Nova' }];
let owner = 'kris';
const getOneCharacter = jest.fn();
const refreshCharacterAvatar = jest.fn();
const printCharactersDebounced = jest.fn();
const emit = jest.fn();
const capability = { ensureReady: jest.fn() };
const readImageAvailability = jest.fn();
const readAvatarReview = jest.fn();
const generateImage = jest.fn();
jest.unstable_mockModule('../public/script.js', () => ({ characters, getOneCharacter, refreshCharacterAvatar, printCharactersDebounced,
    select_selected_character: jest.fn(), this_chid: 0, getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({ event_types: { CHARACTER_EDITED: 'edited' }, eventSource: { emit } }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.unstable_mockModule('../public/scripts/user.js', () => ({ getCurrentUserHandle: () => owner }));
jest.unstable_mockModule('../public/scripts/jobs.js', () => ({ cancelJob: jest.fn(), retryJob: jest.fn(), getJobApproval: jest.fn(), decideJobApproval: jest.fn() }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/extension-capabilities.js', () => ({ getExtensionCapability: () => capability }));
const h = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat(Infinity).filter(Boolean), append(...values) { this.children.push(...values.filter(Boolean)); } });
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({ h }));
jest.unstable_mockModule('../public/scripts/scratchpad/api.js', () => ({ readImageAvailability, readAvatarReview, generateImage, newSubmissionKey: () => 'image-key' }));
const { renderImageCard, prepareAvatarChange, generateProposal, reviewImagePrompt } = await import('../public/scripts/scratchpad/images.js');
const source = { kind: 'general', key: 'general', avatar: 'Nova.png' };
const session = { id: 'session' };
const part = { index: 0, change: { type: 'image', action: 'generate', target: 'avatar', character: 'Nova', prompt: 'Portrait.' } };
const message = () => ({ id: 'reply', images: { 0: { state: 'done', target: 'avatar', avatar: 'Nova.png', prompt: 'Portrait.', url: '/user/images/Scratchpad/scratchpad-new.png' } } });
const nodes = root => [root, ...root.children.flatMap(child => child?.tag ? nodes(child) : [])];

beforeEach(() => {
    jest.clearAllMocks(); owner = 'kris';
    getOneCharacter.mockResolvedValue(true); refreshCharacterAvatar.mockResolvedValue();
    readImageAvailability.mockResolvedValue({ image: true, reason: '' });
    readAvatarReview.mockResolvedValue({ avatar: 'Nova.png', name: 'Nova', revision: 'a'.repeat(64), currentUrl: '/user/images/Scratchpad/scratchpad-old.png',
        proposedUrl: '/user/images/Scratchpad/scratchpad-new.png', bucket: {} });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async url => url === '/api/characters/edit-avatar' ? { ok: true } : { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) });
});
afterEach(() => jest.restoreAllMocks());

describe('Scratchpad images and avatar reviews', () => {
    test('rendering, reopening and applied-state rendering never generate or upload an image', () => {
        const onGenerate = jest.fn();
        const render = msg => renderImageCard({ session, message: msg, part, availability: { image: true }, onGenerate,
            button: (label, onclick, options) => h('button', { text: label, onclick, ...options }) });
        for (const msg of [{ id: 'reply' }, message(), { ...message(), proposals: { 0: 'applied' } }]) render(msg);
        expect(onGenerate).not.toHaveBeenCalled();
        expect(generateImage).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(nodes(render({ ...message(), proposals: { 0: 'applied' } })).some(node => node.tag === 'img')).toBe(true);
    });

    test('only pressing Generate submits a source-bound saved proposal after settings acknowledgement', async () => {
        const acknowledge = jest.fn(async () => ({ settingsRevision: 7 }));
        await generateProposal({ source, session, message: message(), part, guard: () => {}, acknowledge });
        expect(acknowledge).toHaveBeenCalledTimes(1);
        expect(generateImage).toHaveBeenCalledWith({ source, sessionId: 'session', messageId: 'reply', index: 0,
            submissionKey: 'image-key', acknowledgement: { settingsRevision: 7 } });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('unavailable generation is inline-capable and does not submit or upload', async () => {
        readImageAvailability.mockResolvedValue({ image: false, reason: 'Set up Quick Image Gen.' });
        await expect(generateProposal({ source, session, message: message(), part, guard: () => {}, acknowledge: jest.fn() })).rejects.toThrow('Set up');
        expect(generateImage).not.toHaveBeenCalled();
    });

    test('a pending image waiting for prompt review offers the review and no stop', () => {
        const onPromptReview = jest.fn();
        const job = { id: 'image-job', state: 'waiting', stage: 'approval', result: { approval: { id: 'approval-1' } } };
        const pending = { id: 'reply', images: { 0: { state: 'pending', jobId: 'image-job' } } };
        const card = renderImageCard({ session, message: pending, part, job, availability: { image: true }, onPromptReview, onError: jest.fn(),
            button: (label, onclick, options) => h('button', { text: label, onclick, ...options }) });
        const buttons = nodes(card).filter(node => node.tag === 'button');
        expect(buttons.map(node => node.attributes.text)).toEqual(['Review image prompt']);
        expect(buttons[0].attributes.onclick).toBe(onPromptReview);
        expect(nodes(card).some(node => node.attributes.text === 'Review the processed image prompt before generation.')).toBe(true);
        expect(generateImage).not.toHaveBeenCalled();
    });

    test('a pending image that is generating offers Stop image and no review', async () => {
        const { cancelJob } = await import('../public/scripts/jobs.js');
        cancelJob.mockResolvedValueOnce();
        const job = { id: 'image-job', state: 'running', stage: null, result: null };
        const pending = { id: 'reply', images: { 0: { state: 'pending', jobId: 'image-job' } } };
        const card = renderImageCard({ session, message: pending, part, job, availability: { image: true }, onPromptReview: jest.fn(), onError: jest.fn(),
            button: (label, onclick, options) => h('button', { text: label, onclick, ...options }) });
        const buttons = nodes(card).filter(node => node.tag === 'button');
        expect(buttons.map(node => node.attributes.text)).toEqual(['Stop image']);
        expect(nodes(card).some(node => node.attributes.text === 'Generating image...')).toBe(true);
        buttons[0].attributes.onclick();
        await new Promise(resolve => setImmediate(resolve));
        expect(cancelJob).toHaveBeenCalledWith('image-job');
    });

    test('the prompt review window declines with Cancel, not Stop image', async () => {
        const { getJobApproval, decideJobApproval } = await import('../public/scripts/jobs.js');
        getJobApproval.mockResolvedValueOnce({ id: 'approval-1', proposal: { prompt: 'Portrait.', negative: 'lowres' } });
        const popup = jest.fn(async () => 0);
        await reviewImagePrompt({ id: 'image-job', result: { approval: { id: 'approval-1' } } }, { guard: () => {}, popup, type: 'confirm', affirmative: 1 });
        const [content, type, value, options] = popup.mock.calls[0];
        expect(type).toBe('confirm');
        expect(value).toBe('');
        expect(options.okButton).toBe('Generate reviewed image');
        expect(options.cancelButton).toBe('Cancel');
        expect(content.children.map(child => child.attributes.text)).toEqual(['Processed image prompt', 'Portrait.', 'Exclude: lowres']);
        expect(decideJobApproval).toHaveBeenCalledWith('image-job', { id: 'approval-1', proposal: { prompt: 'Portrait.', negative: 'lowres' }, decision: 'deny' });
    });

    test('Not now leaves the card unchanged and a visual review shows labelled Current and Proposed pictures', async () => {
        const plan = await prepareAvatarChange({ source, session, message: message(), part, guard: () => {} });
        expect(nodes(plan.visual).filter(node => node.tag === 'figcaption').map(node => node.attributes.text)).toEqual(['Current avatar', 'Proposed avatar']);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(plan.bucket).toEqual({});

        // Drive the real review popup with Not now: the commit must never run.
        const vm = await import('node:vm');
        const fs = await import('node:fs');
        const indexSource = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
        const commit = jest.fn(async () => ({ committed: true }));
        const stubPlan = { ...plan, editable: false, after: '', visual: plan.visual, hint: plan.hint, commit };
        const applied = [];
        const markChange = jest.fn();
        const popup = jest.fn(async () => 0);
        const element = (tag, attributes = {}, ...children) => ({ tag, attributes, children: children.flat(Infinity).filter(Boolean) });
        const runtime = vm.createContext({
            app: { source, queue: Promise.resolve() }, committedChanges: new Set(),
            h: element, t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
            POPUP_TYPE: { CONFIRM: 'confirm' }, POPUP_RESULT: { AFFIRMATIVE: 1 },
            callGenericPopup: popup, changeDiff: () => element('div'), reportError: error => { throw error; },
            requireScope: jest.fn(), sameChat: () => true, currentSettings: () => ({ include: { card: true } }),
            wireSource: value => value, applyBucket: bucket => applied.push(bucket), markChange,
            images: { prepareAvatarChange: jest.fn(async () => stubPlan) },
            toastr: { success: jest.fn(), info: jest.fn() },
        });
        vm.runInContext(indexSource.match(/^async function reviewAndSaveChange\([\s\S]*?^}/m)[0], runtime);
        await runtime.reviewAndSaveChange(session, message(), part, 'review-key');
        expect(popup).toHaveBeenCalledTimes(1);
        expect(applied).toEqual([plan.bucket]);
        expect(commit).not.toHaveBeenCalled();
        expect(markChange).not.toHaveBeenCalled();
    });

    test('explicit Save uses only the captured filename and revision, then refreshes every avatar surface', async () => {
        const plan = await prepareAvatarChange({ source, session, message: message(), part, guard: () => {} });
        await expect(plan.commit()).resolves.toMatchObject({ committed: true, refreshFailed: false });
        const form = globalThis.fetch.mock.calls[0][1].body;
        expect(form.get('avatar_url')).toBe('Nova.png');
        expect(form.get('expected_revision')).toBe('a'.repeat(64));
        expect(JSON.parse(form.get('scratchpad_avatar_review'))).toEqual({ source, sessionId: 'session', messageId: 'reply', index: 0 });
        expect(getOneCharacter).toHaveBeenCalledWith('Nova.png');
        expect(printCharactersDebounced).toHaveBeenCalled();
        expect(emit).toHaveBeenCalled();
        expect(refreshCharacterAvatar).toHaveBeenCalledWith('Nova.png');
    });

    test.each(['account', 'source'])('a changed %s prevents upload after review', async kind => {
        let current = true;
        const plan = await prepareAvatarChange({ source, session, message: message(), part, guard: () => { if (!current) throw new Error('Source changed'); } });
        if (kind === 'account') owner = 'other'; else current = false;
        await expect(plan.commit()).rejects.toThrow('changed');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('a changed card revision refuses the upload without reporting success', async () => {
        const plan = await prepareAvatarChange({ source, session, message: message(), part, guard: () => {} });
        globalThis.fetch.mockImplementation(async url => url === '/api/characters/edit-avatar'
            ? { ok: false, status: 409, json: async () => ({ message: 'The character changed.' }) }
            : { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) });
        await expect(plan.commit()).rejects.toThrow('character changed');
        expect(refreshCharacterAvatar).not.toHaveBeenCalled();
    });

    test('a refresh failure is reported as a successful saved avatar needing refresh', async () => {
        refreshCharacterAvatar.mockRejectedValueOnce(new Error('Failed view refresh'));
        const plan = await prepareAvatarChange({ source, session, message: message(), part, guard: () => {} });
        await expect(plan.commit()).resolves.toMatchObject({ committed: true, refreshFailed: true });
    });

    test('Retry saved job asks the thread to reload once the retry succeeds', async () => {
        const { retryJob } = await import('../public/scripts/jobs.js');
        retryJob.mockResolvedValueOnce();
        const onRetried = jest.fn();
        const failed = { id: 'reply', images: { 0: { state: 'failed', target: 'image', jobId: 'image-job', error: 'Stopped.' } } };
        const card = renderImageCard({ session, message: failed, part, availability: { image: true }, onRetried, onError: jest.fn(),
            button: (label, onclick, options) => h('button', { text: label, onclick, ...options }) });
        nodes(card).find(node => node.attributes.text === 'Retry saved job').attributes.onclick();
        await new Promise(resolve => setImmediate(resolve));
        expect(retryJob).toHaveBeenCalledWith('image-job');
        expect(onRetried).toHaveBeenCalledTimes(1);
    });

    test('unsafe model URLs never become image elements or review upload sources', async () => {
        const msg = message(); msg.images[0].url = 'https://bad.invalid/image.png';
        const card = renderImageCard({ session, message: msg, part, availability: { image: true }, button: text => h('button', { text }) });
        expect(nodes(card).filter(node => node.tag === 'img')).toEqual([]);
        readAvatarReview.mockResolvedValue({ avatar: 'Nova.png', revision: 'a'.repeat(64), currentUrl: '/user/images/Scratchpad/scratchpad-old.png', proposedUrl: 'data:image/png;base64,AAAA' });
        await expect(prepareAvatarChange({ source, session, message: message(), part, guard: () => {} })).rejects.toThrow('verify');
    });
});
