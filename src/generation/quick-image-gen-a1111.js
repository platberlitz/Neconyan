import { randomInt } from 'node:crypto';
import { buildA1111ADetailerUnit, parseFiniteFloat as decimal, parseFiniteInt as integer } from '../../public/scripts/extensions/quick-image-gen/lib/a1111-runtime.js';
import { readResponseText, MAX_PROVIDER_RESPONSE_BYTES } from '../../public/scripts/extensions/quick-image-gen/lib/security.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayError, roleplayHash } from '../roleplay-store.js';
import { prepareQuickImageReference } from './quick-image-gen-reference.js';

const SAMPLERS = { euler_a: 'Euler a', euler: 'Euler', 'dpm++_2m': 'DPM++ 2M', 'dpm++_sde': 'DPM++ SDE',
    'dpm++_2m_sde': 'DPM++ 2M SDE', 'dpm++_3m_sde': 'DPM++ 3M SDE', 'dpm++_2s_ancestral': 'DPM++ 2S a',
    dpm_2: 'DPM2', dpm_2_ancestral: 'DPM2 a', dpm_fast: 'DPM fast', dpm_adaptive: 'DPM adaptive', ddim: 'DDIM',
    ddpm: 'DDPM', lms: 'LMS', heun: 'Heun', heunpp2: 'Heun++ 2', plms: 'PLMS', uni_pc: 'UniPC',
    uni_pc_bh2: 'UniPC BH2', lcm: 'LCM', deis: 'DEIS', restart: 'Restart', er_sde: 'ER SDE' };
const invalid = (message, code = 'QIG_INVALID_A1111') => roleplayError(code, message, 409);

export function a1111BaseUrl(settings) {
    let url;
    try { url = new URL(settings.localUrl); } catch { throw invalid('The saved A1111 URL is invalid.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw invalid('The saved A1111 URL must be an explicit HTTP address without credentials or a query.');
    }
    return url.href.replace(/\/+$/, '');
}

/** A1111, Forge and their extensions consume the same saved controls as the bundled browser caller. */
export function buildA1111ImageRequest(s, input, { reference = '', controlReference = '', scriptKey = 'ControlNet', subseed = -1 } = {}) {
    const base = a1111BaseUrl(s);
    const img2img = Boolean((s.localType ?? 'a1111') === 'a1111' && s.localRefImage && !s.a1111IpAdapter);
    const payload = { prompt: input.prompt, negative_prompt: input.negative,
        width: integer(s.width, 512, 256, 2048), height: integer(s.height, 512, 256, 2048),
        steps: integer(s.steps, 25, 1, 150), cfg_scale: decimal(s.cfgScale, 7, 1, 30),
        sampler_name: SAMPLERS[s.sampler] || s.sampler || 'Euler a', scheduler: s.a1111Scheduler || 'Automatic', seed: input.seed };
    if (s.a1111Model) {
        payload.override_settings = { sd_model_checkpoint: s.a1111Model };
        payload.override_settings_restore_afterwards = true;
    }
    if (s.a1111RestoreFaces) payload.restore_faces = true;
    if (s.a1111Tiling) payload.tiling = true;
    const strength = decimal(s.a1111SubseedStrength, 0, 0, 1);
    if (strength > 0) Object.assign(payload, { subseed, subseed_strength: strength });
    if (s.a1111Loras) {
        if (typeof s.a1111Loras !== 'string') throw invalid('The saved A1111 LoRA list is invalid.');
        const tags = s.a1111Loras.split(',').map(value => value.trim()).filter(Boolean).map(value => {
            const colon = value.lastIndexOf(':');
            const weighted = colon > 0 && Number.isFinite(parseFloat(value.slice(colon + 1)));
            const name = (weighted ? value.slice(0, colon) : value).trim();
            return name ? `<lora:${name}:${weighted ? parseFloat(value.slice(colon + 1)) : 0.8}>` : '';
        }).filter(Boolean).join(' ');
        if (tags) payload.prompt += ` ${tags}`;
    }
    const clip = integer(s.a1111ClipSkip, 1, 1, 12);
    if (clip > 1) (payload.override_settings ??= {}).CLIP_stop_at_last_layers = clip;
    if (s.a1111Vae) (payload.override_settings ??= {}).sd_vae = s.a1111Vae;
    if (s.a1111HiresFix && !img2img) {
        Object.assign(payload, { enable_hr: true, hr_upscaler: s.a1111HiresUpscaler || 'Latent',
            hr_scale: decimal(s.a1111HiresScale, 2, 1, 4), hr_second_pass_steps: integer(s.a1111HiresSteps, 0, 0, 150),
            denoising_strength: decimal(s.a1111HiresDenoise, 0.55, 0, 1) });
        for (const [field, key] of Object.entries({ a1111HiresSampler: 'hr_sampler_name', a1111HiresScheduler: 'hr_scheduler',
            a1111HiresPrompt: 'hr_prompt', a1111HiresNegative: 'hr_negative_prompt' })) if (s[field]) payload[key] = s[field];
        if (integer(s.a1111HiresResizeX, 0, 0, 4096) > 0) payload.hr_resize_x = integer(s.a1111HiresResizeX, 0, 0, 4096);
        if (integer(s.a1111HiresResizeY, 0, 0, 4096) > 0) payload.hr_resize_y = integer(s.a1111HiresResizeY, 0, 0, 4096);
    }
    if (s.a1111Adetailer) {
        const detail = (prefix, model) => buildA1111ADetailerUnit({ model: s[`${prefix}Model`] || model,
            prompt: s[`${prefix}Prompt`], negativePrompt: s[`${prefix}Negative`], denoise: s[`${prefix}Denoise`],
            confidence: s[`${prefix}Confidence`], maskBlur: s[`${prefix}MaskBlur`], dilateErode: s[`${prefix}DilateErode`],
            inpaintOnlyMasked: s[`${prefix}InpaintOnlyMasked`], inpaintPadding: s[`${prefix}InpaintPadding`] });
        const args = [true, detail('a1111Adetailer', 'face_yolov8n.pt')];
        if (s.a1111Adetailer2) args.push(detail('a1111Adetailer2', 'hand_yolov8n.pt'));
        (payload.alwayson_scripts ??= {}).ADetailer = { args };
    }
    if (s.a1111SaveToWebUI) payload.save_images = true;
    if (img2img) {
        payload.init_images = [reference];
        payload.denoising_strength = decimal(s.localDenoise, 0.75, 0, 1);
    }
    const units = [];
    if (s.a1111IpAdapter && s.localRefImage) {
        const model = s.a1111IpAdapterMode || 'ip-adapter-faceid-portrait_sd15';
        units.push({ enabled: true, module: model.toLowerCase().includes('plus') ? 'ip-adapter_face_id_plus' : 'ip-adapter_face_id',
            model, weight: decimal(s.a1111IpAdapterWeight, 0.7, 0, 1.5), image: reference, input_image: reference,
            resize_mode: s.a1111IpAdapterResizeMode || 'Crop and Resize', control_mode: s.a1111IpAdapterControlMode || 'Balanced',
            pixel_perfect: s.a1111IpAdapterPixelPerfect ?? true, guidance_start: decimal(s.a1111IpAdapterStartStep, 0, 0, 1),
            guidance_end: decimal(s.a1111IpAdapterEndStep, 1, 0, 1) });
    }
    if (s.a1111ControlNet && s.a1111ControlNetModel) {
        units.push({ enabled: true, module: s.a1111ControlNetModule || 'none', model: s.a1111ControlNetModel,
            weight: decimal(s.a1111ControlNetWeight, 1, 0, 2), resize_mode: s.a1111ControlNetResizeMode || 'Crop and Resize',
            control_mode: s.a1111ControlNetControlMode || 'Balanced', pixel_perfect: s.a1111ControlNetPixelPerfect ?? true,
            guidance_start: decimal(s.a1111ControlNetGuidanceStart, 0, 0, 1), guidance_end: decimal(s.a1111ControlNetGuidanceEnd, 1, 0, 1),
            ...(controlReference ? { image: controlReference, input_image: controlReference } : {}) });
    }
    if (units.length) (payload.alwayson_scripts ??= {})[scriptKey] = { args: units };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PROVIDER_RESPONSE_BYTES * 2) throw invalid('The saved A1111 request is too large.');
    return { url: `${base}/sdapi/v1/${img2img ? 'img2img' : 'txt2img'}`, body };
}

/** Bind references, extension selection and variation seed before the single mutating image request. */
export async function prepareA1111ImageRequest(context, { effectId, input, settings, fingerprint, withAccount, readSettingsLocked, fetchImpl }) {
    const name = `input:quick-image:${effectId}:a1111`;
    const identity = roleplayHash({ input, fingerprint });
    let saved = withAccount(() => readArtifact(context.directories, context.job.id, name));
    if (saved !== undefined && (saved?.identity !== identity || saved.hash !== roleplayHash({ identity,
        subseed: saved.subseed, scriptKey: saved.scriptKey }))) throw invalid('The saved A1111 controls need recovery.', 'QIG_RESULT_RECOVERY');
    const reference = async (source, key) => source ? (await prepareQuickImageReference(context, {
        name: `${name}:${key}`, source, fingerprint, withAccount, readSettingsLocked, fetchImpl,
    })).bytes.toString('base64') : '';
    const local = await reference(settings.localRefImage, 'reference');
    const control = settings.a1111ControlNet && settings.a1111ControlNetModel
        ? await reference(settings.a1111ControlNetImage, 'controlnet') : '';
    if (saved === undefined) {
        let scriptKey = 'ControlNet';
        if (settings.a1111IpAdapter && settings.localRefImage || settings.a1111ControlNet && settings.a1111ControlNetModel) {
            let response;
            try {
                response = await fetchImpl(`${a1111BaseUrl(settings)}/sdapi/v1/scripts`, {
                    signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
            } catch {
                context.signal.throwIfAborted();
                throw invalid('The saved A1111 extension list could not be read.');
            }
            if (!response.ok) throw invalid('The saved A1111 extension list could not be read.');
            let data;
            try { data = JSON.parse(await readResponseText(response, 1024 * 1024)); } catch {
                throw invalid('The saved A1111 extension list is invalid.');
            }
            scriptKey = data.alwayson?.find(value => typeof value === 'string' && value.toLowerCase() === 'controlnet')
                || data.alwayson?.find(value => value === 'sd_forge_controlnet');
            if (!scriptKey) throw invalid('The configured A1111 server has no ControlNet extension.');
        }
        const configured = integer(settings.a1111Subseed, -1, -1, 0xffffffff);
        const data = { identity, subseed: configured < 0 ? randomInt(0x7fffffff) : configured, scriptKey };
        saved = { ...data, hash: roleplayHash(data) };
        withAccount(() => {
            if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted A1111 settings changed.', 'QIG_SETTINGS_CHANGED');
            writeArtifact(context.directories, context.job.id, name, saved);
        });
    }
    const request = buildA1111ImageRequest(settings, input, { reference: local, controlReference: control,
        subseed: saved.subseed, scriptKey: saved.scriptKey });
    withAccount(() => {
        if (roleplayHash(readSettingsLocked()) !== fingerprint) throw invalid('The accepted A1111 settings changed.', 'QIG_SETTINGS_CHANGED');
        const body = { identity, digest: roleplayHash(request.body), byteLength: Buffer.byteLength(request.body) };
        const previous = readArtifact(context.directories, context.job.id, `${name}:request`);
        if (previous !== undefined && roleplayHash(previous) !== roleplayHash(body)) throw invalid('The saved A1111 request changed.', 'QIG_RESULT_RECOVERY');
        if (previous === undefined) writeArtifact(context.directories, context.job.id, `${name}:request`, body);
    });
    return request;
}
