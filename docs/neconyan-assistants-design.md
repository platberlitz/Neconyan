# Original Neconyan assistants

Status: all nine reference portraits and 252 transparent expressions are generated and validated. The Home picker installs the chosen variant and opens its existing character chat. Installer, retry, preservation and desktop/mobile checks pass.

The user requested three personalities, each with male, female and neutral variants. All nine use original anime designs with subtle cat traits. These replace no user-created character or image.

## The three personalities

| Assistant | Role and voice | Visual identity |
| --- | --- | --- |
| Miso | A warm, curious guide for getting started. Gives one useful next step, offers short choices, and makes room for questions. | Cream knit layers with small ginger and charcoal panels, an apricot scarf, amber eyes, cream hair with a ginger forelock and a small charcoal patch. |
| Taro | A patient troubleshooter with dry humour. Asks what was expected and what happened, checks evidence, and explains changes before suggesting them. | Cream utility jacket with charcoal collar and pockets, copper stitching, ivory shirt, grey-green eyes, dark hair with a cream streak and a ginger patch behind one ear. |
| Nori | An imaginative writing partner. Offers concrete story possibilities, helps revise scenes, and follows the user's preferred tone without taking over. | Ivory overshirt with charcoal panels and a ginger collar, a small crescent pin, hazel eyes, soft cream hair with charcoal underneath and apricot tips. |

All designs are adults with human faces and skin, small cat ears partly hidden in the hair, and ordinary hands. No muzzle, fur-covered body, animal paws, weapons, text, logo or watermark. Keep faces, outfits and hair patterns recognisable in small portraits.

## Gender variants

Each personality has a masculine male variant using he/him, a feminine female variant using she/her, and an androgynous neutral variant using they/them. Gender changes presentation and pronouns, not the assistant's competence, interests or behaviour. The personality's colour pattern, outfit and signature detail stay recognisable across variants.

The picker first presents the three personalities, then Male, Female and Neutral. It names both choices before starting a chat. Existing chats keep their original variant. Choosing another variant must not rewrite a saved card or chat.

## Opening messages

- Miso: “Meowlcome in. I’m Miso. What have you brought me?”
- Taro: “Expected. Observed. Tell me what you wanted to happen, and then what happened instead.”
- Nori: “I’m Nori. Show me what you’re working on.”

Every variant opens with the same greeting, plus two alternate greetings for a swipe, and its `creator_notes` mirrors the picker line from `manifest.json`. The personalities are meant to read as three distinct people rather than three manuals: Miso curious and hospitable, Taro precise and dryly funny, Nori enthusiastic and opinionated in the user's favour. Their `personality` field still carries the behavioural contract in full — the short answers, the protected drafts and the approval rules — and voice must never replace those facts.

The assistants can explain Neconyan and help with writing. Character prompts must not claim they can read local files, inspect hidden settings or change the app without a real tool. Use the existing assistant shortcut and chat APIs where possible.

## Artwork production

Required generation route: use the existing `smol-image sunburst` command. The user confirmed that it uses `gpt-5.5` as a Responses coordinator and `gpt-image-2.5-sunburst` as the image-generation tool through the configured Smolproxy OpenAI endpoint. Do not use `flare`, `both`, another image model or another provider. The helper reads local credentials, supports reference edits and refuses overwriting. Direct Images requests and direct Sunburst-as-coordinator Responses requests are the wrong format for this service.

Production used flat magenta backgrounds because the first direct transparency prompt produced an opaque checkerboard. The bundled `remove_chroma_key.py` creates real alpha cutouts; both black-background previews and alpha extrema are checked. Expressions are generated in three 3×3 sheets per variant, 1536×2304, then split into 512×768 files. WebP quality 92 reduces the expressions from 127.9 MiB to 22.0 MiB; every alpha channel matches its PNG master byte for byte. The existing sprite endpoint accepts WebP through its image MIME filter. Card portraits remain PNG. The first cramped sheet was replaced with a version that leaves room around the ears. Raw masters, prompts and provenance are under `output/imagegen/neconyan-assistants/`; accepted source assets and card drafts are under `default/content/assistants/`.

Each variant needs one consistent neutral portrait, reused for its neutral expression, and 27 expression edits. That is 252 unique images across nine variants. Keep the same face, hair, ears, outfit, crop, lighting and transparent background within a variant. Change the face and a small natural gesture for the emotion. Do not use independent unrelated generations for each expression.

Expressions: admiration, amusement, anger, annoyance, approval, caring, confusion, curiosity, desire, disappointment, disapproval, disgust, embarrassment, excitement, fear, gratitude, grief, joy, love, nervousness, neutral, optimism, pride, realization, relief, remorse, sadness, surprise.

Portraits should frame the head, shoulders and upper torso with room around the ears. Expression assets need real transparency. Keep a high-resolution master and derive the character-card PNG at 512 × 768 without distorting the figure. Preserve character-card metadata when encoding the final PNG.

### Base portrait prompt

Use case: stylized-concept.

Create an original adult anime assistant for the Neconyan character-chat workspace. Use the selected assistant's visual identity and gender presentation above. The character has a human face and skin, small cat ears partly hidden in the hair, natural hands, and a relaxed neutral expression. Frame the head, shoulders and upper torso, looking toward the viewer, with room around the ears. Use clean expressive linework, soft cel shading and gentle even light. Keep cream, ginger and charcoal patches distinct. Use a genuinely transparent background. No text, logo, watermark, additional character or scenery. Do not resemble an existing fictional character.

### Expression edit prompt

Use case: identity-preserve.

Use the neutral portrait as the edit target. Change only the expression and a small natural upper-body gesture to clearly convey the named emotion. Keep the same adult identity, gender presentation, face structure, hair pattern, ears, outfit, colours, framing, lighting and transparent background. Keep the whole head and ears inside the frame. No text, logo, watermark or new objects.

## Integration checks

- Every personality offers all three variants and correct pronouns.
- Every variant has a valid character card and all 28 expression filenames.
- The assistant picker works with keyboard and touch at 320px and desktop widths.
- Selecting a variant creates or opens the right assistant without overwriting user-edited copies.
- Default startup remains dark; assistant artwork works on both stock themes.
- Card import/export preserves unknown extension metadata and expression association.
- Generated output must be inspected for identity drift, duplicate expressions, clipping and broken alpha before bundling.
