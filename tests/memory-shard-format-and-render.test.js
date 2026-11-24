import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import css from '@adobe/css-tools';
import {
    MEMORY_SHARD_STANDARD_SECTIONS,
    countMemoryShardSectionLines,
    getMemoryShardSectionMeta,
    getMissingMemoryShardStandardSections,
    isMemoryShardTarget,
    parseMemoryShardDocument,
    serializeMemoryShardDocument,
    summarizeMemoryShardSection,
} from '../public/scripts/extensions/in-chat-agents/companion/memory-shard-format.js';
import { applyRegexScriptList } from '../public/scripts/extensions/in-chat-agents/regex-scripts.js';

const require = createRequire(import.meta.url);
const showdown = require('showdown');

const TEMPLATE_PATH = path.resolve(
    process.cwd(),
    '../public/scripts/extensions/in-chat-agents/templates/memory-shard-companion.json',
);

const SAMPLE_V3_SHARD = [
    '# MEMORY SHARD: ASH-3',
    '',
    '## Current Snapshot',
    '- Location: Flooded chapel beneath the old conservatory',
    '- Time: Past midnight, heavy storm outside',
    '- Present: Aria, Thorne',
    '- Situation: Aria just opened the iron strongbox and found her sister\'s wax seal inside.',
    '- Mood: Raw shock giving way to fragile truce',
    '- Physical: Aria\'s left forearm is bandaged; Thorne is soaked through and guarding the stairs',
    '- Next up: Decide whether to confront the regent before dawn or flee across the river',
    '',
    '## Tone & Atmosphere',
    'Gothic mystery with slow-burn tension, taut dialogue, and weathered candlelight.',
    '',
    '## Characters',
    '### Aria',
    '- Role: Protagonist and disinherited archivist',
    '- Appearance: Dark coat, singed cuff, bandaged left forearm',
    '- Personality: Sharp-tongued, loyal, slow to forgive',
    '- Abilities: Forgery detection, lockpicking, keen memory for ledgers',
    '- Status: Alive, injured left forearm, shaken but resolved',
    '- Growth: Realised Thorne hid the original ledger to protect her sister rather than the regent.',
    '',
    '## Relationships',
    '- Aria -> Thorne (fragile truce): Bitter betrayal softened after seeing the real seal; trust is still thin.',
    '- Thorne -> Aria (protective guilt): Willing to burn his own standing to keep her alive.',
    '',
    '## World & Setting',
    '- Conservatory Vault: Only the bearer of a twin wax seal can unlock the inner archive.',
    '',
    '## Story Events',
    '### 1. [Critical] The Strongbox Revealed (Flooded Chapel)',
    '- What happened: Aria pried open the iron box and discovered her sister\'s unbroken seal beside Thorne\'s forged death writ.',
    '- Aftermath: The accusation of treason against Thorne collapsed, shifting suspicion directly onto the regent.',
    '- Emotions & state: Aria trembled in disbelief while Thorne kept his hand steady on the lantern.',
    '',
    '### 2. [Major] Footsteps on the Upper Stairs (Chapel Stairwell)',
    '- What happened: Lantern light swept across the stairwell, forcing both of them behind the stone pillar.',
    '- Aftermath: Their exit through the east courtyard is now cut off.',
    '',
    '## Key Scenes',
    '### The Wax Seal in the Rain',
    'Water dripped from the cracked arches onto the iron lid as Aria turned the seal toward the flame. For three winters she had cursed Thorne\'s name for a fire he never lit, and now the proof sat warm in her palm.',
    '',
    '## Memorable Quotes & Voices',
    '- Aria: "You let me hate you for three winters just to keep her breathing." (quiet, incredulous)',
    '- Thorne: "Hate kept you sharp. Trust would have got you killed." (flat, steady)',
    '',
    '## Sensory Anchors',
    '- Wet cedar smoke and candle wax (Smell): Clings to the vault papers and signals the regent\'s private seal.',
    '',
    '## Callbacks & Loose Threads',
    '- [Open] The missing second ledger: Still locked inside the regent\'s study; only Thorne knows the cipher.',
    '- [Planted] Silver ferry token: Tucked inside Aria\'s boot from the dockmaster in chapter one.',
    '- [Resolved] The burned archive accusation: Proven to be a staged cover-up to hide Aria\'s sister.',
].join('\n');

const SAMPLE_V2_SHARD = [
    '# MEMORY SHARD: ASH-1',
    '',
    '## Shard Reference Key',
    '- `|` separates fields.',
    '',
    '## Character Registry',
    'Aria|protagonist|tall,scarred|guarded,loyal|lockpicking|alive,injured',
    '',
    '## Events',
    '1. Aria broke into the vault -> found empty shelf -> escaped, 4',
    '',
    '## Current State',
    '- Location: East courtyard',
    '- Present: Aria',
].join('\n');

function renderShardWithTemplateRegex(rawContent) {
    const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    const transformed = applyRegexScriptList(
        rawContent,
        template.regexScripts,
        2,
        { isMarkdown: true },
    );
    const converter = new showdown.Converter({
        simpleLineBreaks: true,
        tables: true,
        strikethrough: true,
    });
    return {
        transformed,
        html: converter.makeHtml(transformed),
    };
}

describe('memory-shard-format parser and serializer', () => {
    test('parses and losslessly round-trips a structured v3 shard', () => {
        const parsed = parseMemoryShardDocument(SAMPLE_V3_SHARD);
        expect(parsed.title).toBe('MEMORY SHARD: ASH-3');
        expect(parsed.preamble).toBe('');
        expect(parsed.sections.map(section => section.heading)).toEqual([
            'Current Snapshot',
            'Tone & Atmosphere',
            'Characters',
            'Relationships',
            'World & Setting',
            'Story Events',
            'Key Scenes',
            'Memorable Quotes & Voices',
            'Sensory Anchors',
            'Callbacks & Loose Threads',
        ]);

        const rebuilt = serializeMemoryShardDocument(parsed);
        expect(rebuilt).toBe(SAMPLE_V3_SHARD);
    });

    test('preserves fenced code blocks containing markdown headings inside a section', () => {
        const doc = [
            '# MEMORY SHARD: CODE-1',
            '',
            '## World & Setting',
            '- Cipher note:',
            '```markdown',
            '## Not A Real Section',
            '# Also Not A Title',
            '```',
            '- End note: Still inside World & Setting.',
            '',
            '## Current Snapshot',
            '- Location: Study',
        ].join('\n');

        const parsed = parseMemoryShardDocument(doc);
        expect(parsed.sections.map(s => s.heading)).toEqual(['World & Setting', 'Current Snapshot']);
        expect(parsed.sections[0].body).toContain('## Not A Real Section');
        expect(serializeMemoryShardDocument(parsed)).toBe(doc);
    });

    test('handles legacy v2 shards and custom headings gracefully', () => {
        const parsed = parseMemoryShardDocument(SAMPLE_V2_SHARD);
        expect(parsed.title).toBe('MEMORY SHARD: ASH-1');
        expect(parsed.sections.map(s => s.heading)).toEqual([
            'Shard Reference Key',
            'Character Registry',
            'Events',
            'Current State',
        ]);

        expect(getMemoryShardSectionMeta('Current State').tone).toBe('current');
        expect(getMemoryShardSectionMeta('Character Registry').tone).toBe('characters');
        expect(getMemoryShardSectionMeta('NSFW Registry').tone).toBe('intimate');
        expect(getMemoryShardSectionMeta('Faction Debts').tone).toBe('custom');
        expect(getMemoryShardSectionMeta('Faction Debts').icon).toBe('fa-solid fa-bookmark');
    });

    test('detects Memory Shard targets by template id, name, or shard heading', () => {
        expect(isMemoryShardTarget({ agent: { sourceTemplateId: 'tpl-memory-shard-companion' } })).toBe(true);
        expect(isMemoryShardTarget({ agent: { name: 'Memory Shard' } })).toBe(true);
        expect(isMemoryShardTarget({ agent: { name: 'Story Notes' }, content: '# MEMORY SHARD: ARC-2\n\n## Current Snapshot' })).toBe(true);
        expect(isMemoryShardTarget({ agent: { name: 'Story Notes' }, content: '# CONSOLIDATED MEMORY SHARD: ARC-MASTER' })).toBe(true);
        expect(isMemoryShardTarget({ agent: { name: 'Vitals Tracker' }, content: 'HP: 100/100' })).toBe(false);
    });

    test('computes section previews, line counts, and missing standard presets', () => {
        const parsed = parseMemoryShardDocument(SAMPLE_V3_SHARD);
        expect(summarizeMemoryShardSection(parsed.sections[0].body)).toContain('Location: Flooded chapel');
        expect(countMemoryShardSectionLines(parsed.sections[0].body)).toBe(7);
        const missing = getMissingMemoryShardStandardSections(parsed.sections);
        expect(missing.map(section => section.heading)).toEqual(['Intimate Moments']);
        expect(MEMORY_SHARD_STANDARD_SECTIONS.length).toBeGreaterThanOrEqual(10);
    });
});

describe('memory-shard HTML regex presentation', () => {
    test('renders v3 shard into structured cards, pills, and clean Showdown HTML', () => {
        const { transformed, html } = renderShardWithTemplateRegex(SAMPLE_V3_SHARD);
        expect(transformed).toContain('<style>');

        const $ = cheerio.load(html);
        expect($('style').length).toBe(1);
        expect($('.ms-hero .ms-hero-code').text()).toBe('ASH-3');
        expect($('.ms-sec-snapshot .ms-sec-title').text()).toBe('Current Snapshot');
        expect($('.ms-sec-snapshot + ul > li').length).toBe(7);
        expect($('.ms-sec-snapshot + ul > li .ms-kv-k').first().text()).toBe('Location');

        expect($('.ms-sub.ms-ev').length).toBe(2);
        expect($('.ms-sub.ms-ev .ms-ev-num').eq(0).text()).toBe('1');
        expect($('.ms-sub.ms-ev .ms-ev-loc').eq(0).text()).toContain('Flooded Chapel');
        expect($('.ms-tag-critical').text()).toBe('Critical');
        expect($('.ms-tag-major').text()).toBe('Major');

        expect($('.ms-rel-pair').length).toBe(2);
        expect($('.ms-rel-a').first().text()).toBe('Aria');
        expect($('.ms-rel-b').first().text()).toBe('Thorne');
        expect($('.ms-rel-note').first().text()).toBe('fragile truce');

        expect($('.ms-tag-open').text()).toBe('Open');
        expect($('.ms-tag-planted').text()).toBe('Planted');
        expect($('.ms-tag-resolved').text()).toBe('Resolved');
        expect($('.ms-thread-title').first().text()).toBe('The missing second ledger');

        // Key scene prose attaches directly after the subheading card
        expect($('.ms-sub + p').text()).toContain('Water dripped from the cracked arches');

        // Ensure Showdown did not wrap block divs in stray <p> tags
        expect($('p > .ms-hero').length).toBe(0);
        expect($('p > .ms-sec').length).toBe(0);
        expect($('p > .ms-sub').length).toBe(0);
    });

    test('renders consolidated master shard and code-fenced shards cleanly', () => {
        const fenced = '```markdown\n# CONSOLIDATED MEMORY SHARD: ARC-MASTER\n\n## Current Snapshot\n- **Location:** Harbour\n```';
        const { html } = renderShardWithTemplateRegex(fenced);
        const $ = cheerio.load(html);

        expect($('.ms-hero-master').length).toBe(1);
        expect($('.ms-hero-code').text()).toBe('ARC-MASTER');
        expect($('.ms-kv-k').text()).toBe('Location');
        expect($('.ms-kv-v').text()).toBe('Harbour');
        expect($('pre code').length).toBe(0);
    });

    test('still styles legacy v2 shards cleanly without dropping content', () => {
        const { html } = renderShardWithTemplateRegex(SAMPLE_V2_SHARD);
        const $ = cheerio.load(html);

        expect($('.ms-hero-code').text()).toBe('ASH-1');
        expect($('.ms-sec-key .ms-sec-title').text()).toBe('Shard Reference Key');
        expect($('.ms-sec-chars .ms-sec-title').text()).toBe('Character Registry');
        expect($('.ms-sec-events .ms-sec-title').text()).toBe('Events');
        expect($('.ms-sec-snapshot .ms-sec-title').text()).toBe('Current State');
        expect(html).toContain('Aria broke into the vault');
    });

    test('regex stylesheet parses cleanly via @adobe/css-tools and has no macro/dollar hazards', () => {
        const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
        const styleScript = template.regexScripts.find(s => s.id === 'memory-shard-styles');
        expect(styleScript).toBeDefined();

        const match = styleScript.replaceString.match(/<style>([\s\S]*?)<\/style>/);
        expect(match).not.toBeNull();
        const cssText = match[1];

        expect(cssText).not.toContain('{{');
        expect(cssText).not.toMatch(/\$\d|\$</);
        expect(cssText).toContain('prefers-reduced-motion');
        // Never target .fa-* directly because DOMPurify does not add custom- to fa-*
        expect(cssText).not.toMatch(/\.fa-[a-z0-9-]+/i);

        const parsed = css.parse(cssText);
        expect(parsed.stylesheet.rules.length).toBeGreaterThan(20);
    });
});
