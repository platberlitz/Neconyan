import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { load } from 'cheerio';

// The helper looks the reason up through the page's exact translate(); a stand-in with a small dictionary shows when and on what.
const lookups = [];
const dictionary = new Map();
await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    translate: (text, key = null) => { lookups.push([text, key]); return dictionary.get(key || text) ?? text; },
}));

const { escapeToastText, twoLineToastHtml } = await import('../public/scripts/toast-lines.js');

// The toast puts this HTML on the page as it is (escapeHtml: false), so it is read back the way a browser would read it.
const page = html => load(`<div class="toast-message">${html}</div>`, null, false);

beforeEach(() => {
    lookups.length = 0;
    dictionary.clear();
});

describe('twoLineToastHtml', () => {
    test('shows the sentence, then the reason, on two lines', () => {
        const html = twoLineToastHtml('The image cannot be sent as it is.', 'The file is too large.');
        const $ = page(html);
        const message = $('.toast-message');
        expect(message.children('br')).toHaveLength(1);
        expect(message.contents().map((_, node) => node.type).get()).toEqual(['text', 'tag', 'tag']);
        expect(message.contents().first().text()).toBe('The image cannot be sent as it is.');
        expect(message.children('span').text()).toBe('The file is too large.');
        // The line break sits between them: the sentence cannot run into the reason.
        expect(html.indexOf('<br>')).toBeGreaterThan(html.indexOf('The image'));
        expect(html.indexOf('<br>')).toBeLessThan(html.indexOf('The file'));
    });

    test('reasonFirst puts the reason on the first line', () => {
        const message = page(twoLineToastHtml('Open Review chat images.', 'The file is too large.', { reasonFirst: true })).root().find('.toast-message');
        expect(message.contents().first().is('span')).toBe(true);
        expect(message.contents().first().text()).toBe('The file is too large.');
        expect(message.contents().last().text()).toBe('Open Review chat images.');
        expect(message.children('br')).toHaveLength(1);
    });

    test('a reason with markup shows literally and adds no element', () => {
        const reason = 'Bad <b>image</b> & "quoted" \'text\' <img src=x onerror=alert(1)>';
        for (const reasonFirst of [false, true]) {
            const html = twoLineToastHtml('Sentence.', reason, { reasonFirst });
            expect(html).not.toContain('<b>');
            expect(html).not.toContain('<img');
            const message = page(html).root().find('.toast-message');
            expect(message.find('b, img')).toHaveLength(0);
            expect(message.children().map((_, node) => node.tagName).get().sort()).toEqual(['br', 'span']);
            expect(message.children('span').text()).toBe(reason);
        }
    });

    test('the sentence is escaped too, and so is a translation of the reason', () => {
        dictionary.set('Hold on.', 'Espere <i>um momento</i> & tente de novo.');
        const message = page(twoLineToastHtml('Use <b>Show only</b> & go.', 'Hold on.')).root().find('.toast-message');
        expect(message.find('b, i')).toHaveLength(0);
        expect(message.contents().first().text()).toBe('Use <b>Show only</b> & go.');
        expect(message.children('span').text()).toBe('Espere <i>um momento</i> & tente de novo.');
    });

    test('the reason is looked up by its exact text, trimmed, and the sentence is not looked up at all', () => {
        dictionary.set('The file is too large.', 'O ficheiro é demasiado grande.');
        const html = twoLineToastHtml('Already translated sentence.', '  The file is too large.  ');
        expect(lookups).toEqual([['The file is too large.', null]]);
        expect(page(html).root().find('span').text()).toBe('O ficheiro é demasiado grande.');
        // No dictionary entry: the reason is shown as it came.
        expect(page(twoLineToastHtml('Sentence.', 'Unknown words.')).root().find('span').text()).toBe('Unknown words.');
    });

    test('the reason line is marked for the run-time localiser; the sentence line is not', () => {
        const message = page(twoLineToastHtml('Sentence.', 'Reason.')).root().find('.toast-message');
        expect(message.children('span').attr('data-i18n-ignore')).toBe('');
        expect(message.attr('data-i18n-ignore')).toBeUndefined();
        expect(message.contents().get(0).type).toBe('text');
    });

    test('with no reason there is one line and nothing is looked up', () => {
        for (const reason of [undefined, null, '', '   ']) {
            lookups.length = 0;
            const html = twoLineToastHtml('Only <the> sentence.', reason);
            expect(html).toBe('Only &lt;the&gt; sentence.');
            expect(lookups).toEqual([]);
        }
        expect(twoLineToastHtml('One line.', undefined, { reasonFirst: true })).toBe('One line.');
    });

    test('a newline inside the reason is kept as it came, on its own line only through the line break between the two', () => {
        const html = twoLineToastHtml('Sentence.', 'First part.\nSecond part.');
        expect(html.split('<br>')).toHaveLength(2);
        expect(page(html).root().find('span').text()).toBe('First part.\nSecond part.');
    });
});

describe('escapeToastText', () => {
    test('escapes the five characters that matter in markup and attributes, and nothing else', () => {
        expect(escapeToastText('<a href="x" title=\'y\'>&</a>')).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
        expect(escapeToastText('Plain words, 100% safe.')).toBe('Plain words, 100% safe.');
        expect(escapeToastText(undefined)).toBe('');
        expect(escapeToastText(null)).toBe('');
        expect(escapeToastText(42)).toBe('42');
    });
});
