'use strict';

const labels = require('./labels.json');

const BLOCKING_LABELS = new Set(Object.values(labels)
    .filter(label => label.blocksMerge)
    .flatMap(label => [label.name, ...(label.legacy ?? [])]));

module.exports = { BLOCKING_LABELS };
