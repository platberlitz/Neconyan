/**
 * Fixed checks for a generation preset. Pure and dependency-free: the caller
 * supplies the snapshot read from the app.
 */
import { scanMacroProblems } from './macros.js';

const REQUIRED_CHAT_SLOTS = [
    ['chatHistory', 'Chat history'],
    ['charDescription', 'Character description'],
];

function target(name, module) {
    return { kind: 'preset', name, ...(module ? { module } : {}) };
}

function finding(name, module, rule, severity, message, details) {
    return { rule, severity, target: target(name, module), message, ...(details ? { details } : {}) };
}

function numeric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function sampler(values, key) {
    const list = Array.isArray(values?.samplers) ? values.samplers : [];
    return list.find(item => item?.key === key)?.value;
}

/**
 * Checks one preset snapshot from readCurrentPreset.
 * @param {object} preset Snapshot with kind, api, name, modules, values and connection
 * @param {{knownMacros?: Iterable<string>, modelContext?: number}} options Check context
 * @returns {{findings: object[], name: string}}
 */
export function checkPreset(preset, { knownMacros = [], modelContext = 0 } = {}) {
    const name = String(preset?.name || 'Unnamed preset');
    const modules = Array.isArray(preset?.modules) ? preset.modules : [];
    const values = preset?.values || {};
    const connection = preset?.connection || {};
    const findings = [];
    const push = (module, rule, severity, message, details) => findings.push(finding(name, module, rule, severity, message, details));

    if (preset?.kind === 'chat') {
        for (const [id, label] of REQUIRED_CHAT_SLOTS) {
            const slot = modules.find(item => item.id === id);
            if (!slot) push(id, 'preset-slot-missing', 'error', `The ${label} slot is missing, so that text never reaches the model.`);
            else if (!slot.enabled) push(id, 'preset-slot-off', 'warning', `The ${label} slot is switched off.`);
        }
    }

    const seen = new Set();
    for (const item of modules) {
        if (seen.has(item.id)) push(item.id, 'preset-duplicate-id', 'error', `Module ID ${item.id} appears more than once.`);
        seen.add(item.id);
        if (item.enabled && !item.marker && !String(item.content ?? '').trim()) {
            push(item.id, 'preset-module-empty', 'warning', `The enabled module ${item.name || item.id} is empty.`);
        }
    }

    if (knownMacros && [...knownMacros].length) {
        for (const item of modules) {
            const text = String(item.content ?? '');
            if (!text) continue;
            for (const problem of scanMacroProblems(text, { knownNames: knownMacros })) {
                push(item.id, problem.rule, problem.severity, `${item.name || item.id}: ${problem.message}`, problem.details);
            }
        }
    }

    const contextSize = numeric(values.contextSize);
    const replyLength = numeric(values.replyLength);
    if (contextSize > 0 && replyLength > 0 && replyLength >= contextSize) {
        push('', 'preset-reply-length', 'error', `Reply length (${replyLength}) leaves no room in the context size (${contextSize}).`);
    }
    if (contextSize > 0 && modelContext > 0 && contextSize > modelContext) {
        push('', 'preset-context-over-model', 'warning', `Context size (${contextSize}) is above the ${modelContext} tokens the selected model reports.`);
    }
    const temperature = numeric(sampler(values, 'temperature'));
    if (temperature !== null && (temperature <= 0.05 || temperature >= 1.95)) {
        push('', 'preset-temperature-extreme', 'warning', `Temperature is at an extreme (${temperature}). Replies may become flat or erratic.`);
    }
    if (preset?.kind === 'chat' && connection.source !== 'claude' && values.continuePrefill && String(values.assistantPrefill ?? '').trim()) {
        push('', 'preset-prefill-unsupported', 'warning', `The ${connection.sourceLabel || connection.source || 'selected'} connection does not support assistant prefill.`);
    }
    if (preset?.kind === 'text' && values.instructEnabled && !String(values.instructPreset ?? '').trim()) {
        push('instruct', 'preset-instruct-template', 'warning', 'Instruct mode is on but no instruct template is selected.');
    }

    return { kind: 'preset', findings, name };
}
