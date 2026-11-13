import Foundation

// Z(0.2.6): 채팅의 '답 쓰는 중' 표시. 서버가 대표 글마다 정한 답 상태(`Message.reply`, shared/types.ts MessageReply)를 그리기만 한다.
// 앱은 전달·팀장 상태로 따로 추측하지 않는다(0.2.4 E3 원칙). 서버가 이 칸을 싣지 않으면(옛 서버) 아무것도 그리지 않는다.
// 하나만 앞서 지운다: 서버 규칙으로 답인 글이 이미 화면에 있으면 '답 쓰는 중'을 그리지 않는다(answeredOnScreen). 상태를 만들지는 않는다.
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

    /// 받는 이마다 한 줄. 차례는 그 글을 보낸 차례다. `names`: 팀장 id → 화면 이름(ChatView 의 chatReplyName: 그 팀장의 이름, 비었으면 직급).
    static func statuses(_ messages: [Message], names: [String: String], now: Date = Date()) -> [ChatReplyStatus] {
        var pending: [String: [(index: Int, message: Message, reply: MessageReply)]] = [:]
        var order: [String] = []
        let said = messages.contains { $0.mine && ($0.reply?.state == "working" || $0.reply?.state == "delivered") } ? lastSaid(messages) : [:]
        for (index, message) in messages.enumerated() where message.mine {
            guard let reply = message.reply else { continue }
            if settled.contains(reply.state) || answeredOnScreen(message, reply: reply, lastSaid: said) { pending[reply.memberId] = []; continue }
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

    /// 팀장마다 대화에 쓴 마지막 글의 시각. 서버가 만든 글(시스템 글, '대표 전달 지연')은 답이 아니라 세지 않는다(서버 Store.firstReply 와 같은 기준:
    /// 종류나 보낸 이가 '시스템'. 영어 화면에서는 보낸 이가 'System' 으로 바뀌어 있다).
    private static func lastSaid(_ messages: [Message]) -> [String: Date] {
        var out: [String: Date] = [:]
        // 영어 화면에서 서버 글의 보낸 이 '시스템'은 디코딩 때 이 이름으로 바뀌어 있다(ServerText.systemName 과 같은 열쇠).
        let system = String(localized: "message.kind.system", defaultValue: "시스템")
        for message in messages where !message.mine {
            guard let member = message.memberId, message.kind != "시스템", message.who != "시스템", message.who != system,
                  let at = parseISODate(message.at) else { continue }
            if out[member].map({ $0 < at }) ?? true { out[member] = at }
        }
        return out
    }

    /// 서버는 '이 글로 턴이 돈다(working)'·'받음(delivered)'이라고 했는데, 그 뒤(since 이후) 받는 이가 쓴 글이 이미 화면에 있다.
    /// 서버의 답 규칙(이 글의 답 창 안에서 그 팀장이 쓴 첫 글)으로도 답함이고, 서버의 '답함'은 곧 따로 온다(실시간 사건 둘이 앱에서 따로 그려지는 틈).
    /// 그 틈에 답 글과 '답 쓰는 중'을 함께 그리지 않는다. 앞 일을 마치는 중(behind)·보내는 중 등에서는 쓰지 않는다: 그때 쓴 글은 서버가 답으로 세지 않는다.
    private static func answeredOnScreen(_ message: Message, reply: MessageReply, lastSaid: [String: Date]) -> Bool {
        guard reply.state == "working" || reply.state == "delivered", let said = lastSaid[reply.memberId],
              let start = parseISODate(reply.since) ?? parseISODate(message.at) else { return false }
        return said >= start
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
