// Editable starting points for the built-in Text AI instructions.
// Keep these in sync with the adaptive builders in prompt-instructions.js: they
// mirror the standard single-message case, while toggle-driven blocks (identity
// rules, quality/lighting/artist additions) are appended at request time by the
// custom-instruction path.

export const DEFAULT_TAGS_INSTRUCTION_TEMPLATE = `### STANDALONE IMAGE GENERATION TASK ###
Turn the scene below into Danbooru-style tags. This is a separate task, not a chat reply: use only the scene and character info given here.

Output ONLY comma-separated tags on one line. No sentences, no explanations.
Example: 1girl, hatsune_miku, vocaloid, long_hair, twintails, blue_hair, blue_eyes, detached_sleeves, sitting, smile, looking_at_viewer, classroom, window, sunlight, masterpiece, best_quality

Create Danbooru-style tags for this scene: {{scene}}

CHARACTER INFO:
{{char}}'s appearance: {{charDesc}}
{{user}}'s persona: {{userDesc}}

Tag categories to cover:
- Character name + series (use the recognised character and series tags)
- Physical traits (hair, eyes, body, skin)
- Clothing and accessories
- Pose and expression
- Background/setting
- Quality tags (masterpiece, best quality)

Never use:
- Realism tags (realistic, photorealistic, photography)
- Realistic or overused artists (wlop, artgerm, sakimichan, greg rutkowski)

Tags:`;

export const DEFAULT_NATURAL_INSTRUCTION_TEMPLATE = `[STANDALONE IMAGE PROMPT GENERATION TASK]
Write one image prompt for the scene below. This is a separate task, not a chat reply: use only the scene and reference given here, and describe what is seen instead of repeating the scene text.

CHARACTER REFERENCE:
{{char}}'s appearance: {{charDesc}}
{{user}}'s persona: {{userDesc}}

CURRENT SCENE: {{scene}}

Describe in flowing natural language, no tags or lists:
- Who is present and their defining visual traits (hair, eyes, build, outfit, distinguishing features)
- Pose, expression and body language
- Setting and background
- Lighting and atmosphere
- Art style only where the scene or reference implies one (anime, illustration, painting, 3D, photo). Stay style-neutral otherwise; realism is never the default

Output only the image prompt, no commentary.

Prompt:`;

export const DEFAULT_TWO_STEP_INSTRUCTION_TEMPLATE = `[STANDALONE VISUAL SCENE DESCRIPTION TASK]
Turn the selected chat scene into one concise plain-language visual description for an image generator. This is a separate task, not a roleplay reply.

- Describe one coherent visible moment: subjects, identities, poses, expressions, clothing, setting, lighting, mood and framing.
- Keep stated species, ages, body traits, names and non-human details from the scene or reference context.
- Output only the description: no dialogue, speaker labels, tags, lists, markdown or commentary.

REFERENCE CONTEXT:
{{char}}'s appearance/profile: {{charDesc}}
{{user}}'s persona/appearance: {{userDesc}}

SELECTED SCENE:
{{scene}}

Plain visual description:`;
