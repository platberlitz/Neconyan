import { describe, expect, test } from '@jest/globals';
import {
    HIDDEN_ENTRY_PLACEHOLDER,
    IMAGE_PLACEHOLDER,
    LAST_PROMPT_HEADING,
    MEDIA_PLACEHOLDER,
    STORED_PROMPT_MAX_CHARS,
    formatLastPrompt,
    formatMissingLastPrompt,
    hiddenEntryNeedles,
    itemizedPromptRecord,
    latestItemizedPrompt,
    normalisePromptPayload,
    normalisePromptRecord,
    pickLatestPrompt,
    redactPromptText,
    scrubHiddenEntries,
} from '../public/scripts/scratchpad/last-prompt.js';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.repeat(12);

describe('Scratchpad last prompt formatting', () => {
    test('formats a Chat Completion message array with indexes, roles, names and exact text', () => {
        const entry = {
            main_api: 'openai', presetName: 'Story preset', model: 'gpt-test', this_max_context: 32000, tokenizer: 'o200k',
            messagesCount: 2, examplesCount: 1, generationType: 'normal', recordedAt: NOW - 120_000,
            oaiMainTokens: 120, oaiConversationTokens: 340, oaiTotalTokens: 460,
            rawPrompt: [
                { role: 'system', content: 'You are Mira.\n  Keep the scene moving.' },
                { role: 'user', name: 'Kris', content: 'Hello  there, Mira.' },
                { role: 'assistant', content: 'Hi!' },
            ],
        };
        const { text, hidden, redactions, trimmed } = formatLastPrompt(itemizedPromptRecord(entry), { now: NOW });
        expect(text.startsWith(`${LAST_PROMPT_HEADING}\n`)).toBe(true);
        expect(text).toContain(`Sent: ${new Date(NOW - 120_000).toISOString()} (2 minutes ago)`);
        expect(text).toContain('Mode: Roleplay, Chat Completion, normal request');
        expect(text).toContain('Model: gpt-test; Preset: Story preset');
        expect(text).toContain('Context limit: 32000 tokens; Tokenizer: o200k; Chat messages in prompt: 2; Example messages: 1');
        expect(text).toContain('Token counts: main prompt 120, conversation 340, total 460');
        expect(text).toContain('Messages: 3');
        expect(text.endsWith('\n\n[end of last prompt sent]')).toBe(true);
        expect(text).toContain('### 1. system\nYou are Mira.\n  Keep the scene moving.');
        expect(text).toContain('### 2. user (name: Kris)\nHello  there, Mira.');
        expect(text).toContain('### 3. assistant\nHi!');
        expect(text.indexOf('### 1.')).toBeLessThan(text.indexOf('### 2.'));
        expect(text).not.toContain('Notes:');
        expect({ hidden, redactions, trimmed }).toEqual({ hidden: 0, redactions: 0, trimmed: 0 });
    });

    test('shares a Text Completion prompt string exactly', () => {
        const prompt = '<|system|>Story so far\n\n### Instruction:\nKris: Hello\nMira:';
        const record = itemizedPromptRecord({ main_api: 'textgenerationwebui', rawPrompt: prompt, recordedAt: NOW, this_max_context: 8192 });
        const { text } = formatLastPrompt(record, { now: NOW });
        expect(text).toContain('Mode: Roleplay, Text Completion');
        expect(text).toContain(`Prompt text (exact):\n${prompt}\n[end of prompt]`);
        expect(text).toContain('(just now)');
        expect(formatLastPrompt(itemizedPromptRecord({ main_api: 'kobold', rawPrompt: 'Once' }), { now: NOW }).text).toContain('Mode: Roleplay, KoboldAI');
        expect(formatLastPrompt(itemizedPromptRecord({ main_api: 'novel', rawPrompt: 'Once' }), { now: NOW }).text).toContain('Mode: Roleplay, NovelAI');
    });

    test('leaves base64 and media parts out of multimodal messages', () => {
        const payload = normalisePromptPayload([
            { role: 'user', content: [
                { type: 'text', text: 'Look at this' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${BASE64}` } },
                { type: 'input_audio', input_audio: { data: BASE64, format: 'wav' } },
            ] },
            { role: 'user', content: `Inline data:image/jpeg;base64,${BASE64} and data:audio/wav;base64,${BASE64} and raw ${BASE64}` },
        ]);
        expect(payload[0].content).toBe(`Look at this\n${IMAGE_PLACEHOLDER}\n${MEDIA_PLACEHOLDER}`);
        expect(payload[1].content).toBe(`Inline ${IMAGE_PLACEHOLDER} and ${MEDIA_PLACEHOLDER} and raw ${MEDIA_PLACEHOLDER}`);
        const { text } = formatLastPrompt({ prompt: payload, recordedAt: NOW }, { now: NOW });
        expect(text).not.toContain('iVBORw0KGgo');
        expect(text).not.toContain('base64,');
    });

    test('trims a huge prompt to the budget, keeping the start and the latest messages', () => {
        const messages = [{ role: 'system', content: 'SYSTEM-START instructions' }];
        for (let index = 0; index < 4000; index++) messages.push({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index} ${'lorem ipsum '.repeat(40)}` });
        messages.push({ role: 'user', content: 'LATEST-TAIL message' });
        const maxBytes = 64 * 1024;
        const { text, trimmed } = formatLastPrompt({ prompt: messages, recordedAt: NOW }, { now: NOW, maxBytes });
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(maxBytes);
        expect(trimmed).toBeGreaterThan(0);
        expect(text).toContain('SYSTEM-START instructions');
        expect(text).toMatch(/\[\.\.\. omitted \d+ characters to fit Scratchpad budget \.\.\.\]/);
        expect(text).toContain(`The middle was trimmed to fit the Scratchpad budget (${trimmed} characters left out).`);
        expect(text).toContain('LATEST-TAIL message');
        expect(text).toContain('its middle was left out when it was saved');
        const short = formatLastPrompt({ prompt: messages.slice(-200).concat([{ role: 'user', content: 'LATEST-TAIL message' }]), recordedAt: NOW }, { now: NOW, maxBytes: 16 * 1024 });
        expect(short.text).toContain('LATEST-TAIL message');
        expect(new TextEncoder().encode(short.text).length).toBeLessThanOrEqual(16 * 1024);
    });

    test('clips a stored prompt that is longer than Neconyan keeps and says so', () => {
        const record = normalisePromptRecord({ prompt: `START ${'lorem ipsum '.repeat(STORED_PROMPT_MAX_CHARS / 10)} END`, recordedAt: NOW });
        expect(record.clipped).toBe(true);
        expect(record.prompt.length).toBeLessThan(STORED_PROMPT_MAX_CHARS + 200);
        expect(record.prompt.startsWith('START ')).toBe(true);
        expect(record.prompt.endsWith(' END')).toBe(true);
        expect(formatLastPrompt(record, { now: NOW }).text).toContain('its middle was left out when it was saved');
    });

    test('redacts credentials and leaves ordinary prose, dialogue and lorebook text alone', () => {
        const secrets = [
            'Authorization: Bearer abcdefghijklmnop1234567890',
            'x-api-key: 9f8e7d6c5b4a39281706',
            'Here is my key sk-proj-AbCdEf1234567890GhIjKlMn',
            'Gemini AIzaSyA1234567890abcdefghijklmnopqrstu',
            'GitHub ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
            'Proxy https://kris:hunter2pass@proxy.example.com/v1 and https://api.example.com/v1?key=abc123secret&mode=fast',
            'api_key = "q1w2e3r4t5y6u7i8"',
        ].join('\n');
        const { text, count } = redactPromptText(secrets);
        expect(count).toBeGreaterThanOrEqual(8);
        for (const leaked of ['abcdefghijklmnop1234567890', '9f8e7d6c5b4a39281706', 'sk-proj-AbCdEf', 'AIzaSyA1234567890', 'ghp_abcdef', 'eyJhbGciOiJIUzI1NiJ9', 'hunter2pass', 'abc123secret', 'q1w2e3r4t5y6u7i8']) {
            expect(text).not.toContain(leaked);
        }
        expect(text).toContain('Authorization: [redacted]');
        expect(text).toContain('https://[redacted]@proxy.example.com/v1');
        expect(text).toContain('?key=[redacted]&mode=fast');

        const prose = [
            'Mira whispered, "The password is courage, and the key is in the old oak tree."',
            'Token of friendship: a silver ring. Bearer of bad news, the scout rode in at dawn.',
            'Authorization was granted by the queen herself in the year 1204.',
            'Lorebook: The Skyward Accord (signed 1204) binds the seven cities. See https://example.com/wiki/Accord?page=2 for maps.',
            'Kris: sk-8 is my skateboard brand, and AIza is a name.',
            '*She sighs.* "I counted 1234567890 stars last night."',
        ].join('\n');
        expect(redactPromptText(prose)).toEqual({ text: prose, count: 0 });
    });

    test('scrubs hidden lorebook entries as written, with names filled in, ignoring case and spacing', () => {
        const entries = [
            { content: 'The VAULT-CODE is Kestrel Nine, known only to {{char}} and {{user}}.', agentBlacklisted: true },
            { content: 'Secret marker: OBSIDIAN-ORCHID-7731', agentBlacklisted: true },
            { content: '   ', agentBlacklisted: true },
        ];
        const substitute = value => value.replace(/\{\{char\}\}/gi, 'Mira').replace(/\{\{user\}\}/gi, 'Kris');
        const needles = hiddenEntryNeedles(entries, [substitute]);
        expect(needles).toContain('Secret marker: OBSIDIAN-ORCHID-7731');
        expect(needles).toContain('The VAULT-CODE is Kestrel Nine, known only to Mira and Kris.');
        const prompt = [
            { role: 'system', content: 'World info:\nthe vault-code is kestrel nine, known only to MIRA and kris.\nKeep it calm.' },
            { role: 'system', content: 'secret   marker:\nobsidian-orchid-7731' },
            { role: 'system', content: 'Raw: The VAULT-CODE is Kestrel Nine, known only to {{char}} and {{user}}.' },
            { role: 'user', content: 'Mira, what is the obsidian orchid?' },
        ];
        const { text, hidden } = formatLastPrompt({ prompt, recordedAt: NOW }, { now: NOW, hiddenNeedles: needles });
        expect(hidden).toBe(3);
        expect(text.toLowerCase()).not.toContain('kestrel nine');
        expect(text.toLowerCase()).not.toContain('obsidian-orchid-7731');
        expect(text).toContain(`World info:\n${HIDDEN_ENTRY_PLACEHOLDER}\nKeep it calm.`);
        expect(text).toContain('Notes: Hidden lorebook entries were omitted.');
        expect(text).toContain('Mira, what is the obsidian orchid?');
    });

    test('scrubs a partly included hidden entry line by line and never cuts words out of longer words', () => {
        const needles = hiddenEntryNeedles([{ content: 'First hidden line about the moon gate.\nSecond hidden line about the tide key.' }, { content: 'Ash' }]);
        const { text, count } = scrubHiddenEntries('Only this: second hidden line about the tide key. Ashley walked past the ash tree.', needles);
        expect(text).toBe(`Only this: ${HIDDEN_ENTRY_PLACEHOLDER} Ashley walked past the ${HIDDEN_ENTRY_PLACEHOLDER} tree.`);
        expect(count).toBe(2);
    });
});

describe('Scratchpad last prompt selection', () => {
    test('picks the newest recordedAt after an earlier message is regenerated', () => {
        const entries = [
            { mesId: 1, rawPrompt: 'first', recordedAt: NOW - 3000 },
            { mesId: 5, rawPrompt: 'latest reply', recordedAt: NOW - 2000 },
            // Regenerating message 1 replaces its entry in place, so the newest prompt is not the last one in the list.
            { mesId: 3, rawPrompt: 'regenerated earlier message', recordedAt: NOW },
            { mesId: 7, rawPrompt: 'summary', recordedAt: NOW + 1000, generationType: 'quiet' },
            { mesId: 9, recordedAt: NOW + 2000 },
        ];
        expect(latestItemizedPrompt(entries).rawPrompt).toBe('regenerated earlier message');
    });

    test('falls back to the last entry with a prompt for older saved entries', () => {
        expect(latestItemizedPrompt([{ rawPrompt: 'old a' }, { rawPrompt: 'old b' }, { mesId: 4 }]).rawPrompt).toBe('old b');
        expect(latestItemizedPrompt([])).toBeNull();
        expect(latestItemizedPrompt(null)).toBeNull();
    });

    test('prefers the newer of the browser and server records', () => {
        const browser = { prompt: 'browser', recordedAt: NOW - 10 };
        const server = { prompt: 'server', recordedAt: NOW };
        expect(pickLatestPrompt([browser, server]).prompt).toBe('server');
        expect(pickLatestPrompt([{ ...browser, recordedAt: NOW + 5 }, server]).prompt).toBe('browser');
        expect(pickLatestPrompt([{ prompt: 'untimed' }, server]).prompt).toBe('server');
        expect(pickLatestPrompt([null, undefined])).toBeNull();
    });

    test('shows a plain note when no prompt has been sent', () => {
        expect(formatMissingLastPrompt()).toBe(`${LAST_PROMPT_HEADING}\nNo prompt has been sent in this chat yet, so there is nothing to share. Send or regenerate a message, then look again.`);
        expect(formatLastPrompt(null).text).toBe(formatMissingLastPrompt());
        expect(itemizedPromptRecord({ mesId: 2 })).toBeNull();
    });

    test('records Conversation server prompts with mode, speaker and backend', () => {
        const record = normalisePromptRecord({
            origin: 'server', mode: 'conversation', api: 'openai', backend: 'openrouter', model: 'story-model', speaker: 'Mira',
            contextLimit: 16000, recordedAt: NOW, prompt: [{ role: 'system', content: 'Conversation system prompt' }, { role: 'user', content: 'Hi' }],
        });
        const { text } = formatLastPrompt(record, { now: NOW });
        expect(text).toContain('Mode: Conversation, Chat Completion, openrouter');
        expect(text).toContain('Speaker: Mira; Model: story-model');
        expect(text).toContain('Context limit: 16000 tokens');
        expect(text).toContain('### 1. system\nConversation system prompt');
    });
});
