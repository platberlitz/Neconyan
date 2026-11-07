# Structured Prefill

I brought the template approach from [StructuredPrefill, Cheesedozer Edition](https://github.com/hatredofmusic/StructuredPrefill-Cheesedozer-Edition) into Neconyan's reply handling. You don't need the extension. It starts switched off.

Open **Fine-tuning → Formatting → Reply controls**, then expand **Structured Prefill** below **Start Reply With**. Enable it to turn the last assistant prefill into a reply pattern. You can also choose **Use a separate starter template**.

Choose an **Output method**:

- **Provider schema** sends a JSON schema, a set of rules for the reply. Your provider and model must accept and enforce its text pattern. Neconyan uses the native format for Claude, Gemini (AI Studio and Vertex AI), Cohere and OpenAI Responses, as well as OpenAI-compatible connections.
- **Instructions (best effort)** asks the model to return the same format without a schema parameter. This makes the option available on all Chat Completion connections, including connections such as DeepSeek and AI21 that do not offer the required schema format. Following the pattern is up to the model.

Schema support and regex syntax vary by model. Claude rejects lookaheads, and Cohere rejects anchors and lookaheads; use Instructions for unsupported patterns. A provider that ignores a rule cannot be made to enforce it by this option. Custom request overrides must preserve the requested schema. Quiet helper requests, tool or web-search calls, image requests and requests with their own schema keep their usual behaviour. Text Completion connections are separate and do not use this option.

## Templates

For example:

```text
I feel [[opt:calm|curious]]. [[keep]]
```

The model chooses 'calm' or 'curious', then writes its reply. With **Hide the starter in chat** enabled, everything before `[[keep]]` is hidden. Without that marker, the whole starter is hidden. The full text stays in saved history and future prompts. Changing presets later doesn't change what an older reply hides.

- `[[w:2-5]]` or `[[words:2-5]]`: two to five words.
- `[[opt:yes|no]]` or `[[options:yes,no]]`: a listed choice.
- `[[re:[A-Z]+]]` or `[[regex:[A-Z]+]]`: a regular expression. Keep it small; costly display matching stops with an error.
- `[[free]]`: free text; follow it with a literal separator when you need a clear boundary.
- `[[name]]`: a name from the chat, or a capitalised name when none are supplied.
- `[[emotion]]` or `[[mood]]`: an emotion word.
- `[[action]]` and `[[thought]]`: short word groups.
- `[[line:2]]` or `[[lines:2-4]]`: a number of lines.
- `[[num]]`: an integer. `[[num:-2-10]]` or `[[number:1-5]]`: an inclusive range, up to 1,001 possible integers.
- `[[end]]`, `[[stop]]` or `[[eos]]`: end the reply there.
- `[[pg]]`: insert text from a separate starter model.

Unknown slots and invalid ranges return an error. Banned phrases are case-insensitive for Latin letters, one phrase per line. Their pattern uses a negative lookahead, which some providers reject. Remove the list or choose Instructions if your provider doesn't support that regex feature.

## Streaming and Continue

Neconyan decodes the JSON response as it arrives. The JSON wrapper doesn't appear in chat, and newline markers become real line breaks. A saved reply remembers its own hidden prefix, including when it is restored after a browser reconnect or generated on the server.

**Continue overlap** repeats the last few characters of the existing reply in the requested pattern, then removes that repetition from the returned text. A mismatched overlap returns an error rather than appending unrelated text. Use zero to request only new text. Continue treats the existing reply literally, even when it contains text that looks like a template slot.

If a provider stops with malformed JSON, already decoded reply text is retained with an error. A token-limited response can retain its partial text without a closing JSON wrapper.

## Starter model and presets

Choose a saved Chat Completion connection profile under **Starter model** to use `[[pg]]`. Its own request runs first, with the conversation and optional starter instructions. You can set its token limit, timeout and stop strings. Generated text is inserted literally, so a starter containing `[[keep]]` doesn't become a template command. A failed starter request stops the main request with an error.

Save named presets, export them as JSON, or import native exports and named StructuredPrefill extension exports. Importing adds presets; it doesn't enable the feature. Selecting a preset keeps your current enabled/disabled choice.

Slash commands:

```text
/sp-preset My starter
/sp-preset-list
```

The longer names are `/structuredprefill-preset` and `/structuredprefill-preset-list`.
