import Foundation

struct CLIApprovalOption: Decodable, Sendable, Identifiable {
    let n: Int
    let label: String
    let reject: Bool
    var id: Int { n }
}

struct CLIApprovalPrompt: Decodable, Sendable {
    let title: String
    let body: String
    let question: String
    let options: [CLIApprovalOption]
    let fingerprint: String

    private enum CodingKeys: String, CodingKey { case title, body, question, options, fingerprint }
    init(title: String, body: String, question: String, options: [CLIApprovalOption], fingerprint: String) {
        self.title = title; self.body = body; self.question = question; self.options = options; self.fingerprint = fingerprint
    }
    /// 0.2.6 Y: 서버가 덧붙인 정해진 한국어(폴더 신뢰 창의 제목과 설명 한 줄)는 영어 화면에서 영어로. 화면에서 읽은 CLI 글과 경로는 그대로다.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = ServerErrorText.display(try c.decode(String.self, forKey: .title), code: "approval_folder_trust")
        body = try c.decode(String.self, forKey: .body).components(separatedBy: "\n")
            .map { ServerErrorText.display($0, code: "approval_folder_trust_detail") }.joined(separator: "\n")
        question = try c.decode(String.self, forKey: .question)
        options = try c.decode([CLIApprovalOption].self, forKey: .options)
        fingerprint = try c.decode(String.self, forKey: .fingerprint)
    }
}

struct CLIApprovalResponse: Decodable, Sendable { let approval: CLIApprovalPrompt? }
struct CLIApprovalAnswer: Encodable, Sendable { let fingerprint: String; let option: Int }
