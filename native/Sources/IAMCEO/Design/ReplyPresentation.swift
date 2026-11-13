import Foundation

// Z(0.2.6): 채팅의 '답 쓰는 중' 표시. 서버가 대표 글마다 정한 답 상태(`Message.reply`, shared/types.ts MessageReply)를 그리기만 한다.
// 앱은 전달·팀장 상태로 따로 추측하지 않는다(0.2.4 E3 원칙). 서버가 이 칸을 싣지 않으면(옛 서버) 아무것도 그리지 않는다.
// iPhone·Mac 같은 규칙. 대화 화면에만 쓴다(대화 목록·홈의 팀장 줄에는 넣지 않는다).

/// 대표 글 하나의 답 상태. state: queued 보내는 중 · behind 앞 일을 마치는 중 · waking 깨우는 중 · checking 넣었는지 확인 중 ·
/// blocked 막힘 · delivered 받음(턴 시작 전) · working 이 글의 턴이 도는 중 · replied 답함 · no_reply 답 없이 끝남 · stopped 답하기 전에 멈춤.
/// 모르는 state 는 그리지 않는다(다음 서버가 더해도 이 앱은 조용하다).
struct MessageReply: Codable, Sendable, Equatable {
    let state: String
    let memberId: String
    var since: String? = nil
    /// queued·behind·waking·checking·blocked 의 까닭(서버의 waitReason, 또는 턴 도중의 approval·usage_limit·api_outage·error).
    var reason: String? = nil
}

/// 대화 맨 아래 한 줄: 그 팀장이 내 글에 어떻게 하고 있는가.
struct ChatReplyStatus: Equatable, Identifiable, Sendable {
    /// 이 줄이 대신 말하는 내 글. 그 글의 발바닥에서는 대기 사유 줄을 빼고(같은 말을 두 번 하지 않는다) 여기서 말한다.
    let messageID: String
    let memberID: String
    let state: String
    let label: String
    let tone: Tone
    /// 받은 팀장이 이 글로 턴을 돌리고 있다: 움직이는 점 세 개.
    let typing: Bool
    var id: String { memberID }
    /// VoiceOver: 말줄임표 없이.
    var accessibilityLabel: String { label.hasSuffix("…") ? String(label.dropLast()) : label }
}

enum ChatReplyBoard {
    /// 맨 아래에 줄을 그리는 상태(아직 끝나지 않은 것).
    static let open: Set<String> = ["queued", "behind", "waking", "checking", "blocked", "delivered", "working"]
    /// 끝난 상태. 이보다 앞선 내 글은 그 팀장에 대해 더 볼 것이 없다.
    static let settled: Set<String> = ["replied", "no_reply", "stopped"]

    /// 한 팀장에게 아직 끝나지 않은 내 글이 여럿이면, 그 팀장이 지금 실제로 하고 있는 쪽을 말한다(이 글로 턴이 돌면 앞 일 줄보다 먼저).
    private static func rank(_ state: String) -> Int {
        switch state {
        case "working": 6
        case "delivered": 5
        case "blocked": 4
        case "checking": 3
        case "waking": 2
        case "behind": 1
        default: 0
        }
    }

    /// 받는 이마다 한 줄. 차례는 그 글을 보낸 차례다. `names`: 팀장 id → 화면 이름(총괄은 '결제 총괄'처럼 직급이 드러나는 이름).
    static func statuses(_ messages: [Message], names: [String: String], now: Date = Date()) -> [ChatReplyStatus] {
        var pending: [String: [(index: Int, message: Message, reply: MessageReply)]] = [:]
        var order: [String] = []
        for (index, message) in messages.enumerated() where message.mine {
            guard let reply = message.reply else { continue }
            if settled.contains(reply.state) { pending[reply.memberId] = []; continue }
            guard open.contains(reply.state) else { continue }
            if !order.contains(reply.memberId) { order.append(reply.memberId) }
            pending[reply.memberId, default: []].append((index, message, reply))
        }
        var rows: [(index: Int, status: ChatReplyStatus)] = []
        for memberID in order {
            // 같은 순위면 나중 글.
            guard let pick = pending[memberID]?.max(by: { rank($0.reply.state) == rank($1.reply.state) ? $0.index < $1.index : rank($0.reply.state) < rank($1.reply.state) }) else { continue }
            let who = names[memberID] ?? pick.message.targetName ?? String(localized: "총괄")
            rows.append((pick.index, status(pick.message.id, reply: pick.reply, name: who, now: now)))
        }
        return rows.sorted { $0.index < $1.index }.map(\.status)
    }

    static func status(_ messageID: String, reply: MessageReply, name: String, now: Date = Date()) -> ChatReplyStatus {
        ChatReplyStatus(messageID: messageID, memberID: reply.memberId, state: reply.state, label: label(reply, name: name, now: now),
                        tone: tone(reply), typing: reply.state == "working" || reply.state == "delivered")
    }

    /// 한 줄의 말. 일하는 중이 1분을 넘으면 '읽고 일하는 중 · N분째', 기다림·막힘에도 1분이 넘으면 걸린 시간을 붙인다.
    static func label(_ reply: MessageReply, name: String, now: Date = Date()) -> String {
        let s = subjectParticle(name), o = objectParticle(name)
        let minutes = reply.since.flatMap(parseISODate).map { Int(now.timeIntervalSince($0) / 60) } ?? 0
        switch reply.state {
        case "working":
            return minutes < 1 ? String(localized: "\(name)\(s) 답을 쓰는 중…") : elapsed(String(localized: "\(name)\(s) 읽고 일하는 중"), since: reply.since, now: now)
        case "delivered":
            return String(localized: "\(name)\(s) 읽는 중…")
        case "behind":
            return elapsed(String(localized: "\(name)\(s) 앞 일을 마치는 중"), since: reply.since, now: now)
        case "waking":
            return elapsed(String(localized: "\(name)\(o) 깨우는 중"), since: reply.since, now: now)
        case "checking":
            return elapsed(String(localized: "\(name)에게 전달됐는지 확인하는 중"), since: reply.since, now: now)
        case "blocked":
            let base: String
            switch reply.reason {
            case "approval": base = String(localized: "\(name)\(s) 승인 창 앞에서 기다리는 중")
            case "usage_limit": base = String(localized: "\(name)\(s) 사용 한도가 풀리기를 기다리는 중")
            case "api_outage": base = String(localized: "\(name)\(s) 인터넷 연결을 기다리는 중")
            case "manual_control": base = String(localized: "\(name)\(s) 터미널에서 직접 조작되는 중")
            case "runner_off": base = String(localized: "실행이 꺼져 있어 \(name)에게 보내지 못하는 중")
            case "archived": base = String(localized: "보관한 프로젝트라 \(name)에게 보내지 않음")
            case "error": base = String(localized: "\(name)\(s) 오류로 멈춤")
            default: base = String(localized: "\(name)\(s) 멈춰 있음")
            }
            return elapsed(base, since: reply.since, now: now)
        default:
            switch reply.reason {
            case "run_limit": return elapsed(String(localized: "\(name)\(s) 차례를 기다리는 중"), since: reply.since, now: now)
            case "retry_wait": return elapsed(String(localized: "\(name)에게 다시 보내는 중"), since: reply.since, now: now)
            default: return elapsed(String(localized: "\(name)에게 보내는 중"), since: reply.since, now: now)
            }
        }
    }

    /// 색은 뜻이 있을 때만: 일하는 중은 보라, 대표가 풀어야 하는 막힘은 승인 색, 저절로 풀리는 막힘은 주의 색, 오류는 위험 색.
    static func tone(_ reply: MessageReply) -> Tone {
        switch reply.state {
        case "working", "delivered": .live
        case "blocked":
            switch reply.reason {
            case "approval": .approval
            case "error": .danger
            default: .attention
            }
        default: .neutral
        }
    }

    /// 내 글 아래 작은 줄: 답 없이 끝났거나 답하기 전에 멈췄다.
    static func footnote(_ reply: MessageReply?) -> String? {
        switch reply?.state {
        case "no_reply": String(localized: "읽었지만 답하지 않았습니다")
        case "stopped": String(localized: "답하기 전에 멈췄습니다")
        default: nil
        }
    }

    /// 점 세 개가 움직이는가. '동작 줄이기'를 켰거나 그 탭이 화면에 없으면 멈춘 점이다(반복 애니메이션은 화면 주사율로 계속 돈다).
    static func dotsMove(reduceMotion: Bool, tabVisible: Bool) -> Bool { !reduceMotion && tabVisible }

    /// 걸린 시간 꼬리(대기 사유 줄 waitReasonLabel 과 같은 말: '· 3분째').
    static func elapsed(_ base: String, since: String?, now: Date) -> String {
        guard let since, let start = parseISODate(since) else { return base }
        let minutes = Int(now.timeIntervalSince(start) / 60)
        if minutes < 1 { return base }
        if minutes < 60 { return String(localized: "\(base) · \(minutes)분째") }
        let hours = minutes / 60
        return hours < 24 ? String(localized: "\(base) · \(hours)시간째") : String(localized: "\(base) · \(hours / 24)일째")
    }
}
