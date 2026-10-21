// #7199 「入会提醒」开关(默认开):记在这台电脑上 —— 提醒读的就是这台电脑的日历。
// 壳(提醒卡)与会话页(助理的设置页)是同一个 document 里的两个 bundle,localStorage 是两边共读的那一份;改了发一个 window 事件。

const KEY = 'gugu.voiceNotes.meetingReminder'
export const MEETING_REMINDER_PREF_EVENT = 'gugu:meeting-reminder-pref'

export function meetingReminderEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setMeetingReminderEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // 记不住就照默认(开着)。
  }
  window.dispatchEvent(new Event(MEETING_REMINDER_PREF_EVENT))
}

export function subscribeMeetingReminderPref(listener: () => void): () => void {
  window.addEventListener(MEETING_REMINDER_PREF_EVENT, listener)
  return () => window.removeEventListener(MEETING_REMINDER_PREF_EVENT, listener)
}
