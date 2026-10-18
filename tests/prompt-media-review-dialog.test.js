/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "unreached"] }] -- unreached() holds the assertions of the structural checks. */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { localizeString } from '../public/scripts/ui-localization.js';
import { assembled, loadDialog, scanIssue, scanResult } from './prompt-media-dialog-harness.js';
import { buttonsNamed, byTag, elements, marked, settle, shielded, textPieces } from './prompt-media-dom-stub.js';

// The Roleplay image review dialog (E2 rows RVW, CPY, BAT, HIS and INT-01). The real prompt-media-ui.js and prompt-media-labels.js run against
// stand-ins for the app and the browser, with the lookup stand-ins reading the same tables the page's translate() reads. The in-app check
// happens in stage 4. The Conversation dialog is in prompt-media-conversation-dialog.test.js, and the status and stage maps are in
// prompt-media-label-maps.test.js.

// What the real pt-pt files show for a string once translated, read straight from the assembled files and never through the lookup under test:
// a scoped key reads the scoped table, an exact text reads the dictionary, and the English stays only when neither holds an entry.
const realPt = assembled('pt-pt');
const shown = (english, key = null) => (key ? realPt.scoped[key] : realPt.dictionary[english]) ?? english;
const filled = (text, ...values) => text.replace(/\$\{(\d+)\}/g, (_, index) => values[index]);

let env;
beforeAll(async () => { env = await loadDialog(jest); });
beforeEach(() => env.reset());

const target = { group: false, chat: 'Review', avatar: 'Group.png' };
const rowsOf = content => byTag(content, 'fieldset');
const listOf = content => elements(content, node => node.getAttribute('role') === 'list')[0];
const itemsOf = list => elements(list, node => node.getAttribute('role') === 'listitem');
const rowsOfList = content => itemsOf(listOf(content));
const choiceSelect = row => byTag(row, 'select')[0];
const sourceSelect = row => byTag(row, 'select')[1];
const optionsOf = select => byTag(select, 'option').map(option => ({ value: option.value, label: option.textContent }));
const unreached = (root, label) => {
    // The run-time localiser skips an element marked final, or marked translate="no", and everything inside it. Any other text is reachable.
    const reachable = textPieces(root).filter(piece => !shielded(piece.entry)).map(piece => piece.text);
    expect({ view: label, reachable }).toEqual({ view: label, reachable: [] });
};

describe('authored values', () => {
    test('a chat named Review, a character named Group and a description reading Show only each sit in their own translate="no" element, in every view', async () => {
        env.use('pt-pt');
        // The real pt-pt dictionary translates these words, so a value that leaked into a phrase would show as 'Revisar' or 'Grupo'.
        expect(env.dictionary.Review).toBe('Revisar');
        expect(env.dictionary.Group).toBe('Grupo');
        env.routes.scan = () => scanResult([scanIssue({ title: 'Show only' })], target);
        env.routes.chats = () => ({ chats: [target, { group: true, chat: 'Main' }], next: null });
        env.routes.history = () => ({ operations: [
            { id: 'a', locator: { group: false, chat: 'Review', avatar: 'Group.png' }, createdAt: '2026-03-04T10:20:30.000Z', phase: 'prepared', stage: 'committed', backupAvailable: true },
            { id: 'b', locator: null, createdAt: null, phase: 'staging', stage: 'staging-incomplete', backupAvailable: false },
        ], next: null });
        const { panel, content, navigation } = await env.open(target);

        const noTranslation = node => node.getAttribute('translate') === 'no';
        expect(elements(content, noTranslation).map(node => node.textContent)).toEqual(['Review', 'Show only']);
        expect(byTag(content, 'h4')[0].textContent).toBe('Review');
        expect(noTranslation(byTag(content, 'h4')[0])).toBe(true);
        unreached(panel, 'chat');

        await byTag(navigation, 'button')[1].click(); await settle();
        const library = panel.children.at(-1);
        expect(elements(library, noTranslation).map(node => node.textContent)).toEqual(['Group', 'Review', 'Main']);
        // The word 'Group chat' is ours, and it is translated; the character's name and the chat's name are not.
        expect(elements(library, node => node.tag === 'label').map(node => node.textContent)).toEqual(['Group: Review', 'Chat em grupo: Main']);
        unreached(panel, 'choose chats');

        await byTag(navigation, 'button')[2].click(); await settle();
        const history = panel.children.at(-1);
        expect(elements(history, noTranslation).map(node => node.textContent)).toEqual(['Review', expect.any(String)]);
        // The unfinished change has no chat yet: that legend is a word of ours, and it is not marked translate="no".
        const legends = byTag(history, 'legend');
        expect(legends.map(node => node.textContent)).toEqual(['Review', shown('Unfinished change', 'scoped.prompt_media.HIS-01')]);
        expect(noTranslation(legends[0])).toBe(true);
        expect(noTranslation(legends[1])).toBe(false);
        unreached(panel, 'change history');
    });

    test('nothing the dialog says is reachable by the run-time localiser, with a status shown, in either language', async () => {
        for (const language of [null, 'pt-pt']) {
            env.reset(); env.use(language);
            env.routes.scan = () => scanResult([scanIssue({ title: 'A note', status: 'embedded-image', hasPromptCopy: true, proposedSource: 'http://localhost/user/images/a.png' }),
                scanIssue({ index: 1, mediaIndex: -1, status: 'empty-attachment-list', actions: ['detach'] }), scanIssue({ index: 2, status: 'other-media', actions: [] })], target);
            const { panel } = await env.open(target);
            unreached(panel, `${language ?? 'en'} dialog`);
            for (const { content } of env.confirmations) unreached(content, 'confirmation');
        }
    });
});

describe('row legends (RVW-35)', () => {
    test('four complete phrases, looked up by their scoped keys, and the old fragments are never built', async () => {
        env.routes.scan = () => scanResult([
            scanIssue({ index: 0, swipe: null, mediaIndex: 0 }), scanIssue({ index: 1, swipe: 1, mediaIndex: 2 }),
            scanIssue({ index: 2, swipe: null, mediaIndex: -1, status: 'empty-attachment-list', actions: ['detach'] }),
            scanIssue({ index: 3, swipe: 0, mediaIndex: -1, status: 'malformed-attachment', actions: ['detach'] }),
        ], target);
        const { content } = await env.open(target);
        expect(byTag(content, 'legend').map(node => node.textContent)).toEqual([
            'Message 1, image 1', 'Message 2, alternative 2, image 3', 'Message 3, attachment list', 'Message 4, alternative 1, attachment list']);
        const keys = env.lookups.filter(([, key]) => key?.startsWith('scoped.prompt_media.RVW-35')).map(([text, key]) => `${key} = ${text}`);
        expect(keys).toEqual([
            'scoped.prompt_media.RVW-35.1 = Message ${0}, image ${1}', 'scoped.prompt_media.RVW-35.2 = Message ${0}, alternative ${1}, image ${2}',
            'scoped.prompt_media.RVW-35.3 = Message ${0}, attachment list', 'scoped.prompt_media.RVW-35.4 = Message ${0}, alternative ${1}, attachment list']);
        // No lookup of the fragment key the builder used to collect.
        expect(env.lookups.some(([text, key]) => [text, key].some(value => value?.includes('${0}${1}${2}')))).toBe(false);
        // A translation reaches the legend through the scoped table only, and the holes are filled afterwards.
        env.scoped['scoped.prompt_media.RVW-35.1'] = 'Mensagem ${0}, imagem ${1}';
        env.routes.scan = () => scanResult([scanIssue({ index: 2, swipe: null, mediaIndex: 0 })], target);
        env.shownPanels.length = 0;
        const again = await env.open(target);
        expect(byTag(again.content, 'legend')[0].textContent).toBe('Mensagem 3, imagem 1');
        expect(marked({ node: byTag(again.content, 'legend')[0], path: [] }, 'data-i18n-ignore')).toBe(true);
    });
});

describe('textareas (C-4)', () => {
    test('the placeholder and the accessible name are built with t``, so a translation reaches both', async () => {
        env.dictionary['Type the description the model receives'] = 'Escreva a descrição que o modelo recebe';
        env.dictionary['What the model receives from this image'] = 'O que o modelo recebe desta imagem';
        env.dictionary['Where the description comes from'] = 'De onde vem a descrição';
        env.routes.scan = () => scanResult([scanIssue()], target);
        const { content } = await env.open(target);
        const [row] = rowsOf(content);
        const area = byTag(row, 'textarea')[0];
        expect(area.getAttribute('placeholder')).toBe('Escreva a descrição que o modelo recebe');
        expect(area.getAttribute('aria-label')).toBe('Escreva a descrição que o modelo recebe');
        expect(choiceSelect(row).getAttribute('aria-label')).toBe('O que o modelo recebe desta imagem');
        expect(sourceSelect(row).getAttribute('aria-label')).toBe('De onde vem a descrição');
        // In English both are the ledger's sentence.
        env.dictionary = {}; env.shownPanels.length = 0;
        const english = await env.open(target);
        expect(byTag(rowsOf(english.content)[0], 'textarea')[0].getAttribute('placeholder')).toBe('Type the description the model receives');
    });
});

describe('description sources (D20)', () => {
    const open = async issues => { env.routes.scan = () => scanResult(issues, target); env.shownPanels.length = 0; return rowsOf((await env.open(target)).content); };

    test('condition 1 and 2: a saved source is offered only when it has text, and typing is always offered', async () => {
        const rows = await open([
            scanIssue({ identity: 'a', sources: { 'media-title': true, 'message-title': true } }),
            scanIssue({ identity: 'b', index: 1, sources: { 'media-title': true, 'message-title': false } }),
            scanIssue({ identity: 'c', index: 2, sources: { 'media-title': false, 'message-title': true } }),
            scanIssue({ identity: 'd', index: 3, sources: { 'media-title': false, 'message-title': false } }),
            scanIssue({ identity: 'e', index: 4, sources: undefined }),
        ]);
        const offered = rows.map(row => optionsOf(sourceSelect(row)));
        expect(offered.map(list => list.map(option => option.value))).toEqual([
            ['custom', 'media-title', 'message-title'], ['custom', 'media-title'], ['custom', 'message-title'], ['custom'], ['custom']]);
        expect(offered[0].map(option => option.label)).toEqual(['Type a description', 'The image\'s saved description', 'The message\'s saved title']);
        // A saved description that is not there is never offered as a way to describe the image; a typed one is the way out.
        for (const list of offered) expect(list[0]).toEqual({ value: 'custom', label: 'Type a description' });
    });

    test('condition 3: a saved source that has no text now stays selected under its no-longer-available label, is explained, and nothing is saved', async () => {
        const rows = await open([
            scanIssue({ identity: 'a', mode: 'caption', caption: { source: 'media-title' }, sources: { 'media-title': false, 'message-title': true } }),
            scanIssue({ identity: 'b', index: 1, mode: 'caption', caption: { source: 'message-title' }, sources: { 'media-title': true, 'message-title': false } }),
            scanIssue({ identity: 'c', index: 2, mode: 'caption', caption: { source: 'media-title' }, sources: { 'media-title': true, 'message-title': false } }),
            scanIssue({ identity: 'd', index: 3, mode: 'caption', caption: { source: 'custom', text: 'Typed once' }, sources: { 'media-title': false, 'message-title': false } }),
        ]);
        const gone = 'The saved description source for this image is empty or longer than 16 KiB, so it cannot be used. To use a description, choose another source or type one, then save.';
        const noteOf = row => byTag(row, 'p').find(node => node.textContent === gone);
        // Row a: the saved image description has no text. It stays selected under RVW-58, the message title is offered as it has text, the note shows.
        expect(optionsOf(sourceSelect(rows[0]))).toEqual([{ value: 'custom', label: 'Type a description' },
            { value: 'media-title', label: 'The image\'s saved description (no longer available)' }, { value: 'message-title', label: 'The message\'s saved title' }]);
        expect(sourceSelect(rows[0]).value).toBe('media-title');
        expect(noteOf(rows[0]).hidden).toBe(false);
        // Row b: the same for the message title, under RVW-59.
        expect(optionsOf(sourceSelect(rows[1])).at(-1)).toEqual({ value: 'message-title', label: 'The message\'s saved title (no longer available)' });
        expect(sourceSelect(rows[1]).value).toBe('message-title');
        expect(noteOf(rows[1]).hidden).toBe(false);
        // Row c: the saved source still has text, so there is no label change and no note.
        expect(sourceSelect(rows[2]).value).toBe('media-title');
        expect(optionsOf(sourceSelect(rows[2])).map(option => option.label)).toContain('The image\'s saved description');
        expect(noteOf(rows[2]).hidden).toBe(true);
        // Row d: typed text is untouched and no note appears.
        expect(sourceSelect(rows[3]).value).toBe('custom');
        expect(byTag(rows[3], 'textarea')[0].value).toBe('Typed once');
        expect(noteOf(rows[3]).hidden).toBe(true);
        // Opening the dialog changed nothing: every choice reads as it was saved, and the only request was the listing.
        expect(rows.map(row => choiceSelect(row).value)).toEqual(['caption', 'caption', 'caption', 'caption']);
        expect(env.requests.map(request => request.action)).toEqual(['scan']);
        // The note goes away once the person picks another source, and the unavailable source is still what is saved until they save.
        sourceSelect(rows[0]).value = 'message-title';
        for (const listener of sourceSelect(rows[0]).listeners.change) listener();
        expect(noteOf(rows[0]).hidden).toBe(true);
        expect(env.requests.map(request => request.action)).toEqual(['scan']);
    });

    test('saving sends the source as it is selected, and only then', async () => {
        const rows = await open([scanIssue({ mode: 'caption', caption: { source: 'media-title' }, sources: { 'media-title': false, 'message-title': false } })]);
        env.routes.apply = () => ({});
        await buttonsNamed(rows[0], 'Save choice')[0].click(); await settle();
        const sent = env.requests.find(request => request.action === 'apply');
        expect(sent.body.actions[0]).toMatchObject({ mode: 'caption', caption: { source: 'media-title' } });
    });

    test('the descriptions are hidden unless the choice is Use a description, and the typed text is shown only then', async () => {
        const rows = await open([scanIssue(), scanIssue({ index: 1, mode: 'caption', caption: { source: 'custom', text: 'x' } })]);
        expect([sourceSelect(rows[0]).hidden, byTag(rows[0], 'textarea')[0].hidden]).toEqual([true, true]);
        expect([sourceSelect(rows[1]).hidden, byTag(rows[1], 'textarea')[0].hidden]).toEqual([false, false]);
    });
});

describe('failures shown in the status line', () => {
    test('D12: an integrity failure shows the explanation, then the server\'s English detail in an element of its own, with markup shown as written', async () => {
        const detail = 'Backup <b>hash</b> mismatch for "Review" & its copy.';
        env.dictionary['Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.'] = 'Traduzido.';
        env.dictionary[detail] = 'must never be used';
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.routes.apply = () => ({ failure: { status: 500, body: { error: detail, integrity: true } } });
        const { content, status } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.hasAttribute('data-i18n-ignore')).toBe(true);
        expect(status.children[0].textContent).toBe('Traduzido.');
        expect(status.children[1].tag).toBe('br');
        expect(status.children[2].getAttribute('translate')).toBe('no');
        expect(status.children[2].textContent).toBe(detail);
        expect(status.children).toHaveLength(3);
        // The detail is English as written: it is not looked up at all.
        expect(env.lookups.some(([text]) => text === detail)).toBe(false);
        unreached(status, 'integrity status');
        // In English the explanation is INT-01 as approved.
        env.dictionary = {}; env.shownPanels.length = 0;
        const english = await env.open(target);
        await buttonsNamed(rowsOf(english.content)[0], 'Save choice')[0].click(); await settle();
        expect(english.status.children[0].textContent).toBe('Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.');
    });

    test('an ordinary failure shows the server\'s reason through the exact lookup, and nothing is marked as a detail', async () => {
        env.dictionary['The chat changed while you were reviewing it. List its images again, then choose.'] = 'O chat mudou.';
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.routes.apply = () => ({ failure: { status: 409, body: { error: 'The chat changed while you were reviewing it. List its images again, then choose.' } } });
        const { content, status } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.textContent).toBe('O chat mudou.');
        expect(elements(status, node => node.getAttribute('translate') === 'no')).toEqual([]);
        // A reply with no reason gets the general sentence.
        env.routes.apply = () => ({ failure: { status: 500, body: {} } });
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.textContent).toBe('That did not finish. Try again.');
    });

    test('server text goes through the exact lookup only and is shown final: with the real pt-pt dictionary an untranslated message is unchanged', async () => {
        env.use('pt-pt');
        const message = 'Select the image again.';
        // The control: left to the run-time localiser, the pattern 'Select ${0}' would translate half of it.
        expect(localizeString(message, env.dictionary)).toContain('Selecionar');
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.routes.apply = () => ({ failure: { status: 409, body: { error: message } } });
        const { content, status } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], shown('Save choice', 'scoped.prompt_media.RVW-46'))[0].click(); await settle();
        expect(status.textContent).toBe(message);
        expect(status.hasAttribute('data-i18n-ignore')).toBe(true);
        // The lookup was the exact one: the message itself, with no key and no template.
        expect(env.lookups).toContainEqual([message, null]);
        // A message that has an exact entry is translated.
        const [exact, translated] = Object.entries(env.dictionary).find(([key, value]) => key !== value && !key.includes('${') && key.length > 24 && key.length < 70 && /^[A-Z][^.]*\.$/.test(key));
        env.routes.apply = () => ({ failure: { status: 409, body: { error: exact } } });
        await buttonsNamed(rowsOf(content)[0], shown('Save choice', 'scoped.prompt_media.RVW-46'))[0].click(); await settle();
        expect(status.textContent).toBe(translated);
    });

    test('a browser error is shown as it is, final, and the status is cleared by a later message', async () => {
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.routes.apply = () => { throw new TypeError('Failed to fetch'); };
        const { content, status } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.textContent).toBe('Failed to fetch');
        expect(status.children).toHaveLength(0);
    });

    test('the account changing is reported in the sentence of RVW-21', async () => {
        env.routes.scan = () => scanResult([scanIssue()], target);
        const { content, status } = await env.open(target);
        env.handle = 'bob';
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.textContent).toBe('You switched accounts. Close this window and open it again.');
    });
});

describe('the list of attachments', () => {
    test('each scan status shows its label and never its code, with the image\'s own description after a label', async () => {
        const statuses = ['saved-reference', 'missing-file', 'needs-compatible-copy', 'unreadable-or-over-limit', 'embedded-image', 'external-or-old-location',
            'invalid-gallery-selection', 'malformed-attachment', 'empty-attachment-list', 'other-media'];
        env.routes.scan = () => scanResult(statuses.map((status, index) => scanIssue({
            index, status, identity: `id-${index}`, title: index === 0 ? 'A saved description' : '',
            ...(status === 'empty-attachment-list' || status === 'malformed-attachment' ? { mediaIndex: -1, actions: ['detach'] } : {}), ...(status === 'other-media' ? { actions: [] } : {}) })), target);
        const { content } = await env.open(target);
        const lines = rowsOf(content).map(row => row.children[1].textContent);
        expect(lines).toEqual([
            'Saved on this serverSaved description: A saved description', 'Missing: its file is no longer on the server',
            'Needs a compatible copy: unsupported format, or larger than 2048 pixels', 'Needs a compatible copy: larger than 1 MiB, or unreadable', 'Stored inside the chat file',
            'Linked from a website or an old location', 'The gallery\'s chosen image is missing', 'Damaged attachment', 'Empty attachment list', 'Audio or video']);
        for (const line of lines) expect(line).not.toMatch(/saved-reference|missing-file|-image|-location|-selection|-attachment|-media|-limit/);
        // The description sits in its own element, after the label.
        const state = rowsOf(content)[0].children[1];
        expect(state.children.map(child => typeof child === 'string' ? child : child.textContent)).toEqual(['Saved on this server', '', 'Saved description', ': ', 'A saved description']);
        expect(state.children.at(-1).getAttribute('translate')).toBe('no');
        // Audio and video get the sentence of RVW-37 and no controls.
        expect(byTag(rowsOf(content).at(-1), 'p').at(-1).textContent).toBe('Audio and video are not changed here.');
        expect(byTag(rowsOf(content).at(-1), 'select')).toHaveLength(0);
    });

    // D-2: the count and the sentence after it are two final elements on two lines, not one run of words joined by a space.
    const countLine = content => {
        const line = byTag(content, 'p')[0];
        expect(line.hasAttribute('data-i18n-ignore')).toBe(true);
        expect(line.children.map(child => typeof child === 'string' ? 'text' : child.tag)).toEqual(['span', 'br', 'span']);
        for (const part of line.children.filter(child => child.tag === 'span')) expect(part.hasAttribute('data-i18n-ignore')).toBe(true);
        return line.children.filter(child => child.tag === 'span').map(part => part.textContent);
    };

    test('the heading, the count line and the intro sentences are looked up, and the count and the limit are separate final elements on separate lines', async () => {
        env.routes.scan = () => scanResult([scanIssue()], target, { total: 12000, limited: true });
        const { panel, content } = await env.open(target);
        expect(panel.children[0].textContent).toBe('Chat images');
        expect(countLine(content)).toEqual(['Attachments found: 12000', 'Only the first 10,000 are listed.']);
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.shownPanels.length = 0;
        const second = await env.open(target);
        expect(countLine(second.content)).toEqual(['Attachments found: 1', 'Listing does not download anything from websites.']);
        expect(env.lookups).toContainEqual(['Attachments found: ${0}', 'scoped.prompt_media.RVW-31']);
    });

    test('the count and its sentence stay apart in pt-pt too, and a translation of either reaches only its own element', async () => {
        env.dictionary['Listing does not download anything from websites.'] = 'A lista não descarrega nada de sites.';
        env.scoped['scoped.prompt_media.RVW-31'] = 'Anexos encontrados: ${0}';
        env.routes.scan = () => scanResult([scanIssue(), scanIssue({ index: 1, identity: 'id-1' })], target);
        const { content } = await env.open(target);
        expect(countLine(content)).toEqual(['Anexos encontrados: 2', 'A lista não descarrega nada de sites.']);
        unreached(content, 'count line');
    });

    test('Saved. Change history ... stays on screen after a change, because the list is rebuilt before it is written', async () => {
        env.routes.scan = () => scanResult([scanIssue()], target);
        env.routes.apply = () => ({});
        const { content, status } = await env.open(target);
        expect(status.textContent).toBe('Images listed.');
        await buttonsNamed(rowsOf(content)[0], 'Save choice')[0].click(); await settle();
        expect(status.textContent).toBe('Saved. Change history keeps a backup of the chat from before this change: you can download it, or undo the change while the chat stays unchanged.');
        expect(env.events.map(event => event.type)).toContain('neconyan:image-input-settings-changed');
    });
});

describe('removing an image, and using the compatible copy', () => {
    test('removal is confirmed with the vocabulary of D4, in final text', async () => {
        env.routes.scan = () => scanResult([scanIssue({ mode: 'detach' })], target);
        const { content } = await env.open(target);
        const row = rowsOf(content)[0];
        expect(optionsOf(choiceSelect(row)).map(option => option.label)).toEqual(['Show only', 'Use a description', 'Send the image', 'Remove from message']);
        choiceSelect(row).value = 'detach';
        env.routes.apply = () => ({});
        await buttonsNamed(row, 'Save choice')[0].click(); await settle();
        const { content: dialog } = env.confirmations[0];
        expect(byTag(dialog, 'h3')[0].textContent).toBe('Remove this image from the message?');
        expect(byTag(dialog, 'p')[0].textContent).toBe('Its file stays on the server. You can undo this in Change history while the chat stays unchanged.');
        expect(dialog.hasAttribute('data-i18n-ignore')).toBe(true);
        expect(env.confirmations[0].header).toBeNull();
    });

    test('every option of the choice and source selects is final after its lookup, the removal name included, so the localiser cannot capture a word of it', async () => {
        env.use('pt-pt');
        env.routes.scan = () => scanResult([scanIssue({ sources: { 'media-title': true, 'message-title': true } })], target);
        const { content } = await env.open(target);
        const options = byTag(rowsOf(content)[0], 'option');
        expect(options.map(option => option.textContent)).toEqual([shown('Show only', 'scoped.prompt_media.QIG-02'), shown('Use a description', 'scoped.prompt_media.QIG-04'), shown('Send the image', 'scoped.prompt_media.QIG-03'), shown('Remove from message', 'scoped.prompt_media.RVW-47'), shown('Type a description', 'scoped.prompt_media.RVW-40'), shown('The image\'s saved description'), shown('The message\'s saved title')]);
        for (const option of options) expect(option.hasAttribute('data-i18n-ignore')).toBe(true);
        // The removal name is looked up by its scoped key like the other three.
        expect(env.lookups).toContainEqual(['Remove from message', 'scoped.prompt_media.RVW-47']);
    });

    test('the matching local image: the path sits in an element of its own between the two halves of the sentence', async () => {
        const path = '/user/images/a&b\'s <image>.png';
        env.routes.scan = () => scanResult([scanIssue({ proposedSource: `http://localhost${encodeURI(path)}`, status: 'external-or-old-location' })], target);
        const { content } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Use the copy already on this server')[0].click(); await settle();
        const [{ content: dialog }] = env.confirmations;
        expect(byTag(dialog, 'h3')[0].textContent).toBe('Use the image already on this server?');
        const body = byTag(dialog, 'p')[0];
        expect(body.children[0]).toBe('The message will point to ');
        expect(body.children[2]).toBe(' instead of its full web address. The server first checks that this file exists in your account and is compatible.');
        expect(body.children[1].tag).toBe('code');
        expect(body.children[1].getAttribute('translate')).toBe('no');
        expect(body.children[1].textContent).toBe(encodeURI(path));
        expect(env.lookups).toContainEqual(['The message will point to ${0} instead of its full web address. The server first checks that this file exists in your account and is compatible.', 'scoped.prompt_media.CPY-15']);
    });

    test('showing the compatible copy and removing several images are confirmed with the ledger\'s sentences', async () => {
        env.routes.scan = () => scanResult([scanIssue({ hasPromptCopy: true })], target);
        env.routes.apply = () => ({});
        const { content } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Show the compatible copy in the chat')[0].click(); await settle();
        expect(byTag(env.confirmations[0].content, 'h3')[0].textContent).toBe('Show the compatible copy instead of the original?');
        expect(env.confirmations[0].content.children[1].textContent).toBe('The copy replaces the image shown in the chat. Your choices for what the model receives still apply. The original file stays on the server. You can undo this in Change history while the chat stays unchanged.');
        // Select this image, choose Remove from message, and save the selected images.
        const row = rowsOf(content)[0];
        const box = byTag(row, 'input')[0];
        box.checked = true; await box.listeners.change[0](); choiceSelect(row).value = 'detach';
        env.confirmations.length = 0;
        await buttonsNamed(content, 'Save choices for selected images')[0].click(); await settle();
        expect(byTag(env.confirmations[0].content, 'h3')[0].textContent).toBe('Remove the selected images from their messages?');
        expect(env.confirmations[0].content.children[1].textContent).toBe('Their files stay on the server.');
    });

    test('selecting nothing, or the wrong images, is reported in the ledger\'s sentences', async () => {
        env.routes.scan = () => scanResult([scanIssue({ status: 'saved-reference' })], target);
        const { content, status } = await env.open(target);
        await buttonsNamed(content, 'Save choices for selected images')[0].click(); await settle();
        expect(status.textContent).toBe('Select at least one image.');
        await buttonsNamed(content, 'Save copies of selected images stored in the chat')[0].click(); await settle();
        expect(status.textContent).toBe('Select at least one image stored in the chat.');
        const box = byTag(rowsOf(content)[0], 'input')[0];
        box.checked = true; await box.listeners.change[0]();
        await buttonsNamed(content, 'Save copies of selected images stored in the chat')[0].click(); await settle();
        expect(status.textContent).toBe('Select only images stored in the chat. Other images need a converted copy, prepared one at a time.');
    });

    test('Remove from message is not a copy: the preview explains what to do first', async () => {
        env.routes.scan = () => scanResult([scanIssue({ mode: 'detach' })], target);
        const { content, status } = await env.open(target);
        await buttonsNamed(rowsOf(content)[0], 'Prepare a converted copy')[0].click(); await settle();
        expect(status.textContent).toBe('To remove the image, use Save choice. To prepare a copy, first choose Send the image, Show only or Use a description.');
    });
});

describe('the compatible copy preview and the conversion worker (C-5)', () => {
    const prepare = async answer => {
        env.workerAnswer = answer;
        env.routes.scan = () => scanResult([scanIssue({ status: 'embedded-image' })], target);
        env.routes.source = () => ({ base64: 'AAAA' });
        env.shownPanels.length = 0; env.popups.length = 0;
        const dialog = await env.open(target);
        await buttonsNamed(rowsOf(dialog.content)[0], 'Prepare a converted copy')[0].click(); await settle();
        return dialog;
    };

    test('every code the worker can post is shown as its sentence, final, and an unknown or old-style answer gets the general one', async () => {
        const messages = env.labels.workerErrorMessages();
        expect(Object.keys(messages).length).toBeGreaterThanOrEqual(11);
        for (const [code, sentence] of Object.entries(messages)) {
            const { status } = await prepare({ errorCode: code });
            expect(status.textContent).toBe(sentence);
            expect(status.hasAttribute('data-i18n-ignore')).toBe(true);
        }
        expect((await prepare({ errorCode: 'something-new' })).status.textContent).toBe(messages.failed);
        expect((await prepare({ error: 'An English sentence from an older worker.' })).status.textContent).toBe(messages.failed);
    });

    test('the sentences come from t``: a translation reaches the status line', async () => {
        env.dictionary['Animated images cannot be converted. Choose a still image.'] = 'Imagens animadas não podem ser convertidas. Escolha uma imagem fixa.';
        const dialog = await prepare({ errorCode: 'animated' });
        expect(dialog.status.textContent).toBe('Imagens animadas não podem ser convertidas. Escolha uma imagem fixa.');
    });

    test('a prepared copy shows its sizes in a protected element, then the sentence, and offers Save copy through its scoped key', async () => {
        env.popupResult = false; // cancel the preview; saving is covered by the server tests
        await prepare({ blob: new Blob(['x'], { type: 'image/png' }), width: 10, height: 20, originalWidth: 3000, originalHeight: 4000 });
        const preview = env.popups.find(popup => popup.type === 'confirm');
        expect(preview.options.okButton).toBe('Save copy');
        expect(preview.options.cancelButton).toBe('Cancel');
        expect(env.lookups).toContainEqual(['Save copy', 'scoped.prompt_media.CPY-08']);
        const protectedLine = elements(preview.content, node => node.getAttribute('translate') === 'no');
        expect(protectedLine.map(node => node.textContent)).toEqual(['3000 × 4000 → 10 × 20 · image/png · 1 KiB']);
        expect(byTag(preview.content, 'h3')[0].textContent).toBe('Save this compatible copy?');
        expect(byTag(preview.content, 'p').map(node => node.textContent)).toContain('Unless you tick the box above, the chat keeps showing the original image.');
        expect(byTag(preview.content, 'img')[0].alt).toBe('Prepared compatible copy');
        expect(byTag(preview.content, 'span').map(node => node.textContent)).toContain('Also show this copy in the chat instead of the original');
        unreached(preview.content, 'preview');
    });
});

describe('choose chats and the results of a batch change (BAT-09)', () => {
    const chats = [{ group: false, chat: 'Review', avatar: 'Group.png' }, { group: true, chat: 'Main' }, { group: false, chat: 'Third', avatar: 'Nova.png' }];
    const library = async () => {
        env.routes.chats = () => ({ chats, next: null });
        const dialog = await env.open(null);
        await byTag(dialog.navigation, 'button')[0].click(); await settle();
        const content = dialog.panel.children.at(-1);
        for (const label of elements(content, node => node.tag === 'label')) { const box = byTag(label, 'input')[0]; box.checked = true; await box.listeners.change[0](); }
        return { ...dialog, content };
    };

    test('with no chat open the status says so, and Current chat is not offered', async () => {
        const { status, navigation } = await env.open(null);
        expect(status.textContent).toBe('No chat is open. Choose chats to review, or change the setting for all chats above.');
        expect(byTag(navigation, 'button').map(node => node.textContent)).toEqual(['Choose chats', 'Change history']);
    });

    test('one row per chat: its name in a translate="no" element, then what happened, with errors through the exact lookup', async () => {
        env.use('pt-pt');
        env.routes.scan = body => scanResult([], body.locator);
        env.routes.apply = body => body.observation.locator.chat === 'Main' ? { failure: { status: 409, body: { error: 'The chat changed while you were reviewing it. List its images again, then choose.' } } }
            : body.observation.locator.chat === 'Third' ? { failure: { status: 500, body: { error: 'Hash <b>mismatch</b>.', integrity: true } } } : {};
        const { content, status } = await library();
        env.confirmations.length = 0;
        await buttonsNamed(content, shown('Stop sending images in selected chats'))[0].click(); await settle();
        // The confirmation counts the chats in a scoped, filled sentence.
        expect(byTag(env.confirmations[0].content, 'h3')[0].textContent).toBe(shown('Stop sending images in the selected chats?'));
        expect(byTag(env.confirmations[0].content, 'p')[0].textContent).toBe(filled(shown('Chats selected: ${0}. In new replies, the model will receive neither their images nor the images\' saved descriptions. You can turn this off again for each chat.', 'scoped.prompt_media.BAT-07'), 3));
        const list = listOf(content);
        const items = itemsOf(list);
        expect(items).toHaveLength(3);
        // Names first, protected; results after, final.
        expect(items.map(item => [item.children[0].getAttribute('translate'), item.children[0].textContent])).toEqual([['no', 'Review'], ['no', 'Main'], ['no', 'Third']]);
        expect(items.map(item => item.children[2].hasAttribute('data-i18n-ignore'))).toEqual([true, true, true]);
        expect(items[0].children[2].textContent).toBe('Salvo'); // the existing key 'Saved', translated by t``
        expect(items[1].children[2].textContent).toBe(shown('The chat changed while you were reviewing it. List its images again, then choose.'));
        expect(items[2].children[2].children.map(child => child.tag)).toEqual(['span', 'br', 'span']);
        expect(items[2].children[2].children[2].textContent).toBe('Hash <b>mismatch</b>.');
        expect(items[2].children[2].children[2].getAttribute('translate')).toBe('no');
        unreached(list, 'results');
        expect(status.textContent).toBe('');
        expect(env.events.map(event => event.type)).toContain('neconyan:image-input-settings-changed');
    });

    test('copies of stored images: the count, nothing to do, and the ledger\'s limits', async () => {
        env.routes.scan = body => body.locator.chat === 'Main' ? scanResult([], body.locator)
            : body.locator.chat === 'Third' ? scanResult([scanIssue()], body.locator, { limited: true })
                : scanResult([scanIssue({ status: 'embedded-image' }), scanIssue({ index: 1, identity: 'x', status: 'embedded-image' })], body.locator);
        env.routes.apply = () => ({});
        const { content } = await library();
        env.confirmations.length = 0;
        await buttonsNamed(content, 'Save copies of images stored in selected chats')[0].click(); await settle();
        expect(byTag(env.confirmations[0].content, 'h3')[0].textContent).toBe('Save copies of images stored in the selected chats?');
        const items = rowsOfList(content);
        expect(items.map(item => item.children[2].textContent)).toEqual([
            'Compatible copies saved: 2', 'No images stored in the chat', 'This chat has too many attachments to change with others. Review it on its own.']);
        expect(env.lookups).toContainEqual(['Compatible copies saved: ${0}', 'scoped.prompt_media.BAT-09.3']);
    });

    test('a second batch replaces the list of the first, so every row belongs to the run just made', async () => {
        env.routes.scan = body => scanResult([scanIssue({ status: 'embedded-image' })], body.locator);
        env.routes.apply = () => ({});
        const { content } = await library();
        await buttonsNamed(content, 'Stop sending images in selected chats')[0].click(); await settle();
        const list = listOf(content);
        expect(itemsOf(list).map(item => item.children[2].textContent)).toEqual(['Saved', 'Saved', 'Saved']);
        await buttonsNamed(content, 'Save copies of images stored in selected chats')[0].click(); await settle();
        expect(itemsOf(list).map(item => item.children[2].textContent)).toEqual(['Compatible copies saved: 1', 'Compatible copies saved: 1', 'Compatible copies saved: 1']);
    });

    test('declining the confirmation changes nothing, and selecting no chat is reported', async () => {
        const { content, status } = await library();
        env.confirmResult = 0;
        await buttonsNamed(content, 'Stop sending images in selected chats')[0].click(); await settle();
        expect(env.requests.map(request => request.action)).not.toContain('apply');
        expect(itemsOf(listOf(content))).toHaveLength(0);
        for (const label of elements(content, node => node.tag === 'label')) { const box = byTag(label, 'input')[0]; box.checked = false; await box.listeners.change[0](); }
        await buttonsNamed(content, 'Save copies of images stored in selected chats')[0].click(); await settle();
        expect(status.textContent).toBe('Select at least one chat.');
    });
});

describe('change history (HIS)', () => {
    const operations = [
        { id: 'c1', locator: { group: false, chat: 'Review', avatar: 'Group.png' }, createdAt: '2026-03-04T10:20:30.000Z', phase: 'prepared', stage: 'committed', backupAvailable: true },
        { id: 'c2', locator: { group: true, chat: 'Main' }, createdAt: '2026-03-05T08:00:00.000Z', phase: 'prepared', stage: 'committed', backupAvailable: false },
        { id: 'p1', locator: { group: true, chat: 'Main' }, createdAt: '2026-03-06T08:00:00.000Z', phase: 'prepared', stage: 'backup-verified', backupAvailable: false },
        { id: 'w1', locator: { group: true, chat: 'Main' }, createdAt: '2026-03-07T08:00:00.000Z', phase: 'prepared', stage: 'native-write-pending', backupAvailable: false },
        { id: 's1', locator: null, createdAt: null, phase: 'staging', stage: 'staging-incomplete', backupAvailable: false },
        { id: 'd1', locator: { group: true, chat: 'Main' }, createdAt: '2026-03-08T08:00:00.000Z', phase: 'aborted', stage: 'discarded', backupAvailable: false },
    ];
    const history = async (language = 'en') => {
        env.page.documentElement.lang = language;
        env.routes.history = () => ({ operations, next: 50 });
        const dialog = await env.open(null);
        await byTag(dialog.navigation, 'button')[1].click(); await settle();
        return { ...dialog, content: dialog.panel.children.at(-1) };
    };

    test('every change shows its date in the interface language and its stage as a label, never the stage code', async () => {
        const { content } = await history('pt-pt');
        const rows = byTag(content, 'fieldset');
        expect(rows).toHaveLength(6);
        const lines = rows.map(row => row.children[1]);
        const when = iso => new Intl.DateTimeFormat('pt-pt', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
        expect(lines.map(line => line.textContent)).toEqual([
            `${when(operations[0].createdAt)} · Completed`, `${when(operations[1].createdAt)} · Completed, backup deleted`,
            `${when(operations[2].createdAt)} · Prepared, not applied yet`, `${when(operations[3].createdAt)} · Interrupted while saving the chat`,
            'Preparation did not finish', `${when(operations[5].createdAt)} · Discarded`]);
        // The date is in an element of its own that nothing translates; a change with no date shows no date element.
        expect(lines[0].children[0].getAttribute('translate')).toBe('no');
        expect(lines[4].children).toHaveLength(1);
        expect(new Intl.DateTimeFormat('de-de', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(operations[0].createdAt))).not.toBe(when(operations[0].createdAt));
        expect(content.textContent).not.toMatch(/staging-incomplete|backup-verified|native-write-pending/);
        // The existing key 'Delete backup' and the scoped labels are looked up; the heading is the history heading.
        expect(byTag(content, 'h4')[0].textContent).toBe('Change history');
    });

    test('the buttons follow the state: finish, discard, download, undo, delete, and more', async () => {
        const { content } = await history();
        const rows = byTag(content, 'fieldset');
        const names = row => byTag(row, 'button').map(node => node.textContent);
        expect(names(rows[0])).toEqual(['Download backup', 'Undo change', 'Delete backup']);
        expect(names(rows[1])).toEqual([]);
        expect(names(rows[2])).toEqual(['Finish this change']);
        expect(names(rows[3])).toEqual(['Finish this change']);
        expect(names(rows[4])).toEqual(['Discard unfinished change']);
        expect(names(rows[5])).toEqual([]);
        expect(byTag(content, 'button').at(-1).textContent).toBe('More changes');
    });

    test('finishing, discarding, undoing and deleting use the ledger\'s sentences', async () => {
        const { content, status } = await history();
        const rows = byTag(content, 'fieldset');
        env.routes.resume = () => ({}); env.routes.discard = () => ({}); env.routes['backup/remove'] = () => ({});
        env.routes.scan = body => scanResult([], body.locator); env.routes.apply = () => ({});
        await buttonsNamed(rows[2], 'Finish this change')[0].click(); await settle();
        expect(status.textContent).toBe('Change finished. Reopen the chat to see it.');
        await buttonsNamed(rows[4], 'Discard unfinished change')[0].click(); await settle();
        expect(byTag(env.confirmations.at(-1).content, 'h3')[0].textContent).toBe('Discard this unfinished change?');
        expect(env.confirmations.at(-1).content.children[1].textContent).toBe('Its preparation files are deleted; anything unexpected is kept. Your chat and its images are not changed. You can make the change again afterwards.');
        expect(status.textContent).toBe('Unfinished change discarded.');
        await buttonsNamed(rows[0], 'Undo change')[0].click(); await settle();
        expect(byTag(env.confirmations.at(-1).content, 'h3')[0].textContent).toBe('Undo this change?');
        expect(env.confirmations.at(-1).content.children[1].textContent).toBe('The chat goes back to how it was before this change. This works only if the chat has not changed since. Images that were missing stay missing.');
        expect(status.textContent).toBe('Change undone.');
        expect(env.requests.find(request => request.body.undoOf === 'c1')).toBeTruthy();
        await buttonsNamed(rows[0], 'Delete backup')[0].click(); await settle();
        expect(byTag(env.confirmations.at(-1).content, 'h3')[0].textContent).toBe('Delete this backup?');
        expect(env.confirmations.at(-1).content.children[1].textContent).toBe('You will no longer be able to undo this change. Image files, including compatible copies, are kept. Download the backup first if you might need it.');
        expect(env.requests.map(request => request.action)).toContain('backup/remove');
    });
});

describe('the status line once a list has loaded (D-1)', () => {
    const operation = { id: 'c1', locator: { group: false, chat: 'Review', avatar: 'Group.png' }, createdAt: '2026-03-04T10:20:30.000Z', phase: 'prepared', stage: 'committed', backupAvailable: true };
    // A route that answers only when the test lets it, so the status can be read while the list is still loading.
    const gated = answer => {
        let release; const gate = new Promise(resolve => { release = resolve; });
        return { release, route: async body => { await gate; return answer(body); } };
    };

    test('Change history says Working… while it loads and nothing once it has', async () => {
        const history = gated(() => ({ operations: [operation], next: 50 }));
        env.routes.history = history.route;
        const { status, navigation, panel } = await env.open(null);
        expect(status.textContent).toBe('No chat is open. Choose chats to review, or change the setting for all chats above.');
        const loading = byTag(navigation, 'button')[1].click(); await settle();
        expect(status.textContent).toBe('Working…');
        history.release(); await loading; await settle();
        expect(byTag(panel.children.at(-1), 'h4')[0].textContent).toBe('Change history');
        expect(status.textContent).toBe('');
        // The paging button goes through the same view.
        env.routes.history = () => ({ operations: [], next: null });
        await buttonsNamed(panel.children.at(-1), 'More changes')[0].click(); await settle();
        expect(status.textContent).toBe('');
    });

    test('Choose chats says Working… while it loads and nothing once it has, also after More chats', async () => {
        const chats = gated(() => ({ chats: [{ group: false, chat: 'Review', avatar: 'Group.png' }], next: 50 }));
        env.routes.chats = chats.route;
        const { status, navigation, panel } = await env.open(null);
        const loading = byTag(navigation, 'button')[0].click(); await settle();
        expect(status.textContent).toBe('Working…');
        chats.release(); await loading; await settle();
        expect(byTag(panel.children.at(-1), 'h4')[0].textContent).toBe('Choose chats');
        expect(status.textContent).toBe('');
        env.routes.chats = () => ({ chats: [], next: null });
        await buttonsNamed(panel.children.at(-1), 'More chats')[0].click(); await settle();
        expect(status.textContent).toBe('');
    });

    test('Delete backup reloads the history and leaves the status line empty', async () => {
        env.routes.history = () => ({ operations: [operation], next: null });
        env.routes['backup/remove'] = () => ({});
        const { status, navigation, panel } = await env.open(null);
        await byTag(navigation, 'button')[1].click(); await settle();
        await buttonsNamed(panel.children.at(-1), 'Delete backup')[0].click(); await settle();
        expect(env.requests.map(request => request.action).filter(action => action === 'history' || action === 'backup/remove')).toEqual(['history', 'backup/remove', 'history']);
        expect(status.textContent).toBe('');
    });

    test('a list that fails to load keeps its reason in the status line instead of clearing it', async () => {
        env.routes.history = () => ({ failure: { status: 500, body: { error: 'The change history could not be read.' } } });
        env.routes.chats = () => ({ failure: { status: 500, body: { error: 'The chats could not be listed.' } } });
        const { status, navigation } = await env.open(null);
        await byTag(navigation, 'button')[1].click(); await settle();
        expect(status.textContent).toBe('The change history could not be read.');
        await byTag(navigation, 'button')[0].click(); await settle();
        expect(status.textContent).toBe('The chats could not be listed.');
    });

    test('Finish, Discard and Undo still show their own messages after the history reloads', async () => {
        env.routes.history = () => ({ operations: [{ ...operation, phase: 'prepared', stage: 'backup-verified', backupAvailable: false }, { id: 's1', locator: null, createdAt: null, phase: 'staging', stage: 'staging-incomplete', backupAvailable: false }, operation], next: null });
        env.routes.resume = () => ({}); env.routes.discard = () => ({}); env.routes.scan = body => scanResult([], body.locator); env.routes.apply = () => ({});
        const { status, navigation, panel } = await env.open(null);
        await byTag(navigation, 'button')[1].click(); await settle();
        const rows = () => byTag(panel.children.at(-1), 'fieldset');
        await buttonsNamed(rows()[0], 'Finish this change')[0].click(); await settle();
        expect(status.textContent).toBe('Change finished. Reopen the chat to see it.');
        await buttonsNamed(rows()[1], 'Discard unfinished change')[0].click(); await settle();
        expect(status.textContent).toBe('Unfinished change discarded.');
        await buttonsNamed(rows()[2], 'Undo change')[0].click(); await settle();
        expect(status.textContent).toBe('Change undone.');
    });
});

describe('the dialog\'s style rules (D-5, D-6)', () => {
    // The rules of public/css/neconyan-menus.css that apply to the dialog, as { selectors, declarations } pairs. The real layout is measured in the browser.
    const rules = readFileSync(new URL('../public/css/neconyan-menus.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        .split('}').map(block => block.split('{')).filter(([selectors, body]) => body !== undefined && selectors.includes('#prompt-media-review'))
        .map(([selectors, body]) => ({ selectors: selectors.split(',').map(selector => selector.trim()), declarations: body.split(';').map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean) }));
    const declaring = declaration => selector => rules.some(rule => rule.selectors.includes(selector) && rule.declarations.includes(declaration));

    test('D-5: a closed select wraps a long selected option onto a second line instead of cutting it off, and stays inside the dialog', () => {
        expect(declaring('white-space: normal')('#prompt-media-review select')).toBe(true);
        expect(declaring('block-size: auto')('#prompt-media-review select')).toBe(true);
        // The width limits that keep a select inside the dialog are still there.
        expect(declaring('max-inline-size: 100%')('#prompt-media-review select')).toBe(true);
        expect(declaring('min-inline-size: 0')('#prompt-media-review select')).toBe(true);
    });

    test('D-6: headings and every value the person wrote wrap, as paragraphs, labels and legends already do', () => {
        const wraps = declaring('overflow-wrap: anywhere');
        for (const selector of ['#prompt-media-review h3', '#prompt-media-review h4', '#prompt-media-review [translate="no"]',
            '#prompt-media-review p', '#prompt-media-review label', '#prompt-media-review legend']) expect({ selector, wraps: wraps(selector) }).toEqual({ selector, wraps: true });
    });
});
