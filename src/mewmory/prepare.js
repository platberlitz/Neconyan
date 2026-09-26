import { fail, list, refKey, sourceEligible, text } from './core.js';
import { generationFingerprint } from './context.js';
import { readConfig } from './models.js';
import { processingVersion } from './processing.js';
import { recall } from './retrieval.js';
import { loadCurrentState } from './sources.js';
import { mutateState, normalizeLocator, readChat } from './store.js';
import { getCounter } from './tokens.js';

export async function prepareMewmoryPrompt(directories, body, signal, {
    loadState = loadCurrentState, mutate = mutateState, readSource = readChat, scheduleBackground = true, readConfiguration = readConfig,
} = {}) {
    const locator = normalizeLocator(body.locator);
    const config = readConfiguration(directories);
    const state = await loadState(directories, locator);
    if (!state.enabled) return { enabled: false, excludedIndices: [], npcText: '', memoryText: '' };
    const snapshot = generationFingerprint(state, config);
    const source = readSource(directories, locator);
    if (body.integrity && source.metadata.integrity !== body.integrity) {
        fail('This chat changed in another tab. Reload the chat, then send again.', 409);
    }
    const offset = state.inheritedTimeline?.length || 0;
    const counter = await getCounter(config.writerTokenizer, body.tokenizer || {});
    let previous = -1;
    const history = list(body.history, 'Prompt history', 100000).map(item => {
        if (!Number.isInteger(item.index) || item.index <= previous || item.index >= source.messages.length) fail('The chat history arrived in the wrong order. Reload the chat and send again.');
        previous = item.index;
        return { index: item.index, tokens: counter.count(text(item.text, 'History text', 2000000, true)) + 4 };
    });
    const asOf = history.length ? history.at(-1).index + offset : offset - 1;
    const startForWindow = target => {
        let tokens = 0;
        let index = history.length;
        while (index > 0) {
            const next = history[index - 1].tokens;
            if (index < history.length && tokens + next > target) break;
            tokens += next;
            index--;
        }
        return index;
    };
    const desiredStart = config.excludeHistory ? startForWindow(config.historyWindow) : 0;
    const policy = processingVersion(config);
    const excludedIndices = [];
    for (const item of history.slice(0, desiredStart)) {
        const ref = state.timeline[item.index + offset];
        if (!ref || (sourceEligible(state, ref) && state.checkpoints[refKey(ref)] !== policy)) break;
        excludedIndices.push(item.index);
    }
    const context = await recall(directories, locator, { asOf, tokenizer: body.tokenizer || {}, signal, local: true }, { loadState, mutate, scheduleBackground, readConfiguration });
    if (generationFingerprint(await loadState(directories, locator), readConfiguration(directories)) !== snapshot) {
        fail('The chat, Mewmory settings, or a memory you edited changed while the reply was being prepared. Reload and send again.', 409);
    }
    const excluded = new Set(excludedIndices);
    const historyUsage = {
        originalTokens: history.reduce((sum, item) => sum + item.tokens, 0),
        retainedTokens: history.filter(item => !excluded.has(item.index)).reduce((sum, item) => sum + item.tokens, 0),
        target: config.historyWindow, excludedMessages: excluded.size, waitingForPreservation: excluded.size < desiredStart,
    };
    mutate(directories, locator, current => {
        if (current.preview?.fingerprint === context.fingerprint) current.preview.history = historyUsage;
    });
    return {
        ...context, excludedIndices,
        history: historyUsage,
    };
}
