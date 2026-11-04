import { getRequestHeaders } from '../../../../script.js';
import { getPathfinderRuntimeAgent, runAsInternalPromptTransform } from '../agent-runner.js';
import { getSettings } from './tree-store.js';
import { sidecarGenerateWithProfile } from './llm-sidecar.js';
import { extension_settings } from '../../../extensions.js';
import { getChatCompletionModel, oai_settings } from '../../../openai.js';
import { effectiveDecisionMode } from '../../../mewmory/jev-presets.js';
export { entryDecisionCandidates, waypointDecisionCandidates } from './decision-input.js';

/** Only retrieval calls use decisions. Summary writing keeps its chat connection. */
export async function retrieveWithModel(prompt, systemPrompt, profileId, maxTokens, signal, options = {}) {
    const settings = getSettings();
    const profile = extension_settings.connectionManager?.profiles?.find(item => item.id === profileId);
    const stageSettings = options.stageProfile ? { ...settings, modelConnection: 'profile', modelOverride: '', decisionMode: 'auto' } : settings;
    const manual = stageSettings.modelConnection === 'manual';
    const mode = effectiveDecisionMode({ decisionMode: stageSettings.decisionMode,
        model: stageSettings.modelOverride || profile?.model || getChatCompletionModel(),
        endpoint: manual ? stageSettings.modelEndpoint : profile?.['api-url'] || (!profileId && oai_settings.chat_completion_source === 'custom' ? oai_settings.custom_url : '') });
    if (!manual && mode === 'chat') return { text: await sidecarGenerateWithProfile(prompt, systemPrompt, profileId, maxTokens, signal,
        { ...options, modelOverride: stageSettings.modelOverride }) };
    const response = await runAsInternalPromptTransform(() => fetch('/api/in-chat-agents/pathfinder/retrieve', {
        method: 'POST', headers: getRequestHeaders(), signal,
        body: JSON.stringify({ settings, agentId: getPathfinderRuntimeAgent()?.id, profileId: options.stageProfile || '',
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
            candidates: options.candidates, maxTokens, temperature: options.temperature }),
    }), signal);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Pawthfinder retrieval failed.');
    signal?.throwIfAborted();
    if (result.useExistingConnection) return { text: await sidecarGenerateWithProfile(prompt, systemPrompt, profileId, maxTokens, signal, options) };
    return result;
}
