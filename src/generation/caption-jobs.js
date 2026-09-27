import path from 'node:path';
import { registerHandler } from '../jobs/runner.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { admitRoleplayJob, applyRoleplayJobEffect, readRoleplayJobResult } from '../roleplay-jobs.js';
import { roleplayError, roleplayHash, roleplaySettingsHash, readRoleplayFile, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { captureSavedRoleplayImages, selectSavedRoleplayPersona } from './world-info.js';
import { captureRoleplayCaptions, prepareRoleplayCaptions } from './roleplay-captions.js';
import { roleplayNativeHost } from '../endpoints/chats.js';

const fail = message => roleplayError('ROLEPLAY_CAPTION_INVALID', message, 409);
const text = value => typeof value === 'string' ? value : '';

function readSettings(directories) {
    try {
        const file = readRoleplayFile(path.join(directories.root, 'settings.json'), 8 * 1024 * 1024);
        return JSON.parse(file.bytes.toString('utf8'));
    } catch { throw fail('The saved caption settings are unavailable.'); }
}

/** Manual captions have their own exact message effect, not an artificial assistant reply. */
export function captureCaptionRequest(base, account, source, { avatar, mediaIndex = 0, reviewedPrompt, reviewed } = {}) {
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        const index = source.message?.index;
        const record = Number.isSafeInteger(index) && index >= 0 ? saved.records[index + 1] : null;
        const media = Number.isSafeInteger(mediaIndex) && mediaIndex >= 0 ? record?.extra?.media?.[mediaIndex] : null;
        if (!record || record.is_system || !media || !source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) {
            throw fail('A manual caption needs its saved message, selected media and character.');
        }
        const settings = readSettings(base.directories);
        const entity = readRoleplayEntityLocked(lease, 'character', avatar);
        if (entity.changed) saveRoleplayAccount(lease);
        const card = entity.data.data ?? entity.data;
        const persona = selectSavedRoleplayPersona(settings, saved, source, avatar, base.directories);
        const projection = saved.records.map((value, recordIndex) => recordIndex === 0 ? value : recordIndex === index + 1
            ? { mes: value.mes, extra: { media: [media], media_display: 'list' } } : { mes: value.mes });
        const images = captureSavedRoleplayImages(base.directories, projection, 'list', settings.extension_settings?.caption);
        const captions = captureRoleplayCaptions(base.directories, settings, { records: saved.records, images, automatic: false,
            selection: [{ index, mediaIndex, imageIndex: 0 }], reviewedPrompt, reviewed });
        if (!captions) throw fail('Enable captions before accepting this operation.');
        const macros = { names: { char: card.name || path.parse(avatar).name, user: persona.name || settings.username || 'User' },
            character: { description: text(card.description), personality: text(card.personality), scenario: text(card.scenario), persona: persona.description || '' },
            variables: { local: saved.records[0].chat_metadata?.variables ?? {}, global: settings.extension_settings?.variables?.global ?? {} },
            extra: { character: { ...card, avatar }, characterAvatar: avatar, chat: saved.records.slice(1), chatMetadata: saved.records[0].chat_metadata ?? {} } };
        const snapshot = { account: { accountId: account.accountId, dataEpoch: account.dataEpoch }, source, avatar, images, captions,
            experimentalMacroEngine: Boolean(settings.power_user?.experimental_macro_engine), settingsHash: roleplaySettingsHash(settings) };
        const request = { worldInfo: snapshot, macros };
        if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) throw fail('The selected caption input exceeds its saved limit.');
        return request;
    });
}

export function admitCaptionJob(base, account, { operationKey, source, request }) {
    if (!request?.worldInfo?.captions?.manual || roleplayHash(request.worldInfo.source) !== roleplayHash(source)
        || roleplayHash(request.worldInfo.account) !== roleplayHash(account)) throw fail('The saved caption intent is incomplete.');
    return admitRoleplayJob(base, account, { operationKey, source, request, effect: 'caption', type: 'roleplay.caption', label: 'Caption saved media' });
}

export async function runCaptionJob(context, { fetchImpl = fetch, localCaption, wait, host = roleplayNativeHost, beforeCompletion } = {}) {
    const { job, owner, directories } = context;
    const { roleplay, effect, source, request } = job.intent ?? {};
    if (!roleplay || effect !== 'caption' || !request?.worldInfo?.captions?.manual) throw fail('The accepted caption request is missing.');
    const base = { owner, directories };
    const account = { accountId: roleplay.accountId, dataEpoch: roleplay.dataEpoch };
    const ownership = { operationKey: roleplay.operationKey, jobId: job.id, effect, source, request };
    const completed = readRoleplayJobResult(base, account, ownership);
    if (completed) return { result: completed };
    let output = withRoleplayAccount(base, account, () => readArtifact(directories, job.id, 'caption-output'));
    if (output === undefined) {
        const assertCurrent = () => withRoleplayAccount(base, account, lease => {
            context.signal.throwIfAborted();
            const saved = assertRoleplaySourceLocked(lease, source, { effect });
            const current = captureSavedRoleplayImages(base.directories, saved.records.map((record, index) => index === 0 ? record
                : index === source.message.index + 1 ? { mes: record.mes, extra: { media: [record.extra.media[request.worldInfo.captions.items[0].mediaIndex]], media_display: 'list' } }
                    : { mes: record.mes }), 'list', readSettings(directories).extension_settings?.caption);
            if (roleplayHash(current) !== roleplayHash(request.worldInfo.images)) throw fail('The selected caption media changed after admission.');
            return saved;
        });
        const saved = assertCurrent();
        await prepareRoleplayCaptions(context, { base, snapshot: request.worldInfo, records: saved.records,
            macros: request.macros, assertCurrent, fetchImpl, localCaption, wait });
        output = withRoleplayAccount(base, account, () => {
            const captions = readArtifact(directories, job.id, 'roleplay-captions');
            const value = { identity: roleplayHash(job.intent), captions: captions.results };
            const result = { ...value, hash: roleplayHash(value) };
            writeArtifact(directories, job.id, 'caption-output', result);
            return result;
        });
    }
    await beforeCompletion?.(output);
    context.signal.throwIfAborted();
    const { hash, ...value } = output ?? {};
    if (value.identity !== roleplayHash(job.intent) || hash !== roleplayHash(value)) throw fail('The saved caption output needs recovery.');
    return { result: applyRoleplayJobEffect(base, account, { operationKey: roleplay.operationKey, jobId: job.id, output: { captions: value.captions } }, host) };
}

registerHandler('roleplay.caption', context => runCaptionJob(context));
