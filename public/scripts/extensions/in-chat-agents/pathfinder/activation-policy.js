// Neconyan: keyword-activation policy for Pawthfinder. When the user opts in,
// entries in books Pawthfinder can read no longer activate through World Info
// keyword matching; constant, sticky and decorated entries keep their native
// behaviour, and keyword activation falls back whenever the response's own
// retrieval did not succeed. The runner records the retrieval outcome per
// response via setPathfinderRetrievalState(); everything else is re-checked
// against live settings on every call.

import { setKeywordActivationPolicy } from '../../../world-info-policy.js';
import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getSettings } from './tree-store.js';
import { getReadableBooks } from './pathfinder-tool-bridge.js';

let retrievalState = null;

export function setPathfinderRetrievalState(state) {
    retrievalState = state && state.retrievalSucceeded === true ? state : null;
}

export function shouldSuppressWorldInfoKeywords(entry) {
    if (!retrievalState) return false;
    if (!isPathfinderSubmoduleEnabled()) return false;
    const s = getSettings();
    if (s.suppressKeywordActivation !== true) return false;
    if (!(s.sidecarEnabled || s.pipelineEnabled)) return false;
    const world = entry?.world;
    return Boolean(world) && getReadableBooks().includes(world);
}

export function installPathfinderKeywordPolicy() {
    setKeywordActivationPolicy(shouldSuppressWorldInfoKeywords);
}

export function uninstallPathfinderKeywordPolicy() {
    setKeywordActivationPolicy(null);
    retrievalState = null;
}
