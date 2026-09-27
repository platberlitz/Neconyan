import { roleplayError } from '../roleplay-store.js';
import { getActiveCompanionResults, getAgentTemplateId, MEMORY_SHARD_TEMPLATE_ID } from '../../public/scripts/extensions/in-chat-agents/companion/companion-shared.js';
import { isNativeCompanion } from './agent-definition.js';

export const MAX_COMPANION_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_MANUAL_RESULT_BYTES = Math.floor(1.6 * 1024 * 1024);
const MAX_NOTE_CODE_UNITS = 65536;

/** Reserve worst-case escaped note text before any model or companion call is accepted. */
export function captureCompanionCapacity(agents, records, source, { agentContext = false, trigger = 'normal', hiddenIds = [] } = {}) {
    const hidden = new Set(hiddenIds);
    // Automatic runs skip hidden Companions; explicit manual selections can still run them.
    const selected = agents.filter(agent => isNativeCompanion(agent) && agent.prompt.trim() && (agentContext || !hidden.has(agent.id)));
    const index = source.message?.index;
    const originalHost = Number.isSafeInteger(index) && index >= 0 ? records[index + 1] : null;
    const host = agentContext || trigger === 'continue' ? originalHost : null;
    const existing = host ? getActiveCompanionResults(host) : {};
    if (!selected.length && !Object.keys(existing).length) return null;
    const maxBytes = agentContext ? MAX_MANUAL_RESULT_BYTES : MAX_COMPANION_RESULT_BYTES;
    const baselineBytes = Buffer.byteLength(JSON.stringify(existing));
    let requiredBytes = baselineBytes + 8192;
    for (const agent of selected) {
        const metadata = { id: agent.id, name: agent.name, icon: agent.icon, profileLabel: agent.profileLabel,
            modelOverride: agent.modelOverride, format: agent.companion.format, displayMode: agent.companion.displayMode };
        const metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
        const coverageBytes = getAgentTemplateId(agent) === MEMORY_SHARD_TEMPLATE_ID ? records.length * 256 : 0;
        requiredBytes += MAX_NOTE_CODE_UNITS * 6 + metadataBytes * 2 + coverageBytes + 4096;
    }
    if (requiredBytes > maxBytes) throw roleplayError('ROLEPLAY_COMPANION_CAPACITY',
        'The selected Companions cannot fit their saved results within this account workflow.', 507);
    return { version: 1, maxBytes, requiredBytes, baselineBytes, companionCount: selected.length };
}
