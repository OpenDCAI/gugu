import type { ToolEffect, ToolRisk } from './rules'

/** Reviewed names, not prefix heuristics. Inventory tests compare with the real registrars/families. */
function entries(effect: ToolEffect, risk: ToolRisk['risk'], names: string): Record<string, ToolRisk> {
  return Object.fromEntries(names.split(/\s+/).filter(Boolean).map(name => [name, { effect, risk }]))
}
export const CORE_TOOL_RISKS: Readonly<Record<string, ToolRisk>> = {
  ...entries('discovery', 'low', `app_search catalog_describe catalog_list device_actions guide_read guide_topics
    session_list_harnesses session_list_models`),
  ...entries('read', 'medium', `activity_chat_list activity_context activity_list library_list library_read
    message_conversations message_download_file message_history message_invitations message_search owner_friends_list
    project_list schedule_list session_children session_get session_list_tabs session_peers group_join_requests
    profile_lookup profile_whoami session_devices message_members message_rules topic_list topic_members group_info group_list`),
  ...entries('write', 'medium', `library_write profile_update project_create schedule_cancel schedule_create
    session_close_tab session_open_in_tab session_set_parent session_stop group_avatar_set group_leave
    group_announcement_delete group_announcement_post group_announcement_update topic_delete`),
  ...entries('send', 'medium', `message_send message_send_file session_message widget_send session_ask_user`),
  ...entries('execute', 'high', `app_check app_create app_pack session_spawn`),
  ...entries('owner', 'high', `message_send_as_owner message_send_file_as_owner`),
  ...entries('social', 'high', `contact_friend message_invite topic_invite topic_open group_create group_add_agent group_join_decide project_get`),
  ...entries('permission', 'high', `app_install app_manage group_remove_member group_set_role group_update
    project_add_folder project_remove_folder project_add_device project_remove_device project_restore_device session_archive`),
  ...entries('send', 'medium', 'web_search'),
  // Wrappers are expanded before evaluation. Their own entries do not confer permission on the payload.
  ...entries('execute', 'high', 'catalog_call device_call'),
}

export const DEVICE_ACTION_RISKS: Readonly<Record<string, ToolRisk>> = {
  ...entries('read', 'medium', `battery.get calendar.calendars.get calendar.events.get calendar.events.list calendar.list
    calendar.sources.list calendar.status clipboard.read computer.get_accessibility_tree computer.get_cursor_position
    computer.get_desktop_state computer.get_screen_size computer.get_window_state computer.list_apps computer.list_windows
    computer.verify_state computer.zoom contacts.get contacts.list contacts.me fs.find fs.grep fs.list fs.ocr fs.read fs.stat
    fs.volumes.list imessage.chats.list imessage.conversation.get imessage.search imessage.unread location.get
    mail.accounts.list mail.mailboxes.list mail.messages.find mail.messages.get mail.messages.contentPreview.get mail.messages.list
    notes.folders.list notes.get notes.list reminders.get reminders.list reminders.lists.get reminders.sources.list
    reminders.status screen.elements.find screen.get sdef.get shortcuts.list system.apps.list system.get system.shell.get
    system.user.get system.users.list`),
  ...entries('write', 'medium', `calendar.calendars.create calendar.calendars.delete calendar.calendars.update
    calendar.events.create calendar.events.delete calendar.events.update clipboard.write contacts.delete contacts.update
    fs.copy fs.mkdir fs.move fs.patch fs.tags fs.tags_registry fs.trash fs.write fs.xattr
    mail.messages.delete mail.messages.mark mail.messages.move notes.create notes.delete notes.update notification.show
    reminders.complete reminders.create reminders.delete reminders.lists reminders.lists.create reminders.lists.delete
    reminders.lists.update reminders.update url.open`),
  ...entries('send', 'medium', 'calendar.events.export contacts.export location.geocode'),
  ...entries('owner', 'high', 'imessage.send imessage.send_file mail.forward mail.reply mail.send'),
  ...entries('social', 'high', 'contacts.create'),
  ...entries('execute', 'high', `script.jxa script.shell shortcuts.run computer.bring_to_front computer.click computer.double_click
    computer.drag computer.hotkey computer.invoke_menu computer.kill_app computer.launch_app computer.move_cursor
    computer.press_key computer.right_click computer.run_steps computer.scroll computer.set_value computer.set_window_frame computer.type_text`),
}
