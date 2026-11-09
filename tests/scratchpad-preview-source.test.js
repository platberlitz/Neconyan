import { describe, expect, test } from '@jest/globals';
import { previewForBlock, previewFromText, previewLanguage } from '../public/scripts/scratchpad/preview-source.js';

describe('Scratchpad static preview sources', () => {
    test.each(['language-html', 'custom-language-html hljs', 'language-xml', 'lang-htm'])('recognises %s after message sanitisation', name => {
        expect(previewLanguage(name)).toBe('html');
    });
    test('does not offer previews for unrelated or unlabelled code', () => {
        for (const name of ['', 'language-js', 'language-css-extra', 'hljs']) expect(previewLanguage(name)).toBe('');
        expect(previewLanguage('custom-language-css')).toBe('css');
        expect(previewForBlock([{ language: '', text: '<p>Keep code</p>' }], 0)).toBeNull();
    });
    test('previews the selected HTML, combining separate CSS without other HTML or code', () => {
        const blocks = [{ language: 'html', text: '<p>First</p>' }, { language: 'css', text: 'p { color: red; }' },
            { language: 'html', text: '<p>{{user}}</p>' }, { language: '', text: 'private-looking code' }, { language: 'css', text: 'p { padding: 1em; }' }];
        expect(previewForBlock(blocks, 2)).toEqual({ html: '<p>{{user}}</p>', css: 'p { color: red; }\n\np { padding: 1em; }' });
        expect(previewForBlock(blocks, 1).html).toBe('<p>First</p>');
    });
    test('reads edited proposals without resolving macros or changing the source', () => {
        const text = '```html\n<p>{{getvar::secret}}</p>\n```\n```css\np { color: red; }\n```';
        expect(previewFromText(text)).toEqual({ html: '<p>{{getvar::secret}}</p>', css: 'p { color: red; }' });
        expect(previewFromText('<style>p { color: red; }</style><p>{{char}}</p>')).toEqual({ html: '<style>p { color: red; }</style><p>{{char}}</p>', css: '' });
        expect(previewFromText('~~~css\np { color: red; }\n~~~')).toEqual({ html: '', css: 'p { color: red; }' });
        expect(previewFromText('.mes_text { color: red; }')).toEqual({ html: '', css: '.mes_text { color: red; }' });
        expect(previewFromText('Ordinary proposed text.')).toBeNull();
    });
});
