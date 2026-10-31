import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Voice messages: the local gateway turns a line into speech with the owner's own OpenAI key (bridge/voice.mjs).
enum QQVoice {
    private static func endpoint(_ path: String) -> URL? {
        guard let base = ProcessInfo.processInfo.environment["DAFEIYU_CODEX_URL"], let url = URL(string: base + path),
              url.scheme == "http", url.host == "127.0.0.1" else { return nil }
        return url
    }
    /// Whether voice is set up and switched on in the console.
    static func enabled(key: String) async -> Bool {
        guard let url = endpoint("/voice") else { return false }
        var request = URLRequest(url: url); request.timeoutInterval = 5
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["enabled"] as? Bool == true
    }
    /// The line as mp3 audio, ready for a QQ record segment.
    static func speak(_ text: String, key: String, chat: String) async throws -> Data {
        guard let url = endpoint("/voice/speech") else { throw AppFailure.message("语音接口不可用") }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 75
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": String(text.prefix(600)), "chat": String(chat.prefix(60))])
        let (data, response) = try await URLSession.shared.data(for: request)
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (response as? HTTPURLResponse)?.statusCode == 200, let encoded = object?["audio"] as? String,
              let audio = Data(base64Encoded: encoded), audio.count > 100 else {
            throw AppFailure.message((object?["error"] as? String) ?? "语音合成失败")
        }
        return audio
    }
}
