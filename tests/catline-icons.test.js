import { describe, expect, test } from '@jest/globals';
import { load } from 'cheerio';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { icons, aliases, renderIcon } from '../scripts/catline-icons.js';
import { galleryIcons } from '../public/scripts/extensions/gallery/icons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(path.join(root, name), 'utf8');
const catalogue = JSON.parse(read('public/img/icons/catline/catalogue.json'));
const available = new Set(catalogue.flat());
const modifiers = /^(?:fa-(?:(?:\d+x|\d*xs|\d*xl|sm|lg)|solid|regular|light|brands|classic|sharp|fw|spin(?:-reverse|-pulse)?|pulse|fade|beat|bounce|shake|flip(?:-horizontal|-vertical)?|rotate-\d+|ul|li|sr-only|animation-[\w-]+)|fa-circle-chevron|fa-1|fa-solid-900)$/;

function sources(directory) {
    return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        const name = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return ['lib', 'locales', 'icons'].includes(entry.name) ? [] : sources(name);
        return /\.(?:js|html|css|json)$/.test(name) && !name.includes('.min.') ? [name] : [];
    });
}

describe('Catline SVG icon replacement', () => {
    test('every bundled icon class has a drawing, including dynamic arrow states', () => {
        const missing = [];
        for (const filename of [...sources('public'), ...sources('default')]) {
            for (const name of read(filename).matchAll(/\bfa-[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
                if (!available.has(name[0]) && !modifiers.test(name[0])) missing.push(`${filename}: ${name[0]}`);
            }
        }
        expect([...new Set(missing)]).toEqual([]);
        for (const direction of ['up', 'down', 'left', 'right']) expect(available.has(`fa-circle-chevron-${direction}`)).toBe(true);
    });

    test('generated assets exactly match the authored drawings', () => {
        expect(() => execFileSync(process.execPath, ['scripts/build-catline-icons.js', '--check'], { cwd: root })).not.toThrow();
        expect(catalogue.length).toBe(Object.keys(icons).length);
        expect(available.size).toBe(catalogue.flat().length);
        for (const [name, drawings] of Object.entries(icons)) {
            expect(catalogue).toContainEqual([`fa-${name}`, ...(aliases[name] ?? []).map(alias => `fa-${alias}`)]);
            for (const drawing of drawings) {
                const svg = load(renderIcon(drawing), { xmlMode: true });
                expect(svg('svg').attr('viewBox')).toBe('0 0 24 24');
                expect(svg('svg').attr('stroke')).toBe('currentColor');
                expect(svg('svg').attr('stroke-width')).toBe('2.4');
                expect(svg('svg').attr('stroke-linecap')).toBe('round');
                expect(svg('svg').attr('stroke-linejoin')).toBe('round');
                for (const group of svg('g[stroke-width]').toArray()) {
                    const scale = Number(svg(group).attr('transform').match(/scale\(([\d.]+)\)/)[1]);
                    expect(Number(svg(group).attr('stroke-width')) * scale).toBeCloseTo(2.4, 2);
                }
                expect(svg('script, foreignObject, image, text, use').length).toBe(0);
                expect(renderIcon(drawing)).not.toMatch(/(?:href=|style=|on\w+=|#[0-9a-f]{3,8}\b)/i);
            }
        }
    });

    test('the app loads SVG styling instead of icon fonts', () => {
        const html = read('public/index.html');
        expect(html).toContain('css/neconyan-icons.css?v=');
        expect(html).toContain('css/neconyan-icons-map.css?v=');
        expect(html).not.toMatch(/(?:fontawesome|solid|brands)\.min\.css/);
        expect(read('public/script.js')).not.toContain('fa-solid-900.woff2');
        expect(read('public/css/neconyan-icons-map.css')).toContain(':root[data-sb-kittyless=\'true\']');
    });

    test('the Persona cat face has a :3 mouth while Kittyless keeps its smile', () => {
        expect(load(read('public/index.html'))('#sb_character_tab_persona i').hasClass('fa-face-smile')).toBe(true);
        const cat = load(renderIcon(icons['face-smile'][0]), { xmlMode: true });
        const plain = load(renderIcon(icons['face-smile'][1]), { xmlMode: true });
        expect(cat('path[d="M8 15q2 4 4 0q2 4 4 0"]').length).toBe(1);
        expect(cat('path[d="M8 15q4 4 8 0"]').length).toBe(0);
        expect(plain('path[d="M8 15q4 4 8 0"]').length).toBe(1);
    });

    test('legacy CSS glyphs are replaced at their source', () => {
        const glyphs = sources('public').filter(name => name.endsWith('.css')).flatMap(name => /content:\s*['"]\\[fe][0-9a-f]{3}/i.test(read(name)) ? [name] : []);
        expect(glyphs).toEqual([]);
    });

    test('every gallery font-icon slot uses an available SVG or a service label', () => {
        const vendor = read('public/scripts/extensions/gallery/jquery.nanogallery2.min.js');
        const slots = [...vendor.matchAll(/(\w+):'<i[^']*class="nGY2Icon-/g)].map(match => match[1]);
        expect(slots.length).toBeGreaterThan(40);
        for (const slot of slots) {
            expect(galleryIcons[slot]).toBeTruthy();
            expect(galleryIcons[slot]).not.toContain('nGY2Icon-');
        }
        for (const markup of Object.values(galleryIcons)) {
            for (const match of markup.matchAll(/fa-([a-z-]+)/g)) {
                expect(available.has(match[0]) || modifiers.test(match[0])).toBe(true);
            }
        }
    });
});
