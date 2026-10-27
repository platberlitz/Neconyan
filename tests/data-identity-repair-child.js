import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const { configureTermuxStartup } = await import('../src/termux-startup.js');
const { bootstrapRoleplayAccount, commitSingleChatWrite } = await import('../src/roleplay-lifecycle.js');
const { captureRoleplayStorageSource } = await import('../src/generation/roleplay-source.js');
const { roleplayNativeHost } = await import('../src/endpoints/chats.js');
const [root, owner, mode] = process.argv.slice(2);
const base = { owner, directories: Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, relative]) => [key, path.join(root, owner, relative)])) };
const configured = await configureTermuxStartup({ dataRoot: root }, { termux: true, bun: false, wakeLock: () => ({ status: 0 }) });
const scope = bootstrapRoleplayAccount(base, roleplayNativeHost);
const locator = { group: false, avatar: 'Nova.png', chat: 'Source' };
const captured = captureRoleplayStorageSource(scope, locator);
const filename = path.join(base.directories.chats, 'Nova', 'Source.jsonl');
if (mode === 'save') {
    const records = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
    records.push({ name: 'User', is_user: true, mes: 'Saved after identity repair' });
    commitSingleChatWrite(scope, { operationKey: 'after-identity-repair', sourceKind: 'storage', source: captured,
        mode: 'update', records, backup: { deferBackup: true } }, roleplayNativeHost);
}
console.log(JSON.stringify({ policy: configured.mode, accountId: scope.accountId, dataEpoch: scope.dataEpoch,
    instanceId: captured.instanceId, content: fs.readFileSync(filename, 'utf8').includes('Saved after identity repair') }));
