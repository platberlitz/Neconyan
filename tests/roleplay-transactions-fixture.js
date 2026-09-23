import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath, FILE_WRITE_RECOVERY_SUFFIX } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { initialiseRoleplayAccount, readRoleplayFile } = await import('../src/roleplay-store.js');
const { captureRoleplaySource } = await import('../src/generation/roleplay-source.js');
const { write: writeCard } = await import('../src/character-card-parser.js');
const { canonicalMemoryPaths } = await import('../src/mewmory/prepared-branch.js');
const { buildMemoryRecoveryGuard } = await import('../src/mewmory/store.js');
const { newState, syncSources } = await import('../src/mewmory/core.js');
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

export function fixture(t, group = false, owner = 'fixture') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-roleplay-transaction-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userRoot = path.join(root, owner);
    const directories = Object.fromEntries(['chats', 'groupChats', 'characters', 'groups', 'backups'].map(key => [key, path.join(userRoot, key)]));
    directories.root = userRoot;
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(directories.chats, 'Nova'));
    fs.writeFileSync(path.join(directories.characters, 'Nova.png'), writeCard(png, JSON.stringify({ name: 'Nova', description: 'Original' })));
    fs.writeFileSync(path.join(directories.groups, 'group.json'), JSON.stringify({ id: 'group', members: ['Nova.png'], chats: ['Source', 'New'] }));
    const locator = group ? { group: true, chat: 'Source' } : { group: false, chat: 'Source', avatar: 'Nova.png' };
    const filename = path.join(group ? directories.groupChats : path.join(directories.chats, 'Nova'), 'Source.jsonl');
    const records = [{ user_name: 'User', character_name: 'Nova', chat_metadata: {}, unknown: true },
        { name: 'User', is_user: true, mes: 'Original', extra: { file: 'attachment.txt' } },
        { name: 'Nova', is_user: false, mes: 'Answer', swipes: ['Answer', 'Other'], swipe_id: 0, swipe_info: [{ extra: { reasoning: 'hidden' } }, {}] }];
    fs.writeFileSync(filename, records.map(row => JSON.stringify(row)).join('\n'));
    const scope = initialiseRoleplayAccount({ owner, directories });
    const source = () => captureRoleplaySource(scope, { locator, ...(group ? { groupId: 'group' } : {}) });
    const input = () => ({ operationKey: 'first', mode: 'update', source: source(), backup: { deferBackup: true }, records: [...structuredClone(records), { name: 'Nova', mes: 'New result', is_user: false }] });
    return { root, scope, locator, filename, records, input, source };
}

export function memoryParent(f, chat = 'Parent') {
    const locator = { ...f.locator, chat };
    const filename = path.join(path.dirname(f.filename), chat + '.jsonl');
    fs.writeFileSync(filename, f.records.map(row => JSON.stringify(row)).join('\n'));
    const paths = canonicalMemoryPaths(f.scope.directories, locator);
    const state = syncSources(newState(paths.locator), f.records.slice(1), []);
    state.revision = 1;
    for (const file of [paths.archive, paths.guard]) fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(paths.archive, JSON.stringify(state));
    fs.writeFileSync(paths.guard, JSON.stringify(buildMemoryRecoveryGuard(state)));
    return { paths, state };
}

export function writeJournal(f, overrides = {}) {
    const source = readRoleplayFile(f.filename);
    const record = { version: 1, dev: source.physical.dev, ino: source.physical.ino, birthtime: source.physical.birthtimeNs,
        originalHash: source.rawHash, nextHash: '0'.repeat(64), originalData: source.bytes.toString('base64'), ...overrides };
    const filename = f.filename + FILE_WRITE_RECOVERY_SUFFIX;
    fs.writeFileSync(filename, JSON.stringify(record));
    return { filename, record, ...readRoleplayFile(filename) };
}
