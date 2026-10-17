/* eslint playwright/expect-expect: off -- Real native transactions with disposable account files. */
// What the image review lists for the dialog: which description sources have text (D20), and the status and stage lists
// that the dialog keeps one label for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'acorn';
import { fixture, png } from './roleplay-transactions-fixture.js';
const recovery = await import('../src/roleplay-image-recovery.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const { roleplayHash } = await import('../src/roleplay-store.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIB = 1024;
const embedded = `data:image/png;base64,${png.toString('base64')}`;
const accountOf = f => ({ accountId: f.scope.accountId, dataEpoch: f.scope.dataEpoch });

// A chat whose messages carry the given extras, one message each.
function chatWith(t, extras) {
    const f = fixture(t);
    f.scope.directories.userImages = path.join(f.scope.directories.root, 'user/images');
    fs.mkdirSync(f.scope.directories.userImages, { recursive: true });
    f.records.splice(1, f.records.length - 1, ...extras.map((extra, index) => ({ name: 'User', is_user: true, mes: `Message ${index}`, extra })));
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    return f;
}
const scanOf = f => recovery.scanRoleplayImages(f.scope, { locator: f.locator });
const media = title => ({ type: 'image', url: embedded, ...(title === undefined ? {} : { title }) });

// [name, the message's extra, media-title, message-title, descriptionAvailable]
const SOURCE_CASES = [
    ['both sources have text', { media: [media('Image text')], title: 'Message text' }, true, true, true],
    ['neither source has a description', { media: [media()] }, false, false, false],
    ['empty descriptions', { media: [media('')], title: '' }, false, false, false],
    ['blank descriptions', { media: [media('  \n\t')], title: '   ' }, false, false, true],
    ['only the image has text', { media: [media('Image text')] }, true, false, true],
    ['only the message has text', { media: [media()], title: 'Message text' }, false, true, true],
    ['exactly 16 KiB', { media: [media('a'.repeat(16 * KIB))], title: 'b'.repeat(16 * KIB) }, true, true, true],
    ['one byte over 16 KiB', { media: [media('a'.repeat(16 * KIB + 1))], title: 'b'.repeat(16 * KIB + 1) }, false, false, true],
    ['16 KiB counts bytes, not characters', { media: [media('€'.repeat(5462))], title: '€'.repeat(5461) }, false, true, true],
    ['text that is not a string', { media: [{ type: 'image', url: embedded, title: 42 }], title: { text: 'x' } }, false, false, true],
    ['a single legacy image keeps its title on the message', { image: embedded, title: 'Legacy text' }, true, true, true],
    ['a single legacy image without a title', { image: embedded }, false, false, false],
];

for (const [name, extra, mediaTitle, messageTitle, available] of SOURCE_CASES) {
    test(`sources: ${name}`, t => {
        const issue = scanOf(chatWith(t, [extra])).issues[0];
        assert.deepEqual(issue.sources, { 'media-title': mediaTitle, 'message-title': messageTitle });
        assert.equal(issue.descriptionAvailable, available, 'descriptionAvailable keeps its old meaning');
    });
    test(`sources agree with choosing them: ${name}`, t => {
        for (const [source, usable] of [['media-title', mediaTitle], ['message-title', messageTitle]]) {
            const f = chatWith(t, [structuredClone(extra)]), scan = scanOf(f);
            const choose = () => recovery.applyRoleplayImageRepair(f.scope, { account: accountOf(f), key: `describe-${source}`, observation: scan.observation,
                actions: [{ ...scan.issues[0], mode: 'caption', caption: { source } }] }, roleplayNativeHost);
            if (usable) assert.equal(choose().replayed, false, source);
            else assert.throws(choose, { message: 'A description must contain text and be at most 16 KiB.' }, source);
        }
    });
}

test('sources: every listed image has both flags, whatever its status', t => {
    const f = chatWith(t, [{ media: [] }, { media: [null] }, { media: [{ type: 'video', url: '/user/videos/a.mp4' }] }, { media: [media('Text')] },
        { media: { not: 'a list' } }, { image: 5 }]);
    const { issues } = scanOf(f);
    assert.equal(issues.length, 6);
    for (const issue of issues) {
        assert.deepEqual(Object.keys(issue.sources), ['media-title', 'message-title']);
        for (const value of Object.values(issue.sources)) assert.equal(typeof value, 'boolean');
    }
});

// An alternative reply and a gallery keep their own titles.
test('sources: an alternative reply is judged on its own extra', t => {
    const f = chatWith(t, [{ media: [media('Active text')], title: 'Active title' }]);
    f.records[1].swipe_id = 0;
    f.records[1].swipes = ['Answer', 'Other'];
    f.records[1].swipe_info = [{ extra: structuredClone(f.records[1].extra) }, { extra: { media: [media('')], title: '' } }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const { issues } = scanOf(f);
    assert.deepEqual(issues.map(issue => [issue.swipe, issue.sources]), [
        [null, { 'media-title': true, 'message-title': true }],
        [1, { 'media-title': false, 'message-title': false }],
    ]);
});

// The statuses the scan gives. Each scene produces one, so the list is read off what the scan really does.
const WIDE = Buffer.from(png);
WIDE.writeUInt32BE(3000, 16);
const STATUS_SCENES = [
    ['saved-reference', { media: [{ type: 'image', url: '/user/images/ok.png' }] }],
    ['missing-file', { media: [{ type: 'image', url: '/user/images/gone.png' }] }],
    ['needs-compatible-copy', { media: [{ type: 'image', url: '/user/images/wide.png' }] }],
    ['unreadable-or-over-limit', { media: [{ type: 'image', url: '/user/images/huge.png' }] }],
    ['embedded-image', { media: [{ type: 'image', url: embedded }] }],
    ['external-or-old-location', { media: [{ type: 'image', url: 'https://example.com/a.png' }] }],
    ['other-media', { media: [{ type: 'video', url: '/user/videos/a.mp4' }] }],
    ['malformed-attachment', { media: [null] }],
    ['empty-attachment-list', { media: [] }],
    ['invalid-gallery-selection', { media: [{ type: 'image', url: embedded }], media_display: 'gallery', media_index: 5 }],
];

test('IMAGE_REVIEW_STATUSES is exactly what a scan can give', t => {
    const f = chatWith(t, STATUS_SCENES.map(([, extra]) => extra));
    const images = f.scope.directories.userImages;
    fs.writeFileSync(path.join(images, 'ok.png'), png);
    fs.writeFileSync(path.join(images, 'wide.png'), WIDE);
    fs.writeFileSync(path.join(images, 'huge.png'), Buffer.alloc(1024 * 1024 + 1));
    const observed = scanOf(f).issues.map(issue => issue.status);
    assert.deepEqual(observed, STATUS_SCENES.map(([status]) => status));
    assert.equal(recovery.IMAGE_REVIEW_STATUSES.length, 10);
    assert.deepEqual([...recovery.IMAGE_REVIEW_STATUSES].sort(), [...new Set(observed)].sort());
    assert.ok(Object.isFrozen(recovery.IMAGE_REVIEW_STATUSES));
});

// The same lists, read from the source: every literal that the code assigns to a status or a stage.
const ast = parse(fs.readFileSync(path.join(root, 'src/roleplay-image-recovery.js'), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
function everyNode(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(item => everyNode(item, visit)) : everyNode(value, visit);
}
// The literals a value expression can give: a literal, either branch of a conditional, either side of ??.
const given = node => node?.type === 'Literal' ? [node.value]
    : node?.type === 'ConditionalExpression' ? [...given(node.consequent), ...given(node.alternate)]
        : node?.type === 'LogicalExpression' ? [...given(node.left), ...given(node.right)] : [];
const named = (node, name) => node?.name === name || node?.property?.name === name || node?.key?.name === name;

test('IMAGE_REVIEW_STATUSES matches every status the code assigns', () => {
    const assigned = new Set();
    everyNode(ast, node => {
        if (node.type === 'VariableDeclarator' && named(node.id, 'status')) given(node.init).forEach(value => assigned.add(value));
        if (node.type === 'AssignmentExpression' && named(node.left, 'status')) given(node.right).forEach(value => assigned.add(value));
    });
    assert.deepEqual([...assigned].sort(), [...recovery.IMAGE_REVIEW_STATUSES].sort());
});

test('REPAIR_HISTORY_STAGES matches every stage the code assigns', () => {
    const assigned = new Set();
    everyNode(ast, node => {
        if (node.type === 'Property' && named(node, 'stage')) given(node.value).forEach(value => assigned.add(value));
        if (node.type === 'AssignmentExpression' && named(node.left, 'stage')) given(node.right).forEach(value => assigned.add(value));
    });
    assert.deepEqual([...assigned].sort(), [...recovery.REPAIR_HISTORY_STAGES].sort());
    assert.ok(Object.isFrozen(recovery.REPAIR_HISTORY_STAGES));
});

// One change taken to each stage, then read back through change history.
function change(t) {
    const f = fixture(t);
    f.records[1].extra.media = [{ type: 'image', url: 'data:image/png;base64,old-broken-image' }];
    fs.writeFileSync(f.filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const scan = scanOf(f), account = accountOf(f);
    const input = { account, key: 'change', observation: scan.observation, actions: [{ ...scan.issues[0], mode: 'display-only' }] };
    const id = roleplayHash([f.scope.accountId, f.scope.dataEpoch, 'image-repair', input.key]);
    const crashAt = phase => assert.throws(() => recovery.applyRoleplayImageRepair(f.scope, input, roleplayNativeHost, {
        checkpoint(value) { if (value === phase) throw new Error('simulated crash'); },
    }), /simulated crash/);
    const history = () => recovery.roleplayImageRepairHistory(f.scope, { account }).operations.find(operation => operation.id === id);
    return { f, account, input, id, crashAt, history, finish: () => recovery.applyRoleplayImageRepair(f.scope, input, roleplayNativeHost) };
}
const STAGE_SCENES = {
    'staging-incomplete': c => { c.crashAt('reserved'); },
    'backup-verified': c => { c.crashAt('backup-verified'); },
    'native-write-pending': c => { c.crashAt('native-committed'); },
    committed: c => { c.finish(); },
    discarded: c => { c.crashAt('reserved'); recovery.discardRoleplayImageRepair(c.f.scope, { account: c.account, id: c.id }); },
};

test('REPAIR_HISTORY_STAGES is exactly what change history can report', t => {
    const observed = {};
    for (const [stage, scene] of Object.entries(STAGE_SCENES)) {
        const c = change(t);
        scene(c);
        observed[stage] = c.history();
        assert.equal(observed[stage].stage, stage);
    }
    assert.deepEqual(Object.keys(observed).sort(), [...recovery.REPAIR_HISTORY_STAGES].sort());
    assert.deepEqual(Object.entries(observed).filter(([, operation]) => operation.backupAvailable).map(([stage]) => stage), ['committed']);
});

test('a completed change whose backup was deleted keeps its stage and loses backupAvailable', t => {
    const c = change(t);
    c.finish();
    assert.equal(c.history().backupAvailable, true);
    recovery.removeRoleplayImageBackup(c.f.scope, { account: c.account, id: c.id });
    assert.deepEqual([c.history().stage, c.history().backupAvailable], ['committed', false]);
});
