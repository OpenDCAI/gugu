// 通讯录(Contacts 框架)—— contacts.* 7 个,见 apps/desktop/electron/device-actions/families/contacts.ts。
// 规矩:
// - 做事前 ensureContacts():没授权回 os_permission,❌ 调用中途弹窗。
// - 读一个字段前先确认它的 key 取过了:没取就读 = Objective-C 异常,整个助手当场崩掉(在途的别的调用一起失败)。
// - 搜索在内存里做:系统的 predicateForContacts(matchingName:) 只认词首,中文「三」搜不到「张三」;电话要按数字比。
// - 删除 / 会丢数据的修改 / 建同名联系人,没带 confirmed 就回 needs_confirmation,问句点名是哪一位、丢哪几项。
import Contacts
import Foundation

private let VCARD_CAP = 256 * 1024
private let NOTE_CAP = 4000

// MARK: 取哪些字段

private func keys(_ names: [String]) -> [CNKeyDescriptor] { names.map { $0 as CNKeyDescriptor } }

private func nameKeys() -> [CNKeyDescriptor] {
    [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)] + keys([
        CNContactIdentifierKey, CNContactGivenNameKey, CNContactFamilyNameKey, CNContactMiddleNameKey,
        CNContactNicknameKey, CNContactOrganizationNameKey, CNContactTypeKey,
    ])
}

private func summaryKeys() -> [CNKeyDescriptor] {
    nameKeys() + keys([CNContactJobTitleKey, CNContactEmailAddressesKey, CNContactPhoneNumbersKey, CNContactBirthdayKey])
}

private func detailKeys(withNote: Bool) -> [CNKeyDescriptor] {
    var list = summaryKeys() + keys([
        CNContactNamePrefixKey, CNContactNameSuffixKey, CNContactPreviousFamilyNameKey,
        CNContactPhoneticGivenNameKey, CNContactPhoneticMiddleNameKey, CNContactPhoneticFamilyNameKey,
        CNContactDepartmentNameKey, CNContactPostalAddressesKey, CNContactUrlAddressesKey,
        CNContactSocialProfilesKey, CNContactInstantMessageAddressesKey, CNContactRelationsKey, CNContactDatesKey,
    ])
    if withNote { list.append(CNContactNoteKey as CNKeyDescriptor) }
    return list
}

// MARK: 错误

private func contactsError(_ error: Error, id: String? = nil) -> HelperError {
    if let known = error as? HelperError { return known }
    let ns = error as NSError
    guard ns.domain == CNErrorDomain else { return .failed("Contacts: \(ns.localizedDescription)") }
    switch ns.code {
    case CNError.Code.authorizationDenied.rawValue:
        return HelperError(code: "os_permission", message: "macOS has not allowed 咕咕 to access Contacts: System Settings → Privacy & Security → Contacts → turn on 咕咕.", details: ["settingsUrl": PRIVACY + "Privacy_Contacts"])
    case CNError.Code.recordDoesNotExist.rawValue, CNError.Code.recordIdentifierInvalid.rawValue:
        return .notFound(id.map { "No contact with id \($0) on this Mac (ids come from contacts.list / contacts.get; it may have been deleted)." } ?? "That contact no longer exists on this Mac.")
    case 300..<400:
        return .invalid("Contacts rejected the change: \(ns.localizedDescription)")
    default:
        return .failed("Contacts: \(ns.localizedDescription)")
    }
}

private func isUnauthorizedKeys(_ error: Error) -> Bool {
    let ns = error as NSError
    return ns.domain == CNErrorDomain && ns.code == CNError.Code.unauthorizedKeys.rawValue
}

// MARK: 读

private func loadContact(_ store: CNContactStore, _ id: String, _ list: [CNKeyDescriptor]) throws -> CNContact {
    do { return try store.unifiedContact(withIdentifier: id, keysToFetch: list) } catch { throw contactsError(error, id: id) }
}

/// 全部字段;备注要另一项授权的系统上(CNErrorCodeUnauthorizedKeys)退一步不取备注。
private func loadDetail(_ store: CNContactStore, _ id: String) throws -> CNContact {
    do {
        return try store.unifiedContact(withIdentifier: id, keysToFetch: detailKeys(withNote: true))
    } catch where isUnauthorizedKeys(error) {
        return try loadContact(store, id, detailKeys(withNote: false))
    } catch {
        throw contactsError(error, id: id)
    }
}

/// 逐个过一遍;body 回 false 就停。
private func eachContact(_ store: CNContactStore, _ list: [CNKeyDescriptor], predicate: NSPredicate? = nil, _ body: (CNContact) -> Bool) throws {
    let request = CNContactFetchRequest(keysToFetch: list)
    request.predicate = predicate
    request.sortOrder = .userDefault
    do {
        try store.enumerateContacts(with: request) { contact, stop in
            if !body(contact) { stop.pointee = true }
        }
    } catch {
        throw contactsError(error)
    }
}

private func field(_ c: CNContact, _ key: String, _ get: (CNContact) -> String) -> String? {
    guard c.isKeyAvailable(key) else { return nil }
    let value = get(c).trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
}

/// 通讯录里显示的那个名字(按用户设的姓名顺序);没名字的用公司 / 邮箱 / 电话。
func contactDisplayName(_ c: CNContact) -> String {
    if let name = CNContactFormatter.string(from: c, style: .fullName)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
    if let org = field(c, CNContactOrganizationNameKey, { $0.organizationName }) { return org }
    if c.isKeyAvailable(CNContactEmailAddressesKey), let email = c.emailAddresses.first { return email.value as String }
    if c.isKeyAvailable(CNContactPhoneNumbersKey), let phone = c.phoneNumbers.first { return phone.value.stringValue }
    return "(no name)"
}

private func labelText(_ label: String?) -> String? {
    guard let label, !label.isEmpty else { return nil }
    return CNLabeledValue<NSString>.localizedString(forLabel: label)
}

private func labeled(_ label: String?, _ value: String) -> [String: Any] {
    var row: [String: Any] = ["value": value]
    if let text = labelText(label) { row["label"] = text }
    return row
}

private func emailsOf(_ c: CNContact) -> [[String: Any]] {
    guard c.isKeyAvailable(CNContactEmailAddressesKey) else { return [] }
    return c.emailAddresses.map { labeled($0.label, $0.value as String) }
}

private func phonesOf(_ c: CNContact) -> [[String: Any]] {
    guard c.isKeyAvailable(CNContactPhoneNumbersKey) else { return [] }
    return c.phoneNumbers.map { labeled($0.label, $0.value.stringValue) }
}

private func addressLine(_ a: CNPostalAddress) -> String {
    CNPostalAddressFormatter.string(from: a, style: .mailingAddress)
        .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")
}

private func addressesOf(_ c: CNContact) -> [[String: Any]] {
    guard c.isKeyAvailable(CNContactPostalAddressesKey) else { return [] }
    return c.postalAddresses.map { item in
        let a = item.value
        var row: [String: Any] = [:]
        if let text = labelText(item.label) { row["label"] = text }
        for (key, value) in [("street", a.street), ("city", a.city), ("state", a.state), ("zip", a.postalCode), ("country", a.country), ("country_code", a.isoCountryCode)] where !value.isEmpty {
            row[key] = value
        }
        let line = addressLine(a)
        if !line.isEmpty { row["formatted"] = line }
        return row
    }
}

/// 生日 / 纪念日:整天,「YYYY-MM-DD」,没记年份的「--MM-DD」。
private func dayText(_ comps: DateComponents?) -> String? {
    guard let comps, let month = comps.month, let day = comps.day, month != NSDateComponentUndefined, day != NSDateComponentUndefined else { return nil }
    if let year = comps.year, year != NSDateComponentUndefined { return String(format: "%04d-%02d-%02d", year, month, day) }
    return String(format: "--%02d-%02d", month, day)
}

/// list / 候选用的一行。
func contactSummary(_ c: CNContact) -> [String: Any] {
    var row: [String: Any] = ["id": c.identifier, "name": contactDisplayName(c)]
    if let v = field(c, CNContactOrganizationNameKey, { $0.organizationName }) { row["organization"] = v }
    if let v = field(c, CNContactJobTitleKey, { $0.jobTitle }) { row["job_title"] = v }
    if c.isKeyAvailable(CNContactTypeKey), c.contactType == .organization { row["company"] = true }
    row["emails"] = emailsOf(c)
    row["phones"] = phonesOf(c)
    if c.isKeyAvailable(CNContactBirthdayKey), let birthday = dayText(c.birthday) { row["birthday"] = birthday }
    return row
}

/// get / me / create / update 回的全量。
func contactDetail(_ c: CNContact) -> [String: Any] {
    var row = contactSummary(c)
    let scalars: [(String, String, (CNContact) -> String)] = [
        ("first_name", CNContactGivenNameKey, { $0.givenName }),
        ("last_name", CNContactFamilyNameKey, { $0.familyName }),
        ("middle_name", CNContactMiddleNameKey, { $0.middleName }),
        ("nickname", CNContactNicknameKey, { $0.nickname }),
        ("name_prefix", CNContactNamePrefixKey, { $0.namePrefix }),
        ("name_suffix", CNContactNameSuffixKey, { $0.nameSuffix }),
        ("maiden_name", CNContactPreviousFamilyNameKey, { $0.previousFamilyName }),
        ("phonetic_first_name", CNContactPhoneticGivenNameKey, { $0.phoneticGivenName }),
        ("phonetic_middle_name", CNContactPhoneticMiddleNameKey, { $0.phoneticMiddleName }),
        ("phonetic_last_name", CNContactPhoneticFamilyNameKey, { $0.phoneticFamilyName }),
        ("department", CNContactDepartmentNameKey, { $0.departmentName }),
    ]
    for (name, key, get) in scalars {
        if let v = field(c, key, get) { row[name] = v }
    }
    if c.isKeyAvailable(CNContactNoteKey) {
        if let note = field(c, CNContactNoteKey, { $0.note }) {
            row["note"] = String(note.prefix(NOTE_CAP))
            if note.count > NOTE_CAP { row["note_truncated"] = true }
        }
    } else {
        row["note_unavailable"] = true
    }
    row["addresses"] = addressesOf(c)
    if c.isKeyAvailable(CNContactUrlAddressesKey) { row["urls"] = c.urlAddresses.map { labeled($0.label, $0.value as String) } }
    if c.isKeyAvailable(CNContactSocialProfilesKey), !c.socialProfiles.isEmpty {
        row["social_profiles"] = c.socialProfiles.map { item -> [String: Any] in
            var p: [String: Any] = [:]
            for (key, value) in [("service", item.value.service), ("username", item.value.username), ("url", item.value.urlString)] where !value.isEmpty { p[key] = value }
            return p
        }
    }
    if c.isKeyAvailable(CNContactInstantMessageAddressesKey), !c.instantMessageAddresses.isEmpty {
        row["instant_messages"] = c.instantMessageAddresses.map { ["service": $0.value.service, "username": $0.value.username] }
    }
    if c.isKeyAvailable(CNContactRelationsKey), !c.contactRelations.isEmpty {
        row["related_names"] = c.contactRelations.map { labeled($0.label, $0.value.name) }
    }
    if c.isKeyAvailable(CNContactDatesKey), !c.dates.isEmpty {
        row["dates"] = c.dates.compactMap { item -> [String: Any]? in
            guard let day = dayText(item.value as DateComponents) else { return nil }
            return labeled(item.label, day)
        }
    }
    return row
}

// MARK: 按名字 / 内容找

private func squash(_ s: String) -> String { s.filter { !$0.isWhitespace }.lowercased() }
private func digitsOf(_ s: String) -> String { String(s.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) && $0.isASCII }.map(Character.init)) }
private func contains(_ haystack: String, _ needle: String) -> Bool {
    !needle.isEmpty && haystack.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != nil
}

private struct ContactSearch {
    let text: String
    let squashed: String
    /// 像电话号码(只有数字和 + - ( ) 空格、至少 3 位)时按数字比。
    let digits: String?

    init(_ text: String) {
        self.text = text
        squashed = squash(text)
        let d = digitsOf(text)
        let phoneish = text.allSatisfy { "0123456789+-(). ".contains($0) }
        digits = phoneish && d.count >= 3 ? d : nil
    }

    private func names(_ c: CNContact) -> [String] {
        var list = [contactDisplayName(c)]
        if let v = field(c, CNContactNicknameKey, { $0.nickname }) { list.append(v) }
        if let v = field(c, CNContactOrganizationNameKey, { $0.organizationName }) { list.append(v) }
        let given = field(c, CNContactGivenNameKey, { $0.givenName }) ?? ""
        let family = field(c, CNContactFamilyNameKey, { $0.familyName }) ?? ""
        list.append(family + given)
        list.append(given + family)
        return list
    }

    func matchesName(_ c: CNContact) -> Bool {
        names(c).contains { contains($0, text) || contains(squash($0), squashed) }
    }

    /// 名字完全一样(忽略大小写与空格):按名字找到好几个时,只有一个完全一样的就是它。
    func exactName(_ c: CNContact) -> Bool {
        names(c).contains { squash($0) == squashed }
    }

    /// list 的搜索:名字、邮箱、电话。
    func matchesAny(_ c: CNContact) -> Bool {
        if matchesName(c) { return true }
        if c.isKeyAvailable(CNContactEmailAddressesKey), c.emailAddresses.contains(where: { contains($0.value as String, text) }) { return true }
        if let digits, c.isKeyAvailable(CNContactPhoneNumbersKey) {
            // 存的是 138…、搜的是 +86 138… 也算:存的号码够长(≥7 位)且是搜的那串的结尾。
            return c.phoneNumbers.contains { item in
                let stored = digitsOf(item.value.stringValue)
                return stored.contains(digits) || (stored.count >= 7 && digits.hasSuffix(stored))
            }
        }
        return false
    }
}

private func findByName(_ store: CNContactStore, _ name: String) throws -> (all: [CNContact], exact: [CNContact]) {
    let search = ContactSearch(name)
    var all: [CNContact] = []
    var exact: [CNContact] = []
    try eachContact(store, summaryKeys()) { c in
        if search.matchesName(c) {
            all.append(c)
            if search.exactName(c) { exact.append(c) }
        }
        return true
    }
    return (all, exact)
}

// MARK: 写

private enum LabelKind { case phone, email, url, address }

/// 人话标签(「手机」「work」)→ 通讯录的标签常量;认不出的当自定义标签原样存。
private func labelConstant(_ text: String?, _ kind: LabelKind) -> String? {
    guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
    if raw.hasPrefix("_$!<") { return raw }
    let lower = raw.lowercased()
    switch lower {
    case "home", "家", "住宅", "家庭": return CNLabelHome
    case "work", "工作", "单位": return CNLabelWork
    case "school", "学校": return CNLabelSchool
    case "other", "其他": return CNLabelOther
    default: break
    }
    switch kind {
    case .phone:
        switch lower {
        case "mobile", "cell", "手机", "移动电话": return CNLabelPhoneNumberMobile
        case "iphone": return CNLabelPhoneNumberiPhone
        case "main", "主要", "总机": return CNLabelPhoneNumberMain
        case "home fax", "住宅传真": return CNLabelPhoneNumberHomeFax
        case "work fax", "工作传真": return CNLabelPhoneNumberWorkFax
        case "other fax": return CNLabelPhoneNumberOtherFax
        case "pager", "传呼": return CNLabelPhoneNumberPager
        default: return raw
        }
    case .email:
        return lower == "icloud" ? CNLabelEmailiCloud : raw
    case .url:
        return ["homepage", "home page", "主页"].contains(lower) ? CNLabelURLAddressHomePage : raw
    case .address:
        return raw
    }
}

private struct ScalarField {
    let param: String
    let key: String
    let zh: String
    let get: (CNContact) -> String
    let set: (CNMutableContact, String) -> Void
}

private func scalarFields() -> [ScalarField] {
    [
        ScalarField(param: "firstName", key: CNContactGivenNameKey, zh: "名", get: { $0.givenName }, set: { $0.givenName = $1 }),
        ScalarField(param: "lastName", key: CNContactFamilyNameKey, zh: "姓", get: { $0.familyName }, set: { $0.familyName = $1 }),
        ScalarField(param: "middleName", key: CNContactMiddleNameKey, zh: "中间名", get: { $0.middleName }, set: { $0.middleName = $1 }),
        ScalarField(param: "nickname", key: CNContactNicknameKey, zh: "昵称", get: { $0.nickname }, set: { $0.nickname = $1 }),
        ScalarField(param: "organization", key: CNContactOrganizationNameKey, zh: "公司", get: { $0.organizationName }, set: { $0.organizationName = $1 }),
        ScalarField(param: "jobTitle", key: CNContactJobTitleKey, zh: "职位", get: { $0.jobTitle }, set: { $0.jobTitle = $1 }),
        ScalarField(param: "department", key: CNContactDepartmentNameKey, zh: "部门", get: { $0.departmentName }, set: { $0.departmentName = $1 }),
        ScalarField(param: "note", key: CNContactNoteKey, zh: "备注", get: { $0.note }, set: { $0.note = $1 }),
    ]
}

/// 「YYYY-MM-DD」或「--MM-DD」(不记年份)。
private func parseBirthday(_ text: String) throws -> DateComponents {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    var comps = DateComponents()
    if text.hasPrefix("--"), parts.count == 4, let m = Int(parts[2]), let d = Int(parts[3]) {
        comps.month = m
        comps.day = d
    } else if parts.count == 3, parts[0].count == 4, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) {
        comps.year = y
        comps.month = m
        comps.day = d
    } else {
        throw HelperError.invalid("birthday must be \"YYYY-MM-DD\" or \"--MM-DD\" (no year), got \(text)")
    }
    guard let m = comps.month, let d = comps.day, (1...12).contains(m), (1...31).contains(d) else {
        throw HelperError.invalid("birthday has an impossible month/day: \(text)")
    }
    return comps
}

/// 参数里要改的东西。数组字段给了就整组替换;字符串给 "" = 清空;没给的不动。
private struct ContactEdit {
    var scalars: [(ScalarField, String)] = []
    var emails: [CNLabeledValue<NSString>]?
    var phones: [CNLabeledValue<CNPhoneNumber>]?
    var addresses: [CNLabeledValue<CNPostalAddress>]?
    var urls: [CNLabeledValue<NSString>]?
    var homePage: String?
    /// 外层 nil = 没给;内层 nil = 清空。
    var birthday: DateComponents??
    var company: Bool?

    var isEmpty: Bool {
        scalars.isEmpty && emails == nil && phones == nil && addresses == nil && urls == nil && homePage == nil && birthday == nil && company == nil
    }

    init(_ p: Params, allowCompany: Bool) throws {
        for f in scalarFields() {
            guard let raw = p.raw[f.param] else { continue }
            guard let value = raw as? String else { throw HelperError.invalid("\(f.param) must be a string") }
            scalars.append((f, value.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        if let list = try ContactEdit.entries(p, "emails") {
            emails = try list.map { o in
                guard let value = (o["value"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), value.contains("@") else { throw HelperError.invalid("emails: every entry needs a value that is an email address") }
                return CNLabeledValue(label: labelConstant(o["label"] as? String, .email), value: value as NSString)
            }
        }
        if let list = try ContactEdit.entries(p, "phones") {
            phones = try list.map { o in
                guard let value = (o["value"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !digitsOf(value).isEmpty else { throw HelperError.invalid("phones: every entry needs a value with digits") }
                return CNLabeledValue(label: labelConstant(o["label"] as? String, .phone), value: CNPhoneNumber(stringValue: value))
            }
        }
        if let list = try ContactEdit.entries(p, "addresses") {
            addresses = try list.map { o in
                let a = CNMutablePostalAddress()
                let text = { (key: String) in ((o[key] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
                a.street = text("street")
                a.city = text("city")
                a.state = text("state")
                a.postalCode = text("zip")
                a.country = text("country")
                a.isoCountryCode = text("countryCode").lowercased()
                if [a.street, a.city, a.state, a.postalCode, a.country].allSatisfy(\.isEmpty) { throw HelperError.invalid("addresses: every entry needs at least one of street, city, state, zip, country") }
                return CNLabeledValue(label: labelConstant(o["label"] as? String, .address), value: a.copy() as! CNPostalAddress)
            }
        }
        if let list = try ContactEdit.entries(p, "urls") {
            urls = try list.map { o in
                guard let value = (o["value"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { throw HelperError.invalid("urls: every entry needs a value") }
                return CNLabeledValue(label: labelConstant(o["label"] as? String, .url), value: value as NSString)
            }
        }
        if let raw = p.raw["homePage"] {
            guard let value = raw as? String else { throw HelperError.invalid("homePage must be a string") }
            homePage = value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let raw = p.raw["birthday"] {
            guard let value = raw as? String else { throw HelperError.invalid("birthday must be a string") }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { birthday = .some(nil) } else { birthday = .some(try parseBirthday(trimmed)) }
        }
        if allowCompany, let flag = p.bool("company") { company = flag }
    }

    private static func entries(_ p: Params, _ key: String) throws -> [[String: Any]]? {
        guard let raw = p.raw[key] else { return nil }
        guard let list = raw as? [Any] else { throw HelperError.invalid("\(key) must be an array") }
        if list.count > 50 { throw HelperError.invalid("\(key): at most 50 entries") }
        return try list.map { item in
            guard let object = item as? [String: Any] else { throw HelperError.invalid("\(key): every entry must be an object") }
            return object
        }
    }

    func apply(to c: CNMutableContact) throws {
        for (f, value) in scalars {
            guard c.isKeyAvailable(f.key) else { throw HelperError.failed("This Mac does not let 咕咕 edit the contact's \(f.param).") }
            f.set(c, value)
        }
        if let emails { c.emailAddresses = emails }
        if let phones { c.phoneNumbers = phones }
        if let addresses { c.postalAddresses = addresses }
        if let urls { c.urlAddresses = urls }
        if let homePage {
            let rest = c.urlAddresses.filter { $0.label != CNLabelURLAddressHomePage }
            c.urlAddresses = (homePage.isEmpty ? [] : [CNLabeledValue(label: CNLabelURLAddressHomePage, value: homePage as NSString)]) + rest
        }
        if let birthday { c.birthday = birthday }
        if let company { c.contactType = company ? .organization : .person }
    }
}

/// 改完之后旧的里面有、新的里面没了的东西(给人看的中文,一项一条)。
private func lostData(old: CNContact, new: CNContact) -> [String] {
    var lost: [String] = []
    for f in scalarFields() {
        if let before = field(old, f.key, f.get), field(new, f.key, f.get) == nil { lost.append("\(f.zh)「\(before.prefix(40))」") }
    }
    func diff<T>(_ key: String, _ zh: String, _ list: (CNContact) -> [T], _ norm: (T) -> String, _ show: (T) -> String) {
        guard old.isKeyAvailable(key), new.isKeyAvailable(key) else { return }
        let keep = Set(list(new).map(norm))
        for item in list(old) where !keep.contains(norm(item)) { lost.append("\(zh) \(show(item))") }
    }
    diff(CNContactEmailAddressesKey, "邮箱", { $0.emailAddresses }, { ($0.value as String).lowercased() }, { $0.value as String })
    diff(CNContactPhoneNumbersKey, "电话", { $0.phoneNumbers }, { digitsOf($0.value.stringValue) }, { $0.value.stringValue })
    diff(CNContactPostalAddressesKey, "地址", { $0.postalAddresses }, { squash(addressLine($0.value)) }, { addressLine($0.value) })
    diff(CNContactUrlAddressesKey, "网址", { $0.urlAddresses }, { ($0.value as String).lowercased() }, { $0.value as String })
    if old.isKeyAvailable(CNContactBirthdayKey), let before = dayText(old.birthday), dayText(new.birthday) == nil { lost.append("生日 \(before)") }
    return lost
}

private func save(_ store: CNContactStore, _ request: CNSaveRequest, id: String? = nil) throws {
    do { try store.execute(request) } catch { throw contactsError(error, id: id) }
}

/// 问句里点名用:「张三(Acme · 138 0000 0000)」。
private func whoText(_ c: CNContact) -> String {
    var bits: [String] = []
    if let org = field(c, CNContactOrganizationNameKey, { $0.organizationName }), org != contactDisplayName(c) { bits.append(org) }
    if c.isKeyAvailable(CNContactPhoneNumbersKey), let phone = c.phoneNumbers.first { bits.append(phone.value.stringValue) } else if c.isKeyAvailable(CNContactEmailAddressesKey), let email = c.emailAddresses.first { bits.append(email.value as String) }
    return "「\(contactDisplayName(c))」" + (bits.isEmpty ? "" : "（\(bits.joined(separator: " · "))）")
}

func registerContacts(_ r: Router) {
    r.on("contacts.list") { p in
        try ensureContacts()
        let store = CNContactStore()
        let limit = max(1, min(p.int("limit") ?? 50, 500))
        var predicate: NSPredicate?
        var groupName: String?
        if let wanted = p.string("group") {
            let groups: [CNGroup]
            do { groups = try store.groups(matching: nil) } catch { throw contactsError(error) }
            guard let group = groups.first(where: { $0.name.compare(wanted, options: [.caseInsensitive, .widthInsensitive]) == .orderedSame }) else {
                let names = groups.map(\.name)
                throw HelperError.invalid(names.isEmpty
                    ? "No contact group named \"\(wanted)\": Contacts on this Mac has no groups. Leave group out."
                    : "No contact group named \"\(wanted)\". Groups on this Mac: \(names.prefix(60).joined(separator: ", ")).")
            }
            predicate = CNContact.predicateForContactsInGroup(withIdentifier: group.identifier)
            groupName = group.name
        }
        let search = p.string("search").map(ContactSearch.init)
        var total = 0
        var rows: [[String: Any]] = []
        try eachContact(store, summaryKeys(), predicate: predicate) { c in
            if let search, !search.matchesAny(c) { return true }
            total += 1
            if rows.count < limit { rows.append(contactSummary(c)) }
            return true
        }
        var result: [String: Any] = ["total": total, "returned": rows.count, "truncated": total > rows.count, "contacts": rows]
        if let groupName { result["group"] = groupName }
        return result
    }

    r.on("contacts.get") { p in
        try ensureContacts()
        let store = CNContactStore()
        if let id = p.string("id") { return contactDetail(try loadDetail(store, id)) }
        let name = try p.requireString("name")
        let found = try findByName(store, name)
        if let only = found.all.count == 1 ? found.all.first : (found.exact.count == 1 ? found.exact.first : nil) {
            return contactDetail(try loadDetail(store, only.identifier))
        }
        if found.all.isEmpty {
            throw HelperError.notFound("No contact on this Mac matches the name \"\(name)\". Try contacts.list with a shorter search (it also matches emails and phone numbers).")
        }
        return [
            "multiple": true,
            "total": found.all.count,
            "candidates": found.all.prefix(20).map(contactSummary),
            "hint": "\(found.all.count) contacts match \"\(name)\". Pick the right one (ask the person if unsure) and call contacts.get again with its id.",
        ] as [String: Any]
    }

    r.on("contacts.me") { _ in
        try ensureContacts()
        let store = CNContactStore()
        func me(_ list: [CNKeyDescriptor]) throws -> CNContact { try store.unifiedMeContactWithKeys(toFetch: list) }
        do {
            let card: CNContact
            do { card = try me(detailKeys(withNote: true)) } catch where isUnauthorizedKeys(error) { card = try me(detailKeys(withNote: false)) }
            return contactDetail(card)
        } catch {
            let ns = error as NSError
            if ns.domain == CNErrorDomain, ns.code == CNError.Code.authorizationDenied.rawValue { throw contactsError(error) }
            throw HelperError.failed("This Mac has no \"My Card\" in Contacts (\(ns.localizedDescription)). The person can set one in Contacts → Card → Make This My Card.")
        }
    }

    r.on("contacts.create") { p in
        try ensureContacts()
        let edit = try ContactEdit(p, allowCompany: true)
        let contact = CNMutableContact()
        try edit.apply(to: contact)
        let named = [contact.givenName, contact.familyName, contact.organizationName].contains { !$0.isEmpty }
        if !named { throw HelperError.invalid("At least one of firstName, lastName or organization is required") }
        if contact.contactType == .organization, contact.organizationName.isEmpty { throw HelperError.invalid("organization is required when company is true") }
        let store = CNContactStore()
        if p.bool("confirmed") != true {
            let name = squash(contactDisplayName(contact))
            var same: [CNContact] = []
            try eachContact(store, summaryKeys()) { c in
                if squash(contactDisplayName(c)) == name { same.append(c) }
                return true
            }
            if !same.isEmpty {
                let list = same.prefix(3).map(whoText).joined(separator: "、")
                throw HelperError.confirm(
                    "通讯录里已经有 \(same.count) 位「\(contactDisplayName(contact))」：\(list)。还要再新建一个同名联系人吗？",
                    details: ["existing": same.prefix(10).map(contactSummary), "hint": "To change the existing contact use contacts.update with its id; resend with confirmed: true only if the person wants a second contact."])
            }
        }
        let request = CNSaveRequest()
        request.add(contact, toContainerWithIdentifier: nil)
        try save(store, request)
        return contactDetail(contact)
    }

    r.on("contacts.update") { p in
        try ensureContacts()
        let id = try p.requireString("id")
        let edit = try ContactEdit(p, allowCompany: false)
        if edit.isEmpty { throw HelperError.invalid("Nothing to change: pass at least one field besides id") }
        let store = CNContactStore()
        let old = try loadDetail(store, id)
        guard let contact = old.mutableCopy() as? CNMutableContact else { throw HelperError.failed("Contacts did not give an editable copy of \(id)") }
        try edit.apply(to: contact)
        if contact.givenName.isEmpty, contact.familyName.isEmpty, contact.organizationName.isEmpty {
            throw HelperError.invalid("The contact would be left without firstName, lastName and organization; keep at least one")
        }
        let lost = lostData(old: old, new: contact)
        if !lost.isEmpty, p.bool("confirmed") != true {
            let shown = lost.prefix(8).joined(separator: "、") + (lost.count > 8 ? " 等 \(lost.count) 项" : "")
            throw HelperError.confirm(
                "修改\(whoText(old))会删掉：\(shown)。确定吗？",
                details: ["contact": contactSummary(old), "removes": lost, "hint": "emails / phones / addresses / urls replace the whole list. To add an entry, pass the existing entries too (see contacts.get). Resend with confirmed: true only if the person agrees to remove these."])
        }
        let request = CNSaveRequest()
        request.update(contact)
        try save(store, request, id: id)
        return contactDetail(contact)
    }

    r.on("contacts.delete") { p in
        try ensureContacts()
        let id = try p.requireString("id")
        let store = CNContactStore()
        let contact = try loadContact(store, id, summaryKeys())
        let name = contactDisplayName(contact)
        if p.bool("confirmed") != true {
            throw HelperError.confirm("要从这台电脑的通讯录里删除\(whoText(contact))吗？删除后无法撤销。", details: ["contact": contactSummary(contact)])
        }
        guard let mutable = contact.mutableCopy() as? CNMutableContact else { throw HelperError.failed("Contacts did not give an editable copy of \(id)") }
        let request = CNSaveRequest()
        request.delete(mutable)
        try save(store, request, id: id)
        return ["deleted": true, "id": id, "name": name] as [String: Any]
    }

    r.on("contacts.export") { p in
        try ensureContacts()
        let store = CNContactStore()
        var ids: [String] = []
        if let id = p.string("id") {
            ids = [id]
        } else {
            let name = try p.requireString("name")
            ids = try findByName(store, name).all.map(\.identifier)
            if ids.isEmpty { throw HelperError.notFound("No contact on this Mac matches the name \"\(name)\". Use contacts.list to search.") }
        }
        let vcardKeys = [CNContactVCardSerialization.descriptorForRequiredKeys()] + nameKeys()
        var used = 0
        var rows: [[String: Any]] = []
        for id in ids {
            let contact = try loadContact(store, id, vcardKeys)
            // 照片不进 vCard(一张就能上百 KB),要的是名片上的文字。
            guard let copy = contact.mutableCopy() as? CNMutableContact else { continue }
            if copy.isKeyAvailable(CNContactImageDataKey) { copy.imageData = nil }
            let data: Data
            do { data = try CNContactVCardSerialization.data(with: [copy]) } catch { throw HelperError.failed("Could not write a vCard for \(contactDisplayName(contact)): \(error.localizedDescription)") }
            if used + data.count > VCARD_CAP { break }
            used += data.count
            rows.append(["id": contact.identifier, "name": contactDisplayName(contact), "vcard": String(decoding: data, as: UTF8.self)])
        }
        return ["total": ids.count, "returned": rows.count, "truncated": rows.count < ids.count, "bytes": used, "contacts": rows] as [String: Any]
    }
}
