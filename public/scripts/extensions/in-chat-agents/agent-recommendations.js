// Taro's agent guide: local, deterministic recommendations. This module never
// loads a model, reads a chat or writes an agent. The Agents page owns those.

export const TARO_GUIDE_ANSWERS_VERSION = 1;
export const TARO_GUIDE_MAX_NEW_PICKS = 6;

export const TARO_GUIDE_BUDGETS = Object.freeze({
    free: Object.freeze({
        label: 'No extra requests',
        help: 'Only agents that add text to the request already being sent, or wait for a manual Run.',
        extraRequestLimit: 0,
    }),
    light: Object.freeze({
        label: 'Up to two extra-request agents',
        help: 'Up to two agents that make an extra request, counting any extra-request agents already switched on. The provider decides how each request is handled.',
        extraRequestLimit: 2,
    }),
    any: Object.freeze({
        label: 'No limit',
        help: 'Every agent that matches your answers, up to the six new ones this page adds at once.',
        extraRequestLimit: Number.POSITIVE_INFINITY,
    }),
});

export const TARO_GUIDE_QUESTIONS = Object.freeze([
    Object.freeze({
        id: 'style',
        title: 'What are you playing?',
        help: 'Pick anything that fits. Roleplay needs no extra agent on its own; the fixes and extras do the work.',
        type: 'checkbox',
        options: Object.freeze([
            Object.freeze({ value: 'roleplay', label: 'Roleplay', hint: 'A character chat with one main partner.' }),
            Object.freeze({ value: 'adventure', label: 'Adventure', hint: 'Places to go, checks to make, things to carry.' }),
            Object.freeze({ value: 'romance', label: 'Romance', hint: 'Relationships and how they change.' }),
            Object.freeze({ value: 'bigcast', label: 'Big cast', hint: 'Several characters, sometimes in different places.' }),
        ]),
        explicitOption: Object.freeze({
            label: 'Explicit scenes are welcome',
            hint: 'Only adds an agent when your budget allows extra requests.',
        }),
    }),
    Object.freeze({
        id: 'fixes',
        title: 'What should the reply do better?',
        help: 'Choose the problems you actually notice. Taro will not switch on anything you do not pick.',
        type: 'checkbox',
        options: Object.freeze([
            Object.freeze({ value: 'agency', label: 'Leave my character to me', hint: 'Stop the reply writing your words, thoughts or choices.' }),
            Object.freeze({ value: 'repeat', label: 'Stop repeating itself', hint: 'Fewer recycled openers, phrases and gestures.' }),
            Object.freeze({ value: 'length', label: 'Keep replies to a length', hint: 'Pace a scene or trim an overlong reply.' }),
            Object.freeze({ value: 'continuity', label: 'Keep facts straight', hint: 'Who is there, what they hold and what already happened.' }),
            Object.freeze({ value: 'voice', label: 'Keep characters in character', hint: 'Less drift in how a character speaks and acts.' }),
            Object.freeze({ value: 'pushback', label: 'Let characters push back', hint: 'No instant yeses or sudden warmth without a reason.' }),
            Object.freeze({ value: 'prose', label: 'Clean up the prose', hint: 'Tidy wording and dialogue that sounds human.' }),
            Object.freeze({ value: 'format', label: 'Fix formatting', hint: 'Repair broken markup and uneven presentation.' }),
            Object.freeze({ value: 'rules', label: 'Follow my instructions', hint: 'Bring the reply back to the prompt it was given.' }),
            Object.freeze({ value: 'knowledge', label: 'Stick to what it knows', hint: 'Keep the character inside their own knowledge.' }),
            Object.freeze({ value: 'intent', label: 'Read what I am asking', hint: 'Catch the actual request, including out-of-character notes.' }),
        ]),
    }),
    Object.freeze({
        id: 'extras',
        title: 'Anything to keep track of?',
        help: 'These add running notes or menus beside the reply. Leave them off if you only want the reply improved.',
        type: 'checkbox',
        options: Object.freeze([
            Object.freeze({ value: 'map', label: 'Where everyone is', hint: 'A live position map with characters and places.' }),
            Object.freeze({ value: 'vitals', label: 'Health and condition', hint: 'Injuries, energy and how a character is holding up.' }),
            Object.freeze({ value: 'choices', label: 'Choices at the end', hint: 'Numbered actions, or a choice menu with checks.' }),
            Object.freeze({ value: 'scene', label: 'The scene and time', hint: 'Where you are, what the light is doing and how much time has passed.' }),
            Object.freeze({ value: 'bonds', label: 'Relationships', hint: 'How each pair feels about each other and why.' }),
            Object.freeze({ value: 'quests', label: 'Quests and things carried', hint: 'Open jobs, promises and the items needed for them.' }),
            Object.freeze({ value: 'offscreen', label: 'What happens off screen', hint: 'What absent characters and the wider world are doing.' }),
        ]),
    }),
    Object.freeze({
        id: 'budget',
        title: 'How many extra requests?',
        help: 'An extra-request agent asks for a separate request before or after the reply. Prompt-only agents add text to the request already being sent.',
        type: 'radio',
        options: Object.freeze([
            Object.freeze({ value: 'free', label: 'No extra requests', hint: TARO_GUIDE_BUDGETS.free.help }),
            Object.freeze({ value: 'light', label: 'Up to two extra-request agents', hint: TARO_GUIDE_BUDGETS.light.help }),
            Object.freeze({ value: 'any', label: 'No limit', hint: TARO_GUIDE_BUDGETS.any.help }),
        ]),
    }),
]);

const STYLE_VALUES = new Set(TARO_GUIDE_QUESTIONS[0].options.map(option => option.value));
const FIX_VALUES = new Set(TARO_GUIDE_QUESTIONS[1].options.map(option => option.value));
const EXTRA_VALUES = new Set(TARO_GUIDE_QUESTIONS[2].options.map(option => option.value));
const BUDGET_VALUES = new Set(Object.keys(TARO_GUIDE_BUDGETS));

const REQUEST_COST_LABELS = Object.freeze({
    free: 'Adds prompt text; no extra request',
    manual: 'Runs only when you press Run; no automatic request',
    before: 'One extra request before the reply',
    after: 'One extra request after the reply',
});

/**
 * Known conflict groups. Descriptions that say "Don't run it with" or
 * "Pick this or ... one at a time" are added on top of these at call time.
 * A star group pairs the hub with each member, not the members with each other.
 */
export const AGENT_TEMPLATE_CONFLICT_GROUPS = Object.freeze([
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-doors', 'tpl-doors-fate-checks']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-position-tracker-companion', 'tpl-visual-map-companion']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-parallel-tracker', 'tpl-parallel-tracker-extended']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-user-agency-guard', 'tpl-dont-write-for-user']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-friction-keeper', 'tpl-friction-mode']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-repeat-spotter', 'tpl-repetition-breaker']) }),
    Object.freeze({ kind: 'pair', ids: Object.freeze(['tpl-intent-reader', 'tpl-beat-planner']) }),
    Object.freeze({ kind: 'star', hub: 'tpl-continuity-pins', ids: Object.freeze([
        'tpl-continuity-companion',
        'tpl-scene-tracker',
        'tpl-status-tracker',
        'tpl-item-tracker',
    ]) }),
    Object.freeze({ kind: 'star', hub: 'tpl-beat-planner', ids: Object.freeze([
        'tpl-plot-compass-companion',
        'tpl-scene-driving-force',
        'tpl-scene-pressure',
        'tpl-combined-directors-cut',
        'tpl-chaos-mode',
    ]) }),
    Object.freeze({ kind: 'star', hub: 'tpl-pace-setter', ids: Object.freeze([
        'tpl-length-trimmer',
        'tpl-scene-pressure',
        'tpl-combined-directors-cut',
    ]) }),
    Object.freeze({ kind: 'clique', ids: Object.freeze([
        'tpl-cyoa-choices',
        'tpl-cyoa-choices-skill-checks',
        'tpl-direction-menu',
        'tpl-doors',
        'tpl-doors-fate-checks',
        'tpl-four-winds',
    ]) }),
]);

const RULES = Object.freeze([
    {
        id: 'agency',
        source: 'fixes',
        option: 'agency',
        priority: 3,
        reason: 'You asked the reply to leave your character\'s choices to you.',
        select: ({ answers }) => answers.budget === 'free'
            ? ['tpl-dont-write-for-user']
            : ['tpl-user-agency-guard'],
    },
    {
        id: 'repeat',
        source: 'fixes',
        option: 'repeat',
        priority: 3,
        reason: 'You asked for less repetition.',
        select: ({ answers }) => answers.budget === 'any' ? ['tpl-repetition-breaker'] : ['tpl-repeat-spotter'],
    },
    {
        id: 'length',
        source: 'fixes',
        option: 'length',
        priority: 3,
        reason: 'You asked for a reply length you can control.',
        select: ({ answers }) => answers.budget === 'any' ? ['tpl-length-trimmer'] : ['tpl-pace-setter'],
    },
    {
        id: 'continuity',
        source: 'fixes',
        option: 'continuity',
        priority: 3,
        reason: 'You asked for facts to stay straight.',
        select: ({ answers, hasEnabled, selectedExtras }) => {
            if (answers.budget === 'free') return ['tpl-scene-tracker', 'tpl-status-tracker'];
            if (answers.budget === 'light' && hasTrackerCoverage(hasEnabled, selectedExtras)) {
                return ['tpl-scene-tracker', 'tpl-status-tracker'];
            }
            return answers.budget === 'light' ? ['tpl-continuity-pins'] : ['tpl-continuity-corrector'];
        },
    },
    {
        id: 'voice',
        source: 'fixes',
        option: 'voice',
        priority: 3,
        reason: 'You asked characters to stay in voice.',
        select: () => ['tpl-character-authenticity'],
    },
    {
        id: 'pushback',
        source: 'fixes',
        option: 'pushback',
        priority: 3,
        reason: 'You asked characters to push back.',
        select: ({ answers }) => answers.budget === 'free'
            ? ['tpl-friction-mode']
            : ['tpl-friction-keeper'],
    },
    {
        id: 'prose',
        source: 'fixes',
        option: 'prose',
        priority: 3,
        reason: 'You asked for cleaner prose.',
        select: () => ['tpl-proofreader'],
    },
    {
        id: 'prose-dialogue',
        source: 'fixes',
        option: 'prose',
        priority: 3,
        reason: 'You asked for dialogue that sounds human.',
        select: ({ answers }) => answers.budget === 'any' ? ['tpl-dialogue-humaniser'] : [],
    },
    {
        id: 'format',
        source: 'fixes',
        option: 'format',
        priority: 3,
        reason: 'You asked for tidier formatting.',
        select: () => ['tpl-format-fixer'],
    },
    {
        id: 'rules',
        source: 'fixes',
        option: 'rules',
        priority: 3,
        reason: 'You asked replies to follow your instructions.',
        select: () => ['tpl-prompt-adherence-checker'],
    },
    {
        id: 'knowledge',
        source: 'fixes',
        option: 'knowledge',
        priority: 3,
        reason: 'You asked the reply to stick to what the character knows.',
        select: () => ['tpl-knowledge-guard'],
    },
    {
        id: 'intent',
        source: 'fixes',
        option: 'intent',
        priority: 3,
        reason: 'You asked the reply to understand what you meant.',
        select: () => ['tpl-intent-reader'],
    },
    {
        id: 'explicit',
        source: 'explicit',
        option: 'explicit',
        priority: 3,
        reason: 'You said explicit scenes are welcome.',
        select: () => ['tpl-nsfw-enhancer'],
    },
    {
        id: 'adventure',
        source: 'style',
        option: 'adventure',
        priority: 1,
        reason: 'You picked Adventure, so choices need places, things and consequences.',
        select: () => ['tpl-cyoa-choices-skill-checks', 'tpl-item-tracker', 'tpl-event-tracker'],
    },
    {
        id: 'romance',
        source: 'style',
        option: 'romance',
        priority: 1,
        reason: 'You picked Romance, so relationship changes need a record.',
        select: () => ['tpl-relationship-tracker'],
    },
    {
        id: 'bigcast',
        source: 'style',
        option: 'bigcast',
        priority: 1,
        reason: 'You have a big cast, so other characters need their own cards and off-screen time.',
        select: () => ['tpl-npc-profiles', 'tpl-parallel-tracker'],
    },
    {
        id: 'map',
        source: 'extras',
        option: 'map',
        priority: 2,
        reason: 'You asked for a map of who is where.',
        select: () => ['tpl-position-tracker-companion'],
    },
    {
        id: 'vitals',
        source: 'extras',
        option: 'vitals',
        priority: 2,
        reason: 'You asked to keep track of health and condition.',
        select: ({ answers }) => answers.budget === 'free'
            ? ['tpl-status-tracker']
            : ['tpl-vitals-companion'],
    },
    {
        id: 'choices',
        source: 'extras',
        option: 'choices',
        priority: 2,
        reason: 'You asked for choices at the end of replies.',
        select: ({ answers }) => answers.budget === 'free' || answers.styles.includes('adventure')
            ? ['tpl-cyoa-choices-skill-checks']
            : ['tpl-direction-menu'],
    },
    {
        id: 'scene',
        source: 'extras',
        option: 'scene',
        priority: 2,
        reason: 'You asked to keep track of the scene and time.',
        select: () => ['tpl-scene-tracker', 'tpl-time-tracker'],
    },
    {
        id: 'bonds',
        source: 'extras',
        option: 'bonds',
        priority: 2,
        reason: 'You asked to track relationships.',
        select: () => ['tpl-relationship-tracker'],
    },
    {
        id: 'quests',
        source: 'extras',
        option: 'quests',
        priority: 2,
        reason: 'You asked to track quests and the things needed for them.',
        select: () => ['tpl-event-tracker', 'tpl-item-tracker'],
    },
    {
        id: 'offscreen',
        source: 'extras',
        option: 'offscreen',
        priority: 2,
        reason: 'You asked to see what happens off screen.',
        select: () => ['tpl-parallel-tracker'],
    },
]);

function normalizeName(value) {
    return String(value ?? '').trim().toLocaleLowerCase('en');
}

function uniqueAllowedValues(value, allowed) {
    if (!Array.isArray(value)) return [];
    const selected = new Set();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = item.trim().toLocaleLowerCase('en');
        if (allowed.has(normalized)) selected.add(normalized);
    }
    return [...selected];
}

export function createDefaultTaroGuideAnswers() {
    return {
        version: TARO_GUIDE_ANSWERS_VERSION,
        styles: [],
        fixes: [],
        extras: [],
        explicit: false,
        budget: 'light',
    };
}

/** Accepts anything from account storage and returns a safe, complete answers object. */
export function normalizeTaroGuideAnswers(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaults = createDefaultTaroGuideAnswers();
    const budget = typeof source.budget === 'string' && BUDGET_VALUES.has(source.budget.trim().toLocaleLowerCase('en'))
        ? source.budget.trim().toLocaleLowerCase('en')
        : defaults.budget;
    return {
        version: TARO_GUIDE_ANSWERS_VERSION,
        styles: uniqueAllowedValues(source.styles, STYLE_VALUES),
        fixes: uniqueAllowedValues(source.fixes, FIX_VALUES),
        extras: uniqueAllowedValues(source.extras, EXTRA_VALUES),
        explicit: source.explicit === true,
        budget,
    };
}

/**
 * What an agent does on an ordinary reply: add prompt text, make an automatic
 * extra request, or wait for a manual Run.
 * @param {object} record An installed agent or a bundled template.
 * @returns {'free'|'manual'|'before'|'after'}
 */
export function getAgentRequestCost(record) {
    const preProcess = record?.preProcess && typeof record.preProcess === 'object' ? record.preProcess : {};
    const postProcess = record?.postProcess && typeof record.postProcess === 'object' ? record.postProcess : {};
    if (preProcess.mode === 'intercept' && preProcess.interceptTiming !== 'post-main-generation') {
        return 'before';
    }
    if (record?.execution === 'companion') {
        return record?.companion?.trigger === 'manual' ? 'manual' : 'after';
    }
    if (postProcess.promptTransformEnabled === true) return 'after';
    if (preProcess.mode === 'intercept') return 'after';
    return 'free';
}

/** Whether a cost uses one of the automatic extra-request slots. */
export function isAutomaticRequestCost(cost) {
    return cost === 'before' || cost === 'after';
}

export function getAgentRequestCostLabel(cost) {
    return REQUEST_COST_LABELS[cost] ?? REQUEST_COST_LABELS.free;
}

function agentOrder(agent) {
    const order = Number(agent?.injection?.order);
    return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

export function chooseInstalledCopy(copies, isEnabled) {
    if (!copies.length) return null;
    return [...copies].sort((left, right) => {
        const enabledDifference = Number(Boolean(isEnabled(right))) - Number(Boolean(isEnabled(left)));
        if (enabledDifference) return enabledDifference;
        const orderDifference = agentOrder(left) - agentOrder(right);
        if (orderDifference) return orderDifference;
        return String(left.id ?? '').localeCompare(String(right.id ?? ''));
    })[0];
}

export function copiesForTemplate(agents, template) {
    const sourceCopies = agents.filter(agent => String(agent?.sourceTemplateId ?? '').trim() === String(template?.id));
    if (sourceCopies.length) return sourceCopies;
    return agents.filter(agent => !String(agent?.sourceTemplateId ?? '').trim()
        && normalizeName(agent?.name) === normalizeName(template?.name));
}

/**
 * Recalculates visible picks without silently re-checking a pick the user cleared.
 * New picks start checked; a known pick keeps its previous checked state.
 */
export function mergePickSelection({ previousSelection = [], previousKnown = [], picks = [], resetSelection = false } = {}) {
    const selected = new Set(previousSelection);
    const known = new Set(previousKnown);
    const next = new Set();
    for (const pick of picks) {
        const templateId = typeof pick === 'string' ? pick : pick?.templateId;
        if (!templateId) continue;
        if (resetSelection || !known.has(templateId) || selected.has(templateId)) next.add(templateId);
    }
    return next;
}

/** The first reason an undo can no longer safely touch the switches it made. */
export function getTaroUndoBlockReason({ workspaceCurrent = true, scope, expectedScope, guardCurrent = true } = {}) {
    if (!workspaceCurrent) {
        return 'The chat changed. Open Taro\'s guide in the chat you set up before undoing these switches.';
    }
    if (scope !== expectedScope) {
        return 'The chat type changed. Open Taro\'s guide in the same chat type before undoing these switches.';
    }
    if (!guardCurrent) {
        return 'One of these agents changed elsewhere. Check the agent list before undoing.';
    }
    return '';
}

/** Whether retrying an undo cannot help because its scope or records moved. */
export function isTerminalTaroUndoError(message) {
    return /chat changed|chat type changed|changed elsewhere|agent changed|removed|not current|account changed/i.test(String(message ?? ''));
}

function hasTrackerCoverage(hasEnabled, selectedExtras) {
    return selectedExtras.has('scene')
        || selectedExtras.has('vitals')
        || selectedExtras.has('quests')
        || hasEnabled('tpl-scene-tracker')
        || hasEnabled('tpl-status-tracker')
        || hasEnabled('tpl-item-tracker');
}

function addConflict(map, left, right) {
    if (!left || !right || left === right) return;
    if (!map.has(left)) map.set(left, new Set());
    map.get(left).add(right);
}

function buildConflictIndex(templates) {
    const conflicts = new Map();
    const byName = new Map();
    for (const template of templates) {
        if (template?.id) byName.set(normalizeName(template.name), template.id);
    }

    for (const group of AGENT_TEMPLATE_CONFLICT_GROUPS) {
        if (group.kind === 'pair') {
            addConflict(conflicts, group.ids[0], group.ids[1]);
            addConflict(conflicts, group.ids[1], group.ids[0]);
        } else if (group.kind === 'star') {
            for (const id of group.ids) {
                addConflict(conflicts, group.hub, id);
                addConflict(conflicts, id, group.hub);
            }
        } else if (group.kind === 'clique') {
            for (const left of group.ids) {
                for (const right of group.ids) addConflict(conflicts, left, right);
            }
        }
    }

    for (const template of templates) {
        const description = String(template?.description ?? '');
        if (!template?.id) continue;
        const dontRunWith = description.match(/Don't run it with:\s*([^.\n]+)/i);
        if (dontRunWith) {
            for (const name of dontRunWith[1].split(/,|\band\b/i)) {
                const other = byName.get(normalizeName(name));
                if (other) {
                    addConflict(conflicts, template.id, other);
                    addConflict(conflicts, other, template.id);
                }
            }
        }
        const pickInstead = description.match(/Pick this or\s+([^,.\n]+)/i);
        if (pickInstead) {
            const other = byName.get(normalizeName(pickInstead[1]));
            if (other) {
                addConflict(conflicts, template.id, other);
                addConflict(conflicts, other, template.id);
            }
        }
    }

    return conflicts;
}

function addReasons(candidate, reasons) {
    for (const reason of reasons) {
        if (reason && !candidate.reasons.includes(reason)) candidate.reasons.push(reason);
    }
}

/**
 * @typedef {object} TaroGuidePick
 * @property {string} templateId
 * @property {string} name
 * @property {string|null} agentId
 * @property {boolean} needsCreate
 * @property {'free'|'before'|'after'} cost
 * @property {string} costLabel
 * @property {string[]} reasons
 */

/**
 * Recommends bundled agents for Taro's guide. Local and deterministic.
 * @param {ReturnType<typeof normalizeTaroGuideAnswers>} answers
 * @param {{agents?: object[], templates?: object[], isEnabled?: (agent: object) => boolean}} [context]
 */
export function recommendAgents(answers, context = {}) {
    const normalized = normalizeTaroGuideAnswers(answers);
    const agents = Array.isArray(context.agents) ? context.agents : [];
    const templates = Array.isArray(context.templates) ? context.templates.filter(template => template?.id) : [];
    const isEnabled = typeof context.isEnabled === 'function'
        ? agent => Boolean(context.isEnabled(agent))
        : agent => Boolean(agent?.enabled);

    const templateById = new Map(templates.map(template => [String(template.id), template]));
    const conflictIndex = buildConflictIndex(templates);
    const selectedStyles = new Set(normalized.styles);
    const selectedFixes = new Set(normalized.fixes);
    const selectedExtras = new Set(normalized.extras);

    const enabledTemplateIds = new Set();
    for (const agent of agents) {
        if (!isEnabled(agent)) continue;
        const sourceId = String(agent?.sourceTemplateId ?? '').trim();
        if (sourceId) {
            enabledTemplateIds.add(sourceId);
            continue;
        }
        const nameMatch = templates.find(template => normalizeName(template.name) === normalizeName(agent?.name));
        if (nameMatch) enabledTemplateIds.add(String(nameMatch.id));
    }

    const isTemplateEnabled = templateId => enabledTemplateIds.has(templateId);
    const ruleContext = {
        answers: normalized,
        hasEnabled: isTemplateEnabled,
        selectedStyles,
        selectedFixes,
        selectedExtras,
    };

    const candidates = new Map();
    const skipped = [];
    const notes = [];

    for (const rule of RULES) {
        const isSourced = (rule.source === 'style' && selectedStyles.has(rule.option))
            || (rule.source === 'fixes' && selectedFixes.has(rule.option))
            || (rule.source === 'extras' && selectedExtras.has(rule.option))
            || (rule.source === 'explicit' && normalized.explicit);
        if (!isSourced) continue;

        const templateIds = rule.select(ruleContext);
        const ruleOrder = RULES.indexOf(rule);

        for (const templateId of templateIds) {
            const template = templateById.get(templateId);
            if (!template) {
                skipped.push({
                    templateId,
                    name: templateId,
                    reason: 'This agent is not in the bundled library on this server. Update Neconyan and try again.',
                });
                continue;
            }

            const existing = candidates.get(templateId);
            if (existing) {
                addReasons(existing, [rule.reason]);
                existing.priority = Math.max(existing.priority, rule.priority);
                existing.order = Math.min(existing.order, ruleOrder);
                continue;
            }
            candidates.set(templateId, {
                templateId,
                template,
                priority: rule.priority,
                order: ruleOrder,
                reasons: [rule.reason],
            });
        }
    }

    for (const candidate of candidates.values()) {
        candidate.copies = copiesForTemplate(agents, candidate.template);
        candidate.installed = chooseInstalledCopy(candidate.copies, isEnabled);
        candidate.cost = getAgentRequestCost(candidate.installed ?? candidate.template);
    }

    const activeExtraCount = agents.filter(agent => isEnabled(agent) && isAutomaticRequestCost(getAgentRequestCost(agent))).length;
    const extraRequestLimit = TARO_GUIDE_BUDGETS[normalized.budget].extraRequestLimit;
    const remainingExtraRequests = Math.max(0, extraRequestLimit - activeExtraCount);

    if (normalized.budget === 'free' && activeExtraCount > 0) {
        notes.push(`You already have ${activeExtraCount} extra-request agent${activeExtraCount === 1 ? '' : 's'} switched on. This pass adds none and does not switch them off.`);
    } else if (normalized.budget === 'light' && activeExtraCount >= extraRequestLimit) {
        notes.push(`You already have ${activeExtraCount} extra-request agent${activeExtraCount === 1 ? '' : 's'} switched on, so the two this budget describes are in use. Taro does not switch any of them off.`);
    }
    if (selectedStyles.has('roleplay')) {
        notes.push('Roleplay needs no extra agent on its own. The rest of these answers decide what else is worth adding.');
    }

    const sortedCandidates = [...candidates.values()].sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority;
        const leftFree = isAutomaticRequestCost(left.cost) ? 1 : 0;
        const rightFree = isAutomaticRequestCost(right.cost) ? 1 : 0;
        if (leftFree !== rightFree) return leftFree - rightFree;
        if (left.order !== right.order) return left.order - right.order;
        return left.templateId.localeCompare(right.templateId);
    });

    const picks = [];
    const alreadyOn = [];
    const selectedTemplateIds = new Set();
    let newExtraRequests = 0;

    for (const candidate of sortedCandidates) {
        const template = candidate.template;
        const copies = candidate.copies;
        const installed = candidate.installed;
        const cost = candidate.cost;
        const costLabel = getAgentRequestCostLabel(cost);

        if (installed && isEnabled(installed)) {
            alreadyOn.push({
                templateId: template.id,
                name: template.name,
                agentId: installed.id,
                needsCreate: false,
                cost,
                costLabel,
                reasons: candidate.reasons,
            });
            selectedTemplateIds.add(template.id);
            continue;
        }

        if (enabledTemplateIds.has(template.id)) {
            const enabledCopy = copies.find(agent => isEnabled(agent));
            alreadyOn.push({
                templateId: template.id,
                name: template.name,
                agentId: enabledCopy?.id ?? null,
                needsCreate: false,
                cost,
                costLabel,
                reasons: candidate.reasons,
            });
            selectedTemplateIds.add(template.id);
            continue;
        }

        const enabledConflicts = conflictIndex.get(template.id);
        const enabledConflict = enabledConflicts
            ? [...enabledConflicts].find(id => enabledTemplateIds.has(id))
            : null;
        if (enabledConflict) {
            skipped.push({
                templateId: template.id,
                name: template.name,
                reason: `It conflicts with ${templateById.get(enabledConflict)?.name ?? enabledConflict}, which is already switched on.`,
            });
            continue;
        }

        const selectedConflict = enabledConflicts
            ? [...enabledConflicts].find(id => selectedTemplateIds.has(id))
            : null;
        if (selectedConflict) {
            skipped.push({
                templateId: template.id,
                name: template.name,
                reason: `It conflicts with ${templateById.get(selectedConflict)?.name ?? selectedConflict}, chosen by an earlier answer.`,
            });
            continue;
        }

        if (isAutomaticRequestCost(cost) && normalized.budget === 'free') {
            skipped.push({
                templateId: template.id,
                name: template.name,
                reason: 'It needs an extra request, and No extra requests is selected.',
            });
            continue;
        }
        if (isAutomaticRequestCost(cost) && normalized.budget === 'light' && newExtraRequests >= remainingExtraRequests) {
            skipped.push({
                templateId: template.id,
                name: template.name,
                reason: remainingExtraRequests === 0
                    ? 'Both extra-request slots are already in use, so this pass cannot add it.'
                    : 'The two extra-request slots for this pass are full.',
            });
            continue;
        }
        if (picks.length >= TARO_GUIDE_MAX_NEW_PICKS) {
            skipped.push({
                templateId: template.id,
                name: template.name,
                reason: `Only ${TARO_GUIDE_MAX_NEW_PICKS} new agents are added at once. Switch some off and run this again.`,
            });
            continue;
        }

        picks.push({
            templateId: template.id,
            name: template.name,
            agentId: installed?.id ?? null,
            needsCreate: !installed,
            cost,
            costLabel,
            reasons: candidate.reasons,
        });
        selectedTemplateIds.add(template.id);
        if (isAutomaticRequestCost(cost)) newExtraRequests += 1;
    }

    if (skipped.some(entry => entry.reason.includes('extra request') || entry.reason.includes('extra-request slots'))) {
        notes.push('Some answers need an agent that makes an extra request. They are listed below with what to change.');
    }

    const conflictNames = picks.length
        ? []
        : skipped
            .filter(entry => entry.reason.startsWith('It conflicts with'))
            .map(entry => entry.name)
            .slice(0, 3);
    if (conflictNames.length) {
        notes.push(`${conflictNames.join(', ')} could not be added because of switches already on. Taro did not switch anything off.`);
    }

    return {
        answers: normalized,
        picks,
        alreadyOn,
        skipped,
        notes,
        budget: {
            mode: normalized.budget,
            label: TARO_GUIDE_BUDGETS[normalized.budget].label,
            activeExtraCount,
            newExtraCount: newExtraRequests,
            extraRequestLimit,
            remainingExtraRequests,
        },
        counts: {
            newPicks: picks.length,
            alreadyOn: alreadyOn.length,
            skipped: skipped.length,
        },
        // Kept for callers that only need the answer to "can this be applied?".
        canApply: picks.length > 0,
    };
}
