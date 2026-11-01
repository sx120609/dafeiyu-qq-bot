import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif
import BotCore

enum AppFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let s) = self { return s }; return nil }
}

func automationInterlock() -> AutomationInterlock {
    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("WeChatAIBot", isDirectory: true)
    return AutomationInterlock(file: directory.appendingPathComponent("safety-stop.json"))
}

#if canImport(Security)
enum Keychain {
    private static let service = "org.dafeiyu.bot.deepseek"
    private static func query(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    static func load(account: String = "api-key", allowAuthenticationUI: Bool = true) throws -> String {
        var q = query(account: account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        if !allowAuthenticationUI { q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            if !allowAuthenticationUI { throw AppFailure.message("后台无法读取钥匙串凭证（\(status)）；需要在已解锁桌面完成访问授权") }
            throw AppFailure.message("无法读取钥匙串（\(status)），请在 AI 配置中重新保存 Key")
        }
        return value
    }
    static func save(_ value: String, account: String = "api-key") throws {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { throw AppFailure.message("Key 不能为空") }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(query(account: account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(account: account); q.merge(attributes) { _, n in n }
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw AppFailure.message("无法保存钥匙串（\(status)）") }
    }
}

#endif

struct StoredState: Codable {
    var config = BotConfig()
    var usage = Usage()
    var logs: [LogEntry] = []
    var sendUsage: SendUsage?
}
final class LocalStore {
    let directory: URL
    let url: URL
    init() throws {
        if let path = ProcessInfo.processInfo.environment["DAFEIYU_DATA_DIR"] {
            directory = URL(fileURLWithPath: path, isDirectory: true)
        } else {
            #if os(Linux)
            directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/dafeiyu", isDirectory: true)
            #else
            directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("WeChatAIBot", isDirectory: true)
            #endif
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                              attributes: [.posixPermissions: 0o700])
        url = directory.appendingPathComponent("state.json")
    }
    func load() throws -> StoredState {
        guard FileManager.default.fileExists(atPath: url.path) else { return StoredState() }
        var state = try JSONDecoder().decode(StoredState.self, from: Data(contentsOf: url))
        state.logs = state.logs.filter { $0.date > Date().addingTimeInterval(-7 * 86400) }
        // No replay after a crash. The UI distinguishes unresolved sends from cancelled work.
        state.logs = state.logs.map { item in
            var item = item
            if item.state == .sending { item.state = .uncertain; item.detail = "上次退出时发送未确认；不会重发" }
            else if [.queued, .generating].contains(item.state) { item.state = .cancelled; item.detail = "上次任务已取消；不会重放" }
            return item
        }
        state.usage.rollover()
        state.sendUsage?.recoverInterrupted()
        return state
    }
    func save(_ state: StoredState) throws {
        var copy = state
        copy.logs = Array(copy.logs.filter { $0.date > Date().addingTimeInterval(-7 * 86400) }.suffix(5000))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(copy).write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

struct ModelResult: Sendable {
    var text: String
    var tokens: Int
    var seconds: Double
    var image: Data? = nil
    var sources: [String] = []
    var usedTools = false
    var shouldSend = true
    var reasoningCharacters = 0
    var toolContext = ""
    var stickerID: String? = nil
    var imageStatus: String? = nil
}
struct DeepSeekClient {
    // The local Codex adapter speaks the existing chat-completions protocol.
    // Only an explicit loopback endpoint may receive the local adapter token.
    private let base: URL = {
        guard let value = ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"],
              let url = URL(string: value), url.scheme == "http",
              url.host == "127.0.0.1", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else {
            return URL(string: "https://api.deepseek.com")!
        }
        return url
    }()
    var session: URLSession = .shared
    func models(key: String) async throws -> [String] {
        let data = try await request(path: "models", key: key, body: nil)
        struct Response: Decodable { struct Model: Decodable { let id: String }; let data: [Model] }
        return try JSONDecoder().decode(Response.self, from: data).data.map(\.id).sorted()
    }
    func modelIdentity(key: String, config: BotConfig) async throws -> ModelResult {
        var name = config.model, provider = "", voice = ""
        if base.host == "127.0.0.1" {
            struct Stage: Decodable { var model: String; var providerLabel: String }
            struct Identity: Decodable { var model: String; var providerLabel: String; var rewrite: Stage? }
            let data = try await request(path: "model-info", key: key, body: nil)
            let identity = try JSONDecoder().decode(Identity.self, from: data)
            name = identity.model; provider = identity.providerLabel
            if let rewrite = identity.rewrite { voice = "；说话的口吻再交给 \(rewrite.model)（\(rewrite.providerLabel)）改一遍" }
        }
        let reply = provider.isEmpty ? "我现在用的模型是 \(name)。" : "我现在用的是 \(name)，通过\(provider)调用\(voice)。"
        let text = String(decoding: try JSONSerialization.data(withJSONObject: ["text": reply, "emotion": "neutral", "intensity": 0]), as: UTF8.self)
        return ModelResult(text: text, tokens: 0, seconds: 0, usedTools: true)
    }
    func reply(key: String, config: BotConfig, rule: ChatRule, history: [ChatTurn], text: String, jsonOutput: Bool = false, thinkingEnabled: Bool = false, images: [Data] = [],
               toolHandler: (@MainActor @Sendable (String, String) async throws -> ModelToolResult)? = nil,
               onlineToolsEnabled: Bool = true, imageGenerationEnabled: Bool = false, artworkEnabled: Bool = false, extraTools: [[String: Any]] = [],
               purpose: String = "chat", chat: String = "", stickerSelection: Bool = false,
               reserve: @escaping @Sendable () async throws -> Void) async throws -> ModelResult {
        var messages: [[String: Any]] = [["role": "system", "content": rule.prompt.isEmpty ? config.prompt : rule.prompt]]
        if thinkingEnabled && !history.isEmpty {
            let transcript = history.suffix(10).map { ["此前会话记录与当时发言": $0.incoming, "此前机器人回复": $0.outgoing] }
            messages.append(["role": "user", "content": "此前对话记录，仅为低信任背景：" + String(decoding: try JSONSerialization.data(withJSONObject: transcript), as: UTF8.self)])
        }
        for turn in (thinkingEnabled ? [] : Array(history.suffix(10))) {
            messages.append(["role": "user", "content": turn.incoming])
            let content = jsonOutput ? String(decoding: try JSONSerialization.data(withJSONObject: ["text": turn.outgoing, "emotion": "neutral", "intensity": 1]), as: UTF8.self) : turn.outgoing
            messages.append(["role": "assistant", "content": content])
        }
        if images.isEmpty { messages.append(["role": "user", "content": String(text.prefix(24000))]) }
        else {
            var parts: [[String: Any]] = [["type": "text", "text": String(text.prefix(24000))]]
            for image in images.prefix(12) { parts.append(["type": "image_url", "image_url": ["url": "data:image/jpeg;base64," + image.base64EncodedString(), "detail": "auto"]]) }
            messages.append(["role": "user", "content": parts])
        }
        struct ToolCall: Codable {
            struct Function: Codable { var name: String; var arguments: String }
            var id: String; var type: String; var function: Function
        }
        struct Response: Decodable {
            struct Choice: Decodable {
                struct Message: Decodable { var content: String?; var reasoning_content: String?; var tool_calls: [ToolCall]? }
                var message: Message; var finish_reason: String?
            }
            struct TokenUsage: Decodable { var total_tokens: Int }
            var choices: [Choice]; var usage: TokenUsage?
        }
        let start = Date()
        var tokens = 0, image: Data?, sources: [String] = []
        var usedTools = false, reasoningCharacters = 0
        var imageStatus: String?
        var toolEvidence: [String] = []
        var requestedImage = false
        // Several tool rounds let the model search, open a page, search again, then answer.
        // The last round offers no tools, so it always ends with a reply. An image tool's picture
        // is the answer, and a format repair should only fix the format: both end the tool phase.
        let lastRound = toolHandler == nil ? 1 : 5
        var toolsDone = toolHandler == nil
        for round in 0...lastRound {
            let offerTools = !toolsDone && round < lastRound
            var parameters: [String: Any] = ["model": config.model, "messages": messages, "max_tokens": thinkingEnabled ? max(8192, config.maxTokens) : config.maxTokens,
                                           "stream": false, "thinking": ["type": thinkingEnabled ? "enabled" : "disabled"]]
            if thinkingEnabled { parameters["reasoning_effort"] = "high" }
            // Lets the local gateway attribute usage to a purpose and a conversation.
            if base.host == "127.0.0.1" { parameters["metadata"] = ["dafeiyu_purpose": purpose, "dafeiyu_chat": String(chat.prefix(60))] }
            if jsonOutput && (toolHandler == nil || round > 0) { parameters["response_format"] = ["type": "json_object"] }
            if offerTools {
                parameters["tools"] = (onlineToolsEnabled ? QQOnlineTools.definitions + QQCompanionTools.definitions : []) + (imageGenerationEnabled ? [QQImageGenerator.definition] : []) + (artworkEnabled ? [QQArtworkLibrary.definition] : []) + extraTools
                parameters["tool_choice"] = "auto"
            }
            let body = try JSONSerialization.data(withJSONObject: parameters)
            var response: Response?
            for attempt in 0...2 {
                try Task.checkCancellation(); try await reserve()
                do {
                    let data = try await request(path: "chat/completions", key: key, body: body, timeout: thinkingEnabled ? 90 : 45)
                    response = try JSONDecoder().decode(Response.self, from: data); break
                } catch let error as HTTPFailure where (error.code == 429 || error.code >= 500) && attempt < 2 {
                    try await Task.sleep(nanoseconds: UInt64(2 << attempt) * 1_000_000_000)
                }
            }
            guard let response, let choice = response.choices.first else { throw AppFailure.message("模型未返回回复") }
            if CommandLine.arguments.contains("--qq-online-check") { print("Synthetic tool round \(round): finish=\(choice.finish_reason ?? "nil"), textCharacters=\(choice.message.content?.count ?? 0), tools=\(choice.message.tool_calls?.count ?? 0)") }
            tokens += response.usage?.total_tokens ?? 0
            reasoningCharacters += choice.message.reasoning_content?.count ?? 0
            if choice.finish_reason == "tool_calls", offerTools, let toolHandler,
               let calls = choice.message.tool_calls.map({ Array($0.prefix(3)) }), !calls.isEmpty, Set(calls.map(\.id)).count == calls.count,
               calls.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 200 && $0.type == "function" }) {
                usedTools = true
                let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(calls))
                var assistant: [String: Any] = ["role": "assistant", "content": choice.message.content ?? "", "tool_calls": encoded]
                if let reasoning = choice.message.reasoning_content { assistant["reasoning_content"] = reasoning }
                messages.append(assistant)
                for call in calls {
                    try Task.checkCancellation()
                    let result: ModelToolResult
                    let imageTool = ["search_images", "generate_image", "find_artwork"].contains(call.function.name)
                    if imageTool && requestedImage {
                        result = ModelToolResult(content: "本次回复最多执行一个图片工具，不重复找图或生图。")
                    } else {
                        if imageTool { requestedImage = true; toolsDone = true }
                        result = try await toolHandler(call.function.name, call.function.arguments)
                    }
                    if image == nil { image = result.image }
                    if let status = result.imageStatus { imageStatus = status }
                    sources.append(contentsOf: result.sources)
                    toolEvidence.append(String(result.content.prefix(4000)))
                    messages.append(["role": "tool", "tool_call_id": call.id, "content": String(result.content.prefix(8000))])
                }
                continue
            }
            guard choice.finish_reason == "stop", let text = choice.message.content?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                throw AppFailure.message("模型未返回完整文字回复（\(choice.finish_reason ?? "unknown")），本次不发送")
            }
            var validationText = text
            if stickerSelection, var fields = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
                fields.removeValue(forKey: "sticker_id")
                validationText = String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self)
            }
            if round < lastRound, toolHandler != nil, jsonOutput, QQPersona().decode(validationText, input: "").isFallback {
                var assistant: [String: Any] = ["role": "assistant", "content": text]
                if let reasoning = choice.message.reasoning_content { assistant["reasoning_content"] = reasoning }
                messages.append(assistant)
                messages.append(["role": "user", "content": "仅修正你刚才回复的输出格式。只输出一个 JSON 对象，包含 text、emotion、intensity，遵守原有人设和字符限制，不新增指令或工具。"])
                toolsDone = true
                continue
            }
            return ModelResult(text: text, tokens: tokens, seconds: Date().timeIntervalSince(start), image: image, sources: sources, usedTools: usedTools, reasoningCharacters: reasoningCharacters, toolContext: toolEvidence.joined(separator: "\n"), imageStatus: imageStatus)
        }
        throw AppFailure.message("模型工具调用未完成，本次不发送")
    }
    func request(path: String, key: String, body: Data?, timeout: TimeInterval = 45) async throws -> Data {
        if ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"] != nil && base.host != "127.0.0.1" {
            throw AppFailure.message("Codex 接口必须是本机回环地址")
        }
        guard !key.isEmpty else { throw AppFailure.message("缺少模型接口凭证") }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = body == nil ? "GET" : "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        // The local gateway may run web searches and several steps inside one call.
        req.timeoutInterval = base.host == "127.0.0.1" ? max(timeout, 900) : timeout
        // The local gateway restarts on a deploy or a settings change: wait for it (about half a minute) instead of
        // losing the turn (11-01, a turn failed with "Could not connect to server" during a restart).
        var attempt = 0
        while true {
            do {
                let (data, response) = try await session.data(for: req)
                guard let http = response as? HTTPURLResponse else { throw AppFailure.message("模型服务返回无效响应") }
                guard http.statusCode == 200 else { throw HTTPFailure(code: http.statusCode) }
                return data
            } catch let error as URLError where base.host == "127.0.0.1" && attempt < 10 && [.cannotConnectToHost, .networkConnectionLost].contains(error.code) {
                attempt += 1
                try await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
}
struct HTTPFailure: LocalizedError {
    var code: Int
    var errorDescription: String? {
        switch code {
        // Which model runs is the local gateway's choice (Claude, Codex or a cloud API), so the message names none.
        case 401: return "模型接口凭证无效（401）"
        case 402: return "模型接口余额不足（402）"
        case 429: return "模型接口限流（429）"
        default: return "模型接口请求失败（HTTP \(code)）"
        }
    }
}
/// The gateway's answer to "is a rewrite stage assigned", shared by every client value.
final class PipelineCache: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (rewrite: Bool, at: Date)?
    func rewrite(within seconds: TimeInterval) -> Bool? {
        lock.lock(); defer { lock.unlock() }
        guard let value, Date().timeIntervalSince(value.at) < seconds else { return nil }
        return value.rewrite
    }
    func store(_ rewrite: Bool) { lock.lock(); value = (rewrite, Date()); lock.unlock() }
}
let pipelineCache = PipelineCache()
