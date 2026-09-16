# Original Neconyan assistants

Artwork bundle: version 3. Nine portraits, 252 transparent expressions, eight tutorial chibis and three selectable assistant-head icons share the identities below. The Home picker installs the chosen variant and opens its existing character chat. Older installed cards can use 'Install updated copy' to receive the new artwork.

The user requested three personalities, each with male, female and neutral variants. All nine use original anime designs with subtle cat traits. These replace no user-created character or image.

## The three personalities

| Assistant | Role and voice | Visual identity |
| --- | --- | --- |
| Miso | A warm, curious guide for getting started. Gives one useful next step, offers short choices, and makes room for questions. | Orange hair with irregular charcoal-black tiger stripes, rounded tiger ears, amber eyes, cream knit layers with orange and charcoal striped panels, and an apricot scarf. |
| Taro | A patient troubleshooter with dry humour. Asks what was expected and what happened, checks evidence, and explains changes before suggesting them. | Smoky blue-grey hair and ears with silver highlights, grey-green eyes, a slate-grey utility jacket with charcoal pockets and collar, copper stitching, and a light grey shirt. |
| Nori | An imaginative writing partner. Offers concrete story possibilities, helps revise scenes, and follows the user's preferred tone without taking over. | Black-and-white tuxedo palette: charcoal-black hair with an ivory forelock, black ears with white inner fluff, hazel eyes, a black overshirt with ivory collar and white chest panel, and a silver crescent detail. |

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

Version 3 production uses a green extraction background, removed into real transparency with green edge correction. Check previews on light and dark backgrounds and check each image's transparency. Generate three 3×3 expression sheets per variant at 1536×2304, then split them into 512×768 files. Replace any clipped expression with an individual reference edit. Expressions and tutorial chibis use WebP quality 92; card portraits remain PNG and frontend head icons are 192×192 PNGs. Raw masters and prompts for this release are kept locally under `.local-runtime/assistant-art-v3/`. Shipped artwork records retain the prompts, reference checksums, model names and final checksums. Accepted card assets live under `default/content/assistants/`; tutorial and icon assets live under `public/img/neconyan/`.

Each variant needs one consistent neutral portrait, reused for its neutral expression, and 27 expression edits. That is 252 unique images across nine variants. Keep the same face, hair, ears, outfit, crop, lighting and transparent background within a variant. Change the face and a small natural gesture for the emotion. Do not use independent unrelated generations for each expression.

Expressions: admiration, amusement, anger, annoyance, approval, caring, confusion, curiosity, desire, disappointment, disapproval, disgust, embarrassment, excitement, fear, gratitude, grief, joy, love, nervousness, neutral, optimism, pride, realization, relief, remorse, sadness, surprise.

Portraits should frame the head, shoulders and upper torso with room around the ears. Expression assets need real transparency. Keep a high-resolution master and derive the character-card PNG at 512 × 768 without distorting the figure. Preserve character-card metadata when encoding the final PNG.

### Base portrait prompt

Use case: stylized-concept.

Create an original adult anime assistant for the Neconyan character-chat workspace. Apply the selected assistant's visual identity and gender presentation above. Keep a human face and skin, natural hands and a relaxed neutral expression. Miso has rounded tiger ears; Taro and Nori have cat ears. Frame the head, shoulders and upper torso, looking towards the viewer, with clear space around the ears. Use clean expressive linework, soft cel shading and gentle even light. Keep the selected hair pattern and outfit consistent. Render a flat green extraction background, with neutral lighting on the subject and artwork free of text or scenery.

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
- Frontend Icon offers Calico, Miso, Taro and Nori; selection survives reloads and Conversation unread badges use the selected head.
