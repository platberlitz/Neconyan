/** Synthetic backend-only timings. Run with Node 24 from the checkout to measure. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

// Using cwd also lets this script measure an older checkout without copying it.
const repo = process.cwd();
const load = file => import(pathToFileURL(path.join(repo, file)));
process.env.SILLYTAVERN_PERFORMANCE_USEDISKCACHE = 'false';
const { setConfigFilePath } = await load('src/util.js');
setConfigFilePath(path.join(repo, 'default/config.yaml'));
const { router: settings } = await load('src/endpoints/settings.js');
const { router: characters } = await load('src/endpoints/characters.js');
const { readQuickImageGenSettings } = await load('src/generation/quick-image-gen.js');
const { write } = await load('src/character-card-parser.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-reads-benchmark-'));
const directories = { root };

function handler(router, route) {
    return router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
}

async function call(fn, body = {}) {
    let result;
    await fn({ body, user: { profile: { handle: 'benchmark' }, directories } }, {
        send: value => { result = value; },
        json: value => { result = value; },
        sendStatus: status => { throw new Error(String(status)); },
    });
    return result;
}

async function measure(name, run) {
    const begin = performance.now();
    const initial = await run();
    const cold = performance.now() - begin;
    const samples = [];
    for (let i = 0; i < 9; i++) {
        const start = performance.now();
        const value = await run();
        samples.push(performance.now() - start);
        if (JSON.stringify(initial) !== JSON.stringify(value)) throw new Error(`${name}: output changed`);
    }
    samples.sort((a, b) => a - b);
    return {
        name,
        coldMs: +cold.toFixed(2),
        medianMs: +samples[4].toFixed(2),
        checksum: createHash('sha256').update(JSON.stringify(initial)).digest('hex'),
    };
}

try {
    for (const key of ['characters', 'novelAI_Settings', 'openAI_Settings', 'textGen_Settings', 'koboldAI_Settings', 'instruct', 'context', 'sysprompt', 'reasoning', 'quickreplies']) {
        directories[key] = path.join(root, key);
        fs.mkdirSync(directories[key]);
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    const rows = Array.from({ length: 160 }, (_, i) => ({ name: `entry-${i}`, text: 'synthetic card and preset content '.repeat(6) }));
    for (let i = 0; i < 192; i++) {
        fs.writeFileSync(path.join(directories.characters, `card-${String(i).padStart(3, '0')}.png`), write(png, JSON.stringify({
            name: `Card ${i}`,
            rows,
            data: { extensions: i < 9 ? { neconyan_assistant: { id: 'miso-male', version: 1 } } : {} },
        })));
    }
    for (let i = 0; i < 128; i++) {
        fs.writeFileSync(path.join(directories.openAI_Settings, `preset-${i}.json`), JSON.stringify({ name: `Preset ${i}`, rows }, null, 2));
    }
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({
        extension_settings: {
            'quick-image-gen': { provider: 'openai', model: 'fixture' },
            unrelated: Array.from({ length: 200 }, () => rows),
        },
    }, null, 2));
    console.log(JSON.stringify({
        settingsBytes: fs.statSync(path.join(root, 'settings.json')).size,
        results: [
            await measure('preset catalogue (128 presets)', () => call(handler(settings, '/get'), { sections: ['presets'] })),
            await measure('assistant catalogue (192 cards)', () => call(handler(characters, '/assistants'))),
            await measure('image settings (large unrelated blocks)', () => readQuickImageGenSettings(directories)),
        ],
    }, null, 2));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
