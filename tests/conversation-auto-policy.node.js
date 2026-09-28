import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    getConversationAutomationClock, selectConversationReminder, selectConversationScheduledMessage,
    selectConversationIdleMessage, selectConversationProactiveMessage, selectConversationChime,
    selectConversationCharacterChat, selectNextConversationThreadAutomation, getConversationOccurrenceKey,
    isConversationOccurrenceEnabled, conversationReminderIdentityKey,
} = await import('../src/generation/conversation-auto-policy.js');
const { applyConversationBookkeeping, wasConversationAutomaticOccurrenceAccepted } = await import('../src/generation/conversation-effects.js');
const { migrateConversationAutomaticOwnership, scanConversationAutonomy } = await import('../src/generation/conversation-worker.js');
const { acceptJob, getJob, holdJobPruning, jobKey, readJobStore, updateJob } = await import('../src/jobs/store.js');
const { cancelAutoSaves } = await import('../src/endpoints/settings.js');
after(() => cancelAutoSaves());
const { getConversationThreadKey } = await import('../src/endpoints/conversation-store.js');

const target = { avatar: 'a.png', groupId: '', personaId: 'p.png', branchId: 'main' };
const branch = overrides => ({ messages: [], lastActivity: 0, followupCount: 0, ...overrides });
const partner = (avatar, name, extra = {}) => ({ avatar, name, status: 'online', ...extra });

test('upgrade ownership is copied before pruning, and damaged settings hold all pruning until repaired', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-upgrade-'));
    const directories = { root };
    const owner = 'upgrade-test';
    t.after(() => { holdJobPruning(owner, false); fs.rmSync(root, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(root, 'jobs'));
    const legacy = { id: 'legacy', owner, type: 'conversation.reply', submissionKey: 'old-reminder-key|0',
        intent: { mode: 'auto', automation: { kind: 'reminder', patch: { reminder: { id: 'legacy-reminder' } } } },
        state: 'failed', dismissed: true, createdAt: 1, updatedAt: 1 };
    const jobs = Object.fromEntries([legacy, ...Array.from({ length: 200 }, (_, i) => ({
        id: `filler-${i}`, owner, type: 'other.task', state: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
    }))].map(job => [jobKey(job.id), job]));
    fs.writeFileSync(path.join(root, 'jobs/index.json'), JSON.stringify({ schema: 1, revision: 7, jobs }));
    fs.writeFileSync(path.join(root, 'settings.json'), '{');
    const options = { owners: [owner], directoriesFor: () => directories };
    await migrateConversationAutomaticOwnership(options);
    assert.equal(readJobStore(directories).revision, 7);
    updateJob(directories, 'filler-0', { label: 'changed' });
    assert.equal(Object.keys(readJobStore(directories).jobs).length, 201);
    assert.throws(() => acceptJob(directories, { owner, type: 'other.task', submissionKey: 'new', intent: {} }), error => error.code === 'JOB_STORE_FULL');
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ _version: 1, extension_settings: { neconyan_conversation: { characters: {}, reminders: [], groups: [] } } }));
    const revision = readJobStore(directories).revision;
    await migrateConversationAutomaticOwnership(options);
    assert.equal(readJobStore(directories).revision, revision);
    updateJob(directories, 'filler-0', { label: 'migrated' });
    assert.equal(getJob(directories, legacy.id), null);
    const store = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).extension_settings.neconyan_conversation;
    assert.equal(wasConversationAutomaticOccurrenceAccepted(store, conversationReminderIdentityKey('legacy-reminder')), true);
    const boot = fs.readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
    assert.ok(boot.indexOf('.then(migrateConversationOwnership)') < boot.indexOf('.then(preSetupTasks)'));
    assert.ok(boot.indexOf('.then(migrateConversationOwnership)') < boot.indexOf('.then(() => new ServerStartup'));
});

test('fresh chime checks honour mentions, disabled unsolicited chimes and the frozen activity', () => {
    const input = { kind: 'chime', settings: { enabled: true, multi_char: false }, store: { automation: { mode: 'server' } },
        target, branch: branch({ lastActivity: 100, messages: [{ role: 'user', mes: 'Hello' }] }),
        partners: [partner('kit.png', 'Kit')], plan: [{ avatar: 'kit.png', purpose: 'chime' }],
        patch: { sessionMarkers: { sb_conv_last_chime_session_: '100' } }, now: 1000000 };
    assert.equal(isConversationOccurrenceEnabled(input), false);
    input.branch.messages[0].mes = 'Hey @Kit';
    assert.equal(isConversationOccurrenceEnabled(input), true);
    input.branch.messages[0].mes = 'Hello';
    input.settings.multi_char = true;
    assert.equal(isConversationOccurrenceEnabled(input), true);
    input.branch.lastActivity = 101;
    assert.equal(isConversationOccurrenceEnabled(input), false);
    input.branch.lastActivity = 100;
    input.branch.sessionMarkers = { sb_conv_last_chime_session_: '100' };
    assert.equal(isConversationOccurrenceEnabled(input), false);
});

test('reminders fire once, defer while retrying, and can be skipped or invalidated', () => {
    const now = 10_000_000;
    const reminder = { id: 'r1', personaId: 'p.png', avatar: 'a.png', groupId: '', branchId: 'main', triggerAt: now - 1, text: 'tea', fired: false };
    const targets = new Map([[reminder, { target, settings: { enabled: true } }]]);

    const due = selectConversationReminder({ reminders: [reminder], targets, personaId: 'p.png', now });
    assert.equal(due.kind, 'reminder');
    assert.equal(due.participants[0].avatar, 'a.png');
    assert.deepEqual(due.target, target);
    assert.equal(due.bookkeeping.reminder.id, 'r1');
    assert.equal(due.bookkeeping.markAutoMessage, true);

    assert.equal(selectConversationReminder({ reminders: [{ ...reminder, triggerAt: now + 1 }], targets, personaId: 'p.png', now }), null);
    assert.equal(selectConversationReminder({ reminders: [{ ...reminder, retryAfter: now + 1000 }], targets, personaId: 'p.png', now }), null);
    assert.equal(selectConversationReminder({ reminders: [reminder], targets, personaId: 'other', now }), null);
    assert.deepEqual(
        selectConversationReminder({ reminders: [reminder], targets: new Map([[reminder, { target, settings: { enabled: false } }]]), personaId: 'p.png', now }),
        { action: 'skip', reminderId: 'r1' },
    );
    assert.deepEqual(
        selectConversationReminder({ reminders: [reminder], targets: new Map(), personaId: 'p.png', now }),
        { action: 'invalidate', reminderId: 'r1', reason: 'missing_branch' },
    );
});

test('weekly and legacy schedules match the named-timezone clock', () => {
    const monday = Date.UTC(2026, 0, 5, 9, 0);
    assert.deepEqual(getConversationAutomationClock(monday, 'UTC'), { dayOfWeek: 1, hour: 9, minuteKey: '09:00', dateKey: '2026-01-05' });
    const weekly = { auto_message: true, ai_schedule: '', weekly_schedule: JSON.stringify([{ days: [1], time: '09:00', message: 'standup' }]) };
    const weeklyResult = selectConversationScheduledMessage({ settings: weekly, branch: branch({ lastActivity: monday }), target, now: monday, timeZone: 'UTC' });
    assert.equal(weeklyResult.kind, 'schedule');
    assert.equal(weeklyResult.bookkeeping.scheduleTriggers.length, 1);
    assert.equal(weeklyResult.participants[0].purpose, 'schedule');

    const absolute = { auto_message: true, ai_schedule: '09:00 - daily note', weekly_schedule: '[]' };
    assert.equal(selectConversationScheduledMessage({ settings: absolute, branch: branch({ lastActivity: monday }), target, now: monday, timeZone: 'UTC' }).kind, 'schedule');

    const relative = { auto_message: true, ai_schedule: '5 - quiet check-in', weekly_schedule: '[]' };
    const late = monday + 6 * 60000;
    assert.equal(selectConversationScheduledMessage({ settings: relative, branch: branch({ lastActivity: monday }), target, now: late, timeZone: 'UTC' }).kind, 'schedule');
    assert.equal(selectConversationScheduledMessage({ settings: relative, branch: branch({ lastActivity: monday }), target, now: monday + 60000, timeZone: 'UTC' }), null);

    // A repeated local day key only fires once, and the next week is not blocked.
    const triggered = selectConversationScheduledMessage({ settings: weekly, branch: branch({ lastActivity: monday, scheduleTriggers: { 'weekly:2026-01-05:09:00:standup': 1 } }), target, now: monday, timeZone: 'UTC' });
    assert.equal(triggered, null);
    const nextWeek = selectConversationScheduledMessage({ settings: weekly, branch: branch({ lastActivity: monday, scheduleTriggers: { 'weekly:2025-12-29:09:00:standup': 1 } }), target, now: monday, timeZone: 'UTC' });
    assert.equal(nextWeek.kind, 'schedule');
});

test('reminder acceptance retry keeps its identity and a submitted failure cannot starve the next reminder', () => {
    const first = { id: 'first', personaId: 'p.png', triggerAt: 100, text: 'tea', target: { target, settings: { enabled: true } } };
    const second = { ...first, id: 'second', text: 'water' };
    const due = selectConversationReminder({ reminders: [first], personaId: 'p.png', now: 200 });
    first.retryAfter = 300;
    assert.equal(selectConversationReminder({ reminders: [first], personaId: 'p.png', now: 250 }), null);
    assert.equal(selectConversationReminder({ reminders: [first], personaId: 'p.png', now: 400 }).key, due.key);
    const next = selectConversationReminder({ reminders: [first, second], submitted: new Set([due.key]), personaId: 'p.png', now: 400 });
    assert.equal(next.bookkeeping.reminder.id, 'second');
});

test('idle follow-ups and spontaneous pings respect their session markers', () => {
    const now = 100 * 60000;
    const idle = { idle_followup: true, idle_spontaneous: true, idle_limit: 15 };
    const followup = selectConversationIdleMessage({ settings: idle, branch: branch({ lastActivity: 0 }), target, now });
    assert.equal(followup.kind, 'idle-followup');
    assert.equal(followup.participants[0].purpose, 'idle-followup');
    assert.equal(followup.bookkeeping.sessionMarkers.sb_conv_last_idle_session_followup, '0');
    assert.equal(selectConversationIdleMessage({ settings: idle, branch: branch({ lastActivity: 0, sessionMarkers: { sb_conv_last_idle_session_followup: '0' } }), target, now: now + 16 * 60000 }).kind, 'idle-spontaneous');

    const spontaneous = selectConversationIdleMessage({
        settings: { idle_followup: true, idle_spontaneous: true, idle_limit: 15 },
        branch: branch({ lastActivity: 0, sessionMarkers: { sb_conv_last_idle_session_followup: '0' } }), target, now,
    });
    assert.equal(spontaneous.kind, 'idle-spontaneous');
    assert.equal(spontaneous.participants[0].purpose, 'idle-spontaneous');
});

test('proactive outreach handles catch-up, thresholds and user dnd', () => {
    const now = 200 * 60000;
    const settings = { proactive_messaging: true, inactivity_threshold: 120, max_followups: 3 };
    const catchUp = selectConversationProactiveMessage({ settings, branch: branch({ lastActivity: 0, messages: [{ role: 'user', mes: 'hi' }] }), target, activity: { status: 'online', activity: 'free time' }, now });
    assert.equal(catchUp.kind, 'proactive');
    assert.equal(catchUp.bookkeeping.followupCount, 1);

    const tooSoon = selectConversationProactiveMessage({ settings, branch: branch({ lastActivity: 0, messages: [] }), target, activity: { status: 'online', activity: 'free time' }, now: 60 * 60000 });
    assert.equal(tooSoon, null);
    assert.equal(selectConversationProactiveMessage({ settings, branch: branch({ lastActivity: 0, messages: [] }), target, activity: { status: 'online' }, userStatus: 'dnd', now }), null);
    assert.equal(selectConversationProactiveMessage({ settings, branch: branch({ lastActivity: 0, messages: [] }), target, activity: { status: 'offline' }, now }), null);
});

test('chimes and character chat start from saved partners', () => {
    const now = 50 * 60000;
    const partners = [partner('b.png', 'Bob'), partner('c.png', 'Carol')];
    const messages = [{ role: 'user', mes: 'Bob, thoughts?' }];
    const chime = selectConversationChime({ settings: { multi_char: false, idle_limit: 15 }, branch: branch({ messages, lastActivity: 0 }), target, partners, now, random: () => 0 });
    assert.equal(chime.kind, 'chime');
    assert.equal(chime.participants[0].avatar, 'b.png');
    assert.equal(chime.participants[0].extra.partner_avatar, 'b.png');
    assert.ok(chime.directive);

    const chat = selectConversationCharacterChat({ settings: { auto_character_chat: true, auto_chat_cooldown: 10 }, branch: branch({ messages, lastActivity: 0, updatedAt: 0 }), target, partners, now, random: () => 0 });
    assert.equal(chat.kind, 'chat');
    assert.equal(chat.participants[0].purpose, 'chat');
});

test('thread selection obeys the per-thread cooldown and reminder priority', () => {
    const now = 100 * 60000;
    const settings = { enabled: true, cooldown: 60, idle_followup: true, idle_limit: 15 };
    const cooled = selectNextConversationThreadAutomation({ settings, branch: branch({ lastActivity: 0, lastAutoMessageAt: now - 1000 }), target, now });
    assert.equal(cooled, null);
    const due = selectNextConversationThreadAutomation({ settings, branch: branch({ lastActivity: 0 }), target, now });
    assert.equal(due.kind, 'idle-followup');
    assert.equal(selectNextConversationThreadAutomation({ settings, branch: branch({ lastActivity: 0 }), target, userStatus: 'offline', now }), null);
});

test('an already accepted automatic candidate does not mask later schedules or idle work', () => {
    const options = { target, branch: branch({ lastActivity: 0 }), now: 100 * 60000,
        settings: { enabled: true, cooldown: 0, auto_message: true, ai_schedule: '1 - first\n2 - second', idle_followup: true, idle_spontaneous: true, idle_limit: 15 } };
    const takenKeys = new Set();
    const kinds = [];
    for (let i = 0; i < 4; i++) {
        const next = selectNextConversationThreadAutomation({ ...options, taken: key => takenKeys.has(key) });
        assert.ok(next);
        kinds.push(next.kind);
        takenKeys.add(next.key);
    }
    assert.deepEqual(kinds, ['schedule', 'schedule', 'idle-followup', 'idle-spontaneous']);
    assert.equal(selectNextConversationThreadAutomation({ ...options, taken: key => takenKeys.has(key) }), null);
});

test('an occurrence key is deterministic and excludes scan time', () => {
    const first = getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 123 });
    const second = getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 123 });
    assert.equal(first, second);
    assert.notEqual(first, getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 124 }));
});

test('bookkeeping is applied once per occurrence and consumes its reminder', () => {
    const storeBranch = {};
    const store = { reminders: [{ id: 'r1', fired: false }] };
    const patch = { reminder: { id: 'r1' }, sessionMarkers: { marker: '1' }, followupCount: 2, markAutoMessage: true };
    assert.equal(applyConversationBookkeeping(storeBranch, store, patch, 'occ-1', 100), true);
    assert.equal(store.reminders[0].fired, true);
    assert.equal(store.reminders[0].firedAt, 100);
    assert.equal(storeBranch.followupCount, 2);
    assert.equal(storeBranch.lastAutoMessageAt, 100);
    assert.equal(storeBranch.sessionMarkers.marker, '1');
    assert.equal(applyConversationBookkeeping(storeBranch, store, patch, 'occ-1', 200), false);
    assert.equal(storeBranch.followupCount, 2);
});

test('an oversized solo partner list does not stop the scan from invalidating an unrelated reminder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-auto-policy-'));
    fs.mkdirSync(path.join(root, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups'));
    const now = Date.now();
    const messages = Array.from({ length: 129 }, (_, index) => ({
        id: `history-${index}`, role: 'partner', mes: 'Earlier solo reply.', extra: { partner_avatar: `p${index}.png` },
    }));
    const store = {
        version: 1,
        settings: {},
        characters: { [getConversationThreadKey('a.png', '', 'p.png')]: {
            settings: { enabled: true, multi_char_names: 'p0.png' }, activeBranchId: 'main',
            branches: { main: { id: 'main', lastActivity: now, messages } },
        } },
        groups: [],
        reminders: [{ id: 'rem1', personaId: 'p.png', avatar: 'a.png', groupId: '', branchId: 'missing', triggerAt: now - 1, text: 'tea', fired: false }],
        automation: { mode: 'server', timeZone: 'UTC' },
    };
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        _version: 0, user_avatar: 'p.png',
        extension_settings: { neconyan_conversation: store },
    }));
    const result = await scanConversationAutonomy({ directoriesFor: () => ({ root, groups: path.join(root, 'groups'), characters: path.join(root, 'characters') }), owners: [''], now });
    assert.deepEqual(result.invalidated, ['rem1']);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    assert.ok(saved.extension_settings.neconyan_conversation.reminders[0].invalidAt);
    fs.rmSync(root, { recursive: true, force: true });
});

test('an unresolved legacy group does not stop the scan from invalidating an unrelated reminder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-auto-policy-'));
    fs.mkdirSync(path.join(root, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups'));
    fs.writeFileSync(path.join(root, 'groups', 'legacy.json'), JSON.stringify({ id: 'legacy', members: ['a.png', 'b.png'] }));
    const now = Date.now();
    const store = {
        version: 1,
        settings: {},
        characters: { [getConversationThreadKey('a.png', 'legacy', 'p.png')]: {
            settings: { enabled: true, multi_char_names: 'b.png' }, activeBranchId: 'main',
            branches: { main: { id: 'main', messages: [{ id: 'legacy-partner', role: 'partner', mes: 'Earlier group reply.', extra: { partner_avatar: 'b.png' } }] } },
        } },
        groups: [],
        reminders: [{ id: 'rem1', personaId: 'p.png', avatar: 'a.png', groupId: '', branchId: 'missing', triggerAt: now - 1, text: 'tea', fired: false }],
        automation: { mode: 'server', timeZone: 'UTC' },
    };
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        _version: 0, user_avatar: 'p.png',
        extension_settings: { neconyan_conversation: store },
    }));
    // An empty handle keeps the settings autosave (a 10-minute throttle timer)
    // out of the test process.
    const result = await scanConversationAutonomy({ directoriesFor: () => ({ root, groups: path.join(root, 'groups'), characters: path.join(root, 'characters') }), owners: [''], now });
    assert.deepEqual(result.invalidated, ['rem1']);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    assert.ok(saved.extension_settings.neconyan_conversation.reminders[0].invalidAt);
    fs.rmSync(root, { recursive: true, force: true });
});
