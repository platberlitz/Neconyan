import { getActiveGenerationAcknowledgement, saveChatConditional, saveSettings } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { getCurrentUserHandle } from '../../user.js';
import { getOperationClient, mountOperationRecovery } from '../../operations-client.js';
import { generateWebLlmChatPrompt, isWebLlmSupported } from '../shared.js';
import { WebLlmVectorProvider } from './webllm.js';

const active = new Map();
const localResults = new Map();
const webllm = new WebLlmVectorProvider();

function locator() {
    const context = getContext();
    const chat = context.getCurrentChatId();
    if (!chat) return null;
    if (context.groupId != null) return { group: true, chat };
    const avatar = context.characters[context.characterId]?.avatar;
    return avatar ? { group: false, avatar, chat } : null;
}

async function handleBrowserWork(client, key, signal) {
    const record = await client.read(key);
    const work = record.browserWork;
    if (!work) return;
    signal?.throwIfAborted();
    if (!isWebLlmSupported()) throw new Error('Open this saved vector operation in a browser with WebLLM support to finish its local model step.');
    const cacheKey = `${getCurrentUserHandle()}:${work.id}`;
    let computation = localResults.get(cacheKey);
    if (!computation) {
        computation = (async () => {
            if (work.kind === 'webllm.embedding') return webllm.embedTexts(work.input.texts, work.input.model);
            if (work.kind === 'webllm.summary') return generateWebLlmChatPrompt(work.input.messages);
            throw new Error('The saved browser computation is unsupported.');
        })();
        localResults.set(cacheKey, computation);
        computation.catch(() => localResults.delete(cacheKey));
    }
    const result = await computation;
    signal?.throwIfAborted();
    await client.request(`/api/operations/records/${encodeURIComponent(key)}/browser-result`, {
        method: 'POST', body: JSON.stringify({ id: work.id, result }),
    });
    localResults.delete(cacheKey);
}

/** The only page-owned part of a native reply is its explicitly selected WebLLM computation. */
export async function serviceVectorBrowserWork(job, { signal } = {}) {
    if (job.type !== 'operations.vectors' || job.state !== 'waiting' || !job.resume?.browserId || job.cancellation?.requested) return;
    const client = await getOperationClient();
    await handleBrowserWork(client, job.intent.operations.key, signal);
}

export async function runVectorWork(action, input = {}, { signal, onProgress, automatic = false } = {}) {
    const owner = getCurrentUserHandle();
    const selected = locator();
    const scope = `vectors:${action}:${JSON.stringify({ selected, ...input })}`;
    const activeKey = `${owner}:${scope}`;
    if (active.has(activeKey)) return active.get(activeKey);
    const client = await getOperationClient();
    const promise = client.run(action === 'purge' ? 'vector-purge' : 'vectors', action === 'purge' ? input : { ...input, action }, {
        scope, signal, prepareInput: async value => {
            if (owner !== getCurrentUserHandle() || JSON.stringify(selected) !== JSON.stringify(locator())) throw new Error('The account or chat changed before vector work was accepted.');
            if (!automatic && !await saveSettings(0, { returnResult: true })) throw new Error('Save the vector settings before starting this work.');
            if (selected) await saveChatConditional({ throwOnError: true, throwOnPromptError: true });
            if (owner !== getCurrentUserHandle() || JSON.stringify(selected) !== JSON.stringify(locator())) throw new Error('The account or chat changed before vector work was accepted.');
            const settings = getContext().extensionSettings.vectors || {};
            const maySummarize = ['sync-chat', 'prompt'].includes(action) || action === 'query' && input.queryKind === 'chat';
            const acknowledgement = maySummarize && settings.summarize && settings.summary_source !== 'webllm' ? getActiveGenerationAcknowledgement() : null;
            return action === 'purge' ? value : { ...value, ...(selected ? { locator: selected } : {}), acknowledgement };
        },
        onProgress: async (progress, job) => {
            await onProgress?.(progress, job);
            if (job.state === 'waiting' && job.resume?.browserId) await handleBrowserWork(client, job.intent.operations.key, signal);
        },
    }).then(record => record.result);
    active.set(activeKey, promise);
    try { return await promise; } finally { active.delete(activeKey); }
}

export function mountSavedVectorWork(container) {
    const wrapper = document.createElement('div');
    const select = document.createElement('select'); select.className = 'text_pole'; select.setAttribute('aria-label', 'Saved vector work');
    const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'menu_button'; stop.textContent = 'Stop vector work'; stop.style.display = 'none';
    const status = document.createElement('div'); status.setAttribute('role', 'status');
    wrapper.append(select, stop, status); container.append(wrapper); mountOperationRecovery(wrapper);
    const ready = getOperationClient();
    let controller;
    const refresh = async () => {
        if (controller) return;
        const client = await ready;
        const records = [...await client.list('vectors'), ...await client.list('vector-purge')].sort((a, b) => b.createdAt - a.createdAt);
        const selected = select.value;
        select.replaceChildren(new Option('Choose saved vector work', ''), ...records.map(record => new Option(`${record.label} · ${new Date(record.createdAt).toLocaleString()} · ${record.state}`, record.key)));
        if (records.some(record => record.key === selected)) select.value = selected;
    };
    const report = error => { status.textContent = error.cancelled ? 'Vector work stopped.' : error.message; };
    select.addEventListener('focus', () => { void refresh().catch(report); });
    stop.addEventListener('click', () => controller?.abort('user-stop'));
    select.addEventListener('change', async () => {
        if (controller || !select.value) return;
        controller = new AbortController(); select.disabled = true; stop.style.display = '';
        try {
            const client = await ready;
            const record = await client.observe(await client.read(select.value), { signal: controller.signal,
                onProgress: async (_progress, job) => {
                    status.textContent = job.stage;
                    if (job.state === 'waiting' && job.resume?.browserId) await handleBrowserWork(client, select.value, controller.signal);
                } });
            status.textContent = record.kind === 'vector-purge' ? `${record.result.removed} saved vector files cleared.`
                : `${record.result.collections?.length ?? Object.keys(record.result).length} saved vector collections ready.`;
        } catch (error) { report(error); } finally { controller = null; select.disabled = false; stop.style.display = 'none'; }
    });
    void refresh().catch(report);
}
