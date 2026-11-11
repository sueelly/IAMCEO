import Foundation

// '읽는 힘 줄이기' B안: the pieces the writing guide puts in fixed places, read back out of the text so the screens can
// draw them in fixed places too. A report's first line "● 대표 차례: …" becomes a band at the top of its card; a decision's
// first line "★ 권장: …" becomes a band right under the title; tables move under the answer buttons and the rest of the
// background folds away. Text that does not follow the guide is shown as before.

/// "● 대표 차례: 커밋할지 정해 주세요(결재함 1건)." → text "커밋할지 정해 주세요", place "결재함 1건", and the body without the line.
struct OwnerTurn: Equatable, Sendable {
    /// What the owner has to do.
    let text: String
    /// Where to do it ("결재함 1건", "결재함", "터미널"…), when the line names it.
    let place: String?
    /// The body without the owner line (and without the blank lines right after it).
    let rest: String

    /// The place names the inbox, so the band can open it.
    var pointsToInbox: Bool { place?.contains("결재") == true || text.contains("결재함") }

    /// Reads the first non-blank line of a report body. Nil when it is not an owner line.
    static func parse(_ body: String) -> OwnerTurn? {
        var lines = body.components(separatedBy: "\n")
        guard let index = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return nil }
        guard let content = stripLabel(lines[index], label: "대표 차례", marks: ["●", "•", "*", "-"]) else { return nil }
        let (text, place) = splitPlace(content)
        guard !text.isEmpty else { return nil }
        lines.removeSubrange(0...index)
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        return OwnerTurn(text: text, place: place, rest: lines.joined(separator: "\n"))
    }

    /// "할 일(결재함 1건)." / "할 일 · 결재함 1건" / "할 일, 결재함에서" → ("할 일", "결재함 1건").
    static func splitPlace(_ value: String) -> (String, String?) {
        var text = value.trimmingCharacters(in: .whitespaces)
        while let last = text.last, ".。".contains(last) { text.removeLast() }
        if text.hasSuffix(")") || text.hasSuffix("）"), let open = text.lastIndex(where: { $0 == "(" || $0 == "（" }) {
            let inner = text[text.index(after: open)..<text.index(before: text.endIndex)].trimmingCharacters(in: .whitespaces)
            let head = text[..<open].trimmingCharacters(in: .whitespaces)
            if !inner.isEmpty && !head.isEmpty { return (trimEnd(head), inner) }
        }
        if let dot = text.range(of: " · ", options: .backwards) {
            let tail = text[dot.upperBound...].trimmingCharacters(in: .whitespaces)
            let head = text[..<dot.lowerBound].trimmingCharacters(in: .whitespaces)
            if !tail.isEmpty && !head.isEmpty && tail.count <= 16 { return (trimEnd(head), tail) }
        }
        return (text, nil)
    }

    private static func trimEnd(_ value: String) -> String {
        var text = value
        while let last = text.last, ".。,".contains(last) { text.removeLast() }
        return text
    }
}

/// "**★ 권장: 유료 API 키.** 공식 안내로 지금 되는 방법입니다. 감수할 것: 쓴 만큼 요금이 나옵니다." → label "유료 API 키",
/// reason "공식 안내로 … 나옵니다.", and the detail without that paragraph.
struct RecommendationLine: Equatable, Sendable {
    /// The recommended answer as the line names it (the card shows the option's own label when it has one).
    let label: String
    /// Why, and what to accept with it.
    let reason: String
    /// The detail without the ★ paragraph.
    let rest: String

    static func parse(_ detail: String) -> RecommendationLine? {
        var lines = detail.components(separatedBy: "\n")
        guard let index = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { return nil }
        // The paragraph runs until the first blank line.
        var end = index
        while end + 1 < lines.count, !lines[end + 1].trimmingCharacters(in: .whitespaces).isEmpty,
              !lines[end + 1].trimmingCharacters(in: .whitespaces).hasPrefix("|") { end += 1 }
        let paragraph = lines[index...end].joined(separator: " ")
        let raw = paragraph.trimmingCharacters(in: .whitespaces)
        // "**★ 권장: 안.** 이유" keeps the bold part as the label; without bold the first sentence is the label.
        var label = ""
        var reason = ""
        if raw.hasPrefix("**"), let close = raw.range(of: "**", range: raw.index(raw.startIndex, offsetBy: 2)..<raw.endIndex) {
            let bold = String(raw[raw.index(raw.startIndex, offsetBy: 2)..<close.lowerBound])
            guard let content = stripLabel(bold, label: "권장", marks: ["★", "☆"]) else { return nil }
            label = content
            reason = String(raw[close.upperBound...])
        } else {
            guard let content = stripLabel(raw, label: "권장", marks: ["★", "☆"]) else { return nil }
            if let stop = content.range(of: ". ") ?? content.range(of: " — ") ?? content.range(of: " - ") {
                label = String(content[..<stop.lowerBound])
                reason = String(content[stop.upperBound...])
            } else {
                label = content
            }
        }
        label = label.trimmingCharacters(in: .whitespaces)
        while let last = label.last, ".。:".contains(last) { label.removeLast() }
        reason = reason.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces)
        if reason.hasPrefix("— ") || reason.hasPrefix("- ") { reason = String(reason.dropFirst(2)) }
        guard !label.isEmpty else { return nil }
        lines.removeSubrange(0...end)
        while let first = lines.first, first.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        return RecommendationLine(label: label, reason: reason, rest: lines.joined(separator: "\n"))
    }
}

/// A decision's background split for the B card: the markdown tables (drawn under the answer buttons) and everything
/// else (folded under "배경 보기"). Tables inside code fences stay where they are.
struct DecisionDetailParts: Equatable, Sendable {
    let tables: [String]
    let background: String

    static func split(_ markdown: String) -> DecisionDetailParts {
        var tables: [String] = []
        var rest: [String] = []
        var current: [String] = []
        var fenced = false
        func flush() {
            if current.count >= 2 { tables.append(current.joined(separator: "\n")) } else { rest.append(contentsOf: current) }
            current = []
        }
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { flush(); fenced.toggle(); rest.append(line); continue }
            if !fenced && trimmed.hasPrefix("|") {
                current.append(line)
            } else {
                flush()
                rest.append(line)
            }
        }
        flush()
        // Fold the blank lines a table leaves behind.
        var background: [String] = []
        for line in rest {
            let blank = line.trimmingCharacters(in: .whitespaces).isEmpty
            if blank && (background.last?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) { continue }
            background.append(line)
        }
        while background.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { background.removeLast() }
        return DecisionDetailParts(tables: tables, background: background.joined(separator: "\n"))
    }
}

/// "● 대표 차례: x" → "x" when the line carries `label` behind one of `marks` (or none), with ":" or "：".
/// Bold around the label ("**대표 차례:** x", "**대표 차례**: x") is allowed.
private func stripLabel(_ line: String, label: String, marks: [String]) -> String? {
    var text = line.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("**") && !text.hasPrefix("**" + label) && marks.contains(where: { text.dropFirst(2).hasPrefix($0) }) {
        text = String(text.dropFirst(2))
    }
    for mark in marks where text.hasPrefix(mark) && !text.hasPrefix("**") {
        text = String(text.dropFirst(mark.count)).trimmingCharacters(in: .whitespaces)
        break
    }
    if text.hasPrefix("**") { text = String(text.dropFirst(2)) }
    guard text.hasPrefix(label) else { return nil }
    text = String(text.dropFirst(label.count))
    if text.hasPrefix("**") { text = String(text.dropFirst(2)) }
    text = text.trimmingCharacters(in: .whitespaces)
    guard let first = text.first, first == ":" || first == "：" else { return nil }
    text = String(text.dropFirst())
    if text.hasPrefix("**") { text = String(text.dropFirst(2)) }
    text = text.replacingOccurrences(of: "**", with: "")
    return text.trimmingCharacters(in: .whitespaces)
}
