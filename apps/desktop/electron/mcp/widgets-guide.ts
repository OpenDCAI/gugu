export const WIDGETS_GUIDE = {
  topic: 'widgets',
  about: 'Send an installed App view inside a chat message: fixed height, immutable input, human callbacks and fallback.',
  text: `# App views in messages (API26)

Declare a normal tab with widget: { height: 240 } (integer 64–520). It still appears in the App's tabs; handle getContext() without widget there. A widget tab cannot also declare hostPage, perSession, opensFiles or chatFile.

Find an enabled App with app_search; widgetViews lists its declared views. Call widget_send { chat_id, app, view, text, data?, reply_to_message_id? }. text is 1–200 plain characters, used in previews, notifications, quotes and the task timeline. data must be a JSON object, serialized to at most 4096 UTF-8 bytes; the complete message is at most 6144. Errors report byte sizes. There are no recipients and sending does not wake agents. Group rules and the session's thread still apply.

The v2 content is { v: 2, text, app, view, data? }. Never put id or title at the top level. Extra v2 keys are ignored by readers. getContext().widget gives { messageId, data, sender }; sender identifies the message's author. Any chat member can supply data: treat every value as untrusted, never insert it as HTML or execute it. Initial data is immutable. Persist personal state in App data; shared state belongs in the chat's files. Pages outside the viewport may be destroyed and recreated.

Use existing callbacks from a human click: dispatch(text,{ draft:true,to:{chat:ctx.chat.id} }) drafts; the person presses Send. dispatch(text,{to:{chat,member},visible:true}) needs chat:relay; {to:{agent}} needs agents:control. ALL dispatch calls in a widget require a live human gesture, including explicit targets. On-load dispatch is refused. No new permissions are granted by a message.

callProgram runs on the viewing person's desktop. On a phone, a call without an explicit device is refused; show its error in the App. This version adds no machine routing. Retain the host's description line for right-click and phone long-press menus.

Missing or switched-off Apps show text and a reason. A missing market App offers Install through the normal consent flow; nothing is installed automatically. A local-only App has no market install button: distribute its App bundle first. Older clients show [Widget]; backend upgrades provide readable text previews.

No pinning, updating a widget message, shared instance, machine field, or task-timeline embedded page is part of this interface.
`,
} as const
