import { describe, expect, test } from '@jest/globals';
import {
    MISO_GUIDE_QUESTIONS,
    MISO_GUIDE_STORAGE_KEY,
    createDefaultMisoGuideAnswers,
    formatMisoSettingValue,
    getMisoQuestion,
    getMisoUndoBlockReason,
    mergeMisoSelection,
    normalizeMisoGuideAnswers,
    recommendSettings,
    resolveMisoTargetConflicts,
    sortMisoTargetsForApply,
} from '../public/scripts/miso-settings-recommendations.js';

const optionTargets = (questionId, value) => {
    const question = getMisoQuestion(questionId);
    const option = question.options.find(entry => entry.value === value);
    return option.targets.map(target => [target.setting, target.value]);
};


describe('Miso settings recommendations', () => {
    test('starts empty and keeps only known answers', () => {
        expect(createDefaultMisoGuideAnswers()).toEqual({
            version: 1,
            look: [],
            reading: [],
            chatting: [],
            device: 'keep',
        });
        expect(normalizeMisoGuideAnswers({
            look: ['simple', 'not-a-real-option'],
            reading: ['bubbles', 'storybook', 'messenger'],
            chatting: ['chime'],
            device: 'not-a-device',
        })).toEqual({
            version: 1,
            look: ['simple'],
            reading: ['bubbles'],
            chatting: ['chime'],
            device: 'keep',
        });
        expect(normalizeMisoGuideAnswers('nonsense')).toEqual(createDefaultMisoGuideAnswers());
        expect(MISO_GUIDE_STORAGE_KEY).toBe('NeconyanMisoSettingsGuide.v1');
    });

    test('maps every supported answer to its real settings', () => {
        expect(optionTargets('look', 'simple')).toEqual([['simpleMode', true]]);
        expect(optionTargets('look', 'compact')).toEqual([['compactMode', true]]);
        expect(optionTargets('look', 'kittyless')).toEqual([['kittyless', true]]);

        expect(optionTargets('reading', 'bubbles')).toEqual([['chatDisplay', 1]]);
        expect(optionTargets('reading', 'messenger')).toEqual([['chatDisplay', 8]]);
        expect(optionTargets('reading', 'storybook')).toEqual([['chatDisplay', 12]]);
        expect(optionTargets('reading', 'larger_text')).toEqual([['fontScale', 1.15], ['lineSpacing', 1.35]]);
        expect(optionTargets('reading', 'hide_details')).toEqual([
            ['messageTokenCount', false],
            ['messageTimer', false],
            ['messageModelName', false],
        ]);
        expect(optionTargets('reading', 'calm_motion')).toEqual([['reducedMotion', true], ['fastUi', true]]);

        expect(optionTargets('chatting', 'resume')).toEqual([['autoLoadChat', true]]);
        expect(optionTargets('chatting', 'server_replies')).toEqual([['replyLocation', 'server']]);
        expect(optionTargets('chatting', 'smooth_stream')).toEqual([['smoothStreaming', true]]);
        expect(optionTargets('chatting', 'quick_helpers')).toEqual([['quickContinue', true], ['quickImpersonate', true]]);
        expect(optionTargets('chatting', 'send_newline')).toEqual([['sendOnEnter', -1]]);
        expect(optionTargets('chatting', 'chime')).toEqual([['messageSound', true], ['backgroundSound', true]]);
        expect(optionTargets('chatting', 'spoiler_free')).toEqual([['spoilerFree', true]]);

        expect(optionTargets('device', 'keep')).toEqual([]);
        expect(optionTargets('device', 'standard')).toEqual([['lowMemoryMode', 'auto']]);
        expect(optionTargets('device', 'low_memory')).toEqual([['lowMemoryMode', 'on'], ['streamingFps', 15]]);
        expect(optionTargets('device', 'plenty')).toEqual([['lowMemoryMode', 'off'], ['chatTruncation', 150]]);
    });

    test('reports settings already at the suggested value instead of picking them', () => {
        const answers = { look: ['simple'], reading: ['larger_text'], chatting: ['resume'], device: 'standard' };
        const expected = [
            ...optionTargets('look', 'simple'),
            ...optionTargets('reading', 'larger_text'),
            ...optionTargets('chatting', 'resume'),
            ...optionTargets('device', 'standard'),
        ];
        const values = Object.fromEntries(expected);
        const result = recommendSettings(answers, { values });

        expect(result.picks).toEqual([]);
        expect(result.alreadySet.map(pick => pick.settingId)).toEqual(expected.map(([settingId]) => settingId));
        expect(result.alreadySet.every(pick => pick.alreadySet === true)).toBe(true);
        expect(result.canApply).toBe(false);
        expect(result.notes.join(' ')).toMatch(/Already set/);
    });

    test('returns titled, located picks and no model-request note', () => {
        const result = recommendSettings({
            look: ['compact'],
            reading: ['hide_details'],
            chatting: ['chime'],
            device: 'plenty',
        }, {
            values: {
                compactMode: false,
                messageTokenCount: true,
                messageTimer: true,
                messageModelName: true,
                messageSound: false,
                backgroundSound: true,
                lowMemoryMode: 'auto',
                chatTruncation: 100,
            },
        });

        expect(result.picks.map(pick => pick.settingId)).toEqual([
            'compactMode',
            'messageTokenCount',
            'messageTimer',
            'messageModelName',
            'messageSound',
            'lowMemoryMode',
            'chatTruncation',
        ]);
        const compact = result.picks[0];
        expect(compact.title).toBe('Compact layout');
        expect(compact.valueLabel).toBe('On');
        expect(compact.location).toContain('Appearance');
        expect(compact.reasons.join(' ')).toMatch(/tighter layout/);
        const sound = result.picks.find(pick => pick.settingId === 'messageSound');
        expect(sound.valueLabel).toBe('On');
        const truncation = result.picks.find(pick => pick.settingId === 'chatTruncation');
        expect(truncation.valueLabel).toBe('150 messages');
        expect(result.notes.join(' ')).toMatch(/sends no model request/);
        expect(result.notes.join(' ')).toMatch(/Only the boxes you tick/);
        expect(result.alreadySet.map(pick => pick.settingId)).toEqual(['backgroundSound']);
    });

    test('resolves two chat styles deterministically and explains the dropped one', () => {
        expect(normalizeMisoGuideAnswers({ reading: ['storybook', 'messenger', 'bubbles'] }).reading).toEqual(['bubbles']);
        const { targets, conflicts } = resolveMisoTargetConflicts([
            { settingId: 'chatDisplay', value: 1, valueLabel: 'Bubbles', optionLabel: 'Bubbles' },
            { settingId: 'chatDisplay', value: 8, valueLabel: 'Messenger', optionLabel: 'Messenger' },
        ]);
        expect(targets.map(target => target.value)).toEqual([1]);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0].reason).toMatch(/Kept Bubbles/);
        expect(conflicts[0].reason).toMatch(/Messenger also asks/);
    });

    test('skips a locked setting when it cannot be changed', () => {
        const result = recommendSettings({ reading: ['calm_motion'] }, {
            values: { reducedMotion: false, fastUi: false },
            locked: ['reducedMotion'],
        });
        expect(result.picks.map(pick => pick.settingId)).toEqual(['fastUi']);
        expect(result.skipped.map(entry => entry.settingId)).toEqual(['reducedMotion']);
        expect(result.skipped[0].reason).toMatch(/cannot change/);
    });

    test('uses a plain locked reason for a window fixed by aggressive unloading', () => {
        const reason = 'Aggressive unloading keeps the chat at 5 messages. Turn off Enable aggressive unloading in Settings → System & Device before changing Messages to load.';
        const result = recommendSettings({ device: 'plenty' }, {
            values: { lowMemoryMode: 'on', chatTruncation: 5 },
            locked: { chatTruncation: reason },
        });
        expect(result.picks.map(pick => pick.settingId)).toEqual(['lowMemoryMode']);
        expect(result.skipped).toEqual([
            expect.objectContaining({ settingId: 'chatTruncation', reason }),
        ]);
        expect(result.notes.join(' ')).not.toMatch(/chatTruncation/);
    });

    test('keeps the messages-to-load target when low-memory mode alone can change it', () => {
        const result = recommendSettings({ device: 'plenty' }, {
            values: { lowMemoryMode: 'on', chatTruncation: 25 },
            locked: {},
        });
        expect(result.picks.map(pick => pick.settingId)).toEqual(['lowMemoryMode', 'chatTruncation']);
        expect(result.skipped).toEqual([]);
    });

    test('keeps manual unticks when new picks arrive, until the answers reset', () => {
        const picks = [{ settingId: 'compactMode' }, { settingId: 'messageSound' }, { settingId: 'simpleMode' }];
        const kept = mergeMisoSelection({
            previousSelection: ['compactMode'],
            previousKnown: ['compactMode', 'messageSound'],
            picks,
        });
        expect([...kept]).toEqual(['compactMode', 'simpleMode']);
        const reset = mergeMisoSelection({
            previousSelection: ['compactMode'],
            previousKnown: ['compactMode', 'messageSound'],
            picks,
            resetSelection: true,
        });
        expect([...reset]).toEqual(['compactMode', 'messageSound', 'simpleMode']);
    });

    test('puts low-memory mode before the settings its policy manages', () => {
        const sorted = sortMisoTargetsForApply([
            { settingId: 'chatDisplay' },
            { settingId: 'chatTruncation' },
            { settingId: 'lowMemoryMode' },
            { settingId: 'fastUi' },
            { settingId: 'simpleMode' },
            { settingId: 'streamingFps' },
        ]);
        expect(sorted.map(target => target.settingId)).toEqual([
            'lowMemoryMode',
            'chatTruncation',
            'fastUi',
            'streamingFps',
            'chatDisplay',
            'simpleMode',
        ]);
    });

    test('blocks undo when an applied setting or low-memory choice changed elsewhere', () => {
        expect(getMisoUndoBlockReason({
            applied: { compactMode: true, chatTruncation: 150 },
            current: { compactMode: true, chatTruncation: 150 },
        })).toBe('');
        expect(getMisoUndoBlockReason({
            applied: { compactMode: true },
            current: { compactMode: false },
        })).toMatch(/changed elsewhere/);
        expect(getMisoUndoBlockReason({
            applied: { compactMode: true },
            current: {},
        })).toMatch(/changed elsewhere/);
        expect(getMisoUndoBlockReason({
            applied: { chatTruncation: 150 },
            current: { chatTruncation: 150 },
            expectedPreferences: '{"fast_ui_mode":true}',
            currentPreferences: '{"fast_ui_mode":false}',
        })).toMatch(/low-memory/);
    });

    test('formats values the way the results list shows them', () => {
        expect(formatMisoSettingValue('chatDisplay', 1)).toBe('Bubbles');
        expect(formatMisoSettingValue('chatDisplay', 8)).toBe('Messenger');
        expect(formatMisoSettingValue('chatDisplay', 12)).toBe('Storybook');
        expect(formatMisoSettingValue('sendOnEnter', -1)).toBe('Disabled');
        expect(formatMisoSettingValue('lowMemoryMode', 'auto')).toBe('Auto');
        expect(formatMisoSettingValue('replyLocation', 'server')).toBe('On the server');
        expect(formatMisoSettingValue('chatTruncation', 150)).toBe('150 messages');
        expect(formatMisoSettingValue('streamingFps', 15)).toBe('15 per second');
        expect(formatMisoSettingValue('fastUi', true)).toBe('On');
        expect(formatMisoSettingValue('fastUi', false)).toBe('Off');
    });

    test('exposes four questions in the order the guide walks them', () => {
        expect(MISO_GUIDE_QUESTIONS.map(question => question.id)).toEqual(['look', 'reading', 'chatting', 'device']);
        expect(MISO_GUIDE_QUESTIONS.map(question => question.type)).toEqual(['checkbox', 'checkbox', 'checkbox', 'radio']);
    });
});
