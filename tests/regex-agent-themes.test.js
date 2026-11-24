import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import css from '@adobe/css-tools';
import { readFileSync } from 'node:fs';
import { ARCHETYPES, PREVIEWABLE_ARCHETYPES, SPECS, THEMABLE_TEMPLATE_IDS, getSpec } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/specs.js';
import { STOCK, getStock } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/stock.js';
import { TRACKER_FAMILIES, TEMPLATE_LABELS } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/template-catalog.js';
import { buildAgentScripts } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/build.js';
import { buildReplaceString } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/render/index.js';
import { applyList, regexFromString } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/interpolate.js';
import { PREVIEW_KEYS, renderPreviewHtml } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/preview.js';
import { SAMPLES } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/samples.js';
import { THEMES, getTheme } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/themes/index.js';
import { resolveTheme } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/tokens.js';
import { composite, contrastRatio, flattenColor, parseColor } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/color.js';
import { applyAll, applyToAgent, inspectAgent, reconcile, revertAgent } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/apply.js';
import { __setHostForTests } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/host.js';
import { DEFAULTS, getSettings, resolveThemeSlug, updateSettings } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/settings.js';
import { SETTINGS_KEY, STOCK_THEME } from '../public/scripts/extensions/third-party/Neconyan-Regex-Agent-Themes/src/constants.js';

const templates = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, templates), 'utf8'));
const bundles = read('regex-bundles.json');
const scriptsFor = id => structuredClone(bundles[id] ?? read(`${id.slice(4)}.json`).regexScripts);
const theme = THEMES[0];
const settings = () => ({ ...structuredClone(DEFAULTS), theme: theme.slug });
const agentFor = id => ({ id: `agent-${id}`, name: id, sourceTemplateId: id, version: 5,
    phaseLocked: false, prompt: 'Keep my instructions', regexScripts: scriptsFor(id) });

describe('bundled tracker contracts', () => {
    test('covers both current tracker groups and each bundled script exactly', () => {
        const groups = read('groups.json');
        for (const [group, family] of [['grp-pura-trackers', 'pura'], ['grp-pura-ethereality-trackers', 'ethereal']]) {
            const ids = groups.find(item => item.id === group).agentTemplateIds;
            expect(Object.keys(TRACKER_FAMILIES).filter(id => TRACKER_FAMILIES[id] === family).sort()).toEqual([...ids].sort());
        }
        expect(new Set(THEMABLE_TEMPLATE_IDS)).toEqual(new Set(Object.keys(TEMPLATE_LABELS)));
        expect(SPECS).toHaveLength(STOCK.length);
        for (const id of THEMABLE_TEMPLATE_IDS) {
            expect(TEMPLATE_LABELS[id]).toBe(read(`${id.slice(4)}.json`).name);
            expect(SPECS.filter(spec => spec.templateId === id).map(spec => spec.scriptId).sort())
                .toEqual(scriptsFor(id).map(script => script.id).sort());
            for (const script of scriptsFor(id)) {
                const spec = getSpec(id, script.id);
                const baseline = getStock(id, script.id);
                expect(baseline).toMatchObject({ findRegex: script.findRegex, replaceString: script.replaceString });
                const regex = regexFromString(script.findRegex);
                const count = new RegExp(`${regex.source}|`, regex.flags.replace(/[gy]/g, '')).exec('').length - 1;
                expect(spec.groups).toBe(count);
                expect(baseline.groups).toBe(count);
            }
            const report = inspectAgent(agentFor(id), settings());
            expect(report.perScript.filter(entry => !entry.owned && !['stock', 'pristine'].includes(entry.status))).toEqual([]);
        }
    });

    test('all themes preserve every display capture and source-facing pattern', () => {
        for (const selected of THEMES) {
            for (const id of THEMABLE_TEMPLATE_IDS) {
                const originals = scriptsFor(id);
                const built = buildAgentScripts(id, originals, selected, { meters: true });
                expect(built.skipped).toEqual([]);
                for (const original of originals.filter(script => !getSpec(id, script.id).regenerateFindRegex)) {
                    const script = built.scripts.find(item => item.id === original.id);
                    expect(script.findRegex).toBe(original.findRegex);
                    expect({ ...script, replaceString: original.replaceString }).toEqual(original);
                }
                for (const original of originals.filter(script => !getSpec(id, script.id).passthrough && !getSpec(id, script.id).regenerateFindRegex)) {
                    const spec = getSpec(id, original.id);
                    const script = built.scripts.find(item => item.id === original.id);
                    const refs = new Set([...script.replaceString.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
                    const required = Array.from({ length: spec.groups }, (_, i) => i + 1).filter(g => g !== spec.hue?.g);
                    expect({ id: original.id, missing: required.filter(g => !refs.has(g)), invalid: [...refs].filter(g => g > spec.groups) })
                        .toEqual({ id: original.id, missing: [], invalid: [] });
                }
            }
        }
    });

    for (const id of ['tpl-cyoa-choices', 'tpl-cyoa-choices-skill-checks']) {
        test(`${id} retains seven choices and removes unused rows`, () => {
            const built = buildAgentScripts(id, scriptsFor(id), theme);
            const text = '[CHOICES]\n' + Array.from({ length: 7 }, (_, i) => `${i + 1}. Action ${i + 1}`).join('\n') + '\n[/CHOICES]';
            const full = applyList(text, built.scripts);
            expect(full.match(/data-rat-part="slot"/g)).toHaveLength(7);
            for (let i = 1; i <= 7; i++) expect(full).toContain(`>${i}.</span> Action ${i}`);
            const partial = applyList(SAMPLES.choices.partial, built.scripts);
            expect(partial.match(/data-rat-part="slot"/g)).toHaveLength(2);
            expect(partial).not.toContain('[CHOICES]');
            expect(built.added).toEqual([]);
        });
    }

    test('current relationship card retains portrait, every field and concealed thoughts', () => {
        const id = 'tpl-relationship-tracker';
        const built = buildAgentScripts(id, scriptsFor(id), theme, { meters: true });
        const rendered = applyList(SAMPLES['relationship-bond'].full, built.scripts);
        expect(rendered).toContain('/thumbnail/portrait?name=Mira&amp;char={{char}}');
        expect(rendered).toContain('Tell her who sent you');
        expect(rendered).toContain('Route Progress');
        expect(rendered).toContain('Keepsake Memory');
        expect(rendered).toContain('Would Say Yes To');
        expect(rendered).toContain('Turning Point');
        expect(rendered).toContain('Next Threshold');
        expect(rendered).toContain('data-rat-part="stepper"');
        expect(rendered).toMatch(/<details data-rat-part="row"[^>]*><summary>.*?Unsaid:.*?<\/summary><span data-rat-part="row-value">I hoped you would stay<\/span><\/details>/);
        expect(rendered.match(/role="progressbar"/g)).toHaveLength(4);
        expect(rendered).not.toContain('[METER');
        expect(rendered).not.toMatch(/\$\d+/);
    });

    test('relationship card header wraps its status pill instead of squeezing the name on any theme', () => {
        const id = 'tpl-relationship-tracker';
        const stock = getStock(id, 'c81e4b95-2d7a-4a60-8f3c-7b9e0d6a4c22');
        const outputs = [['stock', applyList(SAMPLES['relationship-bond'].full, [stock])]];
        for (const selected of THEMES) {
            outputs.push([selected.slug, applyList(SAMPLES['relationship-bond'].full, buildAgentScripts(id, scriptsFor(id), selected).scripts)]);
        }
        for (const [slug, rendered] of outputs) {
            const summary = rendered.match(/<summary[^>]* style="[^"]*"[\s\S]*?<\/summary>/)?.[0] ?? '';
            const summaryStyle = summary.match(/^<summary[^>]* style="([^"]*)"/)?.[1] ?? '';
            expect({ slug, wraps: /flex-wrap:\s*wrap/.test(summaryStyle) }).toEqual({ slug, wraps: true });
            expect({ slug, nameFloor: /flex:\s*1 1 0;\s*min-width:\s*min\(7em,\s*100%\)/.test(summary) }).toEqual({ slug, nameFloor: true });
            expect({ slug, nowrap: summary.includes('nowrap') }).toEqual({ slug, nowrap: false });
            expect(summary).toContain('Mira');
        }
    });

    for (const [id, text, values, parts] of [
        ['tpl-the-ledger', '[LEDGER|Mira|A lost hour|Before dawn]\ncontext: The clerk is waiting\n[/LEDGER]', ['Mira', 'A lost hour', 'Before dawn', 'The clerk is waiting', 'OWED TO THE STRANGE', 'What Is Owed', 'audit'], { row: 2 }],
        ['tpl-the-census', '[CENSUS:LODGER|Mira]\nb: Archivist\n[/CENSUS]', ['Mira', 'Archivist', 'LODGER', 'filed, provisionally'], { section: 1 }],
        ['tpl-doors-fate-checks', '[DOORS]\n1. Take the stairs [LUCK 12]\n2. Knock\n[/DOORS]', ['Take the stairs [LUCK 12]', 'Knock', 'THE CORRIDOR', 'one is ajar'], { row: 1 }],
        ['tpl-four-winds', '[WINDS]\nA. North\nB. South\n[/WINDS]', ['A. North', 'B. South', 'The Four Winds', 'choose a weather'], { slot: 2 }],
        ['tpl-drift-tracker', '[DRIFT|SLIGHTLY ASKANCE|A faint tilt in the floorboards]\nThe staircase has one more step than yesterday.\n[/DRIFT]', ['SLIGHTLY ASKANCE', 'A faint tilt in the floorboards', 'The staircase has one more step than yesterday.', 'D R I F T'], { row: 1 }],
        ['tpl-clock-is-lying', '[HOUR|3:14 PM|The Hour of Unmailed Letters|the pendulum hesitates]\nnote: All wristwatches in the parlour agree to disagree.\n[/HOUR]', ['3:14 PM', 'The Hour of Unmailed Letters', 'the pendulum hesitates', 'The Clock Is Lying'], { row: 1 }],
        ['tpl-small-miracles', '[CERT|The Teacup That Refused to Cool|Domestic Grace|staying warm through three chapters]\nstamp: Witnessed by the parlour cat\n[/CERT]', ['The Teacup That Refused to Cool', 'Domestic Grace', 'staying warm through three chapters', 'Witnessed by the parlour cat', 'Certificate of Miracle', 'E. Thistlewood'], { row: 2 }],
        ['tpl-the-committee', '[VOICE|The Brigadier|LOUD|Alarmed]\nsays: We must fortify the umbrella stand at once.\n[/VOICE]', ['The Brigadier', 'LOUD', 'Alarmed', 'We must fortify the umbrella stand at once.', 'MINUTES WERE TAKEN, THEN LOST'], { row: 1 }],
        ['tpl-thought-cabinet', '[THOUGHT|The Architecture of Regret|INTERNALIZING|2h remaining]\nnote: Every hallway eventually leads back to the kitchen.\n[/THOUGHT]', ['The Architecture of Regret', 'INTERNALIZING', '2h remaining', 'Tenancy Report', 'FURNITURE MAY SHIFT IN TRANSIT'], { row: 1 }],
        ['tpl-the-becoming', '[BECOMING|A Tourist|Someone Who Knows the Postman|WEARING THIN]\nnote: You stopped checking the street signs.\n[/BECOMING]', ['A Tourist', 'Someone Who Knows the Postman', 'WEARING THIN', 'Evidence', 'THE COAT REMEMBERS EVERY SHOULDER'], { row: 1 }],
        ['tpl-meanwhile-impossibly', '[ELSEWHERE|The Municipal Greenhouse|3 miles north]\n- The ferns are whispering in Latin.\n- A watering can floats three inches off the bench.\n- Nobody has unlocked the gate since Tuesday.\n[/ELSEWHERE]', ['The Municipal Greenhouse', '3 miles north', 'IMPOSSIBLY', 'The ferns are whispering in Latin.'], { row: 3 }],
    ]) {
        test(`${id} renders current Ethereal output`, () => {
            const built = buildAgentScripts(id, scriptsFor(id), theme);
            const rendered = applyList(text, built.scripts);
            expect(rendered).toContain('data-rat=');
            for (const value of values) expect(rendered).toContain(value);
            expect(rendered).not.toMatch(/\[\/?(?:LEDGER|CENSUS|DOORS|WINDS|DRIFT|HOUR|CERT|VOICE|THOUGHT|BECOMING|ELSEWHERE)/);
            for (const [part, count] of Object.entries(parts)) expect(rendered.match(new RegExp(`data-rat-part="${part}"`, 'g'))).toHaveLength(count);
        });
    }

    test('all preview samples still match the current display scripts', () => {
        for (const spec of SPECS.filter(item => item.family === 'tracker' && !item.passthrough && item.archetype !== ARCHETYPES.CLEANUP && SAMPLES[item.key])) {
            const sample = SAMPLES[spec.key];
            for (const text of Object.values(sample)) {
                expect({ id: spec.scriptId, matched: regexFromString(getStock(spec.templateId, spec.scriptId).findRegex).test(text) })
                    .toEqual({ id: spec.scriptId, matched: true });
                expect(buildReplaceString(spec, theme)).toBeTruthy();
            }
        }
    });

    test('every theme keeps companion map, movement, outfit and vital data intact', () => {
        for (const selected of THEMES) {
            for (const [id, key, values] of [
                ['tpl-position-tracker-companion', 'position', ['Harbour at dusk', 'Tavern', 'Mira', 'Nearby', 'Ezra', 'Away', 'Recent moves']],
                ['tpl-clothing-tracker-companion', 'clothing', ['Scene wardrobe', '{{user}}', 'Rain-darkened navy coat', 'Mira', 'Cream jumper', 'Léa O’Connor', 'Wool waistcoat', 'data-clothing-icon="footwear"', 'data-clothing-icon="other"']],
                ['tpl-visual-map-companion', 'visual-map', ['Harbour at dusk', 'Tavern', 'Docks', 'Mira', 'Beside the boat', 'Trail']],
                ['tpl-vitals-companion', 'vitals', ['Tired but safe', 'Health', 'Critical', 'Low', 'Fair', 'Good', 'Bruised ribs', 'Sheltered']],
                ['tpl-plot-compass-companion', 'plot-compass', ['Recover the sealed harbour ledger before the night watch changes.', 'Rain hammers the pier roof', 'Mira bribes the dock clerk', '<strong>brass token</strong>', '<em>limping courier</em>', '2. Have the courier pause under the bridge lamp', 'data-pc-card="1"', 'data-pc-opts="1"', 'pura-choice']],
            ]) {
                const built = buildAgentScripts(id, scriptsFor(id), selected);
                const rendered = applyList(SAMPLES[key].full, built.scripts);
                expect(rendered).toContain(`data-rat="${selected.slug}@`);
                for (const value of values) expect(rendered).toContain(value);
                expect(rendered).not.toMatch(/^(?:map-(?:start|end)|clothing-(?:start|end)|place\||pin\||who\||move\||outfit\||vitals[|-]|bar\||status\|)/im);
                expect(rendered).not.toContain('[[vitals-change:');
            }
        }
    }, 30000);

    test('every theme keeps vital bar widths and changes', () => {
        const id = 'tpl-vitals-companion';
        for (const selected of THEMES) {
            const rendered = applyList(SAMPLES.vitals.full, buildAgentScripts(id, scriptsFor(id), selected).scripts);
            for (const width of [23, 41, 57, 78, 90]) expect(rendered).toContain(`width:${width}%`);
            expect(rendered).toContain('fa-caret-up');
            expect(rendered).toContain('fa-caret-down');
        }
    }, 30000);

    test('companion cards handle unknown values and maps without movement', () => {
        const position = buildAgentScripts('tpl-position-tracker-companion', scriptsFor('tpl-position-tracker-companion'), theme);
        const positionHtml = applyList('map-start|Market|Morning\nplace|Stall|Open\nwho|Mira|hidden|Behind boxes|Waiting\nmap-end', position.scripts);
        for (const value of ['Mira', 'hidden', 'Behind boxes', 'Waiting']) expect(positionHtml).toContain(value);
        expect(positionHtml).not.toContain('Recent moves');

        const map = buildAgentScripts('tpl-visual-map-companion', scriptsFor('tpl-visual-map-companion'), theme);
        const mapHtml = applyList('map-start|Market|Morning\nplace|Stall|unknown|shop|Open\npin|Mira|Behind boxes|Waiting\nmap-end', map.scripts);
        expect(mapHtml).toContain('data-vm-d="unknown"');
        expect(mapHtml).toContain('data-vm-k="shop"');
        expect(mapHtml).toContain('Behind boxes');
        expect(mapHtml).not.toContain('class="ratvm-' + theme.slug + '-trail"');

        const vitals = buildAgentScripts('tpl-vitals-companion', scriptsFor('tpl-vitals-companion'), theme);
        const vitalsHtml = applyList('vitals|Mira|Resting\nbar|Magic|Unknown|0|Not measured\nstatus|Curious|other\nvitals-end', vitals.scripts);
        for (const value of ['Magic', 'Unknown', 'Not measured', 'Curious']) expect(vitalsHtml).toContain(value);
        expect(vitalsHtml).not.toContain('[[vitals-change:');
        expect(applyList('tracker-none', vitals.scripts)).toContain('No vitals to show yet');
    });

    test('visual map styles are scoped to their theme while direction attributes remain unchanged', () => {
        const id = 'tpl-visual-map-companion';
        const first = applyList(SAMPLES['visual-map'].full, buildAgentScripts(id, scriptsFor(id), THEMES[0]).scripts);
        const second = applyList(SAMPLES['visual-map'].full, buildAgentScripts(id, scriptsFor(id), THEMES[1]).scripts);
        for (const [html, selected] of [[first, THEMES[0]], [second, THEMES[1]]]) {
            expect(html).toContain(`.ratvm-${selected.slug}-place[data-vm-d="here" i]`);
            expect(html).toContain('data-vm-d="here"');
            expect(html).toContain('data-vm-d="east"');
        }
        expect(first).not.toContain(`.ratvm-${THEMES[1].slug}-place`);
        expect(second).not.toContain(`.ratvm-${THEMES[0].slug}-place`);
    });

    test('plot compass styles are scoped to their theme while preserving choice hooks', () => {
        const id = 'tpl-plot-compass-companion';
        const first = applyList(SAMPLES['plot-compass'].full, buildAgentScripts(id, scriptsFor(id), THEMES[0]).scripts);
        const second = applyList(SAMPLES['plot-compass'].full, buildAgentScripts(id, scriptsFor(id), THEMES[1]).scripts);
        for (const [html, selected] of [[first, THEMES[0]], [second, THEMES[1]]]) {
            expect(html).toContain(`.ratpc-${selected.slug} .ratpc-${selected.slug}-opt`);
            expect(html).toContain('data-pc-card="1"');
            expect(html).toContain('data-pc-opts="1"');
            expect(html.match(/class="pura-choice ratpc-/g)).toHaveLength(3);
            expect(html).not.toContain('\n');
        }
        expect(first).not.toContain(`.ratpc-${THEMES[1].slug}-opt`);
        expect(second).not.toContain(`.ratpc-${THEMES[0].slug}-opt`);
    });

    test('every theme keeps each chatroom platform look, scoped to that theme', () => {
        const id = 'tpl-chatroom-companion';
        const feed = SAMPLES.chatroom.full.replace('dockside', 'thread-board/4chan')
            .replace('notice\n', 'notice\n>be me\nchatroom-you|ezra|I will take the south gate.\n');
        for (const selected of THEMES) {
            const html = applyList(feed, buildAgentScripts(id, scriptsFor(id), selected).scripts);
            const scope = `.rat-cr-chatroom-${selected.slug}`;
            expect(html).toContain(`class="rat rat-stream rat-k-chatroom rat-tm-${selected.slug} ${scope.slice(1)}" data-chatroom-style="thread-board/4chan"`);
            for (const platform of ['4chan', 'reddit', 'twitter', 'discord', 'ao3', 'newsroom', 'infomercial']) {
                expect(html).toContain(`${scope}[data-chatroom-style*="${platform}" i]`);
            }
            for (const marker of ['content:">>"', 'content:" (You)"', 'content:"u/"', 'content:"Replying to "', 'content:"╭ "', 'content:"Reply · Thread · Parent"', 'content:"Breaking · "', 'content:" ☎ "']) {
                expect(html).toContain(marker);
            }
            for (const name of ['chatroom-post chatroom-post--green', 'chatroom-post--reply', 'chatroom-post--viewer', 'chatroom-replyto-target', 'chatroom-poll', 'chatroom-event-icon']) {
                expect(html).toContain(name);
            }
            expect(html).toContain('--chatroom-hue:312');
            expect(html).toMatch(/class="[^"]*chatroom-poll-option[^"]*"/);
            expect(html).toContain('<span class="chatroom-poll-label"');
            expect(html).not.toContain('class="chatroom-feed"');
            expect(html).not.toMatch(/^(?:CHATROOM|chatroom-)/m);
            expect(html.split('\n').filter(line => line.includes('<style>'))).toHaveLength(1);
        }
    }, 30000);

    test('terminal companions are styled across every theme with valid markdown isolation, bold, open defaults, glyphs and adaptive neutrals', () => {
        expect(THEMABLE_TEMPLATE_IDS).toContain('tpl-user-based-stats-generator');
        expect(THEMABLE_TEMPLATE_IDS).toContain('tpl-level-up-companion');
        expect(THEMABLE_TEMPLATE_IDS).toContain('tpl-memory-shard-companion');
        expect(PREVIEWABLE_ARCHETYPES).toContain(ARCHETYPES.TERMINAL);
        expect(PREVIEW_KEYS[ARCHETYPES.TERMINAL]).toBe('level-up');

        for (const selected of THEMES) {
            const statsScripts = buildAgentScripts('tpl-user-based-stats-generator', scriptsFor('tpl-user-based-stats-generator'), selected).scripts;
            const statsHtml = applyList(SAMPLES['user-stats'].full, statsScripts);
            expect(statsHtml).toContain(`</style>\n<div data-rat="${selected.slug}@4" data-rat-arch="terminal" data-rat-key="user-stats"`);
            expect(statsHtml).toContain(`rat-tw-user-stats-${selected.slug}`);
            expect(statsHtml).toContain('USER_STATS.exe');
            expect(statsHtml).toContain('FULL STAT BLOCK');
            expect(statsHtml).toContain('{{user}}@st:~$ cat USER_STATS.log');
            expect(statsHtml).toContain('<details open>');
            expect(statsHtml).toContain('<strong>Strength</strong>: 6/10');
            expect(statsHtml).toContain('<strong>Keen Eye</strong>: Spots exits and tells in a crowded room.');
            expect(statsHtml).not.toContain('[USER_STATS]');
            expect(statsHtml).not.toContain('[/USER_STATS]');
            expect(statsHtml).not.toContain('**Strength**');
            expect(statsHtml).not.toContain('data-rat-arch="bold"');

            const levelScripts = buildAgentScripts('tpl-level-up-companion', scriptsFor('tpl-level-up-companion'), selected).scripts;
            const levelHtml = applyList(SAMPLES['level-up'].full, levelScripts);
            expect(levelHtml).toContain(`</style>\n<div data-rat="${selected.slug}@4" data-rat-arch="terminal" data-rat-key="level-up"`);
            expect(levelHtml).toContain(`rat-tw-level-up-${selected.slug}`);
            expect(levelHtml).toContain('LEVEL_UP.exe');
            expect(levelHtml).toContain('LEVEL UP REPORT');
            expect(levelHtml).toContain('{{user}}@st:~$ run LEVEL_UP.report');
            expect(levelHtml).toContain('[ LEVEL UP CONFIRMED ]');
            expect(levelHtml).toContain('<strong>Swordplay</strong>: +4, now 46/100');
            expect(levelHtml).toContain('<strong>Night Watch</strong>: Faster recovery after long shifts.');
            expect(levelHtml).not.toContain('[LEVEL_UP]');
            expect(levelHtml).not.toContain('[/LEVEL_UP]');
            expect(levelHtml).not.toContain('**Swordplay**');
        }

        const sampleTheme = getTheme('phosphor-green');
        const closed = applyList(
            SAMPLES['user-stats'].full,
            buildAgentScripts('tpl-user-based-stats-generator', scriptsFor('tpl-user-based-stats-generator'), sampleTheme, {
                openDefaults: 'all-closed',
                glyphs: 'none',
                restyleBold: true,
            }).scripts,
        );
        expect(closed).toContain('<details>');
        expect(closed).not.toContain('<details open>');
        expect(closed).not.toContain('class="rat-tw-dots"');
        expect(closed).not.toContain('class="rat-tw-cursor"');
        expect(closed).not.toContain('\u258e');
        expect(closed).toContain('data-rat-arch="bold"');
        expect(closed).toContain('>Strength</strong>');

        const gameboy = resolveTheme(getTheme('gameboy-dmg'));
        expect(gameboy.term.font).toBe('ui-monospace, Menlo, monospace');
        expect(gameboy.a11y.checks.some(check => check.role === 'terminal-strong')).toBe(true);

        const customWithTerm = {
            ...structuredClone(getTheme('obsidian-ink')),
            slug: 'custom-term-check',
            term: {
                bg: '#08100a',
                panel: '#0e1a12',
                accent: '#42ff9e',
                accentDim: '#24c475',
                text: '#d8ffe7',
                muted: '#7eb695',
                border: '#1d4d32',
                glow: 'rgba(66,255,158,0.18)',
                gold: '#ffe17d',
                font: 'ui-monospace, monospace',
            },
        };
        const adapted = resolveTheme(customWithTerm, { adaptiveNeutrals: true });
        expect(adapted.term.bg).toContain('var(--SmartTheme');
        expect(adapted.term.panel).toContain('var(--SmartTheme');
        expect(adapted.term.border).toContain('var(--SmartTheme');
        expect(adapted.term.accent).toBe('#42ff9e');
        expect(adapted.term.font).toBe('ui-monospace, monospace');
        for (const check of adapted.a11y.checks) {
            const fg = parseColor(check.foreground);
            expect(fg).not.toBeNull();
            for (const bg of check.backgrounds) {
                expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(check.minimum);
            }
        }
    }, 30000);
});

describe('tracker-family selection through the real apply path', () => {
    let agents;
    let saveAgent;
    let context;
    beforeEach(() => {
        agents = THEMABLE_TEMPLATE_IDS.map(agentFor);
        saveAgent = jest.fn(async updated => {
            agents[agents.findIndex(agent => agent.id === updated.id)] = structuredClone(updated);
        });
        context = { extensionSettings: { [SETTINGS_KEY]: settings() }, saveSettingsDebounced: jest.fn(), chat: [] };
        global.SillyTavern = { getContext: () => context };
        __setHostForTests({ ok: true, store: { getAgents: () => agents, saveAgent,
            getAgentById: id => agents.find(agent => agent.id === id) }, scripts: { normalizeRegexScript: value => value } });
    });
    afterEach(() => {
        __setHostForTests(null);
        delete global.SillyTavern;
    });

    test('migrates missing or invalid selections to both and honours overrides only within scope', () => {
        for (const trackerScope of [undefined, 'bogus', null]) {
            updateSettings({ trackerScope });
            expect(getSettings().trackerScope).toBe('both');
        }
        updateSettings({ trackerScope: 'pura', overrides: { 'tpl-the-ledger': THEMES[1].slug } });
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(STOCK_THEME);
        expect(resolveThemeSlug('tpl-scene-tracker')).toBe(theme.slug);
        expect(resolveThemeSlug('tpl-chatroom-companion')).toBe(theme.slug);
        updateSettings({ trackerScope: 'ethereal' });
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(THEMES[1].slug);
    });

    test('applies both, restores excluded trackers exactly, resumes overrides and persists scope', async () => {
        const original = structuredClone(agents);
        updateSettings({ overrides: { 'tpl-the-ledger': THEMES[1].slug } });
        expect(await applyAll()).toMatchObject({ ok: true, applied: original.length, blocked: [], failed: [] });
        for (const agent of agents) expect(inspectAgent(agent).status).toBe('pristine');
        saveAgent.mockClear();
        expect(await reconcile()).toMatchObject({ repaired: 0, reverted: 0, needsAttention: [] });
        expect(saveAgent).not.toHaveBeenCalled();

        for (const scope of ['pura', 'ethereal', 'both']) {
            updateSettings({ trackerScope: scope });
            expect(await applyAll()).toMatchObject({ ok: true, blocked: [], failed: [] });
            expect(getSettings().trackerScope).toBe(scope);
            const excluded = agents.filter(agent => {
                const family = TRACKER_FAMILIES[agent.sourceTemplateId];
                return family && scope !== 'both' && family !== scope;
            });
            for (const agent of excluded) {
                expect(agent).toEqual(original.find(item => item.id === agent.id));
                expect(getSettings().ledger[agent.id]).toBeUndefined();
            }
            for (const agent of agents.filter(item => !excluded.includes(item))) {
                expect(inspectAgent(agent).status).toBe('pristine');
                expect(agent.prompt).toBe(original.find(item => item.id === agent.id).prompt);
                expect(agent.version).toBe(original.find(item => item.id === agent.id).version);
            }
        }
        expect(resolveThemeSlug('tpl-the-ledger')).toBe(THEMES[1].slug);
        updateSettings({ theme: STOCK_THEME, overrides: {} });
        expect(await applyAll()).toMatchObject({ reverted: original.length, blocked: [], failed: [] });
        expect(agents).toEqual(original);
    });

    test('direct apply and reload reconciliation honour selection', async () => {
        await applyAll();
        updateSettings({ trackerScope: 'pura' });
        const ledger = agents.find(agent => agent.sourceTemplateId === 'tpl-the-ledger');
        expect(await applyToAgent(ledger)).toMatchObject({ ok: true });
        expect(ledger.regexScripts).toEqual(scriptsFor('tpl-the-ledger'));
        expect(await reconcile()).toMatchObject({ repaired: 0, reverted: 20, needsAttention: [] });
        updateSettings({ trackerScope: 'ethereal' });
        expect(await reconcile()).toMatchObject({ repaired: 21, reverted: 16, needsAttention: [] });
    });

    test('scope changes protect manual edits and altered source patterns', async () => {
        await applyAll();
        const ledger = agents.find(agent => agent.sourceTemplateId === 'tpl-the-ledger');
        ledger.regexScripts[0].replaceString = '<div>My custom card</div>';
        updateSettings({ trackerScope: 'pura' });
        const result = await applyAll();
        expect(result.blocked.map(entry => entry.agentId)).toContain(ledger.id);
        expect(ledger.regexScripts[0].replaceString).toBe('<div>My custom card</div>');
        updateSettings({ trackerScope: 'both' });
        ledger.regexScripts[0].findRegex = '/custom (pattern)/g';
        expect(await applyToAgent(ledger, { force: true })).toMatchObject({ ok: false });
        expect(ledger.regexScripts[0].findRegex).toBe('/custom (pattern)/g');
    });

    test('reconciles, switches, protects manual edits and reverts terminal companions without mutating messages', async () => {
        const stats = agents.find(agent => agent.sourceTemplateId === 'tpl-user-based-stats-generator');
        const levelUp = agents.find(agent => agent.sourceTemplateId === 'tpl-level-up-companion');
        const originalStats = structuredClone(stats);
        const originalLevelUp = structuredClone(levelUp);
        const emit = jest.fn();
        const updateMessageBlock = jest.fn();
        const storedMessage = {
            mes: 'You feel steadier after the climb.',
            extra: {
                inChatAgentCompanionResults: {
                    [stats.id]: { content: SAMPLES['user-stats'].full, format: 'markdown', status: 'done' },
                    [levelUp.id]: { content: SAMPLES['level-up'].full, format: 'markdown', status: 'done' },
                },
            },
        };
        const messageSnapshot = structuredClone(storedMessage);
        context.chat = [storedMessage];
        context.eventSource = { emit };
        context.updateMessageBlock = updateMessageBlock;

        // Boot reconcile picks up already-installed stock terminal companions.
        const initialReconcile = await reconcile();
        expect(initialReconcile.needsAttention).toEqual([]);
        expect(inspectAgent(agents.find(a => a.id === stats.id)).status).toBe('pristine');
        expect(inspectAgent(agents.find(a => a.id === levelUp.id)).status).toBe('pristine');
        expect(emit).toHaveBeenCalledWith('in_chat_agent_companion_results_updated', { messageIndex: 0 });
        expect(storedMessage).toEqual(messageSnapshot);

        // Switching themes repaints and updates terminal companions cleanly.
        emit.mockClear();
        updateSettings({ theme: THEMES[1].slug });
        const switched = await applyAll();
        expect(switched).toMatchObject({ ok: true, blocked: [], failed: [] });
        expect(agents.find(a => a.id === stats.id).regexScripts[0].replaceString).toContain(`rat-tw-user-stats-${THEMES[1].slug}`);
        expect(agents.find(a => a.id === levelUp.id).regexScripts[0].replaceString).toContain(`rat-tw-level-up-${THEMES[1].slug}`);
        expect(emit).toHaveBeenCalledWith('in_chat_agent_companion_results_updated', { messageIndex: 0 });
        expect(storedMessage).toEqual(messageSnapshot);

        // Hand-edited terminal script is protected during boot reconcile and revert.
        const customHtml = '<div class="my-custom-levelup">$1</div>';
        agents.find(a => a.id === levelUp.id).regexScripts[0].replaceString = customHtml;
        expect(inspectAgent(agents.find(a => a.id === levelUp.id)).status).toBe('foreign');
        const guarded = await reconcile();
        expect(guarded.needsAttention.map(entry => entry.agentId)).toContain(levelUp.id);
        expect(agents.find(a => a.id === levelUp.id).regexScripts[0].replaceString).toBe(customHtml);

        // Reverting to stock restores untouched terminal companion byte-for-byte while protecting the edited one.
        updateSettings({ theme: STOCK_THEME });
        const reverted = await applyAll();
        expect(reverted.blocked.map(entry => entry.agentId)).toContain(levelUp.id);
        expect(agents.find(a => a.id === stats.id)).toEqual(originalStats);
        expect(agents.find(a => a.id === levelUp.id).regexScripts[0].replaceString).toBe(customHtml);

        // Force-reverting or restoring stock after clearing hand edit returns exact stock.
        agents.find(a => a.id === levelUp.id).regexScripts = structuredClone(originalLevelUp.regexScripts);
        expect(agents.find(a => a.id === levelUp.id)).toEqual(originalLevelUp);
    });
});

function resolveLayeredGrounds(background, baseGrounds) {
    const layers = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < background.length; i++) {
        if (background[i] === '(') depth++;
        else if (background[i] === ')') depth--;
        else if (background[i] === ',' && depth === 0) {
            layers.push(background.slice(start, i).trim());
            start = i + 1;
        }
    }
    layers.push(background.slice(start).trim());
    let grounds = baseGrounds;
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.startsWith('repeating-linear-gradient')) {
            const stops = layer.match(/rgba?\([^)]+\)/g) || [];
            const next = [...grounds];
            for (const stop of stops) {
                const parsed = parseColor(stop);
                if (parsed && parsed.a > 0) {
                    for (const ground of grounds) next.push(composite(parsed, ground));
                }
            }
            grounds = next;
        } else if (layer.startsWith('linear-gradient')) {
            const stops = layer.match(/(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/g) || [];
            const next = [];
            for (const stop of stops) {
                const parsed = parseColor(stop);
                if (parsed) {
                    for (const ground of grounds) next.push(composite(parsed, ground));
                }
            }
            if (next.length) grounds = next;
        } else {
            const flat = flattenColor(layer, grounds);
            if (flat.length) grounds = flat;
        }
    }
    return grounds;
}

describe('Memory Shard companion theming', () => {
    const id = 'tpl-memory-shard-companion';
    const sample = SAMPLES['memory-shard'].full;

    test('all 118 themes transform the Memory Shard sample cleanly with isolated CSS and preserved tag chaining', () => {
        const originals = scriptsFor(id);
        for (const selected of THEMES) {
            const built = buildAgentScripts(id, originals, selected, {});
            expect(built.skipped).toEqual([]);
            const prefix = `ratms-${selected.slug}`;
            const styleScript = built.scripts.find(script => script.id === 'memory-shard-styles');
            expect(styleScript.replaceString).toMatch(/^<style>.*<\/style>$/);
            expect(styleScript.replaceString).not.toContain('\n');
            expect(styleScript.replaceString).not.toContain('{{');
            expect(styleScript.replaceString).not.toMatch(/\.ms-/);
            expect(styleScript.replaceString).not.toMatch(/--ms-/);
            expect(styleScript.replaceString).toContain('--mesParagraphSpacingTop');
            expect(styleScript.replaceString).toContain('--mesParagraphSpacingBottom');
            expect(styleScript.replaceString).toContain('--messageTextFontSize');
            expect(styleScript.replaceString).toContain('@media (prefers-reduced-motion: reduce)');

            const rawCss = styleScript.replaceString.slice('<style>'.length, -'</style>'.length);
            expect(() => css.parse(rawCss)).not.toThrow();

            const rendered = applyList(sample, built.scripts);
            expect(rendered).not.toContain('style="0:');
            expect(rendered).toContain(`data-rat="${selected.slug}@`);
            expect(rendered).toContain('data-rat-arch="memory-shard"');
            expect(rendered).toContain('data-rat-part="root"');
            expect(rendered).toContain(`${prefix}-hero`);
            expect(rendered).toContain(`${prefix}-sec-snapshot`);
            expect(rendered).toContain(`${prefix}-ev-num`);
            expect(rendered).toContain(`${prefix}-ev-loc`);
            expect(rendered).toContain(`${prefix}-rel-pair`);
            expect(rendered).toContain(`${prefix}-thread-head`);
            expect(rendered).toContain(`${prefix}-kv-k`);
            for (const kind of ['critical', 'major', 'moderate', 'minor', 'open', 'planted', 'resolved']) {
                expect(rendered).toContain(`class="ms-tag ${prefix}-tag ${prefix}-tag-${kind}"`);
            }
            expect(rendered).not.toMatch(/\[(?:CRITICAL|MAJOR|MODERATE|MINOR|OPEN|PLANTED|RESOLVED)\]/i);
            expect(rendered).not.toMatch(/^#{1,3}\s/m);
            expect(rendered.match(/<style>/g)).toHaveLength(1);
            for (const icon of rendered.matchAll(/<i\b[^>]*>/g)) {
                expect(icon[0]).toContain('style="color:inherit"');
            }
        }
    }, 30000);

    test('all 115 fixed themes meet WCAG AA contrast (>= 4.5:1) across Memory Shard surfaces, chips, and tags', () => {
        const styleSpec = getSpec(id, 'memory-shard-styles');
        const black = parseColor('#000000');
        const white = parseColor('#ffffff');
        const failures = [];

        for (const selected of THEMES) {
            if (selected.mode === 'adaptive') continue;
            const tokens = resolveTheme(selected, {});
            const prefix = `ratms-${tokens.slug}`;
            const rawCss = buildReplaceString(styleSpec, tokens).slice('<style>'.length, -'</style>'.length);
            const ast = css.parse(rawCss);
            const rules = new Map();
            for (const rule of ast.stylesheet.rules) {
                if (rule.type !== 'rule') continue;
                for (const selector of rule.selectors) {
                    const decls = rules.get(selector) || {};
                    for (const decl of rule.declarations) {
                        if (decl.type === 'declaration') decls[decl.property] = decl.value;
                    }
                    rules.set(selector, decls);
                }
            }
            const getGrounds = (selector, parentGrounds = [black, white]) => {
                const bg = rules.get(selector)?.background;
                return bg ? resolveLayeredGrounds(bg, parentGrounds) : parentGrounds;
            };
            const check = (label, selector, grounds) => {
                const fg = parseColor(rules.get(selector)?.color);
                if (!fg || !grounds.length) return;
                const min = Math.min(...grounds.map(ground => contrastRatio(fg, ground)));
                if (min < 4.5) failures.push(`${selected.slug}:${label}=${min.toFixed(2)}`);
            };

            const heroG = getGrounds(`.${prefix}-hero`);
            const secG = getGrounds(`.${prefix}-sec`);
            const listG = getGrounds(`.${prefix}-sec:not(.${prefix}-sec-snapshot) + ul`);
            const subG = getGrounds(`.${prefix}-sub`);
            const quoteG = getGrounds(`.${prefix}-sec.${prefix}-sec-quotes + ul > li`);
            const tileG = getGrounds(`.${prefix}-sec-snapshot + ul > li`);
            const relPairG = getGrounds(`.${prefix}-rel-pair`, listG);

            check('hero-title', `.${prefix}-hero-title`, heroG);
            check('hero-eyebrow', `.${prefix}-hero-eyebrow`, heroG);
            check('hero-master-eyebrow', `.${prefix}-hero-master .${prefix}-hero-eyebrow`, heroG);
            check('hero-ico', `.${prefix}-hero-ico`, getGrounds(`.${prefix}-hero-ico`, heroG));
            check('hero-code', `.${prefix}-hero-code`, getGrounds(`.${prefix}-hero-code`, heroG));
            check('sec-title', `.${prefix}-sec-title`, secG);
            check('sub-title', `.${prefix}-sub-title`, subG);
            check('ev-title', `.${prefix}-ev-title`, subG);
            check('ev-num', `.${prefix}-ev-num`, getGrounds(`.${prefix}-ev-num`, subG));
            check('ev-loc', `.${prefix}-ev-loc`, getGrounds(`.${prefix}-ev-loc`, subG));
            check('list-li', `.${prefix}-sec:not(.${prefix}-sec-snapshot) + ul > li`, listG);
            check('tile-kv-k', `.${prefix}-sec-snapshot + ul > li .${prefix}-kv-k`, tileG);
            check('tile-kv-v', `.${prefix}-sec-snapshot + ul > li .${prefix}-kv-v`, tileG);
            check('quote-li', `.${prefix}-sec.${prefix}-sec-quotes + ul > li`, quoteG);
            check('kv-k', `.${prefix}-kv-k`, listG);
            check('kv-v', `.${prefix}-kv-v`, listG);
            check('rel-pair', `.${prefix}-rel-pair`, relPairG);
            check('rel-arr', `.${prefix}-rel-arr`, relPairG);
            check('rel-note', `.${prefix}-rel-note`, getGrounds(`.${prefix}-rel-note`, listG));
            check('rel-body', `.${prefix}-rel-body`, listG);
            check('thread-title', `.${prefix}-thread-title`, listG);
            check('thread-body', `.${prefix}-thread-body`, listG);
            for (const kind of ['critical', 'major', 'moderate', 'minor', 'open', 'planted', 'resolved']) {
                const sel = `span.${prefix}-tag-${kind}`;
                check(`tag-${kind}`, sel, getGrounds(sel, listG));
            }
        }
        expect(failures).toEqual([]);
    }, 30000);

    test('honours adaptiveNeutrals, adaptive themes, glyphs, density, and motion options', () => {
        const heroSpec = getSpec(id, 'memory-shard-hero');
        const styleSpec = getSpec(id, 'memory-shard-styles');

        const lightAdaptive = resolveTheme(getTheme('delft-porcelain'), { adaptiveNeutrals: true });
        const lightAdaptiveCss = buildReplaceString(styleSpec, lightAdaptive);
        expect(lightAdaptiveCss).toContain('--SmartThemeBlurTintColor');
        expect(lightAdaptiveCss).toContain('rgba(255,255,255,0.52)');

        for (const slug of ['adaptive-native', 'adaptive-accent', 'adaptive-ink']) {
            const adaptiveTokens = resolveTheme(getTheme(slug), {});
            const adaptiveCss = buildReplaceString(styleSpec, adaptiveTokens);
            expect(adaptiveCss).toContain('rgba(0,0,0,0.58)');
            expect(() => css.parse(adaptiveCss.slice('<style>'.length, -'</style>'.length))).not.toThrow();
        }

        const animatedWithGlyphs = resolveTheme(getTheme('signal-pulse'), { glyphs: 'theme', density: 'roomy' });
        const animatedNoGlyphs = resolveTheme(getTheme('signal-pulse'), { glyphs: 'none', density: 'compact' });
        const heroWithGlyphs = buildReplaceString(heroSpec, animatedWithGlyphs);
        const heroNoGlyphs = buildReplaceString(heroSpec, animatedNoGlyphs);
        expect(heroWithGlyphs).toContain('data-rat-motion="signal-pulse"');
        expect(heroWithGlyphs).toContain('border-top:2px solid #66e7ff');
        expect(heroWithGlyphs).toContain('margin-right:5px');
        expect(heroNoGlyphs).not.toContain('margin-right:5px');
        expect(heroWithGlyphs.length).toBeGreaterThan(heroNoGlyphs.length);
        expect(buildReplaceString(styleSpec, animatedWithGlyphs)).not.toBe(buildReplaceString(styleSpec, animatedNoGlyphs));
    });

    test('preview renderer produces stock and themed Memory Shard HTML', () => {
        global.SillyTavern = { getContext: () => ({ name1: 'You', name2: 'Momo', messageFormatting: value => value }) };
        try {
            const stockHtml = renderPreviewHtml(ARCHETYPES.MEMORY_SHARD, null, {});
            expect(stockHtml).toContain('Memory Shard');
            expect(stockHtml).toContain('<style>');
            expect(stockHtml).toContain('class="ms-hero"');
            expect(stockHtml).not.toMatch(/\[(?:CRITICAL|MAJOR|OPEN|PLANTED|RESOLVED)\]/i);

            for (const slug of ['obsidian-ink', 'delft-porcelain', 'adaptive-native']) {
                const html = renderPreviewHtml(ARCHETYPES.MEMORY_SHARD, getTheme(slug), {});
                expect(html).toContain('Memory Shard');
                expect(html).toContain('<style>');
                expect(html).toContain(`ratms-${slug}-hero`);
                expect(html).toContain(`data-rat="${slug}@`);
                expect(html).not.toMatch(/\[(?:CRITICAL|MAJOR|OPEN|PLANTED|RESOLVED)\]/i);
            }
        } finally {
            delete global.SillyTavern;
        }
    });

    describe('drift, boot reconcile, switching, manual-edit protection, and revert without message mutation', () => {
        let agents;
        let saveAgent;
        let context;

        beforeEach(() => {
            agents = [agentFor(id)];
            saveAgent = jest.fn(async updated => {
                agents[0] = structuredClone(updated);
            });
            context = {
                extensionSettings: { [SETTINGS_KEY]: { ...structuredClone(DEFAULTS), theme: 'obsidian-ink' } },
                saveSettingsDebounced: jest.fn(),
                chat: [
                    { mes: 'First message', extra: { companion: { [agents[0].id]: { result: sample } } } },
                ],
            };
            global.SillyTavern = { getContext: () => context };
            __setHostForTests({
                ok: true,
                store: {
                    getAgents: () => agents,
                    saveAgent,
                    getAgentById: agentId => agents.find(agent => agent.id === agentId),
                },
                scripts: { normalizeRegexScript: value => value },
            });
        });

        afterEach(() => {
            __setHostForTests(null);
            delete global.SillyTavern;
        });

        test('reconciles stock install, switches themes via overrides, and reverts cleanly to stock without mutating chat', async () => {
            const stockScripts = scriptsFor(id);
            const initialChat = structuredClone(context.chat);

            expect(inspectAgent(agents[0]).status).toBe('stock');
            expect(await reconcile()).toMatchObject({ repaired: 1, reverted: 0, needsAttention: [] });
            expect(inspectAgent(agents[0]).status).toBe('pristine');
            expect(agents[0].regexScripts.find(s => s.id === 'memory-shard-styles').replaceString).toContain('ratms-obsidian-ink-hero');
            expect(context.chat).toEqual(initialChat);

            // Switch theme via Tracker Override and verify all 30 non-passthrough scripts update cleanly
            updateSettings({ overrides: { [id]: 'delft-porcelain' } });
            expect(await applyAll()).toMatchObject({ ok: true, applied: 1, blocked: [], failed: [] });
            expect(inspectAgent(agents[0]).status).toBe('pristine');
            expect(agents[0].regexScripts.find(s => s.id === 'memory-shard-styles').replaceString).toContain('ratms-delft-porcelain-hero');
            expect(context.chat).toEqual(initialChat);

            // Clean revert restores exact stock scripts and removes ledger entry without mutating messages
            expect(await revertAgent(agents[0])).toMatchObject({ ok: true, reverted: 30 });
            expect(agents[0].regexScripts).toEqual(stockScripts);
            expect(getSettings().ledger[agents[0].id]).toBeUndefined();
            expect(context.chat).toEqual(initialChat);
        });

        test('protects manual edits to memory-shard-styles across reconcile, switch, and revert, and preserves them as backup on force apply', async () => {
            const initialChat = structuredClone(context.chat);

            expect(await reconcile()).toMatchObject({ repaired: 1, reverted: 0, needsAttention: [] });

            const customCss = '<style>.my-handcrafted-shard{border:2px solid gold;}</style>';
            const styleIdx = agents[0].regexScripts.findIndex(s => s.id === 'memory-shard-styles');
            agents[0].regexScripts[styleIdx].replaceString = customCss;

            const report = inspectAgent(agents[0]);
            expect(report.status).toBe('foreign');
            expect(report.perScript.find(entry => entry.scriptId === 'memory-shard-styles').status).toBe('foreign');

            const reconcileBlocked = await reconcile();
            expect(reconcileBlocked).toMatchObject({ repaired: 0, reverted: 0 });
            expect(reconcileBlocked.needsAttention).toEqual([
                expect.objectContaining({
                    agentId: agents[0].id,
                    entries: [expect.objectContaining({ scriptId: 'memory-shard-styles', status: 'foreign' })],
                }),
            ]);
            expect(agents[0].regexScripts[styleIdx].replaceString).toBe(customCss);

            updateSettings({ overrides: { [id]: 'adaptive-native' } });
            const switchRes = await applyAll();
            expect(switchRes.blocked.map(entry => entry.agentId)).toContain(agents[0].id);
            expect(agents[0].regexScripts[styleIdx].replaceString).toBe(customCss);

            const blockedRevert = await revertAgent(agents[0]);
            expect(blockedRevert.ok).toBe(false);
            expect(agents[0].regexScripts[styleIdx].replaceString).toBe(customCss);

            // Force apply records the hand edit in originals and applies the requested theme
            expect(await applyToAgent(agents[0], { force: true })).toMatchObject({ ok: true });
            expect(inspectAgent(agents[0]).status).toBe('pristine');
            expect(agents[0].regexScripts[styleIdx].replaceString).toContain('ratms-adaptive-native-hero');

            // Reverting after a forced overwrite restores the backed-up manual edit and clears the ledger
            expect(await revertAgent(agents[0])).toMatchObject({ ok: true, reverted: 30 });
            expect(agents[0].regexScripts[styleIdx].replaceString).toBe(customCss);
            expect(getSettings().ledger[agents[0].id]).toBeUndefined();
            expect(context.chat).toEqual(initialChat);
        });
    });
});
