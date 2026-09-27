import fs from 'node:fs';
import path from 'node:path';

import showdown from 'showdown';

export const DOCS_READER_PAGES = Object.freeze({
    'in-chat-agents-glossary': Object.freeze({
        file: 'docs/in-chat-agents-glossary.md',
        kicker: 'Agents reference',
    }),
});

const CALLOUT_TITLES = Object.freeze({
    NOTE: 'Note',
    TIP: 'Tip',
    IMPORTANT: 'Important',
    WARNING: 'Warning',
    CAUTION: 'Caution',
});

const WORDS_PER_MINUTE = 200;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripTags(html) {
    return String(html)
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function createConverter() {
    const converter = new showdown.Converter({
        tables: true,
        ghCompatibleHeaderId: true,
        strikethrough: true,
        simplifiedAutoLink: true,
        openLinksInNewWindow: false,
        disableForced4SpacesIndentedSublists: true,
    });
    converter.setFlavor('github');
    converter.setOption('simpleLineBreaks', false);
    return converter;
}

function convertCallouts(html) {
    return html.replace(/<blockquote>\s*<p>\[!(\w+)\]\s*([\s\S]*?)<\/blockquote>/g, (match, kind, body) => {
        const type = String(kind).toUpperCase();
        const title = CALLOUT_TITLES[type];
        if (!title) {
            return match;
        }
        return `<aside class="callout callout-${type.toLowerCase()}" role="note"><p class="callout-title">${title}</p><p>${body.trim()}</aside>`;
    });
}

function labelTableCells(html) {
    return html.replace(/<table>([\s\S]*?)<\/table>/g, (_match, inner) => {
        const headMatch = inner.match(/<thead>([\s\S]*?)<\/thead>/);
        const labels = headMatch
            ? [...headMatch[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(cell => stripTags(cell[1]))
            : [];
        const labelled = inner.replace(/<tr>([\s\S]*?)<\/tr>/g, (rowMatch, row) => {
            if (!/<td\b/.test(row)) {
                return rowMatch;
            }
            let index = 0;
            const cells = row.replace(/<td\b([^>]*)>/g, (_cell, attributes) => {
                const label = labels[index] || '';
                const className = index === 0 ? ' class="cell-lead"' : '';
                index += 1;
                return `<td${attributes}${className} data-label="${escapeHtml(label)}">`;
            });
            return `<tr class="doc-row">${cells}</tr>`;
        });
        return `<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(labels.join(', ') || 'Table')}"><table>${labelled}</table></div>`;
    });
}

function markTermParagraphs(html) {
    return html.replace(/<p><strong>/g, '<p class="term"><strong>');
}

function addHeadingAnchors(html) {
    return html.replace(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g, (_match, level, id, content) => (
        `<h${level} id="${id}" tabindex="-1">${content}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(stripTags(content))}">#</a></h${level}>`
    ));
}

function collectOutline(html) {
    const outline = [];
    for (const match of html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)) {
        const entry = { level: Number(match[1]), id: match[2], text: stripTags(match[3]) };
        if (entry.level === 2) {
            outline.push({ ...entry, children: [] });
        } else if (outline.length) {
            outline[outline.length - 1].children.push(entry);
        }
    }
    return outline;
}

function wrapSections(html) {
    const parts = html.split(/(?=<h2 id=)/);
    const intro = parts[0].trim();
    const sections = parts.slice(1).map((part) => {
        const id = part.match(/^<h2 id="([^"]+)"/)?.[1] || '';
        return `<section class="doc-section" data-section="${id}">${part.trim()}</section>`;
    });
    return `${intro ? `<div class="doc-intro">${intro}</div>` : ''}${sections.join('\n')}`;
}

function renderOutline(outline) {
    const items = outline.map((section) => {
        const children = section.children.length
            ? `<ol>${section.children.map(child => `<li><a href="#${child.id}" data-target="${child.id}">${escapeHtml(child.text)}</a></li>`).join('')}</ol>`
            : '';
        return `<li><a href="#${section.id}" data-target="${section.id}">${escapeHtml(section.text)}</a>${children}</li>`;
    });
    return `<ol class="toc-list">${items.join('')}</ol>`;
}

/**
 * Render a Markdown document into the parts the reader page needs.
 * @param {string} markdown
 * @returns {{ title: string, bodyHtml: string, outline: Array<{ level: number, id: string, text: string, children: Array<{ level: number, id: string, text: string }> }>, wordCount: number, readingMinutes: number }}
 */
export function renderDocsMarkdown(markdown) {
    const source = String(markdown || '').replace(/\r\n?/g, '\n');
    let html = createConverter().makeHtml(source);

    let title = 'Neconyan docs';
    html = html.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/, (_match, content) => {
        title = stripTags(content);
        return '';
    });

    html = convertCallouts(html);
    html = labelTableCells(html);
    html = markTermParagraphs(html);
    const outline = collectOutline(html);
    html = addHeadingAnchors(html);
    html = wrapSections(html);

    const wordCount = stripTags(source.replace(/[|#>*`-]+/g, ' ')).split(' ').filter(Boolean).length;
    return {
        title,
        bodyHtml: html,
        outline,
        wordCount,
        readingMinutes: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
    };
}

/**
 * Build the full themed HTML reader page for a Markdown document.
 * @param {string} markdown
 * @param {{ rawHref?: string, kicker?: string, summary?: string }} [options]
 * @returns {string}
 */
export function renderDocsPage(markdown, options = {}) {
    const doc = renderDocsMarkdown(markdown);
    const rawHref = options.rawHref ? escapeHtml(options.rawHref) : '';
    const kicker = escapeHtml(options.kicker || 'Neconyan docs');
    const summary = options.summary ? `<p class="hero-summary">${escapeHtml(options.summary)}</p>` : '';
    const title = escapeHtml(doc.title);
    const sectionCount = doc.outline.length;

    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${title} - Neconyan</title>
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/webfonts/Nunito/stylesheet.css">
<link rel="stylesheet" href="/webfonts/FredokaOne/stylesheet.css">
<script>
(function () {
    try {
        var saved = localStorage.getItem('neconyan-docs-theme');
        var theme = saved === 'light' || saved === 'dark' ? saved : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', theme);
    } catch (error) { /* storage blocked: keep dark */ }
})();
</script>
<style>
${DOCS_READER_CSS}
</style>
</head>
<body>
<a class="skip-link" href="#doc-content">Skip to content</a>
<header class="topbar">
    <div class="topbar-inner">
        <a class="brand" href="/" aria-label="Open Neconyan">
            <img src="/img/neconyan-pixel-cat.webp" alt="" width="26" height="24">
            <span>Neconyan</span>
        </a>
        <label class="search">
            <span class="visually-hidden">Search the glossary</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            <input id="doc-search" type="search" placeholder="Search glossary" autocomplete="off" spellcheck="false">
            <kbd class="search-hint" aria-hidden="true">/</kbd>
        </label>
        <div class="topbar-actions">
            <button type="button" class="icon-button toc-toggle" id="toc-toggle" aria-label="Sections" title="Sections" aria-expanded="false" aria-controls="doc-toc">
                <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <span>Sections</span>
            </button>
            <button type="button" class="icon-button" id="theme-toggle" aria-label="Switch to light theme" title="Switch to light theme">
                <svg class="icon-sun" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <svg class="icon-moon" aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            </button>
        </div>
    </div>
</header>
<div class="layout">
    <nav class="toc" id="doc-toc" aria-label="Sections">
        <p class="toc-heading">On this page</p>
        ${renderOutline(doc.outline)}
        ${rawHref ? `<a class="raw-link" href="${rawHref}" target="_blank" rel="noopener">View plain Markdown</a>` : ''}
    </nav>
    <main id="doc-content" class="content" tabindex="-1">
        <header class="hero">
            <p class="hero-kicker">${kicker}</p>
            <h1>${title}</h1>
            ${summary}
            <p class="hero-meta"><span>${sectionCount} sections</span><span aria-hidden="true">·</span><span>About ${doc.readingMinutes} min read</span></p>
        </header>
        <p class="search-status" id="search-status" role="status" aria-live="polite" hidden></p>
        <article class="doc">
${doc.bodyHtml}
        </article>
        <p class="empty-state" id="empty-state" hidden>Nothing matches that search. Try a shorter word, such as <strong>companion</strong> or <strong>depth</strong>.</p>
    </main>
</div>
<button type="button" class="back-to-top" id="back-to-top" aria-label="Back to top" title="Back to top" hidden>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="m6 14 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>
<script>
${DOCS_READER_SCRIPT}
</script>
</body>
</html>`;
}

/**
 * Read a registered document from disk and render its reader page.
 * @param {string} serverDirectory
 * @param {string} slug
 * @returns {string|null}
 */
export function renderRegisteredDocsPage(serverDirectory, slug) {
    const page = Object.prototype.hasOwnProperty.call(DOCS_READER_PAGES, slug) ? DOCS_READER_PAGES[slug] : null;
    if (!page) {
        return null;
    }
    const markdown = fs.readFileSync(path.join(serverDirectory, page.file), 'utf8');
    return renderDocsPage(markdown, {
        rawHref: `/docs/${slug}.md`,
        kicker: page.kicker,
        summary: page.summary,
    });
}

const DOCS_READER_CSS = `
:root {
    --canvas: #161716;
    --surface: #242420;
    --raised: #302e29;
    --rail: #1b1c1a;
    --ink: #f6edda;
    --muted: #ddd0bf;
    --soft: #b9ad9d;
    --accent: #d69270;
    --accent-ink: #1b1c1a;
    --accent-wash: rgba(214, 146, 112, 0.14);
    --border: #61534d;
    --hairline: rgba(246, 237, 218, 0.1);
    --mark: rgba(214, 146, 112, 0.38);
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    --measure: 72ch;
    --topbar: 64px;
    color-scheme: dark;
}
:root[data-theme="light"] {
    --canvas: #f6f2e8;
    --surface: #fffaf0;
    --raised: #efe8da;
    --rail: #fbf7ee;
    --ink: #303331;
    --muted: #4f514b;
    --soft: #66675f;
    --accent: #9b572b;
    --accent-ink: #fffaf0;
    --accent-wash: rgba(184, 107, 50, 0.1);
    --border: #d5cec0;
    --hairline: rgba(48, 51, 49, 0.1);
    --mark: rgba(214, 146, 112, 0.42);
    --shadow: 0 12px 32px rgba(84, 66, 44, 0.14);
    color-scheme: light;
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--topbar) + 16px); -webkit-text-size-adjust: 100%; }
body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: 'Nunito', system-ui, sans-serif;
    font-size: 17px;
    line-height: 1.7;
    text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip-link { position: absolute; left: 12px; top: 12px; transform: translateY(-200%); z-index: 30; padding: 10px 14px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); font-weight: 800; }
.skip-link:focus { transform: none; }

.topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--topbar);
    background: color-mix(in srgb, var(--rail) 88%, transparent);
    border-bottom: 1px solid var(--hairline);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
}
.topbar-inner { display: flex; align-items: center; gap: 16px; height: 100%; max-width: 1240px; margin: 0 auto; padding: 0 20px; }
.brand { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; gap: 8px; color: var(--ink); text-decoration: none; font-family: 'Fredoka One', 'Nunito', sans-serif; font-size: 19px; flex: none; }
.brand img { image-rendering: pixelated; }
.search { position: relative; display: flex; align-items: center; flex: 1; max-width: 520px; margin-left: auto; color: var(--soft); }
.search svg { position: absolute; left: 14px; pointer-events: none; }
.search input {
    width: 100%;
    height: 44px;
    padding: 0 44px 0 42px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--ink);
    font: inherit;
    font-size: 16px;
}
.search input::placeholder { color: var(--soft); }
.search input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
.search-hint { position: absolute; right: 12px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 6px; font: 700 12px/1.4 'Nunito', sans-serif; color: var(--soft); }
.search input:focus + .search-hint, .search input:not(:placeholder-shown) + .search-hint { display: none; }
.topbar-actions { display: flex; gap: 8px; flex: none; }
.icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 44px;
    height: 44px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--ink);
    font: 700 15px 'Nunito', sans-serif;
    cursor: pointer;
}
.icon-button:hover { border-color: var(--accent); }
:root[data-theme="dark"] .icon-moon, :root[data-theme="light"] .icon-sun { display: none; }
.toc-toggle { display: none; }

.layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 48px;
    max-width: 1240px;
    margin: 0 auto;
    padding: 0 20px;
}
.toc {
    position: sticky;
    top: var(--topbar);
    align-self: start;
    max-height: calc(100vh - var(--topbar));
    overflow-y: auto;
    padding: 28px 4px 32px 0;
    scrollbar-width: thin;
}
.toc-heading { margin: 0 0 10px 12px; font: 800 12px/1 'Nunito', sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: var(--soft); }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc-list > li { margin: 2px 0; }
.toc-list ol { margin: 2px 0 8px 12px; padding-left: 10px; border-left: 1px solid var(--hairline); }
.toc a { display: block; padding: 6px 12px; border-radius: 8px; color: var(--muted); text-decoration: none; font-size: 15px; line-height: 1.35; }
.toc-list ol a { font-size: 14px; color: var(--soft); padding: 5px 10px; }
.toc a:hover { background: var(--accent-wash); color: var(--ink); }
.toc a.is-active { background: var(--accent-wash); color: var(--accent); font-weight: 800; }
.toc li.is-filtered-out { display: none; }
.toc a.raw-link { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--hairline); border-radius: 0; color: var(--soft); font-size: 14px; }

.content { min-width: 0; padding: 40px 0 120px; outline: none; }
.hero, .doc, .search-status, .empty-state { max-width: var(--measure); }
.hero { padding-bottom: 28px; margin-bottom: 12px; border-bottom: 1px solid var(--hairline); }
.hero-kicker { margin: 0 0 6px; color: var(--accent); font-weight: 800; font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; }
.hero h1 { margin: 0; font-family: 'Fredoka One', 'Nunito', sans-serif; font-weight: 400; font-size: clamp(34px, 5vw, 48px); line-height: 1.1; letter-spacing: 0.005em; }
.hero-summary { margin: 14px 0 0; color: var(--muted); font-size: 19px; line-height: 1.55; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; color: var(--soft); font-size: 14px; font-weight: 700; }

.doc h2 {
    margin: 56px 0 16px;
    font-family: 'Fredoka One', 'Nunito', sans-serif;
    font-weight: 400;
    font-size: 30px;
    line-height: 1.2;
}
.doc-section:first-of-type h2 { margin-top: 32px; }
.doc h3 { margin: 36px 0 10px; font-size: 21px; font-weight: 800; line-height: 1.3; color: var(--ink); }
.doc h2, .doc h3 { position: relative; outline: none; }
.heading-anchor { margin-left: 10px; color: var(--soft); text-decoration: none; font-family: 'Nunito', sans-serif; font-weight: 700; opacity: 0; }
.doc h2:hover .heading-anchor, .doc h3:hover .heading-anchor, .heading-anchor:focus-visible { opacity: 1; }
.doc p { margin: 0 0 16px; color: var(--muted); }
.doc strong { color: var(--ink); font-weight: 800; }
.doc p.term {
    padding: 12px 16px;
    margin: 0 0 12px;
    border-left: 3px solid var(--accent);
    border-radius: 0 10px 10px 0;
    background: var(--surface);
}
.doc p.term > strong:first-child { color: var(--accent); }
.doc code {
    padding: 1px 6px;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    background: var(--raised);
    color: var(--ink);
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 0.86em;
    overflow-wrap: anywhere;
}
.doc ul, .doc ol { margin: 0 0 16px; padding-left: 24px; color: var(--muted); }
.doc li { margin: 4px 0; }

.table-wrap {
    margin: 8px 0 24px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow-x: auto;
    background: var(--surface);
}
.doc table { width: 100%; border-collapse: collapse; font-size: 15.5px; line-height: 1.55; }
.doc th {
    position: sticky;
    top: 0;
    padding: 12px 16px;
    background: var(--raised);
    color: var(--ink);
    text-align: left;
    font-weight: 800;
    font-size: 13px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
}
.doc td { padding: 12px 16px; border-top: 1px solid var(--hairline); color: var(--muted); vertical-align: top; }
.doc td.cell-lead { width: 32%; min-width: 150px; color: var(--ink); }
.doc tbody tr:hover td { background: var(--accent-wash); }

.callout {
    margin: 8px 0 24px;
    padding: 14px 18px 4px 18px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 12px;
    background: var(--accent-wash);
}
.callout-title { display: flex; align-items: center; gap: 8px; margin: 0 0 6px !important; color: var(--accent) !important; font-weight: 800; font-size: 14px; letter-spacing: 0.06em; text-transform: uppercase; }
.callout-title::before { content: ''; width: 18px; height: 18px; flex: none; border-radius: 50%; background: currentColor; -webkit-mask: radial-gradient(circle at 50% 30%, #000 1.6px, transparent 2px), linear-gradient(#000, #000) center 62% / 2px 6px no-repeat; mask: radial-gradient(circle at 50% 30%, #000 1.6px, transparent 2px), linear-gradient(#000, #000) center 62% / 2px 6px no-repeat; opacity: 0.9; }
.callout p { color: var(--ink); }

mark { padding: 0 2px; border-radius: 4px; background: var(--mark); color: inherit; }
.is-filtered-out { display: none !important; }
.search-status { margin: 0 0 8px; padding: 10px 14px; border-radius: 10px; background: var(--surface); color: var(--muted); font-size: 15px; font-weight: 700; }
.empty-state { padding: 32px 0; color: var(--muted); }

.back-to-top {
    position: fixed;
    right: 20px;
    bottom: calc(20px + env(safe-area-inset-bottom));
    z-index: 15;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    color: var(--ink);
    box-shadow: var(--shadow);
    cursor: pointer;
}
.back-to-top[hidden] { display: none; }

@media (max-width: 1024px) {
    .layout { grid-template-columns: 220px minmax(0, 1fr); gap: 32px; }
}
@media (max-width: 768px) {
    :root { --topbar: 60px; }
    body { font-size: 16.5px; }
    .topbar-inner { gap: 8px; padding: 0 12px; }
    .brand span { display: none; }
    .search { max-width: none; }
    .search input { padding-right: 12px; }
    .search-hint { display: none; }
    .toc-toggle { display: inline-flex; }
    .toc-toggle span { display: none; }
    .layout { display: block; padding: 0 16px; }
    .toc {
        position: fixed;
        top: var(--topbar);
        left: 0;
        right: 0;
        z-index: 18;
        max-height: min(70vh, calc(100vh - var(--topbar)));
        padding: 16px 12px calc(20px + env(safe-area-inset-bottom));
        background: var(--rail);
        border-bottom: 1px solid var(--border);
        box-shadow: var(--shadow);
        overscroll-behavior: contain;
        visibility: hidden;
        opacity: 0;
        transform: translateY(-8px);
    }
    body.toc-open .toc { visibility: visible; opacity: 1; transform: none; }
    .toc a { min-height: 44px; display: flex; align-items: center; font-size: 16px; }
    .toc-list ol a { font-size: 15px; }
    .content { padding: 28px 0 96px; }
    .hero-summary { font-size: 17.5px; }
    .doc h2 { font-size: 26px; margin-top: 44px; }
    .doc h3 { font-size: 19px; }
    .heading-anchor { display: none; }
    .doc p.term { padding: 10px 14px; }
    .table-wrap { border: 0; background: none; overflow: visible; }
    .doc table, .doc tbody, .doc tr, .doc td { display: block; width: 100%; }
    .doc thead { display: none; }
    .doc tr.doc-row {
        margin: 0 0 10px;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
    }
    .doc td { padding: 2px 0; border: 0; text-align: left !important; }
    .doc td.cell-lead { width: 100%; min-width: 0; padding-bottom: 6px; font-size: 16.5px; }
    .doc td:not(.cell-lead)::before {
        content: attr(data-label);
        display: block;
        margin-top: 4px;
        color: var(--soft);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.05em;
        text-transform: uppercase;
    }
    .doc td:not(.cell-lead)[data-label="What it does"]::before,
    .doc td:not(.cell-lead)[data-label="Description"]::before,
    .doc td:not(.cell-lead)[data-label="Meaning"]::before { display: none; }
    .doc tbody tr:hover td { background: none; }
    .back-to-top { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    .toc a, .icon-button, .heading-anchor { transition: background-color 160ms ease-out, color 160ms ease-out, border-color 160ms ease-out, opacity 160ms ease-out; }
    @media (max-width: 768px) {
        .toc { transition: opacity 180ms ease-out, transform 180ms ease-out, visibility 180ms; }
    }
}
@media print {
    .topbar, .toc, .back-to-top, .search-status { display: none !important; }
    .layout { display: block; }
    body { background: #fff; color: #000; }
}
`;

const DOCS_READER_SCRIPT = `
(function () {
    var root = document.documentElement;
    var body = document.body;
    var search = document.getElementById('doc-search');
    var status = document.getElementById('search-status');
    var empty = document.getElementById('empty-state');
    var themeButton = document.getElementById('theme-toggle');
    var tocButton = document.getElementById('toc-toggle');
    var toc = document.getElementById('doc-toc');
    var topButton = document.getElementById('back-to-top');
    var sections = Array.prototype.slice.call(document.querySelectorAll('.doc-section'));
    var intro = document.querySelector('.doc-intro');
    var tocLinks = Array.prototype.slice.call(toc.querySelectorAll('a[data-target]'));
    var headings = Array.prototype.slice.call(document.querySelectorAll('.doc h2[id], .doc h3[id]'));
    var blocks = Array.prototype.slice.call(document.querySelectorAll('.doc-section > p, .doc-section > aside, .doc-section > ul, .doc-section > ol, .doc tr.doc-row, .doc-intro > *'));
    var originals = new Map();

    function syncThemeLabel() {
        var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        themeButton.setAttribute('aria-label', 'Switch to ' + next + ' theme');
        themeButton.setAttribute('title', 'Switch to ' + next + ' theme');
    }
    syncThemeLabel();
    themeButton.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('neconyan-docs-theme', next); } catch (error) { /* ignore */ }
        syncThemeLabel();
    });

    function setToc(open) {
        body.classList.toggle('toc-open', open);
        tocButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    tocButton.addEventListener('click', function () { setToc(!body.classList.contains('toc-open')); });
    toc.addEventListener('click', function (event) {
        if (event.target.closest('a')) { setToc(false); }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && body.classList.contains('toc-open')) { setToc(false); tocButton.focus(); }
        if (event.key === '/' && document.activeElement !== search && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            search.focus();
        }
    });
    document.addEventListener('click', function (event) {
        if (body.classList.contains('toc-open') && !toc.contains(event.target) && !tocButton.contains(event.target)) { setToc(false); }
    });

    function restore(element) {
        if (originals.has(element)) { element.innerHTML = originals.get(element); }
    }
    function highlight(element, query) {
        if (!originals.has(element)) { originals.set(element, element.innerHTML); }
        var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
        var nodes = [];
        while (walker.nextNode()) { nodes.push(walker.currentNode); }
        nodes.forEach(function (node) {
            if (node.parentNode && node.parentNode.nodeName === 'MARK') { return; }
            var text = node.nodeValue || '';
            var lower = text.toLowerCase();
            var index = lower.indexOf(query);
            if (index === -1) { return; }
            var fragment = document.createDocumentFragment();
            var last = 0;
            while (index !== -1) {
                fragment.appendChild(document.createTextNode(text.slice(last, index)));
                var mark = document.createElement('mark');
                mark.textContent = text.slice(index, index + query.length);
                fragment.appendChild(mark);
                last = index + query.length;
                index = lower.indexOf(query, last);
            }
            fragment.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(fragment, node);
        });
    }

    var filterTimer = 0;
    function applyFilter() {
        var query = search.value.trim().toLowerCase();
        blocks.forEach(restore);
        headings.forEach(restore);
        document.querySelectorAll('.is-filtered-out').forEach(function (element) { element.classList.remove('is-filtered-out'); });
        if (!query) {
            status.hidden = true;
            empty.hidden = true;
            return;
        }
        var total = 0;
        var visibleSections = 0;
        var containers = intro ? [intro].concat(sections) : sections;
        containers.forEach(function (section) {
            var heading = section.querySelector('h2');
            var sectionHit = heading && heading.textContent.toLowerCase().indexOf(query) !== -1;
            var hits = 0;
            section.querySelectorAll('h3').forEach(function (h3) {
                h3.classList.add('is-filtered-out');
            });
            blocks.forEach(function (block) {
                if (!section.contains(block)) { return; }
                var previous = (block.closest('.table-wrap') || block).previousElementSibling;
                while (previous && previous.tagName !== 'H3' && previous.tagName !== 'H2') { previous = previous.previousElementSibling; }
                var subheading = previous && previous.tagName === 'H3' ? previous : null;
                var subheadingHit = subheading && subheading.textContent.toLowerCase().indexOf(query) !== -1;
                var hit = sectionHit || subheadingHit || block.textContent.toLowerCase().indexOf(query) !== -1;
                if (hit) {
                    hits += 1;
                    highlight(block, query);
                    if (subheading) {
                        subheading.classList.remove('is-filtered-out');
                        if (subheadingHit) { highlight(subheading, query); }
                    }
                } else {
                    block.classList.add('is-filtered-out');
                }
            });
            section.querySelectorAll('.table-wrap').forEach(function (wrap) {
                var visibleRows = wrap.querySelectorAll('tr.doc-row:not(.is-filtered-out)').length;
                wrap.classList.toggle('is-filtered-out', visibleRows === 0);
            });
            if (heading) { highlight(heading, query); }
            var link = heading ? toc.querySelector('a[data-target="' + heading.id + '"]') : null;
            if (hits === 0) {
                section.classList.add('is-filtered-out');
                if (link) { link.parentElement.classList.add('is-filtered-out'); }
            } else if (section !== intro) {
                visibleSections += 1;
            }
            total += hits;
        });
        status.hidden = false;
        status.textContent = total
            ? total + (total === 1 ? ' match' : ' matches') + ' in ' + visibleSections + (visibleSections === 1 ? ' section' : ' sections')
            : 'No matches';
        empty.hidden = total !== 0;
    }
    search.addEventListener('input', function () {
        window.clearTimeout(filterTimer);
        filterTimer = window.setTimeout(applyFilter, 90);
    });
    search.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && search.value) { event.stopPropagation(); search.value = ''; applyFilter(); }
    });

    function setActive(id) {
        tocLinks.forEach(function (link) { link.classList.toggle('is-active', link.getAttribute('data-target') === id); });
    }
    var ticking = false;
    function onScroll() {
        if (ticking) { return; }
        ticking = true;
        window.requestAnimationFrame(function () {
            ticking = false;
            var offset = (parseFloat(getComputedStyle(root).getPropertyValue('--topbar')) || 64) + 40;
            var current = null;
            headings.forEach(function (heading) {
                if (heading.offsetParent !== null && heading.getBoundingClientRect().top - offset <= 0) { current = heading; }
            });
            setActive(current ? current.id : '');
            topButton.hidden = window.scrollY < 600;
        });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    topButton.addEventListener('click', function () {
        window.scrollTo({ top: 0 });
        document.getElementById('doc-content').focus({ preventScroll: true });
    });
})();
`;
