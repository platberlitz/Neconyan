/**
 * Random model rotation between saved Connection Manager profiles.
 *
 * Before every reply the module applies one profile from the ticked pool, so
 * each generation and swipe can come from a different backend. Applying reuses
 * the Connection Manager '/profile' slash command, which switches the API
 * source, key and model exactly like picking the profile by hand.
 */
import { extension_settings } from './extensions.js';
import { eventSource, event_types } from './events.js';
import { online_status, saveSettingsDebounced } from '../script.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { t } from './i18n.js';

export const MODEL_ROTATION_SETTINGS_KEY = 'neconyanModelRotation';

/**
 * @typedef {{ id: string, name: string, model?: string }} RotationProfile
 */

export function getModelRotationSettings() {
    const existing = extension_settings[MODEL_ROTATION_SETTINGS_KEY];
    const store = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : { enabled: false, profileIds: [], lastProfileId: '' };
    extension_settings[MODEL_ROTATION_SETTINGS_KEY] = store;

    if (typeof store.enabled !== 'boolean') store.enabled = false;
    if (!Array.isArray(store.profileIds)) store.profileIds = [];
    if (typeof store.lastProfileId !== 'string') store.lastProfileId = '';

    return store;
}

function getRotatableProfiles() {
    const profiles = extension_settings.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.filter(profile => profile?.id && profile?.name);
}

/**
 * Picks the next profile from the ticked pool. The previous profile is skipped
 * while any other ticked profile remains, so the same model never fires twice
 * in a row.
 *
 * @param {RotationProfile[]} profiles
 * @param {string[]} profileIds
 * @param {string} lastProfileId
 * @param {() => number} [random]
 * @returns {RotationProfile | null}
 */
export function pickNextRotationProfile(profiles, profileIds, lastProfileId, random = Math.random) {
    const selected = new Set(profileIds ?? []);
    const pool = (profiles ?? []).filter(profile => profile && selected.has(profile.id));
    if (!pool.length) return null;

    const candidates = pool.length > 1
        ? pool.filter(profile => profile.id !== lastProfileId)
        : pool;
    const usable = candidates.length ? candidates : pool;
    const index = Math.min(usable.length - 1, Math.max(0, Math.floor(random() * usable.length)));
    return usable[index];
}

/**
 * @param {{ enabled?: boolean }} settings
 * @param {string} type
 * @param {{ isAuxiliaryGeneration?: boolean }} [options]
 * @param {boolean} [dryRun]
 * @returns {boolean}
 */
export function shouldRotateForGeneration(settings, type, options, dryRun) {
    if (!settings?.enabled) return false;
    if (dryRun) return false;
    if (type === 'quiet') return false;
    if (options?.isAuxiliaryGeneration) return false;
    return true;
}

async function applyRotationProfile(profile) {
    const command = SlashCommandParser.commands?.profile;
    if (!command?.callback) return false;
    await command.callback({ await: 'true', timeout: '0' }, profile.name);
    return true;
}

/**
 * The applied profile can rotate the active secret, which forces a reconnect
 * and flips online_status to no_connection. Generate checks that flag right
 * after this listener, so wait out the reconnect instead of letting the reply
 * bail. Cross-backend switches already wait inside the /api command.
 *
 * @param {number} timeoutMs
 */
async function waitForConnection(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (online_status === 'no_connection' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function onGenerationAfterCommands(type, options, dryRun) {
    try {
        const settings = getModelRotationSettings();
        if (!shouldRotateForGeneration(settings, type, options, dryRun)) return;

        const profiles = getRotatableProfiles();
        const picked = pickNextRotationProfile(profiles, settings.profileIds, settings.lastProfileId);
        if (!picked) return;

        settings.lastProfileId = picked.id;
        saveSettingsDebounced();

        if (picked.id === extension_settings.connectionManager?.selectedProfile) return;

        if (await applyRotationProfile(picked)) {
            await waitForConnection(5000);
        }
    } catch (error) {
        console.error('Neconyan model rotation failed', error);
    }
}

function renderModelRotationPanel(panel, profiles) {
    panel.replaceChildren();
    panel.append(element('summary', '', t`Random model rotation`));

    const settings = getModelRotationSettings();
    const toggle = document.createElement('label');
    toggle.className = 'neconyan-model-rotation-toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = settings.enabled;
    toggleInput.addEventListener('change', () => {
        getModelRotationSettings().enabled = toggleInput.checked;
        saveSettingsDebounced();
    });
    toggle.append(toggleInput, document.createTextNode(t`Rotate models on every reply and swipe`));
    panel.append(toggle);

    const list = document.createElement('div');
    list.className = 'neconyan-model-rotation-list';
    const validIds = new Set(profiles.map(profile => profile.id));
    const selectedIds = new Set(settings.profileIds.filter(id => validIds.has(id)));
    settings.profileIds = [...selectedIds];

    for (const profile of profiles) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selectedIds.has(profile.id);
        input.addEventListener('change', () => {
            const ids = new Set(getModelRotationSettings().profileIds);
            if (input.checked) ids.add(profile.id);
            else ids.delete(profile.id);
            getModelRotationSettings().profileIds = [...ids];
            saveSettingsDebounced();
        });
        const model = String(profile.model ?? '').trim();
        label.append(input, document.createTextNode(model ? `${profile.name} (${model})` : profile.name));
        list.append(label);
    }

    if (!profiles.length) {
        list.append(element('small', '', t`No saved connection profiles yet.`));
    }

    panel.append(list);
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * Keeps the rotation panel inside the 'Saved connections' card. Safe to call on
 * every workspace pass: it rebuilds only when the profile list changed.
 *
 * @param {HTMLElement} host
 */
export function mountModelRotationPanel(host) {
    if (!(host instanceof HTMLElement)) return;

    const profiles = getRotatableProfiles();
    const signature = profiles.map(profile => `${profile.id}:${profile.name}:${profile.model ?? ''}`).join('|');
    let panel = host.querySelector(':scope > .neconyan-model-rotation');
    if (panel && panel.dataset.signature === signature) return;

    if (!panel) {
        panel = element('details', 'neconyan-model-rotation');
        host.append(panel);
    }
    panel.dataset.signature = signature;
    renderModelRotationPanel(panel, profiles);
}

let rotationListenerBound = false;

export function initModelRotation() {
    if (rotationListenerBound) return;
    rotationListenerBound = true;
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
}
