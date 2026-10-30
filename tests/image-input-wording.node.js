/* eslint playwright/expect-expect: off -- Source, catalogue and function checks with Node assertions; no browser. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { load } from 'cheerio';
import { createNotifier } from '../public/scripts/extensions/quick-image-gen/lib/notifications.js';

// Wording of the everyday image controls and refusals (E1 stage 2). Each ledger row's English is pinned whole, because
// the text is the key: a changed word changes the key, and a translator then has to start again.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Rows whose English is its own key, by ledger id. A row with two messages has .1 and .2.
const WORDING = {
    'SET-01': 'Don\'t send chat images to the model',
    'SET-02': 'Images stay visible in your chats, but the model receives neither the images nor their saved descriptions when it writes new replies. This works like choosing Show only for every image. It does not change message text or saved memories.',
    'TIP-01': 'Describe with the caption service',
    'CAP-01': 'Using the caption service to describe an image sends the image to the service chosen below, even when it is set to Show only. Automatic descriptions skip images set to Show only or Use a description.',
    'QIG-01': 'Generated images in replies',
    'QIG-05': 'Show only keeps the image in the chat but sends the model neither the image nor its description. If images are not sent for all chats, or for the open chat, that setting takes priority.',
    'QIG-06': 'Right now: not sent, because \'Don\'t send chat images to the model\' is on.',
    'QIG-07': 'Right now: not sent, because this chat\'s images are not sent to the model.',
    'QIG-08': 'Right now: images are not sent, because this connection does not send them. Use Chat Completion with \'Send inline media\' turned on. Descriptions are still sent.',
    'QIG-09': 'Right now: each image\'s own choice applies. To use sent images, the model must be able to see images.',
    'QIG-10': 'Library images in replies',
    'QIG-12.1': 'Applies to images you insert from now on. Roleplay and Conversation keep separate settings; this is the Roleplay one.',
    'QIG-12.2': 'Applies to images you insert from now on. Roleplay and Conversation keep separate settings; this is the Conversation one.',
    'QIG-13': 'Use a description sends the prompt that made the image, as text.',
    'QIG-14': 'Use a description sends the library image\'s saved description, as text. Images without one are not inserted.',
    'QIG-15': 'Insert as a hidden reply',
    'QIG-16': 'Hidden replies show the image to you but are never sent to the model.',
    'QIG-17': 'This version of Neconyan cannot insert images with their image choices. Update Neconyan; the image stays in the gallery.',
    'QIG-18': 'This library image has no saved description. Under \'Library images in replies\', choose Send the image or Show only.',
    'QIG-19.1': 'The image cannot be sent as it is. It stays in the gallery; to insert it now, choose Show only or Use a description.',
    'QIG-19.2': 'The library image cannot be sent as it is. To insert library images, choose Show only or Use a description under \'Library images in replies\'.',
    'QIG-21': 'This image needs a compatible copy before it can be sent.',
    'QIG-22': 'You switched accounts while the image was being inserted, so it was not inserted.',
    'RMV-01': 'The chat changed before the image was removed, so nothing was removed. Try again.',
    'RMV-02': 'This reply\'s saved data disagrees about its images, so nothing was removed. Reload the chat, then try again.',
    'RMV-03': 'The change could not be saved, so the image was kept.',
    'RMV-05': 'Image removed from the message. Its compatible copy is kept on the server, because other chats may use it.',
    'RMV-06': 'Image removed from the message, but its file could not be deleted from the server.',
    'GEN-P01.1': 'The saved setting \'Don\'t send chat images to the model\' is damaged. Turn it off and on again in User Settings.',
    'GEN-P01.2': 'This chat\'s saved setting for sending images is damaged. Turn \'Don\'t send this chat\'s images to the model\' off and on again in Review chat images.',
    'GEN-P01.3': 'This branch\'s saved setting for sending images is damaged. Turn \'Don\'t send this branch\'s images to the model\' off and on again in Review chat images.',
    'GEN-P02': 'An image\'s saved choice is damaged. Choose again for it in Review chat images.',
    'GEN-P03': 'An image changed after its choice was saved. Choose again for it in Review chat images.',
    'GEN-P04': 'An image\'s compatible copy record is damaged. Prepare a new copy in Review chat images.',
    'GEN-P05': 'An image set to Use a description has no description. Choose or type one in Review chat images.',
    'GEN-P06': 'An image\'s description is missing or longer than 16 KiB. Edit it in Review chat images.',
    'GEN-P07': 'A message\'s attachment list is damaged. Review it in Review chat images.',
    'GEN-P08': 'A message\'s older image attachment is damaged. Review it in Review chat images.',
    'GEN-P09': 'The page and the server are running different versions. Reload the page, then try again.',
    'GEN-P10': 'Image settings could not be read. Reload the page, then try again.',
    'GEN-P11': 'A message has an unknown image layout. Switch it to list or gallery, then try again.',
    'GEN-P12': 'A gallery\'s chosen image no longer exists. Pick another image in that gallery, or fix it in Review chat images.',
    'GEN-P13': 'A message has a damaged attachment. Remove it in Review chat images.',
    'GEN-P14': 'A message would send more than four images. Set some to Show only, or show them as a gallery so only one is sent.',
    'GEN-S01': 'This chat\'s connection cannot receive images. Set them to Show only or Use a description, or switch to a connection that accepts images.',
    'GEN-S02': 'An image description changed while the reply was starting. Try again.',
    'GEN-S03': 'This image needs a compatible copy before it can be sent.',
    'GEN-S04': 'This image is on another website. Save a compatible copy of it before sending it.',
    'GEN-C01': 'This page is out of date. Reload it, then try again.',
    'GEN-C02': 'You switched accounts while images were being checked. Try again.',
    'GEN-C03': 'Compatible copies could not be checked. Try again, or review them in Review chat images.',
    'GEN-CV1': 'An older message saved image descriptions and file text together. Before Show only can apply, choose what the model receives for it in Review chat images.',
    'GEN-CV2': 'A message\'s reviewed attachment text is damaged. Choose again in Review chat images.',
    'GEN-CV3': 'A reply contains a quote that cannot be checked against its original message. Your image settings require you to review the quote before continuing. Choose what the model receives in Review chat images.',
    'GEN-F01': 'An image\'s compatible copy is missing or changed. Prepare a new one in Review chat images.',
    'GEN-F02': 'An image\'s original file changed or is missing, so its compatible copy is not used. Review it in Review chat images.',
    'RVW-04': 'Don\'t send chat images to the model',
    'RVW-05': 'Don\'t send this chat\'s images to the model',
    'RVW-06': '\'Don\'t send chat images to the model\' is on for your account, so it applies here whatever you choose below.',
    'RVW-07': 'Stop sending images in selected chats',
    'RVW-23': 'Your setting was not saved. Try again.',
    'RVW-24': 'You switched accounts, so the setting was not saved.',
    'CNV-04': 'Don\'t send chat images to the model',
    'CNV-05': 'Don\'t send this branch\'s images to the model',
    'CNV-06': '\'Don\'t send chat images to the model\' is on for your account, so it applies here whatever you choose below.',
    'GEN-01': 'Review needed before replying',
    'GEN-02': 'Open Review chat images to choose what the model receives.',
    // Stage 4d: why a notice cannot open its review (prompt-media-ui.js, explainOrigin*).
    'NTC-01': 'The chat or branch this notice refers to could not be opened, so its image review is not available.',
    'NTC-02': 'This notice belongs to another account. Switch back to that account to review the image.',
    'NTC-03': 'This notice refers to a different branch. Switch back to that branch to review the image.',
};
// Short labels and sentences with a hole use a scoped key, which only an explicit lookup reaches.
const SCOPED = {
    'scoped.prompt_media.SET-03': 'Review chat images',
    'scoped.prompt_media.QIG-02': 'Show only',
    'scoped.prompt_media.QIG-03': 'Send the image',
    'scoped.prompt_media.QIG-04': 'Use a description',
    'scoped.prompt_media.QIG-20': 'Could not insert the image: ${0}',
    'scoped.prompt_media.QIG-23': 'Context Media could not insert an image: ${0}',
    'scoped.prompt_media.RMV-04': 'Image kept',
};
const exactKeys = [...new Set(Object.values(WORDING))];

test('the pinned key list is the whole list: 66 exact keys and 7 scoped keys', () => {
    assert.equal(exactKeys.length, 66);
    assert.equal(Object.keys(SCOPED).length, 7);
    for (const key of Object.keys(SCOPED)) assert.match(key, /^scoped\.prompt_media\.[A-Z]+-\d+$/);
    for (const key of exactKeys) assert.ok(!key.startsWith('scoped.'), key);
});

test('every key this stage adds is collected by the builder and catalogued in English', () => {
    const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    const listed = new Set(JSON.parse(run.stdout));
    const catalogue = JSON.parse(read('public/locales/neconyan/en.json'));
    for (const key of exactKeys) {
        assert.ok(listed.has(key), `not collected: ${key}`);
        assert.equal(catalogue[key], key, `catalogue value differs: ${key}`);
    }
    for (const [key, english] of Object.entries(SCOPED)) {
        assert.ok(listed.has(key), `not collected: ${key}`);
        assert.equal(catalogue[key], english, `catalogue value differs: ${key}`);
    }
});

function carries(element, key, text) {
    assert.equal(element.length, 1, `one element expected for ${key}`);
    assert.equal(element.attr('data-i18n'), key);
    assert.equal(element.text().trim(), text);
}

test('Settings, the media tooltip and the caption paragraph carry their keys', () => {
    const page = load(read('public/index.html'));
    carries(page('label[for="prompt-images-account"] > span'), WORDING['SET-01'], WORDING['SET-01']);
    carries(page('label[for="prompt-images-account"]').next('small'), WORDING['SET-02'], WORDING['SET-02']);
    carries(page('#prompt-images-review'), 'scoped.prompt_media.SET-03', 'Review chat images');
    // One string covers the envelope icon on a message image and on a message video.
    for (const template of ['#message_image_template', '#message_video_template']) {
        const icon = page(`${template} .mes_img_caption`);
        assert.equal(icon.length, 1, template);
        assert.equal(icon.attr('title'), WORDING['TIP-01']);
        assert.equal(icon.attr('data-i18n'), `[title]${WORDING['TIP-01']}`);
    }
    const drawer = load(read('public/scripts/extensions/caption/settings.html'));
    carries(drawer('.inline-drawer-content > p').first(), WORDING['CAP-01'], WORDING['CAP-01']);
});

// The panel is one template literal in index.js. Rebuild its markup the way the builder does (a hole becomes NUL).
function quickImageGenPanel() {
    const ast = parse(read('public/scripts/extensions/quick-image-gen/index.js'), { ecmaVersion: 'latest', sourceType: 'module' });
    let markup = null;
    (function walk(node) {
        if (markup || !node || typeof node !== 'object') return;
        if (node.type === 'TemplateLiteral') {
            const text = node.quasis.map(quasi => quasi.value.cooked ?? '').join('\u0000');
            if (text.includes('id="qig-chat-image-input"')) { markup = text; return; }
        }
        for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(walk) : walk(value);
    })(ast);
    assert.ok(markup, 'panel template not found');
    return load(markup);
}

test('the Quick Image Gen labels, options and help lines carry their keys', () => {
    const panel = quickImageGenPanel();
    const options = select => Object.fromEntries(panel(`${select} option`).get().map(option => [panel(option).attr('value'),
        [panel(option).attr('data-i18n'), panel(option).text().trim()]]));
    const choices = {
        'display-only': ['scoped.prompt_media.QIG-02', 'Show only'],
        caption: ['scoped.prompt_media.QIG-04', 'Use a description'],
        include: ['scoped.prompt_media.QIG-03', 'Send the image'],
    };
    // Generated images: label, three options, the workspace line set from code, the two help lines, then the 'Right now' line set from code.
    carries(panel('label[for="qig-chat-image-input"]'), WORDING['QIG-01'], WORDING['QIG-01']);
    assert.deepEqual(options('#qig-chat-image-input'), choices);
    const generated = panel('#qig-chat-image-input').nextAll('small');
    assert.equal(generated.eq(0).attr('id'), 'qig-chat-image-input-workspace');
    assert.equal(generated.eq(0).attr('data-i18n'), undefined);
    carries(generated.eq(1), WORDING['QIG-05'], WORDING['QIG-05']);
    carries(generated.eq(2), WORDING['QIG-13'], WORDING['QIG-13']);
    assert.equal(generated.eq(3).attr('id'), 'qig-image-input-effective');
    // Library images in Context Media.
    carries(panel('label[for="qig-context-image-input"]'), WORDING['QIG-10'], WORDING['QIG-10']);
    assert.deepEqual(options('#qig-context-image-input'), choices);
    const library = panel('#qig-context-image-input').nextAll('small');
    carries(library.eq(0), WORDING['QIG-14'], WORDING['QIG-14']);
    assert.equal(library.eq(1).attr('id'), 'qig-context-image-input-effective');
    // The effective-state lines are set from code, so they carry no key of their own.
    for (const id of ['qig-image-input-effective', 'qig-context-image-input-effective']) assert.equal(panel(`#${id}`).attr('data-i18n'), undefined);
    // The hidden-reply checkbox and its help line.
    carries(panel('#qig-insert-hidden-reply').closest('label').find('span'), WORDING['QIG-15'], WORDING['QIG-15']);
    carries(panel('#qig-insert-hidden-reply').closest('label').next('small'), WORDING['QIG-16'], WORDING['QIG-16']);
});

test('the help lines under Generated images in replies share one small gap, and the next label starts clear of them, by a rule scoped to the panel', () => {
    const panel = quickImageGenPanel();
    // The field: the select, the workspace line, QIG-05, QIG-13 and the 'Right now' line, then the next field's label.
    const after = panel('#qig-chat-image-input').nextAll().slice(0, 5).get();
    assert.deepEqual(after.map(element => element.tagName), ['small', 'small', 'small', 'small', 'label']);
    assert.equal(panel(after[0]).attr('id'), 'qig-chat-image-input-workspace');
    assert.equal(panel(after[3]).attr('id'), 'qig-image-input-effective');
    assert.equal(panel(after[4]).text().trim(), 'Chat insert output');
    const css = read('public/scripts/extensions/quick-image-gen/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(match => ({ selectors: match[1].split(',').map(selector => selector.trim().replace(/\s+/g, ' ')), body: match[2] }));
    const marginTop = selector => rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.body.match(/margin-top:\s*([^;]+);/)?.[1]);
    // QIG-05 and QIG-13 are reached from the workspace line, the 'Right now' line by its id; each is under #qig-settings, as the panel's other rules are.
    for (const selector of ['#qig-settings #qig-chat-image-input-workspace + small', '#qig-settings #qig-chat-image-input-workspace + small + small', '#qig-settings #qig-image-input-effective']) {
        assert.deepEqual(marginTop(selector), ['6px'], selector);
    }
    assert.deepEqual(marginTop('#qig-settings #qig-image-input-effective + label'), ['10px']);
    // Both are larger than the panel's own gap under a help line, which they must beat without !important.
    assert.deepEqual(marginTop('#qig-settings small'), ['4px']);
    for (const rule of rules.filter(candidate => candidate.selectors.some(selector => /#qig-image-input-effective|#qig-chat-image-input-workspace/.test(selector)))) assert.ok(!/!important/.test(rule.body));
});

const extract = (source, signature) => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
};
const tag = (strings, ...values) => strings.reduce((text, part, index) => text + part + (index < values.length ? values[index] : ''), '');
const node = () => ({ textContent: '', attributes: {}, value: '', setAttribute(name, value) { this.attributes[name] = value; } });


const qigSource = read('public/scripts/extensions/quick-image-gen/index.js');
// The refresh reads the open workspace and the page, so it runs against a stand-in host with the real helper cut beside it.
function refreshHost() {
    const nodes = Object.fromEntries(['qig-chat-image-input', 'qig-chat-image-input-workspace', 'qig-image-input-effective', 'qig-context-image-input-effective'].map(id => [id, node()]));
    const host = { state: null, t: tag, currentImageInputPreference: () => 'caption', effectiveBrowserPromptMediaContext: async () => host.state,
        conversationState: { conversationWorkspaceOpen: false }, document: { getElementById: id => nodes[id] ?? null } };
    host.workspaceImageInputNote = vm.runInNewContext(`(${extract(qigSource, 'function workspaceImageInputNote(')})`, host);
    host.refresh = vm.runInNewContext(`(${extract(qigSource, 'async function refreshPromptImageEffectiveState(')})`, host);
    return { host, nodes };
}

test('the line under the select names the open workspace, in two complete sentences, and follows the workspace flag', async () => {
    const { host, nodes } = refreshHost();
    host.state = { account: 'include', chat: 'include', inlineImages: true };
    const note = nodes['qig-chat-image-input-workspace'];
    await host.refresh();
    assert.equal(note.textContent, WORDING['QIG-12.1']);
    assert.deepEqual(note.attributes, { 'data-i18n-ignore': '' }, 'the line is final text');
    host.conversationState.conversationWorkspaceOpen = true;
    await host.refresh();
    assert.equal(note.textContent, WORDING['QIG-12.2']);
    host.conversationState.conversationWorkspaceOpen = false;
    await host.refresh();
    assert.equal(note.textContent, WORDING['QIG-12.1']);
    // The line is set before the connection is read, so a damaged setting that stops the second half still leaves it right.
    host.conversationState.conversationWorkspaceOpen = true;
    host.effectiveBrowserPromptMediaContext = async () => { throw new Error('damaged'); };
    await assert.rejects(host.refresh(), { message: 'damaged' });
    assert.equal(note.textContent, WORDING['QIG-12.2']);
    // Both sentences are whole sentences with no hole, so each is its own key.
    assert.ok(!WORDING['QIG-12.1'].includes('${') && !WORDING['QIG-12.2'].includes('${'));
});

test('the effective-state line says its four sentences and marks itself final', async () => {
    const { host, nodes } = refreshHost();
    const refresh = host.refresh;
    const states = [
        [{ account: 'display-only', chat: 'include', inlineImages: true }, 'QIG-06'],
        [{ account: 'include', chat: 'display-only', inlineImages: true }, 'QIG-07'],
        [{ account: 'include', chat: 'include', inlineImages: false }, 'QIG-08'],
        [{ account: 'include', chat: 'include', inlineImages: true }, 'QIG-09'],
    ];
    for (const [state, id] of states) {
        host.state = state;
        await refresh();
        for (const line of ['qig-image-input-effective', 'qig-context-image-input-effective']) {
            assert.equal(nodes[line].textContent, WORDING[id]);
            assert.deepEqual(nodes[line].attributes, { 'data-i18n-ignore': '' }, `${line} is final text`);
        }
        assert.equal(nodes['qig-chat-image-input'].value, 'caption');
    }
});

// prompt-media-client.js imports the browser app, so its two checks are cut out as text and run against a stand-in host.
const clientSource = read('public/scripts/prompt-media-client.js');
const stamp = { account: 'account-stamp' };
// The helper is one line, so it is cut from the source as it stands rather than copied.
const localizedErrorSource = clientSource.split('\n').find(line => line.startsWith('export const localizedError = ')).replace('export ', '');
const integrityExplanationSource = clientSource.split('\n').find(line => line.startsWith('const integrityExplanation = '))?.replace('const integrityExplanation = ', '').replace(/;$/, '') ?? 'undefined';
function clientHost(overrides = {}) {
    const lookups = [];
    let reads = 0;
    const host = { lookups, t: tag, translate: (text, key) => { lookups.push([text, key]); return text; },
        localizedError: vm.runInNewContext(`(${localizedErrorSource.replace('const localizedError = ', '').replace(/;$/, '')})`, { Object, Error }),
        integrityExplanation: vm.runInNewContext(`(${integrityExplanationSource})`, { t: tag }),
        effectiveBrowserPromptMediaContext: async () => ({ account: 'include', chat: 'include', inlineImages: true }),
        getCurrentUserHandle: () => (reads++ ? host.after ?? 'alice' : 'alice'), roleplayAccountStamp: () => stamp, getRequestHeaders: () => ({}),
        fetch: async () => ({ ok: false, json: async () => ({ error: 'Server reason.' }) }), JSON, ...overrides };
    return host;
}
const cut = (host, signature) => vm.runInNewContext(`(${extract(clientSource, signature).replace('export ', '')})`, host);

test('a refused insertion gives its sentence, then the server reason on its own line', async () => {
    const host = clientHost();
    const preflight = cut(host, 'export async function preflightImageInput(');
    await assert.rejects(preflight('/user/images/a.png', 'include'), { message: `${WORDING['QIG-19.1']}\nServer reason.`, sentence: WORDING['QIG-19.1'], reason: 'Server reason.' });
    // The reason is a whole server message, so it is looked up by its exact text before it joins the sentence.
    assert.deepEqual(host.lookups, [['Server reason.', undefined]]);
    await assert.rejects(preflight('/user/images/a.png', 'include', { library: true }), { message: `${WORDING['QIG-19.2']}\nServer reason.`, sentence: WORDING['QIG-19.2'], reason: 'Server reason.' });
});

test('a refused insertion without a server reason falls back to the compatible-copy sentence', async () => {
    const host = clientHost({ fetch: async () => ({ ok: false, json: async () => ({}) }) });
    const preflight = cut(host, 'export async function preflightImageInput(');
    await assert.rejects(preflight('/user/images/a.png', 'include'), { message: `${WORDING['QIG-19.1']}\n${WORDING['QIG-21']}` });
    assert.deepEqual(host.lookups, []);
});

test('an account switch during the check refuses with its own sentence, and unsent images skip the check', async () => {
    const host = clientHost({ fetch: async () => ({ ok: true, json: async () => ({ url: '/user/images/checked.png' }) }) });
    host.after = 'bob';
    await assert.rejects(cut(host, 'export async function preflightImageInput(')('/user/images/a.png', 'include'), { message: WORDING['QIG-22'] });
    const calm = clientHost({ fetch: async () => ({ ok: true, json: async () => ({ url: '/user/images/checked.png' }) }) });
    const preflight = cut(calm, 'export async function preflightImageInput(');
    assert.equal(await preflight('/user/images/a.png', 'include'), '/user/images/checked.png');
    assert.equal(await preflight('/user/images/a.png', 'display-only'), '/user/images/a.png');
});

test('the copy check says what to do when it cannot run, and shows a server reason through its exact lookup', async () => {
    const check = host => cut(host, 'export async function validatePromptImageCopies(');
    // Every error here has its text already in the reader's language, so display code is told not to look it up again.
    await assert.rejects(check(clientHost({ roleplayAccountStamp: () => ({}) }))([{}]), { message: WORDING['GEN-C01'], localized: true });
    const switched = clientHost({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
    switched.after = 'bob';
    await assert.rejects(check(switched)([{}]), { message: WORDING['GEN-C02'], localized: true });
    const unexplained = clientHost({ fetch: async () => ({ ok: false, json: async () => ({}) }) });
    await assert.rejects(check(unexplained)([{}]), { message: WORDING['GEN-C03'], localized: true });
    const explained = clientHost();
    await assert.rejects(check(explained)([{}]), { message: 'Server reason.', localized: true });
    assert.deepEqual(explained.lookups, [['Server reason.', undefined]]);
    assert.equal(await check(clientHost())([]), undefined);
});

// An integrity failure (INT-01) gets the same explanation on the two image checks as in the review window, then the server's English detail as written.
const INT_01 = 'Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.';
const integrityRefusal = { ok: false, json: async () => ({ error: 'The immutable image record changed.', integrity: true }) };

test('an integrity failure on the insertion check gets the explanation, then the detail as written', async () => {
    const host = clientHost({ fetch: async () => integrityRefusal });
    await assert.rejects(cut(host, 'export async function preflightImageInput(')('/user/images/a.png', 'include'), error => {
        assert.equal(error.sentence, WORDING['QIG-19.1']);
        assert.equal(error.reason, `${INT_01} The immutable image record changed.`);
        assert.equal(error.message, `${error.sentence}\n${error.reason}`);
        return true;
    });
    // The detail is the server's English as written: it is not looked up.
    assert.deepEqual(host.lookups, []);
});

test('an integrity failure on the copy check gets the explanation, then the detail as written', async () => {
    const host = clientHost({ fetch: async () => integrityRefusal });
    await assert.rejects(cut(host, 'export async function validatePromptImageCopies(')([{}]), { message: `${INT_01}\nThe immutable image record changed.`, localized: true });
    assert.deepEqual(host.lookups, []);
});

test('only a failure the server tags as an integrity failure gets the explanation', async () => {
    const untagged = clientHost({ fetch: async () => ({ ok: false, json: async () => ({ error: 'Server reason.', integrity: 'true' }) }) });
    await assert.rejects(cut(untagged, 'export async function validatePromptImageCopies(')([{}]), { message: 'Server reason.', localized: true });
    assert.deepEqual(untagged.lookups, [['Server reason.', undefined]]);
});

test('the review window and the image checks say the integrity explanation in the same words', () => {
    for (const file of ['public/scripts/prompt-media-ui.js', 'public/scripts/prompt-media-client.js']) {
        assert.ok(read(file).includes(`t\`${INT_01}\``), `${file} does not say INT-01`);
    }
});

// The toast text is read by insertFailureLines and built by twoLineToastHtml, cut from their sources and run against a stand-in lookup.
function insertFailureHost() {
    const lookups = [];
    const context = vm.createContext({ String, translate: (text, key) => { lookups.push([text, key]); return key ? text : `<${text}>`; } });
    // The module's import line goes and its exports become plain declarations; the rest is the real helper.
    vm.runInContext(read('public/scripts/toast-lines.js').replace(/^import .*\n/m, '').replace(/^export /gm, ''), context);
    const insertFailureLines = vm.runInContext(`(${extract(qigSource, 'function insertFailureLines(')})`, context);
    // The page reads the lines first and builds the HTML once the toast module has loaded; here both happen at once.
    const insertFailureHtml = error => { const { sentence, reason } = insertFailureLines(error); return vm.runInContext('twoLineToastHtml', context)(sentence, reason); };
    // Two lines are text, a line break, then the reason in a span the run-time localiser leaves alone.
    const lines = html => {
        const parts = load(`<div>${html}</div>`)('div').contents().get();
        return { count: parts.length, first: parts[0]?.data, break: parts[1]?.name,
            reason: parts[2]?.name === 'span' ? { text: load(parts[2]).text(), final: parts[2].attribs['data-i18n-ignore'] } : null };
    };
    return { lookups, insertFailureHtml, lines };
}

test('a refused insertion (QIG-19) shows its sentence and the server reason as two lines, without the QIG-20 prefix', () => {
    for (const id of ['QIG-19.1', 'QIG-19.2']) {
        const { lookups, insertFailureHtml, lines } = insertFailureHost();
        const html = insertFailureHtml({ message: `${WORDING[id]}\nServer reason.`, sentence: WORDING[id], reason: 'Server reason.' });
        assert.ok(!html.includes('Could not insert the image'), `${id} has no prefix`);
        // The sentence was made with t`` where the error was raised, so it is shown as it is; only the server reason is looked up.
        assert.deepEqual(lookups, [['Server reason.', undefined]], id);
        assert.deepEqual(lines(html), { count: 3, first: WORDING[id], break: 'br', reason: { text: '<Server reason.>', final: '' } }, id);
    }
    // A reason with markup shows literally, and an error with a sentence but no reason shows the sentence alone.
    const { insertFailureHtml, lines } = insertFailureHost();
    assert.equal(load(`<div>${insertFailureHtml({ message: 'x', sentence: WORDING['QIG-19.1'], reason: '<b>bold</b>' })}</div>`)('b').length, 0);
    assert.deepEqual(lines(insertFailureHtml({ message: WORDING['QIG-19.1'], sentence: WORDING['QIG-19.1'] })), { count: 1, first: WORDING['QIG-19.1'], break: undefined, reason: null });
});

test('an ordinary insertion error keeps the QIG-20 prefix, with its detail looked up exactly first', () => {
    const { lookups, insertFailureHtml, lines } = insertFailureHost();
    // Neither the scoped sentence nor the detail may be read for a replacement pattern such as $&.
    const html = insertFailureHtml({ message: 'Disk $& full' });
    assert.equal(html, 'Could not insert the image: &lt;Disk $&amp; full&gt;');
    assert.deepEqual(lookups, [['Could not insert the image: ${0}', 'scoped.prompt_media.QIG-20'], ['Disk $& full', undefined]]);
    assert.deepEqual(lines(html), { count: 1, first: 'Could not insert the image: <Disk $& full>', break: undefined, reason: null });
    // The account-switch refusal (QIG-22) is one sentence with no reason, so it is also an ordinary error here.
    assert.ok(insertFailureHtml({ message: WORDING['QIG-22'] }).startsWith('Could not insert the image: '));
    assert.equal(qigSource.split('showInsertFailure(err)').length - 1, 2, 'both insert buttons share the sentence');
    assert.equal(qigSource.split('{ finalText: true, escapeHtml: false }').length - 1, 1, 'and show it, from one place, as escaped HTML');
    assert.ok(qigSource.includes('translate(\'Context Media could not insert an image: ${0}\', \'scoped.prompt_media.QIG-23\')'));
    assert.ok(qigSource.includes('preflightImageInput(attachment.url, imageInput, { library: true })'), 'the Context Media path uses the library sentence');
});

// Shared and server messages are marked with uiText() so the catalogue collects them, whichever side raises them.
const MARKED = {
    'public/scripts/prompt-media-policy.js': ['GEN-P01.1', 'GEN-P01.2', 'GEN-P01.3', 'GEN-P02', 'GEN-P03', 'GEN-P04', 'GEN-P05', 'GEN-P06', 'GEN-P07', 'GEN-P08', 'GEN-P09', 'GEN-P10', 'GEN-P11', 'GEN-P12', 'GEN-P13', 'GEN-P14'],
    'public/scripts/neconyan-conversation/prompt-media.js': ['GEN-CV1', 'GEN-CV2', 'GEN-CV3'],
    'src/generation/world-info.js': ['GEN-P09'],
    'src/generation/roleplay-execution.js': ['GEN-S01'],
    'src/generation/roleplay-prompt.js': ['GEN-S02'],
    'src/endpoints/roleplay.js': ['GEN-S03', 'GEN-S04'],
    'src/managed-image-files.js': ['GEN-P04', 'GEN-F01', 'GEN-F02'],
};
const escapeQuote = text => text.split('\'').join('\\\'');

test('shared and server messages are marked uiText, with the same sentence on the page and the server', () => {
    for (const [file, ids] of Object.entries(MARKED)) {
        const source = read(file);
        for (const id of ids) assert.ok(source.includes(`uiText('${escapeQuote(WORDING[id])}')`), `${file} does not mark ${id}`);
    }
    assert.ok(read('public/scripts/prompt-media-policy.js').includes('import { uiText } from \'./ui-text.js\';'));
    assert.ok(read('public/scripts/neconyan-conversation/prompt-media.js').includes('import { uiText } from \'../ui-text.js\';'));
    for (const file of ['src/generation/world-info.js', 'src/generation/roleplay-execution.js', 'src/generation/roleplay-prompt.js', 'src/endpoints/roleplay.js']) {
        assert.ok(read(file).includes('import { uiText } from \'../../public/scripts/ui-text.js\';'), file);
    }
    assert.ok(read('src/managed-image-files.js').includes('import { uiText } from \'../public/scripts/ui-text.js\';'));
});

test('the review dialogs look their choice names up by scoped key and mark them final', () => {
    const source = read('public/scripts/prompt-media-ui.js');
    for (const [key, english] of [['QIG-03', 'Send the image'], ['QIG-02', 'Show only'], ['QIG-04', 'Use a description']]) {
        assert.ok(source.includes(`translate('${english}', 'scoped.prompt_media.${key}')`), key);
    }
    // E2 (RVW-47): the removal name is looked up by its key as well, so no name is left out. That every option is final after its lookup is a
    // behaviour, and prompt-media-review-dialog.test.js checks it on the options the dialog builds.
    assert.ok(source.includes('translate(\'Remove from message\', \'scoped.prompt_media.RVW-47\')'), 'the removal name is looked up by its scoped key');
    assert.equal(source.split('select.append(choiceOption(mode))').length - 1, 2, 'both dialogs build their options the same way');
    for (const id of ['RVW-04', 'RVW-05', 'RVW-06', 'RVW-07', 'RVW-23', 'RVW-24', 'CNV-05']) {
        assert.ok(source.includes(`t\`${WORDING[id]}\``), `prompt-media-ui.js does not say ${id}`);
    }
    assert.equal(source.split(`t\`${WORDING['RVW-04']}\``).length - 1, 2, 'the account checkbox reads the same in both dialogs');
    assert.equal(source.split(`t\`${WORDING['RVW-06']}\``).length - 1, 2, 'the account note reads the same in both dialogs');
});

// What each replaced sentence said before. None may remain in the files this stage changed. A short label is matched as a whole
// quoted string, because its words legitimately appear inside other sentences.
const E1_FILES = ['public/index.html', 'public/scripts/extensions/caption/settings.html', 'public/scripts/extensions/quick-image-gen/index.js',
    'public/scripts/chats.js', 'public/scripts/prompt-media-ui.js', 'public/scripts/prompt-media-client.js', 'public/scripts/prompt-media-policy.js',
    'public/scripts/neconyan-conversation/prompt-media.js', 'src/generation/roleplay-execution.js', 'src/generation/roleplay-prompt.js',
    'src/generation/world-info.js', 'src/endpoints/roleplay.js', 'src/managed-image-files.js'];
const REPLACED = [
    'Keep chat images display-only', 'Keep image files and attachment descriptions out of new automatic replies', 'Review image input and repairs',
    'Describe image using the selected caption service', 'Manually describing an image sends it to the caption service selected below',
    'Use in future chat replies', 'Use the generation prompt as a description', 'Show only keeps the picture visible without sending its file',
    'Effective input: Show only', 'Image files are disabled by the connection.', 'Individual image choices apply.', 'Library images in future chat replies',
    'Use its saved description', 'This app version cannot preserve image input choices', 'Choose Show only or add a description first',
    'The generated image remains in the gallery. Choose Show only or Use a description to insert it.', 'Failed to insert image: ',
    'This image needs a compatible prompt copy.', 'The image insertion account changed.', 'qigToast.warning(`Context Media: ',
    'The chat or image changed. Open the attachment again.', 'have different attachments. Reload the chat before removing an image.',
    'The attachment removal could not be saved.', 'Attachment removed. Its saved copy is kept', 'Attachment removed, but its saved file could not be deleted.',
    'Review the saved image input choice.', 'Review this image\'s saved input choice.', 'This image changed. Choose how to use it in replies again.',
    'Review this image\'s saved prompt copy.', 'Review this image prompt copy before using it.', 'Choose a saved description or enter one.',
    'Choose a description of at most 16 KiB.', 'Review this message\'s image attachments.', 'Review this message\'s older image attachment.',
    'This image input version is unsupported.', 'Review the saved image input settings.', 'Choose list or gallery for this message.',
    'Choose a remaining image in this gallery.', 'Remove or replace this malformed attachment.', 'Choose up to four images for this reply or use a gallery.',
    'These saved Roleplay images need a bound vision connection or saved captions.', 'The saved image description evidence changed.',
    'Save a compatible prompt copy before sending this image.', 'This external image needs an explicitly saved prompt copy.',
    'Reload before checking saved image copies.', 'The image input account changed.', 'Review saved image copies before sending them.',
    'Review this message\'s saved attachment text before using Show only.', 'Review this message\'s attachment text.', 'Review the quoted attachment text.',
    'The saved prompt copy changed or is missing.', 'The original image changed or is missing. Review its saved prompt copy.',
    'Keep images display-only in this chat', 'Keep images display-only across this account', 'The account setting keeps these images display-only',
    'Keep selected chats display-only', 'The image preference was not saved.', 'Keep images display-only in this Conversation branch',
    'The account setting overrides individual image choices.',
    'Review image input choices to keep pictures display-only, use a description, or prepare a compatible copy.',
    'while the image was being inserted, so it was not inserted. It stays in the gallery.',
    // QIG-19 repeated the insertion failure under a toast that already says so (reworded 16 October).
    'The image cannot be sent as it is, so it was not inserted.', 'The library image cannot be sent as it is, so it was not inserted.',
    // The shared refusal notice, QIG-05 and GEN-CV3 were reworded on 16 October (Peter's final wording), and so was NTC-01.
    'Open Review chat images to choose Show only, Use a description, or a compatible copy.', 'that always wins.',
    'A reply quotes an image\'s description, and the quote cannot be checked against its original message.',
    'is no longer available. Its image review cannot be opened.',
];
const REPLACED_WHOLE = ['Attachment kept', 'The account changed.', 'Image input needs attention', 'Reload the page, then try again.', 'An image needs your choice'];

test('none of the replaced wording remains in the files this stage changed', () => {
    for (const file of E1_FILES) {
        const source = read(file).split('\\\'').join('\'');
        for (const old of REPLACED) assert.ok(!source.includes(old), `${file} still says: ${old}`);
        for (const old of REPLACED_WHOLE) {
            for (const quote of ['\'', '"', '`']) assert.ok(!source.includes(`${quote}${old}${quote}`), `${file} still says: ${old}`);
        }
    }
});

test('a Quick Image Gen toast can be marked final, and an ordinary toast is left as it was', () => {
    const marks = [], calls = [];
    const toastr = { error: (message, title, options) => {
        calls.push([message, title, options]);
        return { find: selector => ({ attr: (name, value) => marks.push([selector, name, value]) }) };
    } };
    const notifier = createNotifier({ getToastr: () => toastr, log: () => {} });
    assert.equal(notifier.error('Plain', '', {}), true);
    assert.deepEqual(marks, []);
    assert.equal(notifier.error('Whole sentence', 'Title', { finalText: true, timeOut: 5 }), true);
    assert.deepEqual(marks, [['.toast-message', 'data-i18n-ignore', '']]);
    // The option is for this notifier only; toastr receives the rest.
    assert.deepEqual(calls[1], ['Whole sentence', 'Title', { escapeHtml: true, timeOut: 5 }]);
    // A toast that toastr does not return (a duplicate) is still reported as shown, with nothing to mark.
    assert.equal(createNotifier({ getToastr: () => ({ error: () => undefined }) }).error('Again', '', { finalText: true }), true);
});
