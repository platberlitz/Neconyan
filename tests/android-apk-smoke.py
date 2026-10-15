"""Install an APK on an explicitly selected emulator and check local data recovery.

python3 tests/android-apk-smoke.py --adb PATH --serial emulator-5554 --apk PATH
Debug builds use their separate application ID. --release requires a disposable,
root-capable emulator and checks the official signed application instead.
"""
import argparse
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import time
import threading
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


def private(*command):
    """Run a command as the app (root on release emulators) inside its private directory."""
    if args.release:
        return adb('shell', 'cd /data/user/0/' + package + ' && ' + ' '.join(command))
    return adb('shell', 'run-as', package, *command)


def server_pid():
    return subprocess.run([args.adb, '-s', args.serial, 'shell', 'pidof', package + ':server'],
                          capture_output=True, text=True, timeout=30).stdout.strip()


def server_wake_held():
    power = adb('shell', 'dumpsys', 'power')
    if 'Wake Locks: size=' in power:
        power = power.split('Wake Locks: size=', 1)[1].split('\n\n', 1)[0]
    return "'Neconyan:server'" in power


def server_busy():
    return 'android-busy' in private('ls', 'files').split()


def wait_until(check, seconds, message):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(2)
    raise AssertionError(message)


def check_idle_wake_lock(request, token):
    """Work keeps the phone awake; an idle server lets it sleep again."""
    request('/api/settings/get', {}, token)
    assert server_busy(), 'A request did not mark the server busy'
    wait_until(lambda: not server_busy() and not server_wake_held(), 120, 'An idle server still keeps the phone awake')
    # The app follows the marker in both directions, not only once at startup.
    private('touch', 'files/android-busy')
    wait_until(server_wake_held, 20, 'The app did not keep the phone awake for busy work')
    private('rm', '-f', 'files/android-busy')
    wait_until(lambda: not server_wake_held(), 20, 'The app kept the phone awake after the work finished')
    print('The server holds its wake lock only while it is working.', flush=True)


def window_labels():
    try:
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/neconyan-window.xml')
        screen = adb('shell', 'cat', '/data/local/tmp/neconyan-window.xml')
        return {node.get('text', '') for node in ET.fromstring(screen).iter('node')}
    except (subprocess.SubprocessError, ET.ParseError):
        return set()


def check_crash_report():
    # UI Automator only includes the visible part of this native ScrollView.
    # Keep the labels encountered while scrolling, rather than requiring the
    # summary, both actions and the full report to fit on a small screen at once.
    labels = set()
    for _ in range(12):
        adb('shell', 'uiautomator', 'dump', '/data/local/tmp/neconyan-window.xml')
        screen = adb('shell', 'cat', '/data/local/tmp/neconyan-window.xml')
        Path('android-window.xml').write_text(screen)
        tree = ET.fromstring(screen)
        labels.update(node.get('text', '') for node in tree.iter('node'))
        actions = {'copy report', 'share report'}.issubset({label.casefold() for label in labels})
        server = any('Component: server\n' in label for label in labels)
        if actions and server:
            print('The crashed server shows an individual report with Copy and Share actions.', flush=True)
            return
        scroll = next((node for node in tree.iter('node') if node.get('scrollable') == 'true'), None)
        assert scroll is not None, 'The crash report has no scrollable details: ' + repr(labels)
        left, top, right, bottom = map(int, re.findall(r'\d+', scroll.get('bounds', '')))
        x = str((left + right) // 2)
        inset = max(1, (bottom - top) // 5)
        adb('shell', 'input', 'swipe', x, str(bottom - inset), x, str(top + inset), '400')
    raise AssertionError('The saved report did not expose both actions and the server details: ' + repr(labels))


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
                with client.open(urllib.request.Request(origin + path, data=payload, headers=headers), timeout=120) as response:
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


def check_long_chat(request, token):
    """Exercise the packaged tokenizer and completion transport without a paid API."""
    messages = [{'role': 'assistant' if i % 2 else 'user',
                 'content': f'Message {i}. ' + 'The old story continues, with a familiar character and another choice. ' * 5}
                for i in range(1600)]
    pid = server_pid()
    counts = json.loads(request('/api/tokenizers/openai/count?model=mimo-2.5-pro&per_message=1', messages, token))
    assert len(counts['token_counts']) == len(messages) and min(counts['token_counts']) > 0, counts
    combined = json.loads(request('/api/tokenizers/openai/count?model=mimo-2.5-pro',
                                  [{'role': 'user', 'content': '\n'.join(m['content'] for m in messages)}], token))
    assert combined['token_count'] > 100000, combined
    assert server_pid() == pid, 'Token counting restarted the server'
    received = []

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            received.append(body)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
            self.end_headers()
            if body.get('stream'):
                payload = 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': 'Android long chat survived.'}}]})
                self.wfile.write((payload + '\n\ndata: [DONE]\n\n').encode())
            else:
                self.wfile.write(json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'Android long chat survived.'}, 'finish_reason': 'stop'}]}).encode())

    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    provider_port = str(provider.server_address[1])
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    adb('reverse', 'tcp:' + provider_port, 'tcp:' + provider_port)
    try:
        for kind, streaming in [('normal', False), ('regenerate', True), ('normal', True)]:
            response = request('/api/backends/chat-completions/generate', {
                'chat_completion_source': 'custom', 'custom_url': 'http://127.0.0.1:' + provider_port + '/v1',
                'model': 'mimo-2.5-pro', 'messages': messages, 'type': kind, 'stream': streaming, 'max_tokens': 32,
            }, token)
            assert 'Android long chat survived.' in response, response
            assert server_pid() == pid, 'A long-chat completion restarted the server'
        assert len(received) == 3 and all(body['messages'] == messages for body in received)
        print('1600-message token counts, a combined long prompt, sends and streaming regeneration passed without a server restart.', flush=True)
    finally:
        adb('reverse', '--remove', 'tcp:' + provider_port)
        provider.shutdown()
        provider.server_close()


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
    check_long_chat(request, token)
    adb('shell', 'input', 'keyevent', '3')
    time.sleep(2)
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    print('The local server remains available with the Activity in the background.', flush=True)
    check_idle_wake_lock(request, token)
    adb('shell', 'am', 'force-stop', package)
finally:
    adb('forward', '--remove', 'tcp:' + port)

start()
request, token, port, origin = connect()
try:
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    print('Character survived process death and reopening.', flush=True)
    wait_for_workspace()
finally:
    adb('forward', '--remove', 'tcp:' + port)

# A server that dies from a segmentation fault (the real-world native crash) leaves its
# ready marker behind. The open app must notice, restart it once in safe mode, load the
# workspace again and keep a readable crash record plus the requests that preceded it.
crashed = server_pid()
private('kill', '-SEGV', crashed)


def restarted_server():
    # While the crash dumper works, the dying process briefly has a forked helper with the
    # same name, so pidof can list two pids. Only a single, different pid is a restart.
    pids = server_pid().split()
    return pids[0] if len(pids) == 1 and pids[0] != crashed else ''


deadline = time.monotonic() + 120
while time.monotonic() < deadline and not restarted_server():
    time.sleep(1)
assert restarted_server(), 'The app did not restart its crashed server'
request, token, port, origin = connect()
try:
    assert json.loads(private('cat', 'files/android-ready.json')).get('safe') is True, 'The restart after an early stop was not in safe mode'
    deadline = time.monotonic() + 60
    labels = set()
    while time.monotonic() < deadline:
        labels = window_labels()
        if 'Crash report' in labels:
            break
        time.sleep(1)
    assert 'Crash report' in labels, 'The crashed server did not show its saved report'
    check_crash_report()
    adb('shell', 'input', 'keyevent', '4')
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        labels = window_labels()
        if 'Neconyan is in safe mode' in labels:
            break
        if 'Crash report' in labels:
            # Node and Android can retain separate reports for the same stop.
            check_crash_report()
            adb('shell', 'input', 'keyevent', '4')
        time.sleep(1)
    assert 'Neconyan is in safe mode' in window_labels(), 'The safe-mode notice did not appear'
    adb('shell', 'input', 'keyevent', '4')
    wait_for_workspace()
    assert name in request('/api/characters/get', {'avatar_url': avatar}, token)
    previous = private('cat', 'cache/requests.previous.txt')
    assert '/api/' in previous, 'The previous start left no request trace: ' + previous
    # Android attaches the crash dumper's tombstone to the exit record from API 31 on, a
    # few seconds after the process died; the launcher decodes it 5 s and 20 s after the restart.
    if int(adb('shell', 'getprop', 'ro.build.version.sdk')) >= 31:
        record = ''
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and 'Signal 11' not in record:
            time.sleep(2)
            record = subprocess.run([args.adb, '-s', args.serial, 'shell', 'cd /data/user/0/' + package + ' && cat cache/native-crash.txt'],
                                    capture_output=True, text=True, timeout=30).stdout
        assert 'Signal 11 (SIGSEGV)' in record, 'No decoded crash record was written: ' + record
        assert 'Crashing thread:' in record and '#00 pc' in record, 'The crash record has no backtrace: ' + record
        print('The crash left a decoded native crash record with a backtrace.', flush=True)
    print('A crashed server restarted in safe mode with its data, the workspace reloaded and the request trace survived.', flush=True)
    adb('shell', 'am', 'force-stop', package)
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
