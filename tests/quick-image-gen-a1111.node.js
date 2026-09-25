import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './roleplay-transactions-fixture.js';

const { generateQuickImageGenJobImage, quickImageGenSettingsFingerprint } = await import('../src/generation/quick-image-gen-job.js');
const { resolveQuickImageGenSeed } = await import('../src/generation/quick-image-gen.js');
const { acceptJob, getJob, recoverJobs, updateJob } = await import('../src/jobs/store.js');
const { readArtifact } = await import('../src/jobs/artifacts.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function prepared(t, controls = {}) {
    const f = fixture(t);
    const directories = f.scope.directories;
    directories.userImages = path.join(directories.root, 'user', 'images');
    fs.mkdirSync(directories.userImages, { recursive: true });
    const settings = { provider: 'local', localType: 'a1111', localUrl: 'http://127.0.0.1:7860', seed: 710,
        width: 768, height: 1024, ...controls };
    fs.writeFileSync(path.join(directories.root, 'settings.json'), JSON.stringify({ extension_settings: { 'quick-image-gen': settings } }));
    const { job } = acceptJob(directories, { owner: f.scope.owner, type: 'fixture.a1111', submissionKey: 'image', intent: {} });
    const context = () => ({ job: getJob(directories, job.id), directories, owner: f.scope.owner, signal: new AbortController().signal });
    const request = { effectId: 'image', prompt: 'saved scene', negative: 'blur', settingsFingerprint: quickImageGenSettingsFingerprint(settings) };
    return { ...f, directories, settings, job, context, request, run: fetch => generateQuickImageGenJobImage(context(), { ...request, fetch }) };
}

test('A1111 sends saved enhancement controls and stable variation before saving its result once', async t => {
    const f = prepared(t, { steps: 42, cfgScale: 8.2, sampler: 'dpm++_2m', a1111Scheduler: 'Karras',
        a1111Model: 'checkpoint.safetensors', a1111Vae: 'vae.pt', a1111ClipSkip: 3, a1111RestoreFaces: true,
        a1111Tiling: true, a1111SaveToWebUI: true, a1111Loras: 'identity:0.65, light', a1111SubseedStrength: 0.25,
        a1111Subseed: -1, a1111HiresFix: true, a1111HiresUpscaler: 'Latent', a1111HiresScale: 1.5,
        a1111HiresSteps: 13, a1111HiresDenoise: 0.37, a1111HiresSampler: 'Euler', a1111HiresScheduler: 'Normal',
        a1111HiresPrompt: 'extra detail', a1111HiresNegative: 'noise', a1111HiresResizeX: 1536, a1111HiresResizeY: 2048,
        a1111Adetailer: true, a1111AdetailerPrompt: 'face', a1111AdetailerDenoise: 0.28, a1111AdetailerConfidence: 0.45,
        a1111AdetailerMaskBlur: 8, a1111AdetailerDilateErode: -2, a1111AdetailerInpaintOnlyMasked: false,
        a1111AdetailerInpaintPadding: 48, a1111Adetailer2: true, a1111Adetailer2Prompt: 'hands' });
    let calls = 0;
    const result = await f.run(async (url, options) => {
        calls++;
        assert.equal(url, 'http://127.0.0.1:7860/sdapi/v1/txt2img');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.prompt, 'saved scene <lora:identity:0.65> <lora:light:0.8>');
        assert.deepEqual(body.override_settings, { sd_model_checkpoint: 'checkpoint.safetensors', CLIP_stop_at_last_layers: 3, sd_vae: 'vae.pt' });
        assert.equal(body.seed, 710);
        assert.equal(body.subseed, readArtifact(f.directories, f.job.id, 'input:quick-image:image:a1111').subseed);
        assert.ok(body.subseed >= 0);
        assert.equal(body.subseed_strength, 0.25);
        assert.equal(body.sampler_name, 'DPM++ 2M');
        assert.equal(body.scheduler, 'Karras');
        for (const flag of ['restore_faces', 'tiling', 'save_images', 'enable_hr', 'override_settings_restore_afterwards']) assert.equal(body[flag], true);
        assert.equal(body.hr_prompt, 'extra detail');
        assert.equal(body.hr_negative_prompt, 'noise');
        assert.equal(body.hr_resize_y, 2048);
        assert.equal(body.hr_second_pass_steps, 13);
        assert.equal(body.denoising_strength, 0.37);
        const [enabled, face, hands] = body.alwayson_scripts.ADetailer.args;
        assert.equal(enabled, true);
        assert.equal(face.ad_denoising_strength, 0.28);
        assert.equal(face.ad_inpaint_only_masked, false);
        assert.equal(face.ad_dilate_erode, -2);
        assert.equal(hands.ad_model, 'hand_yolov8n.pt');
        return json({ images: [PNG] });
    });
    assert.equal(result.base64, PNG);
    await f.run(() => assert.fail('saved image must not repeat'));
    assert.equal(calls, 1);
});

test('A1111 img2img uses saved account reference bytes and omits txt2img-only hires', async t => {
    const f = prepared(t, { localRefImage: '/user/images/reference.png', localDenoise: 0.32, a1111HiresFix: true });
    fs.writeFileSync(path.join(f.directories.userImages, 'reference.png'), Buffer.from(PNG, 'base64'));
    await f.run(async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:7860/sdapi/v1/img2img');
        const body = JSON.parse(options.body);
        assert.deepEqual(body.init_images, [PNG]);
        assert.equal(body.denoising_strength, 0.32);
        assert.equal(body.enable_hr, undefined);
        return json({ images: [PNG] });
    });
    assert.ok(readArtifact(f.directories, f.job.id, 'input:quick-image:image:a1111:reference:source').evidence.physical);
});

test('A1111 resolves Forge ControlNet before the only paid POST and preserves both reference units', async t => {
    const f = prepared(t, { localRefImage: `data:image/png;base64,${PNG}`, a1111IpAdapter: true,
        a1111IpAdapterMode: 'ip-adapter-faceid-plus_sd15', a1111IpAdapterWeight: 0.8,
        a1111IpAdapterStartStep: 0.2, a1111IpAdapterEndStep: 0.9, a1111IpAdapterPixelPerfect: false,
        a1111ControlNet: true, a1111ControlNetModel: 'pose', a1111ControlNetModule: 'openpose',
        a1111ControlNetImage: `data:image/png;base64,${PNG}`, a1111ControlNetWeight: 1.2 });
    const calls = [];
    await f.run(async (url, options) => {
        calls.push(url);
        if (url.endsWith('/scripts')) return json({ alwayson: ['ADetailer', 'sd_forge_controlnet'] });
        const body = JSON.parse(options.body);
        assert.ok(url.endsWith('/txt2img'));
        assert.equal(body.init_images, undefined);
        const [face, pose] = body.alwayson_scripts.sd_forge_controlnet.args;
        assert.equal(face.module, 'ip-adapter_face_id_plus');
        assert.equal(face.pixel_perfect, false);
        assert.equal(face.guidance_start, 0.2);
        assert.equal(face.guidance_end, 0.9);
        assert.equal(pose.weight, 1.2);
        for (const unit of [face, pose]) assert.equal(unit.input_image, PNG);
        return json({ images: [PNG] });
    });
    assert.equal(calls.length, 2);
    await f.run(() => assert.fail('saved request must not rediscover or resubmit'));
});

test('A1111 lost or rejected mutation never retries another ControlNet spelling after recovery', async t => {
    const f = prepared(t, { a1111ControlNet: true, a1111ControlNetModel: 'pose' });
    updateJob(f.directories, f.job.id, { state: 'running' });
    let posts = 0;
    await assert.rejects(f.run(async url => {
        if (url.endsWith('/scripts')) return json({ alwayson: ['ControlNet'] });
        posts++;
        return json({ detail: 'always on script ControlNet not found' }, 422);
    }));
    recoverJobs(f.directories);
    assert.equal(getJob(f.directories, f.job.id).state, 'interrupted');
    await assert.rejects(f.run(() => assert.fail('unknown POST must not repeat')), { code: 'QIG_RESULT_RECOVERY' });
    assert.equal(posts, 1);
});

test('QIG seed normalisation follows the saved unsigned range and empty random selection', () => {
    assert.equal(resolveQuickImageGenSeed(0x1ffffffff), 0xffffffff);
    assert.equal(resolveQuickImageGenSeed('14.9'), 14);
    for (const input of [-1, -5, null, undefined, '']) {
        const value = resolveQuickImageGenSeed(input);
        assert.ok(Number.isSafeInteger(value) && value >= 0 && value < 0x7fffffff);
    }
});
