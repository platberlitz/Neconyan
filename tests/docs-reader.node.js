import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { load } from 'cheerio';
import { DOCS_READER_PAGES, readAssistantGender, renderDocsMarkdown, renderDocsPage, renderRegisteredDocsPage } from '../src/docs-reader.js';

const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
const glossary = readFileSync(new URL('../docs/in-chat-agents-glossary.md', import.meta.url), 'utf8');

test('markdown becomes titled sections with an outline, callouts and labelled table cells', () => {
    const doc = renderDocsMarkdown([
        '# Sample Guide',
        '',
        'Intro text.',
        '',
        '## First Part',
        '',
        '**Term** explains a thing.',
        '',
        '> [!NOTE]',
        '> Remember this.',
        '',
        '### Detail',
        '',
        '| Control | What it does |',
        '| --- | --- |',
        '| Save | Stores it |',
        '',
        '## Second Part',
        '',
        'Plain paragraph.',
    ].join('\n'));

    assert.equal(doc.title, 'Sample Guide');
    assert.doesNotMatch(doc.bodyHtml, /<h1/);
    assert.deepEqual(doc.outline.map(item => [item.id, item.children.map(child => child.id)]), [['first-part', ['detail']], ['second-part', []]]);
    assert.match(doc.bodyHtml, /class="doc-intro"/);
    assert.match(doc.bodyHtml, /<section class="doc-section" data-section="first-part">/);
    assert.match(doc.bodyHtml, /<aside class="callout callout-note" role="note">/);
    assert.doesNotMatch(doc.bodyHtml, /\[!NOTE\]/);
    assert.match(doc.bodyHtml, /<p class="term"><strong>Term<\/strong>/);
    assert.match(doc.bodyHtml, /<div class="table-wrap"[^>]*>/);
    assert.match(doc.bodyHtml, /<td[^>]*data-label="What it does"[^>]*>Stores it<\/td>/);
    assert.ok(doc.readingMinutes >= 1);
});

test('the full page carries the reader controls and keeps markup out of the title', () => {
    const html = renderDocsPage('# A <b>risky</b> title\n\n## Part\n\nText.', { rawHref: '/docs/x.md', kicker: 'Kicker', summary: 'Summary' });
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /<title>A risky title - Neconyan<\/title>/);
    for (const marker of ['id="doc-search"', 'id="doc-toc"', 'id="toc-toggle"', 'id="theme-toggle"', 'id="back-to-top"', 'href="/docs/x.md"', 'prefers-reduced-motion']) {
        assert.ok(html.includes(marker), `missing ${marker}`);
    }
});

test('only registered pages render, and the glossary uses current Agents labels', () => {
    assert.deepEqual(Object.keys(DOCS_READER_PAGES), ['in-chat-agents-glossary']);
    assert.equal(renderRegisteredDocsPage(serverDirectory, 'nope'), null);
    assert.equal(renderRegisteredDocsPage(serverDirectory, '../package.json'), null);
    const html = renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary');
    assert.match(html, /In-Chat Agents Glossary/);
    assert.doesNotMatch(html, /explained in plain words/);
    assert.match(html, /href="\/docs\/in-chat-agents-glossary\.md"/);
    assert.equal((html.match(/class="callout callout-note"/g) || []).length, 3);
    for (const label of ['Create agent', 'Browse library', 'Connections &amp; Defaults', 'Companion Notes', 'What It Changes']) {
        assert.ok(html.includes(label), `missing ${label}`);
    }
    assert.doesNotMatch(glossary, /sillybunny/i);
});

test('Taro hosts the glossary in the assistant gender the user picked', () => {
    const neutral = renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary');
    assert.match(neutral, /<header class="hero cat-panel has-host">/);
    assert.match(neutral, /class="hero-speech" role="note" aria-label="Taro says"/);
    assert.match(neutral, /<img class="hero-host" src="\/img\/neconyan\/tour\/tour-05-taro-agents-neutral\.webp\?v=[^"]+"/);
    assert.match(neutral, /<img class="empty-host" src="\/img\/neconyan\/assistant-icons\/taro-neutral\.png\?v=[^"]+"/);
    assert.match(neutral, /I checked twice\. Nothing matches that search\./);

    const asides = [...neutral.matchAll(/<\/section>\s*<aside class="host-aside host-aside-(left|right)" role="note" aria-label="Taro says" data-after="([^"]+)">[\s\S]*?<img class="host-aside-art" src="([^"]+)"/g)];
    assert.deepEqual(asides.map(match => match[2]), ['main-agents-panel', 'companion-notes', 'agent-regex', 'companion-panel', 'storage-and-recovery']);
    assert.deepEqual(asides.map(match => match[1]), ['right', 'left', 'right', 'left', 'right']);
    for (const [, , after, src] of asides) {
        assert.match(src, /^\/img\/neconyan\/tour\/tour-0[358]-taro-[a-z]+-neutral\.webp\?v=/);
        assert.ok(neutral.indexOf(`data-section="${after}"`) < neutral.indexOf(`data-after="${after}"`), `${after} aside sits after its section`);
    }
    assert.match(neutral, /Previous notes to read does nothing unless Read its previous notes is on/);

    const userRoot = mkdtempSync(join(tmpdir(), 'docs-reader-'));
    try {
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
        writeFileSync(join(userRoot, 'settings.json'), JSON.stringify({ accountStorage: { 'neconyanAssistantGender:taro': 'female' } }));
        assert.equal(readAssistantGender(userRoot, 'taro'), 'female');
        const female = renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary', { userRoot });
        assert.match(female, /tour-05-taro-agents-female\.webp/);
        assert.match(female, /assistant-icons\/taro-female\.png/);
        assert.doesNotMatch(female, /-neutral\.(webp|png)/);
        assert.equal(female.match(/<img class="host-aside-art" src="\/img\/neconyan\/tour\/[^"]+-female\.webp/g)?.length, 5);
        writeFileSync(join(userRoot, 'settings.json'), JSON.stringify({ accountStorage: { 'neconyanAssistantGender:taro': '../etc' } }));
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
        writeFileSync(join(userRoot, 'settings.json'), '{ broken');
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
    } finally {
        rmSync(userRoot, { recursive: true, force: true });
    }

    for (const gender of ['male', 'female', 'neutral']) {
        for (const scene of ['tour-03-taro-modes', 'tour-05-taro-agents', 'tour-08-taro-sampling']) {
            assert.ok(existsSync(join(serverDirectory, `public/img/neconyan/tour/${scene}-${gender}.webp`)), `missing ${gender} ${scene}`);
        }
        assert.ok(existsSync(join(serverDirectory, `public/img/neconyan/assistant-icons/taro-${gender}.png`)), `missing ${gender} Taro icon`);
    }
});

test('pages without a host keep the plain hero and empty state', () => {
    const html = renderDocsPage('# Plain\n\n## Part\n\nText.', { rawHref: '/docs/x.md' });
    assert.doesNotMatch(html, /class="hero[^"]*has-host"|<img class="(hero|empty)-host"|<aside class="host-aside/);
    assert.match(html, /id="empty-state"/);
});

test('the header cat rests under reduced motion without shifting the brand link', () => {
    for (const html of [renderDocsPage('# Plain\n\n## Part\n\nText.'), renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary')]) {
        const $ = load(html);
        const brand = $('.topbar .brand');
        assert.deepEqual(brand.children().toArray().map(node => node.tagName), ['picture', 'span']);
        const picture = brand.children('picture');
        assert.deepEqual(picture.children().toArray().map(node => node.tagName), ['source', 'img']);
        assert.equal(picture.children('source').attr('media'), '(prefers-reduced-motion: reduce)');
        assert.equal(picture.children('source').attr('srcset'), '/img/neconyan-pixel-cat-rest.webp');
        assert.equal(picture.children('img').attr('src'), '/img/neconyan-pixel-cat.webp');
        assert.equal(picture.children('img').attr('width'), '26');
        assert.equal(picture.children('img').attr('height'), '24');

        // The brand is a flex row with a gap: the picture must not become a flex item, nor its source.
        const css = $('style').text();
        assert.match(css, /\.brand picture\s*\{\s*display:\s*contents;\s*\}/);
        assert.match(css, /\.brand source\s*\{\s*display:\s*none;\s*\}/);
    }
    for (const file of ['neconyan-pixel-cat.webp', 'neconyan-pixel-cat-rest.webp']) {
        assert.ok(existsSync(join(serverDirectory, 'public/img', file)), `missing ${file}`);
    }
});

function isAnimatedImage(bytes) {
    if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
        return bytes.includes('ANIM', 12, 'latin1') || bytes.includes('ANMF', 12, 'latin1');
    }
    if (bytes.toString('latin1', 0, 4) === 'GIF8') {
        return bytes.includes('NETSCAPE2.0', 0, 'latin1');
    }
    return false;
}

// Shipped references to an animated image that a <picture> reduced-motion source doesn't guard.
// Each one is still covered, by the code named here, and the counts are exact so a new one fails.
const SCRIPTED_ANIMATED_REFERENCES = {
    'public/css/shell-styles/windows-98.css': {
        counts: { 'neconyan-pixel-cat.webp': 3, 'neconyan-pixel-cat-running.webp': 3, 'home-cat.webp': 1, 'startup-cat.webp': 1 },
        guard: ['public/css/shell-styles/windows-98.css', /@media \(prefers-reduced-motion: reduce\) \{\s*[^\n]*body\.neconyan img\[src\*='img\/neconyan-pixel-cat-running\.webp'\] \{ content: url\('[^']*startup-cat-still\.webp[^\n]*\n[^\n]*body\.neconyan img\[src\*='img\/neconyan-pixel-cat\.webp'\] \{ content: url\('[^']*startup-cat-rest\.webp[^\n]*\n\}\n[^\n]*body\.neconyan\.reduced-motion img\[src\*='img\/neconyan-pixel-cat-running\.webp'\] \{ content: url\('[^']*startup-cat-still\.webp[^\n]*\n[^\n]*body\.neconyan\.reduced-motion img\[src\*='img\/neconyan-pixel-cat\.webp'\] \{ content: url\('[^']*startup-cat-rest\.webp/],
    },
    'public/script.js': {
        counts: { 'neconyan-pixel-cat-running.webp': 1 },
        guard: ['public/script.js', /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'img\/neconyan-pixel-cat-rest\.webp' : 'img\/neconyan-pixel-cat-running\.webp'/],
    },
    'public/scripts/action-loader.js': {
        counts: { 'neconyan-pixel-cat-running.webp': 1 },
        guard: ['public/scripts/action-loader.js', /classList\.contains\('reduced-motion'\)\s*\|\| window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches;[\s\S]{0,120}reducedMotion\s*\? 'img\/neconyan-pixel-cat-rest\.webp/],
    },
    'public/scripts/power-user.js': {
        counts: { 'neconyan-pixel-cat-running.webp': 1, 'workspace-kitty-wave.webp': 1 },
        guard: ['public/scripts/power-user.js', /effectiveReducedMotion\s*\? 'img\/neconyan\/workspace-kitty-still\.webp'/],
    },
    'public/scripts/neconyan-home.js': {
        counts: { 'neconyan-pixel-cat.webp': 1 },
        guard: ['public/scripts/neconyan-home.js', /const reduced = catMotionPreference\.matches \|\| Boolean\(document\.body\?\.classList\.contains\('reduced-motion'\)\);[\s\S]*cat\.src = still \? CAT_RESTING_SRC : CAT_MOVING_SRC;/],
    },
    'public/scripts/templates/welcomePanelOnboarding.html': {
        counts: { 'neconyan-pixel-cat.webp': 1 },
        guard: ['public/scripts/welcome-screen.js', /fragment\.querySelectorAll\('\.welcomePanel'\)\.forEach\(\(root\) => \{\s*initializeNeconyanHome\(root\);/],
    },
    'public/scripts/startup-templates.js': {
        counts: { 'neconyan-pixel-cat.webp': 1 },
        guard: ['public/scripts/welcome-screen.js', /fragment\.querySelectorAll\('\.welcomePanel'\)\.forEach\(\(root\) => \{\s*initializeNeconyanHome\(root\);/],
    },
    'src/middleware/basicAuth.js': {
        counts: { 'neconyan-pixel-cat.webp': 1 },
        // Only lets the sign-in flow fetch the file; nothing is drawn here.
        guard: ['src/middleware/basicAuth.js', /const LOGIN_GET_ROUTES = new Set\(\[[^\]]*'\/img\/neconyan-pixel-cat\.webp',/],
    },
};

test('every shipped animated cat stands still under reduced motion', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', 'public', 'default', 'src', 'android'], { cwd: serverDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean);
    const animated = tracked
        .filter(file => /\.(webp|gif|png|apng|avif)$/i.test(file) && isAnimatedImage(readFileSync(join(serverDirectory, file))))
        .sort();
    assert.deepEqual(animated, [
        'public/img/neconyan-pixel-cat-running.webp',
        'public/img/neconyan-pixel-cat.webp',
        'public/img/neconyan/win98/home-cat.webp',
        'public/img/neconyan/win98/startup-cat.webp',
        'public/img/neconyan/workspace-kitty-wave.webp',
    ], 'a new animated image needs a reduced-motion still and a row here');
    const names = animated.map(file => file.split('/').pop());
    const pattern = new RegExp(names.map(name => name.replace(/[.-]/g, '\\$&')).join('|').replace(/(^|\|)/g, '$1(?<![\\w-])'), 'g');

    const unguarded = {};
    for (const file of tracked.filter(file => /\.(html?|[cm]?js|css|xml|java|kt)$/i.test(file))) {
        const text = readFileSync(join(serverDirectory, file), 'utf8');
        for (const match of text.matchAll(pattern)) {
            const before = text.slice(0, match.index);
            const pictureStart = before.lastIndexOf('<picture');
            const insidePicture = pictureStart > before.lastIndexOf('</picture>');
            const tagStart = before.lastIndexOf('<');
            const inImg = before.slice(tagStart).startsWith('<img');
            const stillSource = /<source media="\(prefers-reduced-motion: reduce\)" srcset="[^"]*-(rest|still)\.webp(\?[^"]*)?"/.test(before.slice(pictureStart));
            if (insidePicture && inImg && stillSource) {
                continue;
            }
            unguarded[file] ??= {};
            unguarded[file][match[0]] = (unguarded[file][match[0]] ?? 0) + 1;
        }
    }
    const expected = Object.fromEntries(Object.entries(SCRIPTED_ANIMATED_REFERENCES)
        .filter(([, entry]) => Object.keys(entry.counts).length)
        .map(([file, entry]) => [file, entry.counts]));
    assert.deepEqual(unguarded, expected, 'an animated cat without a reduced-motion <picture> source needs a guard listed here');

    for (const [file, entry] of Object.entries(SCRIPTED_ANIMATED_REFERENCES)) {
        if (entry.guard) {
            const [guardFile, guard] = entry.guard;
            assert.ok(guard.test(readFileSync(join(serverDirectory, guardFile), 'utf8')), `${file} lost its reduced-motion guard in ${guardFile}`);
        }
    }

    // The Home page and boot skeleton are guarded by their <picture> sources for the device setting.
    const index = readFileSync(join(serverDirectory, 'public/index.html'), 'utf8');
    assert.match(index, /<source media="\(prefers-reduced-motion: reduce\)" srcset="img\/neconyan-pixel-cat-rest\.webp[^"]*">\s*<img[^>]*neconyan-pixel-cat-running\.webp/);
    assert.match(index, /<source media="\(prefers-reduced-motion: reduce\)" srcset="img\/neconyan\/workspace-kitty-still\.webp">\s*<img src="img\/neconyan\/workspace-kitty-wave\.webp"/);
});

test('the Agents panel links to the reader page', () => {
    const settings = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/settings.html', import.meta.url), 'utf8');
    assert.match(settings, /href="\/docs\/in-chat-agents-glossary"/);
});
