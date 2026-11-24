import fs from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString: jest.fn(value => {
        const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
    }),
    uuidv4: jest.fn(() => 'test-uuid'),
}));

const { AGENT_REGEX_PLACEMENT, applyRegexScriptList } = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');
const { updateRetiredFindPatterns, updateRetiredReplacements } = await import('../public/scripts/extensions/in-chat-agents/retired-regex-patterns.js');

const CERTIFICATE_ID = 'fb09f6d3-e5bf-4aec-8166-07f3f33aaeaa';
const bundles = JSON.parse(fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
const indexSource = fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url), 'utf8');
const retiredSource = fs.readFileSync(new URL('../public/scripts/extensions/in-chat-agents/retired-regex-patterns.js', import.meta.url), 'utf8');
const certificate = bundles['tpl-small-miracles'].find(script => script.id === CERTIFICATE_ID);
const retiredCertificate = String.raw`/\[CERT\|([^\]\n\r|]+)\|([^\]\n\r|]+)\|([^\]\n\r|]+)\][ \t]*\r?\n?[ \t]*(?:stamp:[ \t]*)?((?:(?!\[\/|\[[A-Z])[^\n\r])*)(?:\s*\[\/CERT\])?/g`;
const findBundledScript = id => Object.values(bundles).flat().find(script => script.id === id);

function render(text, script) {
    return applyRegexScriptList(text, [script], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
}

describe('Miracle Certificate rule', () => {
    const twoFields = '[CERT|The One-Knuckle De-escalation|🎪 IRREGULAR OCCURRENCE]\nstamp: Re: Incident Report 44-C/Seven\n[/CERT]';
    const threeFields = '[CERT|First Door|MINOR|Section 3]\nstamp: sealed\n[/CERT]';

    test('draws certificates whose header leaves out the citation', () => {
        for (const sample of [twoFields, threeFields]) {
            const html = render(sample, certificate);
            expect(html).not.toContain('[CERT');
            expect(html).not.toContain('[/CERT]');
        }
        expect(render(twoFields, certificate)).toContain('The One-Knuckle De-escalation');
        expect(render(twoFields, certificate)).toContain('Re: Incident Report 44-C/Seven');
    });

    test('the retired pattern is the one that left two-field certificates as raw text', () => {
        expect(retiredSource).toContain(retiredCertificate);
        expect(render(twoFields, { ...certificate, findRegex: retiredCertificate })).toContain('[CERT|');
    });
});

describe('updateRetiredFindPatterns', () => {
    test('gives an unedited retired pattern the bundled one and keeps a themed replacement', () => {
        const saved = [
            { id: CERTIFICATE_ID, scriptName: 'Liminal: Miracle Certificate', findRegex: retiredCertificate, replaceString: '<div class="themed">$1</div>' },
            { id: 'other', findRegex: '/x/g', replaceString: 'y' },
        ];

        const updated = updateRetiredFindPatterns(saved, findBundledScript);

        expect(updated[0]).toEqual({ ...saved[0], findRegex: certificate.findRegex });
        expect(updated[1]).toBe(saved[1]);
        expect(saved[0].findRegex).toBe(retiredCertificate);
    });

    test('leaves edited and current patterns alone', () => {
        expect(updateRetiredFindPatterns([{ id: CERTIFICATE_ID, findRegex: `${retiredCertificate}i` }], findBundledScript)).toBeNull();
        expect(updateRetiredFindPatterns([{ ...certificate }], findBundledScript)).toBeNull();
        expect(updateRetiredFindPatterns(undefined, findBundledScript)).toBeNull();
        expect(updateRetiredFindPatterns([{ findRegex: retiredCertificate }], () => null)).toBeNull();
    });

    test('runs for every saved agent at start-up, locked or not, in one library write', () => {
        const start = indexSource.indexOf('async function migrateRetiredRegexFindPatternsToSavedAgents()');
        const body = indexSource.slice(start, indexSource.indexOf('\n}\n', start));
        const initialisation = indexSource.slice(indexSource.indexOf('async function finishAgentLibraryInitialization()'), indexSource.indexOf('async function retryAgentSetupLoading'));

        expect(body).toContain('updateRetiredFindPatterns(agent.regexScripts, findBundledScript)');
        expect(body).toContain('await saveAgentBatch(changes, \'Retired regex patterns\');');
        expect(body).not.toContain('shouldSkipBundledTemplateMigrations');
        expect(initialisation).toContain('await migrateRetiredRegexFindPatternsToSavedAgents()');
    });
});

describe('updateRetiredReplacements', () => {
    const BOND_ID = 'c81e4b95-2d7a-4a60-8f3c-7b9e0d6a4c22';
    const bond = bundles['tpl-relationship-tracker'].find(script => script.id === BOND_ID);
    // The Relationship Bond card before its header wrapped the status pill on narrow cards.
    const retiredBond = bond.replaceString
        .replace('display:flex;flex-wrap:wrap;align-items:center', 'display:flex;align-items:center')
        .replace('flex:1 1 0;min-width:min(7em,100%);line-height:1.4', 'flex:1;min-width:0;line-height:1.4')
        .replace('color:#d6b8ff;margin-left:auto', 'color:#d6b8ff;white-space:nowrap');

    test('the bundled bond header wraps instead of squeezing the name', () => {
        const summary = bond.replaceString.match(/<summary[\s\S]*?<\/summary>/)[0];
        expect(summary).toContain('flex-wrap:wrap');
        expect(summary).toContain('min-width:min(7em,100%)');
        expect(summary).not.toContain('nowrap');
        expect(retiredBond).not.toBe(bond.replaceString);
    });

    test('gives an unedited retired bond card the bundled markup, whatever the saved script id', () => {
        const saved = [
            { id: 'saved-copy', scriptName: 'Replace Relationship Bond', findRegex: bond.findRegex, replaceString: retiredBond },
            { id: 'other', findRegex: '/x/g', replaceString: 'y' },
        ];

        const updated = updateRetiredReplacements(saved, findBundledScript);

        expect(updated[0]).toEqual({ ...saved[0], replaceString: bond.replaceString });
        expect(updated[1]).toBe(saved[1]);
        expect(saved[0].replaceString).toBe(retiredBond);
    });

    test('leaves restyled, themed and current replacements alone', () => {
        expect(updateRetiredReplacements([{ id: BOND_ID, replaceString: `${retiredBond} ` }], findBundledScript)).toBeNull();
        expect(updateRetiredReplacements([{ id: BOND_ID, replaceString: '<details data-rat="x@1">$2</details>' }], findBundledScript)).toBeNull();
        expect(updateRetiredReplacements([{ ...bond }], findBundledScript)).toBeNull();
        expect(updateRetiredReplacements([{ id: BOND_ID }], findBundledScript)).toBeNull();
        expect(updateRetiredReplacements(undefined, findBundledScript)).toBeNull();
        expect(updateRetiredReplacements([{ replaceString: retiredBond }], () => null)).toBeNull();
    });

    test('runs for every saved agent at start-up, locked or not, in one library write', () => {
        const start = indexSource.indexOf('async function migrateRetiredRegexReplacementsToSavedAgents()');
        const body = indexSource.slice(start, indexSource.indexOf('\n}\n', start));
        const initialisation = indexSource.slice(indexSource.indexOf('async function finishAgentLibraryInitialization()'), indexSource.indexOf('async function retryAgentSetupLoading'));

        expect(start).toBeGreaterThan(-1);
        expect(body).toContain('updateRetiredReplacements(agent.regexScripts, findBundledScript)');
        expect(body).toContain('await saveAgentBatch(changes, \'Retired regex replacements\');');
        expect(body).not.toContain('shouldSkipBundledTemplateMigrations');
        expect(initialisation).toContain('await migrateRetiredRegexReplacementsToSavedAgents()');
    });
});
