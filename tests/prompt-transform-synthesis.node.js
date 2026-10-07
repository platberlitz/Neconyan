import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addAppendOutputs,
    cleanAppendOutput,
    composePromptTransformDraft,
    createPromptTransformDraft,
    planPromptTransformStages,
    runPromptTransformStages,
} from '../public/scripts/extensions/in-chat-agents/prompt-transform-synthesis.js';

const reply = 'She smiled and poured the tea.\n\n"Sugar?" she asked.';
const join = (left, right) => !left ? right : !right ? left : `${left}\n\n${right}`;
const isAppend = agent => agent.append === true;
const agents = ids => ids.map(id => ({ id, append: id.startsWith('a') }));
const describe = stages => stages.map(stage => `${stage.type}:${stage.agents.map(agent => agent.id).join(',')}`);

test('run together puts rewrites in order and gathers every append agent into one group', () => {
    const stages = planPromptTransformStages(agents(['a1', 'r1', 'a2', 'r2', 'a3']), { parallel: true, isAppend });
    assert.deepEqual(describe(stages), ['rewrite:r1', 'rewrite:r2', 'append:a1,a2,a3']);
});

test('one at a time follows Order and groups only neighbouring append agents', () => {
    const stages = planPromptTransformStages(agents(['a1', 'r1', 'a2', 'a3', 'r2']), { parallel: false, isAppend });
    assert.deepEqual(describe(stages), ['append:a1', 'rewrite:r1', 'append:a2,a3', 'rewrite:r2']);
});

test('an append output that repeats the reply keeps only its new content', () => {
    assert.equal(cleanAppendOutput(`${reply}\n\n1. Yes\n2. No`, reply), '1. Yes\n2. No');
    assert.equal(cleanAppendOutput(`[SCENE|Tea room]\n${reply.replace('\n\n', '\n')}`, reply), '[SCENE|Tea room]');
    assert.equal(cleanAppendOutput(`<assistant_response>${reply}</assistant_response>\nChoices: a`, reply), 'Choices: a');
});

test('an echoed reply is dropped but passages wait for the finished body', () => {
    assert.equal(cleanAppendOutput(` ${reply.replace(/\s+/g, ' ')} `, reply), '');
    const passage = 'She smiled and poured the tea.';
    assert.equal(cleanAppendOutput(passage, reply), passage);
    const draft = createPromptTransformDraft(reply);
    addAppendOutputs(draft, [{ agent: { id: 'a1' }, text: passage }]);
    assert.equal(composePromptTransformDraft(draft, join), reply);
    assert.equal(cleanAppendOutput('1. Yes', reply), '1. Yes');
    assert.equal(cleanAppendOutput('Hi there, more text', 'Hi'), 'Hi there, more text');
});

test('blocks are deduplicated across agents and placed by the prepend rule', () => {
    const draft = createPromptTransformDraft(reply);
    const isPrepend = (_agent, text) => text.startsWith('[SCENE');
    addAppendOutputs(draft, [
        { agent: { id: 'a1' }, text: '[SCENE|Tea room]' },
        { agent: { id: 'a2' }, text: `${reply}\n\n1. Yes  \n2. No` },
        { agent: { id: 'a3' }, text: '1. Yes\n2. No' },
    ], { isPrepend });
    addAppendOutputs(draft, [{ agent: { id: 'a4' }, text: '[SCENE|Tea room]' }], { isPrepend });
    assert.deepEqual(draft.before, ['[SCENE|Tea room]']);
    assert.deepEqual(draft.after, ['1. Yes  \n2. No']);
    assert.equal(composePromptTransformDraft(draft, join), `[SCENE|Tea room]\n\n${reply}\n\n1. Yes  \n2. No`);
    assert.equal(composePromptTransformDraft(createPromptTransformDraft('  Body  '), join), '  Body  ');
});

test('run together starts append agents on the incoming reply while rewrites edit only the body', async () => {
    const seen = [];
    let releaseRewrite;
    const rewriteHeld = new Promise(resolve => { releaseRewrite = resolve; });
    const result = runPromptTransformStages({
        agents: agents(['a1', 'r1']), text: reply, parallel: true, isAppend,
        runRewrite: async (_agent, body) => {
            seen.push(['rewrite', body]);
            await rewriteHeld;
            return { text: body.toUpperCase() };
        },
        runAppend: async (group, body) => {
            seen.push(['append', body]);
            releaseRewrite();
            return { outputs: group.map(agent => ({ agent, text: `${body}\n\nMenu` })) };
        },
    });
    const { draft, stopped } = await result;
    assert.equal(stopped, false);
    assert.deepEqual(seen, [['rewrite', reply], ['append', reply]]);
    assert.equal(composePromptTransformDraft(draft, join), `${reply.toUpperCase()}\n\nMenu`);
});

test('one at a time gives later append agents the rewritten body and keeps earlier blocks out of rewrites', async () => {
    const rewriteInputs = [];
    const { draft } = await runPromptTransformStages({
        agents: agents(['a1', 'r1', 'a2']), text: 'Plain reply', parallel: false, isAppend,
        runRewrite: async (_agent, body) => {
            rewriteInputs.push(body);
            return { text: 'Rewritten reply' };
        },
        runAppend: async (group, body) => ({ outputs: group.map(agent => ({ agent, text: `${agent.id} for ${body}` })) }),
    });
    assert.deepEqual(rewriteInputs, ['Plain reply']);
    assert.equal(composePromptTransformDraft(draft, join), 'Rewritten reply\n\na1 for Plain reply\n\na2 for Rewritten reply');
});

for (const parallel of [true, false]) {
    test(`${parallel ? 'parallel' : 'sequential'} merging compares held blocks with the finished reply`, async () => {
        const menu = '[CHOICES]\n1. Take the cup\n2. Decline politely\n[/CHOICES]';
        const original = `${reply}\n\n${menu}`;
        for (const rewritten of [reply.toUpperCase(), `${reply.toUpperCase()}\n\n${menu}`]) {
            const { draft } = await runPromptTransformStages({
                agents: agents(['a1', 'r1']), text: original, parallel, isAppend,
                runAppend: async group => ({ outputs: [{ agent: group[0], text: `${original}\n\n${menu}` }] }),
                runRewrite: async () => ({ text: rewritten }),
            });
            assert.equal(composePromptTransformDraft(draft, join), `${reply.toUpperCase()}\n\n${menu}`);
        }
    });
}

for (const failure of ['stop', 'throw']) {
    test(`an append ${failure} prevents later rewrites and waits for the one already running`, async () => {
        const calls = [];
        let releaseRewrite;
        const held = new Promise(resolve => { releaseRewrite = resolve; });
        let rewriteFinished = false;
        const run = runPromptTransformStages({
            agents: agents(['a1', 'r1', 'r2']), text: reply, parallel: true, isAppend,
            runRewrite: async agent => {
                calls.push(agent.id);
                await held;
                rewriteFinished = true;
                return { text: 'Rewritten' };
            },
            runAppend: async () => {
                calls.push('a1');
                if (failure === 'throw') throw new Error('append failed');
                return { stop: true };
            },
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(rewriteFinished, false);
        releaseRewrite();
        if (failure === 'throw') await assert.rejects(run, /append failed/);
        else assert.equal((await run).stopped, true);
        assert.equal(rewriteFinished, true);
        assert.deepEqual(calls, ['r1', 'a1']);
    });
}

test('a stop leaves out the stopping append group and later stages', async () => {
    const calls = [];
    const { draft, stopped } = await runPromptTransformStages({
        agents: agents(['a1', 'r1', 'a2']), text: 'Reply', parallel: true, isAppend,
        runRewrite: async () => {
            calls.push('rewrite');
            return { text: 'Partly rewritten', stop: true };
        },
        runAppend: async group => {
            calls.push('append');
            return { outputs: group.map(agent => ({ agent, text: 'Menu' })) };
        },
    });
    assert.equal(stopped, true);
    assert.deepEqual(calls.sort(), ['append', 'rewrite']);
    assert.equal(composePromptTransformDraft(draft, join), 'Partly rewritten');
});

test('a failing rewrite waits for the append group before the error surfaces', async () => {
    let appendFinished = false;
    await assert.rejects(runPromptTransformStages({
        agents: agents(['a1', 'r1']), text: 'Reply', parallel: true, isAppend,
        runRewrite: async () => { throw new Error('rewrite failed'); },
        runAppend: async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            appendFinished = true;
            return { outputs: [] };
        },
    }), /rewrite failed/);
    assert.equal(appendFinished, true);
});
