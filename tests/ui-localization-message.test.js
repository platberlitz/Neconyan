import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

import { assembleLocaleData } from '../public/scripts/locale-assembly.js';
import { localizeString } from '../public/scripts/ui-localization.js';

const localePath = name => fileURLToPath(new URL(`../public/locales/${name}`, import.meta.url));
const readLocale = file => JSON.parse(fs.readFileSync(localePath(file), 'utf8'));
const SHIPPED_LANGUAGES = fs.readdirSync(localePath('neconyan'))
    .filter(file => file.endsWith('.json') && !['en.json', 'en-aliases.json'].includes(file))
    .map(file => file.slice(0, -'.json'.length))
    .sort();

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

    test('the frame\'s own Scan key beats the shorter Scan key even when an optional hole is empty', () => {
        const short = ['Scan ${0}', 'Varredura ${0}'];
        const frame = ['Scan failed.${0} Technical details: ${1}', 'Falha na varredura.${0} Detalhes técnicos: ${1}'];

        for (const pairs of [[short, frame], [frame, short]]) {
            const dictionary = Object.fromEntries(pairs);

            expect(localizeString('Scan failed. Technical details: X', dictionary)).toBe('Falha na varredura. Detalhes técnicos: X');
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

    test('a two-sentence text takes its own key, whichever key the dictionary lists first', () => {
        const short = ['No settings are available for ${0}.', 'S ${0}.'];
        const long = ['No settings are available for ${0}. Use Manage extensions to install or enable it.', 'L ${0}.'];

        for (const pairs of [[short, long], [long, short]]) {
            const dictionary = Object.fromEntries(pairs);

            expect(localizeString('No settings are available for Story Mode. Use Manage extensions to install or enable it.', dictionary)).toBe('L Story Mode.');
            expect(localizeString('No settings are available for Story Mode.', dictionary)).toBe('S Story Mode.');
        }
    });

    test('there are 17 shipped languages besides English', () => {
        expect(SHIPPED_LANGUAGES).toHaveLength(17);
    });

    test.each(SHIPPED_LANGUAGES)('every shipped language shows the whole missing-settings message: %s', language => {
        const label = 'Card & Lorebook Time Machine';
        const baseFile = `${language}.json`;
        const { dictionary } = assembleLocaleData({
            base: fs.existsSync(localePath(baseFile)) ? readLocale(baseFile) : {},
            supplement: readLocale(`neconyan/${language}.json`),
            catalogue: readLocale('neconyan/en.json'),
        });
        const key = 'No settings are available for ${0}. Use Manage extensions to install or enable it.';

        expect(typeof dictionary[key]).toBe('string');
        expect(typeof dictionary['No settings are available for ${0}.']).toBe('string');
        expect(localizeString(`No settings are available for ${label}. Use Manage extensions to install or enable it.`, dictionary))
            .toBe(dictionary[key].replace('${0}', label));
    });

    test('keys with the same amount of fixed text keep the order the dictionary lists them in', () => {
        const first = ['Alpha ${0}beta', 'first [${0}]'];
        const second = ['Alpha${0} beta', 'second [${0}]'];

        // Both keys have ten characters of fixed text and both match this text.
        expect(localizeString('Alpha one beta', Object.fromEntries([first, second]))).toBe('first [one ]');
        expect(localizeString('Alpha one beta', Object.fromEntries([second, first]))).toBe('second [ one]');
    });

    test('a key with more fixed text beats a longer key whose length is mostly placeholders', () => {
        // 'Move ${0} ${1}' is the longer key (14 characters against 12) but has less fixed text (6 against 8).
        const holes = ['Move ${0} ${1}', 'Mover ${0} ${1}'];
        const own = ['Move ${0} up', 'Subir ${0}'];

        for (const pairs of [[holes, own], [own, holes]]) {
            expect(localizeString('Move card up', Object.fromEntries(pairs))).toBe('Subir card');
        }
    });

    test('keys that start with a hole are ordered by fixed text too', () => {
        const short = ['${0} and ${1}', 'S ${0} ${1}'];
        const long = ['${0} and ${1} too', 'L ${0} ${1}'];

        for (const pairs of [[short, long], [long, short]]) {
            const dictionary = Object.fromEntries(pairs);

            expect(localizeString('cats and dogs too', dictionary)).toBe('L cats dogs');
            expect(localizeString('cats and dogs', dictionary)).toBe('S cats dogs');
        }
    });

    test('templateIndex sizes separated letter-attached, separated non-letter, and ordinary holes accurately', () => {
        const dictionary = {
            'Group: ${0}${1}': 'Gruppe: ${0}${1}',
            'Foo bar${0}${1}': 'Baz ${0}',
            'Alpha ${0}${1}': 'Alpha [${0} | ${1}]',
        };

        expect(localizeString('Group: Alpha', dictionary)).toBe('Gruppe: Alpha');
        expect(localizeString('Foo bars (x)', dictionary)).toBe('Baz s');
        expect(localizeString('Alpha 12', dictionary)).toBe('Alpha [1 | 2]');
        expect(localizeString('Alpha x', dictionary)).toBe('Alpha x');
    });
});

describe('empty holes and Dialogue Colors localization', () => {
    const loadShippedDictionary = language => {
        const baseFile = `${language}.json`;
        return assembleLocaleData({
            base: fs.existsSync(localePath(baseFile)) ? readLocale(baseFile) : {},
            supplement: readLocale(`neconyan/${language}.json`),
            catalogue: readLocale('neconyan/en.json'),
        }).dictionary;
    };

    test('L10N-49 translates Recolored and Colorized save-failure warnings without short-key swallowing', () => {
        const recoloredCases = [
            ['de-de', '1 Nachricht umgefärbt; der Host hat das Speichern des Chats nicht bestätigt.'],
            ['ja-jp', '1件のメッセージの色を再適用しました（ホストがチャットの保存を確認しませんでした）。'],
            ['tr-tr', '1 mesaj yeniden renklendirildi; ana uygulama sohbet kaydını onaylamadı.'],
            ['it-it', 'Messaggi ricolorati: 1; l\'host non ha confermato il salvataggio della chat.'],
            ['fr-fr', '1 message recoloré ; l\'hôte n\'a pas confirmé l\'enregistrement du chat.'],
        ];
        for (const [language, expected] of recoloredCases) {
            const dictionary = loadShippedDictionary(language);
            expect(localizeString('Recolored 1 message; the host did not confirm the chat save.', dictionary)).toBe(expected);
        }

        const colorizedCases = [
            [
                'de-de',
                '1 Nachricht eingefärbt; der Host hat das Speichern des Chats nicht bestätigt.',
                '3 Nachrichten eingefärbt; der Host hat das Speichern des Chats nicht bestätigt.',
            ],
            [
                'it-it',
                'Messaggi colorati: 1; l\'host non ha confermato il salvataggio della chat.',
                'Messaggi colorati: 3; l\'host non ha confermato il salvataggio della chat.',
            ],
            [
                'tr-tr',
                '1 mesaj renklendirildi; ana uygulama sohbet kaydını onaylamadı.',
                '3 mesaj renklendirildi; ana uygulama sohbet kaydını onaylamadı.',
            ],
            [
                'ja-jp',
                '1件のメッセージを色分けしました（ホストがチャットの保存を確認しませんでした）。',
                '3件のメッセージを色分けしました（ホストがチャットの保存を確認しませんでした）。',
            ],
        ];
        for (const [language, expectedOne, expectedThree] of colorizedCases) {
            const dictionary = loadShippedDictionary(language);
            expect(localizeString('Colorized 1 message; the host did not confirm the chat save.', dictionary)).toBe(expectedOne);
            expect(localizeString('Colorized 3 messages; the host did not confirm the chat save.', dictionary)).toBe(expectedThree);
        }
    });

    test('matches singular n=1 plural-ending keys and optional-suffix captions', () => {
        const singularCases = [
            ['de-de', '1 Nachricht umgefärbt.', '1 ausgewählten Agenten löschen?'],
            ['ja-jp', '1件のメッセージの色を再適用しました。', '選択した1体のエージェントを削除しますか？'],
            ['tr-tr', '1 mesaj yeniden renklendirildi.', 'Seçili 1 ajan silinsin mi?'],
        ];
        for (const [language, recoloredOne, deleteOne] of singularCases) {
            const dictionary = loadShippedDictionary(language);
            expect(localizeString('Recolored 1 message.', dictionary)).toBe(recoloredOne);
            expect(localizeString('Delete 1 selected agent?', dictionary)).toBe(deleteOne);
        }

        const german = loadShippedDictionary('de-de');
        expect(localizeString('Extension Foo synced.', german)).toBe('Erweiterung Foo synchronisiert.');
        expect(localizeString('QIG: generation complete.', german)).toBe('QIG: Generierung abgeschlossen.');
    });

    test('Turkish opt-filled Dialogue Colors outputs match exact non-regression strings', () => {
        const turkish = loadShippedDictionary('tr-tr');
        const cases = [
            [
                'Colorized 3 messages (2 skipped - no speaker/color match).',
                '3 mesaj renklendirildi (2 atlandı - eşleşen konuşmacı/renk yok).',
            ],
            [
                'Colorized 3 messages (2 skipped - no speaker/color match); the host did not confirm the chat save.',
                '3 mesaj renklendirildi (2 atlandı - eşleşen konuşmacı/renk yok); ana uygulama sohbet kaydını onaylamadı.',
            ],
            [
                'Randomized 3 unlocked colors; skipped 2 locked.',
                '3 kilitlenmemiş renk rastgeleleştirildi; 2 kilitli atlandı.',
            ],
            [
                'Set group for 3 characters; applied its profile to 2.',
                '3 karakter için grup ayarlandı; profili 2 karaktere uygulandı.',
            ],
            [
                'Cleaned 3 messages (2 swipes).',
                '3 mesaj temizlendi (2 kaydırma).',
            ],
            [
                'Click this toast to undo.',
                'Geri almak için bu bildirime tıklayın.',
            ],
        ];
        for (const [input, expected] of cases) {
            expect(localizeString(input, turkish)).toBe(expected);
        }
    });

    test('L10N-41 Dialogue Colors plural templates translate cleanly across all 17 languages without leaks', () => {
        expect(SHIPPED_LANGUAGES).toHaveLength(17);

        const inputs = [
            'Recolored 1 message.',
            'Recolored 3 messages.',
            'Colorized 1 message.',
            'Colorized 3 messages.',
            'Restored 1 stored color table.',
            'Restored 3 stored color tables. Skipped 2 keys that now exist.',
            'Deleted 1 selected character.',
            'Deleted 3 selected characters. Kept 2 pinned characters.',
            'Verified DOM colors: applied 1 correction, queued 1 suggestion for review.',
            'Verified DOM colors: applied 3 corrections, queued 2 suggestions for review.',
            'Click this toast to undo.',
        ];

        for (const language of SHIPPED_LANGUAGES) {
            const dictionary = loadShippedDictionary(language);
            const cognateLeaks = [];
            for (const input of inputs) {
                const localized = localizeString(input, dictionary);
                expect(localized).not.toBe(input);
                expect(localized).not.toMatch(/\d+(?:s|es)\b|\b(?:stored color|pinned|selected|for review|applied|queued|Click this toast to undo)\b|\$\{\d+\}|(?<!\.)\.\.(?!\.)/);
                if (!['fr-fr', 'it-it'].includes(language) && /\b(?:message|messages|correction|corrections|suggestion|suggestions|character|characters|table|tables|key|keys)\b/i.test(localized)) {
                    cognateLeaks.push(`${language}: ${input} -> ${localized}`);
                }
            }
            expect(cognateLeaks).toEqual([]);
            expect(localizeString('Restored 3 stored color tables. Skipped 2 keys that now exist.', dictionary)).toContain('3');
            expect(localizeString('Restored 3 stored color tables. Skipped 2 keys that now exist.', dictionary)).toContain('2');
            expect(localizeString('Deleted 3 selected characters. Kept 2 pinned characters.', dictionary)).toContain('3');
            expect(localizeString('Deleted 3 selected characters. Kept 2 pinned characters.', dictionary)).toContain('2');
            expect(localizeString('Verified DOM colors: applied 3 corrections, queued 2 suggestions for review.', dictionary)).toContain('3');
            expect(localizeString('Verified DOM colors: applied 3 corrections, queued 2 suggestions for review.', dictionary)).toContain('2');
        }

        const german = loadShippedDictionary('de-de');
        expect(localizeString('Recolored 3 messages.', german)).toBe('3 Nachrichten umgefärbt.');
        expect(localizeString('Restored 3 stored color tables. Skipped 2 keys that now exist.', german)).toBe('3 gespeicherte Farbtabellen wiederhergestellt. 2 Schlüssel übersprungen, die jetzt existieren.');
        expect(localizeString('Deleted 3 selected characters. Kept 2 pinned characters.', german)).toBe('3 ausgewählte Charaktere gelöscht. 2 angepinnte Charaktere behalten.');
        expect(localizeString('Verified DOM colors: applied 3 corrections, queued 2 suggestions for review.', german)).toBe('DOM-Farben überprüft: 3 Korrekturen angewendet, 2 Vorschläge zur Überprüfung eingereiht.');
        expect(localizeString('Click this toast to undo.', german)).toBe('Zum Rückgängigmachen auf diese Meldung klicken.');
    });
});

describe('M102a plural templates, Lorebook tooltip, and Pawthfinder diagnostics', () => {
    const loadShippedLocale = language => {
        const baseFile = `${language}.json`;
        return assembleLocaleData({
            base: fs.existsSync(localePath(baseFile)) ? readLocale(baseFile) : {},
            supplement: readLocale(`neconyan/${language}.json`),
            catalogue: readLocale('neconyan/en.json'),
        });
    };

    test.each(SHIPPED_LANGUAGES)('L10N-LOREBOOK-TOOLTIP-MULTIDIGIT translates 1 and 12 always-active entries cleanly: %s', language => {
        const { dictionary } = loadShippedLocale(language);
        const inputs = [
            ['Always active: ~20 tokens across 1 always-active entry. Click to inspect.', '20', '1'],
            ['Always active: ~240 tokens across 12 always-active entries. Click to inspect.', '240', '12'],
            ['Always active: ~240 tokens across 12 always-active entries of the 1k World Info budget (24%). Click to inspect.', '240', '12'],
            ['Always active: ~240 tokens across 12 always-active entries of the 200 World Info budget (120%) - over budget! Click to inspect.', '240', '12'],
        ];
        for (const [input, tokens, count] of inputs) {
            const localized = localizeString(input, dictionary);
            expect(localized).not.toBe(input);
            expect(localized).toContain(tokens);
            expect(localized).toContain(count);
            expect(localized).not.toMatch(/(?:^|[^\p{L}])(?:always-active|Click to inspect|over budget)(?:$|[^\p{L}])/iu);
        }
    });

    test('pinned ja-jp and zh-cn Lorebook 12-entry tooltips match expected output', () => {
        const ja = loadShippedLocale('ja-jp').dictionary;
        const zh = loadShippedLocale('zh-cn').dictionary;
        expect(localizeString('Always active: ~240 tokens across 12 always-active entries. Click to inspect.', ja))
            .toBe('常時有効: ~240トークン（12件のエントリー） クリックして確認。');
        expect(localizeString('Always active: ~240 tokens across 12 always-active entries. Click to inspect.', zh))
            .toBe('常驻激活：共 12 个词条，约 240 个 token。 点击查看。');
    });

    test.each(SHIPPED_LANGUAGES)('L10N-PATHFINDER-TR-CANDIDATES translates zero-selection and injected candidate variants: %s', language => {
        const { dictionary, scoped } = loadShippedLocale(language);
        expect(scoped['scoped.pathfinder.stage_entry_one']).toContain('${0}');
        expect(scoped['scoped.pathfinder.stage_entry_many']).toContain('${0}');
        expect(scoped['scoped.pathfinder.stage_label']).toContain('${0}');

        const stage0 = scoped['scoped.pathfinder.stage_entry_many'].replace('${0}', '0');
        const stage1 = scoped['scoped.pathfinder.stage_entry_one'].replace('${0}', '1');
        const stageSummary = `lore: ${stage0}; rank: ${stage1}`;

        const zeroNoStage = localizeString('Enabled (default pipeline). Last run returned 0 entries from 5 candidates.', dictionary);
        const zeroWithStage = localizeString(`Enabled (default pipeline). Last run returned 0 entries from 5 candidates. Stages: ${stageSummary}.`, dictionary);
        const injectedThree = localizeString('Enabled (default pipeline). Last run injected 3 entries from 5 candidates.', dictionary);
        const injectedOneNoCand = localizeString('Enabled (default pipeline). Last run injected 1 entry.', dictionary);
        const injectedOneOneCand = localizeString('Enabled (default pipeline). Last run injected 1 entry from 1 candidate.', dictionary);

        for (const text of [zeroNoStage, zeroWithStage, injectedThree, injectedOneNoCand, injectedOneOneCand]) {
            expect(text).not.toMatch(/\bentry\b|\bentries\b|\bcandidate\b|\bcandidates\b|\bLast run\b|\bStages:\b/);
        }
        expect(zeroWithStage).toContain(stageSummary);
        expect(injectedThree).toContain('3');
        expect(injectedThree).toContain('5');
    });

    test('tr-tr Pawthfinder outputs localize zero-selection with multi-stage details and injected candidates completely', () => {
        const { dictionary, scoped } = loadShippedLocale('tr-tr');
        const stageSummary = `lore: ${scoped['scoped.pathfinder.stage_entry_many'].replace('${0}', '0')}; rank: ${scoped['scoped.pathfinder.stage_entry_one'].replace('${0}', '1')}`;
        expect(localizeString('Enabled (default pipeline). Last run returned 0 entries from 5 candidates.', dictionary))
            .toBe('Etkin (default ardışık düzen). Son çalıştırma 5 aday arasından 0 girdi döndürdü.');
        expect(localizeString(`Enabled (default pipeline). Last run returned 0 entries from 5 candidates. Stages: ${stageSummary}.`, dictionary))
            .toBe('Etkin (default ardışık düzen). Son çalıştırma 5 aday arasından 0 girdi döndürdü. Aşamalar: lore: 0 girdi; rank: 1 girdi.');
        expect(localizeString('Enabled (default pipeline). Last run injected 3 entries from 5 candidates.', dictionary))
            .toBe('Etkin (default ardışık düzen). Son çalıştırma 5 aday arasından 3 girdi ekledi.');
    });

    test.each(SHIPPED_LANGUAGES)('L10N-41 M102a slice translates n=1 and n=3 captions without plural-hole leaks: %s', language => {
        const { dictionary } = loadShippedLocale(language);
        const inputs = [
            'Delete 1 selected agent?',
            'Delete 3 selected agents?',
            'Added 1 lorebook entry to "Book".',
            'Added 3 lorebook entries to "Book". Skipped 2 duplicates.',
            'Health check: 1 error or warning. Click to review.',
            'Health check: 3 errors or warnings. Click to review.',
            'Gallery keeps the newest 50 images. 1 older image was removed.',
            'Gallery keeps the newest 50 images. 3 older images were removed.',
            'Stored 1 snapshot; 1 failed.',
            'Stored 3 snapshots; 2 failed.',
            'Maximum 1 reference image reached',
            'Maximum 3 reference images reached',
        ];
        for (const input of inputs) {
            const localized = localizeString(input, dictionary);
            expect(localized).not.toBe(input);
            expect(localized).not.toMatch(/\(s\)|\(n\)|\(e\)|\(en\)|\(es\)|\(ies\)|\.\.| was |(?:^|[^\p{L}])entr(?:$|[^\p{L}])/iu);
        }
    });

    test('pinned M102a de-de, ko-kr, es-es, fr-fr, ru-ru, uk-ua, and ar-sa outputs are leak-free', () => {
        expect(localizeString('Delete 3 selected agents?', loadShippedLocale('de-de').dictionary)).toBe('3 ausgewählte Agenten löschen?');
        expect(localizeString('Delete 3 selected agents?', loadShippedLocale('ko-kr').dictionary)).toBe('선택한 3개의 에이전트를 삭제할까요?');
        expect(localizeString('Added 3 lorebook entries to "Book".', loadShippedLocale('es-es').dictionary)).toBe('Se agregaron 3 entradas de lorebook a "Book".');
        expect(localizeString('Delete 3 selected agents?', loadShippedLocale('fr-fr').dictionary)).toBe('Supprimer 3 agents sélectionnés ?');
        expect(localizeString('Stored 3 snapshots; 2 failed.', loadShippedLocale('ru-ru').dictionary)).toBe('Сохранено снимков: 3; с ошибкой: 2.');
        expect(localizeString('Stored 3 snapshots; 2 failed.', loadShippedLocale('uk-ua').dictionary)).toBe('Збережено знімків: 3; не вдалося: 2.');
        expect(localizeString('Delete 3 selected agents?', loadShippedLocale('ar-sa').dictionary)).toBe('حذف الوكلاء المحددين (3)؟');
    });
});
