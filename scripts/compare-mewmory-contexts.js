#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { assembleContext } = await import('../src/mewmory/context.js');
const { sourceAt, sourceFingerprint } = await import('../src/mewmory/core.js');
const { lexicalSearch, searchDocuments } = await import('../src/mewmory/search.js');
const { getCounter } = await import('../src/mewmory/tokens.js');

const [exportFile, baselineFile, outputDirectory, budgetArgument = '6000', tokenizer = 'cl100k_base'] = process.argv.slice(2);
try {
    if (!exportFile || !baselineFile || !outputDirectory) {
        throw new Error('Usage: npm run compare:mewmory -- export.json baseline-summary.txt output-directory [memory-budget] [tokenizer]');
    }
    const backup = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    if (backup.format !== 'mewmory-export-1' || !Array.isArray(backup.state?.records)) throw new Error('Choose a Mewmory export.');
    const budget = Number(budgetArgument);
    if (!Number.isInteger(budget) || budget < 256 || budget > 64000) throw new Error('Choose a memory budget from 256 to 64000 tokens.');
    const state = backup.state;
    const baseline = fs.readFileSync(baselineFile, 'utf8');
    const counter = await getCounter(tokenizer);
    if (counter.count(baseline) > budget) throw new Error('The supplied baseline summary exceeds the comparison budget.');
    const documents = searchDocuments(state);
    const query = state.timeline.slice(-8).map(ref => sourceAt(state, ref).text).join('\n');
    const selectedIds = new Set(state.recalls.at(-1)?.selections.map(selection => selection.recordId) || []);
    for (const id of state.recalls.at(-1)?.forcedIds || []) selectedIds.add(id);
    if (!selectedIds.size) throw new Error('Preview recall before exporting so this comparison uses a real saved selection.');
    const full = assembleContext(state, documents.filter(document => selectedIds.has(document.id)), { counter, memoryTokens: budget });
    const objectiveDocuments = documents.filter(document => !['interview', 'overview'].includes(document.kind));
    const objective = assembleContext(state, lexicalSearch(objectiveDocuments, query, 24).map(result => result.document), { counter, memoryTokens: budget });
    const variants = {
        baseline: { npcText: full.npcText, memoryText: baseline },
        objective,
        pawspective: full,
    };
    const report = {
        sourceFingerprint: sourceFingerprint(state), tokenizer: counter.name, memoryBudget: budget,
        selection: 'Saved read-only recall for Pawspective; independent lexical recall for objective-only.',
        qualityScores: null,
        note: 'These are matched-budget context artifacts for the same writer. Assess continuity, unsupported claims, voice and repetition separately; token counts do not measure RP quality.',
        variants: {},
    };
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const name of [...Object.keys(variants), 'report']) {
        const filename = path.join(outputDirectory, name + (name === 'report' ? '.json' : '.txt'));
        if (fs.existsSync(filename)) throw new Error('Choose a fresh output directory; an artifact already exists: ' + filename);
    }
    for (const [name, variant] of Object.entries(variants)) {
        const content = [variant.npcText, variant.memoryText].filter(Boolean).join('\n\n');
        report.variants[name] = { npcTokens: counter.count(variant.npcText), memoryTokens: counter.count(variant.memoryText), totalTokens: counter.count(content) };
        fs.writeFileSync(path.join(outputDirectory, name + '.txt'), content, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
