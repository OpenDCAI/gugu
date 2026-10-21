// 提醒事项(EventKit)—— reminders.* 13 个,见 families/reminders.ts。
// 列表 / 账户来源 / 授权状态 / 重复规则与日历共用(EKCalendar 同一种东西),写在 Calendar.swift。
// 查重(同名未完成的提醒)与删除前问一句由 families/reminders.ts 先读后问;删除这里另要 confirmed: true 兜底。
import EventKit
import Foundation

private func fetchReminders(_ predicate: NSPredicate) async -> [EKReminder] {
    await withCheckedContinuation { (cont: CheckedContinuation<[EKReminder], Never>) in
        _ = ekStore().fetchReminders(matching: predicate) { reminders in cont.resume(returning: reminders ?? []) }
    }
}

private func dueDate(_ r: EKReminder) -> Date? {
    guard var c = r.dueDateComponents else { return nil }
    if c.calendar == nil { c.calendar = Calendar.current }
    return c.date
}

/// 到期只有日期(没有时刻)= 那天要做,不在某一刻提醒。
private func hasDueTime(_ r: EKReminder) -> Bool { r.dueDateComponents?.hour != nil }

private func priorityName(_ value: Int) -> String? {
    switch value {
    case 1...4: return "high"
    case 5: return "medium"
    case 6...9: return "low"
    default: return nil
    }
}

private func priorityValue(_ name: String) throws -> Int {
    switch name {
    case "high": return 1
    case "medium": return 5
    case "low": return 9
    case "none": return 0
    default: throw HelperError.invalid("priority must be high / medium / low / none, got \(name)")
    }
}

func reminderRow(_ r: EKReminder, detail: Bool) -> [String: Any] {
    var row: [String: Any] = [
        "reminder_id": r.calendarItemIdentifier,
        "title": r.title ?? "",
        "completed": r.isCompleted,
        "list": r.calendar?.title ?? "",
        "list_id": r.calendar?.calendarIdentifier ?? "",
    ]
    if let due = dueDate(r) {
        let timed = hasDueTime(r)
        row["due"] = (timed ? isoLocal(due) : isoDay(due)) ?? NSNull()
        if !timed { row["due_all_day"] = true }
    }
    if let name = priorityName(r.priority) { row["priority"] = name }
    if r.isCompleted, let done = r.completionDate { row["completed_at"] = isoLocal(done) ?? NSNull() }
    if let notes = capText(r.notes, detail ? 2000 : 300) {
        row["notes"] = notes.0
        if notes.1 { row["notes_truncated"] = true }
    }
    if let url = r.url { row["url"] = url.absoluteString }
    if r.hasRecurrenceRules { row["recurring"] = true }
    if detail {
        if let rule = r.recurrenceRules?.first { row["recurrence"] = rruleText(rule, dateOnly: !hasDueTime(r)) }
        let alarms = (r.alarms ?? []).compactMap { a -> Any? in
            if let at = a.absoluteDate { return ["at": isoLocal(at) ?? ""] }
            if a.structuredLocation != nil { return ["location": a.structuredLocation?.title ?? ""] }
            return ["minutes_before": Int((-a.relativeOffset / 60).rounded())]
        }
        if !alarms.isEmpty { row["alarms"] = alarms }
        if var start = r.startDateComponents {
            if start.calendar == nil { start.calendar = Calendar.current }
            if let date = start.date { row["start"] = (start.hour != nil ? isoLocal(date) : isoDay(date)) ?? NSNull() }
        }
        if let created = r.creationDate { row["created"] = isoLocal(created) ?? NSNull() }
        if let modified = r.lastModifiedDate { row["modified"] = isoLocal(modified) ?? NSNull() }
    }
    return row
}

private func resolveReminder(_ id: String) throws -> EKReminder {
    if let r = ekStore().calendarItem(withIdentifier: id) as? EKReminder { return r }
    throw HelperError.invalid("No reminder with reminder_id \(id) on this Mac (deleted, or not a reminder id). Find it with reminders.list.")
}

private func writableList(_ p: Params) throws -> EKCalendar {
    if let key = p.string("list") { return try resolveContainer(.reminder, key, writable: true) }
    if let def = ekStore().defaultCalendarForNewReminders(), def.allowsContentModifications { return def }
    if let first = containers(.reminder, writableOnly: true, sourceId: nil).first { return first }
    throw HelperError.failed("This Mac's Reminders has no writable list.")
}

/// 建 / 改共用:把给了的字段写上;回改了哪几项。due 带时刻时照「提醒事项」App 的做法在那一刻响(alarm: false 不响)。
private func applyReminderFields(_ r: EKReminder, _ p: Params) throws -> [String] {
    var changed: [String] = []
    if let title = p.string("title") { r.title = title; changed.append("title") }
    if p.raw["notes"] != nil { r.notes = (p.raw["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 }; changed.append("notes") }
    if p.raw["url"] != nil {
        if let text = p.string("url") {
            guard let url = URL(string: text), url.scheme != nil else { throw HelperError.invalid("url must be an absolute URL, got \(text)") }
            r.url = url
        } else {
            r.url = nil
        }
        changed.append("url")
    }
    if let priority = p.string("priority") { r.priority = try priorityValue(priority); changed.append("priority") }
    let dropTimedAlarms = {
        for a in r.alarms ?? [] where a.absoluteDate != nil { r.removeAlarm(a) }
    }
    if let raw = p.raw["due"] {
        if raw is NSNull || p.string("due") == nil {
            r.dueDateComponents = nil
            dropTimedAlarms()
        } else {
            let text = p.string("due")!
            guard let date = parseDate(text) else { throw HelperError.invalid("due must be an ISO 8601 date or date-time, got \(text)") }
            let timed = text.count > 10
            var c = Calendar.current.dateComponents(timed ? [.year, .month, .day, .hour, .minute, .second] : [.year, .month, .day], from: date)
            c.calendar = Calendar.current
            if timed { c.timeZone = TimeZone.current }
            r.dueDateComponents = c
            dropTimedAlarms()
            if timed && p.bool("alarm") != false { r.addAlarm(EKAlarm(absoluteDate: date)) }
        }
        changed.append("due")
    } else if p.bool("alarm") == false {
        dropTimedAlarms()
        changed.append("alarm")
    }
    if let o = p.object("recurrence") {
        let rule = try recurrenceRule(o)
        if rule != nil && r.dueDateComponents == nil { throw HelperError.invalid("A repeating reminder needs a due date: pass due as well.") }
        for old in r.recurrenceRules ?? [] { r.removeRecurrenceRule(old) }
        if let rule { r.addRecurrenceRule(rule) }
        changed.append("recurrence")
    }
    return changed
}

private func saveReminder(_ r: EKReminder) throws {
    do {
        try ekStore().save(r, commit: true)
    } catch {
        throw HelperError.failed("Reminders did not save it: \(error.localizedDescription)")
    }
}

func registerReminders(_ r: Router) {
    r.on("reminders.status") { _ in ekStatus(.reminder) }

    r.on("reminders.sources") { _ in
        try ensureEvents(.reminder)
        return ["sources": sourcesList(.reminder)]
    }

    r.on("reminders.lists.list") { p in
        try ensureEvents(.reminder)
        let rows = containers(.reminder, writableOnly: p.bool("writable_only") ?? false, sourceId: p.string("source_id")).map { containerRow($0, .reminder) }
        return ["lists": rows]
    }

    r.on("reminders.lists.get") { p in
        try ensureEvents(.reminder)
        let list = try containerById(.reminder, try p.requireString("list_id"))
        var row = containerRow(list, .reminder)
        if p.bool("count") == true {
            let items = await fetchReminders(ekStore().predicateForReminders(in: [list]))
            row["reminder_count"] = items.count
            row["incomplete_count"] = items.filter { !$0.isCompleted }.count
        }
        return row
    }

    r.on("reminders.lists.create") { p in
        try ensureEvents(.reminder)
        return try createContainer(.reminder, p)
    }

    r.on("reminders.lists.update") { p in
        try ensureEvents(.reminder)
        return try updateContainer(.reminder, p, idKey: "list_id")
    }

    r.on("reminders.lists.delete") { p in
        try ensureEvents(.reminder)
        return try deleteContainer(.reminder, p, idKey: "list_id")
    }

    r.on("reminders.items.list") { p in
        try ensureEvents(.reminder)
        let store = ekStore()
        var lists: [EKCalendar] = []
        if let key = p.string("list") { lists.append(try resolveContainer(.reminder, key, writable: false)) }
        for id in p.strings("list_ids") ?? [] { lists.append(try containerById(.reminder, id)) }
        if p.bool("default_list") == true {
            guard let def = store.defaultCalendarForNewReminders() else { throw HelperError.failed("This Mac's Reminders has no default list.") }
            lists.append(def)
        }
        let calendars = lists.isEmpty ? nil : lists
        let status = p.string("status") ?? "incomplete"
        let predicate: NSPredicate
        switch status {
        case "incomplete": predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars)
        case "completed": predicate = store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: calendars)
        case "all": predicate = store.predicateForReminders(in: calendars)
        default: throw HelperError.invalid("status must be incomplete / completed / all, got \(status)")
        }
        let dueAfter = try p.date("due_after")
        var dueBefore = try p.date("due_before")
        // 只给日期的 due_before = 那一整天都算。
        if let text = p.string("due_before"), text.count == 10, let d = dueBefore { dueBefore = Calendar.current.date(byAdding: .day, value: 1, to: d) }
        let query = p.string("query")
        var items = await fetchReminders(predicate).filter { r in
            if dueAfter != nil || dueBefore != nil {
                guard let due = dueDate(r) else { return false }
                if let dueAfter, due < dueAfter { return false }
                if let dueBefore, due >= dueBefore { return false }
            }
            if let query {
                return [r.title, r.notes].contains { ($0 ?? "").range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
            }
            return true
        }
        // 没完成的在前、按到期(没有到期的排后);完成的按完成时间新到旧。
        items.sort { a, b in
            if a.isCompleted != b.isCompleted { return !a.isCompleted }
            if !a.isCompleted {
                switch (dueDate(a), dueDate(b)) {
                case let (x?, y?) where x != y: return x < y
                case (nil, _?): return false
                case (_?, nil): return true
                default: break
                }
            } else {
                let x = a.completionDate ?? .distantPast
                let y = b.completionDate ?? .distantPast
                if x != y { return x > y }
            }
            return (a.title ?? "", a.calendarItemIdentifier) < (b.title ?? "", b.calendarItemIdentifier)
        }
        let offset = max(0, p.int("offset") ?? 0)
        let limit = min(max(1, p.int("limit") ?? 50), 500)
        let page = items.dropFirst(offset).prefix(limit)
        var out: [String: Any] = [
            "reminders": page.map { reminderRow($0, detail: false) },
            "total": items.count,
            "has_more": offset + page.count < items.count,
        ]
        if offset + page.count < items.count { out["next_cursor"] = String(offset + page.count) }
        return out
    }

    r.on("reminders.items.get") { p in
        try ensureEvents(.reminder)
        return reminderRow(try resolveReminder(try p.requireString("reminder_id")), detail: true)
    }

    r.on("reminders.items.create") { p in
        try ensureEvents(.reminder)
        let reminder = EKReminder(eventStore: ekStore())
        reminder.title = try p.requireString("title")
        reminder.calendar = try writableList(p)
        _ = try applyReminderFields(reminder, p)
        try saveReminder(reminder)
        return reminderRow(reminder, detail: true)
    }

    r.on("reminders.items.update") { p in
        try ensureEvents(.reminder)
        let reminder = try resolveReminder(try p.requireString("reminder_id"))
        guard reminder.calendar?.allowsContentModifications == true else { throw HelperError.invalid("\"\(reminder.title ?? "")\" is in a read-only list and cannot be changed.") }
        var changed = try applyReminderFields(reminder, p)
        if let key = p.string("list") {
            reminder.calendar = try resolveContainer(.reminder, key, writable: true)
            changed.append("list")
        }
        if changed.isEmpty { throw HelperError.invalid("Nothing to change: pass at least one field (title, notes, due, priority, url, list, alarm, recurrence).") }
        try saveReminder(reminder)
        var row = reminderRow(reminder, detail: true)
        row["changed"] = changed
        return row
    }

    r.on("reminders.items.complete") { p in
        try ensureEvents(.reminder)
        let reminder = try resolveReminder(try p.requireString("reminder_id"))
        if p.bool("completed") ?? true {
            if let at = try p.date("completion_date") { reminder.completionDate = at }
            else if !reminder.isCompleted { reminder.isCompleted = true }
        } else {
            reminder.isCompleted = false
        }
        try saveReminder(reminder)
        return reminderRow(reminder, detail: false)
    }

    r.on("reminders.items.delete") { p in
        try ensureEvents(.reminder)
        let reminder = try resolveReminder(try p.requireString("reminder_id"))
        // 兜底:families/reminders.ts 先读出名字问过人;没带 confirmed 一律不删。
        guard p.bool("confirmed") == true else { throw HelperError.confirm("要删除提醒「\(reminder.title ?? "")」吗？", details: ["reminder": reminderRow(reminder, detail: false)]) }
        let row = reminderRow(reminder, detail: false)
        do {
            try ekStore().remove(reminder, commit: true)
        } catch {
            throw HelperError.failed("Reminders did not delete it: \(error.localizedDescription)")
        }
        return ["deleted": true, "reminder": row]
    }
}
