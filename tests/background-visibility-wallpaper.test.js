import { describe, expect, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/* Background Visibility fades message boxes, Home cards and panels; the wallpaper behind the chat column must always show. */
describe('Background Visibility keeps the wallpaper visible', () => {
    test('the chat and Home column stays transparent in Calico', () => {
        const css = read('public/css/neconyan-calico.css');
        expect(css).toMatch(/body\.neconyan:not\(\.sbterm\) #sheld,\s*body\.neconyan:not\(\.sbterm\) #form_sheld,\s*body\.neconyan:not\(\.sbterm\) #neconyan-home-host\s*\{\s*background-color: transparent !important;/);
    });

    test('no stylesheet paints the whole chat column from the surface opacity', () => {
        const sheets = ['public/css', 'public/css/shell-styles']
            .flatMap(dir => readdirSync(new URL(`../${dir}`, import.meta.url)).filter(name => name.endsWith('.css')).map(name => `${dir}/${name}`));
        for (const sheet of sheets) {
            const rules = read(sheet).split('}');
            const offending = rules.filter(rule => {
                const [selector, body = ''] = rule.split('{');
                return /#sheld\s*$/.test(selector.trim().split(',').map(part => part.trim()).find(part => /#sheld$/.test(part)) || '')
                    && /background/.test(body) && /--sb-shell-surface-opacity/.test(body);
            });
            expect({ sheet, offending }).toEqual({ sheet, offending: [] });
        }
    });
});
