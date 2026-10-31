import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import BotCore
@testable import WeChatAIBot

/// Answers the director with a scripted plan and counts calls per purpose; the input it saw is kept.
private final class AgentModelProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var plans: [String] = []
    private static var seen: [(purpose: String, input: String)] = []
    static func reset(_ scripted: [String]) { lock.lock(); plans = scripted; seen = []; lock.unlock() }
    static var calls: [(purpose: String, input: String)] { lock.lock(); defer { lock.unlock() }; return seen }
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
        let purpose = ((object["metadata"] as? [String: Any])?["dafeiyu_purpose"] as? String) ?? "chat"
        let input = (object["messages"] as! [[String: Any]]).dropFirst().compactMap { $0["content"] as? String }.joined(separator: "\n")
        Self.lock.lock()
        Self.seen.append((purpose, input))
        let content = purpose == "director" && !Self.plans.isEmpty ? Self.plans.removeFirst() : #"{"action":"silence","note":"无事"}"#
        Self.lock.unlock()
        let result: [String: Any] = ["choices": [["message": ["content": content], "finish_reason": "stop"]], "usage": ["total_tokens": 10]]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: result)); client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) @MainActor struct QQAgentTests {
    /// A batch of member messages goes to the director once; its plan is sent bubble by bubble (the first text
    /// quoting the target), reactions land, and a silent plan sends nothing. No counter or keyword is involved.
    @Test func directorDecidesEachBatchAndThePlanIsCarriedOut() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("group".utf8).write(to: directory.appendingPathComponent("message-shape"))
        let server = Process(), output = Pipe()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        server.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("onebot_fixture.py").path, directory.path]
        server.standardOutput = output; try server.run()
        defer { if server.isRunning { server.terminate(); server.waitUntilExit() } }
        let port = try #require(Int(String(decoding: output.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        AgentModelProtocol.reset([
            #"{"action":"reply","target":"2","quote":true,"bubbles":[{"kind":"text","text":"第一句"},{"kind":"text","text":"第二句"},{"kind":"reaction","message":"1","emoji":"76"}],"note":"接住两个人"}"#,
            #"{"action":"silence","note":"他们在互相聊"}"#
        ])
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [AgentModelProtocol.self]
        let session = URLSession(configuration: cfg)
        defer { session.invalidateAndCancel() }
        let engine = QQEngine(allowAuthenticationUI: false, storageDirectory: directory, modelClient: DeepSeekClient(session: session))
        defer { engine.disconnect() }
        engine.config.endpoint = "ws://127.0.0.1:\(port)"; engine.config.expectedSelfID = "12345"
        engine.config.effectiveVisionEnabled = false; engine.config.effectivePersona.stickersEnabled = false
        engine.config.ai.cooldownSeconds = 1; engine.config.ai.effectiveSendLimits.globalIntervalSeconds = 1
        engine.agentQuietSeconds = 0.4; engine.agentCollectSeconds = 2
        #expect(engine.useTemporaryCredentials(token: "synthetic-test-token", key: "synthetic-key"))
        await engine.connect(); try #require(engine.connected, "\(engine.error ?? engine.status)")
        engine.add(try #require(engine.contacts.first { $0.number == "99999" }))
        engine.config.targets[0].enabled = true
        try engine.saveAgentTargets(["group:99999", "group:12121"]) // a group not on the list is dropped
        #expect(engine.config.agentTargets == ["group:99999"])
        engine.start()
        func batch(_ rows: [[String: Any]]) throws {
            try JSONSerialization.data(withJSONObject: rows).write(to: directory.appendingPathComponent("event-batch"), options: .atomic)
        }
        func line(_ id: Int, _ sender: Int, _ text: String) -> [String: Any] {
            ["post_type": "message", "self_id": 12345, "user_id": sender, "sender": ["user_id": sender, "card": "群友\(sender)"], "message_type": "group",
             "sub_type": "normal", "group_id": 99999, "message_id": id, "message": [["type": "text", "data": ["text": text]]]]
        }
        // Neither message mentions the bot; in agent mode that is the director's call, not the program's.
        try batch([line(1, 54321, "今天食堂的红烧肉绝了"), line(2, 54322, "真的假的，明天去试试")])
        let deadline = Date().addingTimeInterval(8)
        while engine.sends.confirmed < 2 && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        try #require(engine.sends.confirmed == 2)
        let directed = AgentModelProtocol.calls.filter { $0.purpose == "director" }
        #expect(directed.count == 1) // both messages in one batch
        #expect(directed.first?.input.contains("这一批新消息（从旧到新）：1、2") == true)
        #expect(directed.first?.input.contains("红烧肉") == true)
        // Each payload's message segments, as (type, text or quoted id).
        let payloads = try String(contentsOf: directory.appendingPathComponent("payloads"), encoding: .utf8).split(separator: "\n").map { line in
            let message = (try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["message"] as? [[String: Any]] ?? []
            return message.map { segment -> String in
                let data = segment["data"] as? [String: Any] ?? [:]
                return (segment["type"] as? String ?? "") + ":" + ((data["text"] as? String) ?? QQPolicy.identifier(data["id"]) ?? "")
            }
        }
        #expect(payloads == [["reply:2", "text:第一句"], ["text:第二句"]])
        let reactionDeadline = Date().addingTimeInterval(3)
        while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("reactions").path) && Date() < reactionDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
        let reactions = (try? String(contentsOf: directory.appendingPathComponent("reactions"), encoding: .utf8)) ?? ""
        #expect(reactions.contains("\"76\"") && reactions.contains("\"1\""))
        #expect(engine.decisions.contains { $0.text.contains("红烧肉") && $0.outcome.hasPrefix("交给代理") })
        #expect(engine.interactions.contains { $0.what.contains("说「第一句」") && $0.why == "接住两个人" })
        // The next batch: the director stays quiet, nothing is sent, and it says why.
        try batch([line(3, 54321, "你去哪个食堂"), line(4, 54322, "二食堂")])
        let quietDeadline = Date().addingTimeInterval(6)
        while !engine.interactions.contains(where: { $0.what == "看了，没出声" }) && Date() < quietDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
        #expect(engine.interactions.contains { $0.what == "看了，没出声" && $0.why == "他们在互相聊" })
        #expect(engine.sends.confirmed == 2)
        // Its own recent moves ride along with the next batch.
        #expect(AgentModelProtocol.calls.filter { $0.purpose == "director" }.last?.input.contains("你最近在这个群做过的事") == true)
        engine.pause()
    }
}
