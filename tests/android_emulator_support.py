"""Bounded emulator startup recovery and diagnostics collected before shutdown."""
from pathlib import Path
import shlex
import subprocess
import time


def ensure_root(adb, attempts=3):
    """Retry only startup transport loss, never a failed root-permission check."""
    for attempt in range(attempts):
        try:
            adb('wait-for-device')
            adb('root')
            adb('wait-for-device')
            assert adb('shell', 'id', '-u') == '0', 'Signed app acceptance needs a root-capable disposable emulator'
            return
        except subprocess.CalledProcessError as error:
            output = str(error.output or '').lower()
            transient = any(text in output for text in (
                'device offline', 'device not found', 'no devices/emulators found',
                'unable to connect for root: closed', 'error: closed', 'transport error',
            ))
            if not transient or attempt + 1 == attempts:
                raise
        except subprocess.TimeoutExpired:
            if attempt + 1 == attempts:
                raise
        print('The emulator ADB connection reset during startup; retrying before installing the app.', flush=True)
        time.sleep(2)


def capture_failure(prefix, package, release, directory=Path('.')):
    """Each best-effort command is bounded; one failed capture cannot discard the others."""
    private = 'date; stat files/android-busy; cat cache/requests.txt'
    private = ('cd /data/user/0/' + package + ' && (' + private + ')') if release else (
        'run-as ' + package + ' sh -c ' + shlex.quote(private))
    commands = [
        ('android-power.txt', ['shell', 'dumpsys', 'power']),
        ('android-wake-state.txt', ['shell', private]),
        ('android-processes.txt', ['shell', 'ps', '-A']),
        ('android-logcat.txt', ['logcat', '-d']),
        ('android-webview.txt', ['shell', 'dumpsys', 'webviewupdate']),
        ('android-window.xml', ['shell', 'uiautomator dump /data/local/tmp/neconyan-failure.xml >/dev/null && cat /data/local/tmp/neconyan-failure.xml']),
        ('android-screen.png', ['exec-out', 'screencap', '-p']),
    ]
    errors = []
    for filename, command in commands:
        try:
            with (directory / filename).open('wb') as output:
                result = subprocess.run([*prefix, *command], stdout=output, stderr=subprocess.PIPE, timeout=15, check=False)
            if result.returncode:
                errors.append(filename + ': ' + result.stderr.decode(errors='replace'))
        except Exception as error:
            errors.append(filename + ': ' + str(error))
    (directory / 'android-diagnostic-errors.txt').write_text('\n'.join(errors))
