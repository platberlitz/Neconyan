"""Install an APK on an explicitly selected emulator and check local data recovery.

python3 tests/android-apk-smoke.py --adb PATH --serial emulator-5554 --apk PATH
Debug builds use their separate application ID. --release requires a disposable,
root-capable emulator and checks the official signed application instead.
"""
import argparse
import http.cookiejar
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--adb', default='adb')
parser.add_argument('--serial', required=True)
parser.add_argument('--apk', required=True)
parser.add_argument('--release', action='store_true', help='Check the signed app on a disposable root-capable emulator')
parser.add_argument('--update-webview', help='Check the old-WebView screen, then install the SDK reference WebView APK')
args = parser.parse_args()
if not args.serial.startswith('emulator-'):
    parser.error('This destructive lifecycle check is restricted to an emulator.')
package = 'io.github.platberlitz.neconyan' + ('' if args.release else '.debug')


def adb(*command):
    return subprocess.check_output([args.adb, '-s', args.serial, *command], text=True, timeout=30).strip()


def start():
    adb('shell', 'am', 'start', '-n', package + '/io.github.platberlitz.neconyan.MainActivity')


def wait_for_workspace():
    deadline = time.monotonic() + 120
    last = ''
    failure = None
    while time.monotonic() < deadline:
        try:
            adb('shell', 'uiautomator', 'dump', '/data/local/tmp/neconyan-window.xml')
            last = adb('shell', 'cat', '/data/local/tmp/neconyan-window.xml')
            labels = {node.get(attribute, '') for node in ET.fromstring(last).iter('node')
                      for attribute in ('text', 'content-desc')}
            if labels.intersection({'Meowlcome to Neconyan~', 'First paws: connect a model'}):
                print('The Android app displays its loaded Home screen or introductory tour.', flush=True)
                return
        except (subprocess.SubprocessError, ET.ParseError) as error:
            failure = error
        time.sleep(1)
    Path('android-window.xml').write_text(last)
    # Capture before the emulator action shuts down its device on script failure.
    for command, filename in [(('logcat', '-d'), 'android-logcat.txt'),
                              (('shell', 'dumpsys', 'webviewupdate'), 'android-webview.txt')]:
        with open(filename, 'w') as output:
            subprocess.run([args.adb, '-s', args.serial, *command], stdout=output, stderr=subprocess.STDOUT, timeout=20, check=False)
    with open('android-screen.png', 'wb') as screenshot:
        subprocess.run([args.adb, '-s', args.serial, 'exec-out', 'screencap', '-p'], stdout=screenshot, timeout=20, check=False)
    raise AssertionError('The Android workspace did not become visible: ' + str(failure or 'Home and tour controls were absent'))


def connect():
    deadline = time.monotonic() + 300
    failure = None
    while time.monotonic() < deadline:
        try:
            if args.release:
                credentials = json.loads(adb('shell', 'cat', '/data/user/0/' + package + '/no_backup/launcher.json'))
            else:
                credentials = json.loads(adb('shell', 'run-as', package, 'cat', 'no_backup/launcher.json'))
            port = adb('forward', 'tcp:0', 'tcp:' + str(credentials['port']))
            origin = 'http://127.0.0.1:' + port
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            def request(path, body=None, csrf=None):
                headers = {'Content-Type': 'application/json'}
                if csrf:
                    headers['X-CSRF-Token'] = csrf
                payload = None if body is None else json.dumps(body).encode()
                with client.open(urllib.request.Request(origin + path, data=payload, headers=headers), timeout=15) as response:
                    return response.read().decode()
            token = json.loads(request('/csrf-token'))['token']
            request('/api/auth/browser/login', {'username': 'neconyan', 'password': credentials['password'], 'remember': True}, token)
            assert 'Neconyan' in request('/')
            return request, token, port, origin
        except Exception as error:
            failure = error
            if 'port' in locals():
                adb('forward', '--remove', 'tcp:' + port)
            time.sleep(1)
    raise RuntimeError('Android server did not start: ' + str(failure))


if args.release:
    adb('root')
    adb('wait-for-device')
    assert adb('shell', 'id', '-u') == '0', 'Signed app acceptance needs a root-capable disposable emulator'
print(adb('shell', 'dumpsys', 'webviewupdate'), flush=True)
print(adb('install', '-r', args.apk), flush=True)
if int(adb('shell', 'getprop', 'ro.build.version.sdk')) >= 33:
    adb('shell', 'pm', 'grant', package, 'android.permission.POST_NOTIFICATIONS')
adb('shell', 'am', 'force-stop', package)
start()
if args.update_webview:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/neconyan-window.xml')
        screen = adb('shell', 'cat', '/data/local/tmp/neconyan-window.xml')
        if 'Update Android System WebView' in screen:
            break
        time.sleep(1)
    else:
        raise AssertionError('The unsupported WebView did not show its update screen')
    Path('android-window.xml').write_text(screen)
    labels = {node.get('text', '').casefold() for node in ET.fromstring(screen).iter('node')}
    # Android's native button theme can capitalise the displayed labels.
    assert {'open webview settings', 'close neconyan'}.issubset(labels), labels
    assert adb('shell', 'test ! -f /data/user/0/' + package + '/no_backup/launcher.json && echo untouched') == 'untouched'
    # Exercise Back on the native screen before creating any WebView or server.
    adb('shell', 'input', 'keyevent', '4')
    adb('shell', 'am', 'force-stop', package)
    print('Unsupported WebView shows update instructions without starting the server.', flush=True)
    print(adb('install', '-r', args.update_webview), flush=True)
    selected = adb('shell', 'cmd', 'webviewupdate', 'set-webview-implementation', 'com.android.webview')
    assert 'Success' in selected, selected
    print(adb('shell', 'dumpsys', 'webviewupdate'), flush=True)
    start()
request, token, port, origin = connect()
try:
    wait_for_workspace()
    try:
        urllib.request.urlopen(urllib.request.Request(origin + '/api/settings/get', data=b'{}'), timeout=10)
        raise AssertionError('Private server accepted an unauthenticated settings request')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    name = 'Android acceptance ' + str(int(time.time()))
    avatar = request('/api/characters/create', {'ch_name': name, 'description': 'Retain this card through Android process death and APK replacement.', 'first_mes': 'Saved on this phone.'}, token)
    assert avatar.endswith('.png'), avatar
    print('Startup, private login, unauthenticated refusal and character creation passed.', flush=True)
    adb('shell', 'input', 'keyevent', '3')
    time.sleep(2)
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    print('The local server remains available with the Activity in the background.', flush=True)
    adb('shell', 'am', 'force-stop', package)
finally:
    adb('forward', '--remove', 'tcp:' + port)

start()
request, token, port, origin = connect()
try:
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    print('Character survived process death and reopening.', flush=True)
finally:
    adb('forward', '--remove', 'tcp:' + port)

print(adb('install', '-r', args.apk), flush=True)
start()
request, token, port, origin = connect()
try:
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    request('/api/characters/delete', {'avatar_url': avatar, 'delete_chats': True}, token)
    print('Character survived APK replacement; test card removed.', flush=True)
finally:
    adb('forward', '--remove', 'tcp:' + port)
