import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Super mode (操控电脑): the local gateway runs the owner's Codex on this PC (bridge/computer.mjs).
enum QQComputer {
    private static func endpoint(_ path: String) -> URL? {
        guard let base = ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"], let url = URL(string: base + path),
              url.scheme == "http", url.host == "127.0.0.1" else { return nil }
        return url
    }
    /// The owner's QQ number when super mode is on, else nil.
    static func owner(key: String) async -> String? {
        guard let url = endpoint("/computer") else { return nil }
        var request = URLRequest(url: url); request.timeoutInterval = 5
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["enabled"] as? Bool == true,
              let owner = object["owner"] as? String, !owner.isEmpty else { return nil }
        return owner
    }
    /// Runs one task; `needsConfirmation` carries what Codex wants to do when it stopped to ask.
    static func run(_ task: String, confirmed: Bool, requester: String, key: String) async throws -> (needsConfirmation: Bool, output: String) {
        guard let url = endpoint("/computer/run") else { throw AppFailure.message("超级模式接口不可用") }
        // No time limit on the task (it runs in the background); a day only guards against a lost connection.
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 86400
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["task": String(task.prefix(2000)), "confirmed": confirmed, "requester": requester])
        let (data, response) = try await URLSession.shared.data(for: request)
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (response as? HTTPURLResponse)?.statusCode == 200, let status = object?["status"] as? String, let output = object?["output"] as? String else {
            throw AppFailure.message((object?["error"] as? String) ?? "这件事没做成")
        }
        return (status == "needs_confirmation", output)
    }
}
