/** Private, fixed-purpose access to the existing JanitorAI browser session. */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const PUBLIC_FILTERS = {
    sections: { popular: 'Popular', trending24: 'Trending · last 24 hours', trending: 'Trending · this week', latest: 'Latest' },
    modes: { all: 'All public characters', sfw: 'SFW only' },
};

export async function startBeauBridge(browser, socketPath = process.env.BEAU_JANITOR_SOCKET) {
    if (!socketPath) return null;
    if (!path.isAbsolute(socketPath)) throw new Error('The Janitor socket must use an absolute path.');
    if (fs.existsSync(socketPath)) {
        const stat = fs.lstatSync(socketPath);
        if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error('The Janitor socket path is already occupied.');
        const active = await new Promise((resolve) => {
            const socket = net.createConnection(socketPath);
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('error', () => resolve(false));
            socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
        });
        if (active) throw new Error('The Janitor socket is already active.');
        fs.unlinkSync(socketPath);
    }
    const server = http.createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        const url = new URL(request.url, 'http://botsearcher');
        if (request.method !== 'GET' || !['/popular', '/filters', '/characters'].includes(url.pathname)
            || (url.pathname !== '/characters' && url.search)) {
            response.writeHead(404).end('{"error":"Unknown browser operation."}');
            return;
        }
        const section = url.searchParams.get('section') || 'popular';
        const mode = url.searchParams.get('mode') || 'all';
        if ([...url.searchParams.keys()].some((key) => !['section', 'mode'].includes(key) || url.searchParams.getAll(key).length !== 1)
            || !Object.hasOwn(PUBLIC_FILTERS.sections, section) || !Object.hasOwn(PUBLIC_FILTERS.modes, mode)) {
            response.writeHead(400).end('{"error":"Choose a supported public section and content filter."}');
            return;
        }
        try {
            const body = JSON.stringify(url.pathname === '/filters' ? PUBLIC_FILTERS : await browser.frontpage(section, mode));
            if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('oversized');
            response.end(body);
        } catch (error) {
            const login = error?.code === 'janny_login_required';
            response.writeHead(login ? 401 : 503).end(JSON.stringify({ error: login
                ? 'Open BotSearcher’s JanitorAI login on the server and sign in again.'
                : 'The BotSearcher JanitorAI browser could not read the requested public character list.' }));
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    return {
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
