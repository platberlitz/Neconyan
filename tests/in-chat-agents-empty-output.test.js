import { EMPTY_OUTPUT_SENTINELS, stripEmptyOutputSentinelLines } from '../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';

test.each([...EMPTY_OUTPUT_SENTINELS])('strips the supported %s sentinel from live output', sentinel => {
    expect(stripEmptyOutputSentinelLines(`Before\r\n  ${sentinel}\t\r\nAfter`)).toBe('Before\n\nAfter');
    expect(stripEmptyOutputSentinelLines(sentinel)).toBe('');
});

test('strips every sentinel in one update and leaves ordinary prose untouched', () => {
    const raw = [...EMPTY_OUTPUT_SENTINELS].join('\n');
    expect(stripEmptyOutputSentinelLines(raw)).toBe('');
    const prose = 'The words tracker-none and PHONE_NONE remain in ordinary prose.\ntracker-none-ish';
    expect(stripEmptyOutputSentinelLines(prose)).toBe(prose);
});
