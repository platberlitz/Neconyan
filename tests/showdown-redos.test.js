/* global globalThis */
import { describe, expect, jest, test } from '@jest/globals';
import { addShowdownPatch } from '../public/scripts/util/showdown-patch.js';

globalThis.window ??= globalThis;
globalThis.document ??= { createElement: () => ({}) };

await jest.unstable_mockModule('slidetoggle', () => ({ toggle: () => {} }));
const { showdown, initLibraryShims } = await import('../public/lib.js');

function createConverter(overrides = {}) {
    return new showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        simplifiedAutoLink: false,
        strikethrough: true,
        tables: true,
        simpleLineBreaks: true,
        openLinksInNewWindow: true,
        ...overrides,
    });
}

describe('Showdown shared parser ReDoS mitigation and Markdown compatibility', () => {
    test('completes adversarial link, image, tag attribute, and reference definition inputs within 50ms each', () => {
        const converter = createConverter();
        converter.makeHtml('warmup');

        const distinctUnusedDefs = Array.from({ length: 1500 }, (_, i) => `[id${i}]: https://example.com/${i}`).join('\n');

        const cases = [
            ['auditor parens payload', '[a](' + '()'.repeat(1000) + ' '],
            ['GHSA-rmmh-p597-ppvv unclosed brackets', '['.repeat(10000)],
            ['GHSA-rmmh-p597-ppvv nested unclosed brackets', '[[a]'.repeat(4000)],
            ['inline link single closing parenthesis between open parens', '[a](' + '('.repeat(4000) + ')' + '('.repeat(4000) + ' '],
            ['inline image single closing parenthesis between open parens', '![a](' + '('.repeat(4000) + ')' + '('.repeat(4000) + ' '],
            ['repeated single-quoted unclosed link titles', '[a](u \'a'.repeat(2000)],
            ['angle-bracket link with repeated paren-quote pairs', '[a](<' + '(\''.repeat(4000) + '>)'],
            ['repeated incomplete base64 image prefixes', '![a](data:a/'.repeat(2000)],
            ['repeated unclosed reference link definition lines', '\n[a'.repeat(2000)],
            ['incomplete base64 reference link definition reaching callback', '[id]\n[id]: data:' + 'a/'.repeat(4000)],
            ['stripLinkDefinitions adjacent horizontal whitespace', '[a]:' + ' '.repeat(600) + 'u' + ' '.repeat(600) + 'x\n'],
            ['stripLinkDefinitions ambiguous title quotes', '[a]: u' + ' '.repeat(600) + '"' + '"'.repeat(600) + 'x\n'],
            ['stripLinkDefinitions base64 ambiguous title quotes', '[a]: data:a/b;base64,AA' + ' '.repeat(600) + '"' + '"'.repeat(600) + 'x\n'],
            ['stripLinkDefinitions trailing double closing angle brackets', '[a]: ' + '"'.repeat(2000) + '>>\n'],
            ['stripLinkDefinitions repeated identical reference definitions', '[a]: u\n'.repeat(1500)],
            ['stripLinkDefinitions repeated distinct unused reference definitions', distinctUnusedDefs],
            ['escapeSpecialCharsWithinTagAttributes repeated unclosed tags', '<a '.repeat(2000)],
            ['repeated unclosed angle-bracket link URLs', '[a](<u'.repeat(3000)],
        ];

        for (const [label, input] of cases) {
            const start = performance.now();
            const html = converter.makeHtml(input);
            const elapsedMs = performance.now() - start;
            expect({ label, type: typeof html }).toEqual({ label, type: 'string' });
            expect(elapsedMs).toBeLessThan(50);
        }

        const globals = {
            gUrls: {},
            gTitles: {},
            gDimensions: {},
            gHtmlSpans: [],
            converter: { _dispatch: (_name, value) => value },
        };
        const options = showdown.getDefaultOptions();
        for (const [subParserName, input] of [
            ['escapeSpecialCharsWithinTagAttributes', '<a' + ' '.repeat(5000)],
            ['stripLinkDefinitions', '[a]:' + ' '.repeat(2000) + 'u' + ' '.repeat(2000) + 'x\n'],
            ['stripLinkDefinitions', '[a]: u' + ' '.repeat(2000) + '"' + '"'.repeat(2000) + 'x\n'],
            ['stripLinkDefinitions', '[a]: data:a/b;base64,AA' + ' '.repeat(2000) + '"' + '"'.repeat(2000) + 'x\n'],
        ]) {
            const start = performance.now();
            const out = showdown.subParser(subParserName)(input, options, globals);
            expect(typeof out).toBe('string');
            expect(performance.now() - start).toBeLessThan(50);
        }
    });

    test('preserves valid Markdown links, titles, escapes, nested parentheses, images, tag attributes, and reference links', () => {
        initLibraryShims();
        addShowdownPatch(showdown);
        const converter = createConverter();

        expect(converter.makeHtml('[Example](https://example.com/path)'))
            .toBe('<p><a href="https://example.com/path" rel="noopener noreferrer" target="_blank">Example</a></p>');

        expect(converter.makeHtml('[Section](#overview)'))
            .toBe('<p><a href="#overview">Section</a></p>');

        expect(converter.makeHtml('[Double title](https://example.com "Bob\'s page")'))
            .toBe('<p><a href="https://example.com" title="Bob\'s page" rel="noopener noreferrer" target="_blank">Double title</a></p>');

        expect(converter.makeHtml('[Single title](https://example.com \'Say "hello"\')'))
            .toBe('<p><a href="https://example.com" title="Say &quot;hello&quot;" rel="noopener noreferrer" target="_blank">Single title</a></p>');

        expect(converter.makeHtml('[Escaped \\[brackets\\]](https://example.com/a\\(1\\)b)'))
            .toBe('<p><a href="https://example.com/a(1)b" rel="noopener noreferrer" target="_blank">Escaped [brackets]</a></p>');

        expect(converter.makeHtml('[One-level parens](./image/cat(1).png)'))
            .toBe('<p><a href="./image/cat(1).png" rel="noopener noreferrer" target="_blank">One-level parens</a></p>');

        expect(converter.makeHtml('[Multiple parens](https://example.com/a(1)/b(2))'))
            .toBe('<p><a href="https://example.com/a(1)/b(2)" rel="noopener noreferrer" target="_blank">Multiple parens</a></p>');

        expect(converter.makeHtml('[Nested parens](https://example.com/wiki/Foo_(bar_(baz)))'))
            .toBe('<p><a href="https://example.com/wiki/Foo_(bar_(baz))" rel="noopener noreferrer" target="_blank">Nested parens</a></p>');

        expect(converter.makeHtml('[Angle URL](<https://example.com/cat).png> "Angle title")'))
            .toBe('<p><a href="https://example.com/cat).png" title="Angle title" rel="noopener noreferrer" target="_blank">Angle URL</a></p>');

        expect(converter.makeHtml('[Empty angle](<> "Empty title")'))
            .toBe('<p><a href="" title="Empty title" rel="noopener noreferrer" target="_blank">Empty angle</a></p>');

        expect(converter.makeHtml('[Empty angle multi-space](<>  "Empty title")'))
            .toBe('<p><a href="" title="Empty title" rel="noopener noreferrer" target="_blank">Empty angle multi-space</a></p>');

        expect(converter.makeHtml('[Empty angle tab](<>\t"Empty title")'))
            .toBe('<p><a href="" title="Empty title" rel="noopener noreferrer" target="_blank">Empty angle tab</a></p>');

        expect(converter.makeHtml('[Empty angle trailing space](<> "Empty title" )'))
            .toBe('<p><a href="" title="Empty title" rel="noopener noreferrer" target="_blank">Empty angle trailing space</a></p>');

        expect(converter.makeHtml('[Untouched empty]()'))
            .toBe('<p>[Untouched empty]()</p>');

        expect(converter.makeHtml('[![Alt [tag]](https://example.com/img(1).png =120x* "Img title")](https://example.com/target(1) "Link title")'))
            .toBe('<p><a href="https://example.com/target(1)" title="Link title" rel="noopener noreferrer" target="_blank"><img src="https://example.com/img(1).png" alt="Alt [tag]" title="Img title" width="120" height="auto" /></a></p>');

        const b64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        expect(converter.makeHtml(`![Pixel](${b64} =16x16 'Pixel title')`))
            .toBe(`<p><img src="${b64}" alt="Pixel" title="Pixel title" width="16" height="16" /></p>`);

        expect(converter.makeHtml('<div data-x="`hello`" data-y="_ital_">text</div>'))
            .toBe('<div data-x="`hello`" data-y="_ital_">text</div>');

        const refMarkdown = [
            '[Full ref][Ref-ID]',
            '[Paren ref][Paren-ID]',
            '[Nextline ref][Next-ID]',
            '[Shortcut ref]',
            '![Ref image][Img-ID]',
            '![B64 image][B64-ID]',
            '',
            '[ref-id]: https://example.com/ref "Reference Title"',
            '[paren-id]: <https://example.com/paren> (Parenthesized Title)',
            '   [next-id]:',
            '   https://example.com/nextline',
            '   "Nextline Title"',
            '[shortcut ref]: https://example.com/shortcut \'Shortcut Title\'',
            '[img-id]: https://example.com/pic(1).png =64x48 "Image Ref Title"',
            '[b64-id]: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC',
            'AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII= =8x8 "Multiline B64"',
            '',
            '[unused-only-once]: https://example.com/unused',
        ].join('\n');
        const refHtml = converter.makeHtml(refMarkdown);
        expect(refHtml).toContain('<a href="https://example.com/ref" title="Reference Title" rel="noopener noreferrer" target="_blank">Full ref</a>');
        expect(refHtml).toContain('<a href="https://example.com/paren" title="Parenthesized Title" rel="noopener noreferrer" target="_blank">Paren ref</a>');
        expect(refHtml).toContain('<a href="https://example.com/nextline" title="Nextline Title" rel="noopener noreferrer" target="_blank">Nextline ref</a>');
        expect(refHtml).toContain('<a href="https://example.com/shortcut" title="Shortcut Title" rel="noopener noreferrer" target="_blank">Shortcut ref</a>');
        expect(refHtml).toContain('<img src="https://example.com/pic(1).png" alt="Ref image" title="Image Ref Title" width="64" height="48" />');
        expect(refHtml).toContain(`<img src="${b64}" alt="B64 image" title="Multiline B64" width="8" height="8" />`);
        expect(refHtml).toContain('[unused-only-once]:');
    });
});
