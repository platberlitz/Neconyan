import { NotebookError } from './paths.js';

/*
 * Notebook policy evaluation. Policies live in Neconyan-owned control data
 * (notebook-control/<id>/policies.json), never in note frontmatter, so an
 * imported or externally edited file cannot grant itself access.
 *
 * Three separate concerns:
 *   assistant        none | read | edit   (manual assistant help)
 *   context          off | reference | pinned, with scopes (automatic use)
 *   assistantPublish false | true          (World Info publication)
 */

export const ASSISTANT_LEVELS = Object.freeze(['none', 'read', 'edit']);
export const CONTEXT_MODES = Object.freeze(['off', 'reference', 'pinned']);
export const SCOPE_KINDS = Object.freeze(['chat', 'character', 'lorebook', 'global']);
export const REQUESTED_EDIT_OPERATIONS = Object.freeze(['create', 'append', 'edit']);
export const REQUESTED_EDIT_MAX_MS = 24 * 60 * 60 * 1000;
const RANK = { none: 0, read: 1, edit: 2 };

export function effectiveAssistantAccess(policies, noteId = null) {
    if (!policies || policies.admitted === false) return 'none';
    const base = ASSISTANT_LEVELS.includes(policies.assistant) ? policies.assistant : 'none';
    if (!noteId) return base;
    const override = policies.notes?.[noteId]?.assistant;
    if (ASSISTANT_LEVELS.includes(override)) return override;
    return base;
}

export function assistantCan(policies, noteId, level) {
    return RANK[effectiveAssistantAccess(policies, noteId)] >= RANK[level];
}

export function assistantCanCreate(policies) {
    return assistantCan(policies, null, 'edit');
}

export function assistantCanPublish(policies, noteId) {
    return policies?.admitted !== false && policies?.assistantPublish === true && assistantCan(policies, noteId, 'read');
}

/** Requested-edit mode lets a user-originated assistant edit skip the review step. */
export function requestedEditAllows(policies, operation, at = Date.now()) {
    const grant = policies?.requestedEdits;
    if (!grant || policies.admitted === false) return false;
    if (!REQUESTED_EDIT_OPERATIONS.includes(operation)) return false;
    if (!Array.isArray(grant.operations) || !grant.operations.includes(operation)) return false;
    const expires = Date.parse(grant.expiresAt);
    return Number.isFinite(expires) && expires > at;
}

export function contextPolicy(policies, noteId) {
    if (!policies || policies.admitted === false) return { mode: 'off', scopes: [] };
    const value = policies.notes?.[noteId]?.context;
    if (!value || !CONTEXT_MODES.includes(value.mode)) return { mode: 'off', scopes: [] };
    return { mode: value.mode, scopes: Array.isArray(value.scopes) ? value.scopes : [] };
}

/** A scope matches only if the generation names the same chat, character or lorebook. */
export function scopeMatches(scopes, active) {
    for (const scope of scopes ?? []) {
        if (scope.kind === 'global') return true;
        if (scope.kind === 'chat' && active.chat && scope.id === active.chat) return true;
        if (scope.kind === 'character' && active.character && scope.id === active.character) return true;
        if (scope.kind === 'lorebook' && Array.isArray(active.lorebooks) && active.lorebooks.includes(scope.id)) return true;
    }
    return false;
}

function requireChoice(value, list, label) {
    if (!list.includes(value)) throw new NotebookError('NOTEBOOK_POLICY_INVALID', `${label} must be one of ${list.join(', ')}.`, 400);
    return value;
}

function cleanScopes(value) {
    if (!Array.isArray(value) || value.length > 32) throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'Choose up to 32 scopes.', 400);
    const seen = new Set();
    const scopes = [];
    for (const scope of value) {
        if (!scope || typeof scope !== 'object') throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'A scope is malformed.', 400);
        const kind = requireChoice(scope.kind, SCOPE_KINDS, 'Scope kind');
        const id = kind === 'global' ? '' : String(scope.id ?? '');
        if (kind !== 'global' && (!id || id.length > 512)) throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'A scope needs an identifier.', 400);
        const label = typeof scope.label === 'string' ? scope.label.slice(0, 200) : '';
        const key = `${kind}\u0000${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scopes.push({ kind, id, ...(label ? { label } : {}) });
    }
    return scopes;
}

/**
 * Applies an owner-originated policy patch. Only the owner's trusted UI calls
 * this through the policy endpoint; assistant tools never reach it.
 */
export function applyPolicyPatch(policies, patch, { noteExists = () => true, at = Date.now() } = {}) {
    const next = structuredClone(policies);
    next.notes ||= {};
    if (!patch || typeof patch !== 'object') throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'Nothing to change.', 400);
    if (patch.assistant !== undefined) next.assistant = requireChoice(patch.assistant, ASSISTANT_LEVELS, 'Assistant access');
    if (patch.assistantPublish !== undefined) next.assistantPublish = patch.assistantPublish === true;
    if (patch.admitted !== undefined) next.admitted = patch.admitted === true;
    if (patch.requestedEdits !== undefined) {
        if (patch.requestedEdits === null || patch.requestedEdits === false) {
            next.requestedEdits = null;
        } else {
            const operations = Array.isArray(patch.requestedEdits.operations) ? patch.requestedEdits.operations : REQUESTED_EDIT_OPERATIONS;
            for (const operation of operations) requireChoice(operation, REQUESTED_EDIT_OPERATIONS, 'Requested edit');
            const hours = Number(patch.requestedEdits.hours ?? 8);
            if (!Number.isFinite(hours) || hours <= 0) throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'Choose how long the permission lasts.', 400);
            const duration = Math.min(hours * 60 * 60 * 1000, REQUESTED_EDIT_MAX_MS);
            next.requestedEdits = {
                operations: [...new Set(operations)],
                enabledAt: new Date(at).toISOString(),
                expiresAt: new Date(at + duration).toISOString(),
            };
        }
    }
    if (patch.notes !== undefined) {
        if (!patch.notes || typeof patch.notes !== 'object') throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'Note policies are malformed.', 400);
        for (const [noteId, notePatch] of Object.entries(patch.notes)) {
            if (!noteExists(noteId)) throw new NotebookError('NOTE_NOT_FOUND', 'That note could not be found.', 404);
            const current = { ...(next.notes[noteId] ?? {}) };
            if (notePatch === null) {
                delete next.notes[noteId];
                continue;
            }
            if (notePatch.assistant !== undefined) {
                if (notePatch.assistant === 'inherit' || notePatch.assistant === null) delete current.assistant;
                else current.assistant = requireChoice(notePatch.assistant, ASSISTANT_LEVELS, 'Assistant access');
            }
            if (notePatch.context !== undefined) {
                if (notePatch.context === null) {
                    delete current.context;
                } else {
                    const mode = requireChoice(notePatch.context.mode, CONTEXT_MODES, 'Context use');
                    const scopes = mode === 'off' ? [] : cleanScopes(notePatch.context.scopes ?? []);
                    if (mode !== 'off' && scopes.length === 0) {
                        throw new NotebookError('NOTEBOOK_POLICY_INVALID', 'Choose at least one chat, character or lorebook for this note.', 400);
                    }
                    current.context = mode === 'off' ? undefined : { mode, scopes, order: Number.isInteger(notePatch.context.order) ? notePatch.context.order : 0 };
                    if (!current.context) delete current.context;
                }
            }
            if (Object.keys(current).length) next.notes[noteId] = current;
            else delete next.notes[noteId];
        }
    }
    return next;
}

/** Policies a fresh import starts with: nothing shared, nothing published, not yet admitted. */
export function importedPolicies(base) {
    return { ...base, assistant: 'none', assistantPublish: false, requestedEdits: null, admitted: false, notes: {} };
}

export function publicPolicy(policies, at = Date.now()) {
    const requested = policies.requestedEdits && Date.parse(policies.requestedEdits.expiresAt) > at ? policies.requestedEdits : null;
    return {
        revision: policies.revision,
        assistant: effectiveAssistantAccess(policies),
        configuredAssistant: policies.assistant,
        assistantPublish: policies.assistantPublish === true,
        admitted: policies.admitted !== false,
        requestedEdits: requested,
        notes: policies.notes ?? {},
    };
}
