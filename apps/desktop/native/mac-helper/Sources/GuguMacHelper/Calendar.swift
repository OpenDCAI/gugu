// 日历(EventKit)—— calendar.* 13 个,见 families/calendar.ts。
// 日历与提醒列表在 EventKit 里是同一种东西(EKCalendar),「容器 / 账户来源 / 授权状态 / 重复规则」的通用部分写在这里,
// Reminders.swift 复用。确认(撞时间、删除前问一句)由 families/*.ts 先读后问,这里只做事;删除另要 confirmed: true 兜底。
import CoreGraphics
import EventKit
import Foundation

// MARK: - 两边共用:容器(日历 / 提醒列表)、账户来源、授权状态

func ekStore() -> EKEventStore { EventStoreBox.shared.store }

func ekNoun(_ type: EKEntityType) -> String { type == .event ? "calendar" : "reminder list" }

func sourceTypeName(_ t: EKSourceType) -> String {
    switch t {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "mobileme"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "unknown"
    }
}

func calendarTypeName(_ t: EKCalendarType) -> String {
    switch t {
    case .local: return "local"
    case .calDAV: return "caldav"
    case .exchange: return "exchange"
    case .subscription: return "subscription"
    case .birthday: return "birthday"
    @unknown default: return "unknown"
    }
}

func hexColor(_ color: CGColor?) -> String? {
    guard let color, let srgb = CGColorSpace(name: CGColorSpace.sRGB),
          let c = color.converted(to: srgb, intent: .defaultIntent, options: nil),
          let comps = c.components, comps.count >= 3 else { return nil }
    let v = comps.prefix(3).map { min(255, max(0, Int(($0 * 255).rounded()))) }
    return String(format: "#%02X%02X%02X", v[0], v[1], v[2])
}

func parseHexColor(_ text: String) throws -> CGColor {
    var s = text.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { throw HelperError.invalid("color must be a hex color like #FF9500, got \(text)") }
    return CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}

func defaultContainer(_ type: EKEntityType) -> EKCalendar? {
    type == .event ? ekStore().defaultCalendarForNewEvents : ekStore().defaultCalendarForNewReminders()
}

func sourceRow(_ s: EKSource) -> [String: Any] {
    ["id": s.sourceIdentifier, "name": s.title, "type": sourceTypeName(s.sourceType)]
}

func containerRow(_ cal: EKCalendar, _ type: EKEntityType) -> [String: Any] {
    var row: [String: Any] = [
        "id": cal.calendarIdentifier,
        "name": cal.title,
        "color": hexColor(cal.cgColor) ?? NSNull(),
        "type": calendarTypeName(cal.type),
        "writable": cal.allowsContentModifications,
        "is_default": cal.calendarIdentifier == defaultContainer(type)?.calendarIdentifier,
        "immutable": cal.isImmutable,
        "subscribed": cal.isSubscribed,
    ]
    if let source = cal.source { row["source"] = sourceRow(source) }
    return row
}

func containers(_ type: EKEntityType, writableOnly: Bool, sourceId: String?) -> [EKCalendar] {
    ekStore().calendars(for: type)
        .filter { (!writableOnly || $0.allowsContentModifications) && (sourceId == nil || $0.source?.sourceIdentifier == sourceId) }
        .sorted { ($0.source?.title ?? "", $0.title) < ($1.source?.title ?? "", $1.title) }
}

/// 只认确切 id(改 / 删容器;❌ 按名字猜 —— 同名的日历在不同账户里很常见)。
func containerById(_ type: EKEntityType, _ id: String) throws -> EKCalendar {
    if let cal = ekStore().calendars(for: type).first(where: { $0.calendarIdentifier == id }) { return cal }
    let lister = type == .event ? "calendar.list" : "reminders.lists"
    throw HelperError.invalid("No \(ekNoun(type)) with id \(id) on this Mac. Get ids from \(lister).")
}

/// 名字或 id 都认(建 / 改条目时选目标):同名有多个就让 agent 改用 id。
func resolveContainer(_ type: EKEntityType, _ key: String, writable: Bool) throws -> EKCalendar {
    let all = ekStore().calendars(for: type)
    if let byId = all.first(where: { $0.calendarIdentifier == key }) {
        if writable && !byId.allowsContentModifications { throw HelperError.invalid("The \(ekNoun(type)) \"\(byId.title)\" is read-only; pick a writable one.") }
        return byId
    }
    let named = all.filter { $0.title.compare(key, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
    let usable = writable ? named.filter { $0.allowsContentModifications } : named
    if usable.count == 1 { return usable[0] }
    if usable.count > 1 {
        let ids = usable.map { "\($0.calendarIdentifier) (\($0.source?.title ?? "?"))" }.joined(separator: ", ")
        throw HelperError.invalid("Several \(ekNoun(type))s are named \"\(key)\": \(ids). Pass the id instead.")
    }
    if !named.isEmpty { throw HelperError.invalid("The \(ekNoun(type)) \"\(key)\" is read-only; pick a writable one.") }
    let names = all.filter { !writable || $0.allowsContentModifications }.map { $0.title }.prefix(30).joined(separator: ", ")
    throw HelperError.invalid("No \(ekNoun(type)) named \"\(key)\" on this Mac. Available: \(names)")
}

func sourcesList(_ type: EKEntityType) -> [[String: Any]] {
    ekStore().sources.map { s in
        var row = sourceRow(s)
        row["container_ids"] = s.calendars(for: type).map { $0.calendarIdentifier }.sorted()
        row["is_delegate"] = s.isDelegate
        return row
    }.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
}

/// 读授权,❌ 弹窗(没授权也能调)。
func ekStatus(_ type: EKEntityType) -> [String: Any] {
    let status = eventStatus(type)
    var row: [String: Any] = [
        "authorization": status,
        "full_access": status == "granted",
        "timezone": TimeZone.current.identifier,
        "os_version": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
    if status == "granted" {
        row["containers"] = ekStore().calendars(for: type).count
        if let def = defaultContainer(type) { row["default"] = ["id": def.calendarIdentifier, "name": def.title] }
    } else {
        row["hint"] = status == "not_determined"
            ? "Not asked yet: the person connects this group in 咕咕 → Settings → Devices on this computer (macOS asks once)."
            : "Turn on 咕咕 in System Settings → Privacy & Security → \(type == .event ? "Calendars" : "Reminders") (Full Access)."
    }
    return row
}

func createContainer(_ type: EKEntityType, _ p: Params) throws -> [String: Any] {
    let name = try p.requireString("name")
    let store = ekStore()
    let cal = EKCalendar(for: type, eventStore: store)
    cal.title = name
    if let color = p.string("color") { cal.cgColor = try parseHexColor(color) }
    let source: EKSource
    if let sourceId = p.string("source_id") {
        guard let s = store.sources.first(where: { $0.sourceIdentifier == sourceId }) else {
            throw HelperError.invalid("No account source with id \(sourceId). Get ids from \(type == .event ? "calendar" : "reminders").sources.list.")
        }
        source = s
    } else if let s = defaultContainer(type)?.source ?? store.sources.first(where: { $0.sourceType == .local }) {
        source = s
    } else {
        throw HelperError.invalid("No default account to put the new \(ekNoun(type)) in; pass source_id from \(type == .event ? "calendar" : "reminders").sources.list.")
    }
    cal.source = source
    do {
        try store.saveCalendar(cal, commit: true)
    } catch {
        throw HelperError.failed("The account \"\(source.title)\" did not accept a new \(ekNoun(type)): \(error.localizedDescription). Try another source_id.")
    }
    return containerRow(cal, type)
}

func updateContainer(_ type: EKEntityType, _ p: Params, idKey: String) throws -> [String: Any] {
    let cal = try containerById(type, try p.requireString(idKey))
    let name = p.string("name")
    let color = p.string("color")
    if name == nil && color == nil { throw HelperError.invalid("Pass name and/or color to change.") }
    if cal.isImmutable || cal.isSubscribed { throw HelperError.invalid("The \(ekNoun(type)) \"\(cal.title)\" cannot be changed (system or subscribed).") }
    if let name { cal.title = name }
    if let color { cal.cgColor = try parseHexColor(color) }
    do {
        try ekStore().saveCalendar(cal, commit: true)
    } catch {
        throw HelperError.failed("Could not change \"\(cal.title)\": \(error.localizedDescription)")
    }
    return containerRow(cal, type)
}

func deleteContainer(_ type: EKEntityType, _ p: Params, idKey: String) throws -> [String: Any] {
    let cal = try containerById(type, try p.requireString(idKey))
    // 兜底:确认在 families/*.ts 里先问过;没带 confirmed 一律不删。
    guard p.bool("confirmed") == true else { throw HelperError.confirm("要删除「\(cal.title)」及其中的全部内容吗？", details: ["container": containerRow(cal, type)]) }
    if cal.isImmutable { throw HelperError.invalid("\"\(cal.title)\" is a system \(ekNoun(type)) and cannot be deleted.") }
    let row = containerRow(cal, type)
    do {
        try ekStore().removeCalendar(cal, commit: true)
    } catch {
        throw HelperError.failed("Could not delete \"\(cal.title)\": \(error.localizedDescription)")
    }
    return ["deleted": true, "container": row]
}

// MARK: - 重复规则(两边共用):RRULE 文本 ⇄ EKRecurrenceRule

private let weekdayCodes: [(String, EKWeekday)] = [("SU", .sunday), ("MO", .monday), ("TU", .tuesday), ("WE", .wednesday), ("TH", .thursday), ("FR", .friday), ("SA", .saturday)]

func icsUTC(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return f.string(from: date)
}

func icsDay(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyyMMdd"
    return f.string(from: date)
}

/// RFC 5545 的 RRULE 值(不带 "RRULE:")。dateOnly:全天事件的 UNTIL 写成日期。
func rruleText(_ r: EKRecurrenceRule, dateOnly: Bool) -> String {
    let freq: String
    switch r.frequency {
    case .daily: freq = "DAILY"
    case .weekly: freq = "WEEKLY"
    case .monthly: freq = "MONTHLY"
    case .yearly: freq = "YEARLY"
    @unknown default: freq = "DAILY"
    }
    var parts = ["FREQ=\(freq)"]
    if r.interval > 1 { parts.append("INTERVAL=\(r.interval)") }
    if let end = r.recurrenceEnd {
        if let until = end.endDate { parts.append("UNTIL=" + (dateOnly ? icsDay(until) : icsUTC(until))) }
        else if end.occurrenceCount > 0 { parts.append("COUNT=\(end.occurrenceCount)") }
    }
    if let days = r.daysOfTheWeek, !days.isEmpty {
        let codes = days.map { d -> String in
            let code = weekdayCodes.first { $0.1 == d.dayOfTheWeek }?.0 ?? "MO"
            return d.weekNumber != 0 ? "\(d.weekNumber)\(code)" : code
        }
        parts.append("BYDAY=" + codes.joined(separator: ","))
    }
    let list = { (key: String, values: [NSNumber]?) in
        if let values, !values.isEmpty { parts.append("\(key)=" + values.map { $0.stringValue }.joined(separator: ",")) }
    }
    list("BYMONTHDAY", r.daysOfTheMonth)
    list("BYMONTH", r.monthsOfTheYear)
    list("BYWEEKNO", r.weeksOfTheYear)
    list("BYYEARDAY", r.daysOfTheYear)
    list("BYSETPOS", r.setPositions)
    // WKST 缺省就是周一(RFC 5545);EventKit 按地区总会填一个,只在不是周一时写出来。
    if r.firstDayOfTheWeek > 0, let code = weekdayCodes.first(where: { $0.1.rawValue == r.firstDayOfTheWeek })?.0, code != "MO" { parts.append("WKST=\(code)") }
    return parts.joined(separator: ";")
}

/// 参数里的 recurrence:{frequency, interval?, days_of_week?, until?, count?};frequency = "none" 回 nil(= 去掉重复)。
func recurrenceRule(_ o: [String: Any]) throws -> EKRecurrenceRule? {
    guard let f = o["frequency"] as? String else { throw HelperError.invalid("recurrence.frequency is required (daily / weekly / monthly / yearly, or none to remove)") }
    let freq: EKRecurrenceFrequency
    switch f {
    case "daily": freq = .daily
    case "weekly": freq = .weekly
    case "monthly": freq = .monthly
    case "yearly": freq = .yearly
    case "none": return nil
    default: throw HelperError.invalid("recurrence.frequency must be daily / weekly / monthly / yearly / none, got \(f)")
    }
    let interval = (o["interval"] as? Int) ?? 1
    guard (1...999).contains(interval) else { throw HelperError.invalid("recurrence.interval must be 1–999") }
    var end: EKRecurrenceEnd? = nil
    if let until = o["until"] as? String, !until.isEmpty {
        guard var date = parseDate(until) else { throw HelperError.invalid("recurrence.until must be an ISO 8601 date, got \(until)") }
        // 只给日期 = 那天也算在内。
        if until.count == 10 { date = Calendar.current.date(byAdding: DateComponents(day: 1, second: -1), to: date) ?? date }
        end = EKRecurrenceEnd(end: date)
    } else if let count = o["count"] as? Int {
        guard count >= 1 else { throw HelperError.invalid("recurrence.count must be ≥ 1") }
        end = EKRecurrenceEnd(occurrenceCount: count)
    }
    var days: [EKRecurrenceDayOfWeek]? = nil
    if let codes = o["days_of_week"] as? [String], !codes.isEmpty {
        days = try codes.map { code in
            guard let day = weekdayCodes.first(where: { $0.0 == code.uppercased() })?.1 else { throw HelperError.invalid("recurrence.days_of_week takes MO TU WE TH FR SA SU, got \(code)") }
            return EKRecurrenceDayOfWeek(day)
        }
    }
    return EKRecurrenceRule(recurrenceWith: freq, interval: interval, daysOfTheWeek: days, daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end)
}

func capText(_ text: String?, _ limit: Int) -> (String, Bool)? {
    guard let text, !text.isEmpty else { return nil }
    return text.count > limit ? (String(text.prefix(limit)), true) : (text, false)
}

// MARK: - 日程

private func participantStatus(_ s: EKParticipantStatus) -> String {
    switch s {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending: return "pending"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in_process"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
}

private func participantEmail(_ p: EKParticipant) -> String? {
    let text = p.url.absoluteString
    return text.lowercased().hasPrefix("mailto:") ? String(text.dropFirst(7)) : nil
}

private func participantName(_ p: EKParticipant) -> String {
    if let name = p.name, !name.isEmpty { return name }
    return participantEmail(p) ?? p.url.absoluteString
}

private func isRecurring(_ e: EKEvent) -> Bool { e.hasRecurrenceRules || e.isDetached }

/// 重复日程的某一次:「calendarItemIdentifier@那次的开始时间」;不重复的就是 calendarItemIdentifier。
func eventId(_ e: EKEvent) -> String {
    let base = e.calendarItemIdentifier
    if isRecurring(e), let start = isoLocal(e.startDate) { return "\(base)@\(start)" }
    return base
}

func resolveEvent(_ id: String) throws -> EKEvent {
    let store = ekStore()
    if let at = id.lastIndex(of: "@"), let when = parseDate(String(id[id.index(after: at)...])) {
        let base = String(id[..<at])
        let around = store.predicateForEvents(withStart: when.addingTimeInterval(-2 * 86_400), end: when.addingTimeInterval(2 * 86_400), calendars: nil)
        let matches = store.events(matching: around).filter { $0.calendarItemIdentifier == base }
        let same = { (d: Date?) in d.map { abs($0.timeIntervalSince(when)) < 1 } ?? false }
        if let e = matches.first(where: { same($0.startDate) }) ?? matches.first(where: { same($0.occurrenceDate) }) { return e }
        throw HelperError.invalid("No occurrence \(id) on this Mac any more (deleted or moved). Find it again with calendar.events.list.")
    }
    if let e = store.calendarItem(withIdentifier: id) as? EKEvent { return e }
    if let e = store.event(withIdentifier: id) { return e }
    throw HelperError.invalid("No event with event_id \(id) on this Mac (deleted, or not an event id). Find it with calendar.events.list.")
}

func eventRow(_ e: EKEvent, detail: Bool) -> [String: Any] {
    let allDay = e.isAllDay
    let when = { (d: Date?) -> Any in (allDay ? isoDay(d) : isoLocal(d)) ?? NSNull() }
    var row: [String: Any] = [
        "event_id": eventId(e),
        "title": e.title ?? "",
        "start": when(e.startDate),
        "end": when(e.endDate),
        "all_day": allDay,
        "calendar": e.calendar?.title ?? "",
        "calendar_id": e.calendar?.calendarIdentifier ?? "",
        "recurring": isRecurring(e),
    ]
    if let location = e.location, !location.isEmpty { row["location"] = location }
    if let notes = capText(e.notes, detail ? 2000 : 300) {
        row["notes"] = notes.0
        if notes.1 { row["notes_truncated"] = true }
    }
    if let url = e.url { row["url"] = url.absoluteString }
    switch e.availability {
    case .free: row["availability"] = "free"
    case .tentative: row["availability"] = "tentative"
    case .unavailable: row["availability"] = "unavailable"
    default: break
    }
    if e.status == .canceled { row["status"] = "canceled" }
    if let organizer = e.organizer { row["organizer"] = participantName(organizer) }
    if let attendees = e.attendees, !attendees.isEmpty {
        row["attendee_count"] = attendees.count
        if let me = attendees.first(where: { $0.isCurrentUser }) { row["my_status"] = participantStatus(me.participantStatus) }
        if detail {
            row["attendees"] = attendees.prefix(20).map { a -> [String: Any] in
                var r: [String: Any] = ["name": participantName(a), "status": participantStatus(a.participantStatus)]
                if let email = participantEmail(a) { r["email"] = email }
                if a.isCurrentUser { r["is_me"] = true }
                return r
            }
        }
    }
    if detail {
        if let rule = e.recurrenceRules?.first { row["recurrence"] = rruleText(rule, dateOnly: allDay) }
        if e.isDetached { row["detached"] = true }
        let alarms = (e.alarms ?? []).compactMap { a -> Any? in
            if let abs = a.absoluteDate { return ["at": isoLocal(abs) ?? ""] }
            return ["minutes_before": Int((-a.relativeOffset / 60).rounded())]
        }
        if !alarms.isEmpty { row["alarms"] = alarms }
        if let tz = e.timeZone { row["time_zone"] = tz.identifier }
        if let uid = e.calendarItemExternalIdentifier, !uid.isEmpty { row["external_id"] = uid }
        if let modified = e.lastModifiedDate { row["modified"] = isoLocal(modified) ?? NSNull() }
    }
    return row
}

/// 日程的时间窗:只给日期的 end = 那一整天都算。缺省 = 今天 0 点起 14 天;只给 end = 它之前 14 天。
private func eventWindow(_ p: Params) throws -> (Date, Date) {
    var givenEnd = try p.date("end")
    if let text = p.string("end"), text.count == 10, let d = givenEnd { givenEnd = Calendar.current.date(byAdding: .day, value: 1, to: d) }
    let start = try p.date("start") ?? givenEnd.map { $0.addingTimeInterval(-14 * 86_400) } ?? Calendar.current.startOfDay(for: Date())
    let end = givenEnd ?? start.addingTimeInterval(14 * 86_400)
    guard end > start else { throw HelperError.invalid("end must be after start") }
    guard end.timeIntervalSince(start) <= 3660 * 86_400 else { throw HelperError.invalid("The time window is limited to about 10 years; narrow start/end.") }
    return (start, end)
}

private func eventCalendars(_ p: Params) throws -> [EKCalendar]? {
    var picked: [EKCalendar] = []
    if let key = p.string("calendar") { picked.append(try resolveContainer(.event, key, writable: false)) }
    for id in p.strings("calendar_ids") ?? [] { picked.append(try containerById(.event, id)) }
    return picked.isEmpty ? nil : picked
}

/// EventKit 一次只查得动约 4 年:按年切窗,重复日程逐次展开,按「哪一次」去重。
private func fetchEvents(_ start: Date, _ end: Date, _ calendars: [EKCalendar]?) throws -> [EKEvent] {
    let store = ekStore()
    var seen = Set<String>()
    var out: [EKEvent] = []
    var from = start
    while from < end {
        let to = min(end, from.addingTimeInterval(365 * 86_400))
        for e in store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars)) {
            let key = "\(e.calendar?.calendarIdentifier ?? "")|\(eventId(e))"
            if seen.insert(key).inserted { out.append(e) }
            if out.count > 50_000 { throw HelperError.invalid("More than 50000 events in that window; narrow start/end or pick a calendar.") }
        }
        from = to
    }
    return out
}

private func matchesQuery(_ e: EKEvent, _ query: String?) -> Bool {
    guard let query else { return true }
    return [e.title, e.location, e.notes].contains { ($0 ?? "").range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
}

private func isDeclined(_ e: EKEvent) -> Bool {
    e.attendees?.first(where: { $0.isCurrentUser })?.participantStatus == .declined
}

private func writableEventCalendar(_ p: Params) throws -> EKCalendar {
    if let key = p.string("calendar") { return try resolveContainer(.event, key, writable: true) }
    if let def = ekStore().defaultCalendarForNewEvents, def.allowsContentModifications { return def }
    if let first = containers(.event, writableOnly: true, sourceId: nil).first { return first }
    throw HelperError.failed("This Mac's Calendar has no writable calendar.")
}

private func alarmList(_ p: Params) throws -> [EKAlarm]? {
    guard let raw = p.raw["alarms_minutes_before"] else { return nil }
    guard let list = raw as? [Any] else { throw HelperError.invalid("alarms_minutes_before must be an array of minutes") }
    guard list.count <= 10 else { throw HelperError.invalid("At most 10 alarms") }
    return try list.map { item in
        guard let n = (item as? NSNumber)?.doubleValue, n.isFinite else { throw HelperError.invalid("alarms_minutes_before must contain numbers") }
        return EKAlarm(relativeOffset: -n * 60)
    }
}

/// 建 / 改共用:把参数里给了的字段写到日程上。回改了哪几项。
private func applyEventFields(_ e: EKEvent, _ p: Params, creating: Bool) throws -> [String] {
    var changed: [String] = []
    if let title = p.string("title") { e.title = title; changed.append("title") }
    let allDay = p.bool("all_day")
    let wasAllDay = e.isAllDay
    let newStart = try p.date("start")
    let newEnd = try p.date("end")
    if allDay == false && wasAllDay && !creating && newStart == nil {
        throw HelperError.invalid("To turn an all-day event into a timed one, also pass start (and end).")
    }
    if let allDay { e.isAllDay = allDay; changed.append("all_day") }
    if creating || newStart != nil || newEnd != nil || allDay != nil {
        let isAllDay = e.isAllDay
        let oldStart: Date? = e.startDate
        let oldEnd: Date? = e.endDate
        var start = newStart ?? oldStart ?? Date()
        var end: Date
        if let newEnd {
            end = newEnd
        } else if creating {
            end = isAllDay ? start : start.addingTimeInterval(3600)
        } else if newStart != nil, let oldStart, let oldEnd {
            // 只改开始:时长不变。
            end = start.addingTimeInterval(oldEnd.timeIntervalSince(oldStart))
        } else {
            end = oldEnd ?? start.addingTimeInterval(3600)
        }
        if isAllDay {
            // 全天:end 是最后一天(含);同一天 = 一天的全天日程。
            start = Calendar.current.startOfDay(for: start)
            end = Calendar.current.startOfDay(for: end)
            if end < start { throw HelperError.invalid("end must not be before start") }
        } else if end <= start {
            throw HelperError.invalid("end must be after start")
        }
        e.startDate = start
        e.endDate = end
        if newStart != nil { changed.append("start") }
        if newEnd != nil { changed.append("end") }
    }
    if p.raw["location"] != nil { e.location = p.string("location"); changed.append("location") }
    if p.raw["notes"] != nil { e.notes = (p.raw["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 }; changed.append("notes") }
    if p.raw["url"] != nil {
        if let text = p.string("url") {
            guard let url = URL(string: text), url.scheme != nil else { throw HelperError.invalid("url must be an absolute URL, got \(text)") }
            e.url = url
        } else {
            e.url = nil
        }
        changed.append("url")
    }
    if let alarms = try alarmList(p) {
        for old in e.alarms ?? [] { e.removeAlarm(old) }
        for a in alarms { e.addAlarm(a) }
        changed.append("alarms")
    }
    if let o = p.object("recurrence") {
        let rule = try recurrenceRule(o)
        for old in e.recurrenceRules ?? [] { e.removeRecurrenceRule(old) }
        if let rule { e.addRecurrenceRule(rule) }
        changed.append("recurrence")
    }
    return changed
}

private func span(_ p: Params, for e: EKEvent) throws -> EKSpan {
    switch p.string("span") {
    case nil:
        if isRecurring(e) { throw HelperError.invalid("\"\(e.title ?? "")\" is a recurring event: pass span \"this\" (only this occurrence) or \"future\" (this and all later ones).") }
        return .thisEvent
    case "this": return .thisEvent
    case "future": return .futureEvents
    case let other?: throw HelperError.invalid("span must be \"this\" or \"future\", got \(other)")
    }
}

// MARK: - ICS 导出

private func icsEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: ";", with: "\\;")
        .replacingOccurrences(of: ",", with: "\\,")
        .replacingOccurrences(of: "\r\n", with: "\\n")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\n")
}

/// 一行最多 75 个字节,续行以空格开头;❌ 把一个 UTF-8 字符切成两半。
private func icsFold(_ line: String) -> String {
    var lines: [String] = []
    var current = ""
    var bytes = 0
    for ch in line {
        let n = String(ch).utf8.count
        if bytes + n > (lines.isEmpty ? 75 : 74) {
            lines.append(current)
            current = ""
            bytes = 0
        }
        current.append(ch)
        bytes += n
    }
    lines.append(current)
    return lines.enumerated().map { $0.offset == 0 ? $0.element : " " + $0.element }.joined(separator: "\r\n")
}

private func icsDuration(minutes: Int) -> String {
    minutes >= 0 ? "-PT\(minutes)M" : "PT\(-minutes)M"
}

private func vevent(_ e: EKEvent, series: Bool, stamp: String) -> [String] {
    let allDay = e.isAllDay
    let base = (e.calendarItemExternalIdentifier?.isEmpty == false ? e.calendarItemExternalIdentifier! : e.calendarItemIdentifier)
    // 单拿重复日程的某一次 = 另一条独立日程,换一个 UID(❌ 冒充原系列)。
    let uid = (isRecurring(e) && !series) ? "\(base)-\(icsUTC(e.startDate))" : base
    var lines = ["BEGIN:VEVENT", "UID:\(icsEscape(uid))", "DTSTAMP:\(stamp)"]
    if allDay {
        let lastDay = Calendar.current.startOfDay(for: e.endDate ?? e.startDate)
        let endExclusive = Calendar.current.date(byAdding: .day, value: 1, to: lastDay) ?? lastDay
        lines.append("DTSTART;VALUE=DATE:\(icsDay(e.startDate))")
        lines.append("DTEND;VALUE=DATE:\(icsDay(endExclusive))")
    } else {
        lines.append("DTSTART:\(icsUTC(e.startDate))")
        lines.append("DTEND:\(icsUTC(e.endDate ?? e.startDate))")
    }
    lines.append("SUMMARY:\(icsEscape(e.title ?? ""))")
    if let location = e.location, !location.isEmpty { lines.append("LOCATION:\(icsEscape(location))") }
    if let notes = e.notes, !notes.isEmpty { lines.append("DESCRIPTION:\(icsEscape(notes))") }
    if let url = e.url { lines.append("URL:\(url.absoluteString)") }
    if series, let rule = e.recurrenceRules?.first { lines.append("RRULE:\(rruleText(rule, dateOnly: allDay))") }
    if e.availability == .free { lines.append("TRANSP:TRANSPARENT") }
    if e.status == .canceled { lines.append("STATUS:CANCELLED") }
    for a in e.alarms ?? [] {
        lines.append("BEGIN:VALARM")
        lines.append("ACTION:DISPLAY")
        lines.append("DESCRIPTION:\(icsEscape(e.title ?? "Reminder"))")
        if let at = a.absoluteDate { lines.append("TRIGGER;VALUE=DATE-TIME:\(icsUTC(at))") }
        else { lines.append("TRIGGER:\(icsDuration(minutes: Int((-a.relativeOffset / 60).rounded())))") }
        lines.append("END:VALARM")
    }
    lines.append("END:VEVENT")
    return lines
}

private func exportICS(_ events: [EKEvent], occurrenceOnly: Bool) -> [String: Any] {
    let stamp = icsUTC(Date())
    var body: [String] = []
    var bytes = 0
    var count = 0
    var truncated = false
    var seriesSeen = Set<String>()
    var notes: [String] = []
    for e in events {
        var target = e
        let series = isRecurring(e) && !occurrenceOnly
        if series {
            // 整个系列只出一条:DTSTART 用系列第一次(event(withIdentifier:) 回第一次)。
            guard seriesSeen.insert(e.calendarItemIdentifier).inserted else { continue }
            if let first = e.eventIdentifier.flatMap({ ekStore().event(withIdentifier: $0) }) { target = first }
            if e.isDetached || target.isDetached { notes.append("\"\(e.title ?? "")\": occurrences changed one by one are exported as the plain series rule.") }
        }
        let lines = vevent(target, series: series, stamp: stamp).map(icsFold)
        let size = lines.reduce(0) { $0 + $1.utf8.count + 2 }
        if count >= 500 || bytes + size > 1_000_000 { truncated = true; break }
        body.append(contentsOf: lines)
        bytes += size
        count += 1
    }
    let ics = (["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gugu//Device Actions//ZH", "CALSCALE:GREGORIAN"] + body + ["END:VCALENDAR"]).joined(separator: "\r\n") + "\r\n"
    var out: [String: Any] = ["ics": ics, "count": count, "truncated": truncated]
    if !notes.isEmpty { out["notes"] = Array(notes.prefix(20)) }
    return out
}

// MARK: - 方法

func registerCalendar(_ r: Router) {
    r.on("calendar.status") { _ in ekStatus(.event) }

    r.on("calendar.sources") { _ in
        try ensureEvents(.event)
        return ["sources": sourcesList(.event)]
    }

    r.on("calendar.calendars.list") { p in
        try ensureEvents(.event)
        let rows = containers(.event, writableOnly: p.bool("writable_only") ?? false, sourceId: p.string("source_id")).map { containerRow($0, .event) }
        return ["calendars": rows]
    }

    r.on("calendar.calendars.get") { p in
        try ensureEvents(.event)
        return containerRow(try containerById(.event, try p.requireString("calendar_id")), .event)
    }

    r.on("calendar.calendars.create") { p in
        try ensureEvents(.event)
        return try createContainer(.event, p)
    }

    r.on("calendar.calendars.update") { p in
        try ensureEvents(.event)
        return try updateContainer(.event, p, idKey: "calendar_id")
    }

    r.on("calendar.calendars.delete") { p in
        try ensureEvents(.event)
        return try deleteContainer(.event, p, idKey: "calendar_id")
    }

    r.on("calendar.events.list") { p in
        try ensureEvents(.event)
        let (start, end) = try eventWindow(p)
        let query = p.string("query")
        let includeDeclined = p.bool("include_declined") ?? false
        let all = try fetchEvents(start, end, try eventCalendars(p))
            .filter { matchesQuery($0, query) && (includeDeclined || !isDeclined($0)) }
            .sorted { a, b in
                if a.startDate != b.startDate { return a.startDate < b.startDate }
                return (a.title ?? "", eventId(a)) < (b.title ?? "", eventId(b))
            }
        let offset = max(0, p.int("offset") ?? 0)
        let limit = min(max(1, p.int("limit") ?? 50), 500)
        let page = all.dropFirst(offset).prefix(limit)
        var out: [String: Any] = [
            "events": page.map { eventRow($0, detail: false) },
            "total": all.count,
            "has_more": offset + page.count < all.count,
            "range": ["start": isoLocal(start) ?? "", "end": isoLocal(end) ?? ""],
        ]
        if offset + page.count < all.count { out["next_cursor"] = String(offset + page.count) }
        return out
    }

    r.on("calendar.events.get") { p in
        try ensureEvents(.event)
        return eventRow(try resolveEvent(try p.requireString("event_id")), detail: true)
    }

    r.on("calendar.events.create") { p in
        try ensureEvents(.event)
        _ = try p.requireString("title")
        _ = try p.requireDate("start")
        let e = EKEvent(eventStore: ekStore())
        e.calendar = try writableEventCalendar(p)
        _ = try applyEventFields(e, p, creating: true)
        do {
            try ekStore().save(e, span: .thisEvent, commit: true)
        } catch {
            throw HelperError.failed("Calendar did not save the event: \(error.localizedDescription)")
        }
        return eventRow(e, detail: true)
    }

    r.on("calendar.events.update") { p in
        try ensureEvents(.event)
        let e = try resolveEvent(try p.requireString("event_id"))
        guard e.calendar?.allowsContentModifications == true else { throw HelperError.invalid("\"\(e.title ?? "")\" is in the read-only calendar \"\(e.calendar?.title ?? "")\" and cannot be changed.") }
        let how = try span(p, for: e)
        var changed = try applyEventFields(e, p, creating: false)
        if let key = p.string("calendar") {
            e.calendar = try resolveContainer(.event, key, writable: true)
            changed.append("calendar")
        }
        if changed.isEmpty { throw HelperError.invalid("Nothing to change: pass at least one field (title, start, end, all_day, calendar, location, notes, url, alarms_minutes_before, recurrence).") }
        do {
            try ekStore().save(e, span: how, commit: true)
        } catch {
            throw HelperError.failed("Calendar did not save the change: \(error.localizedDescription)")
        }
        var row = eventRow(e, detail: true)
        row["changed"] = changed
        return row
    }

    r.on("calendar.events.delete") { p in
        try ensureEvents(.event)
        let e = try resolveEvent(try p.requireString("event_id"))
        let how = try span(p, for: e)
        // 兜底:families/calendar.ts 先读出名字问过人;没带 confirmed 一律不删。
        guard p.bool("confirmed") == true else { throw HelperError.confirm("要删除日程「\(e.title ?? "")」吗？", details: ["event": eventRow(e, detail: false)]) }
        guard e.calendar?.allowsContentModifications == true else { throw HelperError.invalid("\"\(e.title ?? "")\" is in the read-only calendar \"\(e.calendar?.title ?? "")\" and cannot be deleted.") }
        let row = eventRow(e, detail: false)
        do {
            try ekStore().remove(e, span: how, commit: true)
        } catch {
            throw HelperError.failed("Calendar did not delete the event: \(error.localizedDescription)")
        }
        return ["deleted": true, "span": how == .futureEvents ? "future" : "this", "event": row]
    }

    r.on("calendar.events.export") { p in
        try ensureEvents(.event)
        let occurrenceOnly = p.bool("occurrence_only") ?? false
        if let id = p.string("event_id") { return exportICS([try resolveEvent(id)], occurrenceOnly: occurrenceOnly) }
        let (start, end) = try eventWindow(p)
        let query = p.string("query")
        let events = try fetchEvents(start, end, try eventCalendars(p))
            .filter { matchesQuery($0, query) }
            .sorted { $0.startDate < $1.startDate }
        return exportICS(events, occurrenceOnly: occurrenceOnly)
    }
}
