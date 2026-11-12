import Foundation

// '읽는 힘 줄이기' B안: the first-line conventions of reports and decision cards, read back so the screens can draw them
// in fixed places. A port of shared/owner-lines.ts and web/src/lib/thread-view.ts · decision-view.ts; keep them in step
// (the same lines must read the same on the web and in the app).
//   report body first line:    "● 대표 차례: <owner_action>"
//   decision detail first line: "★ 권장: <recommended option label> — <rec_reason>"

/// The report's "● 대표 차례" line: what the owner has to do, and the body without that line.
struct OwnerTurn: Equatable, Sendable {
    /// What the owner has to do, without the trailing "결재함 N건".
    let text: String
    /// "결재함 N건" when the line ends with it (drawn as the band's link to the inbox).
    let inbox: String?
    /// The body without the owner line (and without the blank lines after it).
    let rest: String

    /// shared/owner-lines.ts parseOwnerLine + thread-view.ts splitOwnerAction.
    static func parse(_ body: String) -> OwnerTurn? {
        guard !body.isEmpty else { return nil }
        let (first, rest) = ReadingLines.splitFirstLine(body)
        guard let action = ReadingLines.match(ReadingLines.owner, ReadingLines.unbold(first)) else { return nil }
        let (text, inbox) = splitAction(action)
        return OwnerTurn(text: text, inbox: inbox, rest: rest)
    }

    /// '정해 주세요 · 결재함 1건', '정해 주세요(결재함 1건).' → ("정해 주세요", "결재함 1건").
    static func splitAction(_ action: String) -> (String, String?) {
        let value = action.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(value.startIndex..., in: value)
        guard let m = ReadingLines.ownerInbox.firstMatch(in: value, range: range),
              let headRange = Range(m.range(at: 1), in: value), let inboxRange = Range(m.range(at: 2), in: value) else { return (value, nil) }
        let head = value[headRange].trimmingCharacters(in: .whitespacesAndNewlines)
        guard !head.isEmpty else { return (value, nil) }
        var inbox = String(value[inboxRange]).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        inbox = inbox.replacingOccurrences(of: "(\\d+) 건", with: "$1건", options: .regularExpression)
        return (head, inbox)
    }
}

/// The decision's "★ 권장" line: the band under the title, and the detail without that line.
struct RecommendationLine: Equatable, Sendable {
    /// The recommended answer.
    let label: String
    /// Why (empty when the line gives none).
    let reason: String
    /// A hand-written line whose answer and reason could not be told apart: drawn as plain text, not bold.
    let plain: Bool
    /// The detail without the ★ line.
    let rest: String

    /// shared/owner-lines.ts parseRecLine + decision-view.ts splitDetail. `recLabel` is the card's recommended option.
    static func parse(_ detail: String, recLabel: String?) -> RecommendationLine? {
        guard !detail.isEmpty else { return nil }
        let (first, rest) = ReadingLines.splitFirstLine(detail)
        guard let text = ReadingLines.match(ReadingLines.rec, ReadingLines.unbold(first)) else { return nil }
        let known = recLabel.map(ReadingLines.oneLine) ?? ""
        let sep = " — "
        var label: String
        var reason: String
        if !known.isEmpty && text.hasPrefix(known + sep) {
            label = known; reason = String(text.dropFirst(known.count + sep.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if !known.isEmpty && text == known {
            label = known; reason = ""
        } else if let at = text.range(of: sep) {
            label = text[..<at.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            reason = text[at.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            label = text; reason = ""
        }
        let plain = reason.isEmpty && label != (recLabel ?? "")
        return RecommendationLine(label: label, reason: reason, plain: plain, rest: rest)
    }
}

/// The lead's process posts folded into one line (web thread-view.ts processKind / foldThread / foldLabel).
enum ThreadFolding {
    enum Kind { case assign, renotify }

    /// A worker report followed by the lead within this time is a re-notice.
    static let renotifyWindow: TimeInterval = 2 * 60
    /// Only an assignment posted this soon after the owner's message folds.
    static let assignWindow: TimeInterval = 10 * 60

    private static let processKinds: Set<String> = ["진행", "알림"]
    private static let reportKinds: Set<String> = ["완료", "막힘", "진행", "알림"]
    private static let assignCue = try! NSRegularExpression(pattern: "맡겼|맡김|맡깁|맡기겠|배정했|나눠 맡")
    /// News (a failure, a block, a report that differs, a cause): such a lead post is not a repeat, so it stays open.
    private static let newsCue = try! NSRegularExpression(
        pattern: "실패|막힘|막혔|막힙|아직|다르|다릅|달리|달라|오류|에러|안\\s?됩|안\\s?돼|못\\s?했|못\\s?합|문제|틀렸|틀립|빠졌|빠집|다시 맡|되돌|취소|멈췄|멈춥|중단|원인|때문")
    /// The owner's message is a question: a lead post answering it is a reply, not an assignment, even when it hands off.
    private static let questionCue = try! NSRegularExpression(
        pattern: "[?？]|왜|어떻게|뭐|무엇|무슨|언제|어디|얼마|나요|까요|ㄹ까|는지|인가|가요\\s*$|니\\s*$")
    /// A re-notice folds only when its body is this short (non-blank lines); a longer one may carry news.
    static let renotifyMaxLines = 2

    /// Whether `list[i]` is a lead process post to fold, and which kind. Only earlier posts count, so a fold never opens
    /// again when later posts arrive.
    static func kind(_ list: [Message], _ i: Int, kindOf: (String?) -> String?, date: (String) -> Date?) -> Kind? {
        let m = list[i]
        guard isLeadProcess(m, kindOf: kindOf), let at = date(m.at) else { return nil }
        // News (a failure, a block, a report that differs, a cause) stays open.
        if matches(newsCue, "\(m.title)\n\(m.body)") { return nil }
        // Assignment: the lead's first 진행 right after the owner's message (only system notices between), naming a hand-off.
        if m.kind == "진행", m.fileId == nil, matches(assignCue, "\(m.title)\n\(firstLine(m.body))") {
            var j = i - 1
            while j >= 0 {
                let p = list[j]
                if p.kind == "시스템" && !p.mine { j -= 1; continue }
                if p.mine, !matches(questionCue, p.body.trimmingCharacters(in: .whitespacesAndNewlines)),
                   let pAt = date(p.at), at.timeIntervalSince(pAt) >= 0, at.timeIntervalSince(pAt) <= assignWindow { return .assign }
                break
            }
        }
        // Re-notice: within two minutes after a worker report, only the same lead's process posts or system notices between.
        var j = i - 1
        while j >= 0 {
            let p = list[j]
            if p.kind == "시스템" && !p.mine { j -= 1; continue }
            if p.memberId == m.memberId && isLeadProcess(p, kindOf: kindOf) { j -= 1; continue }
            guard isWorkerReport(p, kindOf: kindOf), let pAt = date(p.at) else { return nil }
            let gap = at.timeIntervalSince(pAt)
            guard gap >= 0, gap <= renotifyWindow else { return nil }
            if let file = m.fileId, file != p.fileId { return nil }
            if m.fileId == nil && lineCount(m.body) > renotifyMaxLines { return nil }
            return .renotify
        }
        return nil
    }

    /// "총괄 · 맡김 1건, 다시 알림 2건".
    static func label(assign: Int, renotify: Int) -> String {
        let parts = [assign > 0 ? "맡김 \(assign)건" : nil, renotify > 0 ? "다시 알림 \(renotify)건" : nil].compactMap { $0 }
        return "총괄 · " + parts.joined(separator: ", ")
    }

    /// The first post's title (or its body's first line), shown on the fold so it says what it hides (web foldPreview).
    static func preview(_ messages: [Message]) -> String {
        guard let m = messages.first else { return "" }
        let title = m.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return ReadingLines.oneLine(title.isEmpty ? firstLine(m.body) : title)
    }

    private static func isLeadProcess(_ m: Message, kindOf: (String?) -> String?) -> Bool {
        !m.mine && kindOf(m.memberId) == "conductor" && processKinds.contains(m.kind) && m.decisionId == nil
            && m.targetMemberId == nil && m.attachments.isEmpty && OwnerTurn.parse(m.body) == nil
    }

    private static func isWorkerReport(_ m: Message, kindOf: (String?) -> String?) -> Bool {
        guard !m.mine, m.memberId != nil, reportKinds.contains(m.kind) else { return false }
        let kind = kindOf(m.memberId)
        return kind != "conductor" && kind != "root"
    }

    private static func firstLine(_ text: String) -> String {
        text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    private static func lineCount(_ text: String) -> Int {
        text.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }

    private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

/// "결재 1건: 제목 · 권장 안 → 결재함" (web cardCopyText). Answered: "· 답함 안"; closed: "· 닫힘".
func decisionCopyText(_ message: Message, _ decision: Decision?) -> String {
    let title = (decision?.title ?? message.title).trimmingCharacters(in: .whitespacesAndNewlines)
    var tail = ""
    if let decision {
        switch decision.status {
        case "open":
            if let rec = decision.options.first(where: { $0.k == decision.rec })?.label { tail = " · 권장 \(rec)" }
        case "closed":
            tail = " · 닫힘"
        default:
            let answer = decision.options.first { $0.k == decision.choice }?.label ?? decision.note
            tail = answer.map { " · 답함 \($0)" } ?? " · 답함"
        }
    }
    return "결재 1건: \(title.isEmpty ? "제목 없음" : title)\(tail) → 결재함"
}

enum ReadingLines {
    static let owner = try! NSRegularExpression(pattern: "^●\\s*대표\\s*차례\\s*[:：]\\s*(.*\\S)\\s*$")
    static let rec = try! NSRegularExpression(pattern: "^★\\s*권장\\s*[:：]\\s*(.*\\S)\\s*$")
    static let ownerInbox = try! NSRegularExpression(pattern: "^(.*?)[\\s.]*(?:·\\s*|\\(\\s*)(결재함\\s*\\d+\\s*건)\\s*\\)?\\s*\\.?\\s*$")

    /// The first capture group, when the whole line matches.
    static func match(_ regex: NSRegularExpression, _ line: String) -> String? {
        guard let m = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
              let r = Range(m.range(at: 1), in: line) else { return nil }
        return String(line[r])
    }

    /// The first non-blank line and the rest (blank lines before the rest removed). CRLF and CR read as LF.
    static func splitFirstLine(_ text: String) -> (String, String) {
        var src = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        src = dropBlankLines(src)
        guard let at = src.firstIndex(of: "\n") else { return (src, "") }
        return (String(src[..<at]), dropBlankLines(String(src[src.index(after: at)...])))
    }

    /// Bold marks off ("**", "__").
    static func unbold(_ line: String) -> String {
        line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Runs of white space become one space.
    static func oneLine(_ value: String) -> String {
        value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Leading lines made only of spaces and tabs.
    private static func dropBlankLines(_ text: String) -> String {
        var rest = Substring(text)
        while let nl = rest.firstIndex(of: "\n"), rest[..<nl].allSatisfy({ $0 == " " || $0 == "\t" }) {
            rest = rest[rest.index(after: nl)...]
        }
        return String(rest)
    }
}
