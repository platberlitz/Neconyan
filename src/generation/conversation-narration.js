import { fetchElevenLabsHistoryAudio, generateOpenAiCompatibleSpeech, generateOpenAiSpeech, generatePollinationsSpeech, listElevenLabsHistory, listElevenLabsVoices, synthesizeElevenLabs } from '../endpoints/speech-transports.js';
import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { readUserSettingsWithStatus } from '../endpoints/conversation-store.js';
import { providerStep } from '../jobs/artifacts.js';
import { createMacroEnvironment } from '../macros/index.js';
import { createHostedProviderDeadline } from '../../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';
import { DEFAULT_TTS_VOICE_MARKER, DISABLED_TTS_VOICE_MARKER, parseTtsVoiceMap, prepareTtsNarrationText, resolveTtsVoiceMapEntry } from '../../public/scripts/extensions/tts/lib/text-prep.js';
import { generateSavedSpeech } from './speech-jobs.js';
import { assertConversationEffectSource } from './conversation-effects.js';
import { captureConversationRoleplaySource } from './conversation-roleplay-source.js';
import { isConversationGroupSpeakerEligible } from '../../public/scripts/neconyan-conversation/partners-utils.js';

const HOSTED_TTS_TIMEOUT_SECONDS = 30;
const OPENAI_VOICE_MATCH = /^[a-z0-9-]+$/;
const MODERN_ELEVENLABS_MODELS = new Set(['eleven_v3', 'eleven_ttv_v3', 'eleven_multilingual_v2', 'eleven_multilingual_ttv_v2']);
const SUPPORTED_PROVIDERS = new Set(['OpenAI', 'OpenAI Compatible', 'ElevenLabs', 'Pollinations']);

/**
 * Automatic Conversation narration. Prepared server-side in the same write as
 * the reply bubble, so a reply is narrated once no matter how many tabs watch.
 * Bundled browser Kokoro stays a page-open exception (reported as `browser`);
 * New admissions freeze speech settings and use saved, ordered audio parts.
 * Already accepted older snapshots retain their original narration path.
 */
export function createConversationNarrator(deps = {}) {
    const { fetchImpl } = deps;
    return async function narrateConversationReply(context, snapshot, text, speaker, delivery = {}) {
        if (Object.hasOwn(snapshot ?? {}, 'speechPolicy')) {
            if (!snapshot.speechPolicy) return null;
            if (!delivery.effectId) throw new Error('Narration requires a delivery effect identity.');
            return generateSavedSpeech(context, { effectId: delivery.effectId, policy: snapshot.speechPolicy,
                account: snapshot.speechAccount, text, displayText: delivery.extra?.display_text || '', speaker, snapshot: { macros: snapshot.macros },
                assertSourceLocked: lease => {
                    const current = assertConversationEffectSource(context, snapshot.target, delivery.effectId);
                    if (snapshot.target.groupId && !isConversationGroupSpeakerEligible(current.group, speaker.avatar)) {
                        throw Object.assign(new Error('The narration speaker is no longer available.'), { status: 409 });
                    }
                    if (snapshot.automation?.roleplaySource) captureConversationRoleplaySource({ user: { directories: context.directories } },
                        snapshot.automation.roleplaySource, { characterName: speaker.name, userName: snapshot.userName, accountLease: lease });
                },
            }, deps);
        }
        const saved = readSavedSettings(context);
        const data = saved?.ok ? saved.data : null;
        const tts = data?.extension_settings?.tts;
        const disabledExtensions = Array.isArray(data?.extension_settings?.disabledExtensions)
            ? data.extension_settings.disabledExtensions
            : [];
        if (!tts || tts.enabled !== true || tts.auto_generation !== true
            || disabledExtensions.some(name => String(name).toLowerCase() === 'tts')) {
            return null;
        }

        const provider = String(tts.currentProvider || '');
        if (provider === 'Kokoro') {
            return { status: 'browser', provider };
        }
        if (provider === 'System') {
            return { status: 'refused', code: 'TTS_BROWSER_ONLY', provider };
        }
        if (tts.multi_voice_enabled) {
            return { status: 'refused', code: 'TTS_MULTI_VOICE_UNSUPPORTED', provider };
        }
        if (!SUPPORTED_PROVIDERS.has(provider)) {
            return { status: 'refused', code: 'TTS_PROVIDER_UNSUPPORTED', provider };
        }

        const narratorText = prepareNarratedText(data, snapshot, tts, text, speaker, delivery);
        if (!narratorText) {
            return null;
        }

        const settings = tts[provider] || {};
        const voiceMap = parseTtsVoiceMap(settings.voiceMap);
        const { entry, disabled } = resolveTtsVoiceMapEntry(voiceMap, speaker?.name, {
            defaultMarker: DEFAULT_TTS_VOICE_MARKER,
            disabledMarker: DISABLED_TTS_VOICE_MARKER,
        });
        if (disabled) {
            return null;
        }
        if (!entry || typeof entry !== 'string') {
            return { status: 'failed', error: `No TTS voice is configured for ${speaker?.name || 'this character'}.` };
        }

        if (!delivery.effectId) throw new Error('Narration requires a delivery effect identity.');
        const name = `narration:${delivery.effectId}`;
        // The shared provider step saves uncertainty before dispatch and settles
        // it only after the artifact is durable. Storage failures must propagate.
        const result = await providerStep(context, name, async () => {
            const deadline = createHostedProviderDeadline(context.signal, HOSTED_TTS_TIMEOUT_SECONDS, provider);
            try {
                const audio = await requestProviderNarration({ context, provider, settings, entry, text: narratorText, signal: deadline.signal, fetchImpl, speakerName: speaker?.name, snapshot });
                return { ok: true, ...audio };
            } catch (error) {
                if (context.signal?.aborted) throw error;
                return { ok: false, error: deadline.didTimeOut() ? deadline.timeoutError().message : String(error?.message || error) };
            } finally {
                deadline.dispose();
            }
        });
        if (result?.ok === false) return { status: 'failed', error: result.error };
        if (result?.ok !== true || typeof result.base64 !== 'string' || !/^audio\//.test(result.mimeType)) {
            throw Object.assign(new Error('The saved narration needs recovery and was left untouched.'), { status: 409 });
        }
        return { status: 'ready', job: context.job.id, artifact: `provider:${name}`, mimeType: result.mimeType };
    };
}

function readSavedSettings(context) {
    try {
        return readUserSettingsWithStatus({ user: { directories: context.directories } });
    } catch {
        return null;
    }
}

function prepareNarratedText(data, snapshot, tts, text, speaker, delivery) {
    const allowName2Display = data?.power_user?.allow_name2_display === true;
    const macros = createMacroEnvironment(snapshot?.macros || {});
    const substitute = value => {
        try {
            return macros.evaluate(value);
        } catch {
            return value;
        }
    };
    const prepared = prepareTtsNarrationText(text, tts, {
        characterName: speaker?.name || '',
        allowName2Display,
        substitute,
        displayText: delivery?.extra?.display_text || '',
    });
    return prepared && prepared.trim() ? prepared : '';
}

function substituteNarrationMacros(snapshot, value) {
    if (typeof value !== 'string' || !value) {
        return undefined;
    }
    try {
        return createMacroEnvironment(snapshot?.macros || {}).evaluate(value);
    } catch {
        return value;
    }
}

async function requestProviderNarration({ context, provider, settings, entry, text, signal, fetchImpl, speakerName, snapshot }) {
    if (provider === 'OpenAI') {
        const key = readSecret(context.directories, SECRET_KEYS.OPENAI);
        if (!key) {
            throw new Error('No OpenAI API key is saved for narration.');
        }
        const voice = OPENAI_VOICE_MATCH.test(entry) ? entry : entry.toLowerCase();
        return generateOpenAiSpeech({
            key,
            text,
            voice,
            model: settings.model,
            speed: settings.speed,
            responseFormat: settings.response_format,
            instructions: substituteNarrationMacros(snapshot, settings.characterInstructions?.[speakerName]),
            signal,
        }, { fetchImpl });
    }
    if (provider === 'OpenAI Compatible') {
        const endpoint = settings.provider_endpoint;
        if (!endpoint) {
            throw new Error('No OpenAI Compatible endpoint is configured for narration.');
        }
        const key = readSecret(context.directories, SECRET_KEYS.CUSTOM_OPENAI_TTS);
        return generateOpenAiCompatibleSpeech({
            endpoint,
            key,
            text,
            voice: entry,
            model: settings.model,
            responseFormat: settings.response_format,
            speed: settings.speed,
            signal,
        }, { fetchImpl });
    }
    if (provider === 'Pollinations') {
        const key = readSecret(context.directories, SECRET_KEYS.POLLINATIONS);
        if (!key) {
            throw new Error('No Pollinations API key is saved for narration.');
        }
        return generatePollinationsSpeech({ key, text, model: settings.model, voice: entry, signal }, { fetchImpl });
    }

    const apiKey = readSecret(context.directories, SECRET_KEYS.ELEVENLABS);
    if (!apiKey) {
        throw new Error('No ElevenLabs API key is saved for narration.');
    }
    const voiceId = await resolveElevenLabsVoiceId({ apiKey, entry, signal, fetchImpl });
    const { history } = await listElevenLabsHistory({ apiKey, signal }, { fetchImpl });
    const previous = Array.isArray(history) && history.find(item => item.text === text && item.voice_id === voiceId);
    if (previous?.history_item_id) {
        return fetchElevenLabsHistoryAudio({ apiKey, historyItemId: previous.history_item_id, signal }, { fetchImpl });
    }
    const voiceSettings = {
        stability: Number(settings.stability ?? 0.75),
        similarity_boost: Number(settings.similarity_boost ?? 0.75),
        speed: Number(settings.speed ?? 1),
    };
    if (MODERN_ELEVENLABS_MODELS.has(settings.model)) {
        voiceSettings.style = Number(settings.style_exaggeration ?? 0);
        voiceSettings.use_speaker_boost = settings.speaker_boost !== false;
    }
    const request = {
        model_id: settings.model || 'eleven_turbo_v2_5',
        text,
        voice_settings: voiceSettings,
    };
    return synthesizeElevenLabs({ apiKey, voiceId, request, signal }, { fetchImpl });
}

async function resolveElevenLabsVoiceId({ apiKey, entry, signal, fetchImpl }) {
    const { voices } = await listElevenLabsVoices({ apiKey, signal }, { fetchImpl });
    const wanted = String(entry).toLowerCase();
    const match = Array.isArray(voices)
        ? voices.find(voice => String(voice.voice_id).toLowerCase() === wanted || String(voice.name).toLowerCase() === wanted)
        : null;
    if (!match?.voice_id) {
        throw new Error(`ElevenLabs voice ${entry} was not found in the account.`);
    }
    return match.voice_id;
}
