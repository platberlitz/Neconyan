# Chat links

I kept this opt-in. You can bookmark an exact saved conversation without making every chat change your address bar, and you don't have to enable automatic launch restoration to use a link.

## Using it

Both switches sit next to 'Copy chat link', so you don't have to dig through settings to find them. On desktop they're in the Recent Chats panel, under the copy button. On phones, the chat tools menu has a 'Chat link settings' row that opens a small panel with the copy button and both switches. They're also the first two options under Chat/Message Handling in User Settings. Every copy stays in sync.

'Chat links in the address bar' keeps the address bar on the saved chat you're viewing. It's off by default. 'Resume last chat on launch' is separate: it uses your account's last successfully opened saved conversation when you open Neconyan without a destination. Your previous auto-load choice is kept.

The existing chat tools menu has a labelled 'Copy chat link' action on desktop and phones. It works with both switches off. A link opens the same saved conversation for the same account on the same installation. It doesn't publish a chat or give another person access.

Temporary chats and unsaved Conversation branches don't have links. Copying doesn't save them for you. If your browser refuses clipboard access, you get a selectable link instead of a false 'Copied' message.

Saved single-character and group Roleplay chats are supported. Conversation links keep the exact persona, group context and branch. Story links use the same saved Roleplay chat with Story presentation; opening one doesn't save a display preference. A disabled mode stays disabled. Meower remains a feed, not a chat destination.

## Launch and history

An explicit chat link wins over launch restoration, even with both preferences off. Existing import and workspace startup actions keep their priority. An explicit Home destination stays Home on refresh and doesn't erase the remembered chat.

With 'Chat links in the address bar' on, choosing another saved conversation adds a history entry. Startup, preference changes and address cleanup replace the current entry. Messages, renamed titles and settings don't add entries. With it off, an explicit link can remain while that chat is visible; moving elsewhere removes its stale chat parameters.

Back and Forward use the address itself, including entries without browser state. Pending edits finish before a switch. An unsent draft, selected attachments or an active reply can refuse navigation; the current address is restored rather than putting one editable chat under another chat's link. Loading or failure blocks new sends. Missing links never create a chat, greeting, branch or model request.

Each restored browser page keeps its own destination. Opening another device doesn't move existing pages. Between devices, the most recent navigation accepted by the server decides the remembered launch chat. Automatic launch restoration doesn't write that destination back.

## Why the IDs are separate from names

I don't want a deleted chat's bookmark opening something new just because you reused its name. Roleplay uses its existing protected instance ID. Conversation has a server-owned ID on the saved branch, with a protected index for direct lookup. Resets, copies, imports and deleted owners can't transfer an old ID to replacement content. Supported chat and character renames preserve the original identity during the existing safeguarded rename operation.

Looking up a link is read-only. Establishing an ID is a signed-in, identity-only operation, protected against requests from other websites and subject to the existing account and settings safeguards. It doesn't rewrite a Roleplay transcript or force a Conversation content save. URLs contain an ID and a supported mode, never chat text, a filesystem path or credentials. Copied links omit unrelated query parameters and fragments.

## Migration, backups and limits

The first unqualified launch with restoration enabled can adopt the exact legacy saved-chat choice, once. It doesn't guess from dates or choose the newest file. If that choice can't be verified, you stay on Home. Explicit links and explicit Home don't perform this migration.

The remembered launch destination, ordering records and account-specific IDs live in a small versioned document alongside the existing protected Roleplay store. Conversation IDs stay in its existing versioned settings block. There's no new database. Account identity and saved-data version checks invalidate incompatible records.

Back up the protected store with the account data using the existing installation backup procedure. An account export or foreign import isn't a portable set of links; imported content needs newly established IDs. Restores remain subject to the existing ownership and recovery rules, so don't copy identity markers manually to make an old link work.

Neconyan still doesn't cache signed-in pages or these server responses. An already-open page offers Retry for a connection failure without deleting its remembered target. A cold offline launch isn't guaranteed. An installed app's operating system may reopen its registered start address rather than a dynamic chat URL; I can't promise otherwise.

Chromium checks cover desktop and phone layouts. iPhone home-screen behaviour is emulated in Chromium; real Safari and operating-system relaunch behaviour haven't been verified here.

## Implementation references

- URL policy and startup: `public/scripts/chat-navigation-policy.js`, `public/scripts/chat-navigation.js`.
- Protected account record and API: `src/chat-navigation-state.js`, `src/endpoints/chat-navigation.js`.
- Conversation identity and rename recovery: `src/conversation-navigation-identity.js`, `src/chat-navigation-lifecycle.js`.
- Isolated checks: `tests/chat-navigation-policy.test.js`, `tests/chat-navigation.node.js`, `tests/chat-navigation.e2e.js`.
