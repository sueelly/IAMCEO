import Foundation
import XCTest
@testable import IAMCEO

/// Z(0.2.6): 채팅의 '답 쓰는 중' 표시. 서버가 대표 글마다 정한 답 상태(`Message.reply`)를 그대로 그린다.
/// 앱은 따로 추측하지 않는다: reply 가 없으면(옛 서버) 아무것도 그리지 않는다.
final class ReplyIndicatorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_900_000_000)
    private func iso(_ secondsAgo: TimeInterval) -> String { SampleWorkspace.format(now.addingTimeInterval(-secondsAgo)) }
    private func mine(_ id: String, _ reply: MessageReply?, target: String? = nil) -> Message {
        Message(id: id, projectId: "p", at: iso(600), mine: true, who: "나", kind: "나", body: id, targetMemberId: target, delivery: "delivered", reply: reply)
    }
    private func reply(_ state: String, _ member: String = "lead", since: TimeInterval = 10, reason: String? = nil) -> MessageReply {
        MessageReply(state: state, memberId: member, since: iso(since), reason: reason)
    }
    private let names = ["lead": "결제 총괄", "card": "카드 결제 구현", "copy": "화면 문구"]
    private func statuses(_ messages: [Message]) -> [ChatReplyStatus] { ChatReplyBoard.statuses(messages, names: names, now: now) }

    // MARK: 해석

    func testDecodesTheServerFieldAndToleratesAMalformedOne() throws {
        let base = #""id":"m1","projectId":"p","at":"2026-11-14T01:00:00.000Z","mine":true,"who":"나","kind":"나","body":"지시""#
        let full = try JSONDecoder().decode(Message.self, from: Data(#"{\#(base),"reply":{"state":"working","memberId":"lead","since":"2026-11-14T01:00:01.000Z"}}"#.utf8))
        XCTAssertEqual(full.reply, MessageReply(state: "working", memberId: "lead", since: "2026-11-14T01:00:01.000Z"))
        let blocked = try JSONDecoder().decode(Message.self, from: Data(#"{\#(base),"reply":{"state":"blocked","memberId":"lead","since":"2026-11-14T01:00:01.000Z","reason":"approval"}}"#.utf8))
        XCTAssertEqual(blocked.reply?.reason, "approval")
        // 옛 서버: 칸이 없다. 모양이 어긋난 칸은 없는 것으로 읽고 글은 그대로 보인다.
        XCTAssertNil(try JSONDecoder().decode(Message.self, from: Data("{\(base)}".utf8)).reply)
        let broken = try JSONDecoder().decode(Message.self, from: Data(#"{\#(base),"reply":{"state":3}}"#.utf8))
        XCTAssertNil(broken.reply)
        XCTAssertEqual(broken.body, "지시")
        // 기기에 남기는 사본(마지막으로 본 상태)에도 그대로 실린다.
        let again = try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(full))
        XCTAssertEqual(again.reply, full.reply)
    }

    // MARK: 맨 아래 줄

    func testWorkingShowsTypingDotsAndAfterAMinuteTheTime() {
        let typing = statuses([mine("m1", reply("working", since: 20))])
        XCTAssertEqual(typing.map(\.label), ["결제 총괄이 답을 쓰는 중…"])
        XCTAssertEqual(typing.first?.typing, true)
        XCTAssertEqual(typing.first?.tone, .live)
        XCTAssertEqual(typing.first?.accessibilityLabel, "결제 총괄이 답을 쓰는 중")
        XCTAssertEqual(statuses([mine("m1", reply("working", since: 3 * 60 + 5))]).map(\.label), ["결제 총괄이 읽고 일하는 중 · 3분째"])
        XCTAssertEqual(statuses([mine("m1", reply("working", since: 2 * 3600))]).map(\.label), ["결제 총괄이 읽고 일하는 중 · 2시간째"])
        XCTAssertEqual(statuses([mine("m1", reply("delivered"))]).map(\.label), ["결제 총괄이 읽는 중…"])
        XCTAssertEqual(statuses([mine("m1", reply("delivered"))]).first?.typing, true)
    }

    func testWaitingAndBlockedSayWhyWithoutTypingDots() {
        let cases: [(MessageReply, String, Tone)] = [
            (reply("behind", "card", since: 125, reason: "member_busy"), "카드 결제 구현이 앞 일을 마치는 중 · 2분째", .neutral),
            (reply("checking", "card", reason: "receipt_check"), "카드 결제 구현에게 전달됐는지 확인하는 중", .neutral),
            (reply("waking", "card", reason: "waking"), "카드 결제 구현을 깨우는 중", .neutral),
            (reply("queued", "card", reason: "unknown"), "카드 결제 구현에게 보내는 중", .neutral),
            (reply("queued", "card", reason: "run_limit"), "카드 결제 구현이 차례를 기다리는 중", .neutral),
            (reply("blocked", "card", reason: "approval"), "카드 결제 구현이 승인 창 앞에서 기다리는 중", .approval),
            (reply("blocked", "card", reason: "usage_limit"), "카드 결제 구현이 사용 한도가 풀리기를 기다리는 중", .attention),
            (reply("blocked", "card", reason: "api_outage"), "카드 결제 구현이 인터넷 연결을 기다리는 중", .attention),
            (reply("blocked", "card", reason: "error"), "카드 결제 구현이 오류로 멈춤", .danger),
            (reply("blocked", "card", reason: "runner_off"), "실행이 꺼져 있어 카드 결제 구현에게 보내지 못하는 중", .attention),
        ]
        for (value, label, tone) in cases {
            let row = statuses([mine("m1", value, target: "card")])
            XCTAssertEqual(row.map(\.label), [label], value.state)
            XCTAssertEqual(row.first?.tone, tone, value.state)
            XCTAssertEqual(row.first?.typing, false, value.state)
        }
    }

    func testFinishedOldOrUnknownStatesDrawNothing() {
        XCTAssertEqual(statuses([mine("m1", reply("replied"))]), [])
        XCTAssertEqual(statuses([mine("m1", reply("no_reply"))]), [])
        XCTAssertEqual(statuses([mine("m1", reply("stopped"))]), [])
        XCTAssertEqual(statuses([mine("m1", nil)]), [], "옛 서버: reply 가 없으면 추측하지 않는다")
        XCTAssertEqual(statuses([mine("m1", reply("typing_harder"))]), [], "모르는 상태는 그리지 않는다")
        // 그 팀장이 뒤 글에 답했으면 앞 글이 '받음'에 머물러 있어도(직접 띄운 세션 등) 더 볼 것이 없다.
        XCTAssertEqual(statuses([mine("m1", reply("delivered")), mine("m2", reply("replied"))]), [])
    }

    func testOneLinePerRecipientPreferringTheTurnThatCarriesMyMessage() {
        // 총괄은 앞 글로 일하는 중이고 뒤 글은 그 일 뒤에 기다린다: '답 쓰는 중'이 그 팀장의 한 줄이다(뒤 글의 대기 줄은 그 글 아래에 남는다).
        let rows = statuses([
            mine("m1", reply("working", since: 30)),
            mine("m2", reply("behind", reason: "member_busy")),
            mine("m3", reply("working", "card", since: 30), target: "card"),
        ])
        XCTAssertEqual(rows.map(\.memberID), ["lead", "card"])
        XCTAssertEqual(rows.map(\.messageID), ["m1", "m3"])
        XCTAssertEqual(rows.map(\.label), ["결제 총괄이 답을 쓰는 중…", "카드 결제 구현이 답을 쓰는 중…"])
        // 같은 순위면 나중 글이 말한다.
        XCTAssertEqual(statuses([mine("m1", reply("behind", reason: "member_busy")), mine("m2", reply("behind", reason: "member_busy"))]).map(\.messageID), ["m2"])
        // 명부에 없는 팀장은 글에 적힌 받는 이 이름으로.
        var gone = mine("m9", reply("working", "closed", since: 5), target: "closed")
        gone.targetName = "닫은 팀장"
        XCTAssertEqual(statuses([gone]).map(\.label), ["닫은 팀장이 답을 쓰는 중…"])
    }

    // MARK: 답 글이 먼저 화면에 온 틈 (0.2.6 사본 확인: 답 카드와 '답 쓰는 중'이 2~4초 함께 보였다)

    /// 서버의 '답함'과 답 글은 따로 오는 실시간 사건이고, 앱은 사건마다 화면을 다시 그린다. 답 글이 먼저 그려진 틈에 '답 쓰는 중'을 함께 그리지 않는다.
    /// 기준은 서버의 답 규칙 그대로다: 이 글의 턴이 돈다(working)·받음(delivered)일 때 그 시각 이후 그 팀장이 쓴 글(서버 글 제외)이면 답이다.
    func testAnAnswerAlreadyOnScreenEndsTheTypingLineBeforeTheServersReplied() {
        func said(_ id: String, _ member: String, _ secondsAgo: TimeInterval, who: String = "결제 총괄", kind: String = "완료") -> Message {
            Message(id: id, projectId: "p", at: iso(secondsAgo), mine: false, memberId: member, who: who, kind: kind, body: id)
        }
        let working = mine("m1", reply("working", since: 30))
        XCTAssertEqual(statuses([working]).map(\.messageID), ["m1"])
        XCTAssertEqual(statuses([working, said("a1", "lead", 10)]), [])
        XCTAssertEqual(statuses([mine("m1", reply("delivered", since: 30)), said("a1", "lead", 10)]), [])
        XCTAssertNil(ChatReplyBoard.footnote(working.reply), "앞서 지울 뿐 '답 없음' 같은 상태를 만들지 않는다")
        // 서버가 만든 글(결과 보고 누락·팀장 오류·대표 전달 지연, 영어 화면에서 보낸 이가 'System' 으로 바뀐 글)은 답이 아니다.
        for note in [said("s1", "lead", 10, who: "시스템", kind: "시스템"), said("s2", "lead", 10, who: "시스템", kind: "막힘"),
                     said("s3", "lead", 10, who: ServerText.systemName("시스템"), kind: "막힘")] {
            XCTAssertEqual(statuses([working, note]).map(\.messageID), ["m1"], note.id)
        }
        // 이 턴이 시작되기 전에 쓴 글, 다른 팀장의 글은 이 글의 답이 아니다.
        XCTAssertEqual(statuses([working, said("a0", "lead", 60)]).map(\.messageID), ["m1"])
        XCTAssertEqual(statuses([working, said("c1", "card", 10, who: "카드 결제 구현")]).map(\.messageID), ["m1"])
        // 앞 일을 마치는 중·보내는 중에 쓴 글은 앞 일의 보고다(서버도 답으로 세지 않는다).
        XCTAssertEqual(statuses([mine("m1", reply("behind", since: 30, reason: "member_busy")), said("a1", "lead", 10)]).map(\.messageID), ["m1"])
        XCTAssertEqual(statuses([mine("m1", reply("queued", since: 30, reason: "unknown")), said("a1", "lead", 10)]).map(\.messageID), ["m1"])
        // 받는 이마다 따로: 총괄은 답했고 카드 결제 구현은 아직 쓰는 중이다.
        let rows = statuses([working, mine("m2", reply("working", "card", since: 30), target: "card"), said("a1", "lead", 10)])
        XCTAssertEqual(rows.map(\.memberID), ["card"])
        // 답 글은 그 글에만: 같은 팀장에게 뒤에 보낸 글이 아직 '받음'(그 답 뒤에 받음)이면 그 줄은 남는다.
        XCTAssertEqual(statuses([working, said("a1", "lead", 20), mine("m3", reply("delivered", since: 10))]).map(\.messageID), ["m3"])
    }

    /// 같은 글의 옛 응답(전달 판 번호가 낮다: 늦게 도착한 보내기 응답 등)이 더 새 답 상태를 되돌리지 않는다. 같은 판이면 나중에 온 쪽이다.
    func testAnOlderSnapshotOfMyMessageNeverRollsTheReplyBack() throws {
        var history = ChatHistory(key: ChatHistoryKey(namespace: "host", connectionGeneration: UUID(), projectID: "p", scope: .project))
        let request = try XCTUnwrap(history.begin(.initial))
        var sent = mine("m1", reply("queued", since: 40, reason: "unknown")); sent.delivery = "queued"; sent.deliveryRevision = 0
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: .project, items: [sent], nextCursor: nil, hasOlder: false), request: request))
        var received = mine("m1", reply("working", since: 30)); received.deliveryRevision = 1
        history.receive(received)
        history.receive(sent)
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        XCTAssertEqual(history.items.first?.reply?.state, "working", "늦게 온 판 0 응답이 '답 쓰는 중'을 '보내는 중'으로 되돌렸다")
        var answered = received; answered.reply = reply("replied", since: 5)
        history.receive(answered)
        XCTAssertEqual(history.items.first?.reply?.state, "replied", "같은 판 안에서 답 상태만 바뀐 사건은 그대로 반영한다")
        // 대화 페이지·보내기 응답·접수 기록이 모두 지나는 한 곳(Message.mergingDelivery)의 규칙이다.
        XCTAssertEqual(sent.mergingDelivery(from: answered).reply?.state, "replied")
        XCTAssertEqual(answered.mergingDelivery(from: received).reply?.state, "replied")
    }

    // MARK: 이름

    /// 서버는 총괄 이름을 그때의 보고 언어로 짓는다('X 총괄'·'X Lead'). 화면 언어와 달라도 직급을 앞에 겹쳐 붙이지 않는다
    /// (영어 화면의 'Lead check 총괄 is replying…'). 이름을 바꿔 직급이 빠진 총괄에게만 붙이고, 이름이 비면 직급으로 부른다.
    func testReplyLineNamesTheRecipientWithoutDoublingTheRank() {
        func lead(_ name: String, kind: String = "conductor") -> Member { Member(id: "lead", projectId: "p", name: name, kind: kind) }
        XCTAssertEqual(chatReplyName(lead("결제 총괄")), "결제 총괄")
        XCTAssertEqual(chatReplyName(lead("check Lead")), "check Lead", "영어 보고 언어로 지은 이름을 한국어 화면에서 '총괄 check Lead' 로 만들지 않는다")
        XCTAssertEqual(chatReplyName(lead("하나")), "총괄 하나")
        XCTAssertEqual(chatReplyName(lead("")), "총괄")
        XCTAssertEqual(chatReplyName(lead("HQ AI", kind: "root")), "HQ AI")
        XCTAssertEqual(chatReplyName(Member(id: "w", projectId: "p", name: "카드 결제 구현", kind: "worker")), "카드 결제 구현")
        XCTAssertEqual(chatReplyName(Member(id: "w", projectId: "p", name: "", kind: "worker")), "팀장")
        let statuses = ChatReplyBoard.statuses([mine("m1", reply("working", since: 20))], names: ["lead": chatReplyName(lead("check Lead"))], now: now)
        XCTAssertEqual(statuses.count, 1)
        XCTAssertTrue(statuses.first?.label.hasPrefix("check Lead") == true, statuses.first?.label ?? "")
        XCTAssertFalse(statuses.first?.label.contains("총괄") == true, statuses.first?.label ?? "")
    }

    // MARK: 내 글 아래 줄

    func testNoReplyAndStoppedLinesUnderMyMessage() {
        XCTAssertEqual(ChatReplyBoard.footnote(reply("no_reply")), "읽었지만 답하지 않았습니다")
        XCTAssertEqual(ChatReplyBoard.footnote(reply("stopped")), "답하기 전에 멈췄습니다")
        for state in ["replied", "working", "behind", "blocked"] { XCTAssertNil(ChatReplyBoard.footnote(reply(state)), state) }
        XCTAssertNil(ChatReplyBoard.footnote(nil))
    }

    // MARK: 동작 줄이기

    func testDotsStayStillWithReduceMotionOrOffScreen() {
        XCTAssertTrue(ChatReplyBoard.dotsMove(reduceMotion: false, tabVisible: true))
        XCTAssertFalse(ChatReplyBoard.dotsMove(reduceMotion: true, tabVisible: true))
        XCTAssertFalse(ChatReplyBoard.dotsMove(reduceMotion: false, tabVisible: false))
    }

    // MARK: 영어

    /// 영어 화면: 조사가 빠지고, 문구 표의 영어 문장으로 그린다(시험에는 언어 표가 없어 표를 직접 읽어 같은 값으로 채워 본다).
    func testEnglishLinesReadNaturally() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("Resources/Shared/Localizable.xcstrings")))
        let strings = try XCTUnwrap((object as? [String: Any])?["strings"] as? [String: [String: Any]])
        func english(_ key: String) throws -> String {
            let localizations = try XCTUnwrap(strings[key]?["localizations"] as? [String: Any], key)
            let unit = try XCTUnwrap((localizations["en"] as? [String: Any])?["stringUnit"] as? [String: Any], key)
            return try XCTUnwrap(unit["value"] as? String, key)
        }
        AppLanguage.withOverride(.en) { XCTAssertEqual(subjectParticle("Checkout Lead"), "") }
        XCTAssertEqual(String(format: try english("%@%@ 답을 쓰는 중…"), "Checkout Lead", ""), "Checkout Lead is replying…")
        XCTAssertEqual(String(format: try english("%@%@ 읽고 일하는 중"), "Checkout Lead", ""), "Checkout Lead is working on it")
        XCTAssertEqual(String(format: try english("%@ · %lld분째"), String(format: try english("%@%@ 읽고 일하는 중"), "Lead", ""), 3), "Lead is working on it · 3 min")
        XCTAssertEqual(String(format: try english("%@%@ 앞 일을 마치는 중"), "Card Checkout", ""), "Card Checkout is finishing earlier work")
        XCTAssertEqual(String(format: try english("%@%@ 깨우는 중"), "Card Checkout", ""), "Waking Card Checkout")
        XCTAssertEqual(String(format: try english("%@에게 전달됐는지 확인하는 중"), "Card Checkout"), "Checking that Card Checkout got it")
        XCTAssertEqual(try english("읽었지만 답하지 않았습니다"), "Read, but no reply")
        XCTAssertEqual(try english("답하기 전에 멈췄습니다"), "Stopped before replying")
        // 화면에 나오는 줄의 열쇠는 모두 표에 영어와 함께 있다(LocalizationCatalogTests 가 소스 전체로도 본다).
        for key in ["%@%@ 읽는 중…", "%@%@ 승인 창 앞에서 기다리는 중", "%@%@ 사용 한도가 풀리기를 기다리는 중", "%@%@ 인터넷 연결을 기다리는 중",
                    "%@%@ 터미널에서 직접 조작되는 중", "실행이 꺼져 있어 %@에게 보내지 못하는 중", "보관한 프로젝트라 %@에게 보내지 않음",
                    "%@%@ 오류로 멈춤", "%@%@ 멈춰 있음", "%@%@ 차례를 기다리는 중", "%@에게 다시 보내는 중", "%@에게 보내는 중"] {
            XCTAssertFalse(SourceLiterals.hasHangul(try english(key)), key)
        }
    }
}

/// 샘플(심사·스크린샷): 지시를 보내면 답이 오기 전 잠깐 '답 쓰는 중' 줄이 보이고, 답이 오면 사라진다.
@MainActor
final class SampleReplyIndicatorTests: XCTestCase {
    func testSampleShowsReplyingUntilTheMemberAnswers() async throws {
        let store = AppStore(demo: true)
        defer { store.prepareForReplacement() }
        let server = try XCTUnwrap(store.sampleServer)
        // 받기까지 짧게. 답은 저절로 나가지 않게 길게 두고, '답 쓰는 중'을 본 뒤 시험이 직접 낸다(실제 시간의 짧은 틈에 기대지 않는다).
        server.deliveryDelay = .milliseconds(30); server.replyDelay = .seconds(600)
        try await waitWhile({ !(store.connectionStatus == .connected && store.state != nil && store.canWrite) }, timeout: .seconds(15))
        let sent = await store.sendMessage(text: "결제 버튼 색을 바꿔 주세요", targetMemberID: "m-card")
        XCTAssertTrue(sent)
        await pollUntil("답 쓰는 중") { store.messages.first { $0.mine && $0.body == "결제 버튼 색을 바꿔 주세요" }?.reply?.state == "working" }
        let mineNow = try XCTUnwrap(store.messages.first { $0.mine && $0.body == "결제 버튼 색을 바꿔 주세요" })
        XCTAssertEqual(mineNow.reply?.memberId, "m-card")
        let rows = ChatReplyBoard.statuses(store.messages, names: Dictionary(uniqueKeysWithValues: store.members.map { ($0.id, $0.name) }))
        XCTAssertEqual(rows.map(\.label), ["카드 결제 구현이 답을 쓰는 중…"])
        XCTAssertEqual(rows.first?.typing, true)
        XCTAssertFalse(store.messages.contains { $0.memberId == "m-card" && $0.title == "지시를 받았습니다" })
        server.acknowledgeNow(messageID: mineNow.id)
        await pollUntil("답함") { store.messages.first { $0.mine && $0.body == "결제 버튼 색을 바꿔 주세요" }?.reply?.state == "replied" }
        XCTAssertTrue(store.messages.contains { $0.memberId == "m-card" && $0.title == "지시를 받았습니다" })
        XCTAssertEqual(ChatReplyBoard.statuses(store.messages, names: [:]), [])
    }
}

/// 동기화가 소켓을 앞지른 틈: 앱이 소켓 사건을 아직 처리하지 못했는데 그 사건들까지 담은 동기화 응답이 먼저 반영되면, 그 사건들은 순번상
/// '이미 본 것'으로 버려진다. 동기화(state)에는 대화 기록이 없으므로, 버려진 대표 글의 '답함'이 대화에 다음 대화 읽기까지 반영되지 않았다.
private final class ReplyRaceServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    var seq = 0
    var messages: [Message] = []
    var pageReads = 0
    func change(_ body: (ReplyRaceServer) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (ReplyRaceServer) -> T) -> T { lock.withLock { body(self) } }
    private func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply { IsolatedTestHTTPReply(data: try JSONEncoder().encode(value)) }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let projectID = query.first { $0.name == "projectId" }?.value
        let bootstrap = Bootstrap(projects: [ProjectSummary(id: "p")])
        let state = ProjectState(project: Project(id: "p", name: "p"), members: [Member(id: "lead", projectId: "p", name: "결제 총괄", kind: "conductor")], messages: messages)
        switch request.url!.path {
        case "/api/bootstrap": return try reply(bootstrap)
        case "/api/capabilities": return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(paging: true, realtime: true)))
        case "/api/runtime": return IsolatedTestHTTPReply()
        case "/api/projects/p/state": return try reply(state)
        case "/api/sync":
            return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: "E", seq: seq), requestedProjectId: projectID,
                projectStatus: projectID == nil ? .none : .ok, bootstrap: bootstrap, state: projectID == nil ? nil : state, revisions: nil))
        case "/api/projects/p/messages/page":
            pageReads += 1
            return try reply(MessagePage(projectId: "p", scope: .project, items: messages, nextCursor: nil, hasOlder: false))
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}

@MainActor
final class ReplyRealtimeRaceTests: XCTestCase {
    private func frame(_ socket: IsolatedTestWebSocket, seq: Int, message: Message) async throws {
        let body = try XCTUnwrap(String(data: JSONEncoder().encode(message), encoding: .utf8))
        try await socket.enqueue(.success(Data(#"{"type":"message","epoch":"E","seq":\#(seq),"message":\#(body)}"#.utf8)))
    }

    func testASyncThatOvertakesTheSocketStillBringsTheReplyIntoTheConversation() async throws {
        let server = ReplyRaceServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        var sent = Message(id: "m1", projectId: "p", at: "2026-11-14T01:00:00.000Z", mine: true, who: "나", kind: "나", body: "상황을 알려 주세요",
                           targetMemberId: "lead", delivery: "delivered", deliveryRevision: 1,
                           reply: MessageReply(state: "working", memberId: "lead", since: "2026-11-14T01:00:01.000Z"))
        server.change { $0.messages = [sent] }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false,
                             realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        defer { store.disconnect() }
        await pollUntil("소켓") { await factory.sockets.count == 1 }
        let opened = await factory.sockets.first
        let socket = try XCTUnwrap(opened)
        try await socket.enqueue(.success(Data(#"{"type":"hello","protocol":2,"epoch":"E","seq":0,"heartbeatMs":15000,"staleAfterMs":45000}"#.utf8)))
        await pollUntil("동기화 시작") { store.realtimeStatus == .syncing || store.realtimeStatus == .live }
        await settleAndAdvance(clock, .milliseconds(500))
        await pollUntil("실시간") { store.realtimeStatus == .live }
        await store.activateHistory()
        XCTAssertEqual(store.history?.items.first { $0.id == "m1" }?.reply?.state, "working")
        let reads = server.read { $0.pageReads }

        // 서버: 총괄이 답했다. 사건 1 은 답 글, 사건 2 는 대표 글의 '답함'(0.2.6 서버는 '답함'을 먼저 내지만 순서와 무관하게 맞아야 한다).
        let answer = Message(id: "a1", projectId: "p", at: "2026-11-14T01:00:20.000Z", memberId: "lead", who: "결제 총괄", kind: "완료",
                             body: "확인했습니다", deliveryRevision: 0)
        sent.reply = MessageReply(state: "replied", memberId: "lead", since: answer.at)
        server.change { $0.messages = [sent, answer]; $0.seq = 2 }
        try await frame(socket, seq: 1, message: answer)
        await pollUntil("답 글") { store.receivedCursor?.seq == 1 && store.history?.items.contains { $0.id == "a1" } == true }
        // 사건 2 를 처리하기 전에 그 사건까지 담은 동기화(순번 2)가 먼저 반영된다.
        await settleAndAdvance(clock, .milliseconds(250))
        await pollUntil("동기화 반영") { store.appliedSnapshotCursor?.seq == 2 }
        try await frame(socket, seq: 2, message: sent)
        // 사건 2 는 이미 본 순번이라 버려진다. 동기화가 앞질렀으니 대화 기록을 다시 읽어 '답함'을 들인다.
        await pollUntil("대화에 답함") { store.history?.items.first { $0.id == "m1" }?.reply?.state == "replied" }
        XCTAssertGreaterThan(server.read { $0.pageReads }, reads)
        XCTAssertEqual(ChatReplyBoard.statuses(store.history?.items ?? [], names: [:]), [])
    }
}
