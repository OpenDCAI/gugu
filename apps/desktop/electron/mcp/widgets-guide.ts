import { WIDGET_HEIGHT_MIN, WIDGET_HEIGHT_MAX } from '@gugu/core/shared/ui/widgetModels'

export const WIDGETS_GUIDE = {
  topic: 'widgets',
  about: 'Send an installed App view inside a chat message: static message height, immutable input, human callbacks and fallback.',
  text: `# App views in messages (API26)

Declare a normal tab with widget: { height: 240 } (integer ${WIDGET_HEIGHT_MIN}–${WIDGET_HEIGHT_MAX}) as its default height. It still appears in the App's tabs; handle getContext() without widget there. A widget tab cannot also declare hostPage, perSession, opensFiles or chatFile.

Find an enabled App with app_search; widgetViews lists its declared views and default heights. Call widget_send { chat_id, app, view, text, height?, data?, reply_to_message_id? }. Optional height (integer ${WIDGET_HEIGHT_MIN}–${WIDGET_HEIGHT_MAX}) sets this message's immutable height instead of the manifest default. text is 1–200 plain characters, used in previews, notifications, quotes and the task timeline. data must be a JSON object, serialized to at most 4096 UTF-8 bytes; the complete message is at most 6144. Errors report byte sizes. There are no recipients and sending does not wake agents. Group rules and the session's thread still apply.

The v2 content is { v: 2, text, app, view, height?, data? }. Never put id or title at the top level. Extra v2 keys are ignored by readers. Older readers ignore height and use the manifest default. getContext().widget gives { messageId, data, sender }; sender identifies the message's author. Any chat member can supply data: treat every value as untrusted, never insert it as HTML or execute it. Initial data is immutable. Persist personal state in App data; shared state belongs in the chat's files. Pages outside the viewport may be destroyed and recreated.

Check an existing card with app_check { message_id: "msg:…" }; widget_id is the legacy message-id alias, not a separate index. It is exclusive with item_id/chat_id/file_path. The host reads the message as you, infers tab_kind (an explicit one must match), and binds its original widget data and sender before loading. The hidden page has the desktop card's 420px width and the message's height (else the manifest default); phone:true uses the actual bubble slot at a 412px phone viewport with touch. It reports widget id/message/chat, installed app_version, size, locale/theme and original text. Other machines may run another version or lack the App. Unavailable cards return rendered:false, reason and text without opening a page. Pictures default on; look:false omits them. Errors from this check and historical real-page errors are labelled separately.

Use steps to click/tap a button or fill a control by the returned snapshot; continue with page, tab_kind and steps. These operations and shared-file writes are real and attributed to the calling agent (ctx.operator), never the human viewer or message sender. Draft/display handoffs return shown to you and leave the human composer alone. Deduplicate votes by the operator id, not widget.sender, and label agent votes as such. The hidden check does not claim visible-widget presence or a resident snapshot.

On desktop and phones, use existing callbacks from a human click: dispatch(text,{ draft:true,to:{chat:ctx.chat.id} }) drafts; the person presses Send. dispatch(text,{to:{chat,member},visible:true}) needs chat:relay; {to:{agent}} needs agents:control. ALL dispatch calls in a widget require a live gesture in that App, including explicit targets. On-load dispatch is refused. Cloud and file calls retain their ordinary permission and gesture checks. Normal App pages keep their existing behavior. No new permissions are granted by a message.

callProgram runs on the viewing person's desktop. On a phone, a call without an explicit device is refused; show its error in the App. This version adds no machine routing. Retain the host's description line for right-click and phone long-press menus.

Missing or switched-off Apps show text and a reason. A missing market App offers Install through the normal consent flow; nothing is installed automatically. A local-only App has no market install button: distribute its App bundle first. Older clients show [Widget]; backend upgrades provide readable text previews.

No pinning, updating a widget message, shared instance, machine field, or task-timeline embedded page is part of this interface.
`,
} as const
