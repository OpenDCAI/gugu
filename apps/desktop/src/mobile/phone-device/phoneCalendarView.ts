import type { NativeCalendarEvent } from './nativePhoneActions'
import { localIso } from './phoneTime'

/** Model-facing calendar values, shared by remote device actions and the embedded Pi SDK. */
export function phoneCalendarEventView(event: NativeCalendarEvent) {
  const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return {
    event_id: event.event_id,
    title: event.title,
    ...(event.all_day
      ? { all_day: true, start_date: utcDate(event.start_ms), end_date: utcDate(event.end_ms) }
      : { all_day: false, start: localIso(event.start_ms), end: localIso(event.end_ms) }),
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    calendar: event.calendar,
  }
}
