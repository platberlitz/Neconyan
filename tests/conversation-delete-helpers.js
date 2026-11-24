// Shared set-up and checks for the Conversation DM delete tests. Not a test file: it imports only modules that exist at release 1.5.7,
// so the preconditions can run on the base. The schedule-only predicate here is the test's own copy of the rule in the plan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, png } from './roleplay-transactions-fixture.js';

const { prepareConversationTarget, appendConversationJobMessage } = await import('../src/generation/conversation-effects.js');
const { readConversationStoreForWrite, saveConversationStore, readUserSettingsWithStatus } = await import('../src/endpoints/conversation-store.js');
const { normalizeConversationGroupRecord } = await import('../src/endpoints/conversation-groups.js');
const { normalizeConversationSettings } = await import('../src/endpoints/conversation-generation.js');
const { createConversationBranch } = await import('../src/endpoints/conversation-threads.js');
const { seedConversationReadBoundary } = await import('../src/endpoints/conversation-utils.js');
const { getSettingsVersion } = await import('../src/settings-version.js');
const { acceptJob } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
const { resolveAutomationActivity } = await import('../src/generation/conversation-auto-policy.js');
const { scanConversationAutonomy } = await import('../src/generation/conversation-worker.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { collectSoloConversationMemorySummary } = await import('../public/scripts/neconyan-conversation/memory-utils.js');

export const A = 'Nova.png';
export const B = 'Kit.png';
export const C = 'Zed.png';
export const MEMORY_FIELDS = ['memorySummary', 'memoryMessageCount', 'memoryUpdatedAt', 'memorySummaryThrough'];
export const SCHEDULE = { generatedAt: 5, days: Array.from({ length: 7 }, () => [{ time: '00:00-23:59', status: 'busy', activity: 'baking bread' }]) };
const DUE = { enabled: true, cooldown: 0, auto_message: true, ai_schedule: '1 - first' };
const normalizeGroup = group => normalizeConversationGroupRecord(group, normalizeConversationSettings);

export const KEY = avatar => `conv-auto||${avatar}|||main|schedule|relative:0:1 - first`;

/** The one rule for a kept record: a schedule, no settings, no memory, no messages. */
export function isScheduleOnly(record) {
    return Boolean(record?.schedule && typeof record.schedule === 'object')
        && (!record.settings || !Object.keys(record.settings).length)
        && !record.memorySummary
        && Object.values(record.branches || {}).every(branch => !branch.memorySummary && !(branch.messages || []).length);
}

/** A fresh fixture on every call, so a control scan, an after-scan and an open job never share one. */
export function seedA0(t) {
    const f = fixture(t);
    t.after(() => cancelAutoSaves());
    const { directories, owner } = f.scope;
    for (const [file, name] of [[B, 'Kit'], [C, 'Zed']]) {
        fs.writeFileSync(path.join(directories.characters, file), writeCard(png, JSON.stringify({ name, description: name })));
    }
    const request = { user: { directories, profile: { handle: owner } } };
    const file = path.join(directories.root, 'settings.json');
    const messages = [{ id: 'm1', role: 'user', name: 'User', mes: 'Hi', extra: {} }];
    const store = {
        version: 1, settings: { connection_profile: 'saved' }, automation: { mode: 'server', timeZone: 'UTC' },
        groups: [{ id: 'g1', personaId: '', members: [A, B], createdAt: 5, updatedAt: 5 }], reminders: [],
        characters: {
            [A]: { activeBranchId: 'main', settings: { ...DUE }, schedule: SCHEDULE,
                memorySummary: 'Thread memory.', memoryMessageCount: 1, memoryUpdatedAt: 7, memorySummaryThrough: 'm1',
                branches: { main: { id: 'main', createdAt: 1, lastActivity: 0, messages, memorySummary: 'Branch memory.', memoryMessageCount: 1, memoryUpdatedAt: 7 } } },
            [B]: { activeBranchId: 'main', settings: { enabled: true }, branches: { main: { id: 'main', createdAt: 1, messages: [] } } },
            [C]: { activeBranchId: 'main', settings: { ...DUE }, branches: { main: { id: 'main', createdAt: 1, lastActivity: 0, messages } } },
        },
    };
    fs.writeFileSync(file, JSON.stringify({
        _version: 0,
        extension_settings: { connectionManager: { profiles: [{ id: 'saved', api: 'openai', model: 'gpt-4o' }] }, neconyan_conversation: store },
        oai_settings: { chat_completion_source: 'openai' },
    }));
    const disk = () => JSON.parse(fs.readFileSync(file, 'utf8')).extension_settings.neconyan_conversation;
    return { directories, owner, request, disk };
}

/** The server route's exact write for the kept record (the A4 write), used as the producer on the base. */
export async function writeKeptRecord(request) {
    const version = getSettingsVersion(readUserSettingsWithStatus(request).data);
    const context = readConversationStoreForWrite(request, version, normalizeGroup);
    assert.equal(context.ok, true);
    const branch = createConversationBranch('Main', 'main');
    seedConversationReadBoundary(branch);
    context.store.characters[A] = { settings: {}, schedule: context.store.characters[A].schedule, activeBranchId: 'main', branches: { main: branch } };
    const saved = await saveConversationStore(request, context.store, version, { trustedConversationEffects: true, settingsSnapshot: context.snapshot });
    assert.equal(saved.ok, true, JSON.stringify(saved.body ?? null));
}

const scan = async seed => (await scanConversationAutonomy({ owners: [seed.owner], directoriesFor: () => seed.directories, now: Date.now() })).accepted;

/** Accept a conversation.reply job for A's current branch on a seed; returns what a late append needs. */
export async function openReplyJob(seed, avatar = A) {
    const captured = await prepareConversationTarget(seed.request, { avatar, branchId: 'main' });
    const { job } = acceptJob(seed.directories, {
        owner: seed.owner, type: 'conversation.reply', submissionKey: `delete:${avatar}`, intent: { target: captured },
        target: { kind: 'conversation', id: avatar, branchId: 'main', createdAt: captured.createdAt },
    });
    // The branch's createdAt must differ from any replacement made right after.
    await new Promise(resolve => setTimeout(resolve, 5));
    const append = async () => {
        try {
            await appendConversationJobMessage({ owner: seed.owner, directories: seed.directories, job }, captured, 'reply', { role: 'character', name: 'Nova', mes: 'Late reply' });
            return null;
        } catch (error) {
            return error;
        }
    };
    return { captured, job, append };
}

/** Items 0, 3, 4 and 5 of A0. `produce(request)` makes A's solo record the kept one. */
export async function checkKeptScheduleRecord(t, produce) {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')));
    // Item 4 control, on its own fixture.
    const control = seedA0(t);
    assert.deepEqual(await scan(control), [KEY(A)], `the control scan must accept exactly A: ${errors.join(' | ')}`);
    // Item 5 before, on the control fixture.
    const at = Date.UTC(2026, 10, 16, 12, 0);
    const expectedActivity = { status: 'busy', activity: 'baking bread', source: 'schedule' };
    assert.deepEqual(resolveAutomationActivity(control.disk().characters, A, '', {}, at, 'UTC'), expectedActivity);
    // Item 4 after, on another fixture: the scan passes over A and accepts C.
    const after = seedA0(t);
    await produce(after.request);
    assert.deepEqual(await scan(after), [KEY(C)], 'after the delete the scan must pass over A and accept the other due pal');
    assert.deepEqual(errors, []);
    // Item 0, on the after fixture.
    const read = () => after.disk();
    const holds = () => {
        const store = read();
        const record = store.characters[A];
        assert.equal(isScheduleOnly(record), true);
        assert.deepEqual(MEMORY_FIELDS.filter(field => Object.hasOwn(record, field)), []);
        assert.ok(!record.branches.main.memorySummary);
        assert.equal(collectSoloConversationMemorySummary(store.characters, A), null);
        assert.deepEqual(record.schedule, SCHEDULE);
        assert.equal(store.automation.mode, 'server');
        assert.equal(store.automation.timeZone, 'UTC');
    };
    holds();
    // An ordinary save that edits B's settings leaves the kept record alone.
    const version = getSettingsVersion(readUserSettingsWithStatus(after.request).data);
    const context = readConversationStoreForWrite(after.request, version, normalizeGroup);
    assert.equal(context.ok, true);
    context.store.characters[B].settings = { ...context.store.characters[B].settings, cooldown: 3 };
    const ordinary = await saveConversationStore(after.request, context.store, version);
    assert.equal(ordinary.ok, true, JSON.stringify(ordinary.body ?? null));
    assert.equal(read().characters[B].settings.cooldown, 3);
    holds();
    // Item 5 after.
    assert.deepEqual(resolveAutomationActivity(read().characters, A, '', {}, at, 'UTC'), expectedActivity);
    // Item 3, on its own fixture: a reply job accepted for the old branch is refused after the delete.
    const open = seedA0(t);
    const job = await openReplyJob(open);
    await produce(open.request);
    const refusal = await job.append();
    assert.ok(refusal, 'the late append must be refused');
    assert.ok(refusal.status === 409 || /cancel/i.test(refusal.message), `unexpected refusal: ${refusal.message}`);
    assert.equal(errors.length, 0, errors.join(' | '));
    return { control: [KEY(A)], after: [KEY(C)], item3: { status: refusal.status ?? null, message: refusal.message } };
}
