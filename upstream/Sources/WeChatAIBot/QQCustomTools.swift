import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Tools the agent writes for itself (create_tool). The local gateway keeps them and runs each one in a sandbox
/// (bridge/agent-tools.mjs); the engine only lists them for a turn and passes calls through.
enum QQCustomTools {
    private static func endpoint(_ path: String) -> URL? {
        guard let base = ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"], let url = URL(string: base + path),
              url.scheme == "http", url.host == "127.0.0.1" else { return nil }
        return url
    }
    private static func post(_ path: String, _ body: [String: Any], key: String, timeout: TimeInterval) async throws -> [String: Any] {
        guard let url = endpoint(path) else { throw AppFailure.message("自建工具接口不可用") }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = timeout
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        let object = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw AppFailure.message((object["error"] as? String) ?? "自建工具接口出错") }
        return object
    }
    /// The enabled ones, as tool definitions; none when the gateway cannot be reached.
    static func definitions(key: String) async -> [[String: Any]] {
        guard let url = endpoint("/agent-tools") else { return [] }
        var request = URLRequest(url: url); request.timeoutInterval = 5
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let tools = object["tools"] as? [[String: Any]] else { return [] }
        return tools.prefix(50).filter { (($0["function"] as? [String: Any])?["name"] as? String)?.hasPrefix("my_") == true }
    }
    /// create_tool: what the test run gave, and whether the tool is now on the list.
    static func create(_ arguments: String, chat: String, key: String) async -> String {
        guard var fields = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any] else { return "参数不是合法的 JSON。" }
        // The model may hand the schema over as a JSON string.
        if let text = fields["parameters"] as? String, let schema = try? JSONSerialization.jsonObject(with: Data(text.utf8)) { fields["parameters"] = schema }
        if let text = fields["test_arguments"] as? String, let test = try? JSONSerialization.jsonObject(with: Data(text.utf8)) { fields["test_arguments"] = test }
        fields["chat"] = chat
        do {
            let result = try await post("/agent-tools/create", fields, key: key, timeout: 120)
            let test = result["test"] as? [String: Any] ?? [:]
            let logs = (test["logs"] as? [String] ?? []).suffix(8).joined(separator: "\n")
            let name = (result["name"] as? String) ?? ""
            if result["saved"] as? Bool == true {
                return (result["replaced"] as? Bool == true ? "已更新" : "已创建") + "并启用 \(name)，现在就能直接调用。测试结果：\n" +
                    String(((test["output"] as? String) ?? "").prefix(2000)) + (logs.isEmpty ? "" : "\n日志：\n" + logs)
            }
            return "没保存：测试没跑通。错误：\n" + String(((test["error"] as? String) ?? "").prefix(1500)) + (logs.isEmpty ? "" : "\n日志：\n" + logs) + "\n改好代码再调用一次 create_tool。"
        } catch { return "没保存：" + error.localizedDescription }
    }
    static func run(_ name: String, arguments: String, key: String) async -> String {
        let fields = ((try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any]) ?? [:]
        do {
            let result = try await post("/agent-tools/run", ["name": name, "arguments": fields], key: key, timeout: 90)
            if result["ok"] as? Bool == true { return String(((result["output"] as? String) ?? "").prefix(6000)) }
            return "工具出错：" + String(((result["error"] as? String) ?? "").prefix(1500)) + "\n（是你自己写的工具；需要的话用 create_tool 改好同名工具）"
        } catch { return "工具没跑成：" + error.localizedDescription }
    }
}
