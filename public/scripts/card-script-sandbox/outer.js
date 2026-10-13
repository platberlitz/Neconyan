import { CARD_SCRIPT_PROTOCOL_VERSION, CARD_SCRIPT_PERMISSIONS, MAX_CARD_DOCUMENT_LENGTH } from './policy.js';
import { MESSAGE_TYPE, MESSAGE_VERSION, RESIZE_MESSAGE_TYPE, READY_MESSAGE_TYPE, BOOTSTRAP_MESSAGE_TYPE, INIT_MESSAGE_TYPE } from './messages.js';

// This function is also serialised into the fixed server response. It has no module dependencies.
export function detectCardScriptProtection(platform, timeoutMs = 700) {
    try {
        for (const name of ['NeconyanExport', 'NeconyanAndroid']) {
            const bridge = platform[name];
            if (bridge && bridge.bridgeRequiresToken?.() !== true) return Promise.resolve('android-bridge');
        }
    } catch { return Promise.resolve('android-bridge'); }
    const Observer = platform.ReportingObserver;
    const Peer = platform.RTCPeerConnection;
    const delay = platform.setTimeout.bind(platform);
    const cancel = platform.clearTimeout.bind(platform);
    if (typeof Observer !== 'function' || typeof Peer !== 'function') return Promise.resolve('unsupported');
    return new Promise(resolve => {
        let observer;
        let timer;
        let finished = false;
        const finish = result => {
            if (finished) return;
            finished = true;
            cancel(timer);
            observer?.disconnect();
            resolve(result);
        };
        try {
            observer = new Observer(reports => {
                for (const report of reports) {
                    const body = report.body;
                    if (report.type === 'connection-allowlist' && body?.connection === 'webrtc' && body.disposition === 'enforce' && Array.isArray(body.allowlist) && body.allowlist.length === 0) finish('protected');
                }
            }, { types: ['connection-allowlist'], buffered: false });
            observer.observe();
            timer = delay(() => finish('unsupported'), timeoutMs);
            try { const peer = new Peer({ iceServers: [] }); peer.close(); } catch { /* Only a native enforcement report qualifies. */ }
        } catch { finish('unsupported'); }
    });
}

export function buildTrustedOuterDocument() {
    const config = { protocol: CARD_SCRIPT_PROTOCOL_VERSION, version: MESSAGE_VERSION, slash: MESSAGE_TYPE, resize: RESIZE_MESSAGE_TYPE, ready: READY_MESSAGE_TYPE, bootstrap: BOOTSTRAP_MESSAGE_TYPE, init: INIT_MESSAGE_TYPE, permissions: CARD_SCRIPT_PERMISSIONS, maxDocumentLength: MAX_CARD_DOCUMENT_LENGTH };
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:160px;border:0}</style></head><body><script>(${trustedOuterBootstrap.toString()})(${JSON.stringify(config)},${detectCardScriptProtection.toString()});</script></body></html>`;
}

function trustedOuterBootstrap(config, detect) {
    const fields = new URLSearchParams(location.hash.slice(1));
    const messageId = Number(fields.get('messageId'));
    const nonce = fields.get('nonce');
    if (fields.size !== 3 || !/^\d+$/.test(fields.get('messageId') ?? '') || !Number.isSafeInteger(messageId) || messageId < 0 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce ?? '') || fields.get('protocol') !== String(config.protocol)) return;
    const hostOrigin = new URL(location.href).origin;
    const send = data => parent.postMessage({ version: config.version, protocol: config.protocol, messageId, nonce, ...data }, hostOrigin);
    let protection = 'checking';
    let initialised = false;
    let child = null;
    let cardNonce = null;
    let frame = null;
    const timestamps = [];
    addEventListener('message', event => {
        const data = event.data;
        if (!data || data.version !== config.version || data.messageId !== messageId) return;
        if (data.type === config.init) {
            if (event.source !== parent || event.origin !== hostOrigin || data.nonce !== nonce || data.protocol !== config.protocol || initialised) return;
            if (protection !== 'protected' && !(protection === 'unsupported' && data.allowUnprotected === true)) return;
            if (typeof data.document !== 'string' || !data.document.length || data.document.length > config.maxDocumentLength || typeof data.cardNonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(data.cardNonce) || typeof data.title !== 'string' || data.title.length > 256 || typeof data.allowUnprotected !== 'boolean') return;
            initialised = true;
            cardNonce = data.cardNonce;
            frame = document.createElement('iframe');
            frame.className = 'card-script-content-frame';
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.setAttribute('allow', config.permissions);
            frame.title = data.title;
            frame.srcdoc = data.document;
            document.body.appendChild(frame);
            child = frame.contentWindow;
            return;
        }
        if (!initialised || event.source !== child || data.nonce !== cardNonce || ![config.slash, config.resize, config.ready].includes(data.type)) return;
        const now = Date.now();
        while (timestamps.length && timestamps[0] <= now - 1000) timestamps.shift();
        if (timestamps.length >= 20) return;
        const relay = { type: data.type };
        if (data.type === config.slash) {
            if (typeof data.command !== 'string' || data.command.length > 2000) return;
            relay.command = data.command;
        } else if (data.type === config.resize) {
            if (typeof data.height !== 'number' || !Number.isFinite(data.height) || data.height < 0) return;
            relay.height = Math.max(48, Math.min(4096, Math.ceil(data.height)));
            frame.style.height = `${relay.height}px`;
        }
        timestamps.push(now);
        send(relay);
    });
    detect(window).then(result => {
        protection = result;
        send({ type: config.bootstrap, protection });
    });
}
