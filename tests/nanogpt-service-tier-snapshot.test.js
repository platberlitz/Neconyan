/* eslint-disable playwright/no-standalone-expect */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { createChatGenerationParameters } from '../public/scripts/chat-provider-parameters.js';
import { getNanoGptServiceTiers, isNanoGptPayg } from '../public/scripts/service-tiers.js';

const openAiSource = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Run the real declarations from openai.js, like the other host-wiring tests.
function declaration(name) {
    const match = openAiSource.match(new RegExp(`^(?:export )?((?:async )?function ${name}\\([^]*?^})`, 'm'));
    if (!match) throw new Error(`Missing function in openai.js: ${name}`);
    return match[1];
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

function makeRuntime(settings, lookup) {
    const stub = () => undefined;
    const context = createContext({
        oai_settings: settings, nanoGptModelList: [], chat_completion_sources: { NANOGPT: 'nanogpt' },
        fetch: lookup, getRequestHeaders: () => ({}), AbortSignal,
        isNanoGptPayg, getNanoGptServiceTiers, createChatGenerationParameters,
        getChatReasoningRoute: stub, appendAutoAppendReasoningInstruction: messages => messages, power_user: {},
        name1: 'User', name2: 'Character', getGroupNames: () => [], shouldRequestReasoning: stub,
        getReasoningEffort: stub, getVerbosity: stub, ToolManager: { canPerformToolCalls: () => false },
        REVERSE_PROXY_SUPPORTED_SOURCES: [], getGroupSpeakerStopStrings: stops => stops,
        getCustomStoppingStrings: () => [], substituteParams: value => value, getChatCompletionSamplerMetadata: stub,
    });
    for (const name of ['getNanoGptServiceTier', 'createGenerationParameters']) runInContext(declaration(name), context);
    return context;
}

const model = { id: 'fixture', subscription: { included: true }, supported_service_tiers: ['priority'] };

describe('NanoGPT service tier during a cold model lookup', () => {
    test.each([
        ['nothing changes', { nanogpt_payg_override: true }, () => {}, true, 'priority'],
        ['the pay-as-you-go override is switched off', { nanogpt_payg_override: true }, live => { live.nanogpt_payg_override = false; }, true, 'priority'],
        ['the pay-as-you-go override is switched on', { nanogpt_payg_override: false }, live => { live.nanogpt_payg_override = true; }, false, undefined],
        ['a provider is allowed', { nanogpt_payg_override: false, nanogpt_allowed_providers: [] }, live => { live.nanogpt_allowed_providers.push('A'); }, false, undefined],
        ['the tier is cleared', { nanogpt_payg_override: true }, live => { live.nanogpt_service_tier = ''; }, true, 'priority'],
    ])('sends the billing choice and tier from when the request started when %s', async (_label, start, change, payg, tier) => {
        const settings = { chat_completion_source: 'nanogpt', nanogpt_service_tier: 'priority', ...start };
        const entered = deferred();
        const gate = deferred();
        const lookup = jest.fn(async () => {
            entered.resolve();
            await gate.promise;
            return { ok: true, json: async () => ({ data: [model] }) };
        });
        const context = makeRuntime(settings, lookup);
        const pending = context.createGenerationParameters(settings, 'fixture', 'normal', [{ role: 'user', content: 'Hello' }]);
        await entered.promise;
        change(settings);
        gate.resolve();
        const { generate_data: data } = await pending;
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(data.nanogpt_payg_override).toBe(payg);
        expect(data.service_tier).toBe(tier);
    });
});
