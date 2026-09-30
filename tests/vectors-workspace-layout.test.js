import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

const settingsHtml = read('public', 'scripts', 'extensions', 'vectors', 'settings.html');
const vectorsCss = read('public', 'scripts', 'extensions', 'vectors', 'style.css');
const neconyanCss = read('public', 'css', 'neconyan.css');
const themeCss = read('public', 'css', 'neconyan-theme.css');

describe('Vectorization workspace layout', () => {
    test('keeps the status line in the header and groups settings into cards', () => {
        const header = settingsHtml.match(/<header class="vectors-hero">(?<body>[\s\S]*?)<\/header>/)?.groups?.body ?? '';

        expect(header).toContain('class="vectors-title"');
        expect(header).toContain('data-vectors-state role="status"');
        expect(settingsHtml.match(/<header\b/g)).toHaveLength(1);
        expect(settingsHtml.match(/class="vectors-card"/g)?.length).toBeGreaterThanOrEqual(10);
    });

    test('labels every tab with hidden icons so the tab names stay plain text', () => {
        const tabs = [...settingsHtml.matchAll(/<button[^>]*role="tab"[^>]*>(?<body>[\s\S]*?)<\/button>/g)].map(match => match.groups.body);

        expect(tabs).toHaveLength(6);
        for (const tab of tabs) {
            expect(tab).toMatch(/^<i class="fa-solid [a-z-]+" aria-hidden="true"><\/i><span[^>]*>[^<]+<\/span>$/);
        }
    });

    test('ships the workspace styles with the extension instead of the blocking sheets', () => {
        expect(neconyanCss).not.toContain('vectors');
        expect(themeCss).not.toContain('vectors_settings');
        expect(vectorsCss).toContain('container: vectors / inline-size;');
        expect(vectorsCss).toMatch(/#vectors_container \.vectors-card \{[^}]*background-color: var\(--neco-surface\);/);
        expect(vectorsCss).toMatch(/#vectors_container \.vectors-workspace \.vectors-hero \.vectors-title \{[^}]*border: 0;/);
    });
});
