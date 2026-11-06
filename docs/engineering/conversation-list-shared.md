# Personal conversation list visibility: shared client contract

Refs #1924. Backend wire protocol: [gugu-supabase#201](https://github.com/GUYI-AI/gugu-supabase/pull/201).

This branch supplies shared client primitives and wires the list/store to the personal-hide RPC. It does not deploy the backend or establish that cross-device restoration passes acceptance. Both clients must ship the final feature together.

## Projection and merge

`ChatItem` carries the signed-in member's `conversation_hidden_at` and `conversation_visibility_revision`, plus its source seat's `source_conversation_hidden_at` and `source_conversation_visibility_revision` for a topic. These are personal projection fields; other members' hidden state must never enter membership views or broadcasts.

Import `mergeConversationVisibility`, `isConversationHidden`, `visibleConversationRows`, `isChatListed`, and `chatAttention` from `@gugu/core/shared/ui/chatModels`.

- Merge fetched rows with `mergeConversationVisibility(fetched, local)` before publishing or persisting them. Revisions are canonical unsigned decimal **strings**; the helper compares them exactly with `BigInt`, including values above 2^53. Own and source seats merge independently. An older hide cannot overwrite a newer restoration, and an older snapshot cannot undo a confirmed hide.
- Keep the complete directory for addressing, search, existing tabs, drafts, file links and receipts. Do not delete hidden rows from that directory. Opening/searching a hidden row does not restore it.
- Use `visibleConversationRows(fullDirectory)` for list and aggregate badge scope. A hidden source excludes its descendant topics without changing their individual hidden state or read cursors. A missing source or peer is not proof of a hide (#1892); missing projection data remains a separate diagnostic condition.
- Use `isChatListed` after scope filtering for the existing empty-DM rule. `chatAttention` preserves raw unread but returns zero list/global attention for an explicitly hidden row. Topic addressed-count and mute rules remain unchanged.
- `phoneChatUnread` now sums only visible scope. A visible source does not receive a hidden topic's badge. Restoration counts retained read positions, with each stream counted once by the existing unread projection.

## Long-press/right-click menu

Import `PersonalConversationRowMenu` from `apps/desktop/src/components/chat/PersonalConversationRowMenu`. Pass the chat, pointer coordinates, existing pin/notification callbacks, and an explicit asynchronous `onHide` callback. It needs the existing auth, chat, contacts and modal providers. Unlike the legacy wrapper, this menu never loads group administration permissions. Every chat kind supports personal removal.

Use `const { hideConversation } = useChatStore('hideConversation')`, then `onHide={() => hideConversation(chat.id)}`. Its signature is `(chatId: string) => Promise<void>`. Desktop and phone import the same store; neither needs a second hide implementation.

`store/useConversationHiding.ts` owns the action through `lib/conversationHider.ts`. `chatService.hideConversation(chatId, operationId)` delegates to `lib/hideListedConversation.ts`, which validates the echoed chat/operation IDs, timestamp and exact decimal revision. `store/chatListProjection.ts` calls the account-scoped `confirmPersonalHiding(accountId, receipt)` binding; `lib/chatProjection.ts` merges that receipt into the existing stamped membership cache and republishes the full directory. An older receipt cannot override a newer restoration. These internal bindings are shared implementation, not an extra phone-side API.

Concurrent submissions share one in-flight operation. A transport failure retains the operation UUID for an explicit retry; an acknowledged receipt is retained if reconciliation fails, so that retry performs reconciliation only. There is no automatic hide replay on app start. A later deliberate action after success receives a new UUID.

The `onHide` callback calls the personal-hide RPC with its stable operation ID and awaits reconciliation of the returned account revision. It must not call a group archive, remove membership, close the tab, discard a draft or stop an Agent. Retry an uncertain hide with the same operation UUID. The backend owns restoration ordering.

For another menu surface, `conversationCanHide` and the `personalHiding: true` row-menu state provide the same availability and label. `confirmHideConversation({ hide, ownedAgent? })` provides the shared confirmation and partial-failure handling. Offer `ownedAgent` only for a live Agent owned by this account in a DM/AI conversation; its `remove` callback deletes that Agent separately.

The Agent option is **unchecked by default**. Cancelling changes nothing. A failed hide does not delete the Agent. If hiding succeeds and Agent deletion fails, the hide stays committed and a separate persistent retry action is shown. That action only retries Agent deletion: it never hides a conversation again if a new message has restored it. An account-session change invalidates pending confirmation/deletion retries.

The existing `ChatRowContextMenu` delegates to the personal component and takes `onHide` with the same asynchronous signature. `ChatListPanel` now calls the shared store action. Group-wide archival remains a separate settings/contacts management action. The old archived-Agent-only menu rule and client permanent-DM delete RPC dispatch are removed; existing permanent tombstone projection remains for historical records. Agent deletion failure uses the notice action created by `confirmHideConversation`, which calls `removeOwnedAgent` only.

## Release acceptance still required

Use the same backend and both client heads. Hide on one client, verify the other consumes the same hidden revision, publish a new visible message, then verify both restore the row with correct unread. Include owner input, native Agent reply, mentions, system messages, topic/source restoration, mute, offline first delivery, duplicate publication and hide retries. History import/replay must not restore a row. Backend migration review and a scheduled staging deployment are required before claiming these chains pass.
