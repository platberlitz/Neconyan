import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parse } from 'acorn';
import { loadDialog } from './prompt-media-dialog-harness.js';

// The label maps of the image review dialogs (C-6, C-5, D20) against the lists the server owns. The status and stage lists come from
// src/roleplay-image-recovery.js (E2-S). Until E2-S exports IMAGE_REVIEW_STATUSES and REPAIR_HISTORY_STAGES, the two completeness tests
// below fail on purpose, saying so. The rest runs without the server.

let env, labels;
beforeAll(async () => { env = await loadDialog(jest); labels = env.labels; });
beforeEach(() => env.reset());

const serverList = async name => {
    const recovery = await import('../src/roleplay-image-recovery.js');
    if (!Array.isArray(recovery[name])) throw new Error(`src/roleplay-image-recovery.js does not export ${name} yet (E2-S has not landed)`);
    return recovery[name];
};

describe('status and stage maps (C-6)', () => {
    test('there is one status label for each scan status, and none for anything else', async () => {
        const statuses = await serverList('IMAGE_REVIEW_STATUSES');
        const mapped = Object.keys(labels.reviewStatusLabels());
        expect([...mapped].sort()).toEqual([...statuses].sort());
        const texts = Object.values(labels.reviewStatusLabels());
        expect(new Set(texts).size).toBe(texts.length);
        for (const status of statuses) {
            expect(labels.reviewStatusLabel(status)).not.toBe(status);
            expect(labels.reviewStatusLabel(status)).not.toMatch(/-/);
        }
    });

    test('there is one stage label for each history stage, in both states of the backup', async () => {
        const stages = await serverList('REPAIR_HISTORY_STAGES');
        for (const backupAvailable of [true, false]) {
            const mapped = labels.historyStageLabels({ backupAvailable });
            expect(Object.keys(mapped).sort()).toEqual([...stages].sort());
            for (const stage of stages) expect(labels.historyStageLabel({ stage, backupAvailable })).toBe(mapped[stage]);
        }
        // Only a completed change depends on its backup: 'Completed, backup deleted' comes from the flag history already returns.
        const kept = labels.historyStageLabels({ backupAvailable: true }), deleted = labels.historyStageLabels({ backupAvailable: false });
        expect(kept.committed).toBe('Completed');
        expect(deleted.committed).toBe('Completed, backup deleted');
        for (const stage of stages.filter(stage => stage !== 'committed')) expect(kept[stage]).toBe(deleted[stage]);
        expect(labels.historyStageLabel({ stage: 'committed' })).toBe('Completed, backup deleted');
    });
});

describe('the labels themselves', () => {
    test('the English of each status and stage is the ledger\'s', () => {
        expect(labels.reviewStatusLabels()).toEqual({
            'saved-reference': 'Saved on this server', 'missing-file': 'Missing: its file is no longer on the server',
            'needs-compatible-copy': 'Needs a compatible copy: unsupported format, or larger than 2048 pixels',
            'unreadable-or-over-limit': 'Needs a compatible copy: larger than 1 MiB, or unreadable', 'embedded-image': 'Stored inside the chat file',
            'external-or-old-location': 'Linked from a website or an old location', 'invalid-gallery-selection': 'The gallery\'s chosen image is missing',
            'malformed-attachment': 'Damaged attachment', 'empty-attachment-list': 'Empty attachment list', 'other-media': 'Audio or video' });
        expect(labels.historyStageLabels()).toEqual({ committed: 'Completed', 'backup-verified': 'Prepared, not applied yet', 'native-write-pending': 'Interrupted while saving the chat',
            'staging-incomplete': 'Preparation did not finish', discarded: 'Discarded' });
    });

    test('a status or stage this page does not know shows as its own code, so nothing disappears', () => {
        expect(labels.reviewStatusLabel('a-newer-status')).toBe('a-newer-status');
        expect(labels.historyStageLabel({ stage: 'a-newer-stage' })).toBe('a-newer-stage');
        expect(labels.historyStageLabel({})).toBe('');
        expect(labels.historyStageLabel(undefined)).toBe('');
    });

    test('the labels follow the interface language: a status and a stage are translated through their keys', () => {
        env.use('pt-pt');
        env.scoped['scoped.prompt_media.RVW-36.8'] = 'Anexo danificado';
        env.scoped['scoped.prompt_media.HIS-02.1'] = 'Concluída';
        env.dictionary['Stored inside the chat file'] = 'Guardada dentro do ficheiro do chat';
        expect(labels.reviewStatusLabel('malformed-attachment')).toBe('Anexo danificado');
        expect(labels.reviewStatusLabel('embedded-image')).toBe('Guardada dentro do ficheiro do chat');
        expect(labels.historyStageLabel({ stage: 'committed', backupAvailable: true })).toBe('Concluída');
    });

    test('a scoped key missing from the scoped table shows its English, never the value of a dictionary entry with the same English', () => {
        env.use('pt-pt');
        // The scoped table is read for scoped keys only: the same English as a dictionary entry never gets an entry's value.
        // The real pt-pt supplement may hold a translation of this key, so the case needs it missing from the scoped table.
        delete env.scoped['scoped.prompt_media.HIS-02.6'];
        env.dictionary.Discarded = 'Descartado (global)';
        expect(labels.historyStageLabel({ stage: 'discarded' })).toBe('Discarded');
    });

    test('a scoped key that is present in the scoped table is read from it, not from the dictionary entry with the same English', () => {
        env.use('pt-pt');
        env.dictionary.Discarded = 'Descartado (global)';
        env.scoped['scoped.prompt_media.HIS-02.6'] = 'Descartado (so deste estado)';
        expect(labels.historyStageLabel({ stage: 'discarded' })).toBe('Descartado (so deste estado)');
    });
});

describe('dates (C-6)', () => {
    const iso = '2026-03-04T10:20:30.000Z';
    test('a date is formatted for the interface language, and an unreadable one is left out', () => {
        for (const language of ['en', 'pt-pt', 'it-it', 'de-de']) {
            expect(labels.formatChangeDate(iso, language)).toBe(new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)));
        }
        expect(labels.formatChangeDate(iso, 'de-de')).not.toBe(labels.formatChangeDate(iso, 'pt-pt'));
        expect(labels.formatChangeDate(iso, 'not a language tag!')).toBe(labels.formatChangeDate(iso, 'en'));
        expect(labels.formatChangeDate(iso, '')).toBe(labels.formatChangeDate(iso, 'en'));
        for (const bad of [null, undefined, '', 'yesterday']) expect(labels.formatChangeDate(bad, 'en')).toBe('');
    });
});

describe('worker error codes (C-5)', () => {
    const workerSource = readFileSync(new URL('../public/scripts/prompt-image-conversion-worker.js', import.meta.url), 'utf8');
    const codesInWorker = () => {
        const found = new Set(), strings = [];
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (node.type === 'CallExpression' && node.callee.name === 'fail' && node.arguments[0]?.type === 'Literal') found.add(node.arguments[0].value);
            if (node.type === 'NewExpression' && node.callee.name === 'Error' && node.arguments[0]?.type === 'Literal') strings.push(node.arguments[0].value);
            for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
        };
        visit(parse(workerSource, { ecmaVersion: 'latest', sourceType: 'module' }));
        return { found, strings };
    };

    test('each code the worker can fail with has its sentence, and each sentence is reachable', () => {
        const { found } = codesInWorker();
        const mapped = Object.keys(labels.workerErrorMessages());
        // 'failed' is for anything the worker did not expect, so the worker never names it.
        expect([...found].sort()).toEqual(mapped.filter(code => code !== 'failed').sort());
        expect(mapped).toContain('failed');
    });

    test('the worker posts a code and carries no sentence of its own', () => {
        expect(codesInWorker().strings).toEqual([]);
        // What the worker posts for each failure, a browser error with a numeric code included, is run in prompt-media-conversion-worker.test.js.
        expect(workerSource).not.toMatch(/postMessage\(\{ error:/);
    });

    test('each code maps to its ledger sentence', () => {
        expect(labels.workerErrorMessages()).toEqual({
            'too-large': 'Choose an image smaller than 16 MiB.', animated: 'Animated images cannot be converted. Choose a still image.',
            'png-incomplete': 'This PNG file is incomplete. Choose another image.', 'webp-incomplete': 'This WebP file is incomplete. Choose another image.',
            'jpeg-damaged': 'This JPEG file is damaged. Choose another image.', 'jpeg-incomplete': 'This JPEG file is incomplete. Choose another image.',
            unsupported: 'Choose a PNG, JPEG or WebP still image of at most 16 million pixels.', 'too-many-pixels': 'This image has more than 16 million pixels. Choose a smaller one.',
            'still-too-large': 'Even converted, this image is larger than 1 MiB. Choose a smaller one.', 'result-too-large': 'The converted image is too large. Choose a smaller one.',
            failed: 'This browser could not convert the image. Choose a PNG, JPEG or WebP file instead.' });
        for (const code of [undefined, null, '', 'nothing', 'constructor', '__proto__']) expect(labels.workerErrorMessage(code)).toBe(labels.workerErrorMessages().failed);
    });

    test('a sentence reaches the page through the lookup, so a translation shows', () => {
        env.dictionary['This PNG file is incomplete. Choose another image.'] = 'Este ficheiro PNG está incompleto. Escolha outra imagem.';
        expect(labels.workerErrorMessage('png-incomplete')).toBe('Este ficheiro PNG está incompleto. Escolha outra imagem.');
    });
});

describe('text helpers', () => {
    test('fillTemplate fills the holes in order and inserts a value exactly as written', () => {
        expect(labels.fillTemplate('Message ${0}, alternative ${1}, image ${2}', 1, 2, 3)).toBe('Message 1, alternative 2, image 3');
        expect(labels.fillTemplate('Name: ${0}', '$& and $1 and ${1}')).toBe('Name: $& and $1 and ${1}');
        expect(labels.fillTemplate('Only ${0}', 'x', 'unused')).toBe('Only x');
        expect(labels.fillTemplate('Missing ${1}', 'x')).toBe('Missing ${1}');
        expect(labels.fillTemplate('Zero ${0}', 0)).toBe('Zero 0');
    });

    test('splitAtHole gives the two halves around a single hole', () => {
        expect(labels.splitAtHole('Before ${0} after.')).toEqual(['Before ', ' after.']);
        expect(labels.splitAtHole('No hole.')).toEqual(['No hole.', '']);
    });

    test('description sources: only ones with text, typing always, and a saved source with no text is kept and flagged', () => {
        const offered = issue => labels.descriptionSourceOptions(issue);
        expect(offered({}).options.map(option => option.value)).toEqual(['custom']);
        expect(offered({ sources: { 'media-title': true, 'message-title': true } }).options.map(option => option.value)).toEqual(['custom', 'media-title', 'message-title']);
        expect(offered({ mode: 'caption', caption: { source: 'media-title' }, sources: { 'media-title': false, 'message-title': true } })).toEqual({
            options: [{ value: 'custom', label: 'Type a description' }, { value: 'media-title', label: 'The image\'s saved description (no longer available)' },
                { value: 'message-title', label: 'The message\'s saved title' }], selected: 'media-title', unavailable: 'media-title' });
        // A caption left over from another choice is not a saved choice: nothing is flagged and typing is selected.
        expect(offered({ mode: 'include', caption: { source: 'message-title' }, sources: { 'media-title': false, 'message-title': false } })).toMatchObject({ selected: 'custom', unavailable: null });
        // A typed description stays selected, and a source that has text keeps its ordinary label.
        expect(offered({ mode: 'caption', caption: { source: 'custom', text: 'x' }, sources: { 'media-title': true } })).toMatchObject({ selected: 'custom', unavailable: null });
        expect(offered({ mode: 'caption', caption: { source: 'message-title' }, sources: { 'message-title': true } })).toMatchObject({ selected: 'message-title', unavailable: null });
        // Only exactly true counts as text.
        expect(offered({ sources: { 'media-title': 'yes', 'message-title': 1 } }).options).toHaveLength(1);
    });

    test('batch results: the sentences of BAT-09, the count through its scoped key', () => {
        expect(labels.batchResultText.saved()).toBe('Saved');
        expect(labels.batchResultText.noImages()).toBe('No images stored in the chat');
        expect(labels.batchResultText.copiesSaved(3)).toBe('Compatible copies saved: 3');
        env.scoped['scoped.prompt_media.BAT-09.3'] = 'Cópias compatíveis guardadas: ${0}';
        expect(labels.batchResultText.copiesSaved(3)).toBe('Cópias compatíveis guardadas: 3');
    });
});
