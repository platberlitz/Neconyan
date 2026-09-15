import { safeRegister } from './registration.js';
import {
    addToDate,
    diffDates,
    formatDate,
    normalizeUnit,
    parseDateInput,
} from './date-impl.js';

export const CATEGORY_DATE = 'enhanced-date';

const UNIT_HELP = 'years, months, weeks, days, hours, minutes or seconds (y/M/w/d/h/m/s)';

export function registerDateMacros() {
    safeRegister('dateadd', {
        category: CATEGORY_DATE,
        unnamedArgs: [
            { name: 'date', description: 'The starting date. Leave empty for now.' },
            { name: 'amount', type: 'integer', description: 'How much to add. Negative subtracts.' },
            { name: 'unit', description: `The unit: ${UNIT_HELP}.` },
            { name: 'format', optional: true, defaultValue: 'YYYY-MM-DD', description: 'The output format (YYYY, MM, DD, HH, mm, ss, dddd, ...).' },
        ],
        description: 'Adds time to a date (calendar-aware: Jan 31 + 1 month = Feb 28). Note: with an empty date argument the result changes as time passes.',
        returns: 'the shifted date',
        exampleUsage: ['{{dateadd::2026-08-03::3::days}}', '{{dateadd::::2::weeks::MMMM D}}'],
        handler: ({ unnamedArgs: [date, amount, unit, format], warn }) => {
            const parsed = parseDateInput(date);
            if (!parsed) {
                warn(`{{dateadd}}: "${date}" is not a date I can read.`);
                return String(date ?? '');
            }
            const n = Number.parseInt(String(amount).trim(), 10);
            if (Number.isNaN(n)) {
                warn(`{{dateadd}}: "${amount}" is not a whole number.`);
                return String(date ?? '');
            }
            const normalizedUnit = normalizeUnit(unit);
            if (!normalizedUnit) {
                warn(`{{dateadd}}: "${unit}" is not a unit I know (${UNIT_HELP}).`);
                return String(date ?? '');
            }
            return formatDate(addToDate(parsed, n, normalizedUnit), format || 'YYYY-MM-DD');
        },
    });

    safeRegister('datediff', {
        category: CATEGORY_DATE,
        unnamedArgs: [
            { name: 'from', description: 'The earlier date. Leave empty for now.' },
            { name: 'to', description: 'The later date. Leave empty for now.' },
            { name: 'unit', optional: true, defaultValue: 'days', description: `The unit: ${UNIT_HELP}.` },
        ],
        description: 'Whole units between two dates (negative when "to" is earlier).',
        returns: 'a whole number',
        returnType: 'integer',
        exampleUsage: ['{{datediff::2026-01-01::2026-08-03::months}}'],
        handler: ({ unnamedArgs: [from, to, unit], warn }) => {
            const a = parseDateInput(from);
            const b = parseDateInput(to);
            if (!a || !b) {
                warn(`{{datediff}}: "${!a ? from : to}" is not a date I can read.`);
                return '';
            }
            const normalizedUnit = normalizeUnit(unit === undefined || unit === '' ? 'days' : unit);
            if (!normalizedUnit) {
                warn(`{{datediff}}: "${unit}" is not a unit I know (${UNIT_HELP}).`);
                return '';
            }
            return String(diffDates(a, b, normalizedUnit));
        },
    });

    safeRegister('dateformat', {
        category: CATEGORY_DATE,
        unnamedArgs: [
            { name: 'date', description: 'The date to format. Leave empty for now.' },
            { name: 'format', optional: true, defaultValue: 'YYYY-MM-DD', description: 'The output format (YYYY, MM, DD, HH, mm, ss, dddd, A, [literal], ...).' },
        ],
        description: 'Formats a date. Note: with an empty date argument this changes every call. that hurts prompt caching, like {{time}}.',
        returns: 'the formatted date',
        exampleUsage: ['{{dateformat::2026-08-03::dddd, MMMM D}}'],
        handler: ({ unnamedArgs: [date, format], warn }) => {
            const parsed = parseDateInput(date);
            if (!parsed) {
                warn(`{{dateformat}}: "${date}" is not a date I can read.`);
                return String(date ?? '');
            }
            return formatDate(parsed, format || 'YYYY-MM-DD');
        },
    });
}
