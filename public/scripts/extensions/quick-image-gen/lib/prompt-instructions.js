const unique = values => [...new Set(values.filter(Boolean))];
const includesName = (text, name) => Boolean(String(name || '').trim()) && String(text || '').toLowerCase().includes(String(name).trim().toLowerCase());
const skinPattern = /\b(dark[- ]?skin(?:ned)?|brown[- ]?skin(?:ned)?|black[- ]?skin(?:ned)?|tan(?:ned)?[- ]?skin|ebony|melanin|mocha|chocolate[- ]?skin|caramel[- ]?skin)\b/gi;

export const QIG_ARTISTS = Object.freeze(['a1 (initial-g)', 'abubu', 'afrobull', 'aiue oka', 'akairiot', 'akamatsu ken',
    'alex ahad', 'alzi xiaomi', 'amazuyu tatsuki', 'aoi nagisa (metalder)', 'ask (askzy)', 'atdan', 'awa', 'ayami kojima',
    'azasuke', 'azto dio', 'bkub', 'blade (galaxist)', 'boris (noborhys)', 'bow (bhp)', 'butcha-u', 'chouzuki maryou',
    'ciloranko', 'circle anco', 'crote', 'dagasi', 'dairi', 'dino (dinoartforame)', 'dishwasher1910', 'drawfag', 'dsmile',
    'ebifurya', 'eroquis', 'fkey', 'fuzichoco', 'gomennasai', 'hammer (sunset beach)', 'hana kazari', 'hara (harayutaka)',
    'haruyama kazunori', 'hews', 'hiroki (yyqw7151)', 'hiten', 'hoshi (snacherubi)', 'inoino', 'itomugi-kun', 'ixy',
    'kagami hirotaka', 'kanon (kurogane knights)', 'kantoku', 'kawacy', 'ke-ta', 'kou hiyoyo', 'kouji (campus life)',
    'kuavera', 'kuon (kwonchan)', 'lack', 'lm7', 'lolita channel', 'm-da s-tarou', 'matsunaga kouyou', 'mika pikazo',
    'mikeinel', 'mizuki hitoshi', 'mizumizuni', 'morikura en', 'naga u', 'nardack', 'neco', 'nel-zel formula', 'neocoill',
    'nian', 'nixeu', 'nyamota', 'nyantcha', 'ojipon', 'onikobe rin', 'piromizu', 'pochi (pochi-goya)', 'qp:flapper',
    'rebecca (keinelove)', 'redjuice', 'rei (sanbonzakura)', 'rurudo', 'ruu (tksymkw)', 'shirataki', 'sincos', 'sky-freedom',
    'tofuubear', 'tony taka', 'tukiwani', 'wanke', 'yaegashi nan', 'yamakaze', 'yoko juusuke', 'yoshiaki', 'yuuki tatsuya']);

function replaceCustom(template, scene, profile) {
    const values = { scene, charDesc: profile.charDescResolved.slice(0, 1500), userDesc: profile.userDescResolved.slice(0, 800),
        char: profile.charNameJoined || 'character', user: profile.userName || 'user' };
    return template.replace(/\{\{\s*(scene|charDesc|userDesc|char|user)\s*\}\}/gi,
        (_, key) => values[Object.keys(values).find(name => name.toLowerCase() === key.toLowerCase())]);
}

/** Explicit profile and random choices make both Text AI passes independent of a page. */
export function buildSceneDescriptionInstruction(settings, scene, profile, { isMultiMessage = false } = {}) {
    const charName = profile.charNameJoined || 'character';
    const userName = profile.userName || 'user';
    const preserve = settings.preserveCharacterIdentity !== false;
    const names = unique(profile.charNames || []);
    const context = [];
    if (profile.charDescResolved) context.push(`${charName}'s appearance/profile: ${profile.charDescResolved.slice(0, 1500)}`);
    if (profile.userDescResolved) context.push(`${userName}'s persona/appearance: ${profile.userDescResolved.slice(0, 800)}`);
    if (profile.charTagsResolved) context.push(`Source/Tags: ${profile.charTagsResolved}`);
    if (profile.charScenarioResolved) context.push(`Setting: ${profile.charScenarioResolved.slice(0, 400)}`);
    if (preserve && names.length) context.push(`Active character names to preserve when visible: ${names.join(', ')}`);
    const sceneLabel = `SELECTED SCENE${isMultiMessage ? ' CONTEXT' : ''}`;
    const custom = String(settings.twoStepInstruction || '').trim();
    if (custom) return replaceCustom(custom, scene, profile)
        + (/\{\{\s*scene\s*\}\}/i.test(custom) ? '' : `\n\n${sceneLabel}:\n${scene}`);
    const rules = ['- Describe one coherent visible moment: subjects, identities, poses, expressions, clothing, setting, lighting, mood and framing.'];
    if (preserve) rules.push('- Keep stated species, ages, body traits, names and non-human details from the scene or reference context.');
    if (isMultiMessage) rules.push('- The scene is a multi-message transcript: pick the best single visual moment from it.');
    rules.push('- Output only the description: no dialogue, speaker labels, tags, lists, markdown or commentary.');
    return `[STANDALONE VISUAL SCENE DESCRIPTION TASK]
Turn the selected chat scene into one concise plain-language visual description for an image generator. This is a separate task, not a roleplay reply.

${rules.join('\n')}
${context.length ? `\nREFERENCE CONTEXT:\n${context.join('\n')}\n` : ''}
${sceneLabel}:
${scene}

Plain visual description:`;
}

export function buildImagePromptInstruction(settings, scene, profile, { isMultiMessage = false, artist = '' } = {}) {
    const s = settings;
    const charName = profile.charNameJoined || 'character';
    const userName = profile.userName || 'user';
    const charDesc = profile.charDescResolved || '';
    const userPersona = profile.userDescResolved || '';
    const scenario = profile.charScenarioResolved || '';
    const tags = profile.charTagsResolved || '';
    const names = unique(profile.charNames || []);
    const nameList = names.join(', ');
    const preserve = s.preserveCharacterIdentity !== false;
    const mentioned = names.filter(name => includesName(scene, name));
    const userInScene = !!userPersona && (/\b(i|me|my|mine|myself)\b/i.test(scene) || includesName(scene, userName));
    const secondary = userInScene && !mentioned.length;
    const userPrimary = userInScene && /\b(reflection|mirror|mirrored|view(?:ing)?\s+my\s+reflection|look(?:ing)?\s+at\s+myself|my\s+(?:face|body|figure|appearance|skin|eyes|reflection))\b/i.test(scene);
    const skins = [];
    if (preserve && charDesc.match(skinPattern)) skins.push(`${charName}: ${charDesc.match(skinPattern)[0]}`);
    if (preserve && userPersona.match(skinPattern)) skins.push(`${userName}: ${userPersona.match(skinPattern)[0]}`);
    const sections = [];
    if (profile.usesCurrentCardContext) {
        if (charDesc) sections.push(`${charName}'s appearance: ${charDesc.slice(0, 1500)}`);
        if (userPersona) sections.push(`${userName}'s appearance: ${userPersona.slice(0, 800)}`);
    } else {
        const persona = `User persona (${userName}; applies to first-person references like I/me/my): ${userPersona.slice(0, 800)}`;
        if (userInScene) sections.push(persona);
        if (charDesc) sections.push(`${secondary ? 'Secondary active character profiles (only use if the scene clearly includes them):' : 'Character profiles:'}\n${charDesc.slice(0, 1500)}`);
        if (!userInScene && userPersona) sections.push(persona);
    }
    if (tags) sections.push(`Source/Tags: ${tags}`);
    if (scenario) sections.push(`Setting: ${scenario.slice(0, 400)}`);
    const exactNames = preserve && profile.useExactNameRequirements && names.length > 0;
    const identityRules = [];
    if (preserve) {
        identityRules.push('- Keep every stated age, species, creature type, race and body trait. Use the specific identity over generic labels (man, woman, person, girl), and keep non-humans non-human.');
        if (skins.length) identityRules.push(`- Skin tones to keep: ${skins.join(', ')}`);
        if (exactNames) identityRules.push(secondary
            ? `- Active character names, only when the scene explicitly includes them: ${nameList}`
            : `- Use these exact character names when the scene or card identifies them: ${nameList}`);
        if (userPersona) identityRules.push(`- I/me/my or the name ${userName} in the scene is the user persona ${userName}: give that subject the persona's name, age, species and body.`);
        if (userInScene) identityRules.push(`- ${userName} is visibly part of this scene: show them as a full subject with their own traits, never as a generic human, a copy of the active character, or a stray hand or silhouette (unless the scene is an off-screen POV).`);
        if (userPrimary) identityRules.push(`- Reflection or self-view: ${userName} is the main subject, so describe their full appearance.`);
        if (secondary) identityRules.push('- Leave the active chat character out unless the scene clearly includes them.');
        if (userInScene && mentioned.length) identityRules.push(`- Keep ${userName} and ${mentioned.join(', ')} equally accurate; neither replaces the other.`);
    }
    if (identityRules.length) sections.push(`IDENTITY:\n${identityRules.join('\n')}`);
    const multi = isMultiMessage ? '\nThe scene is a speaker-tagged transcript: pick one coherent visual moment from it, and leave out speaker labels and dialogue.' : '';
    const sceneGap = isMultiMessage ? '\n' : ' ';
    if (s.llmPromptStyle === 'custom' && s.llmCustomInstruction?.trim()) {
        let instruction = replaceCustom(s.llmCustomInstruction, scene, profile);
        const extras = [];
        if (s.llmAddQuality) extras.push('- Quality tags (masterpiece, best quality, highly detailed)');
        if (s.llmAddLighting) extras.push('- A lighting description (soft, dramatic or rim lighting)');
        if (s.llmAddArtist) extras.push(`- An artist tag such as ${artist.replace(/ /g, '_')}`);
        if (extras.length) instruction += `\n\nALSO INCLUDE:\n${extras.join('\n')}`;
        if (identityRules.length) instruction += `\n\nIDENTITY:\n${identityRules.join('\n')}`;
        if (!/\{\{\s*scene\s*\}\}/i.test(s.llmCustomInstruction)) instruction += `\n\n${isMultiMessage ? 'SELECTED SCENE CONTEXT' : 'SELECTED SCENE'}:\n${scene}`;
        return instruction;
    }
    const reference = sections.join('\n');
    if (s.llmPromptStyle === 'natural') {
        const cover = ['- Who is present and their defining visual traits (hair, eyes, build, outfit, distinguishing features)'];
        if (preserve) cover.push('- For known franchise characters, the series name and canonical look');
        cover.push('- Pose, expression and body language', '- Setting and background', '- Lighting and atmosphere',
            '- Art style only where the scene or reference implies one (anime, illustration, painting, 3D, photo). Stay style-neutral otherwise; realism is never the default');
        if (s.llmAddQuality) cover.push('- Quality descriptors (highly detailed, intricate, polished)');
        if (s.llmAddLighting) cover.push('- A specific lighting setup (soft, dramatic or rim lighting)');
        cover.push(s.llmAddArtist ? `- An art style reference to an artist such as ${artist}` : '- No artist names');
        return `[STANDALONE IMAGE PROMPT GENERATION TASK]
Write one image prompt for the scene below. This is a separate task, not a chat reply: use only the scene and reference given here, and describe what is seen instead of repeating the scene text.${multi}
${reference ? `\nCHARACTER REFERENCE:\n${reference}\n` : ''}
CURRENT SCENE:${sceneGap}${scene}

Describe in flowing natural language, no tags or lists:
${cover.join('\n')}

Output only the image prompt, no commentary.

Prompt:`;
    }
    const cover = [preserve
        ? `- Character name + series (use the recognised character and series tags${exactNames ? `; keep the exact names ${nameList} when no canonical tag exists` : ''})`
        : '- Subjects and visible traits relevant to the scene',
    '- Physical traits (hair, eyes, body, skin)', '- Clothing and accessories', '- Pose and expression', '- Background/setting',
    `- Quality tags (masterpiece, best quality${s.llmAddQuality ? ', highly detailed, sharp focus' : ''})`];
    if (s.llmAddLighting) cover.push('- Lighting tags (soft lighting, dramatic lighting, rim lighting)');
    if (s.llmAddArtist) cover.push(`- An anime/manga artist tag such as ${artist.replace(/ /g, '_')}`);
    return `### STANDALONE IMAGE GENERATION TASK ###
Turn the scene below into Danbooru-style tags. This is a separate task, not a chat reply: use only the scene and character info given here.${multi}

Output ONLY comma-separated tags on one line. No sentences, no explanations.
Example: 1girl, hatsune_miku, vocaloid, long_hair, twintails, blue_hair, blue_eyes, detached_sleeves, sitting, smile, looking_at_viewer, classroom, window, sunlight, masterpiece, best_quality

Create Danbooru-style tags for this scene:${sceneGap}${scene}
${reference ? `\nCHARACTER INFO:\n${reference}\n` : ''}
Tag categories to cover:
${cover.join('\n')}

Never use:
- Realism tags (realistic, photorealistic, photography)
- ${s.llmAddArtist ? 'Realistic or overused artists (wlop, artgerm, sakimichan, greg rutkowski)' : 'Artist names'}

Tags:`;
}

export function cleanSceneDescription(text) {
    return String(text || '').trim().replace(/\[\d+\]\s*/g, '').replace(/\{\{\d+_[a-z0-9]+\}\}/gi, '')
        .replace(/\[ref:[a-z0-9]+\]/gi, '').replace(/^\s*(?:plain\s+)?(?:visual\s+)?(?:description|summary)\s*:\s*/i, '')
        .replace(/^['"`]+|['"`]+$/g, '').trim();
}

export function cleanImagePrompt(text, prefill, profile, scene) {
    let result = String(text || '').trim().replace(/\[\d+\]\s*/g, '').replace(/\{\{\d+_[a-z0-9]+\}\}/gi, '')
        .replace(/\[ref:[a-z0-9]+\]/gi, '').replace(/\[GEN:[^\]]+\]/g, '').replace(/\[Request ID: [^\]]+\]/g, '')
        .replace(/\[Generation ID: \d+\]/g, '').trim();
    const names = unique([...(profile.charNames || []), profile.userName]);
    const meta = prefill && !names.some(name => includesName(prefill, name))
        && (/(^|\b)(image prompt|prompt|tags?|description|answer)\b/i.test(prefill.trim()) || /[:>\-\]]\s*$/.test(prefill.trim()));
    if (meta && result.toLowerCase().startsWith(prefill.toLowerCase())) result = result.slice(prefill.length).trim();
    if (result && prefill && !meta && profile.charNames.some(name => includesName(prefill, name))
        && !profile.charNames.some(name => includesName(result, name))) result = `${prefill}${/[\s(,:-]$/.test(prefill) ? '' : ', '}${result}`.trim();
    if (/["'].*\s["']|said:|thought:|thought\s*:|^[A-Z][a-z]+\s+(?:nods|smiles|frowns|laughs|gasps)/i.test(result)) {
        result = scene.replace(/^###.*?###\s*/g, '').replace(/CRITICAL.*?\n*/gi, '')
            .replace(/Create.*?for\s+this\s+scene:/gi, '').replace(/Scene:\s*/gi, '').replace(/\n\n+/g, '\n').trim();
    }
    return result;
}
