import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReminderDelayToMs } from '../public/scripts/neconyan-conversation/reminder-time.js';

test('reminder times preserve durations and resolve clock times in the captured timezone across DST', () => {
    const now = Date.parse('2026-09-19T12:00:00Z');
    assert.equal(parseReminderDelayToMs('21:30', now, 'Asia/Manila'), 90 * 60000);
    assert.equal(parseReminderDelayToMs('0:30', now, 'Asia/Manila'), 270 * 60000);
    assert.equal(parseReminderDelayToMs('21', now, 'Asia/Manila'), 21 * 60000);
    assert.equal(parseReminderDelayToMs('1.5h', now, 'UTC'), 90 * 60000);
    assert.equal(parseReminderDelayToMs('15 minutes', now, 'UTC'), 15 * 60000);
    assert.equal(parseReminderDelayToMs('1 minute', now, 'UTC'), 60000);
    assert.equal(parseReminderDelayToMs('30 seconds', now, 'UTC'), 30000);
    assert.equal(parseReminderDelayToMs('2 hrs', now, 'UTC'), 2 * 3600000);
    assert.equal(parseReminderDelayToMs('25:00', now, 'UTC'), 0);
    assert.equal(parseReminderDelayToMs('10 nonsense', now, 'UTC'), 0);
    const repeatedHour = Date.parse('2026-11-01T05:45:00Z');
    assert.equal(parseReminderDelayToMs('01:30', repeatedHour, 'America/New_York'), 45 * 60000);
    const skippedHour = Date.parse('2026-03-08T06:45:00Z');
    assert.equal(parseReminderDelayToMs('02:30', skippedHour, 'America/New_York'), 23.75 * 3600000);
});
