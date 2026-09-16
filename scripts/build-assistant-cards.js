#!/usr/bin/env node
// Embeds each bundled assistant's card.json into its card.png.
// The installer copies card.png, so run this after editing any card.json:
//   node scripts/build-assistant-cards.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, write } from '../src/character-card-parser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'default/content/assistants');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

for (const personality of manifest.personalities) {
    for (const variant of personality.variants) {
        const pngPath = path.join(root, variant.card);
        const card = fs.readFileSync(path.join(root, variant.source), 'utf8');
        fs.writeFileSync(pngPath, write(fs.readFileSync(pngPath), card));
        const embedded = JSON.parse(read(fs.readFileSync(pngPath)));
        if (JSON.stringify(embedded.data) !== JSON.stringify(JSON.parse(card).data)) throw new Error(`Round-trip mismatch for ${variant.id}`);
        console.log(`${variant.id}: embedded ${card.length} bytes`);
    }
}
