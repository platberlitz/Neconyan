import { addPromptModule, isReservedPrompt } from './presets.js';
import { newId, normalizePromptDraft } from './schema.js';

/**
 * Operations on prompt drafts: the titled prompts kept in the Prompts space.
 * A prompt draft holds several versions of the same prompt text; one version
 * is selected, and that is the text that travels to presets and comparisons.
 * Everything here is pure data work so it runs under plain Node for the tests.
 */

export function getSelectedVersion(draft) {
    const normalized = normalizePromptDraft(draft);
    return normalized.versions.find(version => version.id === normalized.selectedVersionId)
        ?? normalized.versions[0]
        ?? null;
}

export function selectVersion(draft, versionId) {
    const normalized = normalizePromptDraft(draft);
    if (!normalized.versions.some(version => version.id === versionId)) {
        return normalized;
    }
    return { ...normalized, selectedVersionId: versionId };
}

/** Adds a new version and selects it. Content defaults to the selected text. */
export function addVersion(draft, { label = '', content = null } = {}) {
    const normalized = normalizePromptDraft(draft);
    const now = new Date().toISOString();
    const version = {
        id: newId(),
        label: label ? uniqueLabel(normalized, label) : nextVersionLabel(normalized),
        content: typeof content === 'string' ? content : (getSelectedVersion(normalized)?.content ?? ''),
        createdAt: now,
        updatedAt: now,
    };
    return {
        ...normalized,
        versions: [...normalized.versions, version],
        selectedVersionId: version.id,
    };
}

/**
 * Labels have to stay distinct or the draft cannot be saved, so a requested
 * label that is already taken gets a counter instead of blocking the save.
 */
function uniqueLabel(draft, wanted) {
    const taken = new Set(draft.versions.map(version => version.label.trim().toLowerCase()));
    let label = wanted;
    let counter = 2;
    while (taken.has(label.trim().toLowerCase())) {
        label = `${wanted} ${counter}`;
        counter += 1;
    }
    return label;
}

export function updateVersion(draft, versionId, changes) {
    const normalized = normalizePromptDraft(draft);
    return {
        ...normalized,
        versions: normalized.versions.map(version => (
            version.id === versionId
                ? { ...version, ...changes, id: version.id, updatedAt: new Date().toISOString() }
                : version
        )),
    };
}

/** The last version cannot be removed: a prompt always has one draft. */
export function removeVersion(draft, versionId) {
    const normalized = normalizePromptDraft(draft);
    if (normalized.versions.length <= 1) {
        return normalized;
    }
    const versions = normalized.versions.filter(version => version.id !== versionId);
    if (versions.length === normalized.versions.length) {
        return normalized;
    }
    return {
        ...normalized,
        versions,
        selectedVersionId: versions.some(version => version.id === normalized.selectedVersionId)
            ? normalized.selectedVersionId
            : versions[0].id,
    };
}

function nextVersionLabel(draft) {
    const taken = new Set(draft.versions.map(version => version.label.trim().toLowerCase()));
    let count = draft.versions.length + 1;
    while (taken.has(`draft ${count}`)) {
        count += 1;
    }
    return `Draft ${count}`;
}

/* ----------------------------------------------- prompts <-> preset modules */

/**
 * Builds the prompt-module object a Chat Completion preset stores, from a
 * prompt draft's version. A fresh identifier is always minted so sending the
 * same prompt twice can never collide.
 */
export function draftToModule(draft, version = null) {
    const normalized = normalizePromptDraft(draft);
    const chosen = version ?? getSelectedVersion(normalized);
    return {
        identifier: newId(),
        name: normalized.title,
        role: normalized.role,
        content: chosen?.content ?? '',
        system_prompt: false,
        injection_position: 0,
        injection_depth: 4,
        forbid_overrides: false,
    };
}

/** Starts a prompt draft from a preset's prompt module. */
export function moduleToDraft(prompt, { sourceName = '' } = {}) {
    const now = new Date().toISOString();
    return normalizePromptDraft({
        id: newId(),
        title: String(prompt?.name || prompt?.identifier || 'Untitled prompt'),
        notes: sourceName ? `Saved from "${sourceName}".` : '',
        role: prompt?.role,
        versions: [{
            id: newId(),
            label: 'Draft 1',
            content: typeof prompt?.content === 'string' ? prompt.content : '',
            createdAt: now,
            updatedAt: now,
        }],
        createdAt: now,
        updatedAt: now,
    });
}

/**
 * Pastes a copied prompt module into a Chat Completion preset payload.
 *
 * Ordinary modules get a fresh identifier so the same module can be pasted
 * into any preset, including the one it came from. Modules Neconyan fills
 * in itself keep their identifier, because that identifier is their meaning;
 * pasting one into a preset that already has it is refused instead of
 * silently making a duplicate.
 *
 * @returns {{payload: object, problem: string|null}}
 */
export function pastePromptModule(payload, prompt) {
    if (!prompt || typeof prompt !== 'object') {
        return { payload, problem: 'There is no copied prompt to paste.' };
    }
    if (isReservedPrompt(prompt)) {
        const exists = (Array.isArray(payload?.prompts) ? payload.prompts : [])
            .some(item => item?.identifier === prompt.identifier);
        if (exists) {
            return {
                payload,
                problem: `This preset already has "${prompt.name || prompt.identifier}", which Neconyan fills in itself, so it was not pasted again.`,
            };
        }
        return { payload: addPromptModule(payload, structuredClone(prompt)), problem: null };
    }
    const copy = { ...structuredClone(prompt), identifier: newId() };
    return { payload: addPromptModule(payload, copy), problem: null };
}
