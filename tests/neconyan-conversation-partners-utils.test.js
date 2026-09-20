import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeRegex: value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
}));

const {
    getRecentlySilentMentionedPartnerFromThread,
    collectConversationPartnerAvatars,
    mergeConversationPartnerSettings,
    selectChimePartners,
    getSpeakerPrefixMatch,
    isCharacterMentionedInText,
    parseAvatarList,
    stripSpeakerPrefixText,
} = await import('../public/scripts/neconyan-conversation/partners-utils.js');

describe('sillybunny conversation partner utils', () => {
    test('parses configured partner avatar lists', () => {
        expect(parseAvatarList(' ada.png, , grace.png ,')).toEqual(['ada.png', 'grace.png']);
    });

    test('matches mention boundaries without substring false positives', () => {
        const ada = { name: 'Ada Lovelace', avatar: 'ada.png' };
        const grace = { name: 'Grace Hopper', avatar: 'grace.png' };

        expect(isCharacterMentionedInText(ada, 'can @Ada look at this?', [ada, grace])).toBe(true);
        expect(isCharacterMentionedInText(ada, 'the database looks fine', [ada, grace])).toBe(false);
    });

    test('does not resolve ambiguous first-name mentions', () => {
        const aliceHart = { name: 'Alice Hart', avatar: 'alice-hart.png' };
        const aliceChen = { name: 'Alice Chen', avatar: 'alice-chen.png' };

        expect(isCharacterMentionedInText(aliceHart, 'Alice should decide.', [aliceHart, aliceChen])).toBe(false);
        expect(isCharacterMentionedInText(aliceHart, '@AliceHart should decide.', [aliceHart, aliceChen])).toBe(true);
    });

    test('finds a recently mentioned partner who has not replied yet', () => {
        const ada = { name: 'Ada Lovelace', avatar: 'ada.png' };
        const grace = { name: 'Grace Hopper', avatar: 'grace.png' };
        const thread = [
            { role: 'user', mes: 'Grace already answered.' },
            { role: 'character', mes: 'yep', extra: { partner_avatar: 'grace.png' } },
            { role: 'user', mes: '@Ada can you check this?' },
        ];

        expect(getRecentlySilentMentionedPartnerFromThread(thread, [ada, grace], 6)).toBe(ada);

        thread.push({ role: 'character', mes: 'looking now', extra: { partner_avatar: 'ada.png' } });
        expect(getRecentlySilentMentionedPartnerFromThread(thread, [ada, grace], 6)).toBe(null);
    });

    test('strips generated speaker prefixes line by line', () => {
        expect(stripSpeakerPrefixText('**Ada:** hello\n{{char}} - checking', 'Ada')).toBe('hello\nchecking');
        expect(stripSpeakerPrefixText('Ada: hello', 'Ada', text => text.toUpperCase())).toBe('HELLO');
    });

    test('resolves configured and historical partners and only overrides partner-specific settings', () => {
        const host = { multi_char_names: 'host.png, ada.png, ada.png', reply_max_tokens: 73, connection_profile: 'host', image_gen_enabled: false };
        expect(collectConversationPartnerAvatars('host.png', host, [{ role: 'partner', extra: { partner_avatar: 'grace.png' } }],
            { members: ['host.png', 'lin.png', 'muted.png'], disabled_members: ['muted.png'] })).toEqual(['ada.png', 'lin.png', 'grace.png']);
        expect(mergeConversationPartnerSettings(host, { connection_profile: 'partner', reply_max_tokens: 999, image_gen_enabled: true, availability: 'idle' }))
            .toMatchObject({ connection_profile: 'partner', reply_max_tokens: 73, image_gen_enabled: false, availability: 'idle' });
    });

    test('chimes honour unanswered mentions, least-recent selection, idle time and both saved marker formats', () => {
        const partners = [{ avatar: 'ada.png', name: 'Ada' }, { avatar: 'grace.png', name: 'Grace' }, { avatar: 'lin.png', name: 'Lin' }];
        const branch = { lastActivity: 1000, messages: [
            { role: 'user', mes: '@Ada and @Grace, please answer.' },
            { role: 'partner', mes: 'Ada has answered.', extra: { partner_avatar: 'ada.png' } },
        ], sessionMarkers: {} };
        const input = { partners, branch, now: 1100, settings: { multi_char: false }, random: () => 0 };
        expect(selectChimePartners(input)).toEqual([partners[1]]);
        expect(selectChimePartners({ ...input, settings: { multi_char: true } })).toEqual([partners[1], partners[2]]);
        for (const key of ['sb_conv_last_chime_session_', 'sb_conv_last_chime_session_solo']) {
            branch.sessionMarkers = { [key]: '1000' };
            expect(selectChimePartners(input)).toEqual([]);
        }
        branch.sessionMarkers = {};
        branch.messages = [{ role: 'user', mes: 'No named partner.' }];
        expect(selectChimePartners({ ...input, settings: { multi_char: true, idle_limit: 4 } })).toEqual([]);
        expect(selectChimePartners({ ...input, settings: { multi_char: true, idle_limit: 4 }, now: 61000, random: () => 0 })).toHaveLength(2);
    });

    test('detects explicit generated speaker labels for group replies', () => {
        const speakers = [
            { name: 'Alhaitham', avatar: 'alhaitham.png' },
            { name: 'Kaveh', avatar: 'kaveh.png' },
        ];

        expect(getSpeakerPrefixMatch('Kaveh: did you just type as me', speakers)).toEqual({
            speaker: speakers[1],
            text: 'did you just type as me',
        });
        expect(getSpeakerPrefixMatch('I saw Kaveh: type that', speakers)).toBe(null);
    });
});
