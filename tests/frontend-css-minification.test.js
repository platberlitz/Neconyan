import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@adobe/css-tools';

test('built CSS preserves descendant pseudo-classes, ear positioning and media rules', () => {
    const build = readFileSync(new URL('../scripts/build-frontend-assets.js', import.meta.url), 'utf8');
    const minifyCss = vm.runInNewContext(`(${build.match(/^function minifyCss\(source\) \{[\s\S]*?^}/m)[0]})`);
    const source = `
        body.neconyan :is(#chat,#sheld) { background: transparent; }
        .neconyan-whiskers :is(.neconyan-cat-head,.neconyan-cat-tail) { position: absolute; }
        @media (max-width: 768px) { body.neconyan :is(button,select) { min-height: 44px; } }
        .panel { height: calc(100dvh - 48px); }
    `;
    const rules = css => parse(css).stylesheet.rules.map(rule => rule.type === 'media'
        ? { media: rule.media, rules: rule.rules.map(entry => ({ selectors: entry.selectors, values: entry.declarations.map(value => [value.property, value.value]) })) }
        : { selectors: rule.selectors, values: rule.declarations.map(value => [value.property, value.value]) });
    expect(rules(minifyCss(source))).toEqual(rules(source));
});
