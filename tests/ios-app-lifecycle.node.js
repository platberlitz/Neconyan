// The Swift side cannot be compiled or run here, so these checks pin its wiring to the page and the local server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function block(source, start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end} after ${start}`);
    return source.slice(from, to);
}

test('the iPhone app tells the page when it is paused, sent away and brought back', () => {
    const controller = read('ios/App/BrowserController.swift');
    assert.match(controller, /selector: #selector\(pause\), name: UIApplication\.willResignActiveNotification/);
    assert.match(controller, /selector: #selector\(background\), name: UIApplication\.didEnterBackgroundNotification/);
    assert.match(controller, /selector: #selector\(resume\), name: UIApplication\.didBecomeActiveNotification/);
    assert.match(controller, /@objc private func pause\(\) \{ notifyAppLifecycle\("paused"\) \}/);
    assert.match(block(controller, '@objc private func background()', '\n    }'), /notifyAppLifecycle\("stopped"\)/);
    assert.match(block(controller, '@objc private func resume()', '\n    }'), /notifyAppLifecycle\("resumed"\)/);

    const notify = block(controller, 'private func notifyAppLifecycle(_ state: String)', '\n    }');
    assert.match(notify, /guard !recoveryRequired, let web, let url = web\.url, isLocal\(url\), \["paused", "stopped", "resumed"\]\.contains\(state\)/);
    assert.match(notify, /new CustomEvent\('neconyan:app-lifecycle',\{detail:\{state:'\\\(state\)'\}\}\)/);
});

test('coming back checks the local server without ever reloading a working page', () => {
    const controller = read('ios/App/BrowserController.swift');
    const resume = block(controller, '@objc private func resume()', '\n    }');
    assert.match(resume, /if url\.path == "\/login" \|\| web\.isHidden \{ connect\(\) \} else \{ checkLocalServer\(\) \}/);

    const check = block(controller, 'private func checkLocalServer()', '\n    /// ');
    assert.match(check, /guard !checkingServer, let server, server\.started else \{ return \}/);
    assert.match(check, /defer \{ checkingServer = false \}/);
    assert.match(check, /if await server\.answers\(\)/);
    assert.match(check, /if let message = server\.nodeExitMessage \{[\s\S]*?showRecovery\(message, reason: "local-server-stopped"\)/);
    assert.doesNotMatch(check, /connect\(\)|\.reload|\.load\(/);

    const server = read('ios/App/LocalServer.swift');
    const answers = block(server, 'func answers() async -> Bool', '\n    }');
    assert.match(answers, /appendingPathComponent\("version"\)/);
    assert.match(answers, /httpShouldHandleCookies = false/);
    assert.match(answers, /return response is HTTPURLResponse/);
});

test('the server reopens its own listener in both phone apps', () => {
    const startup = read('src/server-startup.js');
    assert.match(startup, /#isPhoneApp\(\) \{\s*return process\.env\.NECONYAN_ANDROID_APP === '1' \|\| process\.env\.NECONYAN_IOS_APP === '1';/);
    assert.equal(startup.match(/if \(this\.#isPhoneApp\(\)\) keepAppListenerOpen\(server, listenOptions\);/g)?.length, 2);
    assert.equal(startup.match(/server\.listen\(listenOptions\);/g)?.length, 2);
});
