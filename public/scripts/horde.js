import {
    amount_gen,
    getRequestHeaders,
    main_api,
    max_context,
    resultCheckStatus,
    saveSettingsDebounced,
    setGenerationProgress,
    setOnlineStatus,
} from '../script.js';
import { SECRET_KEYS, writeSecret } from './secrets.js';
import { delay } from './utils.js';
import { createSelectPicker } from './select-picker.js';
import { autoSelectInstructPreset } from './instruct-mode.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { kai_settings } from './kai-settings.js';
import { fetchResumable } from './resumable-generation.js';

export {
    MIN_LENGTH,
};

let models = [];

export let horde_settings = {
    models: [],
    auto_adjust_response_length: true,
    auto_adjust_context_length: false,
    trusted_workers_only: false,
};

const MAX_RETRIES = 480;
const CHECK_INTERVAL = 2500;
const MIN_LENGTH = 16;

/**
 * Gets the available workers from Horde.
 * @param {boolean} force Do a force refresh of the workers
 * @returns {Promise<Array>} Array of workers
 */
async function getWorkers(force) {
    const response = await fetch('/api/horde/text-workers', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ force }),
    });
    return await response.json();
}

/**
 * Gets the available models from Horde.
 * @param {boolean} force Do a force refresh of the models
 * @returns {Promise<Array>} Array of models
 */
async function getModels(force) {
    const response = await fetch('/api/horde/text-models', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ force }),
    });
    const data = await response.json();
    console.log('getModels', data);
    return data;
}


/**
 * Gets the status of a Horde task.
 * @param {string} taskId Task ID
 * @returns {Promise<Object>} Task status
 */
async function getTaskStatus(taskId) {
    const response = await fetch('/api/horde/task-status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ taskId }),
    });

    if (!response.ok) {
        throw new Error(`Failed to get task status: ${response.statusText}`);
    }

    return await response.json();
}

/**
 * Cancels a Horde task.
 * @param {string} taskId Task ID
 */
async function cancelTask(taskId) {
    const response = await fetch('/api/horde/cancel-task', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ taskId }),
    });

    if (!response.ok) {
        throw new Error(`Failed to cancel task: ${response.statusText}`);
    }
}

/**
 * Checks if Horde is online.
 * @returns {Promise<boolean>} True if Horde is online, false otherwise
 */
export async function checkHordeStatus() {
    try {
        const response = await fetch('/api/horde/status', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            return false;
        }

        const data = await response.json();
        return data.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

export async function getStatusHorde() {
    try {
        const hordeStatus = await checkHordeStatus();
        setOnlineStatus(hordeStatus ? t`Connected` : 'no_connection');
    } catch {
        setOnlineStatus('no_connection');
    }

    return resultCheckStatus();
}

function validateHordeModel() {
    let selectedModels = models.filter(m => horde_settings.models.includes(m.name));

    if (selectedModels.length === 0) {
        toastr.warning('No Horde model selected or the selected models are no longer available. Please choose another model');
        throw new Error('No Horde model available');
    }

    return selectedModels;
}

export async function adjustHordeGenerationParams(max_context_length, max_length) {
    console.log(max_context_length, max_length);
    const workers = await getWorkers(false);
    let maxContextLength = max_context_length;
    let maxLength = max_length;
    let availableWorkers = [];
    let selectedModels = validateHordeModel();

    if (selectedModels.length === 0) {
        return { maxContextLength, maxLength };
    }

    for (const model of selectedModels) {
        for (const worker of workers) {
            if (model.cluster === worker.cluster && worker.models.includes(model.name)) {
                // Skip workers that are not trusted if the option is enabled
                if (horde_settings.trusted_workers_only && !worker.trusted) {
                    continue;
                }

                availableWorkers.push(worker);
            }
        }
    }

    //get the minimum requires parameters, lowest common value for all selected
    for (const worker of availableWorkers) {
        if (horde_settings.auto_adjust_context_length) {
            maxContextLength = Math.min(worker.max_context_length, maxContextLength);
        }
        if (horde_settings.auto_adjust_response_length) {
            maxLength = Math.min(worker.max_length, maxLength);
        }
    }
    console.log(maxContextLength, maxLength);
    $('#adjustedHordeParams').text(t`Context` + `: ${maxContextLength}, ` + t`Response` + `: ${maxLength}`);
    return { maxContextLength, maxLength };
}

function setContextSizePreview() {
    if (horde_settings.models.length) {
        adjustHordeGenerationParams(max_context, amount_gen);
    } else {
        $('#adjustedHordeParams').text(t`Context` + ': --, ' + t`Response` + ': --');
    }
}

/** Generates text using the Horde API.
 * @param {string} prompt
 * @param params
 * @param signal
 * @param reportProgress
 * @returns {Promise<{text: *, workerName: string}>}
 * @throws {Error}
 */
export async function generateHorde(prompt, params, signal, reportProgress) {
    validateHordeModel();
    delete params.prompt;

    // No idea what these do
    params.n = 1;
    params.frmtadsnsp = false;
    params.frmtrmblln = false;
    params.frmtrmspch = false;
    params.frmttriminc = false;

    const payload = {
        'prompt': prompt,
        'params': params,
        'trusted_workers': horde_settings.trusted_workers_only,
        //"slow_workers": false,
        'models': horde_settings.models,
    };

    const response = await fetchResumable('/api/horde/generate-text', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok) {
        toastr.error('Horde could not write a reply. Try again, or choose another model.', 'Could not generate reply');
        throw new Error(`Horde generation failed: ${response.statusText}`);
    }

    const responseJson = await response.json();

    if (responseJson.error) {
        const reason = responseJson.error?.message || 'Unknown error';
        toastr.error(reason, 'Could not generate reply');
        throw new Error(`Horde generation failed: ${reason}`);
    }

    const taskId = responseJson.id;
    return waitForHordeTask(taskId, signal, reportProgress);
}

/** Reattach to an existing Horde task without submitting or paying for another request. */
export async function waitForHordeTask(taskId, signal, reportProgress = false, cancelOnAbort = true) {
    let queue_position_first = null;
    console.log(`Horde task id = ${taskId}`);

    for (let retryNumber = 0; retryNumber < MAX_RETRIES; retryNumber++) {
        if (signal.aborted) {
            if (cancelOnAbort) cancelTask(taskId);
            throw new Error('Request aborted');
        }

        const statusCheckJson = await getTaskStatus(taskId);
        console.log(statusCheckJson);

        if (statusCheckJson.faulted === true) {
            toastr.error('Horde could not finish the request. Try again.');
            throw new Error('Horde generation failed: Faulted');
        }

        if (statusCheckJson.is_possible === false) {
            toastr.error('No Horde volunteer computers (workers) can handle this request right now. Change the settings or try again later.');
            throw new Error('Horde generation failed: Unsatisfiable request');
        }

        if (statusCheckJson.done && Array.isArray(statusCheckJson.generations) && statusCheckJson.generations.length) {
            reportProgress && setGenerationProgress(100);
            const generatedText = statusCheckJson.generations[0].text;
            const WorkerName = statusCheckJson.generations[0].worker_name;
            const WorkerModel = statusCheckJson.generations[0].model;
            console.log(generatedText);
            console.log(`Generated by Horde Worker: ${WorkerName} [${WorkerModel}]`);
            return { text: generatedText, workerName: `Generated by Horde worker: ${WorkerName} [${WorkerModel}]` };
        } else if (!queue_position_first) {
            queue_position_first = statusCheckJson.queue_position;
            reportProgress && setGenerationProgress(0);
        } else if (statusCheckJson.queue_position >= 0) {
            let queue_position = statusCheckJson.queue_position;
            const progress = Math.round(100 - (queue_position / queue_position_first * 100));
            reportProgress && setGenerationProgress(progress);
        }

        await delay(CHECK_INTERVAL);
    }

    await callGenericPopup(t`Horde request timed out. Try again`, POPUP_TYPE.TEXT);
    throw new Error('Horde timeout');
}


/**
 * Displays the available models in the Horde model selection dropdown.
 * @param {boolean} force Force refresh of the models
 */
export async function getHordeModels(force) {
    const sortByPerformance = (a, b) => b.performance - a.performance;
    const sortByWhitelisted = (a, b) => b.is_whitelisted - a.is_whitelisted;
    const sortByPopular = (a, b) => b.tags?.includes('popular') - a.tags?.includes('popular');

    $('#horde_model').empty();
    models = (await getModels(force)).sort((a, b) => {
        return sortByWhitelisted(a, b) || sortByPopular(a, b) || sortByPerformance(a, b);
    });
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model.name;
        option.innerText = hordeModelTextString(model);
        option.selected = horde_settings.models.includes(model.name);
        $('#horde_model').append(option);
    }

    // if previously selected is no longer available
    if (horde_settings.models.length && models.filter(m => horde_settings.models.includes(m.name)).length === 0) {
        horde_settings.models = [];
    }

    setContextSizePreview();
}

export function loadHordeSettings(settings) {
    if (settings.horde_settings) {
        Object.assign(horde_settings, settings.horde_settings);
    }

    $('#horde_auto_adjust_response_length').prop('checked', horde_settings.auto_adjust_response_length);
    $('#horde_auto_adjust_context_length').prop('checked', horde_settings.auto_adjust_context_length);
    $('#horde_trusted_workers_only').prop('checked', horde_settings.trusted_workers_only);
}

async function showKudos() {
    const response = await fetch('/api/horde/user-info', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        toastr.warning('Could not load user info from Horde. Please try again later.');
        return;
    }

    const data = await response.json();

    if (data.anonymous) {
        toastr.info('You are using Horde without an account. Add your personal Horde API key (a code from your Horde account) to see your kudos (Horde points).');
        return;
    }

    console.log('Horde user data', data.user, 'shared key data', data.sharedKey);
    const kudos = data.sharedKey?.kudos ?? data.user?.kudos ?? 0;
    toastr.info(`Kudos: ${kudos}`, data.user.username);
}

function hordeModelTextString(model) {
    const q = hordeModelQueueStateString(model);
    return `${model.name} (${q})`;
}

function hordeModelQueueStateString(model) {
    return `ETA: ${model.eta}s, Speed: ${model.performance}, Queue: ${model.queued}, Workers: ${model.count}`;
}

export function isHordeGenerationNotAllowed() {
    if (main_api == 'koboldhorde' && kai_settings.preset_settings == 'gui') {
        toastr.error(t`GUI Settings preset is not supported for Horde. Please select another preset.`);
        return true;
    }

    return false;
}

// The models repo sends HTML in its metadata; the picker shows it as plain text.
function stripHordeModelHtml(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent?.trim() || '';
}

function getHordeModelPickerTitle(option) {
    const model = models.find(x => x.name === option.value);
    if (!model) return option.label;
    const displayName = stripHordeModelHtml(model.display_name || model.name).replace(/.*\//g, '') || model.name;
    return model.tags?.includes('popular') ? `★ ${displayName}` : displayName;
}

function getHordeModelPickerDetails(option) {
    const model = models.find(x => x.name === option.value);
    if (!model) return '';
    const style = stripHordeModelHtml(model.style);
    const tags = (model.tags || []).map(stripHordeModelHtml).filter(Boolean);
    return [
        [style && style[0].toUpperCase() + style.slice(1), ...tags].filter(Boolean).join(', '),
        stripHordeModelHtml(model.description),
        hordeModelQueueStateString(model),
    ].filter(Boolean).join(' · ');
}

export function initHorde() {
    $('#horde_model').on('mousedown change', async function (e) {
        console.log('Horde model change', e);
        const modelValue = $('#horde_model').val();
        horde_settings.models = Array.isArray(modelValue) ? modelValue : [];
        console.log('Updated Horde models', horde_settings.models);

        // Try select instruct preset
        autoSelectInstructPreset(horde_settings.models.join(' '));
        if (horde_settings.models.length) {
            adjustHordeGenerationParams(max_context, amount_gen);
        } else {
            $('#adjustedHordeParams').text(t`Context` + ': --, ' + t`Response` + ': --');
        }

        saveSettingsDebounced();
    });

    $('#horde_auto_adjust_response_length').on('input', function () {
        horde_settings.auto_adjust_response_length = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced();
    });

    $('#horde_auto_adjust_context_length').on('input', function () {
        horde_settings.auto_adjust_context_length = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced();
    });

    $('#horde_trusted_workers_only').on('input', function () {
        horde_settings.trusted_workers_only = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced();
    });

    $('#horde_api_key_button').on('click', async function () {
        const key = String($('#horde_api_key').val()).trim();
        if (!key) {
            toastr.warning(t`Please enter your Horde API key`);
            return;
        }
        await writeSecret(SECRET_KEYS.HORDE, key);
    });

    $('#horde_refresh').on('click', () => getHordeModels(true));
    $('#horde_kudos').on('click', showKudos);

    const modelSelect = document.getElementById('horde_model');
    if (modelSelect instanceof HTMLSelectElement) {
        createSelectPicker(modelSelect, {
            labels: () => ({ title: t`Models`, subtitle: t`AI Horde`, search: t`Search models`, placeholder: t`Select Horde models` }),
            rowLabel: getHordeModelPickerTitle,
            describe: getHordeModelPickerDetails,
            selectionLabel: option => option.value,
        });
    }
}
