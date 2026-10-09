"""Exercise V8's stack guard inside the installed APK on a disposable rooted emulator.

Run after android-apk-smoke.py. This changes only the emulator's extracted runtime,
never the APK or saved chats. A caught RangeError must not kill the server process.
"""
import argparse
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--expect-segmenter-crash', action='store_true',
                    help='Confirm that a published APK without full ICU data crashes when it splits words.')
args = parser.parse_args()
if not args.serial.startswith('emulator-'):
    parser.error('This check changes a disposable emulator runtime only.')
package = 'io.github.platberlitz.neconyan'
root = '/data/user/0/' + package


def adb(*command):
    return subprocess.check_output(['adb', '-s', args.serial, *command], text=True, timeout=30).strip()


assert adb('shell', 'id', '-u') == '0'
adb('shell', 'am', 'force-stop', package)
runtime = adb('shell', 'find', root + '/no_backup', '-name', 'server-bootstrap.mjs').splitlines()
assert len(runtime) == 1, runtime
probe = r'''
// Disposable emulator-only stack guard regression probe.
let depth = 0;
try {
    function descend() { depth++; return descend() + 1; }
    descend();
    throw new Error('The stack guard did not fire');
} catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.info('ANDROID_STACK_GUARD_OK', depth);
}
// Out-of-bounds Wasm loads must also become catchable errors, not SIGSEGV.
const probeModule = new WebAssembly.Module(new Uint8Array([
    0,97,115,109,1,0,0,0, 1,6,1,96,1,127,1,127, 3,2,1,0,
    5,3,1,0,1, 7,8,1,4,114,101,97,100,0,0, 10,9,1,7,0,32,0,40,2,0,11,
]));
const probeInstance = new WebAssembly.Instance(probeModule);
for (let i = 0; i < 100; i++) {
    try {
        probeInstance.exports.read(65536);
        throw new Error('The Wasm bounds check did not fire');
    } catch (error) {
        if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    }
}
console.info('ANDROID_WASM_GUARD_OK');
// Mewmory's memory search splits words with Intl.Segmenter. Without ICU word-break data
// that call dereferences a null pointer inside V8 and kills the server (issue 80).
console.info('ANDROID_SEGMENTER_START');
const probeWords = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment('The old story continues.')]
    .filter(part => part.isWordLike).length;
const { terms: probeTerms } = await import('./public/scripts/util/lexical-search.js');
if (probeWords !== 4 || probeTerms('Makima kept the old story going').join(' ') !== 'makima kept the old story going') {
    throw new Error('Word splitting gave unexpected results');
}
console.info('ANDROID_SEGMENTER_OK', probeWords);
'''
subprocess.run(['adb', '-s', args.serial, 'shell', 'cat >> ' + runtime[0]], input=probe, text=True, check=True, timeout=30)
adb('logcat', '-c')
adb('shell', 'am', 'start', '-n', package + '/io.github.platberlitz.neconyan.MainActivity')
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    log = adb('shell', f'cat {root}/cache/server.log {root}/cache/server.previous.log 2>/dev/null; true')
    if args.expect_segmenter_crash:
        crash = adb('logcat', '-d', '-b', 'crash')
        if 'ANDROID_SEGMENTER_START' in log and 'JSSegments' in crash:
            assert 'ANDROID_SEGMENTER_OK' not in log
            print(crash[-6000:], flush=True)
            print('The published APK crashed in Intl.Segmenter, as on the reporter\'s phone.', flush=True)
            break
    elif 'ANDROID_STACK_GUARD_OK' in log and 'ANDROID_WASM_GUARD_OK' in log and 'ANDROID_SEGMENTER_OK' in log:
        print(log[-4000:], flush=True)
        break
    time.sleep(1)
else:
    print(adb('logcat', '-d'), flush=True)
    raise AssertionError('The packaged runtime did not behave as expected')
