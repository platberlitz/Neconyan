const AGENT_WORK_IDLE_POLL_MS = 250;

let agentWorkProbe = () => false;

/** Agents register how to tell whether they could still be working on the open chat. */
export function setAgentWorkProbe(probe) {
    agentWorkProbe = typeof probe === 'function' ? probe : () => false;
}

/**
 * True while an agent run, or reply post-processing that is queued, running or
 * about to retry, could still be working on the open chat. Reloading the chat
 * in that window cancels it.
 */
export function isAgentWorkPending() {
    try {
        return Boolean(agentWorkProbe());
    } catch (error) {
        console.warn('[InChatAgents] Agent work check failed:', error);
        return false;
    }
}

/** Resolves true once no agent is working, or false as soon as `isCancelled()` returns true. */
export function waitForAgentWorkIdle({ isCancelled = () => false, pollMs = AGENT_WORK_IDLE_POLL_MS } = {}) {
    return new Promise(resolve => {
        const check = () => {
            if (isCancelled()) return resolve(false);
            if (!isAgentWorkPending()) return resolve(true);
            setTimeout(check, pollMs);
        };
        check();
    });
}
