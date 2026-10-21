// 文字识别(Vision)、Finder 标签、挂载的磁盘 —— fs.ocr / fs.tags / fs.tags_registry / fs.volumes.list,见 families/files.ts。
// 路径都已经由咕咕按「连上了的位置」判过(真实位置),这里只管做事。
import CoreGraphics
import Foundation
import ImageIO
import Vision

/// Finder 标签存在这个扩展属性里:二进制 plist,一个字符串数组,每项「名字」或「名字\n颜色序号」(Finder 自己就这么写)。
private let TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags"
/// 颜色序号 0…7(Finder 的顺序)。
private let TAG_COLORS = ["none", "gray", "green", "purple", "blue", "yellow", "red", "orange"]

private func posixMessage(_ code: Int32, _ path: String) -> HelperError {
    if code == ENOENT { return HelperError.invalid("not found: \(path)") }
    if code == EPERM {
        return HelperError.failed("macOS did not let 咕咕 read \(path) (Privacy & Security → Files and Folders / Full Disk Access)")
    }
    return HelperError.failed("\(path): \(String(cString: strerror(code)))")
}

func readFinderTags(_ path: String) throws -> [[String: Any]] {
    let size = getxattr(path, TAGS_XATTR, nil, 0, 0, 0)
    if size < 0 {
        if errno == ENOATTR { return [] }
        throw posixMessage(errno, path)
    }
    if size == 0 { return [] }
    var data = Data(count: size)
    let read = data.withUnsafeMutableBytes { getxattr(path, TAGS_XATTR, $0.baseAddress, size, 0, 0) }
    if read < 0 { throw posixMessage(errno, path) }
    guard let list = try? PropertyListSerialization.propertyList(from: data.prefix(read), format: nil) as? [String] else { return [] }
    return list.map { entry in
        let parts = entry.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        let index = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
        return ["name": String(parts[0]), "color": TAG_COLORS.indices.contains(index) ? TAG_COLORS[index] : "none"]
    }
}

func writeFinderTags(_ path: String, _ tags: [[String: Any]]) throws {
    var entries: [String] = []
    for tag in tags {
        guard let name = (tag["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            throw HelperError.invalid("every tag needs a name")
        }
        if name.contains("\n") { throw HelperError.invalid("tag names cannot contain line breaks") }
        let color = (tag["color"] as? String) ?? "none"
        guard let index = TAG_COLORS.firstIndex(of: color) else {
            throw HelperError.invalid("unknown tag color \(color); use one of \(TAG_COLORS.joined(separator: ", "))")
        }
        entries.append(index > 0 ? "\(name)\n\(index)" : name)
    }
    if entries.isEmpty {
        if removexattr(path, TAGS_XATTR, 0) != 0 && errno != ENOATTR { throw posixMessage(errno, path) }
        return
    }
    let data = try PropertyListSerialization.data(fromPropertyList: entries, format: .binary, options: 0)
    let status = data.withUnsafeBytes { setxattr(path, TAGS_XATTR, $0.baseAddress, data.count, 0, 0) }
    if status != 0 { throw posixMessage(errno, path) }
}

/// 要识别的那张图:图片文件照原样(带拍摄方向);PDF 渲染指定那一页(白底,长边不超过 4000 像素)。
private func loadImage(_ path: String, page: Int) throws -> (CGImage, CGImagePropertyOrientation, Int?) {
    let url = URL(fileURLWithPath: path)
    if url.pathExtension.lowercased() == "pdf" {
        guard let doc = CGPDFDocument(url as CFURL) else { throw HelperError.failed("cannot open PDF \(path)") }
        if doc.isEncrypted && !doc.isUnlocked { throw HelperError.failed("\(path) is a password-protected PDF") }
        guard page >= 1 && page <= doc.numberOfPages, let pdfPage = doc.page(at: page) else {
            throw HelperError.invalid("page must be between 1 and \(doc.numberOfPages)")
        }
        let box = pdfPage.getBoxRect(.cropBox)
        let scale = min(4.0, 4000.0 / max(box.width, box.height, 1))
        let width = Int(box.width * scale), height = Int(box.height * scale)
        guard width > 0, height > 0,
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw HelperError.failed("cannot render page \(page) of \(path)") }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        ctx.drawPDFPage(pdfPage)
        guard let image = ctx.makeImage() else { throw HelperError.failed("cannot render page \(page) of \(path)") }
        return (image, .up, doc.numberOfPages)
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw HelperError.invalid("\(path) is not an image macOS can read (JPEG, PNG, HEIC, TIFF, GIF, WebP, BMP or PDF)") }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let raw = (props?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    return (image, CGImagePropertyOrientation(rawValue: raw) ?? .up, nil)
}

/// 「en」「ja」这种短写法换成 Vision 认的那个(en-US、ja-JP);认不出的报出来,❌ 悄悄丢掉。
private func resolveLanguages(_ wanted: [String], supported: [String]) throws -> [String] {
    var out: [String] = []
    for lang in wanted {
        let hit = supported.first { $0.caseInsensitiveCompare(lang) == .orderedSame }
            ?? supported.first { $0.lowercased().hasPrefix(lang.lowercased() + "-") }
        guard let hit else {
            throw HelperError.invalid("OCR does not support language \(lang) on this Mac; supported: \(supported.joined(separator: ", "))")
        }
        if !out.contains(hit) { out.append(hit) }
    }
    return out
}

/// 四位小数;用十进制数回(JSON 里是 0.0244,❌ 二进制浮点的 0.024400000000000002 —— 回给 agent 的每个字都算钱)。
private func round4(_ v: CGFloat) -> NSDecimalNumber { NSDecimalNumber(string: String(format: "%.4f", Double(v))) }

func registerVision(_ r: Router) {
    r.on("vision.ocr") { p in
        let path = try p.requireString("path")
        let page = p.int("page") ?? 1
        let (image, orientation, pages) = try loadImage(path, page: page)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let supported = try request.supportedRecognitionLanguages()
        let wanted = p.strings("languages") ?? ["zh-Hans", "en-US"]
        request.recognitionLanguages = try resolveLanguages(wanted.isEmpty ? ["zh-Hans", "en-US"] : wanted, supported: supported)
        let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
        try handler.perform([request])
        var lines: [[String: Any]] = []
        var texts: [String] = []
        var total: Float = 0
        for observation in request.results ?? [] {
            guard let top = observation.topCandidates(1).first else { continue }
            let b = observation.boundingBox
            texts.append(top.string)
            total += top.confidence
            // Vision 的框原点在左下;回给 agent 的换成左上(与看图的习惯一致),都是 0…1 的比例。
            lines.append([
                "text": top.string,
                "confidence": round4(CGFloat(top.confidence)),
                "box": ["x": round4(b.minX), "y": round4(1 - b.maxY), "width": round4(b.width), "height": round4(b.height)],
            ])
        }
        let rotated = [.left, .right, .leftMirrored, .rightMirrored].contains(orientation)
        var result: [String: Any] = [
            "text": texts.joined(separator: "\n"),
            "confidence": lines.isEmpty ? 0 : round4(CGFloat(total / Float(lines.count))),
            "lineCount": lines.count,
            "lines": lines,
            "width": rotated ? image.height : image.width,
            "height": rotated ? image.width : image.height,
            "languages": request.recognitionLanguages,
        ]
        if let pages { result["page"] = page; result["pageCount"] = pages }
        return result
    }

    /// 一次读多个文件的标签(标签总览要读成百上千个);读不了的那个带 error,❌ 整批失败。
    r.on("files.tags.get") { p in
        guard let paths = p.strings("paths"), !paths.isEmpty else { throw HelperError.invalid("paths is required") }
        return ["results": paths.map { path -> [String: Any] in
            do { return ["path": path, "tags": try readFinderTags(path)] } catch let e as HelperError { return ["path": path, "error": e.message] } catch { return ["path": path, "error": "\(error)"] }
        }]
    }

    /// 整个换掉一个文件的标签(加 / 删 / 改名由咕咕算好再给全量);回写完后实际读到的。
    r.on("files.tags.set") { p in
        let path = try p.requireString("path")
        guard let tags = p.raw["tags"] as? [Any] else { throw HelperError.invalid("tags is required (an empty list removes all tags)") }
        try writeFinderTags(path, tags.compactMap { $0 as? [String: Any] })
        return ["path": path, "tags": try readFinderTags(path)]
    }

    /// 挂载的磁盘(Finder 侧栏能看到的那些;系统内部的隐藏卷不列)。
    r.on("files.volumes") { _ in
        let keys: [URLResourceKey] = [
            .volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey, .volumeAvailableCapacityForImportantUsageKey,
            .volumeIsInternalKey, .volumeIsEjectableKey, .volumeIsRemovableKey, .volumeIsReadOnlyKey, .volumeIsLocalKey,
            .volumeIsEncryptedKey, .volumeIsRootFileSystemKey, .volumeLocalizedFormatDescriptionKey,
        ]
        guard let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) else {
            throw HelperError.failed("macOS did not return the mounted volumes")
        }
        var volumes: [[String: Any]] = []
        for url in urls {
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { continue }
            var fs = statfs()
            var fsType = "", device = ""
            if statfs(url.path, &fs) == 0 {
                fsType = withUnsafePointer(to: &fs.f_fstypename) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MFSTYPENAMELEN)) { String(cString: $0) } }
                device = withUnsafePointer(to: &fs.f_mntfromname) { $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) } }
            }
            let total: Int64 = Int64(v.volumeTotalCapacity ?? 0)
            let free: Int64 = v.volumeAvailableCapacityForImportantUsage ?? Int64(v.volumeAvailableCapacity ?? 0)
            let format: String = v.volumeLocalizedFormatDescription ?? ""
            var row: [String: Any] = [:]
            row["name"] = v.volumeName ?? url.lastPathComponent
            row["mountPoint"] = url.path
            row["fileSystem"] = fsType.isEmpty ? (format.isEmpty ? "unknown" : format) : fsType
            row["format"] = format
            row["totalBytes"] = total
            row["freeBytes"] = free
            row["usedBytes"] = max(Int64(0), total - free)
            row["device"] = device
            row["isRoot"] = v.volumeIsRootFileSystem ?? false
            row["isInternal"] = v.volumeIsInternal ?? false
            row["isLocal"] = v.volumeIsLocal ?? true
            row["isEjectable"] = v.volumeIsEjectable ?? false
            row["isRemovable"] = v.volumeIsRemovable ?? false
            row["isReadOnly"] = v.volumeIsReadOnly ?? false
            row["isEncrypted"] = v.volumeIsEncrypted ?? false
            volumes.append(row)
        }
        return ["volumes": volumes]
    }
}
