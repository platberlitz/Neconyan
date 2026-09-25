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
    const context = [];
    if (profile.charDescResolved) context.push(`${charName}'s appearance/profile: ${profile.charDescResolved.slice(0, 1500)}`);
    if (profile.userDescResolved) context.push(`${userName}'s persona/appearance: ${profile.userDescResolved.slice(0, 800)}`);
    if (profile.charTagsResolved) context.push(`Source/Tags: ${profile.charTagsResolved}`);
    if (profile.charScenarioResolved) context.push(`Setting: ${profile.charScenarioResolved.slice(0, 400)}`);
    if (preserve && profile.charNames.length) context.push(`Active character names to preserve when visible: ${profile.charNames.join(', ')}`);
    const custom = String(settings.twoStepInstruction || '').trim();
    if (custom) return replaceCustom(custom, scene, profile)
        + (/\{\{\s*scene\s*\}\}/i.test(custom) ? '' : `\n\nSELECTED SCENE${isMultiMessage ? ' CONTEXT' : ''}:\n${scene}`);
    return `[STANDALONE VISUAL SCENE DESCRIPTION TASK]

Convert the selected chat scene into one concise plain-language visual description for an image generator.

Rules:
- Output ONLY the plain description. No commentary, no markdown, no speaker labels, no tags, no bullet list.
- Describe one coherent visible moment: subjects, identities, poses, expressions, clothing, setting, lighting, mood, and camera framing.
${preserve ? '- Preserve explicit species, ages, body traits, names, and non-human details from the scene or reference context.' : ''}
- Do not continue the roleplay and do not quote dialogue.
${isMultiMessage ? '- The selected scene is a multi-message transcript. Infer the best single visual moment from it.' : ''}${context.length ? `\nREFERENCE CONTEXT:\n${context.join('\n')}` : ''}

SELECTED SCENE${isMultiMessage ? ' CONTEXT' : ''}:
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
    const skin = skins.length ? `\nCRITICAL - You MUST include these skin tones: ${skins.join(', ')}` : '';
    let appearance = '';
    if (profile.usesCurrentCardContext) {
        if (charDesc) appearance += `${charName}'s appearance: ${charDesc.slice(0, 1500)}\n`;
        if (userPersona) appearance += `${userName}'s appearance: ${userPersona.slice(0, 800)}\n`;
        if (tags) appearance += `Source/Tags: ${tags}\n`;
        if (scenario) appearance += `Setting: ${scenario.slice(0, 400)}\n`;
    } else {
        const sections = [];
        const persona = `User persona (${userName}; applies to first-person references like I/me/my): ${userPersona.slice(0, 800)}`;
        if (userInScene) sections.push(persona);
        if (charDesc) sections.push(`${secondary ? 'Secondary active character profiles (only use if the scene clearly includes them):' : 'Character profiles:'}\n${charDesc.slice(0, 1500)}`);
        if (!userInScene && userPersona) sections.push(persona);
        if (tags) sections.push(`Source/Tags: ${tags}`);
        if (scenario) sections.push(`Setting: ${scenario.slice(0, 400)}`);
        appearance = sections.length ? `${sections.join('\n')}\n` : '';
    }
    const exactNames = preserve && profile.useExactNameRequirements && names.length > 0;
    const nameRequirement = exactNames ? `\n- Preserve and include these exact character name${names.length === 1 ? '' : 's'} when the scene/card identifies them${secondary ? '; otherwise do not force them into the prompt just because they are the active chat character' : ''}: ${nameList}` : '';
    const userRequirement = preserve && userPersona ? `\n- If the scene refers to the user in first person or by name, preserve and include the exact user persona name when applicable: ${userName}` : '';
    const nameBlock = exactNames ? `\n${secondary ? 'ACTIVE CHARACTER NAMES (only use if the scene explicitly includes them):' : 'CHARACTER NAMES TO PRESERVE (use these exact spellings when applicable):'} ${nameList}` : '';
    const userBlock = preserve && userPersona ? `\nUSER PERSONA NAME (use when the scene refers to the user / I / me / my): ${userName}` : '';
    const identityRules = ['- Preserve any explicit age, age range, species, creature type, race, or persona/body traits from the scene or profile.',
        '- Do NOT flatten specific identities into generic labels like man, woman, person, human, teen, adult, boy, or girl when more specific information is available.',
        '- If a subject is non-human or from a known fantasy/franchise species, keep that identity in the prompt instead of humanizing it.'];
    if (userPersona) identityRules.push(`- If the scene uses first-person references like I/me/my or mentions ${userName}, that subject is the user persona described below. Use that persona's age, species, body type, and nonhuman traits.`);
    const identity = preserve ? `\nIDENTITY REQUIREMENTS:\n${identityRules.join('\n')}` : '';
    const subjectRules = [];
    if (userInScene) subjectRules.push(`- The user persona (${userName}) is visually involved in this scene whenever the scene uses first-person references or the user name.`,
        '- Do NOT replace the user persona with a generic human label or with the active chat character\'s profile.',
        '- If the user persona is acting in the scene, depict them as a full subject when relevant instead of reducing them to a hand, claw, limb, silhouette, or other partial-body placeholder unless the scene explicitly calls for an off-screen POV framing.');
    if (userPrimary) subjectRules.push(`- Reflection/self-view scenes should treat the user persona (${userName}) as the primary visual subject and describe their full appearance.`);
    if (secondary) subjectRules.push('- Do not center the active chat character or inject their full profile unless the scene clearly includes them.');
    if (userInScene && mentioned.length) subjectRules.push(`- If both the user persona and another subject are present, preserve both identities accurately and do not let ${mentioned.join(', ')} overshadow the user persona.`);
    const subject = preserve && subjectRules.length ? `\nSCENE SUBJECT PRIORITY:\n${subjectRules.join('\n')}` : '';
    const userBullet = preserve && userPersona ? `\n- If the scene refers to the user in first person or by name, use the user persona reference below for that subject (${userName})` : '';
    const multi = isMultiMessage ? '\nMULTI-MESSAGE SCENE CONTEXT:\n- The selected scene below is speaker-tagged context from the chosen chat messages.\n- Use it to infer one coherent visual moment.\n- Do NOT copy speaker labels, quote dialogue, or echo transcript lines in the output.\n- Convert the exchange into visual details only: subjects, actions, expressions, setting, camera framing, lighting, and mood.' : '';
    if (s.llmPromptStyle === 'custom' && s.llmCustomInstruction?.trim()) {
        let instruction = replaceCustom(s.llmCustomInstruction, scene, profile);
        let enhancements = '';
        if (s.llmAddQuality) enhancements += '\n- Include quality tags (masterpiece, best quality, highly detailed, sharp focus, etc.)';
        if (s.llmAddLighting) enhancements += '\n- Include lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)';
        if (s.llmAddArtist) enhancements += `\n- Include artist tags (e.g., ${artist.replace(/ /g, '_')}, etc.)`;
        if (enhancements) instruction += `\n\nADDITIONAL REQUIREMENTS:${enhancements}`;
        instruction += skin + identity + subject;
        if (nameRequirement || userRequirement) instruction += `\n\nNAME REQUIREMENTS:${nameRequirement}${userRequirement}`;
        if (!/\{\{\s*scene\s*\}\}/i.test(s.llmCustomInstruction)) instruction += `\n\n${isMultiMessage ? 'SELECTED SCENE CONTEXT' : 'SELECTED SCENE'}:\n${scene}`;
        return instruction;
    }
    let enhancements = '';
    let restrictions = '';
    if (s.llmPromptStyle === 'natural') {
        if (s.llmAddQuality) enhancements += '\n- Enhanced quality descriptors (masterpiece, highly detailed, sharp focus, etc.)';
        if (s.llmAddLighting) enhancements += '\n- Professional lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)';
        if (s.llmAddArtist) enhancements += `\n- Art style references from well-known artists (e.g., ${artist}, etc.)`;
        else restrictions += '\n- DO NOT include artist names or art style references';
        return `[STANDALONE IMAGE PROMPT GENERATION TASK]${skin}

CRITICAL INSTRUCTIONS:
- IGNORE any ambient chat history outside the selected scene below
- Generate ONLY a new image prompt based on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone task, not a continuation of chat
${multi}

[Output ONLY an image generation prompt. No commentary or explanation.]${skin}

CHARACTER REFERENCE:
${appearance}${nameBlock}${userBlock}${identity}${subject}
${isMultiMessage ? 'SCENE CONTEXT (multiple messages):\n' : 'CURRENT SCENE: '}${scene}

Write a detailed image prompt describing:
- The characters involved with their defining visual traits (hair color, eye color, outfit, distinguishing features)
${exactNames ? `- Use the exact active character names when the scene/card identifies them (${nameList})` : ''}
${userBullet}
${preserve ? '- Preserve explicit ages, species, creature types, and nonhuman identities from the scene/profile instead of replacing them with generic human labels' : ''}
${preserve ? '- If from known media/franchise, include the series name and character\'s canonical appearance' : ''}
- Their poses, expressions, and body language
- The setting/background
- Lighting and atmosphere
- High quality visual details (sharp focus, detailed rendering, etc.)${enhancements ? `\n\nYOU MUST ALSO INCLUDE:${enhancements}` : ''}${restrictions}

Prompt:`;
    }
    restrictions = '\nCRITICAL RESTRICTIONS (MUST FOLLOW):\n- NEVER use realistic style tags (e.g., realistic, photorealistic, hyperrealistic, photography, etc.)\n- NEVER use realistic artists (e.g., wlop, artgerm, rossdraws, etc.)\n- NEVER use common/overused artists (e.g., sakimichan, greg rutkowski, alphonse mucha, etc.)';
    if (s.llmAddQuality) enhancements += '\n- Enhanced quality tags (masterpiece, best quality, highly detailed, sharp focus, etc.)';
    if (s.llmAddLighting) enhancements += '\n- Professional lighting descriptions (dramatic lighting, soft lighting, rim lighting, etc.)';
    if (s.llmAddArtist) enhancements += `\n- Include artist tags from anime/manga artists (e.g., ${artist.replace(/ /g, '_')}, etc.)`;
    else restrictions += '\n- DO NOT include any artist names';
    return `### STANDALONE IMAGE GENERATION TASK ###${skin}

CRITICAL - THIS IS NOT A CONTINUATION OF CHAT:
- IGNORE any ambient chat history outside the selected scene below
- Generate a FRESH image prompt based ONLY on the selected scene below
- DO NOT repeat or paraphrase the scene text verbatim
- This is a standalone generation task
${multi}

### OUTPUT FORMAT (MANDATORY) ###
Output ONLY comma-separated Danbooru/Booru-style tags. No sentences. No descriptions. No paragraphs. No prose. No explanations.
If you write a sentence instead of tags, you have FAILED the task.

CORRECT example output:
1girl, hatsune_miku, vocaloid, long_hair, twintails, blue_hair, blue_eyes, detached_sleeves, thighhighs, sitting, smile, looking_at_viewer, classroom, window, sunlight, masterpiece, best_quality

WRONG (DO NOT do this):
"A girl with long blue twintails sits in a classroom by the window, smiling at the viewer."

### IMAGE GENERATION TASK ###

Create Danbooru/Booru-style tags for this ${isMultiMessage ? 'scene context:\n' : 'scene: '}${scene}

Character info: ${appearance}${nameBlock}${userBlock}${identity}${subject}

Required tag categories:
${preserve ? `- Character name + series name (CRITICAL: Use recognizable fictional media character tags whenever recognized${exactNames ? `, and keep exact active names like ${nameList || 'the named character'} when no canonical tag exists` : ''})` : '- Subjects and visible traits relevant to the selected scene'}
${userBullet}
${preserve ? '- Preserve explicit ages, species, creature types, and nonhuman identities from the scene/profile instead of replacing them with generic human tags' : ''}
- Physical traits (hair, eyes, body, skin)
- Clothing and accessories
- Pose and expression
- Background/setting
- Quality tags (masterpiece, best quality, etc.)${enhancements ? `\n\nMUST INCLUDE these additional elements:${enhancements}` : ''}
${restrictions}

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
