import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const powerUser = {};
const runRoleplayAgentAction = jest.fn();

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: powerUser }));
jest.unstable_mockModule('../public/scripts/neconyan-conversation/roleplay-workflows.js', () => ({ runRoleplayAgentAction }));

const { runAgentActionOnServer } = await import('../public/scripts/extensions/in-chat-agents/server-agent-actions.js');

describe('manual Agent actions and the reply location', () => {
    beforeEach(() => {
        delete powerUser.reply_generation_location;
        runRoleplayAgentAction.mockReset();
    });

    test.each([undefined, 'browser', 'Server'])('stay in the page when the saved choice is %p', async location => {
        powerUser.reply_generation_location = location;
        await expect(runAgentActionOnServer({ mode: 'run', agentIds: ['edit'], messageIndex: 1 })).resolves.toBeNull();
        expect(runRoleplayAgentAction).not.toHaveBeenCalled();
    });

    test('go to the server when server replies are chosen', async () => {
        powerUser.reply_generation_location = 'server';
        const outcome = { state: 'completed', error: '', jobId: 'job-1', current: true };
        runRoleplayAgentAction.mockResolvedValue(outcome);
        const action = { mode: 'companions', agentIds: ['keeper'], messageIndex: 3 };

        await expect(runAgentActionOnServer(action)).resolves.toBe(outcome);
        expect(runRoleplayAgentAction).toHaveBeenCalledWith(action);
    });
});
