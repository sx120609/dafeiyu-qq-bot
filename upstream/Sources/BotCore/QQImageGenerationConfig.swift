import Foundation

public enum QQImageProvider: String, Codable, CaseIterable, Sendable {
    case zhipu, cloudflare, codex
    public var title: String {
        switch self { case .zhipu: return "智谱 CogView-3-Flash"; case .cloudflare: return "Cloudflare FLUX.1 schnell"; case .codex: return "模型网关生图（云端 API 或本机 Codex）" }
    }
    public var alternate: QQImageProvider { self == .zhipu ? .cloudflare : .zhipu }
}

// Credentials are deliberately excluded from Codable settings.
public struct QQImageGenerationConfig: Codable, Equatable, Sendable {
    public var enabled = false
    public var primary: QQImageProvider = .zhipu
    public var fallbackEnabled = true
    public var cloudflareAccountID = ""
    public init() {}
    public func validate() throws {
        guard cloudflareAccountID.isEmpty || cloudflareAccountID.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil else {
            throw CoreError.invalid("Cloudflare Account ID 应为 32 位十六进制字符（不是 API Token）")
        }
    }
}
