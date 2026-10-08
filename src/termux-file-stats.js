import os from 'node:os';
import { isBunRuntime, isNativeTermuxEnvironment } from './runtime.js';
import { probeTermuxFileIdentity, useZeroTermuxBirthtime } from './termux-file-identity.js';

// Explicit 1.2.1 recovery preloads probe temp storage; normal startup passes its saved policy to workers.
if (isNativeTermuxEnvironment() && !isBunRuntime()) {
    const device = process.env.NECONYAN_TERMUX_ZERO_BIRTHTIME_DEVICE;
    if (device) useZeroTermuxBirthtime(device);
    else {
        const probe = await probeTermuxFileIdentity(os.tmpdir());
        if (probe.fallback) {
            useZeroTermuxBirthtime(probe.device);
            console.info('Termux file creation times are unavailable; file identity uses device and inode numbers.');
        }
    }
}
