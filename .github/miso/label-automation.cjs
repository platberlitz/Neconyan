'use strict';

const labels = require('./labels.json');
const sizeRules = Object.entries(labels).filter(([, label]) => Object.hasOwn(label, 'maxLines'))
    .sort(([, a], [, b]) => (a.maxLines ?? Infinity) - (b.maxLines ?? Infinity));
const typeRules = Object.entries(labels).filter(([, label]) => label.prTypes);
const ruleNames = rules => new Set(rules.flatMap(([, label]) => [label.name, ...(label.legacy ?? [])]));
const typeNames = ruleNames(typeRules);
const sizeNames = ruleNames(sizeRules);

function labelName(id, available) {
    const label = labels[id];
    if (!label) throw new Error(`Unknown label: ${id}`);
    return [label.name, ...(label.legacy ?? [])].find(name => available.has(name));
}

function renderCommentConfig(template, available) {
    return template.replace(/^([ \t]*- name: )'@([a-z-]+)@'$/gm, (_, prefix, id) =>
        `${prefix}${JSON.stringify(labelName(id, available) ?? labels[id].name)}`);
}

function planPrLabels({ title, files, current, available, totalLines }) {
    const names = new Set();
    const select = id => {
        const name = labelName(id, available);
        if (name) names.add(name);
        return name;
    };
    const type = title.match(/^(\w+)(?:\([a-z0-9._/-]+\))?!?: /)?.[1];
    const typeRule = typeRules.find(([, label]) => label.prTypes.includes(type));
    const typeSelected = typeRule && select(typeRule[0]);

    const paths = files.flatMap(({ filename, previous_filename }) => [filename, ...(previous_filename ? [previous_filename] : [])]);
    for (const [id, label] of Object.entries(labels)) {
        if (label.paths?.some(prefix => paths.some(path => path.startsWith(prefix)))) select(id);
    }

    // GitHub caps listFiles at 3,000. Use the full raw size at that limit so a
    // partial file list cannot understate the size. Normally exclude generated files.
    const lines = files.length >= 3000 ? totalLines : files.reduce((sum, file) => {
        return /(?:^|\/)(?:package-lock\.json|bun\.lock)$|^public\/lib\//.test(file.filename) ? sum : sum + file.changes;
    }, 0);
    const size = sizeRules.find(([, { maxLines }]) => lines <= (maxLines ?? Infinity));
    const sizeSelected = select(size[0]);

    return {
        add: [...names].filter(name => !current.has(name)),
        remove: [...current].filter(name => !names.has(name) && ((typeSelected && typeNames.has(name)) || (sizeSelected && sizeNames.has(name)))),
    };
}

function issuePlatformLabels(body, available) {
    // Issue forms store selected values as Markdown list items. Keep platform
    // and browser labels separate from the issue type set by the form.
    const environment = String(body.match(/^### Environment[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? '');
    const system = String(body.match(/^### System[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? '');
    return Object.entries(labels).flatMap(([id, label]) => {
        if (!label.issuePattern || !new RegExp(label.issuePattern, 'im').test(`${environment}\n${system}`)) return [];
        const name = labelName(id, available);
        return name ? [name] : [];
    });
}

async function repoLabelNames(github, repo) {
    return new Set((await github.paginate(github.rest.issues.listLabelsForRepo, repo)).map(label => label.name));
}

function linkedIssueNumbers(text) {
    return [...String(text ?? '').matchAll(/\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing))\s+#([1-9]\d*)\b/gi)]
        .map(match => Number(match[1])).filter(Number.isSafeInteger);
}

async function markIssuesDone({ github, repo, numbers, released }) {
    if (!numbers.length) return;
    const available = await repoLabelNames(github, repo);
    const done = labelName(released ? 'released' : 'done-staging', available);
    if (!done) throw new Error('Run the repository label sync before marking issues done.');
    for (const issue_number of new Set(numbers)) {
        const args = { ...repo, issue_number };
        const { data: issue } = await github.rest.issues.get(args);
        if (issue.pull_request) continue;
        const current = issue.labels.map(label => label.name);
        if (!current.includes(done)) await github.rest.issues.addLabels({ ...args, labels: [done] });
        const progress = labels['in-progress'];
        for (const name of current.filter(name => progress.name === name || progress.legacy.includes(name))) {
            await github.rest.issues.removeLabel({ ...args, name }).catch(error => { if (error.status !== 404) throw error; });
        }
    }
}

module.exports = { issuePlatformLabels, labelName, linkedIssueNumbers, markIssuesDone, planPrLabels, renderCommentConfig, repoLabelNames };
