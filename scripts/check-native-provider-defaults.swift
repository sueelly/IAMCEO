// Foundation-only native contract check, runnable with Command Line Tools:
// swiftc native/Sources/IAMCEO/Models/Models.swift scripts/check-native-provider-defaults.swift -o /tmp/provider-defaults-check
import Foundation

@main
struct NativeProviderDefaultsCheck {
    static func main() throws {
        let decoder = JSONDecoder()
        let codex = try decoder.decode(Project.self, from: Data(#"{"id":"new","chiefCli":"codex"}"#.utf8))
        let claude = try decoder.decode(Project.self, from: Data(#"{"id":"selected","chiefCli":"claude"}"#.utf8))
        let historical = try decoder.decode(Project.self, from: Data(#"{"id":"old"}"#.utf8))
        precondition(codex.chiefCli == "codex")
        precondition(claude.chiefCli == "claude")
        precondition(historical.chiefCli == "claude")
        let legacyMember = try decoder.decode(Member.self, from: Data(#"{"id":"old-member","sessionId":"claude-session"}"#.utf8))
        precondition(legacyMember.cli == "claude" && legacyMember.sessionId == "claude-session")

        precondition(ProjectState(project: codex).defaultMemberCLI == "codex")
        precondition(ProjectState(project: claude).defaultMemberCLI == "claude")
        let team = ProjectState(project: codex, members: [
            Member(id: "worker", kind: "worker", cli: "codex"),
            Member(id: "chief", kind: "conductor", cli: "claude", status: "asleep")
        ])
        precondition(team.defaultMemberCLI == "claude")
        let hq = ProjectState(project: claude, members: [Member(id: "root", kind: "root", cli: "codex")])
        precondition(hq.defaultMemberCLI == "codex")
        print("Native provider defaults: decoding, stored choice, conductor and root checks passed")
    }
}
