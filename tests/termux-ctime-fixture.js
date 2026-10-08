import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

if (process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1') {
    throw new Error('The Termux timestamp fixture is only for disposable test servers.');
}
process.env.TERMUX_VERSION = 'timestamp-fixture';
if (process.env.NECONYAN_TERMUX_TEST_HOME) os.homedir = () => process.env.NECONYAN_TERMUX_TEST_HOME;
for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[method];
    fs[method] = (...args) => {
        const stat = original(...args);
        if (stat && typeof stat.dev === 'bigint') {
            stat.birthtimeNs = stat.ctimeNs;
            stat.birthtimeMs = stat.ctimeMs;
            stat.birthtime = stat.ctime;
        }
        return stat;
    };
}
syncBuiltinESMExports();
