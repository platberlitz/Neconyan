import fetch from 'node-fetch';
import { getConfigValue } from '../util.js';
import { setAdditionalHeadersByType } from '../additional-headers.js';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { getGoogleApiConfigForSettings } from '../endpoints/google.js';
import { requestOpenAIBatchVector } from '../vectors/openai-vectors.js';
import { getCohereBatchVector } from '../vectors/cohere-vectors.js';
import { getNomicAIBatchVector } from '../vectors/nomicai-vectors.js';
import { getLlamaCppBatchVector } from '../vectors/llamacpp-vectors.js';
import { getVllmBatchVector } from '../vectors/vllm-vectors.js';
import { getOllamaBatchVector } from '../vectors/ollama-vectors.js';
import { getMakerSuiteBatchVector, getVertexBatchVector } from '../vectors/google-vectors.js';
import { getTransformersBatchVector } from '../vectors/embedding.js';
import { readEmbeddingResponse } from '../vectors/common.js';
import { providerStep, providerNotDispatched, providerRefused, isDefiniteProviderRefusal, readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { roleplayHash } from '../roleplay-store.js';
import { readLabSettings } from '../labs/sources.js';
import { operationError, withOperation } from './store.js';
import { requestBrowserWork } from './browser-work.js';

const models = {
    transformers: '', openai: 'text-embedding-ada-002', mistral: 'mistral-embed',
    togetherai: 'togethercomputer/m2-bert-80M-32k-retrieval', nomicai: 'nomic-embed-text-v1.5',
    cohere: 'embed-english-v3.0', electronhub: 'text-embedding-3-small', openrouter: 'openai/text-embedding-3-large',
    chutes: 'chutes-qwen-qwen3-embedding-8b', nanogpt: 'text-embedding-3-small', siliconflow: 'Qwen/Qwen3-Embedding-0.6B',
    workers_ai: '@cf/baai/bge-m3', ollama: 'mxbai-embed-large', vllm: '', llamacpp: '', koboldcpp: '',
    palm: 'text-embedding-005', vertexai: 'text-embedding-005', webllm: '',
};
const secrets = { openai: 'OPENAI', mistral: 'MISTRALAI', togetherai: 'TOGETHERAI', nomicai: 'NOMICAI',
    cohere: 'COHERE', electronhub: 'ELECTRONHUB', openrouter: 'OPENROUTER', chutes: 'CHUTES', nanogpt: 'NANOGPT',
    siliconflow: 'SILICONFLOW', workers_ai: 'WORKERS_AI', palm: 'MAKERSUITE' };
const remote = new Set(['llamacpp', 'vllm', 'ollama', 'koboldcpp']);

/** Store only connection fingerprints; credentials are resolved again immediately before dispatch. */
export function captureVectorPolicy(base, saved = readLabSettings(base)) {
    const options = saved.extension_settings?.vectors || {};
    const source = String(options.source || 'transformers');
    if (!Object.hasOwn(models, source)) throw operationError('The saved vector provider is unavailable.', 400);
    const google = source === 'palm' || source === 'vertexai';
    const model = source === 'transformers' ? String(getConfigValue('extensions.models.embedding', ''))
        : ['mistral', 'nomicai', 'llamacpp', 'koboldcpp'].includes(source) ? models[source]
            : String(options[google ? 'google_model' : `${source}_model`] ?? models[source]);
    const settings = { model };
    const credentials = {};
    if (secrets[source]) {
        credentials.key = readSecret(base.directories, SECRET_KEYS[secrets[source]]);
        if (!credentials.key) throw operationError('The saved vector provider key is unavailable.', 400);
    }
    if (remote.has(source)) {
        const address = options.use_alt_endpoint ? options.alt_endpoint_url : saved.textgenerationwebui_settings?.server_urls?.[source];
        let url;
        try { url = new URL(address); } catch { throw operationError('Save a valid vector provider address first.', 400); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw operationError('The vector provider address is invalid.', 400);
        settings.apiUrl = url.toString();
        setAdditionalHeadersByType(credentials, source, settings.apiUrl, base.directories);
        if (['ollama', 'vllm'].includes(source) && !model) throw operationError('Choose a vector model first.', 400);
    }
    if (source === 'ollama') settings.keep = Boolean(options.ollama_keep);
    if (google) {
        const chat = saved.oai_settings || {};
        settings.google = { api: source === 'palm' ? 'makersuite' : 'vertexai', vertexai_auth_mode: chat.vertexai_auth_mode || 'express',
            vertexai_region: chat.vertexai_region || 'us-central1', vertexai_express_project_id: chat.vertexai_express_project_id || '' };
        if (source === 'vertexai') {
            credentials.key = readSecret(base.directories, settings.google.vertexai_auth_mode === 'full'
                ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT : SECRET_KEYS.VERTEXAI);
            if (!credentials.key) throw operationError('The saved Vertex AI vector credentials are unavailable.', 400);
        }
    }
    if (source === 'siliconflow') settings.urlOverride = saved.oai_settings?.siliconflow_endpoint === 'cn' ? 'https://api.siliconflow.cn/v1' : null;
    if (source === 'workers_ai') {
        const id = saved.oai_settings?.workers_ai_account_id;
        if (!id) throw operationError('Save the Workers AI account ID first.', 400);
        settings.urlOverride = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}/ai/v1`;
    }
    return { source, settings, credentialsHash: roleplayHash(credentials) };
}

function validate(result, expected) {
    if (!Array.isArray(result) || result.length !== expected) throw operationError('The vector provider returned a different number of vectors.', 502);
    const dimension = result[0]?.length;
    if (result.some(vector => !Array.isArray(vector) || !dimension || dimension > 65536 || vector.length !== dimension
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || !vector.some(value => value !== 0))) {
        throw operationError('The vector provider returned invalid vectors. Its outcome will not be repeated automatically.', 502);
    }
    return result;
}

/** One bounded provider request, so no completed earlier batch can be repeated after a crash. */
export async function vectorBatch(context, plan, step, texts, { isQuery = false, fetchImpl = fetch, beforeDispatch = () => {} } = {}) {
    if (!Array.isArray(texts) || texts.length > 10 || texts.some(text => typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024)) {
        throw operationError('The vector batch is too large.', 413);
    }
    const artifact = `vector-result:${step}`;
    const saved = readArtifact(context.directories, context.job.id, artifact);
    const identity = roleplayHash({ policy: plan.policy, texts, isQuery });
    if (saved !== undefined) {
        if (saved.identity !== identity) throw operationError('The saved vector request changed.');
        return saved;
    }
    const { source, settings } = plan.policy;
    let config;
    const verify = () => withOperation(context, ({ base, lease }) => {
        const current = captureVectorPolicy(base);
        if (roleplayHash(current) !== roleplayHash(plan.policy)) throw operationError('The accepted vector connection changed.');
        beforeDispatch(lease);
    });
    try {
        verify();
        if (source === 'webllm') {
            const vectors = requestBrowserWork(context, `vectors:${step}`, 'webllm.embedding', { texts, model: settings.model, isQuery });
            const result = { identity, model: settings.model, vectors: validate(vectors, texts.length) };
            writeArtifact(context.directories, context.job.id, artifact, result);
            return result;
        }
        if (source === 'palm' || source === 'vertexai') config = await getGoogleApiConfigForSettings(context.directories, settings.google,
            settings.model, source === 'palm' ? 'batchEmbedContents' : 'predict');
        verify();
    } catch (error) { throw providerNotDispatched(error); }
    const run = async () => {
        try { verify(); } catch (error) { throw providerNotDispatched(error); }
        const options = { fetchImpl, signal: context.signal, config };
        let vectors; let model = settings.model;
        try {
            switch (source) {
                case 'transformers': vectors = await getTransformersBatchVector(texts); break;
                case 'nomicai': vectors = await getNomicAIBatchVector(texts, source, context.directories, options); break;
                case 'cohere': vectors = await getCohereBatchVector(texts, isQuery, context.directories, model, options); break;
                case 'llamacpp': vectors = await getLlamaCppBatchVector(texts, settings.apiUrl, context.directories, options); break;
                case 'vllm': vectors = await getVllmBatchVector(texts, settings.apiUrl, model, context.directories, options); break;
                case 'ollama': vectors = await getOllamaBatchVector(texts, settings.apiUrl, model, settings.keep, context.directories, options); break;
                case 'palm': vectors = await getMakerSuiteBatchVector(texts, model, null, options); break;
                case 'vertexai': vectors = await getVertexBatchVector(texts, model, null, options); break;
                case 'koboldcpp': {
                    const url = new URL(settings.apiUrl); url.pathname = '/api/extra/embeddings';
                    const headers = {}; setAdditionalHeadersByType(headers, source, settings.apiUrl, context.directories);
                    const data = await readEmbeddingResponse(await fetchImpl(url, { method: 'POST', signal: context.signal,
                        headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ input: texts }) }), 'KoboldCpp');
                    if (!Array.isArray(data.data)) throw operationError('KoboldCpp did not return vectors.', 502);
                    model = String(data.model || 'unknown');
                    vectors = data.data.map(value => Array.isArray(value) ? value[0] : value).sort((a, b) => a.index - b.index).map(value => value.embedding);
                    break;
                }
                default: vectors = await requestOpenAIBatchVector(texts, source, context.directories, model, settings.urlOverride, options);
            }
        } catch (error) {
            if (error.embeddingResponse && isDefiniteProviderRefusal(error.status)) throw providerRefused(error);
            throw error;
        }
        return { identity, model, vectors: validate(vectors, texts.length) };
    };
    const result = source === 'transformers' ? await run() : await providerStep(context, `vectors:${step}`, run);
    writeArtifact(context.directories, context.job.id, artifact, result);
    return result;
}
