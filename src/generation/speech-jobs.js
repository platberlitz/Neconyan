import crypto from 'node:crypto';
import path from 'node:path';
import { createMacroEnvironment } from '../macros/index.js';
import { providerNotDispatched, providerRefused, providerStep, readArtifact, unresolvedProviderStep, writeArtifact } from '../jobs/artifacts.js';
import { readAudioArtifact, writeAudioArtifact } from '../jobs/audio-artifacts.js';
import { registerHandler } from '../jobs/runner.js';
import { setJobResume } from '../jobs/store.js';
import { readRoleplayEntityLocked, assertRoleplaySourceLocked } from './roleplay-source.js';
import { confirmRoleplayAccount, roleplayAccountBase, roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { admitNativeMediaJob, finishNativeMediaJob, publishNativeMediaFile, withNativeMediaReceipt } from './media-jobs.js';
import { captureSpeechPolicy, assertSpeechPolicy, readSpeechSettings, speechError, MAX_SPEECH_TEXT } from './speech-config.js';
import { resolveSpeechVoice } from './speech-voices.js';
import { downloadSpeechOutput, prepareSpeechTransport, previousElevenLabsAudio, sendSpeechTransport, withSpeechEndpoint } from './speech-transports.js';
import { DEFAULT_TTS_VOICE_MARKER, parseMessageSegments, prepareTtsNarrationText, resolveTtsVoiceMapEntry } from '../../public/scripts/extensions/tts/lib/text-prep.js';
import { selectSavedRoleplayPersona } from './world-info.js';

const HASH = /^[a-f0-9]{64}$/;
const recover = () => speechError('The saved speech input or result needs recovery.', 'TTS_RESULT_RECOVERY', 503);
const providerText = (provider, text) => {
    if (provider === 'Novel') return text.replace(/~/g, '.').replace(/\*/g, '');
    if (provider === 'XTTSv2') return text.replace(/…/g, '...').replace(/["“”‘’]/g, '').replace(/\.+/g, '.');
    if (provider === 'GSVI') return text.replace('<br>', '\n');
    if (provider === 'SBVits2') return text.replace(/\n+/g, '<br>');
    if (provider === 'Volcengine') return text.split('...').join('');
    return text;
};

function splitSpeech(text, provider) {
    const limit = provider === 'Novel' ? 1000 : provider === 'Google Translate' ? 200 : provider === 'Edge' ? 600 : Infinity;
    const output = [];
    while (text.length > limit) {
        let end = text.lastIndexOf(' ', limit);
        if (end < limit / 2) end = limit;
        if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        if (text.slice(0, end).trim()) output.push(text.slice(0, end).trim());
        text = text.slice(end).trimStart();
    }
    if (text.trim()) output.push(text.trim());
    return output;
}

function speechSegments(text, displayText, speaker, snapshot, policy, config) {
    const environment = createMacroEnvironment(snapshot.macros ?? {}, {}, { readOnly: true });
    const substitute = value => environment.evaluate(value, { strictCapabilities: true });
    const prepared = prepareTtsNarrationText(text, policy.options, { characterName: speaker.name,
        allowName2Display: policy.allowName2Display, displayText, substitute, processText: value => providerText(policy.provider, value),
        separator: policy.provider === 'Edge' ? ' . ' : ' ... ' });
    if (Buffer.byteLength(prepared) > MAX_SPEECH_TEXT) throw speechError('The speech text is too large.');
    const segments = [];
    for (const part of parseMessageSegments(prepared, policy.options.multi_voice_enabled)) {
        const suffix = { dialogue: ' ("Quotes")', action: ' (*Text inside asterisks*)', other: ' (Other text)' }[part.type];
        const voiceKey = policy.options.multi_voice_enabled && speaker.name !== DEFAULT_TTS_VOICE_MARKER ? speaker.name + suffix : speaker.name;
        const voice = resolveTtsVoiceMapEntry(policy.voiceMap, voiceKey);
        if (voice.disabled) continue;
        if (typeof voice.entry !== 'string' || !voice.entry) throw speechError('No voice is saved for this speech part.', 'TTS_VOICE_MISSING');
        let instructions = config.settings.characterInstructions?.[speaker.name] ?? config.settings.instructions ?? '';
        if (typeof instructions !== 'string' || instructions.length > 16384) throw speechError('The saved speech instructions are invalid.');
        instructions = substitute(instructions);
        for (const content of splitSpeech(part.text, policy.provider)) {
            const seed = Number(config.settings.seed ?? -1);
            if (!Number.isSafeInteger(seed) || seed < -1 || seed > 0xffffffff) throw speechError('The saved speech seed is invalid.');
            segments.push({ text: content, entry: voice.entry, voiceKey, character: speaker.name, instructions,
                seed: seed < 0 ? crypto.randomInt(0, 0x80000000) : seed });
        }
    }
    if (segments.length > 256) throw speechError('The speech request contains too many parts.');
    return segments;
}

function verified(value, identity) {
    const { hash, ...data } = value ?? {};
    if (!HASH.test(hash) || hash !== roleplayHash(data) || data.identity !== identity) throw recover();
    return data;
}

/** Saved automatic and manual speech share this workflow; no network runs with an account lock held. */
export async function generateSavedSpeech(context, { effectId, policy, account, text, displayText = '', speaker, snapshot = {}, assertSourceLocked, failSoft = false }, deps = {}) {
    if (!policy) return null;
    if (policy.provider === 'Kokoro') return { status: 'browser', provider: 'Kokoro' };
    if (speaker?.isUser && policy.automatic && policy.options.narrate_user !== true) return null;
    if (typeof effectId !== 'string' || !effectId || effectId.length > 256 || typeof text !== 'string'
        || Buffer.byteLength(text) > MAX_SPEECH_TEXT || typeof speaker?.name !== 'string') throw speechError('The accepted speech input is invalid.');
    const base = roleplayAccountBase(context.directories);
    if (!base || base.owner !== context.owner || !account) throw speechError('The speech account is unavailable.', 'TTS_SOURCE_CHANGED');
    const locked = operation => withRoleplayAccount(base, account, operation);
    const check = () => locked(lease => {
        context.signal.throwIfAborted();
        assertSourceLocked?.(lease);
        return assertSpeechPolicy(context.directories, policy);
    });
    const identity = roleplayHash({ effectId, policy, account, text, displayText, speaker, snapshot });
    const name = `speech:${effectId}`;
    let input = locked(() => readArtifact(context.directories, context.job.id, `input:${name}`));
    const completed = locked(() => readArtifact(context.directories, context.job.id, `${name}:result`));
    if (completed !== undefined) {
        const result = verified(completed, identity).result;
        for (const item of result?.artifacts ?? []) locked(() => {
            if (!readAudioArtifact(context.directories, context.job.id, item.artifact)) throw recover();
        });
        return result;
    }
    if (input === undefined) {
        const config = check();
        if (config.rvc) throw speechError('The configured voice conversion has no installed native handler.', 'TTS_RVC_UNAVAILABLE');
        const segments = speechSegments(text, displayText, speaker, snapshot, policy, config);
        const data = { identity, account, segments };
        input = { ...data, hash: roleplayHash(data) };
        locked(lease => {
            assertSourceLocked?.(lease);
            assertSpeechPolicy(context.directories, policy);
            writeArtifact(context.directories, context.job.id, `input:${name}`, input);
        });
    }
    const data = verified(input, identity);
    if (!Array.isArray(data.segments) || data.segments.length > 256) throw recover();
    const artifacts = [];
    try {
        await saveSpeechSegments();
    } catch (error) {
        // A definite refusal or non-audio answer fails only the narration. The
        // failure is saved so a replay reports it instead of asking again.
        if (!failSoft || !error?.speechRefused || context.signal.aborted) throw error;
        const failed = { status: 'failed', provider: policy.provider, code: error.code || 'TTS_PROVIDER', error: error.message };
        const final = { identity, result: failed };
        locked(() => writeArtifact(context.directories, context.job.id, `${name}:result`, { ...final, hash: roleplayHash(final) }));
        return failed;
    }
    async function saveSpeechSegments() {
        for (let index = 0; index < data.segments.length; index++) {
            context.signal.throwIfAborted();
            const step = `${name}:${index}`;
            const audioName = `${step}:audio`;
            let audio = locked(() => readAudioArtifact(context.directories, context.job.id, audioName));
            if (audio === undefined) {
                const segmentInput = data.segments[index];
                const segmentId = roleplayHash([context.job.id, step, input.hash]);
                let accepted = locked(() => readArtifact(context.directories, context.job.id, `input:${step}:voice`));
                let config;
                if (accepted === undefined) {
                    if (unresolvedProviderStep(context.directories, context.job.id)) throw recover();
                    config = check();
                    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30000)]);
                    const voice = await resolveSpeechVoice(config, segmentInput.entry, { ...deps, signal });
                    const history = await previousElevenLabsAudio(config, { ...segmentInput, voice }, { ...deps, signal });
                    const selection = { identity: segmentId, voice, history };
                    accepted = { ...selection, hash: roleplayHash(selection) };
                    locked(lease => {
                        assertSourceLocked?.(lease); assertSpeechPolicy(context.directories, policy);
                        writeArtifact(context.directories, context.job.id, `input:${step}:voice`, accepted);
                    });
                }
                const selection = verified(accepted, segmentId);
                const segment = { ...segmentInput, id: segmentId, voice: selection.voice };
                const savedProvider = locked(() => readArtifact(context.directories, context.job.id, `provider:${step}`));
                const resultStore = {
                    readResult: (directories, id, key) => locked(() => {
                        const saved = readArtifact(directories, id, key);
                        return saved?.url ? saved : saved === undefined ? undefined : readAudioArtifact(directories, id, key);
                    }),
                    writeResult: (directories, id, key, value) => locked(() => {
                        if (value?.url) writeArtifact(directories, id, key, value);
                        else writeAudioArtifact(directories, id, key, value);
                    }),
                };
                let result;
                if (selection.history) {
                    config = check();
                    result = selection.history;
                } else if (savedProvider !== undefined) result = resultStore.readResult(context.directories, context.job.id, `provider:${step}`);
                else {
                    if (unresolvedProviderStep(context.directories, context.job.id)) throw recover();
                    config = check();
                    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(180000)]);
                    const descriptor = await prepareSpeechTransport(config, segment, { ...deps, signal });
                    // Expiring OAuth headers are reconstructed from the same bound credential; never save them.
                    const digest = roleplayHash({ ...descriptor, headers: null,
                        ...(descriptor.settingsRequest ? { settingsRequest: { ...descriptor.settingsRequest, headers: null } } : {}) });
                    locked(lease => {
                        assertSourceLocked?.(lease); assertSpeechPolicy(context.directories, policy);
                        const expected = { identity: segmentId, digest };
                        const saved = readArtifact(context.directories, context.job.id, `input:${step}:request`);
                        if (saved !== undefined && roleplayHash(saved) !== roleplayHash(expected)) throw recover();
                        if (saved === undefined) writeArtifact(context.directories, context.job.id, `input:${step}:request`, expected);
                    });
                    const run = async () => {
                        try { check(); } catch (error) { throw providerNotDispatched(error); }
                        try { return await sendSpeechTransport(config, descriptor, segment, { ...deps, signal }); } catch (error) {
                            if (context.signal.aborted) throw context.signal.reason;
                            if (error?.speechRefused) throw providerRefused(error);
                            throw speechError('The speech request has no verified complete result.', 'TTS_PROVIDER', error.status ?? 502);
                        }
                    };
                    if (['SpeechT5', 'System'].includes(descriptor.native)) {
                        // Pure local calculation may restart from its saved input without another paid or mutating request.
                        setJobResume(context.directories, context.job.id, `input:${step}:request`);
                        result = await withSpeechEndpoint(`native:${descriptor.native}`, run);
                        resultStore.writeResult(context.directories, context.job.id, `provider:${step}`, result);
                    } else result = await providerStep(context, step, run, resultStore);
                }
                if (result?.url) {
                    config ??= check();
                    audio = await downloadSpeechOutput(config, result, { ...deps, signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]) });
                } else audio = result;
                locked(() => writeAudioArtifact(context.directories, context.job.id, audioName, audio));
            }
            artifacts.push({ artifact: audioName, mimeType: audio.mimeType });
        }
    }
    const result = artifacts.length ? { status: 'ready', provider: policy.provider, job: context.job.id,
        artifact: artifacts[0].artifact, mimeType: artifacts[0].mimeType, artifacts, playbackRate: policy.options.playback_rate ?? 1 } : null;
    const final = { identity, result };
    locked(() => writeArtifact(context.directories, context.job.id, `${name}:result`, { ...final, hash: roleplayHash(final) }));
    return result;
}

/** Manual narration is admitted against an exact saved message and character, not browser-prepared text. */
export function captureSpeechRequest(base, account, source, { avatar = source.locator.avatar } = {}) {
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        if (!Number.isSafeInteger(source.message?.index)) throw speechError('Select an exact saved message for narration.');
        if (!source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) throw speechError('The speech character is outside the accepted source.');
        const character = readRoleplayEntityLocked(lease, 'character', avatar).data;
        confirmRoleplayAccount(lease);
        const record = saved.records[source.message.index + 1];
        const data = readSpeechSettings(base.directories);
        const policy = captureSpeechPolicy(base.directories, data, { automatic: false });
        if (!policy) throw speechError('Speech is disabled for this account.');
        const card = character.data ?? character;
        const persona = selectSavedRoleplayPersona(data, saved, source, avatar, base.directories);
        const userName = persona.name || (saved.records[0].user_name !== 'unused' && saved.records[0].user_name) || 'User';
        return { account, policy, personaHash: roleplayHash({ ...persona, name: persona.name ?? null }),
            text: String(record.mes ?? ''), displayText: record.extra?.display_text || '',
            speaker: { name: record.name, avatar, isUser: Boolean(record.is_user) }, snapshot: { macros: {
                names: { char: card.name, user: userName }, character: { description: card.description ?? '', personality: card.personality ?? '',
                    scenario: card.scenario ?? '', persona: persona.description ?? '' },
                variables: { local: saved.records[0].chat_metadata?.variables ?? {}, global: data.extension_settings?.variables?.global ?? {} },
                extra: { character: card, characterAvatar: avatar, chat: saved.records.slice(1), powerUser: data.power_user ?? {} },
            } } };
    });
}

export function admitSpeechJob(base, account, { operationKey, source, request }) {
    return admitNativeMediaJob(base, account, { operationKey, source, kind: 'speech', request,
        target: { kind: 'media-speech', id: source.instanceId, branchId: roleplayHash(source.message) } });
}

export async function runSpeechJob(context, deps = {}) {
    const closed = withNativeMediaReceipt(context, ({ value }) => value.state === 'closed' ? value.result : undefined, { checkSource: false });
    if (closed !== undefined) return { result: closed };
    const request = context.job.intent.request;
    const assertSourceLocked = lease => {
        const saved = assertRoleplaySourceLocked(lease, context.job.intent.source);
        if (request.personaHash) {
            const persona = selectSavedRoleplayPersona(readSpeechSettings(context.directories), saved,
                context.job.intent.source, request.speaker.avatar, context.directories);
            if (roleplayHash({ ...persona, name: persona.name ?? null }) !== request.personaHash) {
                throw speechError('The accepted speech persona has changed.', 'TTS_SOURCE_CHANGED', 409);
            }
        }
    };
    const result = await generateSavedSpeech(context, { ...request, effectId: 'manual',
        assertSourceLocked }, deps);
    const files = [];
    for (const item of result?.artifacts ?? []) {
        const audio = withNativeMediaReceipt(context, () => readAudioArtifact(context.directories, context.job.id, item.artifact));
        const relative = path.posix.join('user', 'files', 'speech', `${roleplayHash([context.job.id, item.artifact])}.${audio.format}`);
        const after = publishNativeMediaFile(context, { relative, before: null, bytes: Buffer.from(audio.base64, 'base64'),
            checkLocked: assertSourceLocked });
        files.push({ url: `/${relative}`, mimeType: audio.mimeType, rawHash: after.rawHash });
    }
    const output = { narration: result, files };
    withNativeMediaReceipt(context, () => writeArtifact(context.directories, context.job.id, 'result', output));
    return finishNativeMediaJob(context, output);
}

registerHandler('media.speech', runSpeechJob);
