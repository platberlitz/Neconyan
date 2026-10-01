import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = file => readFileSync(fileURLToPath(new URL('../public/' + file, import.meta.url)), 'utf8');
const html = read('index.html');
const css = read('css/welcome.css');

describe('Preparing workspace splash', () => {
    test('keeps its status text and offers a still kitty for reduced motion', () => {
        const splash = html.slice(html.indexOf('<div id="neconyan-home-skeleton"'), html.indexOf('<div id="form_sheld"'));
        expect(splash).toContain('role="status" aria-live="polite"');
        expect(splash).toContain('Preparing your Neconyan workspace…');
        expect(splash).toContain('media="(prefers-reduced-motion: reduce)" srcset="img/neconyan/workspace-kitty-still.webp"');
        expect(splash).toContain('src="img/neconyan/workspace-kitty-wave.webp" alt="" width="176" height="220"');
    });

    test('ships transparent animated WebP artwork and a static fallback', () => {
        for (const [name, animated] of [['wave', true], ['still', false]]) {
            const bytes = readFileSync(fileURLToPath(new URL(`../public/img/neconyan/workspace-kitty-${name}.webp`, import.meta.url)));
            expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
            expect(bytes.length).toBeLessThan(110_000);
            expect(bytes.includes(Buffer.from('ANIM'))).toBe(animated);
            if (animated) expect(bytes[20] & 0x10).toBe(0x10); // WebP extended-header alpha flag.
            else expect(bytes.includes(Buffer.from('ALPH'))).toBe(true);
        }
    });

    test('uses translucent theme surfaces without giving the kitty an opaque tile', () => {
        const card = css.match(/\.neconyan-workspace-splash\s*\{[\s\S]*?\}/)?.[0];
        expect(card).toContain('var(--neco-surface');
        expect(card).toContain('72%, transparent');
        expect(card).toContain('width: min(100%, 360px)');
        expect(css.match(/\.neconyan-home-skeleton img\s*\{[\s\S]*?\}/)?.[0]).toContain('background: transparent');
        expect(read('css/neconyan.css')).toContain('body.neconyan.neconyan-home-booting #sheld { background: transparent; }');
    });

    test('hides the waving kitty with Hide cats while retaining the loading status', () => {
        expect(read('css/neconyan-kittyless.css')).toContain('.neconyan-workspace-kitty');
        expect(read('scripts/welcome-screen.js')).toContain("chatElement.querySelector('#neconyan-home-skeleton')?.remove();");
    });
});
