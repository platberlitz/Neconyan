import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const labels = require('../.github/miso/labels.json');
const rules = require('../.github/miso/label-automation.cjs');
const { planLabelSync } = require('../scripts/sync-github-labels.cjs');
const canonical = new Set(Object.values(labels).map(rule => rule.name));
const fixture = id => ({ name: labels[id].legacy?.[0] ?? labels[id].name, color: 'ededed', description: '' });
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('catalogue names and aliases are unique and metadata fits GitHub', () => {
    const seen = new Set();
    for (const [id, label] of Object.entries(labels)) {
        assert.match(id, /^[a-z-]+$/);
        assert.match(label.name, /^.{2,}\(.+\)$/);
        assert.ok([...label.name].length <= 50, id);
        assert.match(label.colour, /^[0-9a-f]{6}$/);
        assert.ok(label.description.length > 0 && label.description.length <= 100, id);
        if (label.hold) assert.ok(label.legacy.length, id);
        for (const name of [label.name, ...(label.legacy ?? [])]) {
            assert.ok(!seen.has(name.toLowerCase()), name);
            seen.add(name.toLowerCase());
        }
    }
});

test('live migration edits existing labels without changing IDs, and waits for default-dependent names', () => {
    const unrelated = { name: 'do not touch', color: '000000', description: '' };
    const initial = [fixture('docs'), fixture('fix'), fixture('size-m'), unrelated];
    const planned = planLabelSync(initial, false);
    assert.ok(planned.some(row => row.old === 'documentation' && row.name === labels.docs.name));
    assert.ok(planned.some(row => row.old === '🦋 Bug Fix' && row.name === '🦋 Bug Fix'));
    assert.ok(planned.some(row => !row.old && row.name === labels['needs-testing'].legacy[0]));
    for (const id of ['bug', 'feature-request']) {
        assert.ok(planned.some(row => !row.old && row.name === labels[id].legacy[0]));
        assert.ok(!planned.some(row => row.name === labels[id].name));
    }
    assert.ok(!planned.some(row => row.old === unrelated.name || row.name === labels['size-m'].name));
    const synced = planned.map(({ old: _old, ...label }) => label);
    assert.deepEqual(planLabelSync(synced, false), []);
    const promoted = planLabelSync(synced, true);
    assert.ok(promoted.every(row => row.old && row.old !== row.name));
    assert.ok(promoted.some(row => row.old === '🦋 Bug Fix' && row.name === labels.fix.name));
    const final = synced.map(label => promoted.find(row => row.old === label.name) ?? label);
    assert.deepEqual(planLabelSync(final, true), []);
});

test('migration refuses duplicate names rather than discarding historical assignments', () => {
    assert.throws(() => planLabelSync([fixture('fix'), { name: labels.fix.name }], true), /Multiple GitHub labels match fix/);
    assert.throws(() => planLabelSync([{ name: labels['needs-work'].name }], false), /default branch is not ready/);
});

function plan(overrides = {}) {
    return rules.planPrLabels({ title: 'fix: correct something', files: [], current: new Set(), available: canonical, ...overrides });
}

test('PRs use a conventional title and file paths, including moved paths', () => {
    const current = new Set([labels.feature.name, labels['size-s'].legacy[0], labels['needs-testing'].name, 'A custom label']);
    const files = [
        { filename: 'public/scripts/creator/new.js', changes: 15 },
        { filename: 'public/scripts/mewmory/moved.js', previous_filename: 'ios/App/Old.swift', changes: 3 },
        { filename: 'public/lib/vendor.js', changes: 4000 },
        { filename: 'tests/package-lock.json', changes: 4000 },
        { filename: 'bun.lock', changes: 4000 },
    ];
    const result = plan({ title: 'fix(conversation/creator)!: keep the saved draft', current, files });
    assert.deepEqual(new Set(result.add), new Set(['fix', 'catelier', 'mewmory', 'iphone-app', 'size-xs'].map(id => labels[id].name)));
    assert.deepEqual(result.remove, [labels.feature.name, labels['size-s'].legacy[0]]);
});

test('sizes retain their boundary and old labels are usable before normal promotion', () => {
    for (const [changes, size] of [[20, 'xs'], [21, 's'], [100, 's'], [101, 'm'], [500, 'm'], [501, 'l'], [1000, 'l'], [1001, 'xl']]) {
        assert.ok(plan({ files: [{ filename: 'src/foo.js', changes }] }).add.includes(labels[`size-${size}`].name));
    }
    assert.deepEqual(plan({ available: new Set([labels.fix.legacy[0], labels['size-xs'].legacy[0]]) }).add, [labels.fix.legacy[0], labels['size-xs'].legacy[0]]);
    assert.deepEqual(plan({ available: new Set(), current: new Set([labels.feature.name]) }), { add: [], remove: [] });
    assert.ok(plan({ totalLines: 5000, files: Array.from({ length: 3000 }, () => ({ filename: 'file.js', changes: 0 })) }).add.includes(labels['size-xl'].name));
});

test('issue forms use canonical types, platform tags only read environment and system fields', () => {
    assert.deepEqual(yaml.load(read('.github/ISSUE_TEMPLATE/bug-report.yml')).labels, [labels.bug.name]);
    assert.deepEqual(yaml.load(read('.github/ISSUE_TEMPLATE/feature-request.yml')).labels, [labels['feature-request'].name]);
    const body = '### Environment\n\n🪟 Windows\n\n### System\n\nFirefox 155\n\n### Describe the problem\n\nMac and Android examples';
    assert.deepEqual(rules.issuePlatformLabels(body, canonical), [labels.windows.name, labels.firefox.name]);
    assert.deepEqual(rules.issuePlatformLabels('### Environment\n\n- 📱 Termux', canonical), [labels.termux.name, labels.mobile.name]);
    assert.deepEqual(rules.issuePlatformLabels('Firefox and Windows', canonical), []);
});

test('label comments render with names from the catalogue, preserving their actions', () => {
    for (const file of ['pr-auto-comments', 'issues-auto-comments']) {
        const template = read(`.github/${file}.yml`);
        const resolved = yaml.load(rules.renderCommentConfig(template, canonical)).labels;
        assert.ok(resolved.every(entry => canonical.has(entry.name)));
        assert.equal(resolved.length, yaml.load(template).labels.length);
    }
    const config = read('.github/issues-auto-comments.yml');
    const available = new Set([labels.spam.legacy[0], labels['done-staging'].legacy[0]]);
    const result = yaml.load(rules.renderCommentConfig(config, available)).labels;
    assert.equal(result.find(entry => entry.name === labels.spam.legacy[0]).labeled.issue.locking, 'lock');
    assert.match(result.find(entry => entry.name === labels['done-staging'].legacy[0]).labeled.issue.body, /If you're on `main`/);
});

test('staging and release mark only linked issues and preserve other labels', async () => {
    assert.deepEqual(rules.linkedIssueNumbers('Fixes #12, resolves #16. Discussed #11.\nCloses other/project#21'), [12, 16]);
    const repo = { owner: 'test', repo: 'repo' };
    const calls = [];
    const issues = {
        listLabelsForRepo() {},
        get: async ({ issue_number }) => ({ data: issue_number === 16 ? { pull_request: {} } : { labels: [{ name: labels['in-progress'].legacy[0] }, { name: 'custom' }] } }),
        addLabels: async args => calls.push(['add', args.issue_number, ...args.labels]),
        removeLabel: async args => calls.push(['remove', args.issue_number, args.name]),
    };
    const github = { rest: { issues }, paginate: async () => [{ name: labels['done-staging'].legacy[0] }, { name: labels.released.name }] };
    await rules.markIssuesDone({ github, repo, numbers: [12, 12, 16], released: false });
    await rules.markIssuesDone({ github, repo, numbers: [13], released: true });
    assert.deepEqual(calls, [
        ['add', 12, labels['done-staging'].legacy[0]], ['remove', 12, labels['in-progress'].legacy[0]],
        ['add', 13, labels.released.name], ['remove', 13, labels['in-progress'].legacy[0]],
    ]);
});
