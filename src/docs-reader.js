import fs from 'node:fs';
import path from 'node:path';

import showdown from 'showdown';

import { SETTINGS_FILE } from './constants.js';

const ASSISTANT_GENDERS = Object.freeze(['male', 'female', 'neutral']);
// Matches ART_VERSION in public/scripts/neconyan-assistant-art.js so the reader reuses cached artwork.
const ASSISTANT_ART_VERSION = '20260916-art4';

export const DOCS_READER_PAGES = Object.freeze({
    'in-chat-agents-glossary': Object.freeze({
        file: 'docs/in-chat-agents-glossary.md',
        kicker: 'Agents reference',
        host: Object.freeze({
            name: 'Taro',
            personality: 'taro',
            scene: 'tour-05-taro-agents',
            pose: 'Taro pointing at you with a clipboard',
            greeting: 'Every button and setting in the Agents panel, named and explained in the order you meet it. Search for the word you saw on screen, change one thing, then check what it did. I wrote it all down so you do not have to paw through the settings yourself. … That one was good. Do not look at me like that.',
            emptyLine: 'I checked twice. Nothing matches that search.',
            asides: Object.freeze([
                Object.freeze({ after: 'main-agents-panel', scene: 'tour-03-taro-modes', line: 'Switch agents on one at a time and read a reply after each. When something breaks, you will know which one did it. You will not need to ask me.' }),
                Object.freeze({ after: 'companion-output', scene: 'tour-08-taro-sampling', line: 'Longest section done. The one everyone misses: Previous notes to read does nothing unless Read its previous notes is on. I once watched someone tune it for an hour. Do not be that someone.' }),
                Object.freeze({ after: 'agent-regex', scene: 'tour-03-taro-modes', line: 'Try new regex on a message you do not care about first. It will happily eat formatting you wanted to keep, and I am not fishing it back out.' }),
                Object.freeze({ after: 'companion-panel', scene: 'tour-08-taro-sampling', line: 'Run companion works on the newest reply. Regenerate state goes back to the message the note came from. Mix them up and you will blame the wrong Companion.' }),
                Object.freeze({ after: 'storage-and-recovery', scene: 'tour-05-taro-agents', line: 'That is the lot. You read all of it? … Hm. Not bad. Now go change one thing and see what it does.' }),
            ]),
        }),
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
 * @param {{ rawHref?: string, kicker?: string, summary?: string, host?: { name: string, pose: string, greeting: string, emptyLine: string, gender: string, image: string, icon: string, asides?: Array<{ after: string, line: string, image: string }> } | null }} [options]
 * @returns {string}
 */
export function renderDocsPage(markdown, options = {}) {
    const doc = renderDocsMarkdown(markdown);
    const rawHref = options.rawHref ? escapeHtml(options.rawHref) : '';
    const kicker = escapeHtml(options.kicker || 'Neconyan docs');
    const summary = options.summary ? `<p class="hero-summary">${escapeHtml(options.summary)}</p>` : '';
    const title = escapeHtml(doc.title);
    const sectionCount = doc.outline.length;
    const host = options.host || null;
    const hostName = host ? escapeHtml(host.name) : '';
    const heroHost = host ? `
            <div class="hero-speech" role="note" aria-label="${hostName} says">
                <p class="hero-speaker">${hostName}</p>
                <p>${escapeHtml(host.greeting)}</p>
            </div>
            <img class="hero-host" src="${escapeHtml(host.image)}" alt="${escapeHtml(host.pose)}" width="512" height="768" data-gender="${escapeHtml(host.gender)}" decoding="async">` : '';
    const emptyState = host
        ? `<img class="empty-host" src="${escapeHtml(host.icon)}" alt="" width="64" height="64"><span><strong>${escapeHtml(host.emptyLine)}</strong> Try a shorter word, such as <strong>companion</strong> or <strong>depth</strong>.</span>`
        : 'Nothing matches that search. Try a shorter word, such as <strong>companion</strong> or <strong>depth</strong>.';
    const asides = new Map((host?.asides || []).map((aside, index) => [aside.after, `
<aside class="host-aside host-aside-${index % 2 ? 'left' : 'right'}" role="note" aria-label="${hostName} says" data-after="${escapeHtml(aside.after)}">
    <div class="host-aside-bubble"><p class="hero-speaker">${hostName}</p><p>${escapeHtml(aside.line)}</p></div>
    <img class="host-aside-art" src="${escapeHtml(aside.image)}" alt="" width="512" height="768" loading="lazy" decoding="async">
</aside>`]));
    const bodyHtml = asides.size
        ? doc.bodyHtml.replace(/<section class="doc-section" data-section="([^"]+)">[\s\S]*?<\/section>/g, (section, id) => section + (asides.get(id) || ''))
        : doc.bodyHtml;

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
        <header class="hero cat-panel${host ? ' has-host' : ''}">
            <div class="hero-copy">
                <p class="hero-kicker">${kicker}</p>
                <h1>${title}</h1>
                ${summary}
                <p class="hero-meta"><span>${sectionCount} sections</span><span aria-hidden="true">·</span><span>About ${doc.readingMinutes} min read</span></p>
            </div>${heroHost}
        </header>
        <p class="search-status" id="search-status" role="status" aria-live="polite" hidden></p>
        <article class="doc">
${bodyHtml}
        </article>
        <p class="empty-state" id="empty-state" hidden>${emptyState}</p>
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
 * Read the gender a user picked for a bundled assistant in the assistant picker.
 * @param {string|undefined} userRoot User data directory holding settings.json
 * @param {string} personality Assistant id, such as 'taro'
 * @returns {'male'|'female'|'neutral'}
 */
export function readAssistantGender(userRoot, personality) {
    if (!userRoot) {
        return 'neutral';
    }
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(userRoot, SETTINGS_FILE), 'utf8'));
        const gender = settings?.accountStorage?.[`neconyanAssistantGender:${personality}`];
        return ASSISTANT_GENDERS.includes(gender) ? gender : 'neutral';
    } catch {
        return 'neutral';
    }
}

function resolveDocsHost(host, gender) {
    if (!host) {
        return null;
    }
    return {
        name: host.name,
        pose: host.pose,
        greeting: host.greeting,
        emptyLine: host.emptyLine,
        asides: (host.asides || []).map(aside => ({
            after: aside.after,
            line: aside.line,
            image: `/img/neconyan/tour/${aside.scene}-${gender}.webp?v=${ASSISTANT_ART_VERSION}`,
        })),
        gender,
        image: `/img/neconyan/tour/${host.scene}-${gender}.webp?v=${ASSISTANT_ART_VERSION}`,
        icon: `/img/neconyan/assistant-icons/${host.personality}-${gender}.png?v=${ASSISTANT_ART_VERSION}`,
    };
}

/**
 * Read a registered document from disk and render its reader page.
 * @param {string} serverDirectory
 * @param {string} slug
 * @param {{ userRoot?: string }} [options] userRoot picks the host artwork the user chose in the assistant picker
 * @returns {string|null}
 */
export function renderRegisteredDocsPage(serverDirectory, slug, options = {}) {
    const page = Object.prototype.hasOwnProperty.call(DOCS_READER_PAGES, slug) ? DOCS_READER_PAGES[slug] : null;
    if (!page) {
        return null;
    }
    const markdown = fs.readFileSync(path.join(serverDirectory, page.file), 'utf8');
    const gender = page.host ? readAssistantGender(options.userRoot, page.host.personality) : 'neutral';
    return renderDocsPage(markdown, {
        rawHref: `/docs/${slug}.md`,
        kicker: page.kicker,
        summary: page.summary,
        host: resolveDocsHost(page.host, gender),
    });
}

const DOCS_READER_CSS = `
:root {
    --canvas: #161716;
    --surface: #242420;
    --raised: #302e29;
    --ink: #f6edda;
    --muted: #ddd0bf;
    --soft: #b9ad9d;
    --ginger: #d69270;
    --accent: #d69270;
    --accent-fill: #d69270;
    --accent-ink: #141514;
    --accent-wash: rgba(214, 146, 112, 0.14);
    --border: #61534d;
    --panel-border: color-mix(in oklch, var(--border) 88%, var(--ginger));
    --hairline: rgba(246, 237, 218, 0.1);
    --rail: #1b1c1a;
    --rail-ink: #f6edda;
    --rail-soft: #b9ad9d;
    --rail-field: #242420;
    --rail-border: #61534d;
    --mark: rgba(214, 146, 112, 0.38);
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
    --measure: 760px;
    --topbar: 64px;
    color-scheme: dark;
}
:root[data-theme="light"] {
    --canvas: #f6f2e8;
    --surface: #fffaf0;
    --raised: #efe6d6;
    --ink: #303331;
    --muted: #504c45;
    --soft: #66675f;
    --ginger: #b86b32;
    --accent: #944f26;
    --accent-fill: #944f26;
    --accent-ink: #fffaf0;
    --accent-wash: rgba(184, 107, 50, 0.1);
    --border: #d5cec0;
    --hairline: rgba(48, 51, 49, 0.1);
    --rail: #343735;
    --rail-ink: #f6edda;
    --rail-soft: #d3c9b9;
    --rail-field: #2a2c2b;
    --rail-border: #5d605c;
    --mark: rgba(214, 146, 112, 0.42);
    --shadow: 0 10px 28px rgba(84, 66, 44, 0.14);
    color-scheme: light;
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--topbar) + 16px); -webkit-text-size-adjust: 100%; }
body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: 'Nunito', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.65;
    text-rendering: optimizeLegibility;
}
body::before {
    content: '';
    position: fixed;
    inset: var(--topbar) 0 0;
    z-index: -1;
    pointer-events: none;
    background:
        url('/img/neconyan/paw-cream.webp') right 14px top 18px / 88px 88px no-repeat,
        url('/img/neconyan/paw-pink.webp') 92% 24% / 48px 48px no-repeat,
        url('/img/neconyan/paw-peach.webp') left 4px bottom 18px / 84px 84px no-repeat,
        url('/img/neconyan/paw-ink.webp') 76% 97% / 72px 72px no-repeat;
}
a { color: var(--accent); text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--ginger); outline-offset: 2px; border-radius: 6px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip-link { position: absolute; left: 12px; top: 12px; transform: translateY(-200%); z-index: 30; padding: 10px 14px; border-radius: 6px; background: var(--accent-fill); color: var(--accent-ink); font-weight: 800; }
.skip-link:focus { transform: none; }

.topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    height: var(--topbar);
    background: var(--rail);
    color: var(--rail-ink);
    border-bottom: 1px solid var(--rail-border);
}
.topbar-inner { display: flex; align-items: center; gap: 14px; height: 100%; max-width: 1240px; margin: 0 auto; padding: 0 20px; }
.brand { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; gap: 10px; color: var(--rail-ink); text-decoration: none; font-family: 'Fredoka One', 'Nunito', sans-serif; font-size: 20px; flex: none; }
.brand img { image-rendering: pixelated; }
.search { position: relative; display: flex; align-items: center; flex: 1; max-width: 480px; margin-left: auto; color: var(--rail-soft); }
.search svg { position: absolute; left: 14px; pointer-events: none; }
.search input {
    width: 100%;
    height: 44px;
    padding: 0 44px 0 42px;
    border: 1px solid var(--rail-border);
    border-radius: 10px;
    background: var(--rail-field);
    color: var(--rail-ink);
    font: inherit;
    font-size: 16px;
}
.search input::placeholder { color: var(--rail-soft); }
.search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    cursor: pointer;
    background: var(--rail-soft);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3 3l8 8M11 3l-8 8' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3 3l8 8M11 3l-8 8' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / contain no-repeat;
}
.search input::-webkit-search-cancel-button:hover { background: var(--rail-ink); }
.search input:focus { outline: 2px solid var(--ginger); outline-offset: 2px; }
.search-hint { position: absolute; right: 12px; padding: 1px 7px; border: 1px solid var(--rail-border); border-radius: 6px; font: 700 12px/1.4 'Nunito', sans-serif; color: var(--rail-soft); }
.search input:focus + .search-hint, .search input:not(:placeholder-shown) + .search-hint { display: none; }
.topbar-actions { display: flex; gap: 8px; flex: none; }
.icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 44px;
    height: 44px;
    padding: 0 12px;
    border: 1px solid var(--rail-border);
    border-radius: 10px;
    background: var(--rail-field);
    color: var(--rail-ink);
    font: 700 13px 'Nunito', sans-serif;
    cursor: pointer;
}
.icon-button:hover { border-color: var(--ginger); color: var(--ginger); }
:root[data-theme="dark"] .icon-moon, :root[data-theme="light"] .icon-sun { display: none; }
.toc-toggle { display: none; }

.layout {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    gap: 28px;
    max-width: 1240px;
    margin: 0 auto;
    padding: 0 20px;
}
.toc {
    position: sticky;
    top: calc(var(--topbar) + 38px);
    align-self: start;
    max-height: calc(100vh - var(--topbar) - 58px);
    overflow-y: auto;
    margin-top: 38px;
    padding: 16px 10px 14px;
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    background: var(--surface);
    scrollbar-width: thin;
}
.toc-heading { margin: 0 0 8px 10px; font: 400 17px/1.2 'Fredoka One', 'Nunito', sans-serif; color: var(--ink); }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc-list > li { margin: 1px 0; }
.toc-list ol { margin: 1px 0 6px 12px; padding-left: 8px; border-left: 2px solid var(--hairline); }
.toc a { display: block; padding: 6px 10px; border-radius: 10px; color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 700; line-height: 1.35; }
.toc-list ol a { font-size: 13px; font-weight: 600; color: var(--soft); padding: 5px 10px; }
.toc a:hover { background: var(--accent-wash); color: var(--ink); }
.toc a.is-active { background: var(--accent-wash); color: var(--accent); font-weight: 800; }
.toc li.is-filtered-out { display: none; }
.toc a.raw-link { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--hairline); border-radius: 0; color: var(--soft); font-size: 13px; }

.content { min-width: 0; padding: 38px 0 120px; outline: none; }
.hero, .doc, .search-status, .empty-state { max-width: var(--measure); }
.cat-panel { position: relative; isolation: isolate; }
.cat-panel::before, .cat-panel::after {
    content: '';
    position: absolute;
    top: 0;
    z-index: 0;
    width: 30px;
    height: 22px;
    pointer-events: none;
    transform-origin: center bottom;
}
.cat-panel::before { left: 8%; transform: translateY(-100%) skewX(-7deg); background: url('/img/neconyan/ear-left.webp') center / 100% 100% no-repeat; }
.cat-panel::after { right: 8%; transform: translateY(-100%) skewX(7deg); background: url('/img/neconyan/ear-right.webp') center / 100% 100% no-repeat; }
.hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 190px;
    grid-template-areas: "copy host" "speech host";
    column-gap: 20px;
    margin: 22px 0 20px;
    padding: 26px 28px 0;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--surface);
}
.hero:not(.has-host) { grid-template-columns: minmax(0, 1fr); grid-template-areas: "copy"; padding-bottom: 24px; }
.hero-copy { grid-area: copy; }
.hero-kicker { margin: 0 0 4px; color: var(--accent); font-weight: 800; font-size: 13px; }
.hero h1 { margin: 0; font-family: 'Fredoka One', 'Nunito', sans-serif; font-weight: 400; font-size: clamp(32px, 4.4vw, 44px); line-height: 1.1; }
.hero-summary { margin: 12px 0 0; color: var(--muted); font-size: 18px; line-height: 1.55; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; color: var(--soft); font-size: 13px; font-weight: 700; }
.hero-speech {
    grid-area: speech;
    position: relative;
    align-self: start;
    margin: 18px 0 26px;
    padding: 12px 16px 14px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--raised);
}
.hero-speech::after {
    content: '';
    position: absolute;
    right: -8px;
    top: 26px;
    width: 14px;
    height: 14px;
    border: solid var(--panel-border);
    border-width: 1px 1px 0 0;
    background: var(--raised);
    transform: rotate(45deg);
}
.hero-speech p { margin: 0; color: var(--ink); font-size: 15px; line-height: 1.6; }
.hero-speech .hero-speaker { margin-bottom: 2px; color: var(--accent); font: 400 16px/1.3 'Fredoka One', 'Nunito', sans-serif; }
.hero-host { grid-area: host; align-self: end; display: block; width: 190px; height: auto; margin-top: 8px; filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.25)); }
.host-aside { display: flex; align-items: center; gap: 16px; max-width: var(--measure); margin: -4px 0 14px; padding: 0 18px; }
.host-aside-left { flex-direction: row-reverse; }
.host-aside-bubble {
    position: relative;
    flex: 1;
    max-width: 520px;
    margin-left: auto;
    padding: 12px 16px 14px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--raised);
    box-shadow: var(--shadow);
}
.host-aside-left .host-aside-bubble { margin: 0 auto 0 0; }
.host-aside-bubble::after {
    content: '';
    position: absolute;
    top: calc(50% - 7px);
    right: -8px;
    width: 14px;
    height: 14px;
    border: solid var(--panel-border);
    border-width: 1px 1px 0 0;
    background: var(--raised);
    transform: rotate(45deg);
}
.host-aside-left .host-aside-bubble::after { right: auto; left: -8px; border-width: 0 0 1px 1px; }
.doc .host-aside-bubble p { margin: 0; color: var(--ink); font-size: 15px; line-height: 1.6; }
.doc .host-aside-bubble .hero-speaker { margin-bottom: 2px; color: var(--accent); font: 400 16px/1.3 'Fredoka One', 'Nunito', sans-serif; }
.host-aside-art { flex: none; display: block; width: 120px; height: auto; filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.25)); }

.doc-intro, .doc-section {
    margin: 0 0 18px;
    padding: 22px 26px 8px;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    background: var(--surface);
}
.doc h2 {
    margin: 0 0 14px;
    font-family: 'Fredoka One', 'Nunito', sans-serif;
    font-weight: 400;
    font-size: 27px;
    line-height: 1.2;
    color: var(--ink);
}
.doc h3 { margin: 28px 0 10px; padding-top: 20px; border-top: 1px dashed var(--hairline); font-size: 19px; font-weight: 800; line-height: 1.3; color: var(--ink); }
.doc h2 + h3 { margin-top: 8px; padding-top: 0; border-top: 0; }
.doc h2, .doc h3 { position: relative; outline: none; }
.heading-anchor { margin-left: 10px; color: var(--soft); text-decoration: none; font-family: 'Nunito', sans-serif; font-weight: 700; opacity: 0; }
.doc h2:hover .heading-anchor, .doc h3:hover .heading-anchor, .heading-anchor:focus-visible { opacity: 1; }
.doc p { margin: 0 0 14px; color: var(--muted); }
.doc strong { color: var(--ink); font-weight: 800; }
.doc p.term {
    padding: 12px 16px;
    margin: 0 0 10px;
    border-radius: 8px;
    background: var(--raised);
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
.doc ul, .doc ol { margin: 0 0 14px; padding-left: 24px; color: var(--muted); }
.doc li { margin: 4px 0; }
.doc li::marker { color: var(--ginger); }

.table-wrap {
    margin: 6px 0 18px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
}
.doc table { width: 100%; border-collapse: collapse; font-size: 15px; line-height: 1.55; }
.doc th {
    padding: 10px 16px;
    background: var(--raised);
    color: var(--ink);
    text-align: left;
    font-weight: 800;
    font-size: 13px;
}
.doc td { padding: 11px 16px; border-top: 1px solid var(--hairline); color: var(--muted); vertical-align: top; }
.doc td.cell-lead { width: 32%; min-width: 150px; color: var(--ink); font-weight: 700; }
.doc tbody tr:hover td { background: var(--accent-wash); }

.callout {
    margin: 6px 0 18px;
    padding: 12px 16px 2px;
    border: 1px dashed color-mix(in srgb, var(--ginger) 60%, transparent);
    border-radius: 8px;
    background: var(--accent-wash);
}
.doc .callout .callout-title { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; color: var(--accent); font-weight: 800; font-size: 13px; }
.callout-title::before { content: ''; width: 18px; height: 18px; flex: none; background: url('/img/neconyan/paw-peach.webp') center / contain no-repeat; }
.doc .callout p { color: var(--ink); }

mark { padding: 0 2px; border-radius: 4px; background: var(--mark); color: inherit; }
.is-filtered-out { display: none !important; }
.search-status { margin: 0 0 12px; padding: 8px 14px; border: 1px solid var(--panel-border); border-radius: 10px; background: var(--surface); color: var(--muted); font-size: 14px; font-weight: 700; }
.empty-state { display: flex; align-items: center; gap: 14px; margin: 0; padding: 16px 18px; border: 1px solid var(--panel-border); border-radius: 8px; background: var(--surface); color: var(--muted); }
.empty-state[hidden] { display: none; }
.empty-state strong { color: var(--ink); }
.empty-host { flex: none; width: 64px; height: 64px; }

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
    border: 1px solid var(--panel-border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--accent);
    box-shadow: var(--shadow);
    cursor: pointer;
}
.back-to-top[hidden] { display: none; }

@media (max-width: 1024px) {
    .layout { grid-template-columns: 220px minmax(0, 1fr); gap: 22px; }
    .hero { grid-template-columns: minmax(0, 1fr) 150px; }
    .hero-host { width: 150px; }
}
@media (max-width: 768px) {
    :root { --topbar: 60px; }
    .topbar-inner { gap: 8px; padding: 0 12px; }
    .brand span { display: none; }
    .search { max-width: none; }
    .search input { padding-right: 12px; }
    .search-hint { display: none; }
    .toc-toggle { display: inline-flex; }
    .toc-toggle span { display: none; }
    .layout { display: block; padding: 0 12px; }
    .toc {
        position: fixed;
        top: var(--topbar);
        left: 0;
        right: 0;
        z-index: 18;
        max-height: min(70vh, calc(100vh - var(--topbar)));
        margin: 0;
        padding: 12px 12px calc(16px + env(safe-area-inset-bottom));
        border-width: 0 0 1px;
        border-radius: 0 0 12px 12px;
        box-shadow: var(--shadow);
        overscroll-behavior: contain;
        visibility: hidden;
        opacity: 0;
        transform: translateY(-8px);
    }
    body.toc-open .toc { visibility: visible; opacity: 1; transform: none; }
    .toc a { min-height: 44px; display: flex; align-items: center; font-size: 15px; }
    .toc-list ol a { font-size: 14px; }
    .content { padding: 30px 0 96px; }
    .hero {
        grid-template-columns: minmax(0, 1fr) 96px;
        grid-template-areas: "copy host" "speech speech";
        column-gap: 8px;
        margin-top: 20px;
        padding: 20px 16px 0;
    }
    .hero h1 { font-size: 30px; }
    .hero-summary { font-size: 16.5px; }
    .hero-speech { margin: 4px 0 18px; padding: 10px 12px 12px; }
    .hero-speech::after { top: -8px; right: 40px; border-width: 1px 0 0 1px; }
    .hero-speech p { font-size: 14.5px; }
    .hero-host { width: 96px; margin-top: 0; }
    .doc-intro, .doc-section { padding: 18px 16px 6px; }
    .doc h2 { font-size: 24px; }
    .doc h3 { font-size: 18px; }
    .heading-anchor { display: none; }
    .doc p.term { padding: 10px 12px; }
    .table-wrap { border: 0; overflow: visible; }
    .doc table, .doc tbody, .doc tr, .doc td { display: block; width: 100%; }
    .doc thead { display: none; }
    .doc tr.doc-row {
        margin: 0 0 10px;
        padding: 12px 14px;
        border-radius: 8px;
        background: var(--raised);
    }
    .doc td { padding: 2px 0; border: 0; text-align: left !important; }
    .doc td.cell-lead { width: 100%; min-width: 0; padding-bottom: 6px; font-size: 16px; }
    .doc td:not(.cell-lead)::before {
        content: attr(data-label);
        display: block;
        margin-top: 4px;
        color: var(--soft);
        font-size: 12px;
        font-weight: 800;
    }
    .doc td:not(.cell-lead)[data-label="What it does"]::before,
    .doc td:not(.cell-lead)[data-label="Description"]::before,
    .doc td:not(.cell-lead)[data-label="Meaning"]::before { display: none; }
    .doc tbody tr:hover td { background: none; }
    .empty-host { width: 52px; height: 52px; }
    .host-aside { gap: 10px; margin: -6px 0 12px; padding: 0 2px; }
    .host-aside-bubble { padding: 10px 12px 12px; }
    .doc .host-aside-bubble p { font-size: 14.5px; }
    .host-aside-art { width: 84px; }
    .back-to-top { right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); }
}
@keyframes docs-ear-twitch-left {
    0%, 100% { transform: translateY(-100%) skewX(-7deg); }
    38% { transform: translateY(-100%) skewX(-13deg); }
    68% { transform: translateY(-100%) skewX(-3deg); }
}
@keyframes docs-ear-twitch-right {
    0%, 100% { transform: translateY(-100%) skewX(7deg); }
    38% { transform: translateY(-100%) skewX(13deg); }
    68% { transform: translateY(-100%) skewX(3deg); }
}
@media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    .toc a, .icon-button, .heading-anchor { transition: background-color 160ms ease-out, color 160ms ease-out, border-color 160ms ease-out, opacity 160ms ease-out; }
    .cat-panel:hover::before { animation: docs-ear-twitch-left 320ms ease-out; }
    .cat-panel:hover::after { animation: docs-ear-twitch-right 320ms ease-out; }
    @media (max-width: 768px) {
        .toc { transition: opacity 180ms ease-out, transform 180ms ease-out, visibility 180ms; }
    }
}
@media print {
    .topbar, .toc, .back-to-top, .search-status, .hero-host, .host-aside, .cat-panel::before, .cat-panel::after { display: none !important; }
    body::before { display: none; }
    .layout { display: block; }
    body { background: #fff; color: #000; }
    .hero, .doc-intro, .doc-section { border: 0; background: none; padding: 0; }
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
    var hostAsides = Array.prototype.slice.call(document.querySelectorAll('.host-aside'));
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
        hostAsides.forEach(function (aside) { aside.classList.add('is-filtered-out'); });
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
