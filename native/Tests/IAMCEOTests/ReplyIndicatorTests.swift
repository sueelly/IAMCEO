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
