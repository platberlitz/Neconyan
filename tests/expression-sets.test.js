import { readExpressionSets, resolveExpressionMember, applyExpressionMemberPrompt, getExpressionsAgentCastPrompt } from '../public/scripts/extensions/expressions/expression-sets.js';

const mira = { id: 'mira', name: 'Mira', folder: 'cast/mira', description: 'Silver hair, green coat.' };
const sol = { id: 'sol', name: 'Sol', folder: 'cast/sol', description: 'Red hair, blue coat.' };
const card = auto => ({ data: { extensions: { expression_sets: { version: 1, members: [mira, sol], active: 'mira', auto } } } });

describe('modular character expressions', () => {
    test('manual selections stay fixed; automatic selections require an explicit speaker', () => {
        expect(resolveExpressionMember(card(false), { mes: 'Sol: Hello.' })).toEqual(mira);
        expect(resolveExpressionMember(card(true), { mes: 'I spoke to Sol yesterday.' })).toEqual(mira);
        expect(resolveExpressionMember(card(true), { mes: '**Sol:** Hello.\nMira: Hi.' })).toEqual(sol);
        expect(resolveExpressionMember(card(true), { name: 'Sol', mes: 'Hello.' })).toEqual(sol);
    });
    test('the Expressions Agent names the character, and the saved sprite keeps it', () => {
        const reply = { mes: 'Mira: Hello.\nSol scowls.' };
        expect(resolveExpressionMember(card(true), reply, { speaker: 'sol' })).toEqual(sol);
        expect(resolveExpressionMember(card(true), reply, { speaker: 'Nobody' })).toEqual(mira);
        expect(resolveExpressionMember(card(true), reply, { savedSrc: '/characters/cast/sol/anger.png?t=1' })).toEqual(sol);
        expect(resolveExpressionMember(card(true), reply, { speaker: 'Mira', savedSrc: '/characters/cast/sol/anger.png' })).toEqual(mira);
        expect(resolveExpressionMember(card(false), reply, { speaker: 'Sol', savedSrc: '/characters/cast/sol/anger.png' })).toEqual(mira);
    });
    test('only shared cards that follow the speaker ask the agent for a name', () => {
        const prompt = getExpressionsAgentCastPrompt(card(true));
        expect(prompt).toContain('Mira, Sol');
        expect(prompt).toContain('Mira: <label>');
        expect(getExpressionsAgentCastPrompt(card(false))).toBe('');
        const single = card(true);
        single.data.extensions.expression_sets.members = [mira];
        expect(getExpressionsAgentCastPrompt(single)).toBe('');
        expect(getExpressionsAgentCastPrompt(null)).toBe('');
    });
    test('malformed imported definitions cannot escape the sprite directory or alias a member', () => {
        const value = card(false);
        value.data.extensions.expression_sets.members.push({ ...sol, folder: '../sol' }, { ...mira, id: 'other' });
        value.data.extensions.expression_sets.active = 'missing';
        expect(readExpressionSets(value)).toEqual({ version: 1, members: [mira, sol], active: '', auto: false });
    });
    test('generation snapshots isolate the selected person and retain shared card context', () => {
        const context = { characterName: 'Mira and Sol', characterCard: 'Shared history', framing: 'bust' };
        const member = { ...sol };
        const result = applyExpressionMemberPrompt(context, member);
        member.description = 'Changed after capture';
        expect(result.characterName).toBe('Sol');
        expect(result.characterCard).toContain('Red hair, blue coat.');
        expect(result.characterCard).toContain('Do not draw any other cast member.');
        expect(result.characterCard).toContain('Shared history');
        expect(context.characterName).toBe('Mira and Sol');
    });
});
