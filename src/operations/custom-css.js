import path from 'node:path';
import { authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked } from '../authoring-store.js';
import { runChatProfile } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash, roleplayLease } from '../roleplay-store.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { captureLabConnection, readLabSettings } from '../labs/sources.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';
import { CUSTOM_CSS_AI_MAX_TOKENS, buildCustomCssAIMessages, normalizeGeneratedCustomCss }
    from '../../public/scripts/neconyan-custom-css-core.js';

const SETTINGS_LIMIT = 16 * 1024 * 1024;
const TEXT_LIMIT = 64 * 1024;

function boundedText(value, name, { required = false } = {}) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (required && !text) throw operationError(`Describe the ${name} first.`, 400);
    if (Buffer.byteLength(text) > TEXT_LIMIT) throw operationError(`The ${name} is too long.`, 413);
    return text;
}

function cssMacros(saved) {
    return { names: { user: String(saved.name1 || 'User'), char: '' }, variables: {}, extra: { chat: [], chatMetadata: {} } };
}

export async function captureCustomCss(base, account, input = {}) {
    const instruction = boundedText(input.instruction, 'CSS change', { required: true });
    const paletteSnapshot = boundedText(input.paletteSnapshot, 'theme snapshot');
    const mode = input.mode === 'append' ? 'append' : 'replace';
    const saved = readLabSettings(base);
    const currentCss = String(saved.power_user?.custom_css ?? '');
    const macros = cssMacros(saved);
    const { binding } = await captureLabConnection(base, { profileId: typeof input.profileId === 'string' ? input.profileId : '',
        acknowledgement: input.acknowledgement, maxTokens: CUSTOM_CSS_AI_MAX_TOKENS }, macros);
    return { account, binding, mode, currentCss, macros,
        messages: buildCustomCssAIMessages({ instruction, currentCss, paletteSnapshot, mode }) };
}

function nextCss(plan, css) {
    return plan.mode === 'append' && plan.currentCss.trim() ? `${plan.currentCss.trimEnd()}\n\n${css}` : css;
}

/** Save the generated CSS only while the saved custom CSS still matches what was sent to the model. */
export function publishCustomCss(context, plan, css, { afterCustomCssPublication } = {}) {
    return withOperation(context, ({ lease, value, save }) => {
        if (value.effects.settings?.state === 'done') return value.cssResult;
        const filename = path.join(roleplayLease(lease).scope.directories.root, 'settings.json');
        const current = readAuthoringFileLocked(lease, filename, SETTINGS_LIMIT);
        if (!current) throw operationError('Save the account settings before generating custom CSS.');
        const evidence = roleplayHash(authoringEvidence(current));
        let staged = value.effects.settings?.staged;
        if (!staged || (evidence !== roleplayHash(staged.before) && evidence !== roleplayHash(staged.after))) {
            let settings;
            try { settings = JSON.parse(current.bytes.toString('utf8')); } catch { throw operationError('The saved account settings are unreadable.'); }
            const saved = String(settings?.power_user?.custom_css ?? '');
            if (staged && saved === value.cssResult.customCss) {
                value.effects.settings.state = 'done'; save();
                return value.cssResult;
            }
            if (saved !== plan.currentCss) {
                // Keep the paid result without overwriting newer CSS.
                value.cssResult = { css, applied: false, customCss: saved };
                if (staged) { value.effects.settings.state = 'done'; save(); }
                return value.cssResult;
            }
            context.signal.throwIfAborted();
            const customCss = nextCss(plan, css);
            const prepared = prepareSettingsSave({ ...settings, power_user: { ...settings.power_user, custom_css: customCss },
                _version: getSettingsVersion(settings) }, settings);
            if (!prepared.ok) throw operationError('The saved settings changed. Try again.');
            staged = stageAuthoringFileLocked(lease, filename, JSON.stringify(prepared.settings, null, 4),
                { expected: authoringEvidence(current), limit: SETTINGS_LIMIT });
            value.effects.settings = { state: 'prepared', staged };
            value.cssResult = { css, applied: true, customCss, previousVersion: getSettingsVersion(settings),
                version: prepared.version, settingsRevision: prepared.settingsRevision };
            save();
        }
        publishAuthoringFileLocked(lease, staged);
        afterCustomCssPublication?.(staged);
        value.effects.settings.state = 'done'; save();
        return value.cssResult;
    });
}

export async function runCustomCss(context, plan, { generate = runChatProfile, ...dependencies } = {}) {
    let css = readArtifact(context.directories, context.job.id, 'custom-css');
    if (css === undefined) {
        const response = await generate({ context: { directories: context.directories, owner: context.owner }, jobContext: context,
            binding: plan.binding, messages: plan.messages, maxTokens: CUSTOM_CSS_AI_MAX_TOKENS,
            macroEnvironment: createMacroEnvironment(plan.macros), userName: plan.macros.names.user, characterName: '',
            signal: context.signal, stepNamespace: 'custom-css', beforeDispatch: () => withOperation(context, () => {}) });
        css = normalizeGeneratedCustomCss(typeof response === 'string' ? response : response?.text);
        if (!css) throw Object.assign(operationError('The model returned an empty CSS response.', 422), { operationRefused: true });
        writeArtifact(context.directories, context.job.id, 'custom-css', css);
    }
    return publishCustomCss(context, plan, css, dependencies);
}

registerOperation('custom-css', {
    label: 'Generate custom CSS',
    target: () => ({ kind: 'settings', id: 'custom-css' }),
    canRecover: value => Boolean(value.effects.settings),
    capture: captureCustomCss,
    run: runCustomCss,
});
