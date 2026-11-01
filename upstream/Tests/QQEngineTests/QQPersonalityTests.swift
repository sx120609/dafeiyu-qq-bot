import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import BotCore
@testable import WeChatAIBot

private final class PersonalityModelProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var prompts: [String] = []
    private static var requests: [(prompt: String, input: String)] = []
    static func reset() { lock.lock(); prompts = []; requests = []; lock.unlock() }
    static var captured: [String] { lock.lock(); defer { lock.unlock() }; return prompts }
    static var scoped: [(prompt: String, input: String)] { lock.lock(); defer { lock.unlock() }; return requests }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }; var bytes = [UInt8](repeating: 0, count: 8192)
            while stream.hasBytesAvailable { let n = stream.read(&bytes, maxLength: bytes.count); if n <= 0 { break }; data.append(contentsOf: bytes.prefix(n)) }
        }
        let object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let messages = object["messages"] as! [[String: Any]], prompt = messages[0]["content"] as! String
        let input = messages.dropFirst().compactMap { $0["content"] as? String }.joined(separator: "\n")
        Self.lock.lock(); Self.prompts.append(prompt); Self.requests.append((prompt: prompt, input: input)); Self.lock.unlock()
        let style = QQPersonality.allCases.first { prompt.contains("当前会话唯一生效性格：" + $0.name) }
        #expect(style != nil)
        var answer: [String: Any] = ["text": "合成回复：" + (style?.name ?? "未识别"), "emotion": "neutral", "intensity": 0]
        if prompt.contains("[QQ_PARTICIPATION]") { answer["participate"] = true }
        let content = String(decoding: try! JSONSerialization.data(withJSONObject: answer), as: UTF8.self)
        let result: [String: Any] = ["choices": [["message": ["content": content], "finish_reason": "stop"]]]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: result)); client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) @MainActor struct QQPersonalityEngineTests {
    @Test func panelPersistenceKeepsMemoryAndRollsBackStaleWrites() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let seed = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        seed.config.expectedSelfID = "12345"
        seed.config.targets = [QQTarget(number: "54321", name: "peer", group: false), QQTarget(number: "99999", name: "group", group: true)]
        seed.save()
        let file = directory.appendingPathComponent("qq-state.json")
        var raw = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var book = QQMemoryBook()
        book.append(QQMemoryEvent(id: "1", subject: "PEER", text: "synthetic preference blue", at: Date()))
        raw["memoryBooks"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(["12345:private:54321": book]))
        try JSONSerialization.data(withJSONObject: raw).write(to: file)
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        engine.setPersonaStyle("gentle", target: "private:54321")
        #expect(engine.error == nil); #expect(engine.memoryBooks["12345:private:54321"] == book)
        let restored = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(restored.config.persona(for: "private:54321").effectiveStyle == .gentle)
        #expect(restored.memoryBooks["12345:private:54321"] == book)
        engine.setPersonaStyle("invalid", target: "group:99999")
        #expect(engine.error != nil); #expect(engine.config.persona(for: "group:99999").effectiveStyle == .teasing)
        engine.setPersonaStyle("calm", target: "group:77777")
        #expect(engine.error != nil); #expect(engine.config.targets.count == 2)
        // A second legitimate panel changes the file; this stale panel must not override it.
        restored.setPersonaStyle("butler", target: "group:99999")
        engine.setPersonaStyle("calm", target: "private:54321")
        #expect(engine.error != nil); #expect(engine.config.persona(for: "private:54321").effectiveStyle == .gentle)
        let latest = QQEngine(allowAuthenticationUI: false, storageDirectory: directory)
        #expect(latest.config.persona(for: "group:99999").effectiveStyle == .butler)
        #expect(latest.memoryBooks["12345:private:54321"] == book)
    }
}
