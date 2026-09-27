import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function requestJson(request) {
    const bytes = request.postDataBuffer();
    return JSON.parse((request.headers()['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString());
}

/** Layout tests still exercise the browser's real read and save receipt validation. */
export function createMockRoleplayStore(account, { realReads = false } = {}) {
    const chats = new Map();
    const groups = new Map();
    const receipts = new Map();
    const hash = records => createHash('sha256').update(JSON.stringify(records)).digest('hex');
    const content = records => {
        const copy = structuredClone(records);
        if (copy[0]?.chat_metadata) {
            delete copy[0].chat_metadata.integrity;
            delete copy[0].chat_metadata.neconyan_roleplay;
        }
        return copy;
    };
    const snapshot = (input, previous) => {
        const records = content(input);
        const contentHash = hash(records);
        if (previous?.contentHash === contentHash) return { ...previous, changed: false };
        const integrity = randomUUID();
        if (records[0]?.chat_metadata) records[0].chat_metadata.integrity = integrity;
        return { records, contentHash, integrity, changed: true,
            source: { instanceId: previous?.source.instanceId ?? randomUUID(),
                revision: (previous?.source.revision ?? 0) + 1, rawHash: hash(records) } };
    };
    const locatorFor = (route, body) => route.request().url().includes('/group/')
        ? { group: true, chat: String(body.id) }
        : { group: false, avatar: body.avatar_url, chat: body.file_name };
    return {
        async readGroups(route, initial) {
            const owner = await account();
            const records = initial.map(group => {
                if (!groups.has(group.id)) groups.set(group.id, snapshot([group]));
                const saved = groups.get(group.id);
                return { ...saved.records[0], __roleplay: { account: owner,
                    locator: { kind: 'group', groupId: group.id }, source: saved.source } };
            });
            await route.fulfill({ json: records });
        },
        async saveGroup(route) {
            const { roleplay: evidence, ...group } = requestJson(route.request());
            if (!evidence?.operationKey) throw new Error('Missing protected group save evidence.');
            let receipt = receipts.get(evidence.operationKey);
            if (!receipt) {
                const saved = snapshot([group], groups.get(group.id));
                groups.set(group.id, saved);
                receipt = { ok: true, integrity: saved.integrity,
                    roleplay: { account: evidence.account, operationKey: evidence.operationKey,
                        changed: saved.changed, rawChanged: saved.changed, source: saved.source } };
                receipts.set(evidence.operationKey, receipt);
            }
            await route.fulfill({ json: receipt });
        },
        async read(route, initial = []) {
            const locator = locatorFor(route, requestJson(route.request()));
            const key = JSON.stringify(locator);
            if (!chats.has(key) && initial.length) chats.set(key, snapshot(initial));
            const saved = chats.get(key);
            await route.fulfill({ json: saved?.records ?? initial, headers: {
                'X-Neconyan-Roleplay': JSON.stringify({ account: await account(), locator,
                    ...(saved ? { source: saved.source } : { vacancy: 0 }) }),
            } });
        },
        async save(route) {
            const body = requestJson(route.request());
            const evidence = body.roleplay;
            if (!evidence?.account || !evidence.operationKey) throw new Error('Missing protected chat save evidence.');
            let receipt = receipts.get(evidence.operationKey);
            if (!receipt) {
                const key = JSON.stringify(locatorFor(route, body));
                let previous = chats.get(key);
                // Layout-only saves can follow a genuine server read, including a reload.
                if (realReads && JSON.stringify(previous?.source) !== JSON.stringify(evidence.source)) {
                    previous = evidence.source ? { source: evidence.source } : undefined;
                }
                const saved = snapshot(body.chat, previous);
                chats.set(key, saved);
                receipt = { ok: true, integrity: saved.integrity, roleplay: { account: evidence.account,
                    operationKey: evidence.operationKey, changed: saved.changed, source: saved.source } };
                receipts.set(evidence.operationKey, receipt);
            }
            await route.fulfill({ json: receipt });
        },
    };
}
