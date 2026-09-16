# Original Neconyan assistants

Bundle version: 1 (`manifest.json` and each card's `extensions.neconyan_assistant.version` say 1; `character_version` is '1.0'). The number stays at 1 until public release, and older version-1 test installs are deleted by hand before reinstalling. Nine portraits, 252 transparent expressions, 24 tutorial chibis and nine assistant-head icons share the identities below. The Home picker installs the chosen variant and opens its existing character chat. 'Install updated copy' is available only when an installed card has an older bundle version.

Card text lives in `default/content/assistants/<id>/card.json`; the installer copies the matching `card.png`, so after editing any card run `node scripts/build-assistant-cards.js` to embed the JSON into the PNGs.

When replacing artwork, encode `card.png` from the new `portrait.png` bytes and the current card JSON using the character-card parser. The text-only build command preserves existing PNG pixels. Portrait URLs use a content checksum for cache refresh independently of the bundle version.

The user requested three personalities, each with male, female and neutral variants. All nine use original anime designs with subtle cat traits. These replace no user-created character or image.

## The three personalities

| Assistant | Role and voice | Visual identity |
| --- | --- | --- |
| Miso | A genki, cheerful guide for getting started. Easily impressed and delighted by surprises, gives one useful next step, offers short choices, and makes room for questions. | Orange hair with irregular charcoal-black tiger stripes, rounded tiger ears, amber eyes, cream knit layers with orange and charcoal striped panels, and an apricot scarf. |
| Taro | A sardonic troubleshooter who thinks his terrible puns are excellent and embarrasses easily when they land. Asks what was expected and what happened, checks evidence, and explains changes before suggesting them. | Smoky blue-grey hair and ears with silver highlights, grey-green eyes, a slate-grey utility jacket with charcoal pockets and collar, copper stitching, and a light grey shirt. |
| Nori | A bratty, pranking writing partner whose pranks never sting. Offers concrete story possibilities, helps revise scenes, and follows the user's preferred tone without taking over. | Black-and-white tuxedo palette: charcoal-black hair with an ivory forelock, black ears with white inner fluff, hazel eyes, a black overshirt with ivory collar and white chest panel, and a silver crescent detail. |

All designs are adults with human faces and skin, small cat ears partly hidden in the hair, and ordinary hands. No muzzle, fur-covered body, animal paws, weapons, text, logo or watermark. Keep faces, outfits and hair patterns recognisable in small portraits.

Miso has a gentle, friendly face, full cheeks and a visibly chubby body with a soft belly; the existing light warm peach skin stays the same. Taro has a severe, extremely attractive face with sculpted cheekbones, a defined jaw and light brown skin. Nori is lanky, bratty and conspicuously smug, with dark brown skin, half-lidded eyes, an arched eyebrow, a lifted chin and a lopsided grin. Preserve each build and skin colour across all genders and every artwork type.

The cards' interview, personality and Character Note include three personal details: Miso really, really loves belly rubs; Taro enjoys chain-smoking and has a slightly husky voice; Nori has expensive tastes despite being persistently broke.

## Gender variants

Each personality has a masculine male variant using he/him, a feminine female variant using she/her, and an androgynous neutral variant using they/them. Gender changes presentation and pronouns, not the assistant's competence, interests or behaviour. The personality's colour pattern, outfit and signature detail stay recognisable across variants.

The picker first presents the three personalities, then Male, Female and Neutral. Each assistant defaults to Neutral and remembers its own choice in account storage. A change immediately updates that assistant's tour illustrations and frontend head icon, including all three guides on the tour's closing step. The chosen personality for the frontend icon remains a separate setting. The picker names both choices before starting a chat. Existing chats keep their original variant; choosing another variant must not rewrite a saved card or chat.

## Card format

Each card follows the Ali:Chat plus PList layout that the assistants also recommend to users:

- `description` is a pure interview transcript: `` `Interviewer`: `` asks a two-to-five word question, `` `Name`: `` answers with plain-text actions and double-quoted dialogue, one blank line between exchanges, no headers, brackets or asterisks. The nine questions run Brief introduction, Pronouns, Personality, Appearance, a working-method question, a fault-line question about the assistant's own flaw, 'Can you change things in Neconyan?', 'Making a new character?' and a closing quirk. Pronouns and appearance reflect the selected gender; personality and interests stay consistent.
- The PList sits in the Character Note (`extensions.depth_prompt`, depth 4, role system): a bracketed keyword sheet headed `Name's persona:` with one `;`-terminated line per category (persona, likes, dislikes, backstory, appearance, body, hands, wardrobe, abilities, relationships, quirks_and_tells), no sentences, articles or connectors.
- `first_mes` is a single-line dialogue greeting without narration or stage directions (Miso: 'Meowlcome to Neconyan~! I\'m Miso! What are we working on today?', Taro: 'Expected and observed. Tell me what broke and what was supposed to happen instead.', Nori: 'Meowlcome! I\'m Nori. Show me what you\'re working on, let\'s make something fun!'). `alternate_greetings` is an empty list.
- `personality` and `scenario` are short continuous prose describing the assistant's character traits, dynamic in the Neconyan workroom, and creative style.
- `creator_notes` mirrors the picker line from `manifest.json`.

Writing rules for all card and tour copy: continuous sentences rather than clipped fragments, British spelling, no em dashes, no `not X but Y` contrasts, no stock beats (jaw work, breath catching, `a beat`), no clerical vocabulary (ledger, filing, audit, tally, column, record as a noun), and cat puns kept sparse and in character: Miso warm and delighted (Meowlcome plus a little more), Taro deliberately terrible and delivered with a straight face, unaware they are bad, Nori playful and proud. Puns never appear in the PList or in tool descriptions, and never as animal behaviour (no purring, hissing, growling or chirping).

The assistants can explain Neconyan and help with writing. Character prompts must not claim they can read local files, inspect hidden settings or change the app without a real tool. The write tools (create character, edit character, edit lorebook entry, edit agent, edit model preset) require `userConfirmed: true` and otherwise answer `needs_confirmation` with an ask-first checklist; creating a character with no avatar prompt uses the default Neconyan picture (`public/img/ai4.png`).

## Artwork production

Required generation route: use the existing `smol-image sunburst` command. The user confirmed that it uses `gpt-5.5` as a Responses coordinator and `gpt-image-2.5-sunburst` as the image-generation tool through the configured Smolproxy OpenAI endpoint. Do not use `flare`, `both`, another image model or another provider. The helper reads local credentials, supports reference edits and refuses overwriting. Direct Images requests and direct Sunburst-as-coordinator Responses requests are the wrong format for this service.

Artwork revision 4 uses a green extraction background, removed into real transparency with green edge correction. Check previews on light and dark backgrounds and check each image's transparency. Generate three 3×3 expression sheets per variant at 1536×2304, then split them into 512×768 files. Replace clipped or contaminated cells with individual reference edits. Expressions and tutorial chibis use WebP quality 92; card portraits remain PNG and frontend head icons are 192×192 PNGs. Accepted raw masters and prompts are kept locally under `.local-runtime/assistant-art-v4/approved/`. Earlier drafts outside that directory are rejected. Shipped artwork records retain the prompts, reference checksums, model names and final checksums. Accepted card assets live under `default/content/assistants/`; tutorial and icon assets live under `public/img/neconyan/`.

Each of the eight tour scenes has male, female and neutral versions, generated from the matching new portrait. The nine icons show human chibi heads with hair and ears, without shoulders or props. Gender presentation must remain legible at small size through facial proportions, hairstyle and silhouette.

Each variant needs one consistent neutral portrait, reused for its neutral expression, and 27 expression edits. That is 252 unique images across nine variants. Keep the same face, hair, ears, outfit, crop, lighting and transparent background within a variant. Change the face and a small natural gesture for the emotion. Do not use independent unrelated generations for each expression.

Expressions: admiration, amusement, anger, annoyance, approval, caring, confusion, curiosity, desire, disappointment, disapproval, disgust, embarrassment, excitement, fear, gratitude, grief, joy, love, nervousness, neutral, optimism, pride, realization, relief, remorse, sadness, surprise.

Portraits should frame the head, shoulders and upper torso with room around the ears. Expression assets need real transparency. Keep a high-resolution master and derive the character-card PNG at 512 × 768 without distorting the figure. Preserve character-card metadata when encoding the final PNG.

### Base portrait prompt

Use case: stylized-concept.

Create an original adult anime assistant for the Neconyan character-chat workspace. Apply the selected assistant's face, build, skin colour and gender presentation above. Keep a human face and natural hands. Miso looks gentle and friendly, Taro severe and strikingly attractive, and Nori smug and bratty. Miso has rounded tiger ears; Taro and Nori have cat ears. Frame the head, shoulders and upper torso towards the viewer with a dynamic asymmetrical turn and clear space around the ears. Use bold graphic shapes and two or three hard-edged cel tones. Keep the selected hair pattern and outfit consistent. Render a flat green extraction background, with neutral lighting on the subject and artwork free of text or scenery. Append this exact style instruction:

```text
Trigger anime style, flat cel-shading, very thick black outlines, dynamic posing
```

### Expression edit prompt

Use case: identity-preserve.

Use the neutral portrait as the edit target. Change only the expression and a small natural upper-body gesture to clearly convey the named emotion. Keep the same adult identity, gender presentation, face structure, hair pattern, ears, outfit, colours, framing, lighting and transparent background. Keep the whole head and ears inside the frame. No text, logo, watermark or new objects.

The named emotion takes precedence over the default facial expression: Nori can look genuinely sad, frightened or surprised while keeping the same face and lanky build.

## Integration checks

- Every personality offers all three variants and correct pronouns.
- Every variant has a valid character card and all 28 expression filenames.
- The assistant picker works with keyboard and touch at 320px and desktop widths.
- Selecting a variant creates or opens the right assistant without overwriting user-edited copies.
- Default startup remains dark; assistant artwork works on both stock themes.
- Card import/export preserves unknown extension metadata and expression association.
- Generated output must be inspected for identity drift, duplicate expressions, clipping and broken alpha before bundling.
- Frontend Icon offers Calico, Miso, Taro and Nori; selection survives reloads and Conversation unread badges use the selected head.
- Independent gender choices survive reloads, default to Neutral for an account without choices, and refresh the active icon even when its assistant name stays the same.
