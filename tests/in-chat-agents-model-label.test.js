import { describe, test, expect, jest, beforeEach } from '@jest/globals';

describe('in-chat agent model labels', () => {
    let powerUser;

    async function importModelLabel() {
        jest.resetModules();
        await jest.unstable_mockModule('../public/script.js', () => ({
            getShortModelName: jest.fn(model => String(model ?? '').split('/').pop().replace(/^(?:\s*\[[^\]]*\]\s*)+/, '')),
        }));
        await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
            power_user: powerUser,
        }));
        return await import('../public/scripts/extensions/in-chat-agents/model-label.js');
    }

    beforeEach(() => {
        powerUser = { timestamp_model_name_short: false };
    });

    test('formats single and joined model ids with Short Model Name', async () => {
        const { formatAgentModelName } = await importModelLabel();

        expect(formatAgentModelName('moonshot/kimi-k3')).toBe('moonshot/kimi-k3');
        expect(formatAgentModelName('')).toBe('');

        powerUser.timestamp_model_name_short = true;
        expect(formatAgentModelName('moonshot/kimi-k3')).toBe('kimi-k3');
        expect(formatAgentModelName('a/one, b/two')).toBe('one, two');
    });

    test('reads the model from new records and plain ids from older ones', async () => {
        const { getAgentResultModelName } = await importModelLabel();
        powerUser.timestamp_model_name_short = true;

        expect(getAgentResultModelName({ model: 'org/model-a', modelLabel: 'ignored' })).toBe('model-a');
        expect(getAgentResultModelName({ modelLabel: '[free] org/model-b' })).toBe('model-b');
        expect(getAgentResultModelName({ modelLabel: 'claude-3.5-sonnet (Example profile)' })).toBe('claude-3.5-sonnet (Example profile)');
        expect(getAgentResultModelName({ modelLabel: 'Main model' })).toBe('');
        expect(getAgentResultModelName({})).toBe('');
    });

    test('describes the run with its saved connection name', async () => {
        const { describeAgentRunModel } = await importModelLabel();

        expect(describeAgentRunModel({ model: 'org/model-a', profileLabel: 'Work' })).toBe('org/model-a (Work)');
        expect(describeAgentRunModel({ model: 'org/model-a', profileLabel: 'Main model' })).toBe('org/model-a');
        expect(describeAgentRunModel({ modelLabel: 'model-a (Work)', profileLabel: 'Work' })).toBe('model-a (Work)');
        expect(describeAgentRunModel({ modelLabel: 'Main model', profileLabel: 'Main model' })).toBe('Main model');
        expect(describeAgentRunModel({})).toBe('');
    });
});
