import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const {
    getConversationAutomationClock, selectConversationReminder, selectConversationScheduledMessage,
    selectConversationIdleMessage, selectConversationProactiveMessage, selectConversationChime,
    selectConversationCharacterChat, selectNextConversationThreadAutomation, getConversationOccurrenceKey,
} = await import('../src/generation/conversation-auto-policy.js');
const { applyConversationBookkeeping } = await import('../src/generation/conversation-effects.js');
const { scanConversationAutonomy } = await import('../src/generation/conversation-worker.js');

const target = { avatar: 'a.png', groupId: '', personaId: 'p.png', branchId: 'main' };
const branch = overrides => ({ messages: [], lastActivity: 0, followupCount: 0, ...overrides });
const partner = (avatar, name, extra = {}) => ({ avatar, name, status: 'online', ...extra });

test('reminders fire once, defer while retrying, and can be skipped or invalidated', () => {
    const now = 10_000_000;
    const reminder = { id: 'r1', personaId: 'p.png', avatar: 'a.png', groupId: '', branchId: 'main', triggerAt: now - 1, text: 'tea', fired: false };
    const targets = new Map([[reminder, { target, settings: { enabled: true } }]]);

    const due = selectConversationReminder({ reminders: [reminder], targets, personaId: 'p.png', now });
    assert.equal(due.kind, 'reminder');
    assert.equal(due.participants[0].avatar, 'a.png');
    assert.deepEqual(due.target, target);
    assert.equal(due.bookkeeping.reminder.id, 'r1');
    assert.equal(due.bookkeeping.reminder.firedAt, now);

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
    assert.deepEqual(getConversationAutomationClock(monday, 'UTC'), { dayOfWeek: 1, hour: 9, minuteKey: '09:00' });
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

    // A repeated local day key only fires once.
    const triggered = selectConversationScheduledMessage({ settings: weekly, branch: branch({ lastActivity: monday, scheduleTriggers: { 'weekly:1:09:00:standup': 1 } }), target, now: monday, timeZone: 'UTC' });
    assert.equal(triggered, null);
});

test('idle follow-ups and spontaneous pings respect their session markers', () => {
    const now = 100 * 60000;
    const idle = { idle_followup: true, idle_spontaneous: true, idle_limit: 15 };
    const followup = selectConversationIdleMessage({ settings: idle, branch: branch({ lastActivity: 0 }), target, now });
    assert.equal(followup.kind, 'idle-followup');
    assert.equal(followup.bookkeeping.sessionMarkers.sb_conv_last_idle_session_followup, '0');
    assert.equal(selectConversationIdleMessage({ settings: idle, branch: branch({ lastActivity: 0, sessionMarkers: { sb_conv_last_idle_session_followup: '0' } }), target, now: now + 16 * 60000 }).kind, 'idle-spontaneous');

    const spontaneous = selectConversationIdleMessage({
        settings: { idle_followup: true, idle_spontaneous: true, idle_limit: 15 },
        branch: branch({ lastActivity: 0, sessionMarkers: { sb_conv_last_idle_session_followup: '0' } }), target, now,
    });
    assert.equal(spontaneous.kind, 'idle-spontaneous');
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

test('an occurrence key is deterministic and excludes scan time', () => {
    const first = getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 123 });
    const second = getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 123 });
    assert.equal(first, second);
    assert.notEqual(first, getConversationOccurrenceKey({ owner: 'u', target, kind: 'idle-followup', basis: 124 }));
});

test('bookkeeping is applied once per occurrence and consumes its reminder', () => {
    const storeBranch = {};
    const store = { reminders: [{ id: 'r1', fired: false }] };
    const patch = { reminder: { id: 'r1' }, sessionMarkers: { marker: '1' }, followupCount: 2 };
    assert.equal(applyConversationBookkeeping(storeBranch, store, patch, 'occ-1', 100), true);
    assert.equal(store.reminders[0].fired, true);
    assert.equal(storeBranch.followupCount, 2);
    assert.equal(storeBranch.sessionMarkers.marker, '1');
    assert.equal(applyConversationBookkeeping(storeBranch, store, patch, 'occ-1', 200), false);
    assert.equal(storeBranch.followupCount, 2);
});

test('the autonomy scan invalidates a reminder whose branch is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-auto-policy-'));
    fs.mkdirSync(path.join(root, 'characters'), { recursive: true });
    const now = Date.now();
    const store = {
        version: 1,
        settings: {},
        characters: {},
        groups: [],
        reminders: [{ id: 'rem1', personaId: 'p.png', avatar: 'a.png', groupId: '', branchId: 'missing', triggerAt: now - 1, text: 'tea', fired: false }],
        automation: { mode: 'server', timeZone: 'UTC' },
    };
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        _version: 0, user_avatar: 'p.png',
        extension_settings: { sillybunny_conversation: store },
    }));
    // An empty handle keeps the settings autosave (a 10-minute throttle timer)
    // out of the test process.
    const result = await scanConversationAutonomy({ directoriesFor: () => ({ root }), owners: [''], now });
    assert.deepEqual(result.invalidated, ['rem1']);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
    assert.ok(saved.extension_settings.sillybunny_conversation.reminders[0].invalidAt);
    fs.rmSync(root, { recursive: true, force: true });
});
