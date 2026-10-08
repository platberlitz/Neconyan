import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const read = filename => readFileSync(new URL(filename, import.meta.url), 'utf8');

describe('protected storage startup and account transport', () => {
    test('initialises and reconciles storage before migrations, plugins, listening and workers', () => {
        const entry = read('../server.js');
        expect(entry.indexOf('await configureTermuxStartup(cliArgs)')).toBeGreaterThanOrEqual(0);
        expect(entry.indexOf('await configureTermuxStartup(cliArgs)')).toBeLessThan(entry.indexOf('await import(\'./src/server-main.js\')'));
        const source = read('../src/server-main.js');
        const boot = source.slice(source.indexOf('initUserStorage(globalThis.DATA_ROOT)'));
        const stages = ['.then(ensurePublicDirectoriesExist)', '.then(initialiseRoleplayStorage)', '.then(migrateUserData)',
            '.then(migrateConversationOwnership)', '.then(preSetupTasks)', 'new ServerStartup(app, cliArgs).start()', '.then(postSetupTasks)'];
        const positions = stages.map(stage => boot.indexOf(stage));
        expect(positions.every(position => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(source).toContain('bootstrapRoleplayAccount({ owner: path.basename(directories.root), directories }, roleplayNativeHost)');
    });

    test('new profiles initialise explicitly and do not replay an old handle’s retained storage', () => {
        const source = read('../src/endpoints/users-admin.js').split('router.post(\'/create\'')[1].split('router.post(\'/delete\'')[0];
        expect(source.indexOf('roleplayStoreDirectory(scope)')).toBeLessThan(source.indexOf('bootstrapRoleplayAccount(scope'));
        expect(source.indexOf('bootstrapRoleplayAccount(scope')).toBeLessThan(source.indexOf('await storage.setItem'));
        expect(source).toContain('response.status(409)');
    });

    test('settings expose only read account evidence and the browser binds that exact account', () => {
        const source = read('../src/endpoints/settings.js');
        expect(source).toContain('withRoleplayAccount({ owner: request.user.profile.handle, directories: request.user.directories }, null, (_lease, current) => current)');
        expect(source).toContain('roleplayAccount,');
        expect(source).not.toContain('bootstrapRoleplayAccount');
        expect(read('../public/script.js')).toContain('bindRoleplayAccount(data.inChatAgentAccount, data.roleplayAccount)');
    });
});
