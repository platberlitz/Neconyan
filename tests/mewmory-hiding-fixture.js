import { defaultConfig, saveConfig } from '../src/mewmory/models.js';
import { mutateState } from '../src/mewmory/store.js';

/** Turn Mewmory on for one saved chat with a deterministic local writer tokenizer. */
export function enableMewmoryHiding(directories, locator, { autoHide = true, autoHideTokens = 30000 } = {}) {
    saveConfig(directories, { ...defaultConfig(), autoHide, autoHideTokens, writerTokenizer: 'o200k_base' });
    mutateState(directories, locator, state => { state.enabled = true; }, 0);
}
