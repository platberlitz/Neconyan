/* eslint playwright/expect-expect: off -- Source, builder and catalogue checks with Node assertions; no browser. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

// Wording and keys of the image review dialogs (E2-D). The key lists are the ledger's key plan for the dialog rows: each English sentence is its
// own key, except the short labels and the sentences with a hole, which have scoped keys that only an explicit lookup reaches. A changed word
// is a changed key, and a translator then has to start again, so the lists are pinned whole.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const EXACT = [
    ['RVW-11', 'Choose what the model receives from each image when it writes new replies. Show only keeps an image in the chat but sends the model neither the image nor its saved description.'],
    ['RVW-12', 'What these choices do not change'],
    ['RVW-13', 'These choices do not change message text, descriptions already copied into it, or saved memories.'],
    ['RVW-13', 'Replies that are already being written keep the images they started with. Press Stop to cancel one.'],
    ['RVW-13', 'Using the caption service to describe an image, and reference images you give a tool, still send the image when you use them.'],
    ['RVW-13', 'Other extensions may send images by their own rules.'],
    ['RVW-15', 'Saved. Change history keeps a backup of the chat from before this change: you can download it, or undo the change while the chat stays unchanged.'],
    ['RVW-20', 'No chat is open. Choose chats to review, or change the setting for all chats above.'],
    ['RVW-21', 'You switched accounts. Close this window and open it again.'],
    ['RVW-22', 'That did not finish. Try again.'],
    ['RVW-32', 'Only the first 10,000 are listed.'],
    ['RVW-33', 'Listing does not download anything from websites.'],
    ['RVW-34', 'Show only does not change text: a message\'s own title, descriptions already copied into the message and saved memories are used as before.'],
    ['RVW-34', 'To send an image, use Chat Completion with \'Send inline media\' turned on, and a model that can see images.'],
    ['RVW-36', 'Saved on this server'],
    ['RVW-36', 'Missing: its file is no longer on the server'],
    ['RVW-36', 'Needs a compatible copy: unsupported format, or larger than 2048 pixels'],
    ['RVW-36', 'Needs a compatible copy: larger than 1 MiB, or unreadable'],
    ['RVW-36', 'Stored inside the chat file'],
    ['RVW-36', 'Linked from a website or an old location'],
    ['RVW-36', 'The gallery\'s chosen image is missing'],
    ['RVW-37', 'Audio and video are not changed here.'],
    ['RVW-38', 'What the model receives from this image'],
    ['RVW-39', 'Where the description comes from'],
    ['RVW-41', 'The image\'s saved description'],
    ['RVW-42', 'The message\'s saved title'],
    ['RVW-57', 'The saved description source for this image is empty or longer than 16 KiB, so it cannot be used. To use a description, choose another source or type one, then save.'],
    ['RVW-58', 'The image\'s saved description (no longer available)'],
    ['RVW-59', 'The message\'s saved title (no longer available)'],
    ['RVW-43', 'An image\'s saved description comes from the caption service, from the prompt that made it, or from the image library.'],
    ['RVW-44', 'Type the description the model receives'],
    ['RVW-48', 'Remove this image from the message?'],
    ['RVW-49', 'Its file stays on the server. You can undo this in Change history while the chat stays unchanged.'],
    ['RVW-50', 'Save choices for selected images'],
    ['RVW-51', 'Select at least one image.'],
    ['RVW-52', 'Remove the selected images from their messages?'],
    ['RVW-53', 'Their files stay on the server.'],
    ['RVW-56', 'The open chat could not be saved, so its images cannot be listed yet. Try again in a moment.'],
    ['CPY-01', 'Save a copy as it is'],
    ['CPY-02', 'Prepare a converted copy'],
    ['CPY-03', 'Or choose an image file to use as the compatible copy'],
    ['CPY-05', 'Also show this copy in the chat instead of the original'],
    ['CPY-06', 'Unless you tick the box above, the chat keeps showing the original image.'],
    ['CPY-07', 'Save this compatible copy?'],
    ['CPY-09', 'Show the compatible copy in the chat'],
    ['CPY-10', 'Show the compatible copy instead of the original?'],
    ['CPY-11', 'The copy replaces the image shown in the chat. Your choices for what the model receives still apply. The original file stays on the server. You can undo this in Change history while the chat stays unchanged.'],
    ['CPY-12', 'Make this the gallery\'s chosen image'],
    ['CPY-13', 'Use the copy already on this server'],
    ['CPY-14', 'Use the image already on this server?'],
    ['CPY-16', 'Save copies of selected images'],
    ['CPY-16', 'Only images stored in the chat.'],
    ['CPY-17', 'Select only images stored in the chat. Other images need a converted copy, prepared one at a time.'],
    ['CPY-18', 'Select at least one image stored in the chat.'],
    ['CPY-19', 'To remove the image, use Save choice. To prepare a copy, first choose Send the image, Show only or Use a description.'],
    ['CPY-20', 'This image stored in the chat cannot be converted here. Choose an image file instead.'],
    ['CPY-21', 'Download this image from its website?'],
    ['CPY-22', 'Your browser fetches it directly, without your sign-in details or the address of this page. If the website refuses, choose an image file instead.'],
    ['CPY-23', 'Choose an image smaller than 16 MiB.'],
    ['CPY-24', 'Converting took longer than 15 seconds. Choose a smaller image.'],
    ['CPY-25', 'This browser could not convert the image. Choose a PNG, JPEG or WebP file instead.'],
    ['CPY-26', 'Only ordinary web links (http or https) can be downloaded. Choose an image file instead.'],
    ['CPY-27', 'The image could not be downloaded from its website, or is larger than 16 MiB. Choose an image file instead.'],
    ['CPY-28', 'The image on the website is larger than 16 MiB. Choose an image file instead.'],
    ['CPY-30', 'Animated images cannot be converted. Choose a still image.'],
    ['CPY-31', 'This PNG file is incomplete. Choose another image.'],
    ['CPY-32', 'This WebP file is incomplete. Choose another image.'],
    ['CPY-34', 'This JPEG file is damaged. Choose another image.'],
    ['CPY-35', 'This JPEG file is incomplete. Choose another image.'],
    ['CPY-36', 'Choose a PNG, JPEG or WebP still image of at most 16 million pixels.'],
    ['CPY-37', 'This image has more than 16 million pixels. Choose a smaller one.'],
    ['CPY-38', 'Even converted, this image is larger than 1 MiB. Choose a smaller one.'],
    ['CPY-39', 'The converted image is too large. Choose a smaller one.'],
    ['BAT-02', 'Each chat is changed and backed up separately. If one chat fails, the others keep their changes.'],
    ['BAT-05', 'Select at least one chat.'],
    ['BAT-06', 'Stop sending images in the selected chats?'],
    ['BAT-08', 'The open chat could not be saved.'],
    ['BAT-09', 'No images stored in the chat'],
    ['BAT-10', 'Save copies in selected chats'],
    ['BAT-11', 'Save copies of images stored in the selected chats?'],
    ['BAT-12', 'Images stored inside each chat file are saved as compatible copies, as they are. The chat keeps showing the originals, and your choices are kept. Each chat is backed up separately. A chat with more than 128 such images, or with images that need converting, must be reviewed on its own.'],
    ['BAT-13', 'This chat has too many attachments to change with others. Review it on its own.'],
    ['BAT-14', 'This chat has more than 128 images stored in it. Review it on its own and select fewer at a time.'],
    ['HIS-02', 'Prepared, not applied yet'],
    ['HIS-02', 'Interrupted while saving the chat'],
    ['HIS-02', 'Preparation did not finish'],
    ['HIS-04', 'Change finished. Reopen the chat to see it.'],
    ['HIS-06', 'Discard this unfinished change?'],
    ['HIS-07', 'Its preparation files are deleted; anything unexpected is kept. Your chat and its images are not changed. You can make the change again afterwards.'],
    ['HIS-12', 'The chat goes back to how it was before this change. This works only if the chat has not changed since. Images that were missing stay missing.'],
    ['HIS-16', 'You will no longer be able to undo this change. Image files, including compatible copies, are kept. Download the backup first if you might need it.'],
    ['CNV-01', 'Open a Conversation chat to review its images.'],
    ['CNV-03', 'Choose what the model receives from each image when it writes new replies. Show only keeps an image in the Conversation but sends the model neither the image nor its saved description. It does not change message text or saved memories.'],
    ['CNV-07', 'This Conversation changed. Close this window and open it again.'],
    ['CNV-08', 'This message changed. Close this window and open it again.'],
    ['CNV-09', 'Wait for the current choice to finish saving.'],
    ['CNV-10', 'Earlier Conversation changes could not be saved, so this choice was not saved. Try again.'],
    ['CNV-11', 'Your choice was not saved. Try again.'],
    ['CNV-15', 'Description sent to the model'],
    ['CNV-17', 'Type a description of up to 16 KiB.'],
    ['CNV-19', 'This older message saved image descriptions and file text together, so Show only cannot separate them. Choose what the model receives instead: your reviewed text, or nothing. Leaving it out also leaves out the file text. The message as shown is not changed.'],
    ['CNV-20', 'Text sent to the model instead'],
    ['CNV-21', 'Type the text the model receives instead'],
    ['CNV-22', 'This saved attachment text changed. Close this window and open it again.'],
    ['CNV-23', 'Keep the replacement text to at most 16 KiB.'],
    ['CNV-26', 'Leave out the saved attachment text?'],
    ['CNV-27', 'The file text saved with it is left out too. What was written in the message is not changed.'],
    ['CNV-29', 'This reply contains a quote. If your image settings require a review and the quote cannot be checked against its original message, the model receives what you choose here instead of the quote: your reviewed text, or nothing. The message as shown is not changed.'],
    // CNV-30 is CNV-08 again (the existing key); a quote-only row reuses it for the 'changed' error.
    ['CNV-31', 'Leave out the quote?'],
    ['CNV-32', 'If your image settings require a review and the quote cannot be checked against its original message, the model receives this reply without the quote. What was written in the message is not changed.'],
    ['INT-01', 'Neconyan stopped because its saved change records are not as expected. Some steps may already have completed and have not been reversed. Check Change history before trying again, and show the details below to whoever runs this server.'],
];
const SCOPED = {
    'scoped.prompt_media.RVW-10': 'Chat images',
    'scoped.prompt_media.RVW-14': 'Working…',
    'scoped.prompt_media.RVW-17': 'Choose chats',
    'scoped.prompt_media.RVW-18': 'Change history',
    'scoped.prompt_media.RVW-31': 'Attachments found: ${0}',
    'scoped.prompt_media.RVW-35.1': 'Message ${0}, image ${1}',
    'scoped.prompt_media.RVW-35.2': 'Message ${0}, alternative ${1}, image ${2}',
    'scoped.prompt_media.RVW-35.3': 'Message ${0}, attachment list',
    'scoped.prompt_media.RVW-35.4': 'Message ${0}, alternative ${1}, attachment list',
    'scoped.prompt_media.RVW-36.8': 'Damaged attachment',
    'scoped.prompt_media.RVW-36.9': 'Empty attachment list',
    'scoped.prompt_media.RVW-36.10': 'Audio or video',
    'scoped.prompt_media.RVW-40': 'Type a description',
    'scoped.prompt_media.RVW-45': 'Select this image',
    'scoped.prompt_media.RVW-46': 'Save choice',
    'scoped.prompt_media.RVW-47': 'Remove from message',
    'scoped.prompt_media.RVW-54': 'Images listed.',
    'scoped.prompt_media.RVW-55': 'More images',
    'scoped.prompt_media.CPY-04': 'Prepared compatible copy',
    'scoped.prompt_media.CPY-08': 'Save copy',
    'scoped.prompt_media.CPY-15': 'The message will point to ${0} instead of its full web address. The server first checks that this file exists in your account and is compatible.',
    'scoped.prompt_media.BAT-07': 'Chats selected: ${0}. In new replies, the model will receive neither their images nor the images\' saved descriptions. You can turn this off again for each chat.',
    'scoped.prompt_media.BAT-09.3': 'Compatible copies saved: ${0}',
    'scoped.prompt_media.BAT-15': 'More chats',
    'scoped.prompt_media.HIS-01': 'Unfinished change',
    'scoped.prompt_media.HIS-02.1': 'Completed',
    'scoped.prompt_media.HIS-02.2': 'Completed, backup deleted',
    'scoped.prompt_media.HIS-02.6': 'Discarded',
    'scoped.prompt_media.HIS-03': 'Finish this change',
    'scoped.prompt_media.HIS-05': 'Discard unfinished change',
    'scoped.prompt_media.HIS-08': 'Unfinished change discarded.',
    'scoped.prompt_media.HIS-09': 'Download backup',
    'scoped.prompt_media.HIS-10': 'Undo change',
    'scoped.prompt_media.HIS-11': 'Undo this change?',
    'scoped.prompt_media.HIS-13': 'Change undone.',
    'scoped.prompt_media.HIS-15': 'Delete this backup?',
    'scoped.prompt_media.CNV-02': 'Conversation images',
    'scoped.prompt_media.CNV-12': 'Choice saved.',
    'scoped.prompt_media.CNV-13.2': 'Message ${0}, generated image',
    'scoped.prompt_media.CNV-18': 'Message ${0}, saved attachment text',
    'scoped.prompt_media.CNV-24': 'Use this text',
    'scoped.prompt_media.CNV-25': 'Leave it out',
    'scoped.prompt_media.CNV-28': 'Message ${0}, quote from another message',
    'scoped.prompt_media.RVW-36.11': 'Saved description',
};
// Existing keys these dialogs share with other features (the meaning check is the translation Checker's). Group chat, Cancel and Import are existing keys these dialogs use as they are (Import is the file picker's button).
const SHARED = ['Current chat', 'Close', 'Review', 'Saved', 'Delete backup', 'More changes', 'Group chat', 'Cancel', 'Import'];

// The same two files hold E1's choice names and refusal sentences. They are E1's keys and are checked by tests/image-input-wording.node.js.
const E1_EXACT = [
    'Don\'t send chat images to the model', 'Don\'t send this chat\'s images to the model', 'Don\'t send this branch\'s images to the model',
    '\'Don\'t send chat images to the model\' is on for your account, so it applies here whatever you choose below.', 'Stop sending images in selected chats',
    'Your setting was not saved. Try again.', 'You switched accounts, so the setting was not saved.', 'Review needed before replying',
    'Open Review chat images to choose what the model receives.',
    // Stage 4d: why a notice cannot open its review (explainOrigin*).
    'The chat or branch this notice refers to could not be opened, so its image review is not available.',
    'This notice belongs to another account. Switch back to that account to review the image.',
    'This notice refers to a different branch. Switch back to that branch to review the image.',
];
const FILES = ['public/scripts/prompt-media-ui.js', 'public/scripts/prompt-media-labels.js'];
const parseFile = file => parse(read(file), { ecmaVersion: 'latest', sourceType: 'module' });
function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    callback(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => visit(child, callback));
        else if (value && typeof value === 'object') visit(value, callback);
    }
}
const collect = (file, type) => { const found = []; visit(parseFile(file), node => { if (node.type === type) found.push(node); }); return found; };
const calls = (file, name) => collect(file, 'CallExpression').filter(node => node.callee.name === name);
const literalText = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const taggedKey = node => node.quasi.quasis.map((part, index) => part.value.cooked + (index < node.quasi.expressions.length ? '${' + index + '}' : '')).join('');

test('the pinned key list is the whole list: 111 new exact keys and 44 scoped keys, none twice', () => {
    assert.equal(EXACT.length, 111);
    assert.equal(new Set(EXACT.map(([, key]) => key)).size, 111);
    assert.equal(Object.keys(SCOPED).length, 44);
    for (const key of Object.keys(SCOPED)) assert.match(key, /^scoped\.prompt_media\.[A-Z]+-\d+(?:\.\d+)?$/);
    for (const [, key] of EXACT) assert.ok(!key.startsWith('scoped.'), key);
});

test('every key is collected by the builder, and the fragment key it used to collect is not', () => {
    const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    const listed = new Set(JSON.parse(run.stdout));
    for (const [row, key] of EXACT) assert.ok(listed.has(key), `${row} is not collected: ${key}`);
    for (const key of Object.keys(SCOPED)) assert.ok(listed.has(key), `not collected: ${key}`);
    for (const key of SHARED) assert.ok(listed.has(key), `not collected: ${key}`);
    assert.ok(!listed.has('Message ${0}${1}${2}'), 'the adjacent-hole key is still collected');
    // The retired wording is no longer in the files that were changed.
    // The two long button labels of 18 October are gone too: each is now a short label with a line beneath it.
    for (const old of ['Images in replies', 'Recovery history', 'Detach this attachment?', 'Resume saved repair', 'Select for batch change', 'Review ready.', 'Next images',
        'Save copies of selected images stored in the chat', 'Save copies of images stored in selected chats']) {
        for (const file of FILES) assert.ok(!read(file).includes(old), `${file} still says: ${old}`);
    }
});

test('the dialogs look every scoped string up by its pinned key with its pinned English, and by nothing else', () => {
    const found = {};
    for (const file of FILES) {
        for (const call of calls(file, 'translate')) {
            if (call.arguments.length === 1) continue;
            const [english, key] = call.arguments.map(literalText);
            assert.ok(english !== null && key !== null, `${file}:${call.loc?.start.line}: translate() needs two literal arguments`);
            assert.match(key, /^scoped\.prompt_media\./, key);
            found[key] = english;
        }
    }
    // The three choice names and the refusal-free labels of stage 2 belong to E1.
    const own = Object.fromEntries(Object.entries(found).filter(([key]) => !/\.QIG-0[234]$/.test(key)));
    assert.deepEqual(own, SCOPED);
});

test('the dialogs build every exact string with t``, and use nothing else of the dictionary', () => {
    const used = new Set();
    for (const file of FILES) {
        for (const node of collect(file, 'TaggedTemplateExpression')) if (node.tag.name === 't') used.add(taggedKey(node));
    }
    for (const [row, key] of EXACT) assert.ok(used.has(key), `${row} is not built with t\`\`: ${key}`);
    for (const key of SHARED) assert.ok(used.has(key), `not built with t\`\`: ${key}`);
    const known = new Set([...EXACT.map(([, key]) => key), ...SHARED, ...E1_EXACT]);
    for (const key of used) assert.ok(known.has(key), `unexpected t\`\` string: ${key}`);
});

test('no sentence reaches the page unlooked-up: the builders of elements, buttons, confirmations, toasts and errors never take a literal', () => {
    const ui = 'public/scripts/prompt-media-ui.js';
    const words = value => typeof value === 'string' && /[A-Za-z]{2}/.test(value);
    for (const [name, positions] of [['element', [1]], ['button', [0]], ['checkbox', [0]], ['confirmChange', [0, 1]], ['toast', [1]], ['say', [0]], ['showFailure', [1]], ['buttonWithNote', [0, 1]]]) {
        for (const call of calls(ui, name)) {
            for (const position of positions) {
                const value = literalText(call.arguments[position]);
                if (value !== null && words(value)) assert.fail(`${ui}:${call.loc?.start.line}: ${name}() is given a literal: ${value}`);
            }
        }
    }
    for (const node of collect(ui, 'NewExpression').filter(node => node.callee.name === 'Error')) {
        assert.ok(node.arguments.every(argument => argument.type !== 'Literal' && argument.type !== 'TemplateLiteral'), `an Error is thrown with a literal at line ${node.loc?.start.line}`);
    }
    for (const call of collect(ui, 'CallExpression').filter(node => node.callee.property?.name === 'setAttribute')) {
        const [name, value] = call.arguments.map(literalText);
        if (['aria-label', 'placeholder', 'title', 'alt'].includes(name)) assert.equal(value, null, `${name} is set to a literal`);
    }
    for (const node of collect(ui, 'AssignmentExpression')) {
        const property = node.left.property?.name;
        if (['placeholder', 'alt', 'title'].includes(property)) assert.ok(!['Literal', 'TemplateLiteral'].includes(node.right.type) || !words(literalText(node.right)), `.${property} is set to a literal`);
    }
});

test('a server reason is looked up by its exact text only, once, where the error is made', () => {
    const source = read('public/scripts/prompt-media-ui.js');
    const lookups = calls('public/scripts/prompt-media-ui.js', 'translate').filter(call => call.arguments.length === 1);
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].arguments[0].name, 'reason');
    assert.ok(!/localizeMessage|localizeString/.test(source), 'a ${n} fallback is imported');
    assert.equal(calls('public/scripts/prompt-media-labels.js', 'translate').filter(call => call.arguments.length === 1).length, 0);
});

test('the legends are complete phrases: the fragment construction is gone', () => {
    for (const node of collect('public/scripts/prompt-media-ui.js', 'TemplateLiteral')) assert.ok(!/^Message /.test(node.quasis[0].value.cooked), 'a legend is built from fragments');
    const labels = read('public/scripts/prompt-media-labels.js');
    for (const phrase of ['Message ${0}, image ${1}', 'Message ${0}, alternative ${1}, image ${2}', 'Message ${0}, attachment list', 'Message ${0}, alternative ${1}, attachment list',
        'Message ${0}, generated image', 'Message ${0}, saved attachment text', 'Message ${0}, quote from another message']) assert.ok(labels.includes(`'${phrase}'`), phrase);
    assert.ok(!labels.includes('quoted image description'), 'the quote-only legend still names an image description');
});

test('the shared keys are in the catalogue already, with the English as their value', () => {
    const catalogue = JSON.parse(read('public/locales/neconyan/en.json'));
    for (const key of SHARED) assert.equal(catalogue[key], key);
});

// The wording of 16 October: the quote-only row has its own sentences, and the replaced ones are gone from the catalogue.
test('the quote-only keys are in the catalogue with their English, and the keys they replace are not', () => {
    const catalogue = JSON.parse(read('public/locales/neconyan/en.json'));
    for (const [row, key] of EXACT.filter(([row]) => ['CNV-29', 'CNV-31', 'CNV-32'].includes(row))) assert.equal(catalogue[key], key, row);
    assert.equal(catalogue['scoped.prompt_media.CNV-28'], 'Message ${0}, quote from another message');
    // CNV-30 is not a new key: the existing 'This message changed' sentence (CNV-08) is reused.
    assert.equal(catalogue['This message changed. Close this window and open it again.'], 'This message changed. Close this window and open it again.');
    for (const old of ['An image needs your choice', 'Open Review chat images to choose Show only, Use a description, or a compatible copy.', 'Message ${0}, quoted image description',
        'This reply quotes an image' + String.fromCharCode(39) + 's description, and the quote cannot be checked against its original message, so Show only cannot remove it on its own. Choose what the model receives instead: your reviewed text, or nothing. The message as shown is not changed.']) {
        assert.ok(!(old in catalogue), `the catalogue still has: ${old}`);
    }
    // Rows with saved attachment text keep their wording.
    for (const row of ['CNV-19', 'CNV-22', 'CNV-26', 'CNV-27']) assert.ok(EXACT.some(([id, key]) => id === row && catalogue[key] === key), row);
    assert.equal(catalogue['scoped.prompt_media.CNV-18'], 'Message ${0}, saved attachment text');
});

// The wording of 18 October: the two long Save copies buttons are a short label each, with one line beneath that serves both.
test('the two short Save copies labels and their line are in the catalogue with their English, and the two long labels they replace are not', () => {
    const catalogue = JSON.parse(read('public/locales/neconyan/en.json'));
    for (const key of ['Save copies of selected images', 'Save copies in selected chats', 'Only images stored in the chat.']) assert.equal(catalogue[key], key);
    for (const old of ['Save copies of selected images stored in the chat', 'Save copies of images stored in selected chats']) assert.ok(!(old in catalogue), `the catalogue still has: ${old}`);
});
