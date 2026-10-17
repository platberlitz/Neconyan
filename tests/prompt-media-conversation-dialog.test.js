import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { loadDialog } from './prompt-media-dialog-harness.js';
import { buttonsNamed, byTag, elements, settle, shielded, textPieces } from './prompt-media-dom-stub.js';

// The Conversation image review dialog (E2 rows CNV-01 to CNV-27). The real prompt-media-ui.js runs against stand-ins for the app and the
// browser; see prompt-media-review-dialog.test.js for the Roleplay dialog. The in-app check happens in stage 4.

let env;
beforeAll(async () => { env = await loadDialog(jest); });
beforeEach(() => {
    env.reset();
    env.page.body.classes.add('neconyan-conversation-active');
    env.branchData.messages = [
        { id: 'm1', extra: { media: [{ type: 'image', url: '/user/images/a.png', title: 'Review' }, { type: 'image', url: '/user/images/b.png' }] } },
        { id: 'm2', extra: { image_url: '/user/images/g.png', image_prompt: 'Group' } },
        { id: 'm3', extra: { conversation_attachment_context: 'Older description and file text', conversation_reply_to: { text: 'quoted' } } },
    ];
});

const open = async () => { await env.ui.showPromptMediaReview(); return env.shownPanels[0]; };
const rows = panel => byTag(panel, 'fieldset');

describe('the Conversation dialog', () => {
    test('the heading and the help are the ledger\'s sentences, and the account checkbox is the shared one', async () => {
        const panel = await open();
        expect(panel.children[0].textContent).toBe('Conversation images');
        expect(panel.children[1].textContent).toBe('Choose what the model receives from each image when it writes new replies. Show only keeps an image in the Conversation but sends the model neither the image nor its saved description. It does not change message text or saved memories.');
        expect(env.lookups).toContainEqual(['Conversation images', 'scoped.prompt_media.CNV-02']);
        expect(env.popups[0].options.okButton).toBe('Close');
    });

    test('the legends are complete phrases, one of them shared with the Roleplay dialog, and they are final', async () => {
        const panel = await open();
        expect(rows(panel).map(row => row.children[0].textContent)).toEqual([
            'Message 1, image 1', 'Message 1, image 2', 'Message 2, generated image', 'Message 3, saved attachment text']);
        for (const row of rows(panel)) expect(row.children[0].hasAttribute('data-i18n-ignore')).toBe(true);
        const keys = env.lookups.filter(([, key]) => /RVW-35|CNV-13|CNV-18/.test(key ?? '')).map(([text, key]) => `${key} = ${text}`);
        expect(new Set(keys)).toEqual(new Set(['scoped.prompt_media.RVW-35.1 = Message ${0}, image ${1}', 'scoped.prompt_media.CNV-13.2 = Message ${0}, generated image',
            'scoped.prompt_media.CNV-18 = Message ${0}, saved attachment text']));
        expect(env.lookups.some(([text]) => text.includes('${0}${1}${2}'))).toBe(false);
    });

    test('every textarea has its placeholder and its accessible name built with t``, so a translation reaches all four', async () => {
        env.dictionary['Description sent to the model'] = 'Descrição enviada ao modelo';
        env.dictionary['Type the description the model receives'] = 'Escreva a descrição que o modelo recebe';
        env.dictionary['Text sent to the model instead'] = 'Texto enviado ao modelo em vez disso';
        env.dictionary['Type the text the model receives instead'] = 'Escreva o texto que o modelo recebe em vez disso';
        env.dictionary['What the model receives from this image'] = 'O que o modelo recebe desta imagem';
        const panel = await open();
        const [imageArea, , generatedArea, contextArea] = [...byTag(panel, 'textarea')];
        expect([imageArea, generatedArea].map(area => [area.getAttribute('aria-label'), area.getAttribute('placeholder')])).toEqual(
            [['Descrição enviada ao modelo', 'Escreva a descrição que o modelo recebe'], ['Descrição enviada ao modelo', 'Escreva a descrição que o modelo recebe']]);
        expect([contextArea.getAttribute('aria-label'), contextArea.getAttribute('placeholder')]).toEqual(['Texto enviado ao modelo em vez disso', 'Escreva o texto que o modelo recebe em vez disso']);
        expect(byTag(rows(panel)[0], 'select')[0].getAttribute('aria-label')).toBe('O que o modelo recebe desta imagem');
    });

    test('the older saved attachment text has its own explanation and two buttons, and leaving it out is confirmed', async () => {
        const panel = await open();
        const row = rows(panel)[3];
        expect(byTag(row, 'p')[0].textContent).toBe('This older message saved image descriptions and file text together, so Show only cannot separate them. Choose what the model receives instead: your reviewed text, or nothing. Leaving it out also leaves out the file text. The message as shown is not changed.');
        expect(byTag(row, 'button').map(node => node.textContent)).toEqual(['Use this text', 'Leave it out']);
        await buttonsNamed(row, 'Leave it out')[0].click();
        const { content } = env.confirmations[0];
        expect(byTag(content, 'h3')[0].textContent).toBe('Leave out the saved attachment text?');
        expect(byTag(content, 'p')[0].textContent).toBe('The file text saved with it is left out too. What was written in the message is not changed.');
        expect(env.branchData.messages[2].extra.neconyan_image_context).toMatchObject({ mode: 'omit' });
    });

    // D-4: a reply that only quotes has no saved attachment text, so it must not be described as if it had (CNV-28, CNV-29). A row with saved
    // attachment text keeps the older legend and explanation (CNV-18, CNV-19).
    const CNV_19 = 'This older message saved image descriptions and file text together, so Show only cannot separate them. Choose what the model receives instead: your reviewed text, or nothing. Leaving it out also leaves out the file text. The message as shown is not changed.';
    const CNV_29 = 'This reply contains a quote. If your image settings require a review and the quote cannot be checked against its original message, the model receives what you choose here instead of the quote: your reviewed text, or nothing. The message as shown is not changed.';
    const CNV_32 = 'If your image settings require a review and the quote cannot be checked against its original message, the model receives this reply without the quote. What was written in the message is not changed.';

    test('a row with only a quoted reply uses the quote legend and explanation, and a row with saved attachment text keeps the older ones', async () => {
        env.branchData.messages = [
            { id: 'q1', extra: { conversation_reply_to: { messageId: 'x', text: 'a quoted line' } } },
            { id: 'q2', extra: { conversation_reply_to: { messageId: 'y', attachmentSummary: 'one image' } } },
            { id: 'a1', extra: { conversation_attachment_context: 'Older description and file text' } },
            { id: 'a2', extra: { conversation_attachment_context: 'Older description and file text', conversation_reply_to: { text: 'quoted' } } },
        ];
        const panel = await open();
        const [quoteText, quoteSummary, attachmentOnly, attachmentAndQuote] = rows(panel);
        for (const row of [quoteText, quoteSummary]) {
            expect(byTag(row, 'p')[0].textContent).toBe(CNV_29);
            expect(byTag(row, 'p')[0].hasAttribute('data-i18n-ignore')).toBe(true);
            expect(byTag(row, 'p')[0].textContent).not.toMatch(/file text|saved attachment text|older message|image's description/);
        }
        expect(rows(panel).map(row => row.children[0].textContent)).toEqual([
            'Message 1, quote from another message', 'Message 2, quote from another message', 'Message 3, saved attachment text', 'Message 4, saved attachment text']);
        for (const row of rows(panel)) expect(row.children[0].hasAttribute('data-i18n-ignore')).toBe(true);
        for (const row of [attachmentOnly, attachmentAndQuote]) expect(byTag(row, 'p')[0].textContent).toBe(CNV_19);
        // The quote legend is the scoped CNV-28 key, the explanation is its own exact key, and the older pair is still looked up for the other rows.
        expect(env.lookups).toContainEqual(['Message ${0}, quote from another message', 'scoped.prompt_media.CNV-28']);
        expect(env.lookups).toContainEqual(['Message ${0}, saved attachment text', 'scoped.prompt_media.CNV-18']);
        expect(env.lookups).toContainEqual([CNV_29, null]);
        expect(env.lookups).toContainEqual([CNV_19, null]);
        // Every row still has its text box and its two buttons.
        for (const row of rows(panel)) expect(byTag(row, 'button').map(node => node.textContent)).toEqual(['Use this text', 'Leave it out']);
    });

    test('the quote legend and explanation follow the interface language, each through its own key', async () => {
        env.scoped['scoped.prompt_media.CNV-28'] = 'Mensagem ${0}, descrição citada';
        env.dictionary[CNV_29] = 'Esta resposta cita uma descrição.';
        env.branchData.messages = [{ id: 'q1', extra: { conversation_reply_to: { text: 'quoted' } } }];
        const panel = await open();
        const row = rows(panel)[0];
        expect(row.children[0].textContent).toBe('Mensagem 1, descrição citada');
        expect(byTag(row, 'p')[0].textContent).toBe('Esta resposta cita uma descrição.');
        // Neither lookup is mistaken for the other: without CNV-28 the legend stays English, and CNV-18 is not used for it.
        delete env.scoped['scoped.prompt_media.CNV-28'];
        env.shownPanels.length = 0;
        expect(rows(await open())[0].children[0].textContent).toBe('Message 1, quote from another message');
    });

    test('a quote-only row saves the same choices as before: its own text, or nothing', async () => {
        env.branchData.messages = [{ id: 'q1', extra: { conversation_reply_to: { text: 'quoted' } } }];
        const panel = await open();
        const row = rows(panel)[0];
        byTag(row, 'textarea')[0].value = 'Reviewed text';
        await buttonsNamed(row, 'Use this text')[0].click();
        expect(env.branchData.messages[0].extra.neconyan_image_context).toMatchObject({ mode: 'replace', text: 'Reviewed text' });
        await buttonsNamed(row, 'Leave it out')[0].click();
        expect(env.branchData.messages[0].extra.neconyan_image_context).toMatchObject({ mode: 'omit' });
    });

    // The wording of 16 October: a quote-only row has its own legend, explanation, error and confirmation (CNV-28 to CNV-32).
    test('a quote-only row shows the CNV-28 legend and the CNV-29 explanation, and none of the attachment-text wording', async () => {
        env.branchData.messages = [{ id: 'q1', extra: { conversation_reply_to: { messageId: 'x', text: 'a quoted line' } } }];
        const row = rows(await open())[0];
        expect(row.children[0].textContent).toBe('Message 1, quote from another message');
        expect(byTag(row, 'p')[0].textContent).toBe(CNV_29);
        expect(env.lookups).toContainEqual(['Message ${0}, quote from another message', 'scoped.prompt_media.CNV-28']);
        expect(env.lookups).not.toContainEqual(['Message ${0}, saved attachment text', 'scoped.prompt_media.CNV-18']);
    });

    test('a quote-only row that changed under the dialog gives the CNV-30 error: the existing message-changed sentence', async () => {
        env.branchData.messages = [{ id: 'q1', extra: { conversation_reply_to: { messageId: 'x', text: 'a quoted line' } } }];
        const row = rows(await open())[0];
        byTag(row, 'textarea')[0].value = 'Reviewed text';
        env.branchData.messages[0].extra = { conversation_reply_to: { messageId: 'x', text: 'a different line' } };
        env.toasts.length = 0;
        await buttonsNamed(row, 'Use this text')[0].click();
        expect(env.toasts).toEqual([['error', 'This message changed. Close this window and open it again.']]);
        // Nothing was saved, and the sentence is the existing key, not a new one.
        expect(env.branchData.messages[0].extra.neconyan_image_context).toBeUndefined();
        expect(env.lookups).toContainEqual(['This message changed. Close this window and open it again.', null]);
        expect(env.lookups).not.toContainEqual(['This saved attachment text changed. Close this window and open it again.', null]);
    });

    test('leaving out a quote asks CNV-31 with the CNV-32 body, and only a yes saves it', async () => {
        env.branchData.messages = [{ id: 'q1', extra: { conversation_reply_to: { messageId: 'x', text: 'a quoted line' } } }];
        const row = rows(await open())[0];
        env.confirmResult = 0;
        await buttonsNamed(row, 'Leave it out')[0].click();
        expect(env.confirmations).toHaveLength(1);
        const { content } = env.confirmations[0];
        expect(byTag(content, 'h3')[0].textContent).toBe('Leave out the quote?');
        expect(byTag(content, 'p')[0].textContent).toBe(CNV_32);
        expect(content.hasAttribute('data-i18n-ignore')).toBe(true);
        expect(env.lookups).toContainEqual(['Leave out the quote?', null]);
        expect(env.lookups).toContainEqual([CNV_32, null]);
        // The attachment-text confirmation is not shown for this row.
        expect(env.lookups).not.toContainEqual(['Leave out the saved attachment text?', null]);
        expect(env.lookups).not.toContainEqual(['The file text saved with it is left out too. What was written in the message is not changed.', null]);
        // Declined: nothing saved.
        expect(env.branchData.messages[0].extra.neconyan_image_context).toBeUndefined();
        env.confirmResult = 1;
        await buttonsNamed(row, 'Leave it out')[0].click();
        expect(env.confirmations).toHaveLength(2);
        expect(env.branchData.messages[0].extra.neconyan_image_context).toMatchObject({ mode: 'omit' });
    });

    test('a row with saved attachment text, with or without a quote, keeps CNV-18, CNV-19, CNV-22, CNV-26 and CNV-27', async () => {
        env.branchData.messages = [
            { id: 'a1', extra: { conversation_attachment_context: 'Older description and file text' } },
            { id: 'a2', extra: { conversation_attachment_context: 'Older description and file text', conversation_reply_to: { messageId: 'x', text: 'quoted' } } },
        ];
        const panel = await open();
        for (const [index, row] of rows(panel).entries()) {
            expect(row.children[0].textContent).toBe(`Message ${index + 1}, saved attachment text`);
            expect(byTag(row, 'p')[0].textContent).toBe(CNV_19);
            // Its confirmation is the attachment-text one (CNV-26, CNV-27), not the quote one.
            env.confirmations.length = 0;
            await buttonsNamed(row, 'Leave it out')[0].click();
            const { content } = env.confirmations[0];
            expect(byTag(content, 'h3')[0].textContent).toBe('Leave out the saved attachment text?');
            expect(byTag(content, 'p')[0].textContent).toBe('The file text saved with it is left out too. What was written in the message is not changed.');
            expect(env.branchData.messages[index].extra.neconyan_image_context).toMatchObject({ mode: 'omit' });
        }
        // Its error when the saved text changed is CNV-22, not the message-changed sentence.
        const row = rows(panel)[0];
        byTag(row, 'textarea')[0].value = 'ok';
        env.branchData.messages[0].extra = { conversation_attachment_context: 'Something else' };
        env.toasts.length = 0;
        await buttonsNamed(row, 'Use this text')[0].click();
        expect(env.toasts).toEqual([['error', 'This saved attachment text changed. Close this window and open it again.']]);
        expect(env.lookups).not.toContainEqual(['Leave out the quote?', null]);
        expect(env.lookups).not.toContainEqual([CNV_32, null]);
    });

    test('nothing in the dialog is reachable by the run-time localiser', async () => {
        const panel = await open();
        const reachable = textPieces(panel).filter(piece => !shielded(piece.entry)).map(piece => piece.text);
        expect(reachable).toEqual([]);
        // Descriptions and titles are values in a textarea, never text the localiser reads.
        expect(elements(panel, node => node.getAttribute('translate') === 'no')).toEqual([]);
    });

    test('a saved choice shows its toast as final text; a refused save shows the reason the same way', async () => {
        const panel = await open();
        const row = rows(panel)[0];
        await buttonsNamed(row, 'Save choice')[0].click();
        expect(env.toasts).toContainEqual(['success', 'Choice saved.']);
        expect(env.marks).toContainEqual(expect.objectContaining({ kind: 'success', message: 'Choice saved.', selector: '.toast-message, .toast-title', name: 'data-i18n-ignore' }));
        expect(env.lookups).toContainEqual(['Choice saved.', 'scoped.prompt_media.CNV-12']);
        env.toasts.length = 0; env.marks.length = 0;
        env.flushConversationStore.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await buttonsNamed(row, 'Save choice')[0].click();
        expect(env.toasts).toEqual([['error', 'Your choice was not saved. Try again.']]);
        expect(env.marks).toHaveLength(1);
        env.toasts.length = 0;
        env.flushConversationStore.mockResolvedValueOnce(false);
        await buttonsNamed(row, 'Save choice')[0].click();
        expect(env.toasts).toEqual([['error', 'Earlier Conversation changes could not be saved, so this choice was not saved. Try again.']]);
    });

    test('the errors a person can reach are the ledger\'s sentences', async () => {
        const panel = await open();
        const row = rows(panel)[0];
        const [choice, area] = [byTag(row, 'select')[0], byTag(row, 'textarea')[0]];
        const clickAndRead = async button => { env.toasts.length = 0; await button.click(); return env.toasts.map(([, message]) => message); };
        // A description over 16 KiB, or none, with Use a description chosen.
        choice.value = 'caption'; area.value = 'x'.repeat(16385);
        expect(await clickAndRead(buttonsNamed(row, 'Save choice')[0])).toEqual(['Type a description of up to 16 KiB.']);
        // The message changing under the dialog.
        choice.value = 'include';
        env.branchData.messages[0].extra = { media: [{ type: 'image', url: '/user/images/changed.png' }] };
        expect(await clickAndRead(buttonsNamed(row, 'Save choice')[0])).toEqual(['This message changed. Close this window and open it again.']);
        // The replacement text over 16 KiB.
        const context = rows(panel)[3];
        byTag(context, 'textarea')[0].value = 'y'.repeat(16385);
        expect(await clickAndRead(buttonsNamed(context, 'Use this text')[0])).toEqual(['Keep the replacement text to at most 16 KiB.']);
        // Exactly 16 KiB is accepted: the sentence says at most.
        byTag(context, 'textarea')[0].value = 'z'.repeat(16384);
        expect(await clickAndRead(buttonsNamed(context, 'Use this text')[0])).toEqual(['Choice saved.']);
        // The saved text changing, and the account changing.
        byTag(context, 'textarea')[0].value = 'ok';
        env.branchData.messages[2].extra = { conversation_attachment_context: 'Something else' };
        expect(await clickAndRead(buttonsNamed(context, 'Use this text')[0])).toEqual(['This saved attachment text changed. Close this window and open it again.']);
        env.handle = 'bob';
        expect(await clickAndRead(buttonsNamed(row, 'Save choice')[0])).toEqual(['You switched accounts. Close this window and open it again.']);
        env.handle = 'alice';
        // The Conversation changing, and a second save while one is running.
        env.branch = { ...env.branchData, id: 'other' };
        expect(await clickAndRead(buttonsNamed(row, 'Save choice')[0])).toEqual(['This Conversation changed. Close this window and open it again.']);
    });

    test('with no Conversation open the dialog says so, and clicking the notice shows that sentence as a final toast', async () => {
        env.branch = null;
        await expect(env.ui.showPromptMediaReview()).rejects.toThrow('Open a Conversation chat to review its images.');
        expect(env.ui.showImageChoiceNotice({ message: 'A reason.' })).toBe(true);
        env.toastr.warning.mock.calls.at(-1)[2].onclick();
        await settle();
        expect(env.toasts).toContainEqual(['error', 'Open a Conversation chat to review its images.']);
        expect(env.marks).toContainEqual(expect.objectContaining({ kind: 'error', name: 'data-i18n-ignore' }));
    });
});
