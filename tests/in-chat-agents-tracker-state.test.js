import { readFileSync } from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    findTrackerBlocks,
    getCompanionTrackerAutoRepairPayload,
    getTrackerRepairPayload,
    hasUnlabelledTrackerBullets,
    inspectCompanionTrackerOutput,
    inspectTrackerRepairState,
    inspectTrackerState,
    mergeTrackerRepairPayload,
    normalizeCompanionTrackerRepairPayload,
    repairTrackerFieldOrder,
    writeTrackerMetadataValue,
} = await import('../public/scripts/extensions/in-chat-agents/tracker-state.js');

const statusAgent = {
    prompt: '[STATUS|Character|Condition|Severity]\nnote\n[/STATUS]',
    postProcess: {
        extractPattern: '\\[STATUS\\|[^\\]]*\\][\\s\\S]*?\\[/STATUS\\]',
        extractVariable: 'status_data',
    },
};

const templates = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/index.json', import.meta.url), 'utf8'));
const bundles = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/regex-bundles.json', import.meta.url), 'utf8'));
const tracker = id => ({ ...templates.find(agent => agent.id === id), regexScripts: bundles[id] });
const eventAgent = tracker('tpl-event-tracker');
const event = '[EVENT|✅ RESOLVED|The war question was answered|Tonight]\ncontext: The answer is the Archon War.\n[/EVENT]';
const promise = '[EVENT|💬 PROMISE|Defer the remaining questions|Tomorrow]\ncontext: They will talk after resting.\n[/EVENT]';
const brokenEvent = event.replace('|✅ RESOLVED|', '|⚠️ THREAT|✅ RESOLVED|');

describe('tracker repair display audit', () => {
    test.each(templates.filter(agent => agent.category === 'tracker').map(agent => [agent.id]))('%s accepts its bundled format examples', id => {
        const agent = tracker(id);
        const { tag } = inspectTrackerState(agent, agent.prompt);
        const examples = findTrackerBlocks(agent.prompt, tag).filter(block => block.complete
            && /^\[[^\n]+\]\n[\s\S]*\n\[\/[^\n]+\]$/.test(block.text));
        expect(examples.length).toBeGreaterThan(0);
        for (const block of examples) {
            expect(inspectTrackerRepairState(agent, block.text).status).toBe('valid');
            expect(normalizeCompanionTrackerRepairPayload(agent, block.text).payload).toBe(block.text);
            expect(inspectCompanionTrackerOutput(agent, block.text).action).toBe('keep');
        }
    });

    test.each([
        ['tpl-npc-profiles', '[NPC:REF|Ava|red scarf|wary]', '[NPC:REL|Bo|trust increased]'],
        ['tpl-the-census', '[CENSUS:SIGHTING|Ava|red scarf|wary]', '[CENSUS:AMENDED|Bo|trust increased]'],
    ])('%s keeps complete one-line variants without consuming following prose', (id, first, second) => {
        const agent = tracker(id);
        const text = `Before\n${first}\nBetween\n${second}\nAfter`;
        expect(inspectTrackerRepairState(agent, text).payloads).toEqual([first, second]);
        expect(normalizeCompanionTrackerRepairPayload(agent, `${first}\n${second}`).payload).toBe(`${first}\n\n${second}`);
        expect(inspectCompanionTrackerOutput(agent, `${first}\n${second}`).action).toBe('keep');
        expect(mergeTrackerRepairPayload(agent, text, `${second}\n${first}`).text)
            .toBe(`Before\n${second}\n\n${first}\nBetween\n\nAfter`);
    });

    test('repairs an unrenderable event even when the neighbouring record renders', () => {
        const mixed = `${brokenEvent}\n\n${promise}`;
        expect(inspectTrackerState(eventAgent, mixed).status).toBe('valid');
        expect(inspectTrackerRepairState(eventAgent, mixed).status).toBe('unrenderable');
        expect(normalizeCompanionTrackerRepairPayload(eventAgent, mixed).payload).toBe('');
        expect(inspectCompanionTrackerOutput(eventAgent, mixed)).toEqual({ action: 'repair', content: '', reason: 'unrenderable' });
        expect(getCompanionTrackerAutoRepairPayload(eventAgent, mixed)).toBe('');
        expect(normalizeCompanionTrackerRepairPayload(eventAgent, `${event}\n\n${promise}`, { previousText: mixed }).payload)
            .toBe(`${event}\n\n${promise}`);
        expect(normalizeCompanionTrackerRepairPayload(eventAgent, event, { previousText: mixed }).status).toBe('missing-records');
        expect(getCompanionTrackerAutoRepairPayload(eventAgent, event, { previousText: mixed })).toBe('');
    });

    test('does not count a stray closing tag as another record to preserve', () => {
        const previousText = `${brokenEvent}\n[/EVENT]`;
        expect(normalizeCompanionTrackerRepairPayload(eventAgent, event, { previousText }).payload).toBe(event);
        expect(getCompanionTrackerAutoRepairPayload(eventAgent, event, { previousText })).toBe(event);
    });

    test('uses only enabled assistant display rules, including combined display and prompt rules', () => {
        const script = { findRegex: '\\[STATUS\\|[^\\]]*\\][\\s\\S]*?\\[/STATUS\\]', replaceString: '<aside>Ready</aside>', placement: [2] };
        const text = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]';
        for (const overrides of [{ disabled: true }, { markdownOnly: false, promptOnly: true }, { placement: [1] }]) {
            expect(inspectTrackerRepairState({ ...statusAgent, regexScripts: [{ ...script, findRegex: 'never matches', ...overrides }] }, text).status).toBe('valid');
        }
        expect(inspectTrackerRepairState({ ...statusAgent, regexScripts: [{ ...script, promptOnly: true }] }, text).status).toBe('valid');
        expect(inspectTrackerRepairState({ ...statusAgent, regexScripts: [{ ...script, promptOnly: true, findRegex: 'never matches' }] }, text).status).toBe('unrenderable');
        expect(inspectTrackerRepairState({ ...statusAgent, regexScripts: [{ ...script, findRegex: 'note', replaceString: 'changed' }] }, text).status).toBe('unrenderable');
    });

    test('repairs field order without a model and checks the result against the display rule', () => {
        const agent = tracker('tpl-relationship-tracker');
        const correct = findTrackerBlocks(agent.prompt, 'METER').find(block => block.complete).text;
        const swapped = correct.replace(/(date: [^\n]*)\n(turn: [^\n]*)/, '$2\n$1');
        expect(inspectTrackerRepairState(agent, swapped).status).toBe('unrenderable');
        expect(normalizeCompanionTrackerRepairPayload(agent, swapped).payload).toBe(correct);
    });

    test('uses the supplied macro substitutions when matching a custom display regex', () => {
        const agent = { ...statusAgent, regexScripts: [{ findRegex: '\\[STATUS\\|{{char}}\\|[^\\]]*\\][\\s\\S]*?\\[/STATUS\\]',
            replaceString: '<aside>$0</aside>', substituteRegex: 1 }] };
        const text = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]';
        const options = { characterOverride: 'Alice', substituteParamsFn: value => value.replace('{{char}}', 'Alice') };
        expect(inspectTrackerRepairState(agent, text, options).status).toBe('unrenderable');
        agent.regexScripts[0].replaceString = '<aside>Ready</aside>';
        expect(inspectTrackerRepairState(agent, text, options).status).toBe('valid');
    });
});

describe('in-chat agent tracker state', () => {
    test('field order repair retains exact values, inline HTML, and surrounding trackers', () => {
        const agent = { ...statusAgent, prompt: '[STATUS|Name]\ndate: time\nturn: event\n[/STATUS]' };
        const original = 'Before\n[STATUS|Alice]\nturn: <font color="red">A: B</font>\ndate: Dinner\n[/STATUS]\n[NPC|Bob]Keep[/NPC]\nAfter';
        const fixed = repairTrackerFieldOrder(agent, original);
        expect(fixed).toBe(original.replace('turn: <font color="red">A: B</font>\ndate: Dinner', 'date: Dinner\nturn: <font color="red">A: B</font>'));
        expect(repairTrackerFieldOrder(agent, fixed)).toBe(fixed);
    });

    test.each([
        'turn: One\nturn: Two',
        'turn: One\nunknown: Two',
        'turn: One\nNarration\ndate: Dinner',
        'turn: One',
    ])('field order repair leaves ambiguous or incomplete fields unchanged: %s', body => {
        const agent = { ...statusAgent, prompt: '[STATUS|Name]\ndate: time\nturn: event\n[/STATUS]' };
        const original = `[STATUS|Alice]\n${body}\n[/STATUS]`;
        expect(repairTrackerFieldOrder(agent, original)).toBe(original);
    });
    test('uses complete structural blocks when a configured pattern is stale', () => {
        const agent = {
            ...statusAgent,
            postProcess: {
                ...statusAgent.postProcess,
                extractPattern: '\\\\[STATUS\\\\|[^\\\\]]*\\\\]',
            },
        };
        const text = 'Story\n\n[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]';

        expect(inspectTrackerState(agent, text)).toEqual(expect.objectContaining({
            status: 'valid',
            value: '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]',
            tag: 'STATUS',
        }));
    });

    test('requires the expected closer instead of accepting a header match', () => {
        const text = 'Story\n\n[STATUS|Alice|Tired|Moderate]\nnote: Long day';
        const inspection = inspectTrackerState(statusAgent, text);

        expect(inspection.status).toBe('malformed');
        expect(inspection.value).toBe('');
        expect(inspection.blocks).toEqual([
            expect.objectContaining({ complete: false, replaceable: false }),
        ]);
    });

    test('normalizes a single malformed Companion card closer without relaxing message repair', () => {
        const malformedCloser = '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n/STATUS]';
        const missingCloser = '[STATUS|Alice|Tired|Moderate]\nnote: Long day';

        expect(normalizeCompanionTrackerRepairPayload(statusAgent, malformedCloser).payload)
            .toBe('[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]');
        expect(normalizeCompanionTrackerRepairPayload(statusAgent, missingCloser).payload)
            .toBe('[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]');
        expect(normalizeCompanionTrackerRepairPayload(statusAgent, `Story\n${missingCloser}`).payload).toBe('');
        expect(mergeTrackerRepairPayload(statusAgent, `Story\n${missingCloser}`, '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'unsafe-malformed' }));
    });

    test('rejects incomplete openers and mixed complete and malformed blocks', () => {
        const incompleteOpener = '[STATUS|Alice|Tired|Moderate\nnote: Long day\n[/STATUS]';
        const mixed = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]\n[STATUS|Bob|Broken|Severe]';

        expect(inspectTrackerState(statusAgent, incompleteOpener).status).toBe('malformed');
        expect(inspectTrackerState(statusAgent, mixed)).toEqual(expect.objectContaining({
            status: 'malformed',
            value: '',
        }));
        expect(mergeTrackerRepairPayload(statusAgent, 'Story', mixed))
            .toEqual(expect.objectContaining({ changed: false, reason: 'invalid-payload' }));
    });

    test('rejects unmatched closing tags instead of appending beside malformed markup', () => {
        const strayCloser = 'Story\n[/STATUS]';
        const mixed = '[STATUS|Alice|Ready|Mild]\nnote\n[/STATUS]\n[/STATUS]';
        const repaired = '[STATUS|Alice|Ready|Mild]\nrepaired\n[/STATUS]';

        expect(inspectTrackerState(statusAgent, strayCloser).status).toBe('malformed');
        expect(inspectTrackerState(statusAgent, mixed).status).toBe('malformed');
        expect(mergeTrackerRepairPayload(statusAgent, strayCloser, repaired))
            .toEqual(expect.objectContaining({ text: strayCloser, changed: false, reason: 'unsafe-malformed' }));
    });

    test('repairs a broken opening header bounded by its explicit closer', () => {
        const broken = '[STATUS|Alice|Tired|Moderate\nnote: Long day\n[/STATUS]';
        const repaired = '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]';
        expect(inspectTrackerState(statusAgent, broken).status).toBe('malformed');
        expect(findTrackerBlocks(broken, 'STATUS')).toEqual([
            expect.objectContaining({ complete: false, replaceable: true, text: broken }),
        ]);
        expect(mergeTrackerRepairPayload(statusAgent, `Before\n${broken}\nAfter`, repaired))
            .toEqual(expect.objectContaining({ text: `Before\n${repaired}\nAfter`, changed: true }));
    });

    test('repairs mixed bounded blocks without consuming intervening prose or other trackers', () => {
        const original = 'Before\n[STATUS|Alice|Tired|Moderate]\none\n[/STATUS]\nBetween\n[STATUS|Bob|Tired|Moderate\ntwo\n[/STATUS]\n[ITEM|Key]keep[/ITEM]\nAfter';
        const repaired = '[STATUS|Alice|Ready|Mild]\none\n[/STATUS]\n\n[STATUS|Bob|Ready|Mild]\ntwo\n[/STATUS]';
        expect(mergeTrackerRepairPayload(statusAgent, original, repaired).text)
            .toBe(`Before\n${repaired}\nBetween\n\n[ITEM|Key]keep[/ITEM]\nAfter`);
    });

    test('uses configured extraction for custom non-bracket trackers', () => {
        const agent = {
            prompt: 'Return one STATE line.',
            postProcess: {
                extractPattern: 'STATE: [^\\n]+',
                extractVariable: 'custom_state',
            },
        };

        expect(inspectTrackerState(agent, 'Story\nSTATE: ready')).toEqual(expect.objectContaining({
            status: 'valid',
            value: 'STATE: ready',
            tag: '',
        }));
        expect(mergeTrackerRepairPayload(agent, 'Story', 'STATE: ready').text).toBe('Story\n\nSTATE: ready');

        expect(inspectTrackerState(agent, 'STATE: ready\n[STATUS|Alice|Tired|Moderate]\nnote\n[/STATUS]')).toEqual(expect.objectContaining({
            status: 'valid',
            value: 'STATE: ready',
            tag: '',
        }));
    });

    test('collects repeated NPC variants with their shared closer', () => {
        const agent = {
            prompt: '[NPC:MAJOR|Name]\n...\n[/NPC]',
            postProcess: {
                extractPattern: '\\[NPC(?::(?:MAJOR|SUPPORT|MINOR|UP|REF|REL))?\\|[^\\]]+\\][\\s\\S]*?\\[/NPC\\]',
            },
        };
        const text = '[NPC:REF|Ava|red scarf|wary][/NPC]\n[NPC:REL|Bo|trust increased][/NPC]';

        const inspection = inspectTrackerState(agent, text);
        expect(inspection.status).toBe('valid');
        expect(inspection.payloads).toEqual([
            '[NPC:REF|Ava|red scarf|wary][/NPC]',
            '[NPC:REL|Bo|trust increased][/NPC]',
        ]);
        expect(findTrackerBlocks(text, 'NPC')).toHaveLength(2);
    });

    test('replaces all existing blocks atomically while preserving prose', () => {
        const original = 'Before\n[STATUS|A|Old|Mild]\none\n[/STATUS]\nBetween\n[STATUS|B|Old|Mild]\ntwo\n[/STATUS]\nAfter';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';
        const result = mergeTrackerRepairPayload(statusAgent, original, repaired);

        expect(result).toEqual(expect.objectContaining({ changed: true, replaced: true, reason: '' }));
        expect(result.text).toBe(`Before\n${repaired}\nBetween\n\nAfter`);
    });

    test('refuses to replace an unclosed trailing block with an ambiguous suffix', () => {
        const original = 'Story remains.\n\n[STATUS|A|Broken|Severe]\nnote: missing closer';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';

        expect(mergeTrackerRepairPayload(statusAgent, original, repaired))
            .toEqual(expect.objectContaining({ text: original, changed: false, reason: 'unsafe-malformed' }));
    });

    test('refuses to replace an unbounded leading malformed block and following prose', () => {
        const original = '[STATUS|A|Broken|Severe]\nnote: missing closer\nNarrative that must remain.';
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';

        expect(mergeTrackerRepairPayload(statusAgent, original, repaired))
            .toEqual(expect.objectContaining({ text: original, changed: false, reason: 'unsafe-malformed' }));
    });

    test('refuses ambiguous malformed spans and invalid generated payloads', () => {
        const ambiguous = '[STATUS|A|Broken|Severe]\nprose\n[STATUS|B|Broken|Severe]';

        expect(mergeTrackerRepairPayload(statusAgent, ambiguous, '[STATUS|A|Ready|Mild]\nnote\n[/STATUS]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'unsafe-malformed' }));
        expect(mergeTrackerRepairPayload(statusAgent, 'Story', '[STATUS|still broken]'))
            .toEqual(expect.objectContaining({ changed: false, reason: 'invalid-payload' }));
    });

    test('appends a missing valid payload without changing the source prose', () => {
        const repaired = '[STATUS|A|Ready|Mild]\nnote: recovered\n[/STATUS]';
        const result = mergeTrackerRepairPayload(statusAgent, 'Story remains.', repaired);

        expect(result.text).toBe(`Story remains.\n\n${repaired}`);
        expect(getTrackerRepairPayload(statusAgent, result.text).payload).toBe(repaired);
    });

    test('Companion card repair rewrites Parallel bullets that have no "Name:" label', () => {
        const parallelAgent = JSON.parse(readFileSync(new URL('../public/scripts/extensions/in-chat-agents/templates/parallel-tracker.json', import.meta.url), 'utf8'));
        const unlabelled = '[PARALLEL|Multiple locations|regularities]\n- The student is recopying notes.\n- At Lambad\u2019s, the bar matron is boiling stew.\n- In Inazuma, Masayoshi practises iaido.\n[/PARALLEL]';
        const labelled = '[PARALLEL|Multiple locations|regularities]\n- Student: recopying notes.\n- Bar matron: boiling stew at Lambad\u2019s.\n- Masayoshi: practising iaido in Inazuma.\n[/PARALLEL]';

        expect(parallelAgent.prompt).toContain('- Person: what they are doing');
        expect(inspectTrackerState(parallelAgent, unlabelled).status).toBe('valid');
        expect(hasUnlabelledTrackerBullets(parallelAgent, unlabelled)).toBe(true);
        expect(normalizeCompanionTrackerRepairPayload(parallelAgent, unlabelled))
            .toEqual(expect.objectContaining({ status: 'unlabelled', payload: '' }));
        expect(hasUnlabelledTrackerBullets(parallelAgent, labelled)).toBe(false);
        expect(normalizeCompanionTrackerRepairPayload(parallelAgent, labelled).payload).toBe(labelled);
        expect(hasUnlabelledTrackerBullets(statusAgent, '[STATUS|A|Ready|Mild]\n- note\n[/STATUS]')).toBe(false);
    });
});

describe('writeTrackerMetadataValue', () => {
    test('extracted state lands in the host variable store as well as the legacy key', () => {
        const metadata = {};
        expect(writeTrackerMetadataValue(metadata, 'agent_status_data', '[STATUS|x]')).toBe(true);
        expect(metadata.agent_status_data).toBe('[STATUS|x]');
        expect(metadata.variables.agent_status_data).toBe('[STATUS|x]');
        expect(writeTrackerMetadataValue(metadata, 'agent_status_data', '[STATUS|x]')).toBe(false);
    });

    test('clearing removes both copies and reports whether anything existed', () => {
        const metadata = { agent_status_data: 'old', variables: { agent_status_data: 'old', other: 'keep' } };
        expect(writeTrackerMetadataValue(metadata, 'agent_status_data', '')).toBe(true);
        expect(metadata.agent_status_data).toBeUndefined();
        expect(metadata.variables.agent_status_data).toBeUndefined();
        expect(metadata.variables.other).toBe('keep');
        expect(writeTrackerMetadataValue(metadata, 'agent_status_data', '')).toBe(false);
        expect(writeTrackerMetadataValue(null, 'agent_status_data', 'x')).toBe(false);
    });
});

describe('inspectCompanionTrackerOutput', () => {
    const trackerAgent = { ...statusAgent, category: 'tracker' };
    const block = '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n[/STATUS]';
    const roleplay = 'Alice pushed the tavern door open and shook the rain from her cloak. "Another long night," she muttered, '
        + 'dropping into the chair by the fire while the barkeep slid a mug across the counter towards her.';

    test('keeps a clean tracker block untouched', () => {
        expect(inspectCompanionTrackerOutput(trackerAgent, block)).toEqual({ action: 'keep', content: block, reason: 'valid' });
    });

    test('keeps a short preamble beside a valid block', () => {
        const text = `Here is the update:\n${block}`;
        expect(inspectCompanionTrackerOutput(trackerAgent, text)).toEqual(expect.objectContaining({ action: 'keep', content: text }));
    });

    test.each([
        ['before', `${roleplay}\n\n${block}`],
        ['after', `${block}\n\n${roleplay}`],
    ])('asks for a fresh reply when roleplay sits %s the tracker', (_where, text) => {
        expect(inspectCompanionTrackerOutput(trackerAgent, text)).toEqual({ action: 'regenerate', content: block, reason: 'story-text' });
    });

    test('flags short dialogue or actions as roleplay too', () => {
        const text = `*She smiles and leans closer.* "Come on, tell me more."\n${block}`;
        expect(inspectCompanionTrackerOutput(trackerAgent, text).action).toBe('regenerate');
    });

    test('asks for a fresh reply when the output is prose with no tracker', () => {
        expect(inspectCompanionTrackerOutput(trackerAgent, roleplay)).toEqual({ action: 'regenerate', content: '', reason: 'no-tracker' });
    });

    test('keeps the empty-output sentinel', () => {
        expect(inspectCompanionTrackerOutput(trackerAgent, 'tracker-none')).toEqual({ action: 'keep', content: 'tracker-none', reason: 'empty' });
        expect(inspectCompanionTrackerOutput(trackerAgent, `tracker-none\n${roleplay}`).action).toBe('regenerate');
    });

    test('fixes a mistyped closer locally', () => {
        const text = '[STATUS|Alice|Tired|Moderate]\nnote: Long day\n/STATUS]';
        expect(inspectCompanionTrackerOutput(trackerAgent, text)).toEqual({ action: 'keep', content: block, reason: 'closer-fixed' });
    });

    test('sends a block that never closes or has unlabelled bullets to repair', () => {
        expect(inspectCompanionTrackerOutput(trackerAgent, `[STATUS|Alice|Tired|Moderate]\nnote: Long day\n${roleplay}`))
            .toEqual({ action: 'repair', content: '', reason: 'malformed' });
        const parallel = {
            category: 'tracker',
            prompt: '[PARALLEL]\n- Person: what they are doing\n[/PARALLEL]',
            postProcess: { extractPattern: '\\[PARALLEL\\][\\s\\S]*?\\[/PARALLEL\\]' },
        };
        expect(inspectCompanionTrackerOutput(parallel, '[PARALLEL]\n- walking to the market\n[/PARALLEL]').action).toBe('repair');
    });

    test('leaves non-trackers, unknown formats and unconfigured tags alone', () => {
        expect(inspectCompanionTrackerOutput(statusAgent, roleplay).reason).toBe('not-checked');
        expect(inspectCompanionTrackerOutput({ category: 'tracker', prompt: 'Summarise the scene.' }, roleplay).reason).toBe('not-checked');
        const multiAgent = { ...trackerAgent, prompt: `${trackerAgent.prompt}\n[NPC|Name]\nnote: what they want\n[/NPC]` };
        const multi = `${block}\n[NPC|Bob]\n${roleplay}\n[/NPC]`;
        expect(inspectCompanionTrackerOutput(multiAgent, multi)).toEqual(expect.objectContaining({ action: 'keep', reason: 'unknown-structure' }));
    });

    test('treats blocks copied from the story reply as roleplay, not a custom format', () => {
        const thought = '[THOUGHT|Something Is Running My Body|COOKING|2 of 3]\nnote: The clinical words are gone now.\n[/THOUGHT]';
        expect(inspectCompanionTrackerOutput(trackerAgent, `${roleplay}\n\n${thought}\n\n${block}`))
            .toEqual({ action: 'regenerate', content: block, reason: 'story-text' });
        const copied = `[COLORS:Alice=#e86d96]\n\n${roleplay}\n[VOICE|Alice]\nquiet\n[/VOICE]\n${block}\n[METER|Mood|4]\nnote: calm\n[/METER]`;
        expect(inspectCompanionTrackerOutput(trackerAgent, copied)).toEqual({ action: 'regenerate', content: block, reason: 'story-text' });
        expect(inspectCompanionTrackerOutput(trackerAgent, `${roleplay}\n${thought}`)).toEqual({ action: 'regenerate', content: '', reason: 'no-tracker' });
    });

    test('reads extra block tags from an escaped extract pattern', () => {
        const patterned = { category: 'tracker', prompt: 'Track the scene.',
            postProcess: { extractPattern: '\\[STATUS\\|[^\\]]*\\][\\s\\S]*?\\[/STATUS\\]|\\[NPC\\|[^\\]]*\\][\\s\\S]*?\\[\\/NPC\\]' } };
        expect(inspectCompanionTrackerOutput(patterned, `${block}\n[NPC|Bob]\n${roleplay}\n[/NPC]`).reason).toBe('unknown-structure');
    });

    test('automatic repair rejects a block that never closes instead of closing it around prose', () => {
        expect(getCompanionTrackerAutoRepairPayload(trackerAgent, `Fixed:\n${block}`)).toBe(block);
        expect(getCompanionTrackerAutoRepairPayload(trackerAgent, `${roleplay}\n${block}`)).toBe(block);
        expect(getCompanionTrackerAutoRepairPayload(trackerAgent, `[STATUS|Alice|Tired|Moderate]\n${roleplay}`)).toBe('');
        expect(getCompanionTrackerAutoRepairPayload(trackerAgent, roleplay)).toBe('');
        expect(getCompanionTrackerAutoRepairPayload(trackerAgent, 'tracker-none')).toBe('');
    });
});
