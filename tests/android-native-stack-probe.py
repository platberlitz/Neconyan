"""Exercise V8's stack guard inside the installed APK on a disposable rooted emulator.

Run after android-apk-smoke.py. This changes only the emulator's extracted runtime,
never the APK or saved chats. A caught RangeError must not kill the server process.
"""
import argparse
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
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
'''
subprocess.run(['adb', '-s', args.serial, 'shell', 'cat >> ' + runtime[0]], input=probe, text=True, check=True, timeout=30)
adb('shell', 'am', 'start', '-n', package + '/io.github.platberlitz.neconyan.MainActivity')
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    log = adb('shell', 'cat', root + '/cache/server.log')
    if 'ANDROID_STACK_GUARD_OK' in log:
        print(log[-4000:], flush=True)
        break
    time.sleep(1)
else:
    print(adb('logcat', '-d'), flush=True)
    raise AssertionError('The APK did not survive a caught stack overflow')
