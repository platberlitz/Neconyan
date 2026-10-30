import { refKey, syncSources } from '../src/mewmory/core.js';
import { defaultConfig, readConfig, saveConfig } from '../src/mewmory/models.js';
import { processingVersion } from '../src/mewmory/processing.js';
import { readContextSourcesSync } from '../src/mewmory/sources.js';
import { mutateState, readChatShared, readStateShared, sourceSyncOptions } from '../src/mewmory/store.js';

/**
 * Turn Mewmory on for one saved chat with a deterministic local writer tokenizer.
 * The Facts and events reader is switched on (without reading automatically)
 * and by default every message already saved is marked as read, as a finished
 * extraction would leave it, because hiding never removes unread messages.
 */
export function enableMewmoryHiding(directories, locator, { autoHide = true, autoHideTokens = 30000, remembered = true } = {}) {
    const config = defaultConfig();
    Object.assign(config.roles.extractor, { enabled: true, endpoint: 'http://127.0.0.1:1/v1', model: 'test' });
    saveConfig(directories, { ...config, autoUpdate: false, autoHide, autoHideTokens, writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
    if (remembered) rememberSavedChat(directories, locator);
}

/** Mark every message currently saved in the chat as read by Mewmory. */
export function rememberSavedChat(directories, locator) {
    const source = readChatShared(directories, locator);
    const context = readContextSourcesSync(directories, locator, readStateShared(directories, locator), source);
    mutateState(directories, locator, state => {
        syncSources(state, source.messages, context, sourceSyncOptions(directories, source.messages));
        const version = processingVersion(readConfig(directories));
        for (const ref of state.timeline) state.checkpoints[refKey(ref)] = version;
    });
}
