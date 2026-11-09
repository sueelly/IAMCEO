import Foundation

struct ModelOption: Decodable, Sendable, Equatable, Identifiable {
    let value: String
    let label: String
    var description: String? = nil
    let efforts: [String]
    var defaultEffort: String? = nil
    var id: String { value }
}

struct ModelList: Decodable, Sendable, Equatable {
    let models: [ModelOption]
    let source: String
    var updatedAt: String? = nil

    func option(for value: String) -> ModelOption? {
        if let exact = models.first(where: { $0.value == value }) { return exact }
        // Older IAMCEO settings used the short alias for Claude's additional option.
        if value == "fable" { return models.first { $0.label.lowercased() == "fable" } }
        return nil
    }

    func unknownCurrent(_ value: String) -> String? {
        !value.isEmpty && option(for: value) == nil ? "\(value) · 목록에 없음" : nil
    }

    func efforts(for value: String, cli: RankSettingsCLI) -> [String] {
        guard let option = option(for: value), !option.efforts.isEmpty else { return cli.efforts }
        return option.efforts
    }
}

struct ModelCatalog: Decodable, Sendable, Equatable {
    let claude: ModelList
    let codex: ModelList
    /// Absent from servers before Antigravity support.
    var antigravity: ModelList? = nil

    func list(for cli: RankSettingsCLI) -> ModelList { cli == .codex ? codex : claude }
    func list(provider: String) -> ModelList {
        provider == "antigravity" ? (antigravity ?? Self.antigravityFallback) : list(for: provider == "codex" ? .codex : .claude)
    }

    /// Same ids as the server's list (agy 1.5.3). Effort is part of the id, so efforts stay empty.
    static let antigravityFallback = ModelList(models: [
        ("gemini-4-argon-medium", "Gemini 4 Argon (Medium)"), ("gemini-4-argon-high", "Gemini 4 Argon (High)"), ("gemini-4-argon-low", "Gemini 4 Argon (Low)"),
        ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"), ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"), ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
        ("claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"), ("claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"), ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
    ].map { ModelOption(value: $0.0, label: $0.1, efforts: []) }, source: "default")

    static let fallback = ModelCatalog(
        claude: ModelList(models: ["opus", "sonnet", "haiku"].map {
            ModelOption(value: $0, label: $0.capitalized, efforts: RankSettingsCLI.claude.efforts)
        }, source: "default"),
        codex: ModelList(models: RankSettingsCLI.codex.models.map {
            ModelOption(value: $0, label: $0, efforts: RankSettingsCLI.codex.efforts)
        }, source: "default")
    )
    static let demo = ModelCatalog(
        claude: ModelList(models: fallback.claude.models + [
            ModelOption(value: "claude-fable-5-1[1m]", label: "Fable", description: "샘플 모델", efforts: RankSettingsCLI.claude.efforts)
        ], source: "default"), codex: fallback.codex
    )
}
