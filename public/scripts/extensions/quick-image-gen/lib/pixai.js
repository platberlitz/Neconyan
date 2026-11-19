// PixAI (https://platform.pixai.art) request building, task polling and output lookup,
// shared by the browser provider and the server job route.
import { abortableSleep, getRetryAfterMs, isTransientProviderStatus, isTrustedProviderOutputUrl } from "./hosted-provider.js";
import { readProviderErrorResponse } from "./provider-adapters.js";
import { readResponseText } from "./security.js";

export const PIXAI_API_BASE = "https://api.pixai.art/v2";
export const PIXAI_CREATE_URL = `${PIXAI_API_BASE}/image/create`;
export const PIXAI_DEFAULT_MODEL = "2024383379556065549";
export const PIXAI_DEFAULT_MODE = "standard";
export const PIXAI_DEFAULT_PROMPT_HELPER = "disable";
export const PIXAI_MODES = Object.freeze(["lite", "standard", "pro", "ultra"]);
export const PIXAI_PROMPT_HELPERS = Object.freeze(["disable", "enable", "low", "medium"]);

// PixAI refuses a mode the model does not offer (422 INVALID_INPUT); Tsubaki.3 offers only Pro and Ultra.
export const PIXAI_MODELS = Object.freeze([
    Object.freeze({ id: "2024383379556065549", name: "Tsubaki.3", family: "tsubaki",
        modes: Object.freeze(["pro", "ultra"]), defaultMode: "pro" }),
    Object.freeze({ id: "1983308862240288769", name: "Tsubaki.2", family: "tsubaki",
        modes: PIXAI_MODES, defaultMode: PIXAI_DEFAULT_MODE }),
    Object.freeze({ id: "1861558740588989558", name: "Haruka v2", family: "sdxl" }),
    Object.freeze({ id: "1954632828118619567", name: "Hoshino v2", family: "sdxl" }),
]);

// Output sizes for each aspect ratio at the two size tiers (PixAI 'Supported Resolutions').
const PIXAI_RESOLUTIONS = Object.freeze({
    "1:1": { "1k": [1024, 1024], "1.5k": [1536, 1536] },
    "2:3": { "1k": [848, 1280], "1.5k": [1024, 1536] },
    "3:2": { "1k": [1280, 848], "1.5k": [1536, 1024] },
    "3:4": { "1k": [864, 1152], "1.5k": [1152, 1536] },
    "4:3": { "1k": [1152, 864], "1.5k": [1536, 1152] },
    "3:5": { "1k": [768, 1280], "1.5k": [912, 1536] },
    "5:3": { "1k": [1280, 768], "1.5k": [1536, 912] },
    "9:16": { "1k": [720, 1280], "1.5k": [864, 1536] },
    "16:9": { "1k": [1280, 720], "1.5k": [1536, 864] },
    "1:3": { "1k": [512, 1536], "1.5k": [512, 1536] },
    "3:1": { "1k": [1536, 512], "1.5k": [1536, 512] },
});

export const PIXAI_SAMPLER_METHODS = Object.freeze({
    euler_a: "Euler a",
    euler: "Euler",
    lms: "LMS",
    heun: "Heun",
    ddim: "DDIM",
    "dpm++_2m": "DPM++ 2M Karras",
    "dpm++_sde": "DPM++ SDE Karras",
    "dpm++_2m_sde": "DPM++ 2M SDE Karras",
    "dpm++_2s_ancestral": "DPM++ 2S a Karras",
    dpm_2: "DPM2 Karras",
    dpm_2_ancestral: "DPM2 a Karras",
    restart: "Restart",
});

const TSUBAKI_PROMPT_LIMIT = 10_000;
const DEFAULT_PROMPT_LIMIT = 4096;
const NEGATIVE_PROMPT_LIMIT = 4096;
const MAX_EARLY_NOT_FOUND_POLLS = 10;
const MAX_POLL_DELAY_MS = 4000;
const MIN_POLL_DELAY_MS = 1500;

export function normalizePixaiModel(value) {
    return String(value ?? "").trim() || PIXAI_DEFAULT_MODEL;
}

/** 'tsubaki', 'sdxl', or '' for a model version ID this list does not know. */
export function getPixaiModelFamily(model) {
    const id = normalizePixaiModel(model);
    return PIXAI_MODELS.find(entry => entry.id === id)?.family || "";
}

export function getPixaiModelName(model) {
    const id = normalizePixaiModel(model);
    return PIXAI_MODELS.find(entry => entry.id === id)?.name || "";
}

/** The modes a Tsubaki model accepts; empty for models that take no mode. */
export function getPixaiModes(model) {
    const id = normalizePixaiModel(model);
    return PIXAI_MODELS.find(entry => entry.id === id)?.modes || [];
}

/** The saved mode when the model offers it, otherwise that model's own default. */
export function normalizePixaiMode(value, model = PIXAI_DEFAULT_MODEL) {
    const id = normalizePixaiModel(model);
    const entry = PIXAI_MODELS.find(item => item.id === id);
    const modes = entry?.modes || PIXAI_MODES;
    if (modes.includes(value)) return value;
    return entry?.defaultMode || PIXAI_DEFAULT_MODE;
}

export function normalizePixaiPromptHelper(value) {
    return PIXAI_PROMPT_HELPERS.includes(value) ? value : PIXAI_DEFAULT_PROMPT_HELPER;
}

/** The nearest PixAI aspect ratio and size tier to the requested width and height. */
export function getPixaiSize(width, height) {
    const targetWidth = Number(width) > 0 ? Number(width) : 1024;
    const targetHeight = Number(height) > 0 ? Number(height) : 1024;
    const target = Math.log(targetWidth / targetHeight);
    let aspectRatio = "1:1";
    let best = Infinity;
    for (const ratio of Object.keys(PIXAI_RESOLUTIONS)) {
        const [w, h] = ratio.split(":").map(Number);
        const distance = Math.abs(target - Math.log(w / h));
        if (distance < best) {
            best = distance;
            aspectRatio = ratio;
        }
    }
    const size = Math.max(targetWidth, targetHeight) > 1280 ? "1.5k" : "1k";
    const [outputWidth, outputHeight] = PIXAI_RESOLUTIONS[aspectRatio][size];
    return { aspectRatio, size, width: outputWidth, height: outputHeight };
}

function truncateText(value, limit) {
    const text = String(value ?? "");
    if (text.length <= limit) return text;
    let cut = text.slice(0, limit);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut;
}

/**
 * The POST /v2/image/create body, plus the parameters the image was really made with.
 * mode goes only to Tsubaki models and sampling only to SDXL models; an unknown model
 * version ID gets neither, because PixAI rejects either field on the wrong family.
 */
export function buildPixaiImageRequest({
    model, prompt, negative = "", width, height, mode, promptHelper,
    steps, cfgScale, sampler, seed,
} = {}) {
    const modelVersionId = normalizePixaiModel(model);
    const family = getPixaiModelFamily(modelVersionId);
    const finalPrompt = truncateText(prompt, family === "tsubaki" ? TSUBAKI_PROMPT_LIMIT : DEFAULT_PROMPT_LIMIT);
    if (!finalPrompt.trim()) throw new Error("PixAI needs a prompt");
    const finalNegative = truncateText(negative, NEGATIVE_PROMPT_LIMIT);
    const resolution = getPixaiSize(width, height);
    const body = {
        modelVersionId,
        prompt: finalPrompt,
        aspectRatio: resolution.aspectRatio,
        size: resolution.size,
        promptHelper: normalizePixaiPromptHelper(promptHelper),
        batchSize: 1,
    };
    if (finalNegative.trim()) body.negativePrompt = finalNegative;
    const effectiveParameters = {
        model: modelVersionId,
        width: resolution.width,
        height: resolution.height,
        aspectRatio: resolution.aspectRatio,
        imageSize: resolution.size,
        steps: undefined,
        cfgScale: undefined,
        sampler: undefined,
        seed: undefined,
    };
    if (family === "tsubaki") body.mode = normalizePixaiMode(mode, modelVersionId);
    if (family === "sdxl") {
        const sampling = {};
        const method = PIXAI_SAMPLER_METHODS[sampler];
        if (method) sampling.method = method;
        const numericSteps = Number(steps);
        if (Number.isFinite(numericSteps)) sampling.steps = Math.max(1, Math.min(100, Math.trunc(numericSteps)));
        const numericCfg = Number(cfgScale);
        if (Number.isFinite(numericCfg)) sampling.cfgScale = numericCfg;
        if (Object.keys(sampling).length) body.sampling = sampling;
        effectiveParameters.steps = sampling.steps;
        effectiveParameters.cfgScale = sampling.cfgScale;
        effectiveParameters.sampler = sampling.method;
    }
    const numericSeed = Number(seed);
    if (Number.isSafeInteger(numericSeed) && numericSeed >= 0) {
        body.seed = numericSeed;
        effectiveParameters.seed = numericSeed;
    }
    return { body, effectiveParameters, family };
}

/** Build the request from Quick Image Gen settings. */
export function buildPixaiImageRequestFromSettings(settings, prompt, negative, seed) {
    return buildPixaiImageRequest({
        model: settings?.pixaiModel,
        prompt,
        negative,
        width: settings?.width,
        height: settings?.height,
        mode: settings?.pixaiMode,
        promptHelper: settings?.pixaiPromptHelper,
        steps: settings?.steps,
        cfgScale: settings?.cfgScale,
        sampler: settings?.sampler,
        seed,
    });
}

function defaultCreateError(message) {
    return new Error(message);
}

async function describePixaiError(response, action) {
    const { data, message } = await readProviderErrorResponse(response);
    const code = typeof data?.code === "string" && /^[A-Z0-9_]{2,64}$/.test(data.code) ? data.code : "";
    const label = code ? `${response.status} ${code}` : String(response.status);
    const detail = message && message !== code ? message : (response.statusText || "no detail");
    if (response.status === 401) return `PixAI rejected the API key (${label}): ${detail}`;
    return `PixAI ${action} failed (${label}): ${detail}`;
}

async function readJson(response, createError) {
    try {
        return JSON.parse(await readResponseText(response, 1024 * 1024));
    } catch {
        throw createError("PixAI returned a response that is not valid JSON", "QIG_PROVIDER_ERROR");
    }
}

function authHeaders(apiKey) {
    return { Authorization: `Bearer ${String(apiKey || "").trim()}` };
}

export function isValidPixaiTaskId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** Submit one image task and return its ID. Never retried: each submission is paid. */
export async function createPixaiTask({ body, apiKey, fetchImpl = globalThis.fetch, signal, createError = defaultCreateError } = {}) {
    const response = await fetchImpl(PIXAI_CREATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
    });
    if (!response.ok) throw createError(await describePixaiError(response, "image request"), "QIG_PROVIDER_ERROR");
    const task = await readJson(response, createError);
    const id = typeof task?.id === "string" ? task.id.trim() : (Number.isSafeInteger(task?.id) ? String(task.id) : "");
    if (!isValidPixaiTaskId(id)) throw createError("PixAI did not return a task ID", "QIG_PROVIDER_ERROR");
    return id;
}

/** Keep the media ID even when the task already provides a URL. */
export function getPixaiTaskOutput(task) {
    const outputs = task?.outputs && typeof task.outputs === "object" ? task.outputs : {};
    const urls = Array.isArray(outputs.mediaUrls) ? outputs.mediaUrls : [];
    const ids = Array.isArray(outputs.mediaIds) ? outputs.mediaIds : [];
    const url = urls.find(value => typeof value === "string" && value.trim())?.trim();
    const mediaId = ids.map(value => (typeof value === "number" ? String(value) : value))
        .find(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value));
    return url || mediaId ? { url, mediaId } : null;
}

export function pickPixaiMediaUrl(items, mediaId) {
    const list = Array.isArray(items) ? items : (Array.isArray(items?.data) ? items.data : []);
    const media = list.find(item => String(item?.id ?? "") === mediaId);
    const urls = Array.isArray(media?.urls) ? media.urls : [];
    const publicUrl = urls.find(entry => entry?.variant === "PUBLIC" && typeof entry.url === "string")?.url;
    return typeof publicUrl === "string" ? publicUrl.trim() : "";
}

export function describePixaiTaskFailure(task) {
    const status = String(task?.status || "failed").toLowerCase();
    const detail = String(task?.taskStatusMsgI18n?.defaultMessage || "").trim().slice(0, 1000);
    return `PixAI image ${status}${detail ? `: ${detail}` : ""}`;
}

function isTrustedPixaiImageUrl(url) {
    return isTrustedProviderOutputUrl("pixai", url, PIXAI_CREATE_URL);
}

function unsafePixaiImageUrl(createError) {
    return createError("PixAI returned an image address outside its own image hosts", "QIG_UNSAFE_IMAGE_URL");
}

/**
 * Poll a task until it finishes and return the address of its image. The API key goes only
 * to api.pixai.art; the image host never receives it.
 */
export async function pollPixaiTask({
    taskId, apiKey, fetchImpl = globalThis.fetch, signal, wait = abortableSleep, createError = defaultCreateError,
} = {}) {
    if (!isValidPixaiTaskId(taskId)) throw createError("PixAI did not return a task ID", "QIG_PROVIDER_ERROR");
    let attempt = 0;
    let seenTask = false;
    let notFound = 0;
    while (true) {
        await wait(Math.min(MAX_POLL_DELAY_MS, MIN_POLL_DELAY_MS + attempt * 250), signal);
        attempt += 1;
        const response = await fetchImpl(`${PIXAI_API_BASE}/task/${encodeURIComponent(taskId)}`, {
            method: "GET",
            headers: authHeaders(apiKey),
            redirect: "error",
            signal,
        });
        if (!response.ok) {
            // A new task can be briefly unknown to the read side right after it is created.
            if (response.status === 404 && !seenTask && ++notFound <= MAX_EARLY_NOT_FOUND_POLLS) {
                void response.body?.cancel?.().catch(() => {});
                continue;
            }
            if (isTransientProviderStatus(response.status)) {
                void response.body?.cancel?.().catch(() => {});
                await wait(getRetryAfterMs(response), signal);
                continue;
            }
            throw createError(await describePixaiError(response, "status check"), "QIG_PROVIDER_ERROR");
        }
        seenTask = true;
        const task = await readJson(response, createError);
        const status = String(task?.status || "").toLowerCase();
        if (status === "completed") {
            const output = getPixaiTaskOutput(task);
            if (!output) throw createError("PixAI finished without an image", "QIG_BAD_IMAGE");
            if (output.url && isTrustedPixaiImageUrl(output.url)) return output.url;
            if (!output.mediaId) throw unsafePixaiImageUrl(createError);
            // Recover the same image through PixAI without fetching an untrusted URL or submitting again.
            const lookup = await fetchImpl(`${PIXAI_API_BASE}/media/batch?ids=${encodeURIComponent(output.mediaId)}`, {
                method: "GET",
                headers: authHeaders(apiKey),
                redirect: "error",
                signal,
            });
            if (!lookup.ok) throw createError(await describePixaiError(lookup, "image lookup"), "QIG_PROVIDER_ERROR");
            const url = pickPixaiMediaUrl(await readJson(lookup, createError), output.mediaId);
            if (!url) throw createError("PixAI finished, but its image address is unavailable", "QIG_BAD_IMAGE");
            if (!isTrustedPixaiImageUrl(url)) throw unsafePixaiImageUrl(createError);
            return url;
        }
        if (status === "failed" || status === "cancelled" || status === "canceled") {
            throw createError(describePixaiTaskFailure(task), "QIG_PROVIDER_ERROR");
        }
    }
}
