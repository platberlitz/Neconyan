import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const miso = require('../.github/miso/merge-bot.cjs');
const gallery = require('../.github/miso/gallery.json');

const SHA = 'abcdef1234567890';

function pr(overrides = {}) {
    return { number: 7, state: 'open', draft: false, mergeable: true, labels: [], base: { ref: 'staging' }, head: { sha: SHA }, ...overrides };
}

function check(name, conclusion = 'success', overrides = {}) {
    return { id: 1, name, status: 'completed', conclusion, ...overrides };
}

function fakeGitHub({ pull, checkRuns = [], checkRunsQueue, statuses = [], reviews = [], comments = [], onGet }) {
    const calls = { created: [], updated: [], checks: 0, gets: 0 };
    const rest = {
        pulls: {
            list: () => {},
            get: async () => { calls.gets += 1; onGet?.(); return { data: pull }; },
            listReviews: () => {},
        },
        checks: { listForRef: () => {} },
        repos: { getCombinedStatusForRef: async () => ({ data: { statuses } }) },
        issues: {
            listComments: () => {},
            createComment: async args => { calls.created.push(args); },
            updateComment: async args => { calls.updated.push(args); },
        },
    };
    const pages = new Map([
        [rest.pulls.list, [pull]],
        [rest.pulls.listReviews, reviews],
        [rest.checks.listForRef, checkRuns],
        [rest.issues.listComments, comments],
    ]);
    const paginate = async method => {
        if (method === rest.checks.listForRef) {
            calls.checks += 1;
            if (checkRunsQueue) {
                return checkRunsQueue.length > 1 ? checkRunsQueue.shift() : checkRunsQueue[0];
            }
        }
        return pages.get(method);
    };
    return { calls, github: { rest, paginate } };
}

const context = { repo: { owner: 'platberlitz', repo: 'Neconyan' } };
const core = { info() {}, warning(message) { throw new Error(message); } };
const sleep = async () => {};

test('a clean pull request with finished checks is ready', () => {
    const result = miso.evaluatePullRequest({ pr: pr(), checkRuns: [check('lint'), check('tests', 'skipped'), check('PR Label Warning', 'neutral')] });
    assert.deepEqual(result, { state: 'ready', reasons: [] });
});

test('drafts and closed pull requests are skipped', () => {
    assert.equal(miso.evaluatePullRequest({ pr: pr({ draft: true }), checkRuns: [check('lint')] }).state, 'skip');
    assert.equal(miso.evaluatePullRequest({ pr: pr({ state: 'closed' }), checkRuns: [check('lint')] }).state, 'skip');
});

test('Miso stays quiet while checks run or before any check exists', () => {
    assert.equal(miso.evaluatePullRequest({ pr: pr(), checkRuns: [check('lint'), check('tests', null, { status: 'in_progress' })] }).state, 'pending');
    assert.equal(miso.evaluatePullRequest({ pr: pr(), checkRuns: [] }).state, 'pending');
    assert.equal(miso.evaluatePullRequest({ pr: pr({ mergeable: null }), checkRuns: [check('lint')] }).state, 'pending');
    assert.equal(miso.evaluatePullRequest({ pr: pr(), checkRuns: [check('lint')], statuses: [{ context: 'ci', state: 'pending' }] }).state, 'pending');
});

test('her own running check does not hold the verdict back', () => {
    const result = miso.evaluatePullRequest({ pr: pr(), checkRuns: [check('lint'), check('🐯 Miso merge check', null, { status: 'in_progress' })] });
    assert.equal(result.state, 'ready');
});

test('only the latest run of each check counts', () => {
    const checkRuns = [check('tests', 'failure', { id: 1 }), check('tests', 'success', { id: 2 })];
    assert.equal(miso.evaluatePullRequest({ pr: pr(), checkRuns }).state, 'ready');
    const rerunFailed = [check('tests', 'success', { id: 1 }), check('tests', 'failure', { id: 2 })];
    assert.equal(miso.evaluatePullRequest({ pr: pr(), checkRuns: rerunFailed }).state, 'blocked');
});

test('every kind of blocker is listed, even while other checks still run', () => {
    const result = miso.evaluatePullRequest({
        pr: pr({ mergeable: false, labels: [{ name: '🔨 Needs Work' }, { name: '🟩 ⬤○○○○' }] }),
        checkRuns: [check('lint', 'failure'), check('e2e', 'timed_out'), check('tests', null, { status: 'queued' })],
        statuses: [{ context: 'deploy', state: 'error' }],
        reviews: [
            { user: { login: 'reviewer' }, state: 'APPROVED' },
            { user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
            { user: { login: 'reviewer' }, state: 'COMMENTED' },
            { user: { login: 'helper' }, state: 'CHANGES_REQUESTED' },
            { user: { login: 'helper' }, state: 'DISMISSED' },
        ],
    });
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.reasons, [
        'This branch has merge conflicts with `staging`.',
        'The **lint** check failed.',
        'The **e2e** check timed out.',
        'The **deploy** status reported an error.',
        '@reviewer asked for changes.',
        'It has the **🔨 Needs Work** label.',
    ]);
});

test('every blocking label from the Pull Request Manager blocks Miso too', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/pr-auto-manager.yml', import.meta.url), 'utf8');
    const listed = workflow.match(/const blockingLabels = \[([\s\S]*?)\];/)[1].match(/"([^"]+)"/g).map(label => label.slice(1, -1));
    assert.deepEqual([...miso.BLOCKING_LABELS].sort(), listed.sort());
});

test('every character has Sunburst and Flare pictures and lines for both states', () => {
    const ids = new Set();
    for (const state of ['ready', 'blocked']) {
        assert.deepEqual(Object.keys(gallery[state]).sort(), ['kris', 'miso', 'nori', 'taro']);
        for (const [character, models] of Object.entries(gallery[state])) {
            assert.ok(miso.CHARACTERS[character].headings[state]);
            assert.ok(miso.CHARACTERS[character].messages[state].length > 0);
            assert.deepEqual(Object.keys(models).sort(), character === 'kris' ? ['sunburst'] : ['flare', 'sunburst']);
            for (const [model, pictures] of Object.entries(models)) {
                assert.ok(pictures.length > 0);
                for (const picture of pictures) {
                    assert.match(picture.id, new RegExp(`^${character}-${state}-\\d+-${model}$`));
                    assert.match(picture.url, /^https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}$/);
                    assert.ok(picture.alt.length > 0);
                    assert.ok(!ids.has(picture.id), `duplicate picture id ${picture.id}`);
                    ids.add(picture.id);
                }
            }
        }
    }
});

test('the character is rolled first, then the model, then one of its pictures', () => {
    assert.equal(miso.pickPicture('ready', () => 0).id, gallery.ready.miso.sunburst[0].id);
    assert.equal(miso.pickPicture('blocked', () => 0.99).id, gallery.blocked.kris.sunburst.at(-1).id);
    assert.equal(miso.pickPicture('blocked', () => 0.5).character, 'taro');
    const rolls = [0.7, 0.99, 0];
    const nori = miso.pickPicture('blocked', () => rolls.shift());
    assert.equal(nori.id, gallery.blocked.nori.flare[0].id);
    assert.equal(nori.character, 'nori');
    assert.equal(nori.model, 'flare');
});

test('Yukkuri Kris is the rare one', () => {
    const weights = Object.fromEntries(Object.entries(miso.CHARACTERS).map(([name, character]) => [name, character.weight]));
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    assert.equal(weights.kris / total, 0.1);
    assert.equal(weights.miso, weights.taro);
    assert.equal(weights.taro, weights.nori);
    assert.equal(miso.pickPicture('ready', () => 0.89).character, 'nori');
    assert.equal(miso.pickPicture('ready', () => 0.9).character, 'kris');
});

test('every line follows the house writing rules', () => {
    for (const character of Object.values(miso.CHARACTERS)) {
        const lines = [...Object.values(character.headings), ...character.messages.ready, ...character.messages.blocked];
        for (const line of lines) {
            assert.doesNotMatch(line, /\u2014/, line);
            assert.doesNotMatch(line, /\bpurr/i, line);
            assert.doesNotMatch(line, /\b(color|favorite|realize|organize)\b/i, line);
        }
    }
});

test('the comment keeps its picture while the state holds and redraws when it flips', () => {
    const blocked = { state: 'blocked', reasons: ['The **lint** check failed.'] };
    const first = miso.planComment({ evaluation: blocked, existingBody: undefined, sha: SHA, random: () => 0 });
    assert.match(first, /state=blocked picture=miso-blocked-1-sunburst message=0/);
    assert.match(first, /Miso says: merge blocked/);
    assert.match(first, /- The \*\*lint\*\* check failed\./);
    assert.match(first, /Picture drawn by Sunburst\. Checked at commit `abcdef1`\./);
    assert.doesNotMatch(first, /\u2014/);

    assert.equal(miso.planComment({ evaluation: blocked, existingBody: first, sha: SHA, random: () => 0.99 }), null);

    const moreReasons = { state: 'blocked', reasons: ['The **lint** check failed.', 'It has the **🔨 Needs Work** label.'] };
    const updated = miso.planComment({ evaluation: moreReasons, existingBody: first, sha: SHA, random: () => 0.99 });
    assert.match(updated, /picture=miso-blocked-1-sunburst message=0/);
    assert.match(updated, /Needs Work/);

    const ready = miso.planComment({ evaluation: { state: 'ready', reasons: [] }, existingBody: updated, sha: SHA, random: () => 0.99 });
    assert.match(ready, /state=ready picture=kris-ready-1-sunburst message=1/);
    assert.match(ready, /A wild Yukkuri Kris appeared: ready to merge/);
    assert.match(ready, /Picture drawn by Sunburst/);
    assert.doesNotMatch(ready, /^- /m);

    assert.equal(miso.planComment({ evaluation: { state: 'pending', reasons: [] }, existingBody: ready, sha: SHA }), null);
});

test('run posts one comment and later edits it in place', async () => {
    const fresh = fakeGitHub({ pull: pr(), checkRuns: [check('lint')] });
    assert.deepEqual(await miso.run({ ...fresh, context, core, sleep, random: () => 0 }), { 7: 'ready' });
    assert.equal(fresh.calls.created.length, 1);
    assert.equal(fresh.calls.created[0].issue_number, 7);
    assert.match(fresh.calls.created[0].body, /ready to merge/);

    const existing = { id: 99, user: { login: 'github-actions[bot]' }, body: fresh.calls.created[0].body };
    const flipped = fakeGitHub({ pull: pr(), checkRuns: [check('lint', 'failure')], comments: [{ id: 5, user: { login: 'someone' }, body: miso.MARKER }, existing] });
    assert.deepEqual(await miso.run({ ...flipped, context, core, sleep, random: () => 0 }), { 7: 'blocked' });
    assert.equal(flipped.calls.created.length, 0);
    assert.equal(flipped.calls.updated.length, 1);
    assert.equal(flipped.calls.updated[0].comment_id, 99);
    assert.match(flipped.calls.updated[0].body, /merge blocked/);
});

test('run leaves drafts, running checks and unchanged comments alone', async () => {
    const draft = fakeGitHub({ pull: pr({ draft: true }), checkRuns: [check('lint')] });
    assert.deepEqual(await miso.run({ ...draft, context, core, sleep }), { 7: 'skip' });

    const running = fakeGitHub({ pull: pr(), checkRuns: [check('lint', null, { status: 'in_progress' })] });
    assert.deepEqual(await miso.run({ ...running, context, core, sleep }), { 7: 'pending' });

    const body = miso.planComment({ evaluation: { state: 'ready', reasons: [] }, sha: SHA, random: () => 0 });
    const same = fakeGitHub({ pull: pr(), checkRuns: [check('lint')], comments: [{ id: 99, user: { login: 'github-actions[bot]' }, body }] });
    await miso.run({ ...same, context, core, sleep });
    for (const fake of [draft, running, same]) {
        assert.equal(fake.calls.created.length + fake.calls.updated.length, 0);
    }
});

function fakeClock() {
    const clock = { time: 0, naps: [] };
    clock.now = () => clock.time;
    clock.sleep = async ms => { clock.naps.push(ms); clock.time += ms; };
    return clock;
}

test('Miso waits for running checks before judging', async () => {
    const clock = fakeClock();
    const fake = fakeGitHub({
        pull: pr(),
        checkRunsQueue: [
            [check('lint'), check('tests', null, { status: 'in_progress' })],
            [check('lint'), check('tests')],
        ],
    });
    await miso.waitForFinishedChecks({ ...fake, owner: 'platberlitz', repo: 'Neconyan', sha: SHA, sleep: clock.sleep, core, now: clock.now });
    assert.equal(fake.calls.checks, 2);
    assert.deepEqual(clock.naps, [15000]);
});

test('an empty check list only settles after a quiet minute', async () => {
    const clock = fakeClock();
    const fake = fakeGitHub({ pull: pr(), checkRunsQueue: [[]] });
    await miso.waitForFinishedChecks({ ...fake, owner: 'platberlitz', repo: 'Neconyan', sha: SHA, sleep: clock.sleep, core, now: clock.now });
    assert.equal(fake.calls.checks, 5);
    assert.equal(clock.time, 60000);
});

test('the shared deadline stops the wait and warns', async () => {
    const clock = fakeClock();
    const warnings = [];
    const fake = fakeGitHub({ pull: pr(), checkRunsQueue: [[check('tests', null, { status: 'in_progress' })]] });
    const deadline = clock.now() + 60000;
    await miso.waitForFinishedChecks({
        ...fake,
        owner: 'platberlitz',
        repo: 'Neconyan',
        sha: SHA,
        sleep: clock.sleep,
        core: { warning: message => warnings.push(message) },
        now: clock.now,
        deadline,
    });
    assert.equal(clock.time, 60000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /still running after 15 minutes/);
});

test('settleChecks waits, then re-reads the pull request before posting', async () => {
    const clock = fakeClock();
    const fake = fakeGitHub({
        pull: pr(),
        checkRunsQueue: [
            [check('tests', null, { status: 'in_progress' })],
            [check('tests')],
        ],
    });
    assert.deepEqual(await miso.run({ ...fake, context, core, settleChecks: true, sleep: clock.sleep, now: clock.now, random: () => 0 }), { 7: 'ready' });
    assert.equal(fake.calls.created.length, 1);
    assert.ok(fake.calls.gets >= 2, 'the pull request is read again after the wait');
});

test('settleChecks stops when the pull request closes while waiting', async () => {
    const clock = fakeClock();
    let reads = 0;
    const pull = pr();
    const fake = fakeGitHub({
        pull,
        onGet: () => { if (++reads > 1) pull.state = 'closed'; },
        checkRunsQueue: [
            [check('tests', null, { status: 'in_progress' })],
            [check('tests')],
        ],
    });
    assert.deepEqual(await miso.run({ ...fake, context, core, settleChecks: true, sleep: clock.sleep, now: clock.now }), { 7: 'skip' });
    assert.equal(fake.calls.created.length, 0);
    assert.equal(fake.calls.updated.length, 0);
});

test('the workflow job name matches the check Miso ignores', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/pr-miso.yml', import.meta.url), 'utf8');
    assert.match(workflow, /name: 🐯 Miso merge check\n/);
    assert.match(workflow, /sparse-checkout: \.github\/miso/);
    assert.match(workflow, /pull_request_target:/);
    assert.match(workflow, /push:\n\s{4}branches: \[staging\]/);
    assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.ref \}\}/);
    assert.match(workflow, /timeout-minutes: 20/);
    assert.match(workflow, /MISO_SETTLE_CHECKS:/);
    assert.match(workflow, /settleChecks: process\.env\.MISO_SETTLE_CHECKS === 'true'/);
    assert.match(workflow, /workflow_run:/);
});
