import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
    for (const label of ['Create agent', 'Browse library', 'Connections &amp; Defaults', 'Companion Output']) {
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

    const userRoot = mkdtempSync(join(tmpdir(), 'docs-reader-'));
    try {
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
        writeFileSync(join(userRoot, 'settings.json'), JSON.stringify({ accountStorage: { 'neconyanAssistantGender:taro': 'female' } }));
        assert.equal(readAssistantGender(userRoot, 'taro'), 'female');
        const female = renderRegisteredDocsPage(serverDirectory, 'in-chat-agents-glossary', { userRoot });
        assert.match(female, /tour-05-taro-agents-female\.webp/);
        assert.match(female, /assistant-icons\/taro-female\.png/);
        assert.doesNotMatch(female, /-neutral\.(webp|png)/);
        writeFileSync(join(userRoot, 'settings.json'), JSON.stringify({ accountStorage: { 'neconyanAssistantGender:taro': '../etc' } }));
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
        writeFileSync(join(userRoot, 'settings.json'), '{ broken');
        assert.equal(readAssistantGender(userRoot, 'taro'), 'neutral');
    } finally {
        rmSync(userRoot, { recursive: true, force: true });
    }

    for (const gender of ['male', 'female', 'neutral']) {
        assert.ok(existsSync(join(serverDirectory, `public/img/neconyan/tour/tour-05-taro-agents-${gender}.webp`)), `missing ${gender} Taro`);
        assert.ok(existsSync(join(serverDirectory, `public/img/neconyan/assistant-icons/taro-${gender}.png`)), `missing ${gender} Taro icon`);
    }
});

test('pages without a host keep the plain hero and empty state', () => {
    const html = renderDocsPage('# Plain\n\n## Part\n\nText.', { rawHref: '/docs/x.md' });
    assert.doesNotMatch(html, /class="hero[^"]*has-host"|<img class="(hero|empty)-host"/);
    assert.match(html, /id="empty-state"/);
});

test('the Agents panel links to the reader page', () => {
    const settings = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/settings.html', import.meta.url), 'utf8');
    assert.match(settings, /href="\/docs\/in-chat-agents-glossary"/);
});
