import { isKimiK3Model } from '../openai-model-capabilities.js';
import { joinHelperPartialPrefill } from '../extensions/helper-prefill.js';

export function scratchpadPrefill(settings = {}, model = '') {
    const partial = isKimiK3Model(model);
    const text = partial && settings.partialPrefill?.trim() ? settings.partialPrefill : settings.prefill || '';
    const thinking = text.match(/^\s*<think>[\s\S]*?(?:<\/think>|$)/);
    return { text, partial, reply: thinking ? text.slice(thinking[0].length).trimStart() : text };
}

export const joinScratchpadPrefill = joinHelperPartialPrefill;
