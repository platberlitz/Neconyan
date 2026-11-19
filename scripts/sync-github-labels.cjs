'use strict';

const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const catalogue = require('../.github/miso/labels.json');
const REPO = 'platberlitz/Neconyan';
const ENDPOINT = `repos/${REPO}`;

function planLabelSync(existing, defaultReady, manifest = catalogue) {
    const existingByName = new Map(existing.map(label => [label.name.toLowerCase(), label]));
    return Object.entries(manifest).flatMap(([id, rule]) => {
        const matches = [rule.name, ...(rule.legacy ?? [])]
            .map(name => existingByName.get(name.toLowerCase())).filter(Boolean);
        if (matches.length > 1) throw new Error(`Multiple GitHub labels match ${id}: ${matches.map(label => label.name).join(', ')}. No labels have been changed.`);
        const old = matches[0];
        const held = rule.hold && !defaultReady;
        if (held && old?.name === rule.name) throw new Error(`${rule.name} is already present but the default branch is not ready. No labels have been changed.`);
        const name = held ? old?.name ?? rule.legacy[0] : rule.name;
        const attributes = { name, color: rule.colour, description: rule.description };
        return old?.name === name && old.color === attributes.color && old.description === attributes.description ? [] : [{ old: old?.name, ...attributes }];
    });
}

function ghJson(...args) {
    return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
}

function repoLabels() {
    const result = execFileSync('gh', ['api', '--paginate', `${ENDPOINT}/labels?per_page=100`, '--jq', '.[] | @base64'], { encoding: 'utf8' });
    return result.split('\n').filter(Boolean).map(line => JSON.parse(Buffer.from(line, 'base64').toString()));
}

function hasCatalogue(branch) {
    const files = ghJson(`${ENDPOINT}/contents/.github/miso?ref=${encodeURIComponent(branch)}`);
    const manifest = files.find(file => file.name === 'labels.json');
    if (!manifest || !files.some(file => file.name === 'label-automation.cjs')) return false;
    const blob = ghJson(`${ENDPOINT}/git/blobs/${manifest.sha}`);
    return isDeepStrictEqual(JSON.parse(Buffer.from(blob.content, 'base64').toString()), catalogue);
}

function sync(args) {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) throw new Error('Usage: node scripts/sync-github-labels.cjs [--apply]');
    const apply = args[0] === '--apply';
    const { default_branch: defaultBranch } = ghJson(ENDPOINT);
    const defaultReady = hasCatalogue(defaultBranch);
    if (apply && !hasCatalogue('staging')) throw new Error('Merge this catalogue into staging before applying it.');
    const operations = planLabelSync(repoLabels(), defaultReady);
    if (!defaultReady) console.log(`Keeping names still used by ${defaultBranch}. Run this again after normal release promotion to rename them in place.`);
    if (!operations.length) console.log('The repository labels match this catalogue.');
    for (const { old, name, color, description } of operations) {
        console.log(`${apply ? '' : 'Dry run: '}${!old ? `Create ${name}` : old === name ? `Update ${name}` : `Rename ${old} → ${name}`}`);
        if (!apply) continue;
        if (old) ghJson('--method', 'PATCH', `${ENDPOINT}/labels/${encodeURIComponent(old)}`, '-f', `new_name=${name}`, '-f', `color=${color}`, '-f', `description=${description}`);
        else ghJson('--method', 'POST', `${ENDPOINT}/labels`, '-f', `name=${name}`, '-f', `color=${color}`, '-f', `description=${description}`);
    }
}

if (require.main === module) {
    try { sync(process.argv.slice(2)); } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { planLabelSync };
