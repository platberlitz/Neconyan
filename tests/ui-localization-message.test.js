import { describe, expect, test } from '@jest/globals';

import { localizeString } from '../public/scripts/ui-localization.js';

// localizeString finds one whole message the way the run-time localiser finds it (exact key, then a ${n} key), but keeps
// every value in a hole as written. It is for server, provider and browser text that is about to go into a t`` frame.

const BUNDLED_REFUSALS = [
    ['installed', 'instalada'],
    ['updated', 'atualizada'],
    ['managed', 'gerenciada'],
    ['switched', 'trocada'],
    ['moved', 'movida'],
    ['deleted', 'excluída'],
];

describe('localizeString', () => {
    test('an exact key returns its value and keeps the spaces around the text', () => {
        const dictionary = { 'Choose an extension first.': 'Escolha primeiro uma extensão.' };

        expect(localizeString('Choose an extension first.', dictionary)).toBe('Escolha primeiro uma extensão.');
        expect(localizeString('  Choose an extension first.\n', dictionary)).toBe('  Escolha primeiro uma extensão.\n');
    });

    test('a ${n} key returns the translation with the values put back as written', () => {
        const dictionary = {
            'The image service returned an error (${0}). Check the service settings and try again.': 'O serviço de imagem retornou um erro (${0}). Verifique as configurações do serviço e tente novamente.',
        };

        expect(localizeString('The image service returned an error (502). Check the service settings and try again.', dictionary))
            .toBe('O serviço de imagem retornou um erro (502). Verifique as configurações do serviço e tente novamente.');
    });

    test('a hole whose value is itself a key stays as written', () => {
        const dictionary = {
            NovelAI: 'NovelAI traduzido',
            '${0} could not create the image. Check the settings and try again.': '${0} não conseguiu criar a imagem. Verifique as configurações e tente novamente.',
        };

        expect(localizeString('NovelAI could not create the image. Check the settings and try again.', dictionary))
            .toBe('NovelAI não conseguiu criar a imagem. Verifique as configurações e tente novamente.');
        expect(localizeString('NovelAI', dictionary)).toBe('NovelAI traduzido');
    });

    test('text that is already a translation comes back unchanged', () => {
        const dictionary = { 'No file was chosen.': 'Nenhum arquivo foi escolhido.' };

        expect(localizeString('Nenhum arquivo foi escolhido.', dictionary)).toBe('Nenhum arquivo foi escolhido.');
    });

    test('unknown text comes back unchanged', () => {
        const dictionary = { 'No file was chosen.': 'Nenhum arquivo foi escolhido.', 'Error: ${0}': 'Erro: ${0}' };

        expect(localizeString('Failed to fetch', {})).toBe('Failed to fetch');
        expect(localizeString('Failed to fetch', dictionary)).toBe('Failed to fetch');
        expect(localizeString('chapter-3 final.png', dictionary)).toBe('chapter-3 final.png');
        expect(localizeString('upstream connect error or disconnect/reset before headers', dictionary)).toBe('upstream connect error or disconnect/reset before headers');
    });

    test('a key whose value equals the key, or is empty, leaves the text unchanged', () => {
        const dictionary = { 'Keep this text.': 'Keep this text.', 'Empty value.': '', 'Open ${0}.': 'Open ${0}.' };

        expect(localizeString('Keep this text.', dictionary)).toBe('Keep this text.');
        expect(localizeString('Empty value.', dictionary)).toBe('Empty value.');
        expect(localizeString('Open the file.', dictionary)).toBe('Open the file.');
    });

    test('finds the 213-character wording by its whole key', () => {
        const wording = 'Server-side text rules for AI replies must use plain find-and-replace. Macros (placeholders such as {{user}}) and capture groups only work in the browser, so remove them or use a rule that only changes the prompt.';
        const dictionary = { [wording]: 'No servidor, as regras de texto para respostas da IA só podem usar localizar e substituir simples.' };

        expect(wording).toHaveLength(213);
        expect(localizeString(wording, dictionary)).toBe(dictionary[wording]);
    });

    test('inserts a translation that contains $& or $1 literally', () => {
        const dictionary = {
            'Pay now': 'Pague $& agora $1',
            'Pay ${0} now': 'Pague $& e ${0} agora $1',
        };

        expect(localizeString('Pay now', dictionary)).toBe('Pague $& agora $1');
        expect(localizeString('Pay 5 now', dictionary)).toBe('Pague $& e 5 agora $1');
    });

    test('empty and missing text give an empty or unchanged string', () => {
        const dictionary = { 'No file was chosen.': 'Nenhum arquivo foi escolhido.' };

        expect(localizeString('', dictionary)).toBe('');
        expect(localizeString('   ', dictionary)).toBe('   ');
        expect(localizeString(null, dictionary)).toBe('');
        expect(localizeString(undefined, dictionary)).toBe('');
        expect(localizeString(0, dictionary)).toBe('0');
    });

    test('characterisation: given a whole composed text the shorter key captures it, which is why the frames use t', () => {
        const dictionary = { 'Conversation ${0}': 'Conversa ${0}' };

        expect(localizeString('Conversation selfie failed: X', dictionary)).toBe('Conversa selfie failed: X');
    });

    test('characterisation: the shorter Scan key captures the failed-scan text, and the frame\'s own key cannot match an empty hole', () => {
        const short = ['Scan ${0}', 'Varredura ${0}'];
        const frame = ['Scan failed.${0} Technical details: ${1}', 'Falha na varredura.${0} Detalhes técnicos: ${1}'];

        // The same result whichever key the dictionary lists first, which is why World Info Lab builds this line with its own hostT keys.
        for (const pairs of [[short, frame], [frame, short]]) {
            const dictionary = Object.fromEntries(pairs);

            expect(localizeString('Scan failed. Technical details: X', dictionary)).toBe('Varredura failed. Technical details: X');
        }
    });

    test('the six extension updater refusals each find their own key, with the folder name as written', () => {
        const sentence = (name, verb) => `${name} comes with Neconyan, so it cannot be ${verb} from the extension updater.`;
        const key = verb => sentence('${0}', verb);
        const dictionary = {};
        for (const [verb, value] of [...BUNDLED_REFUSALS].reverse()) {
            dictionary[key(verb)] = `\${0} vem com o Neconyan e não pode ser ${value} pelo atualizador de extensões.`;
        }
        dictionary['Neconyan-Story-Mode'] = 'Modo História do Neconyan';

        for (const name of ['ChatCompletionTabs', 'Neconyan-Story-Mode']) {
            for (const [verb, value] of BUNDLED_REFUSALS) {
                expect(localizeString(sentence(name, verb), dictionary))
                    .toBe(`${name} vem com o Neconyan e não pode ser ${value} pelo atualizador de extensões.`);
            }
        }
    });
});
