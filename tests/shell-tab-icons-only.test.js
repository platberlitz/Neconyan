import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

test('phone shell tabs hide labels and retain touch targets when icons-only is selected', () => {
    const css = readFileSync(new URL('../public/css/neconyan-mobile-shell.css', import.meta.url), 'utf8');
    expect(css).toMatch(/:root\[data-sb-mobile-nav-mode='icon-only'\][^{]+\.sb-shell-tab-copy\s*\{\s*display: none;/);
    expect(css).toMatch(/:root\[data-sb-mobile-nav-mode='icon-only'\][^{]+> \.sb-shell-tab\s*\{\s*width: var\(--sb-mobile-touch-target, 44px\);/);
});

test('desktop vertical label styling does not override icons-only mode', () => {
    const css = readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');
    expect(css).toContain(":root[data-sb-desktop-nav-layout='vertical']:not([data-sb-desktop-nav-mode='icon-only']) body.neconyan .sb-shell-root.openDrawer .sb-shell-tab-copy {");
    expect(css).toContain(":root[data-sb-desktop-nav-layout='vertical']:not([data-sb-desktop-nav-mode='icon-only']) body.neconyan .sb-shell-root.openDrawer .sb-shell-nav > .sb-shell-tab {");
});
