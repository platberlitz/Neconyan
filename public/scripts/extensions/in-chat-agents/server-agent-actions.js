import { power_user } from '../../power-user.js';

/**
 * Sends a manual Agent action to the server when replies are set to finish on
 * the server, so Run, Rerun, Retry and repair keep going after the page closes.
 * Resolves with null when the action should run in the page instead.
 * @param {{ mode: string, agentIds?: string[], companionId?: string, messageIndex: number }} action
 * @returns {Promise<{ state: string|null, error: string, jobId: string|null, current: boolean }|null>}
 */
export async function runAgentActionOnServer(action) {
    if (power_user?.reply_generation_location !== 'server') return null;
    const { runRoleplayAgentAction } = await import('../../neconyan-conversation/roleplay-workflows.js');
    return runRoleplayAgentAction(action);
}
