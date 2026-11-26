/* Runs an agent's regex rules away from the UI thread, so a slow pattern can be stopped. */
import { applyCreatorAgentRegexScripts } from './agent-regex.js';

self.onmessage = ({ data }) => {
    try {
        self.postMessage({ text: applyCreatorAgentRegexScripts(data.scripts, data.text) });
    } catch (error) { self.postMessage({ error: error?.message || 'The agent regex rules could not run.' }); }
};
