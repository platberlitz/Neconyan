import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildTrackerEchoGuard,
    extractTrackerLineKeys,
    getActiveCompanionTrackerLineKeys,
    stripSavedAuxiliaryTrackerEchoes,
    stripTrackerLineEchoes,
} from '../public/scripts/extensions/in-chat-agents/companion/companion-tracker-context.js';
import { prepareCompanionFeedback } from '../src/generation/companion-feedback.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { roleplayAgentOutputBaseline } = await import('../src/generation/roleplay-agent-processing.js');

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/scripts/extensions/in-chat-agents/templates');
const NON_TEMPLATE_FILES = new Set(['index.json', 'groups.json', 'regex-bundles.json']);
const templates = fs.readdirSync(templatesDir)
    .filter(file => file.endsWith('.json') && !NON_TEMPLATE_FILES.has(file))
    .map(file => JSON.parse(fs.readFileSync(path.join(templatesDir, file), 'utf8')));
const templateById = new Map(templates.map(template => [template.id, template]));
const isCompanionTemplate = template => template.execution === 'companion' || template.category === 'companion';

const injection = { position: 0, depth: 4, role: 0, scan: false };
function agentFromTemplate(id, overrides = {}) {
    const template = templateById.get(id);
    assert.ok(template, `missing bundled template ${id}`);
    return { ...template, id: `${id}-agent`, sourceTemplateId: id, injection, ...overrides };
}

const PROSE = [
    'Kris lowered herself onto the stool, hands on her knees.',
    '"You could have warned me about the stairs," she said | half joking.',
];
const withProse = lines => [PROSE[0], '', ...lines, '', PROSE[1]].join('\n');
const expectedProse = PROSE.join('\n\n');

describe('companion line tracker echoes', () => {
    it('strips the clothing, vitals and position lines from the reported reply', () => {
        const agents = [
            agentFromTemplate('tpl-clothing-tracker-companion'),
            agentFromTemplate('tpl-vitals-companion'),
            agentFromTemplate('tpl-position-tracker-companion'),
        ];
        const reply = withProse([
            'clothing-start',
            'outfit|Kris|Loose linen shirt; dark trousers; bare feet',
            'outfit|Alhaitham|Black turtleneck; grey slacks',
            'outfit|Kaveh|Red apron over a white shirt',
            'clothing-end',
            'vitals|Kris|Overheated and a little shaky',
            'bar|Health|95|0|steady',
            'bar|Satiety|62|-8|hungry for dinner',
            'map-start|Alhaitham\'s House|6:28 PM, warm evening',
            'place|Study|Shelves of books and a reading lamp',
            'who|Kris|here|Sitting on the stool|Hands on knees',
            'who|Alhaitham|here|Reading chair|Turning a page',
            'place|Kitchen|Pans on the stove',
            'who|Kaveh|kitchen|At the stove|Stirring a pot',
            'map-end',
        ]);

        assert.equal(stripSavedAuxiliaryTrackerEchoes(reply, [], agents), expectedProse);
    });

    it('covers every bundled companion template that declares a line format', () => {
        const covered = [];
        for (const template of templates.filter(isCompanionTemplate)) {
            const declared = template.prompt.replace(/\r\n?/g, '\n').split('\n')
                .filter(line => extractTrackerLineKeys(line).size > 0)
                .map(line => line.replaceAll('{{user}}', 'Kris').replaceAll('{{char}}', 'Mira'));
            if (!declared.length) continue;
            covered.push(template.id);

            const agent = agentFromTemplate(template.id);
            const cleaned = stripSavedAuxiliaryTrackerEchoes(withProse(declared), [], [agent]);
            assert.equal(cleaned, expectedProse, `${template.id} echo was not stripped`);
        }

        for (const id of ['tpl-clothing-tracker-companion', 'tpl-position-tracker-companion', 'tpl-visual-map-companion', 'tpl-vitals-companion']) {
            assert.ok(covered.includes(id), `${id} should declare a line format`);
        }
    });

    it('declares no line format in bundled templates that run inline', () => {
        for (const template of templates.filter(template => !isCompanionTemplate(template))) {
            assert.deepEqual([...extractTrackerLineKeys(template.prompt)], [], `${template.id} declares line keys`);
        }
    });

    it('strips a custom companion format and keeps the same format for an inline agent', () => {
        const custom = {
            id: 'mood', name: 'Mood Ring', execution: 'companion', category: 'companion', injection,
            prompt: 'Track everyone\'s mood.\nmood-start\nmood|name|feeling|cause\nmood-end',
        };
        const reply = withProse(['mood-start', 'mood|Kris|Flustered|the stairs', 'MOOD_END']);
        assert.equal(stripSavedAuxiliaryTrackerEchoes(reply, [], [custom]), expectedProse);

        const inline = { id: 'inline', name: 'Inline Mood', category: 'tracker', execution: 'inline', prompt: custom.prompt };
        assert.equal(stripSavedAuxiliaryTrackerEchoes(reply, [], [custom, inline]), reply);
    });

    it('learns a format from saved output when the prompt never spells it out', () => {
        const custom = { id: 'rel', name: 'Bonds', execution: 'companion', prompt: 'List each bond on its own line.' };
        const keys = getActiveCompanionTrackerLineKeys([custom], extractTrackerLineKeys('bond|Kris|Kaveh|warm\nbond|Kris|Alhaitham|wary'));
        assert.deepEqual([...keys], ['bond']);
        assert.equal(stripTrackerLineEchoes(withProse(['bond|Kris|Kaveh|warm']), keys), expectedProse);
    });

    it('keeps prose, tables and unrelated keyword lines', () => {
        const keys = ['outfit', 'clothing-start', 'clothing-end'];
        const reply = 'Outfit check: fine.\n| outfit | Kris |\nclothing is optional\nnote|keep me\nShe said outfit|coat was enough.';
        assert.equal(stripTrackerLineEchoes(reply, keys), reply);
        assert.equal(stripTrackerLineEchoes(`${reply}\noutfit|`, keys), reply);
    });

    it('removes a code fence left empty by the strip', () => {
        const reply = `${PROSE[0]}\n\n\`\`\`\nclothing-start\noutfit|Kris|Coat\nclothing-end\n\`\`\`\n\n${PROSE[1]}`;
        assert.equal(stripTrackerLineEchoes(reply, ['outfit', 'clothing-start', 'clothing-end']), expectedProse);
    });

    it('names line formats in the echo guard and keeps the bracket wording unchanged', () => {
        const bracketOnly = buildTrackerEchoGuard(new Map([['REP', 'piped']]));
        assert.match(bracketOnly, /Companion-owned bracket formats/);
        assert.match(bracketOnly, /Do not emit any of: \[REP\|\.\.\.\], \[\/REP\]\. Opening one/);

        const lineOnly = buildTrackerEchoGuard(new Map(), ['vitals', 'bar', 'vitals-end']);
        assert.match(lineOnly, /Companion-owned line formats/);
        assert.match(lineOnly, /Do not emit any of: vitals\|\.\.\., bar\|\.\.\., vitals-end\. Starting a line/);
        assert.doesNotMatch(lineOnly, /closing tag/);

        const mixed = buildTrackerEchoGuard(new Map([['REP', 'piped']]), ['outfit']);
        assert.match(mixed, /Companion-owned bracket and line formats/);
        assert.match(mixed, /\[REP\|\.\.\.\], \[\/REP\], outfit\|\.\.\./);
    });

    it('guards fed line formats and strips every active companion format on the server', () => {
        const vitals = agentFromTemplate('tpl-vitals-companion', { companion: { feedback: { enabled: true, depth: 1 } } });
        const clothing = agentFromTemplate('tpl-clothing-tracker-companion');
        const snapshot = { agents: { hiddenIds: [] }, experimentalMacroEngine: false };
        const environment = { names: { char: 'Mira', user: 'Kris' }, evaluate: text => text };
        const records = [
            { chat_metadata: {} },
            { is_user: false, mes: 'Earlier reply.', extra: { inChatAgentCompanionResults: {
                [vitals.id]: { status: 'done', content: 'vitals|Kris|Tired\nbar|Health|90|-5|scraped knee\nvitals-end' },
            } } },
        ];

        const feedback = prepareCompanionFeedback([vitals, clothing], [], records, snapshot, environment, [], 'normal');
        const fed = feedback.extensions.find(extension => extension.key === `inchat_agent_companion_${vitals.id}`);
        assert.ok(fed, 'vitals feedback should be injected');
        assert.match(fed.content, /HARD STOP/);
        assert.match(fed.content, /vitals\|\.\.\., bar\|\.\.\., vitals-end/);
        assert.doesNotMatch(fed.content, /outfit\|\.\.\./);
        assert.deepEqual(feedback.trackerTags, []);
        for (const key of ['vitals', 'bar', 'status', 'vitals-end', 'outfit', 'clothing-start', 'clothing-end']) {
            assert.ok(feedback.trackerLineKeys.includes(key), `missing ${key}`);
        }

        const reply = withProse(['vitals|Kris|Fine', 'bar|Health|90|0|steady', 'vitals-end', 'clothing-start', 'outfit|Kris|Coat', 'clothing-end']);
        assert.equal(roleplayAgentOutputBaseline(reply, { trackerTags: feedback.trackerTags, trackerLineKeys: feedback.trackerLineKeys }), expectedProse);
        assert.equal(roleplayAgentOutputBaseline(reply, { trackerTags: [] }), reply);
    });
});
