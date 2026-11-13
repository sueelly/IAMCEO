import Foundation

/// 서버가 보낸 오류·보류 문장을 화면 언어로(완성도 4차 R, B2. 2차 F 의 '코드로 가르기' 다음 단계).
///
/// - 한국어 화면: 받은 문장을 그대로 쓴다(바꾸기 전과 같다).
/// - 영어 화면: 문장이 그 코드의 대표 문장(ServerErrorText.ko)과 같으면 그 코드의 영어 문장을 쓴다.
///   이름·숫자가 끼어들어 대표 문장과 다르거나, 코드가 없는 옛 서버의 문장은 받은 그대로 둔다(뜻을 지어내지 않는다).
/// - 실행 엔진의 터미널 거절(core_*)은 서버 문장이 영어 내부 문구라, 영어 화면에서는 코드의 문장을 늘 쓴다.
extension ServerErrorText {
    static let alwaysFromCode: Set<String> = ["core_terminal_missing", "core_lease_required", "core_lease_other", "core_terminal_finished"]

    static func display(_ message: String, code: String?, reason: String? = nil, language: AppLanguage = AppLanguage.current) -> String {
        guard language == .en else { return message }
        for candidate in [reason, code].compactMap({ $0 }) {
            guard let entry = table[candidate] else { continue }
            if alwaysFromCode.contains(candidate) || normalized(message) == normalized(entry.ko) { return entry.en }
        }
        return message
    }

    /// 0.2.6 Y: 코드 없이 문장만 오는 서버의 전달 안내(note·추천)를 화면 언어로. 영어 화면에서 문장이 'note_' 코드의 대표 문장과
    /// 같을 때만 그 영어 문장이다. 한국어 화면과 모르는 문장은 받은 그대로.
    static func displayNote(_ message: String, language: AppLanguage = AppLanguage.current) -> String {
        guard language == .en, let code = noteCodes[normalized(message)], let entry = table[code] else { return message }
        return entry.en
    }

    /// 0.2.6 Y: 팀장 상태 관측의 메모(statusObservation.error). 코드 'observation_<code>' 의 대표 문장과 같거나 '<대표 문장>: <폴더>' 꼴이면
    /// 영어 화면에서 그 영어 문장(폴더는 그대로). 그 밖(CLI 원문 등)은 받은 그대로.
    static func displayObservation(_ note: String, code: String, language: AppLanguage = AppLanguage.current) -> String {
        guard language == .en, let entry = table["observation_" + code] else { return note }
        if normalized(note) == normalized(entry.ko) { return entry.en }
        let head = entry.ko + ": "
        return note.hasPrefix(head) ? entry.en + ": " + String(note.dropFirst(head.count)) : note
    }

    private static let noteCodes: [String: String] = {
        var out: [String: String] = [:]
        for (code, entry) in table where code.hasPrefix("note_") { out[normalized(entry.ko)] = code }
        return out
    }()

    /// 코드의 대표 문장을 화면 언어로. 모르는 코드는 nil.
    static func text(_ code: String, language: AppLanguage = AppLanguage.current) -> String? {
        table[code].map { language == .en ? $0.en : $0.ko }
    }

    /// `raw` 가 이 코드의 대표 문장인가(한국어든 영어든). 문장만 남은 자리(연결 오류 줄 등)에서 코드를 되찾을 때 쓴다.
    static func matches(_ raw: String, code: String) -> Bool {
        guard let entry = table[code] else { return false }
        let text = normalized(raw)
        return text == normalized(entry.ko) || text == normalized(entry.en)
    }

    private static func normalized(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix(".") || value.hasSuffix("。") { value.removeLast() }
        return value
    }
}
