import { describe, expect, test } from '@jest/globals';
import { overflowFingerprint, overflowPlan, overflowRanges, visibleMessageIndices } from '../public/scripts/mewmory/overflow-policy.js';

const user = mes => ({ is_user: true, mes });
const reply = mes => ({ is_user: false, mes });
const hidden = (mes, isUser = false) => ({ is_user: isUser, mes, is_system: true });
const countsFor = (messages, tokens = 10) => visibleMessageIndices(messages).map(() => tokens);

describe('Mewmory overflow policy', () => {
    test('a large backlog is cleared in one pass instead of keeping a 30,000-token tail', () => {
        const messages = Array.from({ length: 100 }, (_, index) => index % 2 ? reply('r'.repeat(3999)) : user('u'.repeat(3999)));
        const plan = overflowPlan(messages, 30000, countsFor(messages, 1000));
        // 100,000 visible tokens: every message older than the latest reply is hidden.
        expect(plan.indices).toEqual(Array.from({ length: 99 }, (_, index) => index));
    });

    test('the same configured trigger clears the backlog for a small or huge writing preset', () => {
        const messages = Array.from({ length: 100 }, (_, index) => index % 2 ? reply('r'.repeat(3999)) : user('u'.repeat(3999)));
        const counts = countsFor(messages, 1000);
        for (const presetContext of [4096, 96000, 1000000]) {
            // The preset only changes the writing model's room; Mewmory uses its own saved trigger.
            expect(presetContext).toBeGreaterThan(0);
            expect(overflowPlan(messages, 30000, counts).indices).toEqual(Array.from({ length: 99 }, (_, index) => index));
        }
    });

    test('the exact trigger clears accumulated history, and staying below it keeps everything visible', () => {
        const messages = [user('old'), reply('latest')];
        expect(overflowPlan(messages, 30, [10, 20]).indices).toEqual([0]);
        expect(overflowPlan(messages, 31, [10, 20]).indices).toEqual([]);
    });

    test('an oversized latest reply and later user messages stay visible', () => {
        const messages = [user('old'), reply('oversized reply'), user('later question')];
        expect(overflowPlan(messages, 30, [10, 500, 500]).indices).toEqual([0]);
        expect(overflowPlan([user('old'), user('question')], 30, [10, 500]).indices).toEqual([]);
    });

    test('hidden messages are skipped, stay hidden and never count towards the trigger', () => {
        const messages = [user('old visible'), hidden('already hidden user', true), hidden('already hidden reply'),
            user('middle visible'), hidden('also hidden'), reply('latest reply')];
        const visible = visibleMessageIndices(messages);
        expect(visible).toEqual([0, 3, 5]);
        expect(overflowPlan(messages, 15, [10, 10, 10]).indices).toEqual([0, 3]);
        const applied = messages.map((message, index) => index === 0 || index === 3
            ? { ...message, is_system: true, extra: { mewmoryKeepHidden: true } } : message);
        const remaining = overflowPlan(applied, 15, countsFor(applied));
        expect(remaining.indices).toEqual([]);
    });

    test('hidden messages between visible old rows do not make the hide plan split into a hole', () => {
        const messages = [user('one'), hidden('skip'), user('two'), hidden('skip again'), reply('latest')];
        const plan = overflowPlan(messages, 10, [10, 10, 10]);
        expect(plan.indices).toEqual([0, 2]);
        expect(overflowRanges(plan.indices)).toEqual([[0, 0], [2, 2]]);
    });

    test('a repeated plan after the clear is a no-op until the visible history reaches the trigger again', () => {
        const messages = [user('a'.repeat(10)), reply('b'.repeat(10)), user('c'.repeat(10)), reply('d'.repeat(10))];
        const plan = overflowPlan(messages, 25, countsFor(messages));
        expect(plan.indices).toEqual([0, 1, 2]);
        const saved = messages.map((message, index) => plan.indices.includes(index)
            ? { ...message, is_system: true, extra: { mewmoryKeepHidden: true } } : message);
        expect(overflowPlan(saved, 25, countsFor(saved))).toEqual({ limit: 25, indices: [] });

        // The latest reply stays; the next cycle hides it too once new history accumulates.
        const nextCycle = [...saved, user('e'.repeat(10)), reply('f'.repeat(10))];
        expect(overflowPlan(nextCycle, 25, countsFor(nextCycle)).indices).toEqual([3, 4]);
    });

    test('an incomplete count or a non-positive limit hides nothing instead of guessing', () => {
        const messages = [user('old'), reply('latest')];
        expect(overflowPlan(messages, 0, [10, 10]).indices).toEqual([]);
        expect(() => overflowPlan(messages, 10, [10])).toThrow('incomplete token count');
    });

    test('the fingerprint changes for an edit, a hidden flag or an append', () => {
        const messages = [user('a'), reply('b')];
        const before = overflowFingerprint(messages);
        expect(overflowFingerprint(messages.map(message => ({ ...message })))).toBe(before);
        expect(overflowFingerprint([{ ...messages[0], mes: 'changed' }, messages[1]])).not.toBe(before);
        expect(overflowFingerprint([{ ...messages[0], is_system: true }, messages[1]])).not.toBe(before);
        expect(overflowFingerprint([...messages, user('c')])).not.toBe(before);
    });
});
