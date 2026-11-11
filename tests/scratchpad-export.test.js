import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: (parts, ...values) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '') }));
jest.unstable_mockModule('../public/scripts/notebooks/dom.js', () => ({ h: jest.fn() }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: jest.fn(), POPUP_RESULT: { AFFIRMATIVE: 1 }, POPUP_TYPE: { CONFIRM: 2 } }));

const { buildSessionExport, exportFileName, MAX_IMPORT_BYTES, sessionMarkdown, withoutAttachments } = await import('../public/scripts/scratchpad/export.js');

const webSearch = { provider: 'brave', query: 'tea\nhistory', sources: [{ title: 'Tea [history]', url: 'https://example.com/tea' }], imported: true };
const attachments = [
    { name: 'notes.txt', size: 12, kind: 'text', mimeType: 'text/plain', text: 'A ``` fence inside.' },
    { name: 'cat.png', size: 4, kind: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
];

function session() {
    return {
        id: 'a'.repeat(24),
        name: 'Tea notes',
        assistant: 'miso',
        gender: 'male',
        settings: { participants: ['miso', 'custom-1'], notes: [{ notebookId: 'nb', noteId: 'n' }], picked: [3], pickedSource: { kind: 'roleplay' }, webSearch: true },
        messages: [
            { id: 'u1', role: 'user', text: 'Where does tea come from?', created: 1, attachments },
            {
                id: 'r2', role: 'assistant', state: 'done', text: 'Second answer.', created: 3, assistant: 'miso', assistantName: 'Miso', gender: 'male',
                reasoning: 'Second thoughts.', webSearch, proposals: { 0: 'applied' }, jobId: 'job', token_count: 9, swipeIndex: 1,
                swipes: [{ id: 'r1', role: 'assistant', state: 'done', text: 'First answer.', created: 2, assistant: 'miso', assistantName: 'Miso', gender: 'male', reasoning: 'First thoughts.' }, null],
            },
            { id: 'p1', role: 'assistant', state: 'pending', text: '', created: 4, assistant: 'miso' },
        ],
    };
}

const library = [{ id: 'custom-1', name: 'Custom', personality: 'Kind.' }, { id: 'custom-2', name: 'Unused', personality: 'Absent.' }, { id: 'miso', name: 'Miso' }];

describe('Scratchpad session export', () => {
    test('the default file holds conversation text only, with every version and the assistants used', () => {
        const payload = buildSessionExport(session(), library);
        expect(payload).toMatchObject({ format: 'neconyan-scratchpad', version: 1, session: { name: 'Tea notes', assistant: 'miso', gender: 'male' } });
        expect(payload.session.settings).toMatchObject({ notes: [], picked: [], webSearch: true });
        expect(payload.session.settings.pickedSource).toBeUndefined();
        expect(Object.keys(payload.session.settings.assistants)).toEqual(['custom-1']);
        expect(payload.session.messages).toEqual([
            { role: 'user', text: 'Where does tea come from?', created: 1, assistant: undefined, assistantName: undefined, gender: undefined },
            {
                role: 'assistant', text: 'Second answer.', created: 3, assistant: 'miso', assistantName: 'Miso', gender: 'male', swipeIndex: 1,
                swipes: [
                    { role: 'assistant', text: 'First answer.', created: 2, assistant: 'miso', assistantName: 'Miso', gender: 'male' },
                    { role: 'assistant', text: 'Second answer.', created: 3, assistant: 'miso', assistantName: 'Miso', gender: 'male' },
                ],
            },
        ]);
        expect(JSON.stringify(payload)).not.toMatch(/thoughts|example\.com|notes\.txt|applied|"job"/);
    });

    test('ticked extras travel with each message and version, without saved permissions', () => {
        const [user, reply] = buildSessionExport(session(), library, { reasoning: true, sources: true, attachments: true }).session.messages;
        expect(user.attachments).toEqual(attachments);
        expect(reply.reasoning).toBe('Second thoughts.');
        expect(reply.webSearch).toEqual({ provider: 'brave', query: 'tea\nhistory', sources: webSearch.sources });
        expect(reply.swipes.map(item => item.reasoning)).toEqual(['First thoughts.', 'Second thoughts.']);
        expect(reply).not.toHaveProperty('proposals');
        expect(reply).not.toHaveProperty('jobId');

        const only = buildSessionExport(session(), library, { sources: true }).session.messages;
        expect(only[0]).not.toHaveProperty('attachments');
        expect(only[1]).not.toHaveProperty('reasoning');
        expect(only[1].webSearch.sources).toHaveLength(1);
    });

    test('the Markdown transcript shows the chosen version and only the extras that were ticked', () => {
        const plain = sessionMarkdown(session());
        expect(plain).toBe('# Tea notes\n\n## You\n\nWhere does tea come from?\n\n*Attached: notes.txt*\n\n*Attached: cat.png*\n\n## Miso (version 2 of 2)\n\nSecond answer.\n');

        const full = sessionMarkdown(session(), { reasoning: true, sources: true, attachments: true });
        expect(full).toContain('<details>\n<summary>Thinking</summary>\n\nSecond thoughts.\n\n</details>');
        expect(full).not.toContain('First');
        expect(full).toContain('**notes.txt**\n\n````\nA ``` fence inside.\n````');
        expect(full).toContain('![cat.png](data:image/png;base64,AAAA)');
        expect(full).toContain('**Sources** (Search query: tea history)\n\n1. [Tea \\[history\\]](<https://example.com/tea>)');
    });

    test('the transcript falls back to plain names', () => {
        const text = sessionMarkdown({ name: '', messages: [{ role: 'assistant', state: 'done', text: 'Hello.', assistant: 'taro' }] }, { nameOf: () => 'Taro' });
        expect(text).toBe('# Scratchpad\n\n## Taro\n\nHello.\n');
        expect(sessionMarkdown({ name: 'N', messages: [{ role: 'assistant', state: 'done', text: 'Hello.' }] })).toContain('## Assistant');
    });

    test('file names are safe and an oversized import can drop its attachments', () => {
        expect(exportFileName('Tea / notes: one', 'md')).toBe('Tea_notes_one.md');
        expect(exportFileName('', 'json')).toBe('scratchpad.json');
        expect(exportFileName('x'.repeat(90), 'json')).toBe(`${'x'.repeat(60)}.json`);
        expect(MAX_IMPORT_BYTES).toBeLessThan(4_000_000);

        const trimmed = withoutAttachments({ name: 'Tea', messages: [{ role: 'user', text: 'Hi', attachments }, null, { role: 'assistant', text: 'Yo' }] });
        expect(trimmed).toEqual({ name: 'Tea', messages: [{ role: 'user', text: 'Hi' }, null, { role: 'assistant', text: 'Yo' }] });
        expect(withoutAttachments({ name: 'Tea' }).messages).toEqual([]);
    });
});
