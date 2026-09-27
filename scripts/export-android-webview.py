"""Export the SDK emulator's WebView after its package service is ready."""

import hashlib
from pathlib import Path
import subprocess
import time
import zipfile


destination = Path('webview')
destination.mkdir(exist_ok=True)
apk = destination / 'webview.apk'
deadline = time.monotonic() + 60
last_error = ''
while time.monotonic() < deadline:
    try:
        provider = subprocess.check_output(['adb', 'shell', 'dumpsys', 'webviewupdate'], text=True, timeout=15)
        (destination / 'provider.txt').write_text(provider)
        paths = subprocess.check_output(['adb', 'shell', 'pm', 'path', 'com.android.webview'], text=True, timeout=15)
        source = next((line.removeprefix('package:').strip() for line in paths.splitlines() if line.startswith('package:')), '')
        if not source:
            raise RuntimeError(f'WebView package is not available yet: {paths.strip()}')
        subprocess.run(['adb', 'pull', source, str(apk)], check=True, timeout=30)
        with zipfile.ZipFile(apk) as archive:
            if 'AndroidManifest.xml' not in archive.namelist():
                raise RuntimeError('The exported file is not an APK.')
        digest = hashlib.sha256(apk.read_bytes()).hexdigest()
        (destination / 'SHA256SUMS').write_text(f'{digest}  webview.apk\n')
        print(provider, flush=True)
        print(f'Exported {source}: {apk.stat().st_size} bytes, SHA256 {digest}', flush=True)
        break
    except (subprocess.SubprocessError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        last_error = str(error)
        print(f'WebView export is not ready: {last_error}', flush=True)
        time.sleep(2)
else:
    raise RuntimeError(f'Could not export the SDK WebView within 60 seconds: {last_error}')
