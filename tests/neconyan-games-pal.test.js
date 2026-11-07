import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const generateRawData = jest.fn();
const sendRequest = jest.fn();
const getConnectionProfiles = jest.fn();
jest.unstable_mockModule('../public/script.js', () => ({ generateRawData }));
jest.unstable_mockModule('../public/scripts/extensions/shared.js', () => ({
    ConnectionManagerRequestService: { sendRequest },
}));
jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/llm-utils.js', () => ({
    extractProfileResponseText: response => response?.choices?.[0]?.message?.content || '',
}));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/personas.js', () => ({ getConnectionProfiles }));

const { requestPalMove, testExports } = await import('../public/scripts/neconyan-conversation/games/pal.js');
const { RULES: connectFour } = await import('../public/scripts/neconyan-conversation/games/rules/connect-four.js');
const { RULES: chess } = await import('../public/scripts/neconyan-conversation/games/rules/chess.js');

beforeEach(() => {
    jest.clearAllMocks();
    getConnectionProfiles.mockReturnValue([]);
});

describe('the pal plays the legal move returned by the connection', () => {
    test('keeps the requested Connect Four column rather than the first legal column', async () => {
        generateRawData.mockResolvedValue('4');
        const result = await requestPalMove({ rules: connectFour, state: connectFour.createState({ options: { first: 'pal' } }) });
        expect(result).toEqual({ move: { column: 3 }, source: 'model' });
    });

    test('keeps the requested Chess squares', async () => {
        generateRawData.mockResolvedValue('e2e4');
        const result = await requestPalMove({ rules: chess, state: chess.createState({ options: { first: 'pal' } }) });
        expect(result.source).toBe('model');
        expect(result.move).toMatchObject({ from: 52, to: 36 });
    });

    test.each(['pal-profile', 'Pal profile'])('uses the saved connection %s without changing the main API', async profileName => {
        getConnectionProfiles.mockReturnValue([{ id: 'pal-profile', name: 'Pal profile' }]);
        sendRequest.mockResolvedValue({ choices: [{ message: { content: '6' } }] });
        const result = await requestPalMove({ rules: connectFour, state: connectFour.createState({ options: { first: 'pal' } }), profileName });
        expect(result).toEqual({ move: { column: 5 }, source: 'model' });
        expect(sendRequest).toHaveBeenCalledWith('pal-profile', expect.any(Array), 140, expect.objectContaining({ stream: false, includePreset: false }));
        expect(generateRawData).not.toHaveBeenCalled();
    });

    test('falls back to a legal local move for an unusable reply', async () => {
        generateRawData.mockResolvedValue('No move to offer.');
        const state = connectFour.createState({ options: { first: 'pal' } });
        const result = await requestPalMove({ rules: connectFour, state });
        expect(result.source).toBe('search');
        expect(connectFour.legalMoves(state)).toContainEqual(result.move);
    });

    test('does not confuse promotions or different move shapes', () => {
        expect(testExports.sameMove({ from: 8, to: 0, promotion: 'q' }, { from: 8, to: 0, promotion: 'n' })).toBe(false);
        expect(testExports.sameMove({ column: 0 }, { column: 3 })).toBe(false);
        expect(testExports.sameMove({ column: 0 }, { from: 8, to: 0 })).toBe(false);
    });
});
