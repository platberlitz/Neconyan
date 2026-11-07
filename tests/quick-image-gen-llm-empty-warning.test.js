import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, test } from '@jest/globals';

// Quick Image Gen is too large to load, so the empty-warning helpers are cut out of its
// source as they stand and run against no stand-ins: these five functions are self-contained.
const source = fs.readFileSync(new URL('../public/scripts/extensions/quick-image-gen/index.js', import.meta.url), 'utf8');
const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const cutFunction = name => {
    const found = syntax.body.find(row => row.id?.name === name);
    if (!found) throw new Error(`missing ${name}`);
    return source.slice(found.start, found.end);
};

const { extractLLMResponseDetails, buildLLMEmptyPromptWarning } = vm.runInNewContext(`
    ${cutFunction('summarizeLLMValueShape')}
    ${cutFunction('appendLLMTextSegments')}
    ${cutFunction('extractLLMResponseDetails')}
    ${cutFunction('getLLMHelperRouteDescription')}
    ${cutFunction('buildLLMEmptyPromptWarning')}
    ({ extractLLMResponseDetails, buildLLMEmptyPromptWarning });
`, {});

describe('Quick Image Gen empty LLM reply warnings', () => {
    test('an empty content string with a refusal finish reason names the refusal', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'prohibited_content' }],
        });
        expect(meta.extractionStatus).toBe('empty_string');
        expect(meta.finishReason).toBe('prohibited_content');
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, '', ''))
            .toBe('LLM Override\'s model refused the request (finish reason: prohibited_content), so the raw prompt was used.');
    });

    test('other provider refusal finish reasons are named too', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
        });
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, meta.text, ''))
            .toBe('LLM Override\'s model refused the request (finish reason: content_filter), so the raw prompt was used.');
    });

    test('structured content without text plus a refusal finish reason names the refusal', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: { block: true } }, finish_reason: 'prohibited_content' }],
        });
        expect(meta.extractionStatus).toBe('no_text_parts');
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, '', ''))
            .toBe('LLM Override\'s model refused the request (finish reason: prohibited_content), so the raw prompt was used.');
    });

    test('an empty choices array reports no response choices', () => {
        const meta = extractLLMResponseDetails({ choices: [] });
        expect(meta.extractionStatus).toBe('empty_choices');
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, '', ''))
            .toBe('LLM Override returned no response choices, so the raw prompt was used.');
    });

    test('an empty reply without a refusal finish reason keeps the generic wording', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        });
        expect(meta.extractionStatus).toBe('empty_string');
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, '', ''))
            .toBe('LLM Override returned no text, so the raw prompt was used.');
    });

    test('a cut-off reply keeps the raise-max-tokens wording', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: '1girl, so' }, finish_reason: 'length' }],
        });
        expect(buildLLMEmptyPromptWarning({ ...meta, route: 'llm_override' }, meta.text, '1girl, so'))
            .toContain('LLM Override\'s reply was cut off before it finished');
    });

    test('a successful reply still extracts its text', () => {
        const meta = extractLLMResponseDetails({
            choices: [{ message: { role: 'assistant', content: '1girl, solo, smile' }, finish_reason: 'stop' }],
        });
        expect(meta.text).toBe('1girl, solo, smile');
        expect(meta.extractionStatus).toBe('text');
    });
});
