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
const { updateRetiredFindPatterns } = await import('../public/scripts/extensions/in-chat-agents/retired-regex-patterns.js');

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
