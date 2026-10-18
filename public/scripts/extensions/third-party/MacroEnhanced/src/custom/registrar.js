import { MODULE_NAME } from '../settings.js';
import { safeRegister, safeUnregister } from '../registration.js';
import { notifyMacroDataChanged } from '../data-events.js';
import { CATEGORY_CUSTOM, compileDef } from './compile.js';
import { getEffectiveDefs } from './store.js';

/** @type {Map<string, string>} registered custom macro name (lower) -> fingerprint */
const registered = new Map();

function fingerprint(def, scope) {
    return JSON.stringify([scope, def.id, def.name, def.description, def.template, def.args]);
}

/**
 * Brings the engine registry in line with the stored definitions. Called on init,
 * after every editor save, and on CHAT_CHANGED (character defs follow the chat).
 */
export function syncRegistrations() {
    const ctx = SillyTavern.getContext();
    const engine = ctx.macros?.engine;
    if (!engine) {
        return;
    }

    let changed = false;
    const desired = new Map();
    for (const { def, scope } of getEffectiveDefs()) {
        desired.set(def.name.toLowerCase(), { def, scope });
    }

    for (const [nameKey] of [...registered]) {
        const want = desired.get(nameKey);
        if (!want || fingerprint(want.def, want.scope) !== registered.get(nameKey)) {
            safeUnregister(nameKey);
            registered.delete(nameKey);
            changed = true;
        }
    }

    for (const [nameKey, { def, scope }] of desired) {
        if (registered.has(nameKey)) {
            continue;
        }
        // Backstop for defs saved before validation refused built-in names: never
        // let a custom macro overwrite one of our own non-custom registrations.
        const existing = ctx.macros?.registry?.getMacro?.(def.name);
        if (existing
            && String(existing.source?.name ?? '').toLowerCase() === MODULE_NAME.toLowerCase()
            && existing.category !== CATEGORY_CUSTOM) {
            console.warn(`[Macro Enhanced] Custom macro "{{${def.name}}}" collides with a built-in Macro Enhanced macro and was not registered. Rename it on the My macros tab.`);
            continue;
        }
        const actualName = safeRegister(def.name, compileDef(def, { engine }));
        if (actualName) {
            registered.set(nameKey, fingerprint(def, scope));
            changed = true;
        }
    }

    // Writers notify before they call us. Announce again after the registry and
    // catalogue are in step, so the Reference rebuilds from the new macros.
    if (changed) {
        notifyMacroDataChanged('macros');
    }
}

export function teardownCustomRegistrations() {
    for (const nameKey of registered.keys()) {
        safeUnregister(nameKey);
    }
    registered.clear();
}

/** Currently live custom macro names (for the drawer and /me-macros). */
export function getRegisteredCustomNames() {
    return [...registered.keys()];
}
