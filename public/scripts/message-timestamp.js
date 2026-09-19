import { moment } from '#macro-vendor';

/** Parse native and legacy message timestamps without browser state. */
export function parseTimestamp(timestamp) {
    if (!timestamp) return;
    if (timestamp instanceof Date) return timestamp.toISOString();
    if (typeof timestamp === 'number' || /^\d+$/.test(timestamp)) {
        const unixTime = Number(timestamp);
        const isValid = Number.isFinite(unixTime) && !Number.isNaN(unixTime) && unixTime >= 0;
        if (!isValid) return;
        return new Date(unixTime).toISOString();
    }
    if (moment(timestamp, moment.ISO_8601, true).isValid()) return timestamp;

    const convertFromMeridiemBased = (_, month, day, year, hour, minute, meridiem) => {
        const monthNum = moment().month(month).format('MM');
        const hour24 = meridiem.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
        return `${year}-${monthNum}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute.padStart(2, '0')}:00`;
    };
    const convertFromHumanized = (_, year, month, day, hour, min, sec, ms) => {
        ms = typeof ms !== 'undefined' ? `.${ms.padStart(3, '0')}` : '';
        return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}${ms}Z`;
    };
    const formats = [
        { callback: convertFromMeridiemBased, pattern: /(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i },
        { callback: convertFromHumanized, pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/ },
        { callback: convertFromHumanized, pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/ },
        { callback: convertFromHumanized, pattern: /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/ },
        { callback: convertFromHumanized, pattern: /(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2})-(\d{1,2})-(\d{1,2})/ },
    ];
    for (const { callback, pattern } of formats) {
        const match = timestamp.match(pattern);
        if (match) return callback(...match);
    }
}
