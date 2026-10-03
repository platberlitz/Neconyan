import { describe, expect, test } from '@jest/globals';
import { bindPortraitUrls } from '../public/scripts/portrait-urls.js';

describe('tracker portrait character identity', () => {
    const character = { name: 'Miso', avatar: 'Miso1.png' };
    const html = '<span style="background:url(&quot;/thumbnail/portrait?name=Miso&amp;char=Miso&quot;)"></span>';

    test('updates saved tracker output when switching between same-named cards', () => {
        const first = bindPortraitUrls(html, character);
        expect(first).toContain('?name=Miso&amp;char=Miso&amp;avatar=Miso1.png');
        const second = bindPortraitUrls(first, { ...character, avatar: 'Miso2.png' });
        expect(second).toContain('?name=Miso&amp;char=Miso&amp;avatar=Miso2.png');
        expect(second).not.toContain('Miso1.png');
        expect(bindPortraitUrls(first, character)).toBe(first);
    });

    test('preserves the requested person and safely encodes the current name and filename', () => {
        const result = bindPortraitUrls('<img src="/thumbnail/portrait?name=Alex&amp;preset=mobile">', {
            name: 'Miso & "Friends"', avatar: 'Miso & "Friends" #2.png',
        });
        const url = new URL(result.match(/src="([^"]+)"/)[1].replaceAll('&amp;', '&'), 'http://localhost');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            name: 'Alex', preset: 'mobile', char: 'Miso & "Friends"', avatar: 'Miso & "Friends" #2.png',
        });
        expect(result).toContain('%22Friends%22');
    });

    test('only changes quoted local portrait URLs when a current card exists', () => {
        for (const card of [undefined, {}, { name: 'Miso' }, { name: 'Miso', avatar: 'none' }]) {
            expect(bindPortraitUrls(html, card)).toBe(html);
        }
        const untouched = '<img src="https://example.com/thumbnail/portrait?name=Miso"><img src="/thumbnail?type=avatar&file=Miso.png">';
        expect(bindPortraitUrls(untouched, character)).toBe(untouched);
        expect(bindPortraitUrls('url(\'/thumbnail/portrait?name=Miso\')', character)).toContain('avatar=Miso1.png');
    });
});
