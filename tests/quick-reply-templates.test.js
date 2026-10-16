import { describe, expect, test } from '@jest/globals';

import {
    DEFAULT_CUSTOM_SET_NAME,
    QUICK_REPLY_MODES,
    QUICK_REPLY_TEMPLATES,
    buildQuickReplyMessage,
    escapeEmbeddedCommandText,
    escapeQuickReplyCommandText,
    getQuickReplyTemplate,
    getUniqueQuickReplySetName,
} from '../public/scripts/extensions/quick-reply/src/quick-reply-templates.js';

describe('buildQuickReplyMessage', () => {
    test('send passes the text through, moving a leading slash out of command range', () => {
        expect(buildQuickReplyMessage('send', 'Hello there!')).toBe('Hello there!');
        expect(buildQuickReplyMessage('send', '/not-a-command')).toBe(' /not-a-command');
    });

    test('unknown modes behave like send', () => {
        expect(buildQuickReplyMessage('nonsense', 'Hello')).toBe('Hello');
    });

    test('box puts the text in the message box with macros intact', () => {
        expect(buildQuickReplyMessage('box', '*{{input}}*')).toBe('/setinput *{{input}}*');
        expect(buildQuickReplyMessage('box', '(OOC: {{input}})')).toBe('/setinput (OOC: {{input}})');
    });

    test('box keeps surrounding quotes by quoting and escaping its value', () => {
        // Verified against the live slash command parser: a value starting with a quote loses it, so it is quoted.
        expect(buildQuickReplyMessage('box', '"{{input}}"')).toBe('/setinput "\\"{{input}}\\""');
    });

    test('pipes and script markers in the text cannot split the command', () => {
        expect(buildQuickReplyMessage('box', 'a | b')).toBe('/setinput a \\| b');
        expect(buildQuickReplyMessage('box', 'a {: b')).toBe('/setinput a \\{: b');
    });

    test('direct steers the next reply with a one-off system note, then triggers a reply', () => {
        const message = buildQuickReplyMessage('direct', 'Make it eerie.');
        expect(message).toBe([
            '/inject id=quick-reply-direction position=chat depth=0 role=system ephemeral=true [Direction for the next reply only: Make it eerie.]',
            '/getinput',
            '/if left={{pipe}} rule=neq right="" {: /send {{input}} | /setinput "" :}',
            '/trigger',
        ].join(' | '));
    });

    test('direct keeps anything already typed by sending it before the reply', () => {
        const message = buildQuickReplyMessage('direct', 'Make it eerie.');
        expect(message).toContain('/getinput | /if left={{pipe}} rule=neq right="" {: /send {{input}}');
        expect(message.endsWith('/trigger')).toBe(true);
    });

    test('direct escapes pipes inside the note', () => {
        const message = buildQuickReplyMessage('direct', 'Make it eerie | quiet');
        const segments = message.split(' | ');
        expect(segments[0]).toContain('[Direction for the next reply only: Make it eerie \\| quiet]');
        expect(segments[1]).toBe('/getinput');
    });

    test('direct keeps a note that starts with a quote exactly as typed', () => {
        // The note sits mid-value, so quoting it would leave quotes and backslashes in the injected text.
        const message = buildQuickReplyMessage('direct', '"Run!" she shouts. Make it tense.');
        expect(message.split(' | ')[0])
            .toContain('[Direction for the next reply only: "Run!" she shouts. Make it tense.]');
        expect(message).not.toContain('\\"');
    });

    test('ask shows the answer in a pop-up that keeps line breaks, and stays quiet when there is none', () => {
        expect(buildQuickReplyMessage('ask', 'Sum up the story.'))
            .toBe('/gen Sum up the story. | /if left={{pipe}} rule=neq right="" {: /popup <div style="white-space: pre-wrap; text-align: start">{{pipe}}</div> :}');
    });

    test('command passes the text through untouched', () => {
        expect(buildQuickReplyMessage('command', '/continue')).toBe('/continue');
        expect(buildQuickReplyMessage('command', '/bgcol | /hide')).toBe('/bgcol | /hide');
    });

    test('text is trimmed, and a missing text becomes an empty message', () => {
        expect(buildQuickReplyMessage('send', '  hello  ')).toBe('hello');
        expect(buildQuickReplyMessage('send', undefined)).toBe('');
        expect(buildQuickReplyMessage('box', undefined)).toBe('/setinput ');
    });
});

describe('escapeQuickReplyCommandText', () => {
    test('leaves ordinary text alone', () => {
        expect(escapeQuickReplyCommandText('Just words')).toBe('Just words');
        expect(escapeQuickReplyCommandText('a\\b')).toBe('a\\b');
    });

    test('escapes pipes and script openers', () => {
        expect(escapeQuickReplyCommandText('a|b')).toBe('a\\|b');
        expect(escapeQuickReplyCommandText('{: /hide :}')).toBe('\\{: /hide :}');
    });

    test('quotes a value that starts with a quote', () => {
        expect(escapeQuickReplyCommandText('"hello"')).toBe('"\\"hello\\""');
        expect(escapeQuickReplyCommandText('"a" | "b"')).toBe('"\\"a\\" | \\"b\\""');
    });
});

describe('escapeEmbeddedCommandText', () => {
    test('escapes pipes and script openers but never quotes', () => {
        expect(escapeEmbeddedCommandText('"a" | {: b')).toBe('"a" \\| \\{: b');
        expect(escapeEmbeddedCommandText(undefined)).toBe('');
    });
});

describe('getUniqueQuickReplySetName', () => {
    test('keeps the name when it is free', () => {
        expect(getUniqueQuickReplySetName('My quick replies', [])).toBe('My quick replies');
        expect(getUniqueQuickReplySetName('My quick replies', ['Default'])).toBe('My quick replies');
    });

    test('numbers a name that is taken, ignoring case and spacing', () => {
        expect(getUniqueQuickReplySetName('Reply directions', ['reply directions'])).toBe('Reply directions 2');
        expect(getUniqueQuickReplySetName('Reply directions', ['Reply directions', 'Reply directions 2'])).toBe('Reply directions 3');
        expect(getUniqueQuickReplySetName('Reply directions', [' Reply directions '])).toBe('Reply directions 2');
    });

    test('fills the lowest free number', () => {
        expect(getUniqueQuickReplySetName('Story controls', ['Story controls', 'Story controls 3'])).toBe('Story controls 2');
    });

    test('falls back to the default name for an empty base', () => {
        expect(getUniqueQuickReplySetName('', [])).toBe(DEFAULT_CUSTOM_SET_NAME);
        expect(getUniqueQuickReplySetName(undefined, [DEFAULT_CUSTOM_SET_NAME])).toBe(`${DEFAULT_CUSTOM_SET_NAME} 2`);
    });
});

describe('ready-made templates', () => {
    test('every mode is described well enough to show in the builder', () => {
        expect(QUICK_REPLY_MODES.length).toBeGreaterThan(0);
        for (const mode of QUICK_REPLY_MODES) {
            expect(mode.id).toBeTruthy();
            expect(mode.label).toBeTruthy();
            expect(mode.hint).toBeTruthy();
            expect(typeof mode.placeholder).toBe('string');
        }
        expect(new Set(QUICK_REPLY_MODES.map(mode => mode.id)).size).toBe(QUICK_REPLY_MODES.length);
    });

    test('every template is a complete, usable set of buttons', () => {
        expect(QUICK_REPLY_TEMPLATES.length).toBeGreaterThan(0);
        for (const template of QUICK_REPLY_TEMPLATES) {
            expect(template.id).toBeTruthy();
            expect(template.name).toBeTruthy();
            expect(template.icon).toMatch(/^fa-/);
            expect(template.description).toBeTruthy();
            expect(template.replies.length).toBeGreaterThan(0);
            for (const reply of template.replies) {
                expect(reply.label).toBeTruthy();
                expect(reply.icon).toMatch(/^fa-/);
                expect(reply.title).toBeTruthy();
                expect(reply.message).toBeTruthy();
            }
        }
        expect(new Set(QUICK_REPLY_TEMPLATES.map(template => template.id)).size).toBe(QUICK_REPLY_TEMPLATES.length);
        expect(new Set(QUICK_REPLY_TEMPLATES.map(template => template.name)).size).toBe(QUICK_REPLY_TEMPLATES.length);
    });

    test('looks up a template by id', () => {
        expect(getQuickReplyTemplate('reply-directions')?.name).toBe('Reply directions');
        expect(getQuickReplyTemplate('nope')).toBeUndefined();
    });

    test('the direction template drives the next reply without touching the chat', () => {
        const template = getQuickReplyTemplate('reply-directions');
        for (const reply of template.replies) {
            expect(reply.message).toContain('/inject id=quick-reply-direction');
            expect(reply.message).toContain('ephemeral=true');
            expect(reply.message.endsWith('/trigger')).toBe(true);
        }
    });

    test('the writing helpers keep what was typed and wrap it', () => {
        const helpers = getQuickReplyTemplate('writing-helpers');
        for (const reply of helpers.replies) {
            expect(reply.message.startsWith('/setinput ')).toBe(true);
            expect(reply.message).toContain('{{input}}');
        }
    });

    test('the story controls use plain commands', () => {
        const controls = getQuickReplyTemplate('story-controls');
        for (const reply of controls.replies) {
            expect(reply.message.startsWith('/')).toBe(true);
            expect(reply.message).not.toContain(' | ');
        }
    });

    test('the private questions ask in a pop-up and stay quiet when the answer is empty', () => {
        const template = getQuickReplyTemplate('private-help');
        for (const reply of template.replies) {
            expect(reply.message.startsWith('/gen ')).toBe(true);
            expect(reply.message).toContain('{{pipe}}</div> :}');
        }
    });
});
