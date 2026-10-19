import { describe, expect, jest, test } from '@jest/globals';
import {
    CURRENT_CONNECTION_ID,
    buildRegexDraftMessages,
    listRegexDraftProfiles,
    parseRegexDraftResponse,
    requestRegexDraft,
    resolveRegexDraftProfileId,
    trimRegexDraftSample,
} from '../public/scripts/extensions/regex/ai-draft.js';

const goodReply = JSON.stringify({
    name: 'Hide asterisk actions',
    find: '/\\*[^*]+\\*/g',
    replace: '',
    trim: [],
    affects: ['ai', 'user'],
    changes: 'display',
    example: 'Hello *waves* there',
    explanation: 'Removes anything between asterisks from what you see.',
});

describe('regex drafting prompt', () => {
    test('asks for a JSON rule and passes the request and sample', () => {
        const messages = buildRegexDraftMessages({ request: '  hide actions  ', sample: 'Hi *waves*' });
        expect(messages.map(message => message.role)).toEqual(['system', 'user']);
        expect(messages[0].content).toContain('Answer with one JSON object');
        expect(messages[1].content).toContain('Request: hide actions');
        expect(messages[1].content).toContain('<<<\nHi *waves*\n>>>');
        expect(messages[1].content).not.toContain('Improve this existing rule');
    });

    test('includes the open rule when refining', () => {
        const messages = buildRegexDraftMessages({ request: 'also bold it', current: { name: 'Old', find: '/a/g', replace: 'b' } });
        expect(messages[1].content).toContain('Improve this existing rule');
        expect(messages[1].content).toContain('find: /a/g');
    });

    test('caps long samples', () => {
        const trimmed = trimRegexDraftSample('x'.repeat(5000));
        expect(trimmed.length).toBeLessThan(1600);
        expect(trimmed.endsWith('[...]')).toBe(true);
    });
});

describe('reading the model reply', () => {
    test('maps a clean reply onto editor values', () => {
        const result = parseRegexDraftResponse(goodReply);
        expect(result.ok).toBe(true);
        expect(result.draft).toMatchObject({
            name: 'Hide asterisk actions',
            find: '/\\*[^*]+\\*/g',
            replace: '',
            placement: [1, 2],
            markdownOnly: true,
            promptOnly: false,
        });
    });

    test('ignores reasoning blocks and code fences', () => {
        const reply = `<think>{"find": "nope"}</think>Here you go:\n\`\`\`json\n${goodReply}\n\`\`\``;
        expect(parseRegexDraftResponse(reply).draft.name).toBe('Hide asterisk actions');
    });

    test('wraps a bare pattern and falls back to AI replies shown on screen', () => {
        const result = parseRegexDraftResponse('{"find": "OOC:.*", "changes": "both"}');
        expect(result.draft.find).toBe('/OOC:.*/g');
        expect(result.draft.placement).toEqual([2]);
        expect(result.draft).toMatchObject({ markdownOnly: true, promptOnly: true });
    });

    test('maps every change mode', () => {
        const modes = Object.fromEntries(['display', 'prompt', 'both', 'chat', 'weird'].map(changes => {
            const { markdownOnly, promptOnly } = parseRegexDraftResponse(JSON.stringify({ find: '/a/', changes })).draft;
            return [changes, [markdownOnly, promptOnly]];
        }));
        expect(modes).toEqual({
            display: [true, false],
            prompt: [false, true],
            both: [true, true],
            chat: [false, false],
            weird: [true, false],
        });
    });

    test('explains replies it cannot use', () => {
        expect(parseRegexDraftResponse('Sorry, I cannot help.')).toEqual({ ok: false, error: expect.stringContaining('did not answer with a rule') });
        expect(parseRegexDraftResponse('{"find": ""}')).toEqual({ ok: false, error: expect.stringContaining('left the pattern empty') });
        expect(parseRegexDraftResponse('{"find": "/(unclosed/g"}')).toEqual({ ok: false, error: expect.stringContaining('does not work') });
    });
});

describe('connection profiles', () => {
    test('lists supported profiles by name with their mode', () => {
        const service = {
            getSupportedProfiles: () => [
                { id: 'b', name: 'Zed', mode: 'tc' },
                { id: 'a', name: 'Alpha', mode: 'cc' },
                { name: 'No id' },
            ],
        };
        expect(listRegexDraftProfiles(service)).toEqual([
            { id: 'a', name: 'Alpha', mode: 'Chat Completion' },
            { id: 'b', name: 'Zed', mode: 'Text Completion' },
        ]);
    });

    test('returns no profiles when Connection Manager is off', () => {
        expect(listRegexDraftProfiles(undefined)).toEqual([]);
        expect(listRegexDraftProfiles({ getSupportedProfiles: () => { throw new Error('disabled'); } })).toEqual([]);
    });

    test('keeps the saved profile only while it still exists', () => {
        const profiles = [{ id: 'a' }];
        expect(resolveRegexDraftProfileId(profiles, 'a')).toBe('a');
        expect(resolveRegexDraftProfileId(profiles, 'gone')).toBe(CURRENT_CONNECTION_ID);
    });
});

describe('sending the request', () => {
    test('uses the chosen profile through Connection Manager', async () => {
        const controller = new AbortController();
        const service = {
            constructPrompt: jest.fn(messages => messages),
            sendRequest: jest.fn(async () => ({ content: goodReply })),
        };
        const generateRaw = jest.fn();
        const result = await requestRegexDraft({ service, generateRaw, profileId: 'p1', request: 'hide actions', signal: controller.signal });
        expect(result.ok).toBe(true);
        expect(service.constructPrompt).toHaveBeenCalledWith(expect.any(Array), 'p1');
        expect(service.sendRequest).toHaveBeenCalledWith('p1', expect.any(Array), 4096, expect.objectContaining({ stream: false, extractData: true, signal: controller.signal }));
        expect(generateRaw).not.toHaveBeenCalled();
    });

    test('uses the current connection when no profile is picked', async () => {
        const generateRaw = jest.fn(async () => goodReply);
        const service = { sendRequest: jest.fn() };
        const result = await requestRegexDraft({ service, generateRaw, profileId: CURRENT_CONNECTION_ID, request: 'hide actions' });
        expect(result.ok).toBe(true);
        expect(generateRaw).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining('JSON'), prompt: expect.stringContaining('hide actions'), responseLength: 4096 }));
        expect(service.sendRequest).not.toHaveBeenCalled();
    });

    test('explains when the chosen route is unavailable', async () => {
        await expect(requestRegexDraft({ profileId: 'p1', request: 'x' })).resolves.toEqual({ ok: false, error: expect.stringContaining('Connection Manager') });
        await expect(requestRegexDraft({ profileId: '', request: 'x' })).resolves.toEqual({ ok: false, error: expect.stringContaining('No connection is ready') });
    });
});
