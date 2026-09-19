/** Resolve durations or the next occurrence of a wall-clock time in the captured timezone. */
export function parseReminderDelayToMs(rawDelay, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const delay = String(rawDelay || '').trim().toLowerCase();
    const clock = delay.match(/^(\d{1,2}):(\d{2})$/);
    if (clock) {
        const hour = Number(clock[1]);
        const minute = Number(clock[2]);
        if (hour > 23 || minute > 59) return 0;
        const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const expected = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        // Search actual minutes so skipped/repeated daylight-saving hours follow the named timezone.
        for (let target = Math.floor(now / 60000) * 60000 + 60000; target <= now + 48 * 60 * 60000; target += 60000) {
            if (formatter.format(target) === expected) return target - now;
        }
        return 0;
    }
    const duration = delay.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?)?$/);
    if (!duration) return 0;
    const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(duration[2] || 'm')[0]];
    const result = Number(duration[1]) * multiplier;
    return Number.isFinite(result) ? result : 0;
}
